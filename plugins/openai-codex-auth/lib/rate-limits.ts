/**
 * Codex / ChatGPT Rate Limit Fetcher
 *
 * Mirrors the official Codex CLI `BackendClient::get_rate_limits_many` path:
 *   GET https://chatgpt.com/backend-api/wham/usage
 *
 * Headers required: Bearer access_token + chatgpt-account-id + originator.
 *
 * Response shape (subset, see codex-rs/codex-backend-openapi-models):
 *   {
 *     "plan_type": "plus" | "pro" | "free" | ...,
 *     "rate_limit"?: RateLimitStatusDetails | null,
 *     "credits"?: CreditStatusDetails | null,
 *     "additional_rate_limits"?: AdditionalRateLimitDetails[] | null,
 *     "rate_limit_reached_type"?: { "type": ... } | null
 *   }
 *   RateLimitStatusDetails = {
 *     "allowed": bool, "limit_reached": bool,
 *     "primary_window"?:   RateLimitWindowSnapshot | null,
 *     "secondary_window"?: RateLimitWindowSnapshot | null
 *   }
 *   RateLimitWindowSnapshot = {
 *     "used_percent": int,           // 0-100
 *     "limit_window_seconds": int,
 *     "reset_after_seconds": int,    // seconds from now
 *     "reset_at": int                // unix timestamp (seconds)
 *   }
 */

import type { CodexAccountQuota, CodexQuotaEntry } from './types';
import type { Logger } from './token-store';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

interface Window {
    used_percent?: number;
    limit_window_seconds?: number;
    reset_after_seconds?: number;
    reset_at?: number;
}

interface RateLimitDetails {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: Window | null;
    secondary_window?: Window | null;
}

interface AdditionalRateLimit {
    limit_name?: string;
    metered_feature?: string;
    rate_limit?: RateLimitDetails | null;
}

interface UsagePayload {
    plan_type?: string;
    rate_limit?: RateLimitDetails | null;
    additional_rate_limits?: AdditionalRateLimit[] | null;
    rate_limit_reached_type?: { type?: string } | null;
}

export async function fetchAccountQuota(
    accessToken: string,
    accountId: string,
    logger: Logger
): Promise<CodexAccountQuota | null> {
    try {
        const response = await globalThis.fetch(USAGE_URL, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'chatgpt-account-id': accountId,
                originator: 'codex_cli_rs',
                accept: 'application/json',
            },
        });

        if (!response.ok) {
            logger.warn(`[codex quota] usage fetch failed: ${response.status} ${response.statusText}`);
            return null;
        }

        const payload = (await response.json()) as UsagePayload;
        const entries: CodexQuotaEntry[] = [];

        if (payload.rate_limit) {
            pushWindows(entries, 'codex', payload.rate_limit);
        }

        if (Array.isArray(payload.additional_rate_limits)) {
            for (const extra of payload.additional_rate_limits) {
                if (!extra?.rate_limit) continue;
                const label =
                    extra.limit_name?.trim() ||
                    extra.metered_feature?.trim() ||
                    'additional';
                pushWindows(entries, label, extra.rate_limit);
            }
        }

        return {
            models: entries,
            lastUpdated: Date.now(),
            planType: typeof payload.plan_type === 'string' ? payload.plan_type : undefined,
            rateLimitReached: payload.rate_limit?.limit_reached === true,
        };
    } catch (error) {
        logger.warn('[codex quota] usage fetch threw:', error);
        return null;
    }
}

function pushWindows(out: CodexQuotaEntry[], baseLabel: string, details: RateLimitDetails): void {
    const primary = details.primary_window;
    const secondary = details.secondary_window;

    if (primary) {
        out.push(toEntry(baseLabel + (secondary ? ' (5h)' : ''), primary));
    }
    if (secondary) {
        out.push(toEntry(baseLabel + ' (weekly)', secondary));
    }
}

function toEntry(name: string, window: Window): CodexQuotaEntry {
    const used = typeof window.used_percent === 'number' ? window.used_percent : 0;
    const remaining = Math.max(0, Math.min(100, Math.round(100 - used)));
    const resetIso = resolveResetIso(window);
    return { name, percentage: remaining, resetTime: resetIso };
}

function resolveResetIso(window: Window): string {
    if (typeof window.reset_at === 'number' && window.reset_at > 0) {
        return new Date(window.reset_at * 1000).toISOString();
    }
    if (typeof window.reset_after_seconds === 'number' && window.reset_after_seconds > 0) {
        return new Date(Date.now() + window.reset_after_seconds * 1000).toISOString();
    }
    return new Date(Date.now()).toISOString();
}
