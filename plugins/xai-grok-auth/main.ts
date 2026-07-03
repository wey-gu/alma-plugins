/**
 * xAI Grok Auth Plugin for Alma
 *
 * Enables using a SuperGrok subscription to access Grok models via OAuth,
 * mirroring OpenCode's built-in xai plugin: after login the standard xAI API
 * (https://api.x.ai/v1, OpenAI-compatible) is called with the subscription's
 * OAuth access token injected as the Bearer credential.
 *
 * DISCLAIMER: This plugin is for personal use with your own SuperGrok
 * subscription. Not for commercial resale or multi-user services.
 */

import type { PluginContext, PluginActivation } from 'alma-plugin-api';
import { TokenStore } from './lib/token-store';
import {
    getAuthorizationUrl,
    exchangeCodeForTokens,
    OAUTH_PORT,
    OAUTH_CALLBACK_PATH,
    CORS_ORIGINS,
} from './lib/auth';
import { getActiveModels, setCachedModels, buildModelsFromApiResponse, type XaiModel } from './lib/models';

const XAI_BASE_URL = 'https://api.x.ai/v1';
const DUMMY_API_KEY = 'xai-oauth';

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, storage, providers, commands, ui } = context;

    logger.info('xAI Grok Auth plugin activating...');

    const tokenStore = new TokenStore(storage.secrets, logger);
    await tokenStore.initialize();

    // =========================================================================
    // Custom Fetch Wrapper
    // =========================================================================

    /**
     * Injects the OAuth Bearer token into every request. No URL rewriting or
     * body transformation is needed — subscription tokens are accepted by the
     * standard OpenAI-compatible xAI API.
     */
    const createXaiFetch = (): typeof globalThis.fetch => {
        return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const accessToken = await tokenStore.getValidAccessToken();

            const headers = new Headers(init?.headers ?? {});
            headers.delete('x-api-key');
            headers.set('Authorization', `Bearer ${accessToken}`);

            let response = await globalThis.fetch(input, { ...init, headers });

            // The server can invalidate an access token before its local
            // expiry. On 401, force a refresh and retry the request once.
            if (response.status === 401) {
                const errText = await response
                    .clone()
                    .text()
                    .catch(() => '');
                logger.warn(`xAI API 401, forcing token refresh and retrying once: ${errText.slice(0, 200)}`);
                try {
                    const newToken = await tokenStore.forceRefreshAccessToken();
                    headers.set('Authorization', `Bearer ${newToken}`);
                    response = await globalThis.fetch(input, { ...init, headers });
                } catch (refreshErr) {
                    logger.error('Forced xAI token refresh failed:', refreshErr);
                }
            }

            return response;
        };
    };

    // =========================================================================
    // Model helpers
    // =========================================================================

    const toProviderModel = (model: XaiModel) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: {
            streaming: true,
            reasoning: model.reasoning,
            functionCalling: true,
            vision: model.vision,
        },
    });

    /** Fetch the live model catalog. Tries the metadata-rich endpoint first. */
    const fetchLiveModels = async (): Promise<XaiModel[]> => {
        const accessToken = await tokenStore.getValidAccessToken();
        const headers = { Authorization: `Bearer ${accessToken}` };

        for (const endpoint of ['/language-models', '/models']) {
            try {
                const response = await globalThis.fetch(`${XAI_BASE_URL}${endpoint}`, { headers });
                if (!response.ok) {
                    logger.warn(`xAI ${endpoint} returned ${response.status}`);
                    continue;
                }
                const models = buildModelsFromApiResponse(await response.json());
                if (models.length > 0) {
                    return models;
                }
            } catch (error) {
                logger.warn(`xAI ${endpoint} fetch failed:`, error);
            }
        }
        return [];
    };

    // =========================================================================
    // Register Provider
    // =========================================================================

    const providerDisposable = providers.register({
        id: 'xai-grok',
        name: 'xAI Grok (SuperGrok)',
        description: 'Access Grok models via your SuperGrok subscription',
        authType: 'oauth',
        sdkType: 'openai-compatible',

        async isAuthenticated() {
            return tokenStore.hasTokens();
        },

        async authenticate() {
            try {
                const { url, verifier, state } = await getAuthorizationUrl();
                await tokenStore.storePendingLogin(verifier, state);

                ui.showNotification('Opening browser for xAI login...', { type: 'info' });

                // The redirect_uri host:port is part of the Grok-CLI client
                // registration — the callback server must bind exactly 56121.
                const result = await ui.startOAuthFlow({
                    authUrl: url,
                    callbackPort: OAUTH_PORT,
                    callbackPath: OAUTH_CALLBACK_PATH,
                    timeout: 300000,
                    corsOrigins: CORS_ORIGINS,
                });

                if (!result || !result.code) {
                    await tokenStore.clearPendingState();
                    return { success: false, error: 'Authorization cancelled or timed out' };
                }

                const pending = await tokenStore.getPendingLogin();
                if (!pending) {
                    return { success: false, error: 'No pending authorization. Please try again.' };
                }
                if (result.state !== pending.state) {
                    await tokenStore.clearPendingState();
                    return { success: false, error: 'OAuth state mismatch - please try again' };
                }

                const tokens = await exchangeCodeForTokens(result.code, pending.verifier);
                await tokenStore.saveTokens(tokens);
                await tokenStore.clearPendingState();

                const claims = tokenStore.getAccountClaims();
                const label = claims?.email ? ` (${claims.email})` : '';
                ui.showNotification(`Successfully connected to xAI${label}!`, { type: 'success' });
                logger.info('xAI authentication successful');

                return { success: true };
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Authentication failed';
                logger.error('xAI authentication error:', error);
                ui.showError(`Authentication failed: ${message}`);
                return { success: false, error: message };
            }
        },

        async logout() {
            await tokenStore.clearTokens();
            ui.showNotification('Logged out from xAI', { type: 'info' });
            logger.info('xAI logout successful');
        },

        async getModels() {
            return getActiveModels().map(toProviderModel);
        },

        async fetchModels() {
            logger.info('Fetching available models from xAI API...');
            try {
                const models = await fetchLiveModels();
                if (models.length === 0) {
                    logger.warn('No chat models found in xAI API response, using fallback list');
                    return this.getModels();
                }
                setCachedModels(models);
                logger.info(`Fetched and cached ${models.length} models from xAI API`);
                return models.map(toProviderModel);
            } catch (error) {
                logger.error('Error fetching xAI models:', error);
                return this.getModels();
            }
        },

        async getSDKConfig() {
            return {
                apiKey: DUMMY_API_KEY,
                baseURL: XAI_BASE_URL,
                fetch: createXaiFetch(),
            };
        },
    });

    // =========================================================================
    // Register Commands
    // =========================================================================

    const loginCommand = commands.register('login', async () => {
        ui.showNotification('Use the provider settings to connect to xAI (SuperGrok)', { type: 'info' });
    });

    const logoutCommand = commands.register('logout', async () => {
        await tokenStore.clearTokens();
        ui.showNotification('Logged out from xAI', { type: 'info' });
    });

    const statusCommand = commands.register('status', async () => {
        if (tokenStore.hasTokens()) {
            const claims = tokenStore.getAccountClaims();
            ui.showNotification(`Connected to xAI${claims?.email ? ` (${claims.email})` : ''}`, { type: 'success' });
        } else {
            ui.showNotification('Not connected to xAI', { type: 'warning' });
        }
    });

    logger.info('xAI Grok Auth plugin activated');

    return {
        dispose: () => {
            providerDisposable.dispose();
            loginCommand.dispose();
            logoutCommand.dispose();
            statusCommand.dispose();
            logger.info('xAI Grok Auth plugin deactivated');
        },
    };
}
