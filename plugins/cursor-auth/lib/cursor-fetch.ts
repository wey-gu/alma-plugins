/**
 * Custom fetch wrapper that translates OpenAI chat/completions requests
 * to Cursor's gRPC protocol via HTTP/2.
 *
 * This follows the same pattern as openai-codex-auth's createCodexFetch():
 * - Intercepts AI SDK fetch calls
 * - Transforms request format (OpenAI JSON -> Cursor protobuf)
 * - Makes the actual API call (HTTP/2 Connect protocol)
 * - Returns response in OpenAI-compatible format (SSE stream or JSON)
 *
 * Tool call flow:
 * 1. Cursor model tries native tools -> proxy rejects with typed errors
 * 2. Model falls back to MCP tools -> proxy emits OpenAI tool_calls SSE
 * 3. AI SDK sends follow-up request with tool results
 * 4. Proxy resumes H2 stream with mcpResult, streams continuation
 */

import * as http2 from 'node:http2';
import { createHash } from 'node:crypto';
import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import {
    AgentClientMessageSchema,
    AgentRunRequestSchema,
    AgentServerMessageSchema,
    ClientHeartbeatSchema,
    ConversationActionSchema,
    ConversationStateStructureSchema,
    ConversationStepSchema,
    AgentConversationTurnStructureSchema,
    ConversationTurnStructureSchema,
    AssistantMessageSchema,
    BackgroundShellSpawnResultSchema,
    DeleteResultSchema,
    DeleteRejectedSchema,
    DiagnosticsResultSchema,
    ExecClientMessageSchema,
    FetchErrorSchema,
    FetchResultSchema,
    GetBlobResultSchema,
    GrepErrorSchema,
    GrepResultSchema,
    KvClientMessageSchema,
    LsRejectedSchema,
    LsResultSchema,
    McpErrorSchema,
    McpResultSchema,
    McpSuccessSchema,
    McpTextContentSchema,
    McpToolDefinitionSchema,
    McpToolResultContentItemSchema,
    ModelDetailsSchema,
    ReadRejectedSchema,
    ReadResultSchema,
    RequestContextResultSchema,
    RequestContextSchema,
    RequestContextSuccessSchema,
    SetBlobResultSchema,
    ShellRejectedSchema,
    ShellResultSchema,
    UserMessageActionSchema,
    UserMessageSchema,
    WriteRejectedSchema,
    WriteResultSchema,
    WriteShellStdinErrorSchema,
    WriteShellStdinResultSchema,
    type AgentServerMessage,
    type ExecServerMessage,
    type KvServerMessage,
    type McpToolDefinition,
} from '../proto/agent_pb';
import type {
    ChatCompletionRequest,
    OpenAIMessage,
    OpenAIToolDef,
    PendingExec,
    StreamState,
    ToolResultInfo,
} from './types';

const CURSOR_API_URL = 'https://api2.cursor.sh';
const CURSOR_CLIENT_VERSION = 'cli-2026.02.13-41ac335';
const CONNECT_END_STREAM_FLAG = 0b00000010;

// ============================================================================
// Types
// ============================================================================

interface CursorRequestPayload {
    requestBytes: Uint8Array;
    blobStore: Map<string, Uint8Array>;
    mcpTools: McpToolDefinition[];
}

interface ActiveSession {
    h2Client: http2.ClientHttp2Session;
    h2Stream: http2.ClientHttp2Stream;
    heartbeatTimer: NodeJS.Timeout;
    blobStore: Map<string, Uint8Array>;
    mcpTools: McpToolDefinition[];
    pendingExecs: PendingExec[];
}

// Active H2 sessions keyed by conversation hash, kept alive for tool result continuation
const activeSessions = new Map<string, ActiveSession>();

export interface Logger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
}

// ============================================================================
// Custom Fetch Factory (matching codex-auth's createCodexFetch pattern)
// ============================================================================

export function createCursorFetch(
    getAccessToken: () => Promise<string>,
    logger: Logger,
): typeof globalThis.fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        // Extract URL string
        let url: string;
        if (typeof input === 'string') {
            url = input;
        } else if (input instanceof URL) {
            url = input.toString();
        } else {
            url = input.url;
        }

        // Only intercept chat completions — pass through everything else
        if (!url.includes('/chat/completions')) {
            // Models endpoint — return empty list (models are provided via getModels)
            if (url.includes('/models')) {
                return new Response(
                    JSON.stringify({ object: 'list', data: [] }),
                    { headers: { 'Content-Type': 'application/json' } },
                );
            }
            return globalThis.fetch(input, init);
        }

        try {
            const bodyStr = typeof init?.body === 'string' ? init.body : '';
            const body = JSON.parse(bodyStr) as ChatCompletionRequest;
            const accessToken = await getAccessToken();

            logger.debug(`Cursor request: model=${body.model}, stream=${body.stream}, messages=${body.messages.length}`);

            return await handleChatCompletion(body, accessToken, logger);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error('Cursor fetch error:', message);
            return new Response(
                JSON.stringify({
                    error: { message, type: 'server_error', code: 'internal_error' },
                }),
                { status: 500, headers: { 'Content-Type': 'application/json' } },
            );
        }
    };
}

/** Clean up all active sessions on plugin dispose */
export function disposeAllSessions(): void {
    for (const [key, session] of activeSessions) {
        clearInterval(session.heartbeatTimer);
        try { session.h2Stream.close(); } catch {}
        try { session.h2Client.close(); } catch {}
        activeSessions.delete(key);
    }
}

// ============================================================================
// Chat Completion Handler
// ============================================================================

async function handleChatCompletion(
    body: ChatCompletionRequest,
    accessToken: string,
    logger: Logger,
): Promise<Response> {
    const { systemPrompt, userText, turns, toolResults } = parseMessages(body.messages);
    const modelId = body.model;
    const tools = body.tools ?? [];

    if (!userText && toolResults.length === 0) {
        return new Response(
            JSON.stringify({
                error: { message: 'No user message found', type: 'invalid_request_error' },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
    }

    const sessionKey = deriveSessionKey(modelId, body.messages);
    const activeSession = activeSessions.get(sessionKey);

    // Resume existing session with tool results
    if (activeSession && toolResults.length > 0) {
        activeSessions.delete(sessionKey);
        return resumeWithToolResults(activeSession, toolResults, modelId, tools, accessToken, sessionKey, logger);
    }

    // Clean up stale session
    if (activeSession) {
        clearInterval(activeSession.heartbeatTimer);
        try { activeSession.h2Stream.close(); } catch {}
        try { activeSession.h2Client.close(); } catch {}
        activeSessions.delete(sessionKey);
    }

    const mcpTools = buildMcpToolDefinitions(tools);
    const payload = buildCursorRequest(modelId, systemPrompt, userText, turns);
    payload.mcpTools = mcpTools;

    if (body.stream === false) {
        return await handleNonStreaming(payload, accessToken, modelId, logger);
    }
    return handleStreaming(payload, accessToken, modelId, sessionKey, logger);
}

// ============================================================================
// Message Parsing
// ============================================================================

interface ParsedMessages {
    systemPrompt: string;
    userText: string;
    turns: Array<{ userText: string; assistantText: string }>;
    toolResults: ToolResultInfo[];
}

function parseMessages(messages: OpenAIMessage[]): ParsedMessages {
    let systemPrompt = 'You are a helpful assistant.';
    const pairs: Array<{ userText: string; assistantText: string }> = [];
    const toolResults: ToolResultInfo[] = [];

    const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '');
    if (systemParts.length > 0) systemPrompt = systemParts.join('\n');

    const nonSystem = messages.filter((m) => m.role !== 'system');
    let pendingUser = '';

    for (const msg of nonSystem) {
        if (msg.role === 'tool') {
            toolResults.push({ toolCallId: msg.tool_call_id ?? '', content: msg.content ?? '' });
        } else if (msg.role === 'user') {
            if (pendingUser) pairs.push({ userText: pendingUser, assistantText: '' });
            pendingUser = msg.content ?? '';
        } else if (msg.role === 'assistant') {
            const text = msg.content ?? '';
            if (pendingUser) {
                pairs.push({ userText: pendingUser, assistantText: text });
                pendingUser = '';
            }
        }
    }

    let lastUserText = '';
    if (pendingUser) {
        lastUserText = pendingUser;
    } else if (pairs.length > 0 && toolResults.length === 0) {
        const last = pairs.pop()!;
        lastUserText = last.userText;
    }

    return { systemPrompt, userText: lastUserText, turns: pairs, toolResults };
}

// ============================================================================
// MCP Tool Definitions
// ============================================================================

function buildMcpToolDefinitions(tools: OpenAIToolDef[]): McpToolDefinition[] {
    return tools.map((t) => {
        const fn = t.function;
        const jsonSchema: JsonValue =
            fn.parameters && typeof fn.parameters === 'object'
                ? (fn.parameters as JsonValue)
                : { type: 'object', properties: {}, required: [] };
        const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema));
        return create(McpToolDefinitionSchema, {
            name: fn.name,
            description: fn.description || '',
            providerIdentifier: 'alma',
            toolName: fn.name,
            inputSchema,
        });
    });
}

function decodeMcpArgValue(value: Uint8Array): unknown {
    try {
        const parsed = fromBinary(ValueSchema, value);
        return toJson(ValueSchema, parsed);
    } catch {}
    return new TextDecoder().decode(value);
}

function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
    const decoded: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
        decoded[key] = decodeMcpArgValue(value);
    }
    return decoded;
}

// ============================================================================
// gRPC Request Building
// ============================================================================

function buildCursorRequest(
    modelId: string,
    systemPrompt: string,
    userText: string,
    turns: Array<{ userText: string; assistantText: string }>,
): CursorRequestPayload {
    const blobStore = new Map<string, Uint8Array>();

    const turnBytes: Uint8Array[] = [];
    for (const turn of turns) {
        const userMsg = create(UserMessageSchema, { text: turn.userText, messageId: crypto.randomUUID() });
        const userMsgBytes = toBinary(UserMessageSchema, userMsg);
        const stepBytes: Uint8Array[] = [];
        if (turn.assistantText) {
            const step = create(ConversationStepSchema, {
                message: { case: 'assistantMessage', value: create(AssistantMessageSchema, { text: turn.assistantText }) },
            });
            stepBytes.push(toBinary(ConversationStepSchema, step));
        }
        const agentTurn = create(AgentConversationTurnStructureSchema, { userMessage: userMsgBytes, steps: stepBytes });
        const turnStructure = create(ConversationTurnStructureSchema, {
            turn: { case: 'agentConversationTurn', value: agentTurn },
        });
        turnBytes.push(toBinary(ConversationTurnStructureSchema, turnStructure));
    }

    // System prompt -> blob store (Cursor requests it back via KV handshake)
    const systemJson = JSON.stringify({ role: 'system', content: systemPrompt });
    const systemBytes = new TextEncoder().encode(systemJson);
    const systemBlobId = new Uint8Array(createHash('sha256').update(systemBytes).digest());
    blobStore.set(Buffer.from(systemBlobId).toString('hex'), systemBytes);

    const conversationState = create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [systemBlobId],
        turns: turnBytes,
        todos: [], pendingToolCalls: [], previousWorkspaceUris: [],
        fileStates: {}, fileStatesV2: {},
        summaryArchives: [], turnTimings: [], subagentStates: {},
        selfSummaryCount: 0, readPaths: [],
    });

    const userMessage = create(UserMessageSchema, { text: userText, messageId: crypto.randomUUID() });
    const action = create(ConversationActionSchema, {
        action: { case: 'userMessageAction', value: create(UserMessageActionSchema, { userMessage }) },
    });
    const modelDetails = create(ModelDetailsSchema, { modelId, displayModelId: modelId, displayName: modelId });
    const runRequest = create(AgentRunRequestSchema, { conversationState, action, modelDetails, conversationId: crypto.randomUUID() });
    const clientMessage = create(AgentClientMessageSchema, { message: { case: 'runRequest', value: runRequest } });

    return { requestBytes: toBinary(AgentClientMessageSchema, clientMessage), blobStore, mcpTools: [] };
}

// ============================================================================
// Connect Protocol Helpers
// ============================================================================

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
    const frame = Buffer.alloc(5 + data.length);
    frame[0] = flags;
    frame.writeUInt32BE(data.length, 1);
    frame.set(data, 5);
    return frame;
}

function parseConnectEndStream(data: Uint8Array): Error | null {
    try {
        const payload = JSON.parse(new TextDecoder().decode(data));
        const error = payload?.error;
        if (error) {
            const code = typeof error.code === 'string' ? error.code : 'unknown';
            const message = typeof error.message === 'string' ? error.message : 'Unknown error';
            return new Error(`Connect error ${code}: ${message}`);
        }
        return null;
    } catch {
        return new Error('Failed to parse Connect end stream');
    }
}

function makeHeartbeatBytes(): Buffer {
    const heartbeat = create(AgentClientMessageSchema, {
        message: { case: 'clientHeartbeat', value: create(ClientHeartbeatSchema, {}) },
    });
    return frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeat));
}

// ============================================================================
// HTTP/2 Stream
// ============================================================================

function createH2Stream(accessToken: string): { client: http2.ClientHttp2Session; stream: http2.ClientHttp2Stream } {
    const client = http2.connect(CURSOR_API_URL);
    client.on('error', () => {});
    const stream = client.request({
        ':method': 'POST',
        ':path': '/agent.v1.AgentService/Run',
        'content-type': 'application/connect+proto',
        'connect-protocol-version': '1',
        'te': 'trailers',
        'authorization': `Bearer ${accessToken}`,
        'x-ghost-mode': 'true',
        'x-cursor-client-version': CURSOR_CLIENT_VERSION,
        'x-cursor-client-type': 'cli',
        'x-request-id': crypto.randomUUID(),
    });
    return { client, stream };
}

// ============================================================================
// Server Message Processing
// ============================================================================

function processServerMessage(
    msg: AgentServerMessage,
    blobStore: Map<string, Uint8Array>,
    mcpTools: McpToolDefinition[],
    sendFrame: (data: Buffer) => void,
    state: StreamState,
    onText: (text: string, isThinking?: boolean) => void,
    onMcpExec: (exec: PendingExec) => void,
): void {
    const msgCase = msg.message.case;
    if (msgCase === 'interactionUpdate') {
        const update = msg.message.value as any;
        const updateCase = update.message?.case;
        if (updateCase === 'textDelta') {
            const delta = update.message.value.text || '';
            if (delta) onText(delta, false);
        } else if (updateCase === 'thinkingDelta') {
            const delta = update.message.value.text || '';
            if (delta) onText(delta, true);
        }
    } else if (msgCase === 'kvServerMessage') {
        handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
    } else if (msgCase === 'execServerMessage') {
        handleExecMessage(msg.message.value as ExecServerMessage, mcpTools, sendFrame, onMcpExec);
    }
}

function handleKvMessage(kvMsg: KvServerMessage, blobStore: Map<string, Uint8Array>, sendFrame: (data: Buffer) => void): void {
    const kvCase = kvMsg.message.case;
    if (kvCase === 'getBlobArgs') {
        const blobId = kvMsg.message.value.blobId;
        const blobData = blobStore.get(Buffer.from(blobId).toString('hex'));
        const response = create(KvClientMessageSchema, {
            id: kvMsg.id,
            message: { case: 'getBlobResult', value: create(GetBlobResultSchema, blobData ? { blobData } : {}) },
        });
        const clientMsg = create(AgentClientMessageSchema, { message: { case: 'kvClientMessage', value: response } });
        sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
    } else if (kvCase === 'setBlobArgs') {
        const { blobId, blobData } = kvMsg.message.value;
        blobStore.set(Buffer.from(blobId).toString('hex'), blobData);
        const response = create(KvClientMessageSchema, {
            id: kvMsg.id,
            message: { case: 'setBlobResult', value: create(SetBlobResultSchema, {}) },
        });
        const clientMsg = create(AgentClientMessageSchema, { message: { case: 'kvClientMessage', value: response } });
        sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
    }
}

function handleExecMessage(
    execMsg: ExecServerMessage,
    mcpTools: McpToolDefinition[],
    sendFrame: (data: Buffer) => void,
    onMcpExec: (exec: PendingExec) => void,
): void {
    const execCase = execMsg.message.case;
    const REJECT = 'Tool not available in this environment. Use the MCP tools provided instead.';

    if (execCase === 'requestContextArgs') {
        const ctx = create(RequestContextSchema, { rules: [], repositoryInfo: [], tools: mcpTools, gitRepos: [], projectLayouts: [], mcpInstructions: [], fileContents: {}, customSubagents: [] });
        const result = create(RequestContextResultSchema, { result: { case: 'success', value: create(RequestContextSuccessSchema, { requestContext: ctx }) } });
        sendExecResult(execMsg, 'requestContextResult', result, sendFrame);
    } else if (execCase === 'mcpArgs') {
        const mcpArgs = execMsg.message.value;
        const decoded = decodeMcpArgsMap(mcpArgs.args ?? {});
        onMcpExec({ execId: execMsg.execId, execMsgId: execMsg.id, toolCallId: mcpArgs.toolCallId || crypto.randomUUID(), toolName: mcpArgs.toolName || mcpArgs.name, decodedArgs: JSON.stringify(decoded) });
    } else if (execCase === 'readArgs') {
        sendExecResult(execMsg, 'readResult', create(ReadResultSchema, { result: { case: 'rejected', value: create(ReadRejectedSchema, { path: execMsg.message.value.path, reason: REJECT }) } }), sendFrame);
    } else if (execCase === 'lsArgs') {
        sendExecResult(execMsg, 'lsResult', create(LsResultSchema, { result: { case: 'rejected', value: create(LsRejectedSchema, { path: execMsg.message.value.path, reason: REJECT }) } }), sendFrame);
    } else if (execCase === 'grepArgs') {
        sendExecResult(execMsg, 'grepResult', create(GrepResultSchema, { result: { case: 'error', value: create(GrepErrorSchema, { error: REJECT }) } }), sendFrame);
    } else if (execCase === 'writeArgs') {
        sendExecResult(execMsg, 'writeResult', create(WriteResultSchema, { result: { case: 'rejected', value: create(WriteRejectedSchema, { path: execMsg.message.value.path, reason: REJECT }) } }), sendFrame);
    } else if (execCase === 'deleteArgs') {
        sendExecResult(execMsg, 'deleteResult', create(DeleteResultSchema, { result: { case: 'rejected', value: create(DeleteRejectedSchema, { path: execMsg.message.value.path, reason: REJECT }) } }), sendFrame);
    } else if (execCase === 'shellArgs' || execCase === 'shellStreamArgs') {
        const args = execMsg.message.value;
        sendExecResult(execMsg, 'shellResult', create(ShellResultSchema, { result: { case: 'rejected', value: create(ShellRejectedSchema, { command: args.command ?? '', workingDirectory: args.workingDirectory ?? '', reason: REJECT, isReadonly: false }) } }), sendFrame);
    } else if (execCase === 'backgroundShellSpawnArgs') {
        const args = execMsg.message.value;
        sendExecResult(execMsg, 'backgroundShellSpawnResult', create(BackgroundShellSpawnResultSchema, { result: { case: 'rejected', value: create(ShellRejectedSchema, { command: args.command ?? '', workingDirectory: args.workingDirectory ?? '', reason: REJECT, isReadonly: false }) } }), sendFrame);
    } else if (execCase === 'writeShellStdinArgs') {
        sendExecResult(execMsg, 'writeShellStdinResult', create(WriteShellStdinResultSchema, { result: { case: 'error', value: create(WriteShellStdinErrorSchema, { error: REJECT }) } }), sendFrame);
    } else if (execCase === 'fetchArgs') {
        sendExecResult(execMsg, 'fetchResult', create(FetchResultSchema, { result: { case: 'error', value: create(FetchErrorSchema, { url: execMsg.message.value.url ?? '', error: REJECT }) } }), sendFrame);
    } else if (execCase === 'diagnosticsArgs') {
        sendExecResult(execMsg, 'diagnosticsResult', create(DiagnosticsResultSchema, {}), sendFrame);
    } else {
        const miscMap: Record<string, string> = { listMcpResourcesExecArgs: 'listMcpResourcesExecResult', readMcpResourceExecArgs: 'readMcpResourceExecResult', recordScreenArgs: 'recordScreenResult', computerUseArgs: 'computerUseResult' };
        const resultCase = miscMap[execCase as string];
        if (resultCase) sendExecResult(execMsg, resultCase, create(McpResultSchema, {}), sendFrame);
    }
}

function sendExecResult(execMsg: ExecServerMessage, messageCase: string, value: unknown, sendFrame: (data: Buffer) => void): void {
    const execClient = create(ExecClientMessageSchema, { id: execMsg.id, execId: execMsg.execId, message: { case: messageCase as any, value: value as any } });
    const clientMsg = create(AgentClientMessageSchema, { message: { case: 'execClientMessage', value: execClient } });
    sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
}

// ============================================================================
// Session Key
// ============================================================================

function deriveSessionKey(modelId: string, messages: OpenAIMessage[]): string {
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
    return createHash('sha256').update(`${modelId}:${firstUser.slice(0, 200)}`).digest('hex').slice(0, 16);
}

// ============================================================================
// SSE Stream Builder (shared by streaming & tool resume)
// ============================================================================

function buildSSEStream(
    h2Client: http2.ClientHttp2Session,
    h2Stream: http2.ClientHttp2Stream,
    heartbeatTimer: NodeJS.Timeout,
    payload: { blobStore: Map<string, Uint8Array>; mcpTools: McpToolDefinition[] },
    modelId: string,
    sessionKey: string,
): ReadableStream<Uint8Array> {
    const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 28)}`;
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();

    return new ReadableStream({
        start(controller) {
            let closed = false;
            const send = (data: object) => { if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); };
            const done = () => { if (!closed) controller.enqueue(encoder.encode('data: [DONE]\n\n')); };
            const close = () => { if (closed) return; closed = true; controller.close(); };

            const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
                id: completionId, object: 'chat.completion.chunk', created, model: modelId,
                choices: [{ index: 0, delta, finish_reason: finish }],
            });

            const state: StreamState = { thinkingActive: false, toolCallIndex: 0, pendingExecs: [] };
            let mcpExecReceived = false;
            let pendingBuffer = Buffer.alloc(0);

            const processChunk = (incoming: Buffer) => {
                pendingBuffer = Buffer.concat([pendingBuffer, incoming]);
                while (pendingBuffer.length >= 5) {
                    const flags = pendingBuffer[0]!;
                    const msgLen = pendingBuffer.readUInt32BE(1);
                    if (pendingBuffer.length < 5 + msgLen) break;
                    const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
                    pendingBuffer = pendingBuffer.subarray(5 + msgLen);

                    if (flags & CONNECT_END_STREAM_FLAG) {
                        const endError = parseConnectEndStream(messageBytes);
                        if (endError) send(chunk({ content: `\n[Error: ${endError.message}]` }));
                        continue;
                    }

                    try {
                        const serverMsg = fromBinary(AgentServerMessageSchema, messageBytes);
                        processServerMessage(
                            serverMsg, payload.blobStore, payload.mcpTools,
                            (data) => { if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(data); },
                            state,
                            (text, isThinking) => {
                                if (isThinking) {
                                    if (!state.thinkingActive) { state.thinkingActive = true; send(chunk({ role: 'assistant', content: '<think>' })); }
                                    send(chunk({ content: text }));
                                } else {
                                    if (state.thinkingActive) { state.thinkingActive = false; send(chunk({ content: '</think>' })); }
                                    send(chunk({ content: text }));
                                }
                            },
                            (exec) => {
                                state.pendingExecs.push(exec);
                                mcpExecReceived = true;
                                if (state.thinkingActive) { send(chunk({ content: '</think>' })); state.thinkingActive = false; }
                                send(chunk({ tool_calls: [{ index: state.toolCallIndex++, id: exec.toolCallId, type: 'function', function: { name: exec.toolName, arguments: exec.decodedArgs } }] }));
                                activeSessions.set(sessionKey, { h2Client, h2Stream, heartbeatTimer, blobStore: payload.blobStore, mcpTools: payload.mcpTools, pendingExecs: state.pendingExecs });
                                send(chunk({}, 'tool_calls'));
                                done(); close();
                            },
                        );
                    } catch { /* skip unparseable */ }
                }
            };

            h2Stream.on('data', processChunk);
            h2Stream.on('end', () => {
                clearInterval(heartbeatTimer);
                h2Client.close();
                if (!mcpExecReceived) {
                    if (state.thinkingActive) send(chunk({ content: '</think>' }));
                    send(chunk({}, 'stop'));
                    done(); close();
                }
            });
            h2Stream.on('error', () => {
                clearInterval(heartbeatTimer);
                try { h2Client.close(); } catch {}
                if (!mcpExecReceived) { send(chunk({}, 'stop')); done(); close(); }
            });
        },
    });
}

// ============================================================================
// Streaming Response
// ============================================================================

function handleStreaming(
    payload: CursorRequestPayload,
    accessToken: string,
    modelId: string,
    sessionKey: string,
    logger: Logger,
): Response {
    const { client: h2Client, stream: h2Stream } = createH2Stream(accessToken);
    h2Stream.write(frameConnectMessage(payload.requestBytes));

    const heartbeatTimer = setInterval(() => {
        if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(makeHeartbeatBytes());
    }, 5_000);

    const sseStream = buildSSEStream(h2Client, h2Stream, heartbeatTimer, payload, modelId, sessionKey);

    return new Response(sseStream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
}

// ============================================================================
// Tool Result Resume
// ============================================================================

function resumeWithToolResults(
    session: ActiveSession,
    toolResults: ToolResultInfo[],
    modelId: string,
    tools: OpenAIToolDef[],
    accessToken: string,
    sessionKey: string,
    logger: Logger,
): Response {
    const { h2Client, h2Stream, heartbeatTimer, blobStore, mcpTools, pendingExecs } = session;

    // Send mcpResult for each pending exec
    for (const exec of pendingExecs) {
        const result = toolResults.find((r) => r.toolCallId === exec.toolCallId);
        const mcpResult = result
            ? create(McpResultSchema, { result: { case: 'success', value: create(McpSuccessSchema, { content: [create(McpToolResultContentItemSchema, { content: { case: 'text', value: create(McpTextContentSchema, { text: result.content }) } })], isError: false }) } })
            : create(McpResultSchema, { result: { case: 'error', value: create(McpErrorSchema, { error: 'Tool result not provided' }) } });

        const execClient = create(ExecClientMessageSchema, { id: exec.execMsgId, execId: exec.execId, message: { case: 'mcpResult' as any, value: mcpResult as any } });
        const clientMsg = create(AgentClientMessageSchema, { message: { case: 'execClientMessage', value: execClient } });
        if (!h2Stream.closed && !h2Stream.destroyed) {
            h2Stream.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
        }
    }

    // Re-attach listeners for continuation
    h2Stream.removeAllListeners('data');
    h2Stream.removeAllListeners('end');
    h2Stream.removeAllListeners('error');

    const sseStream = buildSSEStream(h2Client, h2Stream, heartbeatTimer, { blobStore, mcpTools }, modelId, sessionKey);

    return new Response(sseStream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
}

// ============================================================================
// Non-Streaming Response
// ============================================================================

async function handleNonStreaming(
    payload: CursorRequestPayload,
    accessToken: string,
    modelId: string,
    logger: Logger,
): Promise<Response> {
    const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 28)}`;
    const created = Math.floor(Date.now() / 1000);

    const fullText = await collectFullResponse(payload, accessToken);

    return new Response(JSON.stringify({
        id: completionId, object: 'chat.completion', created, model: modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }), { headers: { 'Content-Type': 'application/json' } });
}

function collectFullResponse(
    payload: CursorRequestPayload,
    accessToken: string,
): Promise<string> {
    const { promise, resolve } = Promise.withResolvers<string>();

    const { client: h2Client, stream: h2Stream } = createH2Stream(accessToken);
    h2Stream.write(frameConnectMessage(payload.requestBytes));

    const heartbeatTimer = setInterval(() => {
        if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(makeHeartbeatBytes());
    }, 5_000);

    let fullText = '';
    let pendingBuffer = Buffer.alloc(0);
    const state: StreamState = { thinkingActive: false, toolCallIndex: 0, pendingExecs: [] };

    h2Stream.on('data', (incoming: Buffer) => {
        pendingBuffer = Buffer.concat([pendingBuffer, incoming]);
        while (pendingBuffer.length >= 5) {
            const flags = pendingBuffer[0]!;
            const msgLen = pendingBuffer.readUInt32BE(1);
            if (pendingBuffer.length < 5 + msgLen) break;
            const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
            pendingBuffer = pendingBuffer.subarray(5 + msgLen);
            if (flags & CONNECT_END_STREAM_FLAG) continue;
            try {
                const serverMsg = fromBinary(AgentServerMessageSchema, messageBytes);
                processServerMessage(serverMsg, payload.blobStore, payload.mcpTools,
                    (data) => { if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(data); },
                    state, (text) => { fullText += text; }, () => {});
            } catch { /* skip */ }
        }
    });

    h2Stream.on('end', () => { clearInterval(heartbeatTimer); h2Client.close(); resolve(fullText); });
    h2Stream.on('error', () => { clearInterval(heartbeatTimer); try { h2Client.close(); } catch {} resolve(fullText); });

    return promise;
}
