/**
 * Runtime Antigravity version resolution.
 *
 * We resolve the latest client version at startup so request headers
 * don't get rejected as outdated.
 */

type LoggerLike = {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
};

const VERSION_URL = 'https://antigravity-auto-updater-974169037036.us-central1.run.app';
const CHANGELOG_URL = 'https://antigravity.google/changelog';
const FETCH_TIMEOUT_MS = 5000;
const CHANGELOG_SCAN_CHARS = 5000;
const VERSION_REGEX = /\d+\.\d+\.\d+/;

// Fallback to current stable version as of 2026-02-27.
const FALLBACK_VERSION = '1.19.6';

let antigravityVersion = FALLBACK_VERSION;

function parseVersion(text: string): string | null {
    const match = text.match(VERSION_REGEX);
    return match ? match[0] : null;
}

async function tryFetchVersion(url: string, maxChars?: number): Promise<string | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            return null;
        }

        let text = await response.text();
        if (maxChars) {
            text = text.slice(0, maxChars);
        }
        return parseVersion(text);
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function initAntigravityVersion(logger?: LoggerLike): Promise<void> {
    const fromApi = await tryFetchVersion(VERSION_URL);
    if (fromApi) {
        antigravityVersion = fromApi;
        logger?.info(`[Antigravity] Using runtime version ${antigravityVersion} (source=api)`);
        return;
    }

    const fromChangelog = await tryFetchVersion(CHANGELOG_URL, CHANGELOG_SCAN_CHARS);
    if (fromChangelog) {
        antigravityVersion = fromChangelog;
        logger?.info(`[Antigravity] Using runtime version ${antigravityVersion} (source=changelog)`);
        return;
    }

    logger?.warn(`[Antigravity] Failed to fetch runtime version, using fallback ${antigravityVersion}`);
}

export function getAntigravityVersion(): string {
    return antigravityVersion;
}

export function getAntigravityUserAgent(platform: 'windows/amd64' | 'darwin/arm64' = 'windows/amd64'): string {
    return `antigravity/${antigravityVersion} ${platform}`;
}
