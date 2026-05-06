/**
 * Type definitions for Cursor Auth Plugin
 */

// ============================================================================
// OAuth Types
// ============================================================================

export interface CursorTokens {
    access_token: string;
    refresh_token: string;
    expires_at: number; // Unix timestamp in milliseconds
}

export interface PKCEChallenge {
    verifier: string;
    challenge: string;
}

export interface CursorAuthParams {
    verifier: string;
    challenge: string;
    uuid: string;
    loginUrl: string;
}

// ============================================================================
// Model Types
// ============================================================================

export interface CursorModel {
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
}

// ============================================================================
// Proxy Types
// ============================================================================

export interface OpenAIToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** Content can be a string OR an array of content parts (e.g. [{type:"text", text:"..."}]) */
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }> | null;
    tool_call_id?: string;
    tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolDef {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}

export interface ChatCompletionRequest {
    model: string;
    messages: OpenAIMessage[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    tools?: OpenAIToolDef[];
    tool_choice?: unknown;
}

export interface ToolResultInfo {
    toolCallId: string;
    content: string;
}

export interface HistoryToolCall {
    toolCallId: string;
    toolName: string;
    /** Stringified JSON arguments. */
    argsJson: string;
    /** Tool result text, when known. Undefined => result was not paired in the prompt. */
    resultText?: string;
    isError?: boolean;
}

export interface HistoryTurn {
    userText: string;
    assistantText: string;
    toolCalls: HistoryToolCall[];
}

export interface ParsedMessages {
    systemPrompt: string;
    userText: string;
    turns: HistoryTurn[];
    toolResults: ToolResultInfo[];
}

export interface PendingExec {
    execId: string;
    execMsgId: number;
    toolCallId: string;
    toolName: string;
    decodedArgs: string;
}

export interface StreamState {
    thinkingActive: boolean;
    toolCallIndex: number;
    pendingExecs: PendingExec[];
}
