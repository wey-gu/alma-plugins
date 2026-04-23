/**
 * OAuth Authentication for OpenAI Codex
 *
 * Implements OAuth2 PKCE flow to authenticate with ChatGPT backend.
 * Uses manual code copy method (similar to Claude Subscription).
 */

import type { PKCEChallenge, OAuthConfig, CodexTokens, CodexAccountClaims } from './types';

// ============================================================================
// OAuth Configuration
// ============================================================================

export const OAUTH_CONFIG: OAuthConfig = {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: 'http://localhost:1455/auth/callback',
    scopes: 'openid profile email offline_access',
};

// ============================================================================
// PKCE Helpers
// ============================================================================

/**
 * Generate a random string for PKCE verifier
 */
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

/**
 * Generate SHA-256 hash and base64url encode it
 */
async function sha256Base64Url(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
    // Convert to base64url
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate PKCE challenge and verifier
 */
export async function generatePKCE(): Promise<PKCEChallenge> {
    const verifier = generateRandomString(64);
    const challenge = await sha256Base64Url(verifier);
    return { verifier, challenge };
}

// ============================================================================
// OAuth Flow
// ============================================================================

/**
 * Generate the authorization URL with PKCE challenge
 */
export async function getAuthorizationUrl(): Promise<{ url: string; verifier: string; state: string }> {
    const pkce = await generatePKCE();
    const state = generateRandomString(32);

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: OAUTH_CONFIG.clientId,
        redirect_uri: OAUTH_CONFIG.redirectUri,
        scope: OAUTH_CONFIG.scopes,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state,
        // Codex CLI specific parameters
        codex_cli_simplified_flow: 'true',
        originator: 'codex_cli_rs',
    });

    const url = `${OAUTH_CONFIG.authUrl}?${params.toString()}`;

    return { url, verifier: pkce.verifier, state };
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
    code: string,
    verifier: string
): Promise<CodexTokens> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: OAUTH_CONFIG.clientId,
        code,
        code_verifier: verifier,
        redirect_uri: OAUTH_CONFIG.redirectUri,
    });

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
    }

    const data = await response.json();

    // Extract account ID from JWT
    const accountId = extractAccountIdFromJWT(data.access_token);

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
        account_id: accountId,
        id_token: typeof data.id_token === 'string' ? data.id_token : undefined,
    };
}

/**
 * Refresh access token using refresh token
 */
export async function refreshTokens(refreshToken: string): Promise<CodexTokens> {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CONFIG.clientId,
    });

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token refresh failed: ${error}`);
    }

    const data = await response.json();

    // Extract account ID from new JWT
    const accountId = extractAccountIdFromJWT(data.access_token);

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken, // Keep old refresh token if not provided
        expires_at: Date.now() + data.expires_in * 1000,
        account_id: accountId,
        id_token: typeof data.id_token === 'string' ? data.id_token : undefined,
    };
}

// ============================================================================
// JWT Helpers
// ============================================================================

/**
 * Decode JWT without verification (for extracting claims)
 */
function decodeJWT(token: string): Record<string, unknown> {
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
    }

    // Decode payload (second part)
    const payload = parts[1];
    // Add padding if needed
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));

    return JSON.parse(decoded);
}

/**
 * Extract ChatGPT account ID from access token JWT
 */
export function extractAccountIdFromJWT(accessToken: string): string {
    try {
        const payload = decodeJWT(accessToken);

        // The account ID is in the OpenAI-specific claim
        const authClaim = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
        if (authClaim?.chatgpt_account_id) {
            return authClaim.chatgpt_account_id as string;
        }

        // Fallback to subject claim
        if (payload.sub) {
            return payload.sub as string;
        }

        throw new Error('Could not find account ID in token');
    } catch (error) {
        throw new Error(`Failed to extract account ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Extract account/profile claims from access_token (and optional id_token).
 * Matches the claim shape used by the official Codex CLI (`IdTokenInfo`),
 * extended with the OIDC-standard `picture` claim.
 *
 * Precedence: access_token first, id_token only used to fill gaps.
 */
export function extractAccountClaims(
    accessToken: string,
    idToken?: string
): CodexAccountClaims {
    const primary = safeDecodeJWT(accessToken) ?? {};
    const secondary = idToken ? (safeDecodeJWT(idToken) ?? {}) : {};

    const accountId =
        readString(primary, ['https://api.openai.com/auth', 'chatgpt_account_id']) ||
        readString(secondary, ['https://api.openai.com/auth', 'chatgpt_account_id']) ||
        readString(primary, ['sub']) ||
        readString(secondary, ['sub']) ||
        '';

    if (!accountId) {
        throw new Error('Could not find account ID in token');
    }

    const email =
        readString(primary, ['email']) ||
        readString(secondary, ['email']) ||
        readString(primary, ['https://api.openai.com/profile', 'email']) ||
        readString(secondary, ['https://api.openai.com/profile', 'email']);

    const picture =
        readString(secondary, ['picture']) ||
        readString(primary, ['picture']) ||
        readString(secondary, ['https://api.openai.com/profile', 'picture']) ||
        readString(primary, ['https://api.openai.com/profile', 'picture']);

    const plan =
        readString(primary, ['https://api.openai.com/auth', 'chatgpt_plan_type']) ||
        readString(secondary, ['https://api.openai.com/auth', 'chatgpt_plan_type']);

    return { accountId, email, picture, plan };
}

function safeDecodeJWT(token: string): Record<string, unknown> | null {
    try {
        return decodeJWT(token);
    } catch {
        return null;
    }
}

/** Read a string at a nested path, returning undefined if any hop is missing. */
function readString(obj: Record<string, unknown>, path: string[]): string | undefined {
    let cur: unknown = obj;
    for (const key of path) {
        if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
            cur = (cur as Record<string, unknown>)[key];
        } else {
            return undefined;
        }
    }
    return typeof cur === 'string' && cur.length > 0 ? cur : undefined;
}

/**
 * Check if a token is expired or about to expire (within 5 minutes)
 */
export function isTokenExpired(expiresAt: number, bufferMs: number = 5 * 60 * 1000): boolean {
    return Date.now() >= expiresAt - bufferMs;
}
