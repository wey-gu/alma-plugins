/**
 * Cursor Auth Plugin for Alma
 *
 * Enables using Cursor subscription models (Claude, GPT, Gemini, etc.)
 * inside Alma via OAuth authentication. This plugin registers a custom
 * provider that handles authentication and API calls to the Cursor backend.
 *
 * IMPORTANT: This follows the same pattern as openai-codex-auth:
 * - Plugin returns { apiKey, baseURL, fetch } configuration
 * - Custom fetch wrapper handles gRPC translation, OAuth headers, etc.
 * - AI SDK handles all request/response logic using the provided config
 *
 * DISCLAIMER: This plugin is for personal development use only with your
 * own Cursor subscription. Not for commercial resale or multi-user services.
 */

import type { PluginContext, PluginActivation } from 'alma-plugin-api';
import { TokenStore } from './lib/token-store';
import { generateCursorAuthParams, pollCursorAuth, getTokenExpiry } from './lib/auth';
import { getCursorModels, getFallbackModels } from './lib/models';
import { createCursorFetch, disposeAllSessions } from './lib/cursor-fetch';

// ============================================================================
// Constants
// ============================================================================

const CURSOR_BASE_URL = 'https://api2.cursor.sh';
const DUMMY_API_KEY = 'cursor-oauth';

// ============================================================================
// Plugin Activation
// ============================================================================

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, storage, providers, commands, ui } = context;

    logger.info('Cursor Auth plugin activating...');

    // Initialize token store
    const tokenStore = new TokenStore(storage.secrets, logger);
    await tokenStore.initialize();

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

                // Start OAuth flow — Cursor uses poll-based auth (no callback redirect)
                // Open browser and poll for login completion
                logger.info('Starting Cursor OAuth flow...');
                openBrowser(loginUrl);

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
            disposeAllSessions();
            ui.showNotification('Logged out from Cursor', { type: 'info' });
            logger.info('Cursor logout successful');
        },

        async getModels() {
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
         * Returns SDK configuration for AI SDK's createOpenAI().
         * This follows the openai-codex-auth pattern:
         * - apiKey: Dummy key (actual auth via OAuth)
         * - baseURL: Cursor API URL (custom fetch intercepts and translates)
         * - fetch: Custom fetch that handles gRPC translation
         */
        async getSDKConfig() {
            return {
                apiKey: DUMMY_API_KEY,
                baseURL: CURSOR_BASE_URL,
                fetch: createCursorFetch(
                    () => tokenStore.getValidAccessToken(),
                    logger,
                ),
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
        disposeAllSessions();
        ui.showNotification('Logged out from Cursor', { type: 'info' });
    });

    const statusCommand = commands.register('status', async () => {
        const isAuth = tokenStore.hasValidToken();
        if (isAuth) {
            ui.showNotification('Connected to Cursor', { type: 'success' });
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
            disposeAllSessions();
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
 * Open a URL in the default browser.
 */
function openBrowser(url: string): void {
    const { exec } = require('node:child_process');
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open'
        : platform === 'win32' ? 'start'
        : 'xdg-open';
    exec(`${cmd} "${url}"`);
}
