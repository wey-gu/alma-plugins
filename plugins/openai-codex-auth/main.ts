/**
 * OpenAI Codex Auth Plugin for Alma
 *
 * Enables using ChatGPT Plus/Pro subscription to access OpenAI Codex models
 * via OAuth authentication. This plugin registers a custom provider that
 * handles authentication and API calls to the ChatGPT Codex backend.
 *
 * IMPORTANT: This follows the same pattern as opencode-openai-codex-auth:
 * - Plugin returns { apiKey, baseURL, fetch } configuration
 * - Custom fetch wrapper handles OAuth headers, URL rewriting, etc.
 * - AI SDK handles all request/response logic using the provided config
 *
 * DISCLAIMER: This plugin is for personal development use only with your
 * own ChatGPT subscription. Not for commercial resale or multi-user services.
 */

import type { PluginContext, PluginActivation } from 'alma-plugin-api';
import { TokenStore } from './lib/token-store';
import { getAuthorizationUrl, exchangeCodeForTokens } from './lib/auth';
import { CODEX_MODELS, getBaseModelId, getReasoningEffort } from './lib/models';
import { getCodexInstructions } from './lib/codex-instructions';
import { addAlmaBridgeMessage } from './lib/alma-codex-bridge';

// ============================================================================
// Constants (matching opencode-openai-codex-auth)
// ============================================================================

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const DUMMY_API_KEY = 'chatgpt-oauth';

// OpenAI-specific headers (matching opencode)
const OPENAI_HEADERS = {
    BETA: 'OpenAI-Beta',
    ACCOUNT_ID: 'chatgpt-account-id',
    ORIGINATOR: 'originator',
    SESSION_ID: 'session_id',
    CONVERSATION_ID: 'conversation_id',
} as const;

// URL path segments
const URL_PATHS = {
    RESPONSES: '/responses',
    CODEX_RESPONSES: '/codex/responses',
} as const;

// HTTP status codes (matching opencode)
const HTTP_STATUS = {
    NOT_FOUND: 404,
    TOO_MANY_REQUESTS: 429,
} as const;

// ============================================================================
// Plugin Activation
// ============================================================================

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, storage, providers, commands, ui } = context;

    logger.info('OpenAI Codex Auth plugin activating...');

    // Initialize token store
    const tokenStore = new TokenStore(storage.secrets, logger);
    await tokenStore.initialize();

    // =========================================================================
    // Custom Fetch Wrapper (matching opencode-openai-codex-auth pattern)
    // =========================================================================

    /**
     * Convert SSE stream to JSON for non-streaming requests (generateText)
     * This matches the opencode-openai-codex-auth implementation
     */
    const convertSseToJson = async (response: Response, headers: Headers): Promise<Response> => {
        if (!response.body) {
            throw new Error('Response has no body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';

        // Consume the entire stream
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
        }

        // Parse SSE events to extract the final response
        const lines = fullText.split('\n');
        let finalResponse: unknown = null;

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                try {
                    const data = JSON.parse(line.substring(6));
                    if (data.type === 'response.done' || data.type === 'response.completed') {
                        finalResponse = data.response;
                        break;
                    }
                } catch {
                    // Skip malformed JSON
                }
            }
        }

        if (!finalResponse) {
            logger.error('Could not find final response in SSE stream');
            return new Response(fullText, {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        }

        // Return as plain JSON
        const jsonHeaders = new Headers(headers);
        jsonHeaders.set('content-type', 'application/json; charset=utf-8');

        return new Response(JSON.stringify(finalResponse), {
            status: response.status,
            statusText: response.statusText,
            headers: jsonHeaders,
        });
    };

    /**
     * Map 404 usage limit errors to 429 status (matching opencode)
     * This allows the caller to properly handle rate limiting
     */
    const mapUsageLimit404 = async (response: Response): Promise<Response | null> => {
        if (response.status !== HTTP_STATUS.NOT_FOUND) return null;

        const clone = response.clone();
        let text = '';
        try {
            text = await clone.text();
        } catch {
            text = '';
        }
        if (!text) return null;

        let code = '';
        try {
            const parsed = JSON.parse(text) as any;
            code = (parsed?.error?.code ?? parsed?.error?.type ?? '').toString();
        } catch {
            code = '';
        }

        const haystack = `${code} ${text}`.toLowerCase();
        if (!/usage_limit_reached|usage_not_included|rate_limit_exceeded|usage limit/i.test(haystack)) {
            return null;
        }

        // Return 429 instead of 404 for usage limit errors
        const headers = new Headers(response.headers);
        return new Response(response.body, {
            status: HTTP_STATUS.TOO_MANY_REQUESTS,
            statusText: 'Too Many Requests',
            headers,
        });
    };

    /**
     * Handle orphaned tool outputs by converting them to messages (matching opencode)
     * This prevents infinite loops when function_call was an item_reference that got filtered
     */
    const normalizeOrphanedToolOutputs = (input: any[]): any[] => {
        // Collect all call IDs by type (matching opencode's collectCallIds)
        const functionCallIds = new Set<string>();
        const localShellCallIds = new Set<string>();
        const customToolCallIds = new Set<string>();

        for (const item of input) {
            const callId = typeof item.call_id === 'string' ? item.call_id.trim() : null;
            if (!callId) continue;

            switch (item.type) {
                case 'function_call':
                    functionCallIds.add(callId);
                    break;
                case 'local_shell_call':
                    localShellCallIds.add(callId);
                    break;
                case 'custom_tool_call':
                    customToolCallIds.add(callId);
                    break;
            }
        }

        // Helper to convert orphaned output to message
        const convertToMessage = (item: any, callId: string | null) => {
            const toolName = item.name || 'tool';
            const labelCallId = callId || 'unknown';
            let text: string;
            try {
                text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
            } catch {
                text = String(item.output ?? '');
            }
            if (text.length > 16000) {
                text = text.slice(0, 16000) + '\n...[truncated]';
            }
            return {
                type: 'message',
                role: 'assistant',
                content: `[Previous ${toolName} result; call_id=${labelCallId}]: ${text}`,
            };
        };

        // Convert orphaned output items to messages
        return input.map((item) => {
            const callId = typeof item.call_id === 'string' ? item.call_id.trim() : null;

            if (item.type === 'function_call_output') {
                const hasMatch = callId && (functionCallIds.has(callId) || localShellCallIds.has(callId));
                if (!hasMatch) {
                    logger.debug(`[DEBUG] Converting orphaned function_call_output to message: call_id=${callId}`);
                    return convertToMessage(item, callId);
                }
            }

            if (item.type === 'custom_tool_call_output') {
                const hasMatch = callId && customToolCallIds.has(callId);
                if (!hasMatch) {
                    logger.debug(`[DEBUG] Converting orphaned custom_tool_call_output to message: call_id=${callId}`);
                    return convertToMessage(item, callId);
                }
            }

            if (item.type === 'local_shell_call_output') {
                const hasMatch = callId && localShellCallIds.has(callId);
                if (!hasMatch) {
                    logger.debug(`[DEBUG] Converting orphaned local_shell_call_output to message: call_id=${callId}`);
                    return convertToMessage(item, callId);
                }
            }

            return item;
        });
    };

    /**
     * Creates a custom fetch function that:
     * 1. Refreshes OAuth token if needed
     * 2. Rewrites URLs for Codex backend
     * 3. Transforms request body for Codex format
     * 4. Adds OAuth headers
     * 5. Handles response (SSE→JSON for non-streaming, passthrough for streaming)
     *
     * This matches the opencode-openai-codex-auth implementation exactly.
     */
    const createCodexFetch = (): typeof globalThis.fetch => {
        return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            // Step 1: Get fresh access token
            const accessToken = await tokenStore.getValidAccessToken();
            const accountId = tokenStore.getAccountId();

            if (!accountId) {
                throw new Error('Account ID not found. Please re-authenticate.');
            }

            // Step 2: Extract URL string
            let url: string;
            if (typeof input === 'string') {
                url = input;
            } else if (input instanceof URL) {
                url = input.toString();
            } else {
                url = input.url;
            }

            // Step 3: Rewrite URL for Codex backend: /responses -> /codex/responses
            const codexUrl = url.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES);
            logger.debug(`Rewriting URL: ${url} -> ${codexUrl}`);

            // Step 4: Transform request body (matching opencode-openai-codex-auth exactly)
            let body = init?.body;
            let isStreaming = true; // Default to streaming
            let promptCacheKey: string | undefined; // For prompt caching headers

            if (body && typeof body === 'string') {
                try {
                    const parsed = JSON.parse(body);

                    // Track if this is a streaming request (generateText sends no stream field)
                    // streamText sends stream=true
                    isStreaming = parsed.stream === true;

                    // Extract prompt_cache_key for caching headers (matching opencode)
                    promptCacheKey = parsed.prompt_cache_key;

                    // Normalize model name (e.g., gpt-5.2-codex-low -> gpt-5.2-codex)
                    const originalModel = parsed.model || '';
                    const normalizedModel = getBaseModelId(originalModel);
                    const reasoningEffort = getReasoningEffort(originalModel);

                    // Filter and transform input (matching opencode's filterInput function)
                    // This is CRITICAL for Codex API compatibility:
                    // 1. Remove item_reference types (AI SDK construct not supported by Codex)
                    // 2. Strip IDs from all items (required for stateless mode with store=false)
                    // 3. Normalize orphaned tool outputs to messages (prevent infinite loops)
                    // 4. Filter Alma system prompts (replaced by Codex instructions)
                    // 5. Add Alma-Codex bridge message when tools are present
                    let filteredInput = parsed.input || parsed.messages;
                    const hasTools = !!parsed.tools && parsed.tools.length > 0;

                    // DEBUG: Log the original input to understand what AI SDK sends
                    if (Array.isArray(filteredInput)) {
                        const typeCounts: Record<string, number> = {};
                        let itemRefCount = 0;
                        for (const item of filteredInput) {
                            const t = item.type || 'unknown';
                            typeCounts[t] = (typeCounts[t] || 0) + 1;
                            if (t === 'item_reference') {
                                itemRefCount++;
                                logger.warn(`[DEBUG] item_reference found: id=${item.id}, ref_id=${item.item_id || item.reference_id || 'N/A'}`);
                            }
                        }
                        logger.info(`[DEBUG] Original input: ${filteredInput.length} items, types: ${JSON.stringify(typeCounts)}`);
                        if (itemRefCount > 0) {
                            logger.warn(`[DEBUG] Found ${itemRefCount} item_reference entries that will be filtered out!`);
                        }
                    }

                    if (Array.isArray(filteredInput)) {
                        const beforeCount = filteredInput.length;
                        filteredInput = filteredInput
                            .filter((item: any) => {
                                // Remove AI SDK constructs not supported by Codex API
                                if (item.type === 'item_reference') {
                                    logger.warn(`[DEBUG] Filtering out item_reference: ${JSON.stringify(item).slice(0, 200)}`);
                                    return false;
                                }
                                return true;
                            })
                            .map((item: any) => {
                                // Strip IDs from all items (Codex API stateless mode)
                                if (item.id) {
                                    const { id, ...itemWithoutId } = item;
                                    return itemWithoutId;
                                }
                                return item;
                            });

                        const afterCount = filteredInput.length;
                        if (beforeCount !== afterCount) {
                            logger.warn(`[DEBUG] Filtered ${beforeCount - afterCount} items (from ${beforeCount} to ${afterCount})`);
                        }

                        // Handle orphaned tool outputs (matching opencode's normalizeOrphanedToolOutputs)
                        // This converts orphaned function_call_output items to messages to preserve context
                        filteredInput = normalizeOrphanedToolOutputs(filteredInput);

                        // Add Alma-Codex bridge message when tools are present
                        // This maps Codex tool names (apply_patch, update_plan) to Alma tool names (Edit, TodoWrite)
                        // Note: We don't filter Alma system prompts - they coexist with Codex instructions
                        // This preserves Alma's context (date, platform, memories) while adding Codex behavior
                        filteredInput = addAlmaBridgeMessage(filteredInput, hasTools);

                        // DEBUG: Log final input summary
                        const finalTypeCounts: Record<string, number> = {};
                        const roleCounts: Record<string, number> = {};
                        for (const item of filteredInput) {
                            const t = item.type || 'unknown';
                            finalTypeCounts[t] = (finalTypeCounts[t] || 0) + 1;
                            if (item.role) {
                                roleCounts[item.role] = (roleCounts[item.role] || 0) + 1;
                            }
                        }
                        logger.info(`[DEBUG] Final input: ${filteredInput.length} items, types: ${JSON.stringify(finalTypeCounts)}, roles: ${JSON.stringify(roleCounts)}`);
                    }

                    // Fetch Codex instructions from GitHub (matching opencode)
                    // These are cached with ETag for 15 minutes
                    const codexInstructions = await getCodexInstructions(normalizedModel);

                    // Transform to Codex format (matching opencode's transformRequestBody)
                    const transformedBody: Record<string, any> = {
                        model: normalizedModel,
                        store: false, // Required: stateless mode (ChatGPT backend REQUIRES this)
                        stream: true, // Always stream for Codex (we convert to JSON if needed)
                        input: filteredInput,
                        include: ['reasoning.encrypted_content'], // Required for stateless operation
                        text: {
                            verbosity: 'medium', // Matches Codex CLI default
                        },
                    };

                    // Set Codex instructions (matching opencode's body.instructions = codexInstructions)
                    if (codexInstructions) {
                        transformedBody.instructions = codexInstructions;
                    }

                    // Add reasoning config if not 'none'
                    if (reasoningEffort !== 'none') {
                        transformedBody.reasoning = {
                            effort: reasoningEffort,
                            summary: 'auto',
                        };
                    }

                    // Preserve tools if present
                    if (parsed.tools) {
                        transformedBody.tools = parsed.tools;
                    }

                    // Remove unsupported parameters (matching opencode)
                    // These are not supported by Codex API
                    delete transformedBody.max_output_tokens;
                    delete transformedBody.max_completion_tokens;

                    body = JSON.stringify(transformedBody);
                    logger.debug(`Transformed request: model=${originalModel}->${normalizedModel}, reasoning=${reasoningEffort}, streaming=${isStreaming}`);
                } catch (e) {
                    logger.error('Error transforming request body:', e);
                }
            }

            // Step 5: Create headers with OAuth credentials (matching opencode's createCodexHeaders)
            const headers = new Headers(init?.headers ?? {});
            headers.delete('x-api-key');
            headers.set('Authorization', `Bearer ${accessToken}`);
            headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
            headers.set(OPENAI_HEADERS.BETA, 'responses=experimental');
            headers.set(OPENAI_HEADERS.ORIGINATOR, 'codex_cli_rs');
            headers.set('accept', 'text/event-stream');

            // Set prompt cache headers if prompt_cache_key is present (matching opencode)
            if (promptCacheKey) {
                headers.set(OPENAI_HEADERS.CONVERSATION_ID, promptCacheKey);
                headers.set(OPENAI_HEADERS.SESSION_ID, promptCacheKey);
            } else {
                headers.delete(OPENAI_HEADERS.CONVERSATION_ID);
                headers.delete(OPENAI_HEADERS.SESSION_ID);
            }

            // Step 6: Make the request
            const response = await globalThis.fetch(codexUrl, {
                ...init,
                body,
                headers,
            });

            // Step 7: Handle error response (matching opencode's handleErrorResponse)
            if (!response.ok) {
                // Map 404 usage limit errors to 429 for proper rate limit handling
                const mappedResponse = await mapUsageLimit404(response);
                if (mappedResponse) {
                    logger.warn('Usage limit reached, returning 429 status');
                    return mappedResponse;
                }

                // For other errors, log and return the error response
                const errorText = await response.clone().text();
                logger.error(`Codex API error: ${response.status} ${response.statusText}`, errorText);

                // Return the error response instead of throwing
                // This allows the caller to handle errors properly
                return response;
            }

            // Step 8: Handle success response
            // For non-streaming requests (generateText), convert SSE to JSON
            // For streaming requests (streamText), return stream as-is
            const responseHeaders = new Headers(response.headers);
            if (!responseHeaders.has('content-type')) {
                responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
            }

            if (!isStreaming) {
                return await convertSseToJson(response, responseHeaders);
            }

            // Return streaming response as-is
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders,
            });
        };
    };

    // =========================================================================
    // Register Provider
    // =========================================================================

    const providerDisposable = providers.register({
        id: 'openai-codex',
        name: 'OpenAI Codex (ChatGPT)',
        description: 'Access GPT-5.3 Codex and other models via your ChatGPT subscription',
        authType: 'oauth',

        async initialize() {
            logger.info('Codex provider initialized');
        },

        async isAuthenticated() {
            return tokenStore.hasValidToken();
        },

        async authenticate() {
            try {
                // Generate authorization URL
                const { url, verifier } = await getAuthorizationUrl();

                // Store verifier for code exchange
                await tokenStore.storePendingVerifier(verifier);

                // Show notification
                ui.showNotification('Opening browser for ChatGPT login...', { type: 'info' });

                // Start OAuth flow with local callback server
                logger.info('Starting OAuth flow...');
                const result = await ui.startOAuthFlow({
                    authUrl: url,
                    callbackPort: 1455,
                    callbackPath: '/auth/callback',
                    timeout: 300000, // 5 minutes
                });

                if (!result || !result.code) {
                    await tokenStore.clearPendingState();
                    return { success: false, error: 'Authorization cancelled or timed out' };
                }

                // Exchange code for tokens
                const pendingVerifier = await tokenStore.getPendingVerifier();
                if (!pendingVerifier) {
                    return { success: false, error: 'No pending authorization. Please try again.' };
                }

                const tokens = await exchangeCodeForTokens(result.code, pendingVerifier);
                await tokenStore.saveTokens(tokens);
                await tokenStore.clearPendingState();

                ui.showNotification('Successfully connected to ChatGPT!', { type: 'success' });
                logger.info('Codex authentication successful');

                return { success: true };
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Authentication failed';
                logger.error('Codex authentication error:', error);
                ui.showError(`Authentication failed: ${message}`);
                return { success: false, error: message };
            }
        },

        async logout() {
            await tokenStore.clearTokens();
            ui.showNotification('Logged out from ChatGPT', { type: 'info' });
            logger.info('Codex logout successful');
        },

        async getModels() {
            // Return all supported models
            // All Codex models support function calling (tools)
            return CODEX_MODELS.map(model => ({
                id: model.id,
                name: model.name,
                description: model.description,
                contextWindow: model.contextWindow,
                maxOutputTokens: model.maxOutputTokens,
                capabilities: {
                    streaming: true,
                    reasoning: model.reasoning !== 'none',
                    functionCalling: true, // All Codex models support function calling
                },
                providerOptions: {
                    reasoning: model.reasoning,
                    baseModel: model.baseModel,
                },
            }));
        },

        /**
         * Returns SDK configuration for AI SDK's createOpenAI().
         * This follows the opencode-openai-codex-auth pattern:
         * - apiKey: Dummy key (actual auth via OAuth)
         * - baseURL: ChatGPT backend URL
         * - fetch: Custom fetch that handles OAuth headers, URL rewriting, etc.
         */
        async getSDKConfig() {
            return {
                apiKey: DUMMY_API_KEY,
                baseURL: CODEX_BASE_URL,
                fetch: createCodexFetch(),
                useResponsesAPI: true,
            };
        },
    });

    // =========================================================================
    // Register Commands
    // =========================================================================

    const loginCommand = commands.register('login', async () => {
        ui.showNotification('Use the provider settings to connect to ChatGPT', { type: 'info' });
    });

    const logoutCommand = commands.register('logout', async () => {
        await tokenStore.clearTokens();
        ui.showNotification('Logged out from ChatGPT', { type: 'info' });
    });

    const statusCommand = commands.register('status', async () => {
        const isAuth = tokenStore.hasValidToken();
        const accountId = tokenStore.getAccountId();

        if (isAuth) {
            ui.showNotification(`Connected to ChatGPT (Account: ${accountId?.slice(0, 8)}...)`, { type: 'success' });
        } else {
            ui.showNotification('Not connected to ChatGPT', { type: 'warning' });
        }
    });

    logger.info('OpenAI Codex Auth plugin activated');

    // =========================================================================
    // Cleanup
    // =========================================================================

    return {
        dispose: () => {
            providerDisposable.dispose();
            loginCommand.dispose();
            logoutCommand.dispose();
            statusCommand.dispose();
            logger.info('OpenAI Codex Auth plugin deactivated');
        },
    };
}
