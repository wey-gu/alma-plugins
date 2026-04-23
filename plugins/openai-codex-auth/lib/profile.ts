/**
 * Account avatar resolver.
 *
 * The OpenAI OAuth JWTs don't carry a `picture` claim, and ChatGPT's web-only
 * profile endpoints (`/backend-api/me`, `/backend-api/accounts/check`) sit
 * behind Cloudflare and reject Codex-style bearer tokens with 403. Codex's
 * own backend client (`codex-rs/backend-client`) exposes no profile/avatar
 * endpoint either.
 *
 * So we derive the avatar from Gravatar using the lowercased SHA-256 of the
 * email. Gravatar is asked to 404 when there's no match (`d=404`) so the UI
 * can transparently fall back to its generic User icon via onError.
 *
 * Also compute a deterministic DiceBear fallback as a second chance when the
 * user isn't on Gravatar.
 */

import type { Logger } from './token-store';

export interface AccountProfile {
    email?: string;
    name?: string;
    picture?: string;
}

export async function fetchAccountProfile(
    accessToken: string,
    accountId: string,
    logger: Logger
): Promise<AccountProfile | null> {
    // accessToken / accountId are unused today — kept in the signature so that
    // if OpenAI ever exposes a codex-safe profile endpoint we can plug it in
    // without touching the call site.
    void accessToken;
    void accountId;

    // We don't currently have an email here — the caller only has what's
    // already on the record. This function is still called so we can cheaply
    // keep the hook in place, but without an email there's nothing to do.
    logger.debug('[codex profile] no remote profile endpoint available for CLI tokens');
    return null;
}

/**
 * Resolve an avatar URL from an email address. Gravatar-first, then DiceBear.
 * Both URLs return 200 for any input (Gravatar with `d=404` returns 404 when
 * the email isn't registered, letting the UI fall through to its icon).
 */
export async function avatarUrlForEmail(email: string): Promise<string | null> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;
    const hash = await sha256Hex(normalized);
    // d=404 → Gravatar returns 404 when no match; UI onError drops to icon.
    return `https://www.gravatar.com/avatar/${hash}?s=128&d=404`;
}

async function sha256Hex(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}
