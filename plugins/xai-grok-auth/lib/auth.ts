/**
 * OAuth Authentication for xAI (SuperGrok subscription)
 *
 * Implements the OAuth2 PKCE authorization-code flow against auth.x.ai.
 * Mirrors OpenCode's xai plugin (packages/opencode/src/plugin/xai.ts):
 * xAI's auth server rejects loopback OAuth from non-allowlisted clients,
 * so we reuse the Grok-CLI client_id that xAI ships for desktop OAuth flows.
 */

import type { XaiTokens, XaiAccountClaims } from './types';

// ============================================================================
// OAuth Configuration
// ============================================================================

// Public Grok-CLI OAuth client (same one OpenCode reuses).
export const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const AUTHORIZE_URL = 'https://auth.x.ai/oauth2/authorize';
export const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
export const SCOPE = 'openid profile email offline_access grok-cli:access api:access';

// The host:port pair is part of the Grok-CLI client registration, so the
// loopback callback server must bind exactly this port.
export const OAUTH_HOST = '127.0.0.1';
export const OAUTH_PORT = 56121;
export const OAUTH_CALLBACK_PATH = '/callback';
export const REDIRECT_URI = `http://${OAUTH_HOST}:${OAUTH_PORT}${OAUTH_CALLBACK_PATH}`;

// Origins allowed to hit the loopback callback via CORS/PNA preflight.
export const CORS_ORIGINS = ['https://accounts.x.ai', 'https://auth.x.ai'];

// ============================================================================
// PKCE Helpers
// ============================================================================

function generateRandomString(length: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let result = '';
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
        result += chars[randomValues[i] % chars.length];
    }
    return result;
}

async function sha256Base64Url(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(input));
    const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ============================================================================
// OAuth Flow
// ============================================================================

/**
 * Generate the authorization URL with PKCE challenge.
 */
export async function getAuthorizationUrl(): Promise<{ url: string; verifier: string; state: string }> {
    const verifier = generateRandomString(64);
    const challenge = await sha256Base64Url(verifier);
    const state = generateRandomString(32);
    const nonce = generateRandomString(32);

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        nonce,
        // `plan=generic` opts the consent screen into xAI's generic OAuth plan
        // tier; without it accounts.x.ai rejects loopback OAuth from
        // non-allowlisted clients. `referrer` is best-effort attribution.
        plan: 'generic',
        referrer: 'alma',
    });

    return { url: `${AUTHORIZE_URL}?${params.toString()}`, verifier, state };
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
}

function toTokens(data: TokenResponse, fallbackRefreshToken?: string): XaiTokens {
    const refreshToken = data.refresh_token || fallbackRefreshToken;
    if (!data.access_token || !refreshToken) {
        throw new Error('xAI token response is missing access_token or refresh_token');
    }
    return {
        access_token: data.access_token,
        refresh_token: refreshToken,
        expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
        id_token: typeof data.id_token === 'string' ? data.id_token : undefined,
    };
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCodeForTokens(code: string, verifier: string): Promise<XaiTokens> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
    });

    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: body.toString(),
    });

    if (!response.ok) {
        const error = await response.text().catch(() => '');
        throw new Error(`xAI token exchange failed (${response.status})${error ? `: ${error}` : ''}`);
    }

    return toTokens((await response.json()) as TokenResponse);
}

/**
 * Refresh access token using refresh token.
 */
export async function refreshTokens(refreshToken: string): Promise<XaiTokens> {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
    });

    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: body.toString(),
    });

    if (!response.ok) {
        const error = await response.text().catch(() => '');
        throw new Error(`xAI token refresh failed (${response.status})${error ? `: ${error}` : ''}`);
    }

    return toTokens((await response.json()) as TokenResponse, refreshToken);
}

// ============================================================================
// JWT Helpers
// ============================================================================

function safeDecodeJWT(token: string | undefined): Record<string, unknown> | null {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
        let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (payload.length % 4 !== 0) payload += '=';
        return JSON.parse(atob(payload));
    } catch {
        return null;
    }
}

/**
 * Check whether the access token is expired or about to expire.
 *
 * The stored expires_at is best-effort (xAI does not always return
 * expires_in), so for JWT access tokens the `exp` claim is the load-bearing
 * check. Opaque tokens fall back to the stored deadline only.
 */
export function isTokenExpiring(tokens: XaiTokens, skewMs: number = 2 * 60 * 1000): boolean {
    const claims = safeDecodeJWT(tokens.access_token);
    if (claims && typeof claims.exp === 'number') {
        return claims.exp * 1000 <= Date.now() + skewMs;
    }
    return Date.now() >= tokens.expires_at - skewMs;
}

/**
 * Extract account claims for display. The id_token (openid/profile/email
 * scopes) is the primary source; access_token fills gaps if it's a JWT.
 */
export function extractAccountClaims(tokens: XaiTokens): XaiAccountClaims {
    const id = safeDecodeJWT(tokens.id_token) ?? {};
    const access = safeDecodeJWT(tokens.access_token) ?? {};

    const readString = (obj: Record<string, unknown>, key: string): string | undefined => {
        const value = obj[key];
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    };

    return {
        email: readString(id, 'email') ?? readString(access, 'email'),
        name: readString(id, 'name') ?? readString(access, 'name'),
    };
}
