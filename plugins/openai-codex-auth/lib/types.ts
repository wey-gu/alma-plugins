/**
 * Type definitions for OpenAI Codex Auth Plugin
 */

// ============================================================================
// OAuth Types
// ============================================================================

export interface CodexTokens {
    access_token: string;
    refresh_token: string;
    expires_at: number; // Unix timestamp in milliseconds
    account_id: string; // ChatGPT account ID extracted from JWT
}

export interface PKCEChallenge {
    verifier: string;
    challenge: string;
}

export interface OAuthConfig {
    clientId: string;
    authUrl: string;
    tokenUrl: string;
    redirectUri: string;
    scopes: string;
}

// ============================================================================
// Model Types
// ============================================================================

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CodexModelInfo {
    id: string;
    name: string;
    description?: string;
    baseModel: string; // The actual model ID sent to API
    reasoning: ReasoningEffort;
    contextWindow?: number;
    maxOutputTokens?: number;
}

// ============================================================================
// API Types
// ============================================================================

export interface CodexChatRequest {
    model: string;
    store: false; // Required: stateless mode
    stream: boolean;
    instructions?: string;
    input: CodexInputItem[];
    tools?: CodexTool[];
    reasoning?: {
        effort: ReasoningEffort;
        summary?: 'auto' | 'concise' | 'detailed';
    };
    text?: {
        verbosity?: 'low' | 'medium' | 'high';
    };
    include?: string[];
    prompt_cache_key?: string;
}

export type CodexInputItem =
    | { role: 'developer'; content: string }
    | { role: 'user'; content: string | CodexContentPart[] }
    | { role: 'assistant'; content: string }
    | { type: 'function_call'; call_id: string; name: string; arguments: string }
    | { type: 'function_call_output'; call_id: string; output: string };

export interface CodexContentPart {
    type: 'input_text' | 'input_image';
    text?: string;
    image_url?: string;
}

export interface CodexTool {
    type: 'function';
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}

// ============================================================================
// SSE Response Types
// ============================================================================

export interface CodexSSEEvent {
    type: 'response.start' | 'response.ongoing' | 'response.done' | 'error';
    response?: CodexResponse;
    error?: { message: string; code?: string };
}

export interface CodexResponse {
    id: string;
    output: CodexOutputItem[];
    usage?: {
        input_tokens: number;
        output_tokens: number;
        reasoning_tokens?: number;
    };
}

export interface CodexOutputItem {
    type: 'message' | 'function_call';
    content?: Array<{ type: 'output_text'; text: string }>;
    call_id?: string;
    name?: string;
    arguments?: string;
}
