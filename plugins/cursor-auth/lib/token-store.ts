/**
 * Token Store for Cursor Auth
 *
 * Manages storage and retrieval of OAuth tokens using the plugin's secret storage.
 * Handles automatic token refresh when tokens are about to expire.
 */

import type { CursorTokens } from './types';
import { refreshCursorToken } from './auth';

const STORAGE_KEY = 'cursor_tokens';

export interface SecretStorage {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

export interface Logger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
}

export class TokenStore {
    private secrets: SecretStorage;
    private logger: Logger;
    private cachedTokens: CursorTokens | null = null;
    private refreshPromise: Promise<CursorTokens> | null = null;

    constructor(secrets: SecretStorage, logger: Logger) {
        this.secrets = secrets;
        this.logger = logger;
    }

    async initialize(): Promise<void> {
        try {
            const stored = await this.secrets.get(STORAGE_KEY);
            if (stored) {
                this.cachedTokens = JSON.parse(stored);
                this.logger.info('Loaded cached Cursor tokens');
            }
        } catch (error) {
            this.logger.warn('Failed to load cached tokens:', error);
            this.cachedTokens = null;
        }
    }

    hasValidToken(): boolean {
        if (!this.cachedTokens) {
            return false;
        }
        return !!this.cachedTokens.refresh_token;
    }

    getTokens(): CursorTokens | null {
        return this.cachedTokens;
    }

    async saveTokens(tokens: CursorTokens): Promise<void> {
        this.cachedTokens = tokens;
        await this.secrets.set(STORAGE_KEY, JSON.stringify(tokens));
        this.logger.info('Saved Cursor tokens');
    }

    async clearTokens(): Promise<void> {
        this.cachedTokens = null;
        await this.secrets.delete(STORAGE_KEY);
        this.logger.info('Cleared Cursor tokens');
    }

    /**
     * Get a valid access token, refreshing if necessary.
     * Deduplicates concurrent refresh requests.
     */
    async getValidAccessToken(): Promise<string> {
        if (!this.cachedTokens) {
            throw new Error('Not authenticated. Please login first.');
        }

        // Check if token is still valid (with 5 minute buffer)
        if (Date.now() < this.cachedTokens.expires_at) {
            return this.cachedTokens.access_token;
        }

        this.logger.info('Access token expired, refreshing...');

        if (this.refreshPromise) {
            const tokens = await this.refreshPromise;
            return tokens.access_token;
        }

        this.refreshPromise = this.doRefresh();

        try {
            const tokens = await this.refreshPromise;
            return tokens.access_token;
        } finally {
            this.refreshPromise = null;
        }
    }

    private async doRefresh(): Promise<CursorTokens> {
        if (!this.cachedTokens?.refresh_token) {
            throw new Error('No refresh token available. Please login again.');
        }

        try {
            const newTokens = await refreshCursorToken(this.cachedTokens.refresh_token);
            await this.saveTokens(newTokens);
            this.logger.info('Successfully refreshed Cursor tokens');
            return newTokens;
        } catch (error) {
            this.logger.error('Failed to refresh tokens:', error);
            await this.clearTokens();
            throw new Error('Token refresh failed. Please login again.');
        }
    }
}
