/**
 * Quota extraction from API rate-limit response headers.
 *
 * xAI exposes no subscription-quota endpoint (OpenCode doesn't surface one
 * either), so quota is captured opportunistically from the rate-limit headers
 * that api.x.ai attaches to responses. Header names and reset formats vary
 * across providers and over time, so everything here parses defensively:
 *
 *   - OpenAI-style:  x-ratelimit-{limit,remaining,reset}-{requests,tokens}
 *   - IETF draft:    ratelimit-{limit,remaining,reset}
 *   - 429 fallback:  retry-after (seconds or HTTP-date)
 */

import type { XaiQuota, XaiQuotaModel } from './types';

const HEADER_PATTERN = /^(?:x-)?ratelimit-(limit|remaining|reset)(?:-(.+))?$/i;

/** Parse a reset value: epoch (s/ms), delta seconds, Go-style duration, or date. */
function parseResetToIso(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const num = Number(trimmed);
    if (Number.isFinite(num) && num >= 0) {
        if (num > 1e12) return new Date(num).toISOString(); // ms epoch
        if (num > 1e9) return new Date(num * 1000).toISOString(); // s epoch
        return new Date(Date.now() + num * 1000).toISOString(); // delta seconds
    }

    // Go-style duration like "6m20s", "1h2m", "250ms"
    if (/^(\d+(?:\.\d+)?(?:h|ms|m|s))+$/.test(trimmed)) {
        let ms = 0;
        for (const [, amount, unit] of trimmed.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) {
            const n = Number(amount);
            if (unit === 'h') ms += n * 3_600_000;
            else if (unit === 'm') ms += n * 60_000;
            else if (unit === 's') ms += n * 1000;
            else ms += n;
        }
        return new Date(Date.now() + ms).toISOString();
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    return null;
}

/**
 * Extract quota info from response headers. Returns null when the response
 * carries no rate-limit signal at all.
 */
export function quotaFromHeaders(headers: Headers, status: number): XaiQuota | null {
    const groups = new Map<string, { limit?: number; remaining?: number; reset?: string }>();

    headers.forEach((value, name) => {
        const match = name.match(HEADER_PATTERN);
        if (!match) return;
        const field = match[1].toLowerCase() as 'limit' | 'remaining' | 'reset';
        const group = (match[2] ?? 'requests').toLowerCase();
        const entry = groups.get(group) ?? {};
        if (field === 'reset') {
            entry.reset = value;
        } else {
            const num = Number(value);
            if (Number.isFinite(num) && num >= 0) entry[field] = num;
        }
        groups.set(group, entry);
    });

    const models: XaiQuotaModel[] = [];
    for (const [name, entry] of groups) {
        if (entry.limit === undefined || entry.remaining === undefined || entry.limit <= 0) continue;
        const percentage = Math.max(0, Math.min(100, Math.round((entry.remaining / entry.limit) * 100)));
        const resetTime = (entry.reset ? parseResetToIso(entry.reset) : null) ?? new Date().toISOString();
        models.push({ name, percentage, resetTime });
    }

    const rateLimited = status === 429;
    if (models.length === 0 && !rateLimited) return null;

    if (models.length === 0 && rateLimited) {
        // No structured headers — synthesize a 0% entry from retry-after.
        const retryAfter = headers.get('retry-after');
        const resetTime = (retryAfter ? parseResetToIso(retryAfter) : null) ?? new Date().toISOString();
        models.push({ name: 'requests', percentage: 0, resetTime });
    }

    return {
        models,
        lastUpdated: Date.now(),
        rateLimitReached: rateLimited || models.some(m => m.percentage <= 0),
    };
}
