/**
 * Token Store for xAI Grok Auth — single account.
 *
 * Stores the OAuth token pair in the plugin's secret storage and refreshes
 * the access token proactively. Concurrent refreshes are collapsed onto one
 * HTTP call (single-flight) so a rotating refresh_token is never replayed.
 *
 * Storage layout:
 *   - `xai_tokens`       → JSON<XaiTokens>
 *   - `pending_verifier` → string (PKCE verifier, during login only)
 *   - `pending_state`    → string (OAuth state, during login only)
 */

import type { XaiTokens, XaiAccountClaims, SecretStorage, Logger } from './types';
import { refreshTokens, isTokenExpiring, extractAccountClaims } from './auth';

const STORAGE_KEY = 'xai_tokens';
const PENDING_VERIFIER_KEY = 'pending_verifier';
const PENDING_STATE_KEY = 'pending_state';

export class TokenStore {
    private secrets: SecretStorage;
    private logger: Logger;
    private tokens: XaiTokens | null = null;
    private refreshPromise: Promise<XaiTokens> | null = null;

    constructor(secrets: SecretStorage, logger: Logger) {
        this.secrets = secrets;
        this.logger = logger;
    }

    async initialize(): Promise<void> {
        try {
            const stored = await this.secrets.get(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored) as XaiTokens;
                if (parsed && parsed.access_token && parsed.refresh_token) {
                    this.tokens = parsed;
                    this.logger.info('Loaded cached xAI tokens');
                }
            }
        } catch (error) {
            this.logger.error('Failed to load cached xAI tokens:', error);
        }
    }

    hasTokens(): boolean {
        return this.tokens !== null;
    }

    getAccountClaims(): XaiAccountClaims | null {
        return this.tokens ? extractAccountClaims(this.tokens) : null;
    }

    async saveTokens(tokens: XaiTokens): Promise<void> {
        this.tokens = tokens;
        await this.secrets.set(STORAGE_KEY, JSON.stringify(tokens));
    }

    async clearTokens(): Promise<void> {
        this.tokens = null;
        this.refreshPromise = null;
        await this.secrets.delete(STORAGE_KEY);
        await this.clearPendingState();
    }

    // =========================================================================
    // Pending login state (PKCE verifier + OAuth state)
    // =========================================================================

    async storePendingLogin(verifier: string, state: string): Promise<void> {
        await this.secrets.set(PENDING_VERIFIER_KEY, verifier);
        await this.secrets.set(PENDING_STATE_KEY, state);
    }

    async getPendingLogin(): Promise<{ verifier: string; state: string } | null> {
        const verifier = await this.secrets.get(PENDING_VERIFIER_KEY);
        const state = await this.secrets.get(PENDING_STATE_KEY);
        if (!verifier || !state) return null;
        return { verifier, state };
    }

    async clearPendingState(): Promise<void> {
        await this.secrets.delete(PENDING_VERIFIER_KEY);
        await this.secrets.delete(PENDING_STATE_KEY);
    }

    // =========================================================================
    // Access token retrieval with proactive refresh
    // =========================================================================

    /**
     * Get a valid access token, refreshing it first when it is about to
     * expire.
     */
    async getValidAccessToken(): Promise<string> {
        if (!this.tokens) {
            throw new Error('Not authenticated with xAI. Please connect your SuperGrok account.');
        }

        if (isTokenExpiring(this.tokens)) {
            await this.refresh();
        }

        return this.tokens.access_token;
    }

    /**
     * Force a refresh regardless of local expiry. Used when the server
     * invalidates a token early (401 mid-flight).
     */
    async forceRefreshAccessToken(): Promise<string> {
        if (!this.tokens) {
            throw new Error('Not authenticated with xAI. Please connect your SuperGrok account.');
        }
        await this.refresh();
        return this.tokens.access_token;
    }

    private async refresh(): Promise<void> {
        if (!this.refreshPromise) {
            const current = this.tokens;
            if (!current) {
                throw new Error('Not authenticated with xAI.');
            }
            this.refreshPromise = refreshTokens(current.refresh_token)
                .then(async refreshed => {
                    // Preserve the id_token: refresh responses may omit it and
                    // it is our only source of account email for display.
                    const merged: XaiTokens = {
                        ...refreshed,
                        id_token: refreshed.id_token ?? current.id_token,
                    };
                    await this.saveTokens(merged);
                    this.logger.info('Refreshed xAI access token');
                    return merged;
                })
                .finally(() => {
                    this.refreshPromise = null;
                });
        }

        try {
            await this.refreshPromise;
        } catch (error) {
            // A definitive 4xx from the token endpoint means the refresh token
            // is dead (revoked / rotated elsewhere) — force re-login rather
            // than looping on a broken pair.
            const message = error instanceof Error ? error.message : String(error);
            if (/\((400|401|403)\)/.test(message)) {
                this.logger.error('xAI refresh token rejected, clearing credentials:', message);
                await this.clearTokens();
            }
            throw error;
        }
    }
}
