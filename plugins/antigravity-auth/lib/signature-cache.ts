/**
 * Signature Cache for Thinking Blocks
 *
 * Claude requires signatures for thinking blocks in multi-turn conversations.
 * This cache stores signatures keyed by thinking text content, allowing us to
 * restore them when sending conversation history back to Claude.
 *
 * Based on opencode-antigravity-auth's SignatureCache implementation.
 */

// In-memory cache: thinkingText -> signature
const signatureCache = new Map<string, { signature: string; timestamp: number }>();

// TTL for cache entries (30 minutes)
const CACHE_TTL_MS = 30 * 60 * 1000;

// Maximum cache size
const MAX_CACHE_SIZE = 1000;

/**
 * Minimum valid signature length.
 * Signatures shorter than this are considered invalid/corrupted.
 * Matches Antigravity-Manager's MIN_SIGNATURE_LENGTH constant.
 */
export const MIN_SIGNATURE_LENGTH = 50;

/**
 * Generate a cache key from session ID and thinking text.
 * We use a hash of the text to keep keys manageable.
 */
function makeKey(sessionId: string, text: string): string {
    // Use first 200 chars of text as key (thinking blocks are unique enough)
    const textKey = text.slice(0, 200);
    return `${sessionId}:${textKey}`;
}

/**
 * Store a signature in the cache.
 */
export function cacheSignature(sessionId: string, thinkingText: string, signature: string): void {
    if (!sessionId || !thinkingText || !signature) return;

    // Clean up old entries if cache is too large
    if (signatureCache.size >= MAX_CACHE_SIZE) {
        cleanupExpired();
    }

    const key = makeKey(sessionId, thinkingText);
    signatureCache.set(key, {
        signature,
        timestamp: Date.now(),
    });
}

/**
 * Retrieve a signature from the cache.
 */
export function getCachedSignature(sessionId: string, thinkingText: string): string | undefined {
    if (!sessionId || !thinkingText) return undefined;

    const key = makeKey(sessionId, thinkingText);
    const entry = signatureCache.get(key);

    if (!entry) return undefined;

    // Check if expired
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        signatureCache.delete(key);
        return undefined;
    }

    return entry.signature;
}

/**
 * Remove expired entries from cache.
 */
function cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of signatureCache.entries()) {
        if (now - entry.timestamp > CACHE_TTL_MS) {
            signatureCache.delete(key);
        }
    }
}

/**
 * Clear all cached signatures for a session.
 */
export function clearSessionCache(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of signatureCache.keys()) {
        if (key.startsWith(prefix)) {
            signatureCache.delete(key);
        }
    }
}

/**
 * Clear the entire cache.
 */
export function clearAllCache(): void {
    signatureCache.clear();
}

/**
 * Validate if a signature meets minimum length requirements.
 * Returns true if signature is valid, false otherwise.
 */
export function isValidSignature(signature: string | undefined | null): boolean {
    if (!signature) return false;
    return signature.length >= MIN_SIGNATURE_LENGTH;
}
