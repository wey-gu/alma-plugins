/**
 * PKCE (Proof Key for Code Exchange) helpers for Cursor OAuth.
 * Uses Web Crypto API for cross-runtime compatibility.
 */

import type { PKCEChallenge } from './types';

export async function generatePKCE(): Promise<PKCEChallenge> {
    const verifierBytes = new Uint8Array(96);
    crypto.getRandomValues(verifierBytes);
    const verifier = Buffer.from(verifierBytes).toString('base64url');

    const data = new TextEncoder().encode(verifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const challenge = Buffer.from(hashBuffer).toString('base64url');

    return { verifier, challenge };
}
