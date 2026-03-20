/**
 * Cursor Auth Plugin for Alma
 *
 * Enables using Cursor subscription models (Claude, GPT, Gemini, etc.)
 * inside Alma via:
 * 1. Browser-based OAuth login to Cursor
 * 2. Dynamic model discovery from Cursor's gRPC API
 * 3. Local proxy translating OpenAI format -> Cursor gRPC protocol
 *
 * DISCLAIMER: This plugin is for personal development use only with your
 * own Cursor subscription. Not for commercial resale or multi-user services.
 */

import type { PluginContext, PluginActivation } from 'alma-plugin-api';
import { exec } from 'node:child_process';
import { TokenStore } from './lib/token-store';
import { generateCursorAuthParams, pollCursorAuth, getTokenExpiry } from './lib/auth';
import { getCursorModels, getFallbackModels } from './lib/models';
import { startProxy, stopProxy } from './lib/proxy';

// ============================================================================
// Plugin Activation
// ============================================================================

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, storage, providers, commands, ui } = context;

    logger.info('Cursor Auth plugin activating...');

    // Initialize token store
    const tokenStore = new TokenStore(storage.secrets, logger);
    await tokenStore.initialize();

    // Proxy port (set when proxy starts)
    let currentProxyPort: number | undefined;

    // =========================================================================
    // Proxy Management
    // =========================================================================

    const ensureProxy = async (): Promise<number> => {
        if (currentProxyPort) return currentProxyPort;

        currentProxyPort = await startProxy(async () => {
            return tokenStore.getValidAccessToken();
        });

        logger.info(`Cursor proxy started on port ${currentProxyPort}`);
        return currentProxyPort;
    };

    // =========================================================================
    // Register Provider
    // =========================================================================

    const providerDisposable = providers.register({
        id: 'cursor',
        name: 'Cursor',
        description: 'Access Claude, GPT, Gemini and other models via your Cursor subscription',
        authType: 'oauth',

        async initialize() {
            logger.info('Cursor provider initialized');
        },

        async isAuthenticated() {
            return tokenStore.hasValidToken();
        },

        async authenticate() {
            try {
                const { verifier, uuid, loginUrl } = await generateCursorAuthParams();

                ui.showNotification('Opening browser for Cursor login...', { type: 'info' });

                // Open browser for login
                openBrowser(loginUrl);

                // Poll for auth completion
                ui.showNotification('Waiting for Cursor login to complete...', { type: 'info' });

                const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier);

                await tokenStore.saveTokens({
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    expires_at: getTokenExpiry(accessToken),
                });

                ui.showNotification('Successfully connected to Cursor!', { type: 'success' });
                logger.info('Cursor authentication successful');

                return { success: true };
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Authentication failed';
                logger.error('Cursor authentication error:', error);
                ui.showError(`Authentication failed: ${message}`);
                return { success: false, error: message };
            }
        },

        async logout() {
            await tokenStore.clearTokens();
            ui.showNotification('Logged out from Cursor', { type: 'info' });
            logger.info('Cursor logout successful');
        },

        async getModels() {
            // Return fallback models when not authenticated
            const tokens = tokenStore.getTokens();
            const models = tokens
                ? await getCursorModels(tokens.access_token).catch(() => getFallbackModels())
                : getFallbackModels();

            return models.map(model => ({
                id: model.id,
                name: model.name,
                description: `Cursor: ${model.name}${model.reasoning ? ' (reasoning)' : ''}`,
                contextWindow: model.contextWindow,
                maxOutputTokens: model.maxTokens,
                capabilities: {
                    streaming: true,
                    reasoning: model.reasoning,
                    functionCalling: true,
                },
            }));
        },

        async fetchModels() {
            logger.info('Fetching available models from Cursor API...');
            try {
                const accessToken = await tokenStore.getValidAccessToken();
                const models = await getCursorModels(accessToken);
                logger.info(`Fetched ${models.length} models from Cursor API`);

                return models.map(model => ({
                    id: model.id,
                    name: model.name,
                    description: `Cursor: ${model.name}${model.reasoning ? ' (reasoning)' : ''}`,
                    contextWindow: model.contextWindow,
                    maxOutputTokens: model.maxTokens,
                    capabilities: {
                        streaming: true,
                        reasoning: model.reasoning,
                        functionCalling: true,
                    },
                }));
            } catch (error) {
                logger.error('Error fetching models:', error);
                return this.getModels();
            }
        },

        /**
         * Returns SDK configuration for AI SDK.
         * Points to the local proxy which handles all Cursor protocol translation.
         */
        async getSDKConfig() {
            const port = await ensureProxy();

            return {
                apiKey: 'cursor-proxy',
                baseURL: `http://localhost:${port}/v1`,
                fetch: createProxyFetch(),
            };
        },
    } as any);

    // =========================================================================
    // Register Commands
    // =========================================================================

    const loginCommand = commands.register('login', async () => {
        ui.showNotification('Use the provider settings to connect to Cursor', { type: 'info' });
    });

    const logoutCommand = commands.register('logout', async () => {
        await tokenStore.clearTokens();
        ui.showNotification('Logged out from Cursor', { type: 'info' });
    });

    const statusCommand = commands.register('status', async () => {
        const isAuth = tokenStore.hasValidToken();
        if (isAuth) {
            ui.showNotification(
                `Connected to Cursor${currentProxyPort ? ` (proxy: ${currentProxyPort})` : ''}`,
                { type: 'success' },
            );
        } else {
            ui.showNotification('Not connected to Cursor', { type: 'warning' });
        }
    });

    logger.info('Cursor Auth plugin activated');

    // =========================================================================
    // Cleanup
    // =========================================================================

    return {
        dispose: () => {
            stopProxy();
            providerDisposable.dispose();
            loginCommand.dispose();
            logoutCommand.dispose();
            statusCommand.dispose();
            logger.info('Cursor Auth plugin deactivated');
        },
    };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a custom fetch that strips dummy auth headers.
 * The proxy handles authentication internally.
 */
function createProxyFetch(): typeof globalThis.fetch {
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

/**
 * Open a URL in the default browser.
 */
function openBrowser(url: string): void {
    const platform = process.platform;
    const cmd = platform === 'darwin'
        ? 'open'
        : platform === 'win32'
            ? 'start'
            : 'xdg-open';
    exec(`${cmd} "${url}"`);
}
