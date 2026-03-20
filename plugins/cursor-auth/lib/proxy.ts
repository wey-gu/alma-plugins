/**
 * Local OpenAI-compatible proxy that translates requests to Cursor's gRPC protocol.
 *
 * Accepts POST /v1/chat/completions in OpenAI format, translates to Cursor's
 * protobuf/HTTP2 Connect protocol, and streams back OpenAI-format SSE.
 *
 * Uses Node.js http2 directly (no child process bridge needed).
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
    McpToolNotFoundSchema,
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
    ParsedMessages,
    PendingExec,
    StreamState,
    ToolResultInfo,
} from './types';

const CURSOR_API_URL = 'https://api2.cursor.sh';
const CURSOR_CLIENT_VERSION = 'cli-2026.02.13-41ac335';
const CONNECT_END_STREAM_FLAG = 0b00000010;

// --- Types ---

interface CursorRequestPayload {
    requestBytes: Uint8Array;
    blobStore: Map<string, Uint8Array>;
    mcpTools: McpToolDefinition[];
}

interface ActiveBridge {
    h2Client: http2.ClientHttp2Session;
    h2Stream: http2.ClientHttp2Stream;
    heartbeatTimer: NodeJS.Timeout;
    blobStore: Map<string, Uint8Array>;
    mcpTools: McpToolDefinition[];
    pendingExecs: PendingExec[];
}

const activeBridges = new Map<string, ActiveBridge>();

// --- Server Management ---

let proxyServer: http.Server | undefined;
let proxyPort: number | undefined;

export function getProxyPort(): number | undefined {
    return proxyPort;
}

export function startProxy(getAccessToken: () => Promise<string>): Promise<number> {
    if (proxyServer && proxyPort) return Promise.resolve(proxyPort);

    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            if (req.method === 'GET' && req.url === '/v1/models') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ object: 'list', data: [] }));
                return;
            }

            if (req.method === 'POST' && req.url === '/v1/chat/completions') {
                try {
                    const bodyStr = await readRequestBody(req);
                    const body = JSON.parse(bodyStr) as ChatCompletionRequest;
                    const accessToken = await getAccessToken();
                    await handleChatCompletion(body, accessToken, res);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: { message, type: 'server_error', code: 'internal_error' },
                    }));
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
    for (const [key, active] of activeBridges) {
        clearInterval(active.heartbeatTimer);
        try { active.h2Stream.close(); } catch {}
        try { active.h2Client.close(); } catch {}
        activeBridges.delete(key);
    }
}

// --- Helpers ---

function readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

/** Connect protocol frame: [1-byte flags][4-byte BE length][payload] */
function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
    const frame = Buffer.alloc(5 + data.length);
    frame[0] = flags;
    frame.writeUInt32BE(data.length, 1);
    frame.set(data, 5);
    return frame;
}

// --- HTTP/2 Stream ---

function createH2Stream(accessToken: string): {
    client: http2.ClientHttp2Session;
    stream: http2.ClientHttp2Stream;
} {
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

// --- Chat Completion Handler ---

async function handleChatCompletion(
    body: ChatCompletionRequest,
    accessToken: string,
    res: http.ServerResponse,
): Promise<void> {
    const { systemPrompt, userText, turns, toolResults } = parseMessages(body.messages);
    const modelId = body.model;
    const tools = body.tools ?? [];

    if (!userText && toolResults.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: { message: 'No user message found', type: 'invalid_request_error' },
        }));
        return;
    }

    const bridgeKey = deriveBridgeKey(modelId, body.messages);
    const activeBridge = activeBridges.get(bridgeKey);

    if (activeBridge && toolResults.length > 0) {
        activeBridges.delete(bridgeKey);
        handleToolResultResume(activeBridge, toolResults, modelId, tools, accessToken, bridgeKey, res);
        return;
    }

    // Clean up stale bridge
    if (activeBridge) {
        clearInterval(activeBridge.heartbeatTimer);
        try { activeBridge.h2Stream.close(); } catch {}
        try { activeBridge.h2Client.close(); } catch {}
        activeBridges.delete(bridgeKey);
    }

    const mcpTools = buildMcpToolDefinitions(tools);
    const payload = buildCursorRequest(modelId, systemPrompt, userText, turns);
    payload.mcpTools = mcpTools;

    if (body.stream === false) {
        await handleNonStreamingResponse(payload, accessToken, modelId, res);
    } else {
        handleStreamingResponse(payload, accessToken, modelId, bridgeKey, res);
    }
}

// --- Message Parsing ---

function parseMessages(messages: OpenAIMessage[]): ParsedMessages {
    let systemPrompt = 'You are a helpful assistant.';
    const pairs: Array<{ userText: string; assistantText: string }> = [];
    const toolResults: ToolResultInfo[] = [];

    const systemParts = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content ?? '');
    if (systemParts.length > 0) {
        systemPrompt = systemParts.join('\n');
    }

    const nonSystem = messages.filter((m) => m.role !== 'system');
    let pendingUser = '';

    for (const msg of nonSystem) {
        if (msg.role === 'tool') {
            toolResults.push({
                toolCallId: msg.tool_call_id ?? '',
                content: msg.content ?? '',
            });
        } else if (msg.role === 'user') {
            if (pendingUser) {
                pairs.push({ userText: pendingUser, assistantText: '' });
            }
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

// --- MCP Tool Definitions ---

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

// --- gRPC Request Building ---

function buildCursorRequest(
    modelId: string,
    systemPrompt: string,
    userText: string,
    turns: Array<{ userText: string; assistantText: string }>,
): CursorRequestPayload {
    const blobStore = new Map<string, Uint8Array>();

    const turnBytes: Uint8Array[] = [];
    for (const turn of turns) {
        const userMsg = create(UserMessageSchema, {
            text: turn.userText,
            messageId: crypto.randomUUID(),
        });
        const userMsgBytes = toBinary(UserMessageSchema, userMsg);

        const stepBytes: Uint8Array[] = [];
        if (turn.assistantText) {
            const step = create(ConversationStepSchema, {
                message: {
                    case: 'assistantMessage',
                    value: create(AssistantMessageSchema, { text: turn.assistantText }),
                },
            });
            stepBytes.push(toBinary(ConversationStepSchema, step));
        }

        const agentTurn = create(AgentConversationTurnStructureSchema, {
            userMessage: userMsgBytes,
            steps: stepBytes,
        });
        const turnStructure = create(ConversationTurnStructureSchema, {
            turn: { case: 'agentConversationTurn', value: agentTurn },
        });
        turnBytes.push(toBinary(ConversationTurnStructureSchema, turnStructure));
    }

    // System prompt -> blob store
    const systemJson = JSON.stringify({ role: 'system', content: systemPrompt });
    const systemBytes = new TextEncoder().encode(systemJson);
    const systemBlobId = new Uint8Array(
        createHash('sha256').update(systemBytes).digest(),
    );
    blobStore.set(Buffer.from(systemBlobId).toString('hex'), systemBytes);

    const conversationState = create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [systemBlobId],
        turns: turnBytes,
        todos: [],
        pendingToolCalls: [],
        previousWorkspaceUris: [],
        fileStates: {},
        fileStatesV2: {},
        summaryArchives: [],
        turnTimings: [],
        subagentStates: {},
        selfSummaryCount: 0,
        readPaths: [],
    });

    const userMessage = create(UserMessageSchema, {
        text: userText,
        messageId: crypto.randomUUID(),
    });
    const action = create(ConversationActionSchema, {
        action: {
            case: 'userMessageAction',
            value: create(UserMessageActionSchema, { userMessage }),
        },
    });

    const modelDetails = create(ModelDetailsSchema, {
        modelId,
        displayModelId: modelId,
        displayName: modelId,
    });

    const runRequest = create(AgentRunRequestSchema, {
        conversationState,
        action,
        modelDetails,
        conversationId: crypto.randomUUID(),
    });

    const clientMessage = create(AgentClientMessageSchema, {
        message: { case: 'runRequest', value: runRequest },
    });

    return {
        requestBytes: toBinary(AgentClientMessageSchema, clientMessage),
        blobStore,
        mcpTools: [],
    };
}

// --- Connect Protocol Helpers ---

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
        message: {
            case: 'clientHeartbeat',
            value: create(ClientHeartbeatSchema, {}),
        },
    });
    return frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeat));
}

// --- Server Message Processing ---

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
        handleInteractionUpdate(msg.message.value, onText);
    } else if (msgCase === 'kvServerMessage') {
        handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
    } else if (msgCase === 'execServerMessage') {
        handleExecMessage(msg.message.value as ExecServerMessage, mcpTools, sendFrame, onMcpExec);
    }
}

function handleInteractionUpdate(
    update: any,
    onText: (text: string, isThinking?: boolean) => void,
): void {
    const updateCase = update.message?.case;

    if (updateCase === 'textDelta') {
        const delta = update.message.value.text || '';
        if (delta) onText(delta, false);
    } else if (updateCase === 'thinkingDelta') {
        const delta = update.message.value.text || '';
        if (delta) onText(delta, true);
    }
}

function handleKvMessage(
    kvMsg: KvServerMessage,
    blobStore: Map<string, Uint8Array>,
    sendFrame: (data: Buffer) => void,
): void {
    const kvCase = kvMsg.message.case;

    if (kvCase === 'getBlobArgs') {
        const blobId = kvMsg.message.value.blobId;
        const blobIdKey = Buffer.from(blobId).toString('hex');
        const blobData = blobStore.get(blobIdKey);

        const response = create(KvClientMessageSchema, {
            id: kvMsg.id,
            message: {
                case: 'getBlobResult',
                value: create(GetBlobResultSchema, blobData ? { blobData } : {}),
            },
        });

        const clientMsg = create(AgentClientMessageSchema, {
            message: { case: 'kvClientMessage', value: response },
        });
        sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
    } else if (kvCase === 'setBlobArgs') {
        const { blobId, blobData } = kvMsg.message.value;
        blobStore.set(Buffer.from(blobId).toString('hex'), blobData);

        const response = create(KvClientMessageSchema, {
            id: kvMsg.id,
            message: {
                case: 'setBlobResult',
                value: create(SetBlobResultSchema, {}),
            },
        });

        const clientMsg = create(AgentClientMessageSchema, {
            message: { case: 'kvClientMessage', value: response },
        });
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

    if (execCase === 'requestContextArgs') {
        const requestContext = create(RequestContextSchema, {
            rules: [],
            repositoryInfo: [],
            tools: mcpTools,
            gitRepos: [],
            projectLayouts: [],
            mcpInstructions: [],
            fileContents: {},
            customSubagents: [],
        });
        const result = create(RequestContextResultSchema, {
            result: {
                case: 'success',
                value: create(RequestContextSuccessSchema, { requestContext }),
            },
        });
        sendExecResult(execMsg, 'requestContextResult', result, sendFrame);
        return;
    }

    if (execCase === 'mcpArgs') {
        const mcpArgs = execMsg.message.value;
        const decoded = decodeMcpArgsMap(mcpArgs.args ?? {});
        onMcpExec({
            execId: execMsg.execId,
            execMsgId: execMsg.id,
            toolCallId: mcpArgs.toolCallId || crypto.randomUUID(),
            toolName: mcpArgs.toolName || mcpArgs.name,
            decodedArgs: JSON.stringify(decoded),
        });
        return;
    }

    // --- Reject native Cursor tools ---
    const REJECT_REASON = 'Tool not available in this environment. Use the MCP tools provided instead.';

    if (execCase === 'readArgs') {
        const args = execMsg.message.value;
        const result = create(ReadResultSchema, {
            result: { case: 'rejected', value: create(ReadRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
        });
        sendExecResult(execMsg, 'readResult', result, sendFrame);
        return;
    }
    if (execCase === 'lsArgs') {
        const args = execMsg.message.value;
        const result = create(LsResultSchema, {
            result: { case: 'rejected', value: create(LsRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
        });
        sendExecResult(execMsg, 'lsResult', result, sendFrame);
        return;
    }
    if (execCase === 'grepArgs') {
        const result = create(GrepResultSchema, {
            result: { case: 'error', value: create(GrepErrorSchema, { error: REJECT_REASON }) },
        });
        sendExecResult(execMsg, 'grepResult', result, sendFrame);
        return;
    }
    if (execCase === 'writeArgs') {
        const args = execMsg.message.value;
        const result = create(WriteResultSchema, {
            result: { case: 'rejected', value: create(WriteRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
        });
        sendExecResult(execMsg, 'writeResult', result, sendFrame);
        return;
    }
    if (execCase === 'deleteArgs') {
        const args = execMsg.message.value;
        const result = create(DeleteResultSchema, {
            result: { case: 'rejected', value: create(DeleteRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
        });
        sendExecResult(execMsg, 'deleteResult', result, sendFrame);
        return;
    }
    if (execCase === 'shellArgs' || execCase === 'shellStreamArgs') {
        const args = execMsg.message.value;
        const result = create(ShellResultSchema, {
            result: {
                case: 'rejected',
                value: create(ShellRejectedSchema, {
                    command: args.command ?? '',
                    workingDirectory: args.workingDirectory ?? '',
                    reason: REJECT_REASON,
                    isReadonly: false,
                }),
            },
        });
        sendExecResult(execMsg, 'shellResult', result, sendFrame);
        return;
    }
    if (execCase === 'backgroundShellSpawnArgs') {
        const args = execMsg.message.value;
        const result = create(BackgroundShellSpawnResultSchema, {
            result: {
                case: 'rejected',
                value: create(ShellRejectedSchema, {
                    command: args.command ?? '',
                    workingDirectory: args.workingDirectory ?? '',
                    reason: REJECT_REASON,
                    isReadonly: false,
                }),
            },
        });
        sendExecResult(execMsg, 'backgroundShellSpawnResult', result, sendFrame);
        return;
    }
    if (execCase === 'writeShellStdinArgs') {
        const result = create(WriteShellStdinResultSchema, {
            result: { case: 'error', value: create(WriteShellStdinErrorSchema, { error: REJECT_REASON }) },
        });
        sendExecResult(execMsg, 'writeShellStdinResult', result, sendFrame);
        return;
    }
    if (execCase === 'fetchArgs') {
        const args = execMsg.message.value;
        const result = create(FetchResultSchema, {
            result: { case: 'error', value: create(FetchErrorSchema, { url: args.url ?? '', error: REJECT_REASON }) },
        });
        sendExecResult(execMsg, 'fetchResult', result, sendFrame);
        return;
    }
    if (execCase === 'diagnosticsArgs') {
        const result = create(DiagnosticsResultSchema, {});
        sendExecResult(execMsg, 'diagnosticsResult', result, sendFrame);
        return;
    }

    // MCP resource/screen/computer exec types
    const miscCaseMap: Record<string, string> = {
        listMcpResourcesExecArgs: 'listMcpResourcesExecResult',
        readMcpResourceExecArgs: 'readMcpResourceExecResult',
        recordScreenArgs: 'recordScreenResult',
        computerUseArgs: 'computerUseResult',
    };
    const resultCase = miscCaseMap[execCase as string];
    if (resultCase) {
        sendExecResult(execMsg, resultCase, create(McpResultSchema, {}), sendFrame);
        return;
    }
}

function sendExecResult(
    execMsg: ExecServerMessage,
    messageCase: string,
    value: unknown,
    sendFrame: (data: Buffer) => void,
): void {
    const execClientMessage = create(ExecClientMessageSchema, {
        id: execMsg.id,
        execId: execMsg.execId,
        message: { case: messageCase as any, value: value as any },
    });
    const clientMessage = create(AgentClientMessageSchema, {
        message: { case: 'execClientMessage', value: execClientMessage },
    });
    sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
}

// --- Bridge Key ---

function deriveBridgeKey(modelId: string, messages: OpenAIMessage[]): string {
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
    return createHash('sha256')
        .update(`${modelId}:${firstUser.slice(0, 200)}`)
        .digest('hex')
        .slice(0, 16);
}

// --- Streaming Handler ---

function handleStreamingResponse(
    payload: CursorRequestPayload,
    accessToken: string,
    modelId: string,
    bridgeKey: string,
    res: http.ServerResponse,
): void {
    const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 28)}`;
    const created = Math.floor(Date.now() / 1000);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    let closed = false;
    const sendSSE = (data: object) => {
        if (closed) return;
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const sendDone = () => {
        if (closed) return;
        res.write('data: [DONE]\n\n');
    };
    const closeResponse = () => {
        if (closed) return;
        closed = true;
        res.end();
    };

    const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

    const state: StreamState = {
        thinkingActive: false,
        toolCallIndex: 0,
        pendingExecs: [],
    };

    let mcpExecReceived = false;
    const { client: h2Client, stream: h2Stream } = createH2Stream(accessToken);

    // Send initial request
    h2Stream.write(frameConnectMessage(payload.requestBytes));

    const heartbeatTimer = setInterval(() => {
        if (!h2Stream.closed && !h2Stream.destroyed) {
            h2Stream.write(makeHeartbeatBytes());
        }
    }, 5_000);

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
                if (endError) {
                    sendSSE(makeChunk({ content: `\n[Error: ${endError.message}]` }));
                }
                continue;
            }

            try {
                const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
                processServerMessage(
                    serverMessage,
                    payload.blobStore,
                    payload.mcpTools,
                    (data) => {
                        if (!h2Stream.closed && !h2Stream.destroyed) {
                            h2Stream.write(data);
                        }
                    },
                    state,
                    (text, isThinking) => {
                        if (isThinking) {
                            if (!state.thinkingActive) {
                                state.thinkingActive = true;
                                sendSSE(makeChunk({ role: 'assistant', content: '<think>' }));
                            }
                            sendSSE(makeChunk({ content: text }));
                        } else {
                            if (state.thinkingActive) {
                                state.thinkingActive = false;
                                sendSSE(makeChunk({ content: '</think>' }));
                            }
                            sendSSE(makeChunk({ content: text }));
                        }
                    },
                    (exec) => {
                        state.pendingExecs.push(exec);
                        mcpExecReceived = true;

                        if (state.thinkingActive) {
                            sendSSE(makeChunk({ content: '</think>' }));
                            state.thinkingActive = false;
                        }

                        const toolCallIndex = state.toolCallIndex++;
                        sendSSE(makeChunk({
                            tool_calls: [{
                                index: toolCallIndex,
                                id: exec.toolCallId,
                                type: 'function',
                                function: {
                                    name: exec.toolName,
                                    arguments: exec.decodedArgs,
                                },
                            }],
                        }));

                        // Keep bridge alive for tool result continuation
                        activeBridges.set(bridgeKey, {
                            h2Client,
                            h2Stream,
                            heartbeatTimer,
                            blobStore: payload.blobStore,
                            mcpTools: payload.mcpTools,
                            pendingExecs: state.pendingExecs,
                        });

                        sendSSE(makeChunk({}, 'tool_calls'));
                        sendDone();
                        closeResponse();
                    },
                );
            } catch {
                // Skip unparseable messages
            }
        }
    };

    h2Stream.on('data', processChunk);

    h2Stream.on('end', () => {
        clearInterval(heartbeatTimer);
        h2Client.close();
        if (!mcpExecReceived) {
            if (state.thinkingActive) {
                sendSSE(makeChunk({ content: '</think>' }));
            }
            sendSSE(makeChunk({}, 'stop'));
            sendDone();
            closeResponse();
        }
    });

    h2Stream.on('error', () => {
        clearInterval(heartbeatTimer);
        try { h2Client.close(); } catch {}
        if (!mcpExecReceived) {
            sendSSE(makeChunk({ content: '\n[Error: Connection lost]' }));
            sendSSE(makeChunk({}, 'stop'));
            sendDone();
            closeResponse();
        }
    });
}

// --- Tool Result Resume ---

function handleToolResultResume(
    active: ActiveBridge,
    toolResults: ToolResultInfo[],
    modelId: string,
    tools: OpenAIToolDef[],
    accessToken: string,
    bridgeKey: string,
    res: http.ServerResponse,
): void {
    const { h2Client, h2Stream, heartbeatTimer, blobStore, mcpTools, pendingExecs } = active;

    // Send mcpResult for each pending exec
    for (const exec of pendingExecs) {
        const result = toolResults.find((r) => r.toolCallId === exec.toolCallId);
        const mcpResult = result
            ? create(McpResultSchema, {
                result: {
                    case: 'success',
                    value: create(McpSuccessSchema, {
                        content: [
                            create(McpToolResultContentItemSchema, {
                                content: {
                                    case: 'text',
                                    value: create(McpTextContentSchema, { text: result.content }),
                                },
                            }),
                        ],
                        isError: false,
                    }),
                },
            })
            : create(McpResultSchema, {
                result: {
                    case: 'error',
                    value: create(McpErrorSchema, { error: 'Tool result not provided' }),
                },
            });

        const execClientMessage = create(ExecClientMessageSchema, {
            id: exec.execMsgId,
            execId: exec.execId,
            message: { case: 'mcpResult' as any, value: mcpResult as any },
        });

        const clientMessage = create(AgentClientMessageSchema, {
            message: { case: 'execClientMessage', value: execClientMessage },
        });

        if (!h2Stream.closed && !h2Stream.destroyed) {
            h2Stream.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
        }
    }

    // Stream continuation response
    const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 28)}`;
    const created = Math.floor(Date.now() / 1000);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    let closed = false;
    const sendSSE = (data: object) => {
        if (closed) return;
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const sendDone = () => {
        if (closed) return;
        res.write('data: [DONE]\n\n');
    };
    const closeResponse = () => {
        if (closed) return;
        closed = true;
        res.end();
    };

    const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

    const state: StreamState = {
        thinkingActive: false,
        toolCallIndex: 0,
        pendingExecs: [],
    };

    let mcpExecReceived = false;
    let pendingBuffer = Buffer.alloc(0);

    // Remove old listeners and attach new ones
    h2Stream.removeAllListeners('data');
    h2Stream.removeAllListeners('end');
    h2Stream.removeAllListeners('error');

    h2Stream.on('data', (incoming: Buffer) => {
        pendingBuffer = Buffer.concat([pendingBuffer, incoming]);

        while (pendingBuffer.length >= 5) {
            const flags = pendingBuffer[0]!;
            const msgLen = pendingBuffer.readUInt32BE(1);
            if (pendingBuffer.length < 5 + msgLen) break;

            const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
            pendingBuffer = pendingBuffer.subarray(5 + msgLen);

            if (flags & CONNECT_END_STREAM_FLAG) {
                const endError = parseConnectEndStream(messageBytes);
                if (endError) {
                    sendSSE(makeChunk({ content: `\n[Error: ${endError.message}]` }));
                }
                continue;
            }

            try {
                const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
                processServerMessage(
                    serverMessage,
                    blobStore,
                    mcpTools,
                    (data) => {
                        if (!h2Stream.closed && !h2Stream.destroyed) {
                            h2Stream.write(data);
                        }
                    },
                    state,
                    (text, isThinking) => {
                        if (isThinking) {
                            if (!state.thinkingActive) {
                                state.thinkingActive = true;
                                sendSSE(makeChunk({ role: 'assistant', content: '<think>' }));
                            }
                            sendSSE(makeChunk({ content: text }));
                        } else {
                            if (state.thinkingActive) {
                                state.thinkingActive = false;
                                sendSSE(makeChunk({ content: '</think>' }));
                            }
                            sendSSE(makeChunk({ content: text }));
                        }
                    },
                    (exec) => {
                        state.pendingExecs.push(exec);
                        mcpExecReceived = true;

                        if (state.thinkingActive) {
                            sendSSE(makeChunk({ content: '</think>' }));
                            state.thinkingActive = false;
                        }

                        const toolCallIndex = state.toolCallIndex++;
                        sendSSE(makeChunk({
                            tool_calls: [{
                                index: toolCallIndex,
                                id: exec.toolCallId,
                                type: 'function',
                                function: {
                                    name: exec.toolName,
                                    arguments: exec.decodedArgs,
                                },
                            }],
                        }));

                        activeBridges.set(bridgeKey, {
                            h2Client,
                            h2Stream,
                            heartbeatTimer,
                            blobStore,
                            mcpTools,
                            pendingExecs: state.pendingExecs,
                        });

                        sendSSE(makeChunk({}, 'tool_calls'));
                        sendDone();
                        closeResponse();
                    },
                );
            } catch {
                // Skip
            }
        }
    });

    h2Stream.on('end', () => {
        clearInterval(heartbeatTimer);
        h2Client.close();
        if (!mcpExecReceived) {
            if (state.thinkingActive) {
                sendSSE(makeChunk({ content: '</think>' }));
            }
            sendSSE(makeChunk({}, 'stop'));
            sendDone();
            closeResponse();
        }
    });

    h2Stream.on('error', () => {
        clearInterval(heartbeatTimer);
        try { h2Client.close(); } catch {}
        if (!mcpExecReceived) {
            sendSSE(makeChunk({ content: '\n[Error: Connection lost]' }));
            sendSSE(makeChunk({}, 'stop'));
            sendDone();
            closeResponse();
        }
    });
}

// --- Non-Streaming Handler ---

async function handleNonStreamingResponse(
    payload: CursorRequestPayload,
    accessToken: string,
    modelId: string,
    res: http.ServerResponse,
): Promise<void> {
    const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 28)}`;
    const created = Math.floor(Date.now() / 1000);

    const fullText = await collectFullResponse(payload, accessToken);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        id: completionId,
        object: 'chat.completion',
        created,
        model: modelId,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: fullText },
            finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }));
}

function collectFullResponse(
    payload: CursorRequestPayload,
    accessToken: string,
): Promise<string> {
    return new Promise((resolve) => {
        let fullText = '';

        const { client: h2Client, stream: h2Stream } = createH2Stream(accessToken);
        h2Stream.write(frameConnectMessage(payload.requestBytes));

        const heartbeatTimer = setInterval(() => {
            if (!h2Stream.closed && !h2Stream.destroyed) {
                h2Stream.write(makeHeartbeatBytes());
            }
        }, 5_000);

        let pendingBuffer = Buffer.alloc(0);
        const state: StreamState = {
            thinkingActive: false,
            toolCallIndex: 0,
            pendingExecs: [],
        };

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
                    const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
                    processServerMessage(
                        serverMessage,
                        payload.blobStore,
                        payload.mcpTools,
                        (data) => {
                            if (!h2Stream.closed && !h2Stream.destroyed) {
                                h2Stream.write(data);
                            }
                        },
                        state,
                        (text) => { fullText += text; },
                        () => {},
                    );
                } catch {
                    // Skip
                }
            }
        });

        h2Stream.on('end', () => {
            clearInterval(heartbeatTimer);
            h2Client.close();
            resolve(fullText);
        });

        h2Stream.on('error', () => {
            clearInterval(heartbeatTimer);
            try { h2Client.close(); } catch {}
            resolve(fullText);
        });
    });
}
