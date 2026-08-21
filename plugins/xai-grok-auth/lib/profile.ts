/**
 * Account profile resolver.
 *
 * xAI runs a standard OIDC userinfo endpoint (confirmed by
 * https://auth.x.ai/.well-known/openid-configuration), and our scopes include
 * `openid profile email`, so a plain Bearer GET returns the account's email /
 * name / picture. Gravatar is the avatar fallback when userinfo has no
 * picture claim (d=404 so the UI can drop to its generic icon on miss).
 */

import type { XaiAccountProfile, Logger } from './types';

const USERINFO_URL = 'https://auth.x.ai/oauth2/userinfo';

export async function fetchUserInfo(accessToken: string, logger: Logger): Promise<XaiAccountProfile | null> {
    try {
        const response = await fetch(USERINFO_URL, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
            },
        });
        if (!response.ok) {
            logger.warn(`xAI userinfo returned ${response.status}`);
            return null;
        }

        const data = (await response.json()) as Record<string, unknown>;
        const readString = (key: string): string | undefined => {
            const value = data[key];
            return typeof value === 'string' && value.length > 0 ? value : undefined;
        };

        const profile: XaiAccountProfile = {
            email: readString('email'),
            name: readString('name') ?? readString('preferred_username'),
            picture: absolutizePicture(readString('picture')),
        };

        if (!profile.email && !profile.name && !profile.picture) {
            logger.warn('xAI userinfo response carried no usable claims');
            return null;
        }
        return profile;
    } catch (error) {
        logger.warn('xAI userinfo fetch failed:', error);
        return null;
    }
}

/**
 * xAI's userinfo `picture` claim is a bare asset path like
 * `users/<sub>/xxx-profile-picture.webp`; the asset is served from grok.com
 * (verified live — assets.grok.com 403s, grok.com 200s). Absolute URLs and
 * data URIs pass through untouched.
 */
function absolutizePicture(picture: string | undefined): string | undefined {
    if (!picture) return undefined;
    if (/^(https?:\/\/|data:)/i.test(picture)) return picture;
    return `https://grok.com/${picture.replace(/^\/+/, '')}`;
}

/**
 * Resolve an avatar URL from an email address via Gravatar. `d=404` makes
 * Gravatar 404 when the email isn't registered, letting the UI fall back to
 * its generic icon via onError.
 */
export async function avatarUrlForEmail(email: string): Promise<string | null> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;
    const data = new TextEncoder().encode(normalized);
    const buf = await crypto.subtle.digest('SHA-256', data);
    const hash = Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    return `https://www.gravatar.com/avatar/${hash}?s=128&d=404`;
}
