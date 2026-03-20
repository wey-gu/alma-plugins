/**
 * Local OpenAI-compatible proxy + custom fetch for Cursor's gRPC protocol.
 *
 * This follows opencode-cursor's architecture exactly:
 * 1. startProxy() creates a real HTTP server on localhost (random port)
 * 2. getSDKConfig() returns baseURL pointing to localhost proxy
 * 3. Custom fetch just strips auth headers and forwards to localhost
 * 4. Proxy handles all gRPC translation internally
 *
 * Why a proxy instead of a custom fetch interceptor?
 * Cursor uses gRPC (protobuf over HTTP/2), not REST. The AI SDK may make
 * requests that bypass custom fetch (health checks, retries, etc.).
 * A real HTTP server ensures ALL requests are properly handled.
 */

import * as http from 'node:http';
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

const activeSessions = new Map<string, ActiveSession>();

export interface Logger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
}

// ============================================================================
// Proxy Server (matching opencode-cursor's startProxy/stopProxy)
// ============================================================================

let proxyServer: http.Server | undefined;
let proxyPort: number | undefined;

export function getProxyPort(): number | undefined {
    return proxyPort;
}

export function startProxy(getAccessToken: () => Promise<string>, logger: Logger): Promise<number> {
    if (proxyServer && proxyPort) return Promise.resolve(proxyPort);

    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            // GET /v1/models — return empty list
            if (req.method === 'GET' && req.url?.includes('/models')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ object: 'list', data: [] }));
                return;
            }

            // POST /v1/chat/completions — translate to Cursor gRPC
            if (req.method === 'POST') {
                try {
                    const bodyStr = await readBody(req);
                    const body = JSON.parse(bodyStr) as ChatCompletionRequest;
                    const accessToken = await getAccessToken();

                    logger.debug(`Cursor proxy: model=${body.model}, stream=${body.stream}, messages=${body.messages?.length}`);

                    handleChatCompletion(body, accessToken, res, logger);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    logger.error('Cursor proxy error:', message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message, type: 'server_error', code: 'internal_error' } }));
                }
                return;
            }

            res.writeHead(404);
            res.end('Not Found');
        });

        server.listen(0, () => {
            const addr = server.address();
            if (typeof addr === 'object' && addr) {
                proxyPort = addr.port;
                proxyServer = server;
                logger.info(`Cursor proxy started on port ${proxyPort}`);
                resolve(addr.port);
            } else {
                reject(new Error('Failed to bind proxy to a port'));
            }
        });

        server.on('error', reject);
    });
}

export function stopProxy(): void {
    if (proxyServer) {
        proxyServer.close();
        proxyServer = undefined;
        proxyPort = undefined;
    }
    for (const [key, session] of activeSessions) {
        clearInterval(session.heartbeatTimer);
        try { session.h2Stream.close(); } catch {}
        try { session.h2Client.close(); } catch {}
        activeSessions.delete(key);
    }
}

/**
 * Custom fetch that strips auth headers and forwards to local proxy.
 * Matches opencode-cursor's fetch wrapper exactly.
 */
export function createProxyFetch(): typeof globalThis.fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (init?.headers) {
            if (init.headers instanceof Headers) {
                init.headers.delete('authorization');
                init.headers.delete('Authorization');
            } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                    ([key]) => key.toLowerCase() !== 'authorization',
                );
            } else {
                delete (init.headers as Record<string, string>)['authorization'];
                delete (init.headers as Record<string, string>)['Authorization'];
            }
        }
        return fetch(input, init);
    };
}

// ============================================================================
// Helpers
// ============================================================================

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

// ============================================================================
// Chat Completion Handler
// ============================================================================

function handleChatCompletion(
    body: ChatCompletionRequest,
    accessToken: string,
    res: http.ServerResponse,
    logger: Logger,
): void {
    const { systemPrompt, userText, turns, toolResults } = parseMessages(body.messages);
    const modelId = body.model;
    const tools = body.tools ?? [];

    if (!userText && toolResults.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No user message found', type: 'invalid_request_error' } }));
        return;
    }

    const sessionKey = deriveSessionKey(modelId, body.messages);
    const activeSession = activeSessions.get(sessionKey);

    if (activeSession && toolResults.length > 0) {
        activeSessions.delete(sessionKey);
        resumeWithToolResults(activeSession, toolResults, modelId, sessionKey, res);
        return;
    }

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
        handleNonStreaming(payload, accessToken, modelId, res);
    } else {
        handleStreaming(payload, accessToken, modelId, sessionKey, res);
    }
}

// ============================================================================
// Message Parsing
// ============================================================================

function parseMessages(messages: OpenAIMessage[]): { systemPrompt: string; userText: string; turns: Array<{ userText: string; assistantText: string }>; toolResults: ToolResultInfo[] } {
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
            if (pendingUser) { pairs.push({ userText: pendingUser, assistantText: msg.content ?? '' }); pendingUser = ''; }
        }
    }

    let lastUserText = '';
    if (pendingUser) { lastUserText = pendingUser; }
    else if (pairs.length > 0 && toolResults.length === 0) { const last = pairs.pop()!; lastUserText = last.userText; }

    return { systemPrompt, userText: lastUserText, turns: pairs, toolResults };
}

// ============================================================================
// MCP Tool Definitions
// ============================================================================

function buildMcpToolDefinitions(tools: OpenAIToolDef[]): McpToolDefinition[] {
    return tools.map((t) => {
        const fn = t.function;
        const jsonSchema: JsonValue = fn.parameters && typeof fn.parameters === 'object'
            ? (fn.parameters as JsonValue) : { type: 'object', properties: {}, required: [] };
        const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema));
        return create(McpToolDefinitionSchema, { name: fn.name, description: fn.description || '', providerIdentifier: 'alma', toolName: fn.name, inputSchema });
    });
}

function decodeMcpArgValue(value: Uint8Array): unknown {
    try { return toJson(ValueSchema, fromBinary(ValueSchema, value)); } catch {} return new TextDecoder().decode(value);
}

function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
    const decoded: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) decoded[key] = decodeMcpArgValue(value);
    return decoded;
}

// ============================================================================
// gRPC Request Building
// ============================================================================

function buildCursorRequest(modelId: string, systemPrompt: string, userText: string, turns: Array<{ userText: string; assistantText: string }>): CursorRequestPayload {
    const blobStore = new Map<string, Uint8Array>();
    const turnBytes: Uint8Array[] = [];

    for (const turn of turns) {
        const userMsg = create(UserMessageSchema, { text: turn.userText, messageId: crypto.randomUUID() });
        const stepBytes: Uint8Array[] = [];
        if (turn.assistantText) {
            stepBytes.push(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
                message: { case: 'assistantMessage', value: create(AssistantMessageSchema, { text: turn.assistantText }) },
            })));
        }
        const agentTurn = create(AgentConversationTurnStructureSchema, { userMessage: toBinary(UserMessageSchema, userMsg), steps: stepBytes });
        turnBytes.push(toBinary(ConversationTurnStructureSchema, create(ConversationTurnStructureSchema, {
            turn: { case: 'agentConversationTurn', value: agentTurn },
        })));
    }

    const systemJson = JSON.stringify({ role: 'system', content: systemPrompt });
    const systemBytes = new TextEncoder().encode(systemJson);
    const systemBlobId = new Uint8Array(createHash('sha256').update(systemBytes).digest());
    blobStore.set(Buffer.from(systemBlobId).toString('hex'), systemBytes);

    const conversationState = create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [systemBlobId], turns: turnBytes,
        todos: [], pendingToolCalls: [], previousWorkspaceUris: [],
        fileStates: {}, fileStatesV2: {}, summaryArchives: [], turnTimings: [],
        subagentStates: {}, selfSummaryCount: 0, readPaths: [],
    });

    const userMessage = create(UserMessageSchema, { text: userText, messageId: crypto.randomUUID() });
    const action = create(ConversationActionSchema, { action: { case: 'userMessageAction', value: create(UserMessageActionSchema, { userMessage }) } });
    const modelDetails = create(ModelDetailsSchema, { modelId, displayModelId: modelId, displayName: modelId });
    const runRequest = create(AgentRunRequestSchema, { conversationState, action, modelDetails, conversationId: crypto.randomUUID() });
    const clientMessage = create(AgentClientMessageSchema, { message: { case: 'runRequest', value: runRequest } });

    return { requestBytes: toBinary(AgentClientMessageSchema, clientMessage), blobStore, mcpTools: [] };
}

// ============================================================================
// Connect Protocol
// ============================================================================

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
    const frame = Buffer.alloc(5 + data.length);
    frame[0] = flags; frame.writeUInt32BE(data.length, 1); frame.set(data, 5);
    return frame;
}

function parseConnectEndStream(data: Uint8Array): Error | null {
    try {
        const p = JSON.parse(new TextDecoder().decode(data));
        if (p?.error) return new Error(`Connect error ${p.error.code ?? 'unknown'}: ${p.error.message ?? 'Unknown'}`);
        return null;
    } catch { return new Error('Failed to parse Connect end stream'); }
}

function makeHeartbeatBytes(): Buffer {
    return frameConnectMessage(toBinary(AgentClientMessageSchema,
        create(AgentClientMessageSchema, { message: { case: 'clientHeartbeat', value: create(ClientHeartbeatSchema, {}) } })));
}

// ============================================================================
// HTTP/2 Stream
// ============================================================================

function createH2Stream(accessToken: string): { client: http2.ClientHttp2Session; stream: http2.ClientHttp2Stream } {
    const client = http2.connect(CURSOR_API_URL);
    client.on('error', () => {});
    const stream = client.request({
        ':method': 'POST', ':path': '/agent.v1.AgentService/Run',
        'content-type': 'application/connect+proto', 'connect-protocol-version': '1',
        'te': 'trailers', 'authorization': `Bearer ${accessToken}`,
        'x-ghost-mode': 'true', 'x-cursor-client-version': CURSOR_CLIENT_VERSION,
        'x-cursor-client-type': 'cli', 'x-request-id': crypto.randomUUID(),
    });
    return { client, stream };
}

// ============================================================================
// Server Message Processing
// ============================================================================

function processServerMessage(
    msg: AgentServerMessage, blobStore: Map<string, Uint8Array>, mcpTools: McpToolDefinition[],
    sendFrame: (data: Buffer) => void, state: StreamState,
    onText: (text: string, isThinking?: boolean) => void, onMcpExec: (exec: PendingExec) => void,
): void {
    const c = msg.message.case;
    if (c === 'interactionUpdate') {
        const u = (msg.message.value as any).message;
        if (u?.case === 'textDelta' && u.value.text) onText(u.value.text, false);
        else if (u?.case === 'thinkingDelta' && u.value.text) onText(u.value.text, true);
    } else if (c === 'kvServerMessage') handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
    else if (c === 'execServerMessage') handleExecMessage(msg.message.value as ExecServerMessage, mcpTools, sendFrame, onMcpExec);
}

function handleKvMessage(kv: KvServerMessage, blobStore: Map<string, Uint8Array>, sendFrame: (data: Buffer) => void): void {
    if (kv.message.case === 'getBlobArgs') {
        const blobData = blobStore.get(Buffer.from(kv.message.value.blobId).toString('hex'));
        const r = create(KvClientMessageSchema, { id: kv.id, message: { case: 'getBlobResult', value: create(GetBlobResultSchema, blobData ? { blobData } : {}) } });
        sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, { message: { case: 'kvClientMessage', value: r } }))));
    } else if (kv.message.case === 'setBlobArgs') {
        blobStore.set(Buffer.from(kv.message.value.blobId).toString('hex'), kv.message.value.blobData);
        const r = create(KvClientMessageSchema, { id: kv.id, message: { case: 'setBlobResult', value: create(SetBlobResultSchema, {}) } });
        sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, { message: { case: 'kvClientMessage', value: r } }))));
    }
}

function handleExecMessage(exec: ExecServerMessage, mcpTools: McpToolDefinition[], sendFrame: (data: Buffer) => void, onMcpExec: (e: PendingExec) => void): void {
    const c = exec.message.case;
    const R = 'Tool not available in this environment. Use the MCP tools provided instead.';

    if (c === 'requestContextArgs') {
        const ctx = create(RequestContextSchema, { rules: [], repositoryInfo: [], tools: mcpTools, gitRepos: [], projectLayouts: [], mcpInstructions: [], fileContents: {}, customSubagents: [] });
        sendExec(exec, 'requestContextResult', create(RequestContextResultSchema, { result: { case: 'success', value: create(RequestContextSuccessSchema, { requestContext: ctx }) } }), sendFrame);
    } else if (c === 'mcpArgs') {
        const a = exec.message.value;
        onMcpExec({ execId: exec.execId, execMsgId: exec.id, toolCallId: a.toolCallId || crypto.randomUUID(), toolName: a.toolName || a.name, decodedArgs: JSON.stringify(decodeMcpArgsMap(a.args ?? {})) });
    } else if (c === 'readArgs') sendExec(exec, 'readResult', create(ReadResultSchema, { result: { case: 'rejected', value: create(ReadRejectedSchema, { path: exec.message.value.path, reason: R }) } }), sendFrame);
    else if (c === 'lsArgs') sendExec(exec, 'lsResult', create(LsResultSchema, { result: { case: 'rejected', value: create(LsRejectedSchema, { path: exec.message.value.path, reason: R }) } }), sendFrame);
    else if (c === 'grepArgs') sendExec(exec, 'grepResult', create(GrepResultSchema, { result: { case: 'error', value: create(GrepErrorSchema, { error: R }) } }), sendFrame);
    else if (c === 'writeArgs') sendExec(exec, 'writeResult', create(WriteResultSchema, { result: { case: 'rejected', value: create(WriteRejectedSchema, { path: exec.message.value.path, reason: R }) } }), sendFrame);
    else if (c === 'deleteArgs') sendExec(exec, 'deleteResult', create(DeleteResultSchema, { result: { case: 'rejected', value: create(DeleteRejectedSchema, { path: exec.message.value.path, reason: R }) } }), sendFrame);
    else if (c === 'shellArgs' || c === 'shellStreamArgs') { const a = exec.message.value; sendExec(exec, 'shellResult', create(ShellResultSchema, { result: { case: 'rejected', value: create(ShellRejectedSchema, { command: a.command ?? '', workingDirectory: a.workingDirectory ?? '', reason: R, isReadonly: false }) } }), sendFrame); }
    else if (c === 'backgroundShellSpawnArgs') { const a = exec.message.value; sendExec(exec, 'backgroundShellSpawnResult', create(BackgroundShellSpawnResultSchema, { result: { case: 'rejected', value: create(ShellRejectedSchema, { command: a.command ?? '', workingDirectory: a.workingDirectory ?? '', reason: R, isReadonly: false }) } }), sendFrame); }
    else if (c === 'writeShellStdinArgs') sendExec(exec, 'writeShellStdinResult', create(WriteShellStdinResultSchema, { result: { case: 'error', value: create(WriteShellStdinErrorSchema, { error: R }) } }), sendFrame);
    else if (c === 'fetchArgs') sendExec(exec, 'fetchResult', create(FetchResultSchema, { result: { case: 'error', value: create(FetchErrorSchema, { url: exec.message.value.url ?? '', error: R }) } }), sendFrame);
    else if (c === 'diagnosticsArgs') sendExec(exec, 'diagnosticsResult', create(DiagnosticsResultSchema, {}), sendFrame);
    else { const m: Record<string, string> = { listMcpResourcesExecArgs: 'listMcpResourcesExecResult', readMcpResourceExecArgs: 'readMcpResourceExecResult', recordScreenArgs: 'recordScreenResult', computerUseArgs: 'computerUseResult' }; if (m[c as string]) sendExec(exec, m[c as string], create(McpResultSchema, {}), sendFrame); }
}

function sendExec(exec: ExecServerMessage, mc: string, v: unknown, sendFrame: (data: Buffer) => void): void {
    sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema,
        create(AgentClientMessageSchema, { message: { case: 'execClientMessage', value: create(ExecClientMessageSchema, { id: exec.id, execId: exec.execId, message: { case: mc as any, value: v as any } }) } }))));
}

function deriveSessionKey(modelId: string, messages: OpenAIMessage[]): string {
    const first = messages.find((m) => m.role === 'user')?.content ?? '';
    return createHash('sha256').update(`${modelId}:${first.slice(0, 200)}`).digest('hex').slice(0, 16);
}

// ============================================================================
// Streaming (writes SSE directly to http.ServerResponse)
// ============================================================================

function handleStreaming(payload: CursorRequestPayload, accessToken: string, modelId: string, sessionKey: string, res: http.ServerResponse): void {
    const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 28)}`;
    const created = Math.floor(Date.now() / 1000);

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

    let closed = false;
    const sse = (d: object) => { if (!closed) res.write(`data: ${JSON.stringify(d)}\n\n`); };
    const done = () => { if (!closed) res.write('data: [DONE]\n\n'); };
    const end = () => { if (closed) return; closed = true; res.end(); };
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id, object: 'chat.completion.chunk', created, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] });

    const state: StreamState = { thinkingActive: false, toolCallIndex: 0, pendingExecs: [] };
    let mcpExecReceived = false;

    const { client: h2Client, stream: h2Stream } = createH2Stream(accessToken);
    h2Stream.write(frameConnectMessage(payload.requestBytes));

    const heartbeatTimer = setInterval(() => { if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(makeHeartbeatBytes()); }, 5_000);

    const processData = buildStreamProcessor(h2Stream, payload, state, chunk, sse, done, end, h2Client, heartbeatTimer, sessionKey, () => { mcpExecReceived = true; });

    h2Stream.on('data', processData);
    h2Stream.on('end', () => { clearInterval(heartbeatTimer); h2Client.close(); if (!mcpExecReceived) { if (state.thinkingActive) sse(chunk({ content: '</think>' })); sse(chunk({}, 'stop')); done(); end(); } });
    h2Stream.on('error', () => { clearInterval(heartbeatTimer); try { h2Client.close(); } catch {} if (!mcpExecReceived) { sse(chunk({}, 'stop')); done(); end(); } });
}

function buildStreamProcessor(
    h2Stream: http2.ClientHttp2Stream, payload: { blobStore: Map<string, Uint8Array>; mcpTools: McpToolDefinition[] },
    state: StreamState, chunk: (d: Record<string, unknown>, f?: string | null) => object,
    sse: (d: object) => void, done: () => void, end: () => void,
    h2Client: http2.ClientHttp2Session, heartbeatTimer: NodeJS.Timeout, sessionKey: string,
    onMcpFlag: () => void,
): (incoming: Buffer) => void {
    let pendingBuffer = Buffer.alloc(0);
    return (incoming: Buffer) => {
        pendingBuffer = Buffer.concat([pendingBuffer, incoming]);
        while (pendingBuffer.length >= 5) {
            const flags = pendingBuffer[0]!;
            const msgLen = pendingBuffer.readUInt32BE(1);
            if (pendingBuffer.length < 5 + msgLen) break;
            const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
            pendingBuffer = pendingBuffer.subarray(5 + msgLen);

            if (flags & CONNECT_END_STREAM_FLAG) { const e = parseConnectEndStream(messageBytes); if (e) sse(chunk({ content: `\n[Error: ${e.message}]` })); continue; }

            try {
                processServerMessage(fromBinary(AgentServerMessageSchema, messageBytes), payload.blobStore, payload.mcpTools,
                    (data) => { if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(data); }, state,
                    (text, isThinking) => {
                        if (isThinking) { if (!state.thinkingActive) { state.thinkingActive = true; sse(chunk({ role: 'assistant', content: '<think>' })); } sse(chunk({ content: text })); }
                        else { if (state.thinkingActive) { state.thinkingActive = false; sse(chunk({ content: '</think>' })); } sse(chunk({ content: text })); }
                    },
                    (exec) => {
                        state.pendingExecs.push(exec); onMcpFlag();
                        if (state.thinkingActive) { sse(chunk({ content: '</think>' })); state.thinkingActive = false; }
                        sse(chunk({ tool_calls: [{ index: state.toolCallIndex++, id: exec.toolCallId, type: 'function', function: { name: exec.toolName, arguments: exec.decodedArgs } }] }));
                        activeSessions.set(sessionKey, { h2Client, h2Stream, heartbeatTimer, blobStore: payload.blobStore, mcpTools: payload.mcpTools, pendingExecs: state.pendingExecs });
                        sse(chunk({}, 'tool_calls')); done(); end();
                    });
            } catch { /* skip */ }
        }
    };
}

// ============================================================================
// Tool Result Resume
// ============================================================================

function resumeWithToolResults(session: ActiveSession, toolResults: ToolResultInfo[], modelId: string, sessionKey: string, res: http.ServerResponse): void {
    const { h2Client, h2Stream, heartbeatTimer, blobStore, mcpTools, pendingExecs } = session;

    for (const exec of pendingExecs) {
        const result = toolResults.find((r) => r.toolCallId === exec.toolCallId);
        const mcpResult = result
            ? create(McpResultSchema, { result: { case: 'success', value: create(McpSuccessSchema, { content: [create(McpToolResultContentItemSchema, { content: { case: 'text', value: create(McpTextContentSchema, { text: result.content }) } })], isError: false }) } })
            : create(McpResultSchema, { result: { case: 'error', value: create(McpErrorSchema, { error: 'Tool result not provided' }) } });
        const cm = create(AgentClientMessageSchema, { message: { case: 'execClientMessage', value: create(ExecClientMessageSchema, { id: exec.execMsgId, execId: exec.execId, message: { case: 'mcpResult' as any, value: mcpResult as any } }) } });
        if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(frameConnectMessage(toBinary(AgentClientMessageSchema, cm)));
    }

    h2Stream.removeAllListeners('data');
    h2Stream.removeAllListeners('end');
    h2Stream.removeAllListeners('error');

    const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 28)}`;
    const created = Math.floor(Date.now() / 1000);

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

    let closed = false;
    const sse = (d: object) => { if (!closed) res.write(`data: ${JSON.stringify(d)}\n\n`); };
    const done = () => { if (!closed) res.write('data: [DONE]\n\n'); };
    const end = () => { if (closed) return; closed = true; res.end(); };
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id, object: 'chat.completion.chunk', created, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] });

    const state: StreamState = { thinkingActive: false, toolCallIndex: 0, pendingExecs: [] };
    let mcpExecReceived = false;

    const processData = buildStreamProcessor(h2Stream, { blobStore, mcpTools }, state, chunk, sse, done, end, h2Client, heartbeatTimer, sessionKey, () => { mcpExecReceived = true; });

    h2Stream.on('data', processData);
    h2Stream.on('end', () => { clearInterval(heartbeatTimer); h2Client.close(); if (!mcpExecReceived) { if (state.thinkingActive) sse(chunk({ content: '</think>' })); sse(chunk({}, 'stop')); done(); end(); } });
    h2Stream.on('error', () => { clearInterval(heartbeatTimer); try { h2Client.close(); } catch {} if (!mcpExecReceived) { sse(chunk({}, 'stop')); done(); end(); } });
}

// ============================================================================
// Non-Streaming
// ============================================================================

function handleNonStreaming(payload: CursorRequestPayload, accessToken: string, modelId: string, res: http.ServerResponse): void {
    const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 28)}`;
    const created = Math.floor(Date.now() / 1000);

    const { client: h2Client, stream: h2Stream } = createH2Stream(accessToken);
    h2Stream.write(frameConnectMessage(payload.requestBytes));

    const heartbeatTimer = setInterval(() => { if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(makeHeartbeatBytes()); }, 5_000);

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
            try { processServerMessage(fromBinary(AgentServerMessageSchema, messageBytes), payload.blobStore, payload.mcpTools, (data) => { if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(data); }, state, (text) => { fullText += text; }, () => {}); }
            catch { /* skip */ }
        }
    });

    h2Stream.on('end', () => {
        clearInterval(heartbeatTimer); h2Client.close();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, object: 'chat.completion', created, model: modelId, choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
    });

    h2Stream.on('error', () => {
        clearInterval(heartbeatTimer); try { h2Client.close(); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, object: 'chat.completion', created, model: modelId, choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
    });
}
