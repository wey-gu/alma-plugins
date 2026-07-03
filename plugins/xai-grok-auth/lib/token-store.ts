/**
 * Token Store for xAI Grok Auth — single account.
 *
 * Persists the OAuth token pair plus display data (profile, quota) in the
 * plugin's secret storage and refreshes the access token proactively.
 * Concurrent refreshes are collapsed onto one HTTP call (single-flight) so a
 * rotating refresh_token is never replayed.
 *
 * Storage layout:
 *   - `xai_account`     → JSON<XaiStoredRecord> ({ tokens, profile?, quota? })
 *   - `xai_tokens`       (legacy) → JSON<XaiTokens> — migrated on load
 *   - `pending_verifier` → string (PKCE verifier, during login only)
 *   - `pending_state`    → string (OAuth state, during login only)
 */

import type { XaiTokens, XaiStoredRecord, XaiAccountProfile, XaiQuota, SecretStorage, Logger } from './types';
import { refreshTokens, isTokenExpiring, decodeAccessTokenSub, extractAccountClaims } from './auth';

const STORAGE_KEY = 'xai_account';
const LEGACY_STORAGE_KEY = 'xai_tokens';
const PENDING_VERIFIER_KEY = 'pending_verifier';
const PENDING_STATE_KEY = 'pending_state';

export class TokenStore {
    private secrets: SecretStorage;
    private logger: Logger;
    private record: XaiStoredRecord | null = null;
    private refreshPromise: Promise<XaiTokens> | null = null;
    private lastPersistedQuota: string | null = null;

    constructor(secrets: SecretStorage, logger: Logger) {
        this.secrets = secrets;
        this.logger = logger;
    }

    async initialize(): Promise<void> {
        try {
            const stored = await this.secrets.get(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored) as XaiStoredRecord;
                if (parsed?.tokens?.access_token && parsed.tokens.refresh_token) {
                    this.record = parsed;
                    this.logger.info('Loaded cached xAI account');
                    return;
                }
            }

            // Migrate the v1.0 layout (bare tokens under xai_tokens).
            const legacy = await this.secrets.get(LEGACY_STORAGE_KEY);
            if (legacy) {
                const tokens = JSON.parse(legacy) as XaiTokens;
                if (tokens?.access_token && tokens.refresh_token) {
                    this.record = { tokens };
                    await this.persist();
                    await this.secrets.delete(LEGACY_STORAGE_KEY);
                    this.logger.info('Migrated legacy xAI token storage');
                }
            }
        } catch (error) {
            this.logger.error('Failed to load cached xAI account:', error);
        }
    }

    hasTokens(): boolean {
        return this.record !== null;
    }

    getProfile(): XaiAccountProfile | undefined {
        return this.record?.profile;
    }

    getQuota(): XaiQuota | undefined {
        return this.record?.quota;
    }

    /** Claims decoded from the stored JWTs — fallback when userinfo fails. */
    getIdTokenClaims(): XaiAccountProfile | null {
        return this.record ? extractAccountClaims(this.record.tokens) : null;
    }

    /** Stable account id for the UI: JWT `sub`, then email, then a constant. */
    getAccountId(): string {
        if (!this.record) return 'xai';
        return decodeAccessTokenSub(this.record.tokens.access_token) ?? this.record.profile?.email ?? 'xai';
    }

    private async persist(): Promise<void> {
        if (this.record) {
            await this.secrets.set(STORAGE_KEY, JSON.stringify(this.record));
        }
    }

    async saveTokens(tokens: XaiTokens): Promise<void> {
        this.record = { ...(this.record ?? {}), tokens };
        await this.persist();
    }

    async setProfile(profile: XaiAccountProfile): Promise<void> {
        if (!this.record) return;
        this.record.profile = { ...this.record.profile, ...profile };
        await this.persist();
    }

    /** Update quota; skips the disk write when nothing changed. */
    async setQuota(quota: XaiQuota): Promise<void> {
        if (!this.record) return;
        this.record.quota = quota;
        const fingerprint = JSON.stringify([quota.models, quota.rateLimitReached]);
        if (fingerprint === this.lastPersistedQuota) return;
        this.lastPersistedQuota = fingerprint;
        await this.persist();
    }

    async clearTokens(): Promise<void> {
        this.record = null;
        this.refreshPromise = null;
        this.lastPersistedQuota = null;
        await this.secrets.delete(STORAGE_KEY);
        await this.secrets.delete(LEGACY_STORAGE_KEY);
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
        if (!this.record) {
            throw new Error('Not authenticated with xAI. Please connect your SuperGrok account.');
        }

        if (isTokenExpiring(this.record.tokens)) {
            await this.refresh();
        }

        return this.record.tokens.access_token;
    }

    /**
     * Force a refresh regardless of local expiry. Used when the server
     * invalidates a token early (401 mid-flight).
     */
    async forceRefreshAccessToken(): Promise<string> {
        if (!this.record) {
            throw new Error('Not authenticated with xAI. Please connect your SuperGrok account.');
        }
        await this.refresh();
        return this.record.tokens.access_token;
    }

    private async refresh(): Promise<void> {
        if (!this.refreshPromise) {
            const current = this.record?.tokens;
            if (!current) {
                throw new Error('Not authenticated with xAI.');
            }
            this.refreshPromise = refreshTokens(current.refresh_token)
                .then(async refreshed => {
                    // Preserve the id_token: refresh responses may omit it.
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
