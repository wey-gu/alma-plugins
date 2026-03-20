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
    content: string | null;
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

export interface ParsedMessages {
    systemPrompt: string;
    userText: string;
    turns: Array<{ userText: string; assistantText: string }>;
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
