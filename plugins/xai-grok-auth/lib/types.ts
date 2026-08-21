/**
 * Shared types for xAI Grok Auth plugin.
 */

export interface XaiTokens {
    access_token: string;
    refresh_token: string;
    /** Expiry in ms since epoch. Best-effort: xAI does not always return expires_in. */
    expires_at: number;
    id_token?: string;
}

export interface XaiAccountProfile {
    email?: string;
    name?: string;
    picture?: string;
}

/** Per-limit quota entry, shaped for Alma's ProviderAccountInfo.quota */
export interface XaiQuotaModel {
    /** Limit name (e.g. "requests", "tokens") */
    name: string;
    /** Remaining percentage (0-100) */
    percentage: number;
    /** Reset time in ISO 8601 format */
    resetTime: string;
}

export interface XaiQuota {
    models: XaiQuotaModel[];
    lastUpdated: number;
    rateLimitReached?: boolean;
}

/** Everything persisted for the (single) connected account. */
export interface XaiStoredRecord {
    tokens: XaiTokens;
    profile?: XaiAccountProfile;
    quota?: XaiQuota;
}

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
