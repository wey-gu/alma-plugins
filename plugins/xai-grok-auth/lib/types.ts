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

export interface XaiAccountClaims {
    email?: string;
    name?: string;
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
