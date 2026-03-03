/**
 * Token Store for Antigravity Auth
 *
 * Manages storage and retrieval of OAuth tokens using the plugin's secret storage.
 * Supports multiple accounts with automatic rotation via AccountManager.
 *
 * This implementation matches Antigravity-Manager's token_manager.rs exactly.
 */

import type { AntigravityTokens } from './types';
import { refreshTokens, isTokenExpired } from './auth';
import {
    AccountManager,
    GLOBAL_LOCK_DURATION_MS,
    type ManagedAccount,
    type ModelFamily,
    type HeaderStyle,
    type AccountStorageData,
    type SchedulingMode,
} from './account-manager';
import { fetchQuota, type QuotaData } from './quota';
import { buildModelsFromApiKeys, setCachedModels } from './models';

// Storage keys
const ACCOUNTS_STORAGE_KEY = 'antigravity_accounts';
const PENDING_VERIFIER_KEY = 'pending_verifier';
const PENDING_STATE_KEY = 'pending_state';

// ============================================================================
// Token Store Interface
// ============================================================================

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

// ============================================================================
// Token Store Implementation
// ============================================================================

export class TokenStore {
    private secrets: SecretStorage;
    private logger: Logger;
    private accountManager: AccountManager;
    private refreshPromises: Map<number, Promise<ManagedAccount>> = new Map();

    constructor(secrets: SecretStorage, logger: Logger) {
        this.secrets = secrets;
        this.logger = logger;
        this.accountManager = new AccountManager(logger);
    }

    /**
     * Initialize the token store by loading cached accounts
     */
    async initialize(): Promise<void> {
        try {
            const stored = await this.secrets.get(ACCOUNTS_STORAGE_KEY);
            if (stored) {
                const data = JSON.parse(stored) as AccountStorageData;
                this.accountManager.loadFromStorage(data);
            }
        } catch (error) {
            this.logger.warn('Failed to load cached accounts:', error);
        }
    }

    /**
     * Save accounts to storage
     */
    async saveAccounts(): Promise<void> {
        const data = this.accountManager.toStorageData();
        await this.secrets.set(ACCOUNTS_STORAGE_KEY, JSON.stringify(data));
    }

    /**
     * Check if we have valid tokens (at least one account)
     */
    hasValidToken(): boolean {
        return this.accountManager.getAccountCount() > 0;
    }

    /**
     * Get account manager for direct access
     */
    getAccountManager(): AccountManager {
        return this.accountManager;
    }

    /**
     * Add a new account from OAuth tokens
     */
    async addAccount(tokens: AntigravityTokens): Promise<ManagedAccount> {
        const account = this.accountManager.addAccount(tokens);
        await this.saveAccounts();
        return account;
    }

    /**
     * Remove an account by index
     */
    async removeAccount(index: number): Promise<boolean> {
        const result = this.accountManager.removeAccount(index);
        if (result) {
            await this.saveAccounts();
        }
        return result;
    }

    /**
     * Save tokens (for backward compatibility - adds as new account)
     */
    async saveTokens(tokens: AntigravityTokens): Promise<void> {
        await this.addAccount(tokens);
    }

    /**
     * Clear all accounts (logout all)
     */
    async clearTokens(): Promise<void> {
        // Remove all accounts
        while (this.accountManager.getAccountCount() > 0) {
            this.accountManager.removeAccount(0);
        }
        this.accountManager.clearAllRateLimits();
        this.accountManager.clearSessionBindings();
        this.accountManager.clearLastUsedAccount();
        await this.secrets.delete(ACCOUNTS_STORAGE_KEY);
        await this.secrets.delete(PENDING_VERIFIER_KEY);
        await this.secrets.delete(PENDING_STATE_KEY);
        this.logger.info('Cleared all Antigravity accounts');
    }

    /**
     * Get valid access token for a request with full Antigravity-Manager logic.
     * Matches Antigravity-Manager's get_token_internal exactly:
     * 1. Session stickiness: if session is bound to an account, use it
     * 2. 60s global lock: for non-image requests, reuse same account within 60s
     * 3. Round-robin: select next account using atomic index
     * 4. Retry loop: if token refresh fails, try next account
     * 5. Tier priority: ULTRA > PRO > FREE
     *
     * @param family Model family (claude/gemini)
     * @param sessionId Optional session ID for conversation stickiness
     * @param isImageRequest Whether this is an image generation request
     * @param forceRotate Force rotate to next account (used on retry)
     */
    async getValidAccessTokenForRequest(
        family: ModelFamily,
        sessionId?: string,
        isImageRequest: boolean = false,
        forceRotate: boolean = false
    ): Promise<{ accessToken: string; projectId: string; account: ManagedAccount; headerStyle: HeaderStyle }> {
        // Get tier-sorted accounts snapshot
        const sortedAccounts = this.accountManager.getSortedAccountsSnapshot();
        const total = sortedAccounts.length;

        if (total === 0) {
            throw new Error('Not authenticated. Please login first.');
        }

        // Get last used account info for 60s lock (for non-image requests)
        const lastUsedInfo = !isImageRequest ? this.accountManager.getLastUsedAccount() : null;

        const attempted = new Set<string>();
        let lastError: string | undefined;
        let needUpdateLastUsed: { accountIndex: number; clear: boolean } | null = null;

        // Get scheduling mode
        const schedulingMode = this.accountManager.getSchedulingMode();

        // Retry loop (matches Antigravity-Manager's for attempt in 0..total)
        for (let attempt = 0; attempt < total; attempt++) {
            const rotate = forceRotate || attempt > 0;
            let targetAccount: ManagedAccount | null = null;

            // Mode A: Sticky session handling (skip for PerformanceFirst mode)
            // Matches Antigravity-Manager: if !rotate && session_id.is_some() && scheduling.mode != SchedulingMode::PerformanceFirst
            if (!rotate && sessionId && schedulingMode !== 'PerformanceFirst') {
                const boundAccount = this.accountManager.getAccountForSession(sessionId);
                if (boundAccount) {
                    const accountId = boundAccount.email || String(boundAccount.index);

                    // Use quota-based availability check (not just timer-based)
                    if (!this.accountManager.isAccountAvailable(boundAccount)) {
                        // 【修复 Issue #284】立即解绑并切换账号，不再阻塞等待
                        // 原因：阻塞等待会导致并发请求时客户端 socket 超时 (UND_ERR_SOCKET)
                        // Account is rate-limited: unbind and switch immediately (all modes)
                        this.logger.warn(
                            `Session ${sessionId.slice(0, 8)}... bound account ${accountId} has no remaining quota. Unbinding and switching.`
                        );
                        this.accountManager.unbindSession(sessionId);
                    } else if (!attempted.has(accountId)) {
                        // Reuse bound account
                        this.logger.debug(`Sticky Session: Reusing bound account ${accountId} for session ${sessionId.slice(0, 8)}...`);
                        targetAccount = boundAccount;
                    }
                }
            }

            // Mode B: 60s global lock (skip for image requests only)
            // Matches Antigravity-Manager: target_token.is_none() && !rotate && quota_group != "image_gen"
            // Note: PerformanceFirst does NOT skip Mode B, only skips session binding
            if (!targetAccount && !rotate && !isImageRequest) {
                // Check if we can reuse last used account within 60s window
                if (lastUsedInfo) {
                    const elapsed = Date.now() - lastUsedInfo.timestamp;
                    if (elapsed < GLOBAL_LOCK_DURATION_MS) {
                        const lastAccount = this.accountManager.getAccountByIndex(lastUsedInfo.accountIndex);
                        if (lastAccount) {
                            const accountId = lastAccount.email || String(lastAccount.index);
                            // Use quota-based availability check (not just timer-based)
                            if (!attempted.has(accountId) && this.accountManager.isAccountAvailable(lastAccount)) {
                                this.logger.debug(`60s Window: Reusing last account ${accountId}`);
                                targetAccount = lastAccount;
                            }
                        }
                    }
                }

                // If no locked account, use round-robin
                if (!targetAccount) {
                    targetAccount = this.accountManager.selectNextAccount(sortedAccounts, attempted, true);
                    if (targetAccount) {
                        needUpdateLastUsed = { accountIndex: targetAccount.index, clear: false };

                        // Bind session if provided (skip for PerformanceFirst mode)
                        // Matches Antigravity-Manager: if scheduling.mode != SchedulingMode::PerformanceFirst
                        if (sessionId && schedulingMode !== 'PerformanceFirst') {
                            this.accountManager.bindSession(sessionId, targetAccount.index);
                            this.logger.debug(
                                `Sticky Session: Bound new account ${targetAccount.email || targetAccount.index} to session ${sessionId.slice(0, 8)}...`
                            );
                        }
                    }
                }
            } else if (!targetAccount) {
                // Mode C: Pure round-robin (for image requests or force rotate)
                targetAccount = this.accountManager.selectNextAccount(sortedAccounts, attempted, true);

                if (targetAccount && rotate) {
                    this.logger.debug(`Force Rotation: Switched to account ${targetAccount.email || targetAccount.index}`);
                }
            }

            // No available account - apply optimistic reset strategy
            // 乐观重置策略: 双层防护机制 (matches Antigravity-Manager v3.3.19)
            if (!targetAccount) {
                const minWait = this.accountManager.getMinWaitTime();

                // Layer 1: 如果最短等待时间 <= 2秒，执行缓冲延迟
                if (minWait !== undefined && minWait <= 2) {
                    this.logger.warn(
                        `All accounts rate-limited but shortest wait is ${minWait}s. Applying 500ms buffer for state sync...`
                    );

                    // 缓冲延迟 500ms
                    await new Promise((resolve) => setTimeout(resolve, 500));

                    // 重新尝试选择账号
                    const retryAccount = this.accountManager.selectNextAccount(sortedAccounts, attempted, false);
                    if (retryAccount) {
                        this.logger.info(`Buffer delay successful! Found available account: ${retryAccount.email || retryAccount.index}`);
                        targetAccount = retryAccount;
                    } else {
                        // Layer 2: 缓冲后仍无可用账号，执行乐观重置
                        this.logger.warn(
                            `Buffer delay failed. Executing optimistic reset for all ${sortedAccounts.length} accounts...`
                        );

                        // 清除所有限流记录
                        this.accountManager.clearAllRateLimits();

                        // 再次尝试选择账号
                        const finalAccount = this.accountManager.selectNextAccount(sortedAccounts, attempted, false);
                        if (finalAccount) {
                            this.logger.info(`Optimistic reset successful! Using account: ${finalAccount.email || finalAccount.index}`);
                            targetAccount = finalAccount;
                        } else {
                            // 所有策略都失败
                            throw new Error('All accounts failed after optimistic reset. Please check account health.');
                        }
                    }
                } else if (minWait !== undefined) {
                    // 等待时间 > 2秒，正常返回错误
                    throw new Error(`All accounts are currently limited. Please wait ${minWait}s.`);
                } else {
                    // 无限流记录但仍无可用账号
                    throw new Error('All accounts failed or unhealthy.');
                }
            }

            const accountId = targetAccount.email || String(targetAccount.index);

            // 3. Check if token needs refresh (refresh 5 minutes before expiry)
            const now = Date.now();
            const needsRefresh = !targetAccount.accessToken ||
                !targetAccount.expiresAt ||
                now >= targetAccount.expiresAt - 5 * 60 * 1000;

            if (needsRefresh) {
                this.logger.debug(`Token for account ${accountId} needs refresh...`);

                try {
                    await this.refreshAccountTokenInternal(targetAccount);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    this.logger.error(`Token refresh failed for ${accountId}: ${errorMessage}`);

                    // Check for invalid_grant - disable account
                    if (errorMessage.includes('invalid_grant')) {
                        this.logger.error(`Disabling account ${accountId} due to invalid_grant`);
                        this.accountManager.disableAccount(targetAccount, `invalid_grant: ${errorMessage}`);
                        await this.saveAccounts();
                    }

                    lastError = `Token refresh failed: ${errorMessage}`;
                    attempted.add(accountId);

                    // Clear last used if this was the locked account
                    if (!isImageRequest && lastUsedInfo?.accountIndex === targetAccount.index) {
                        needUpdateLastUsed = { accountIndex: 0, clear: true };
                    }

                    continue; // Try next account
                }
            }

            // 4. Ensure we have project_id (should always be present from OAuth)
            if (!targetAccount.projectId) {
                this.logger.error(`Account ${accountId} missing project_id`);
                lastError = `Account ${accountId} missing project_id`;
                attempted.add(accountId);
                continue;
            }

            // Update last used account (if needed)
            if (needUpdateLastUsed) {
                if (needUpdateLastUsed.clear) {
                    this.accountManager.clearLastUsedAccount();
                } else {
                    this.accountManager.updateLastUsedAccount(needUpdateLastUsed.accountIndex);
                }
            } else if (!isImageRequest && targetAccount) {
                // Always update last used for non-image requests
                this.accountManager.updateLastUsedAccount(targetAccount.index);
            }

            // Update lastUsed timestamp
            targetAccount.lastUsed = now;

            // Save any updates
            await this.saveAccounts();

            return {
                accessToken: targetAccount.accessToken!,
                projectId: targetAccount.projectId,
                account: targetAccount,
                headerStyle: 'antigravity', // Default header style
            };
        }

        // All accounts failed
        throw new Error(lastError || 'All accounts failed');
    }

    /**
     * Internal token refresh without promise deduplication (used in retry loop)
     */
    private async refreshAccountTokenInternal(account: ManagedAccount): Promise<void> {
        this.logger.info(`Refreshing token for account ${account.index} (${account.email || 'unknown'})...`);

        const newTokens = await refreshTokens(account.refreshToken, account.projectId);

        // Update account with new tokens
        this.accountManager.updateAccountTokens(
            account,
            newTokens.access_token,
            newTokens.expires_at
        );

        // Update refresh token if it changed
        if (newTokens.refresh_token !== account.refreshToken) {
            account.refreshToken = newTokens.refresh_token;
        }

        // Update project_id if it was fetched/updated during refresh
        // (matches CLIProxyAPI v6.6.108 ensureAntigravityProjectID behavior)
        if (newTokens.project_id && newTokens.project_id !== account.projectId) {
            this.logger.info(`Updating project_id for account ${account.index}: ${account.projectId} -> ${newTokens.project_id}`);
            account.projectId = newTokens.project_id;
        }

        this.logger.info(`Successfully refreshed token for account ${account.index}`);
    }

    /**
     * Get valid access token for a model family.
     * @deprecated Use getValidAccessTokenForRequest() for full Antigravity-Manager logic
     */
    async getValidAccessTokenForFamily(family: ModelFamily): Promise<{ accessToken: string; projectId: string; account: ManagedAccount; headerStyle: HeaderStyle }> {
        return this.getValidAccessTokenForRequest(family);
    }

    /**
     * Get a valid access token (backward compatibility - uses claude family)
     */
    async getValidAccessToken(): Promise<string> {
        const result = await this.getValidAccessTokenForFamily('claude');
        return result.accessToken;
    }

    /**
     * Mark an account as rate limited.
     * Matches Antigravity-Manager's mark_rate_limited_async with realtime quota fallback.
     *
     * Strategy (matching Antigravity-Manager):
     * 1. If API returns explicit time (quotaResetDelay, retry-after) → use directly
     * 2. If not → fetch realtime quota to get accurate reset time
     * 3. Fallback to default rate limit handling
     *
     * @param account The account to mark
     * @param status HTTP status code (429, 500, 503, 529)
     * @param retryAfterHeader Retry-After header value
     * @param errorBody Error response body
     * @param model Optional model name for model-level rate limiting tracking
     */
    async markRateLimited(
        account: ManagedAccount,
        status: number,
        retryAfterHeader: string | undefined,
        errorBody: string,
        model?: string
    ): Promise<void> {
        const accountId = account.email || String(account.index);

        // Check if API returned explicit retry time
        const hasExplicitRetryTime = retryAfterHeader ||
            errorBody.includes('quotaResetDelay') ||
            errorBody.includes('retry after') ||
            errorBody.includes('try again in');

        if (hasExplicitRetryTime) {
            // API returned explicit time, use it directly
            this.logger.debug(`Account ${accountId} 429 response has explicit retry time, using API-provided time`);
            this.accountManager.markRateLimited(accountId, status, retryAfterHeader, errorBody, model);
        } else {
            // No explicit time - try to fetch real quota to get accurate reset time
            this.logger.info(`Account ${accountId} 429 response has no explicit retry time, fetching real quota...`);
            const locked = await this.fetchAndLockWithRealtimeQuota(account, model);

            if (!locked) {
                // Fallback to default rate limit handling
                this.logger.warn(`Failed to fetch realtime quota for ${accountId}, using default rate limit`);
                this.accountManager.markRateLimited(accountId, status, retryAfterHeader, errorBody, model);
            }
        }

        await this.saveAccounts();
    }

    /**
     * Fetch realtime quota and lock account with accurate reset time.
     * Matches Antigravity-Manager's fetch_and_lock_with_realtime_quota.
     *
     * @param account Account to lock
     * @param model Optional model for model-level rate limiting
     * @returns true if successfully locked with real quota data
     */
    private async fetchAndLockWithRealtimeQuota(
        account: ManagedAccount,
        model?: string
    ): Promise<boolean> {
        const accountId = account.email || String(account.index);

        try {
            // Refresh token if needed
            if (!account.accessToken || !account.expiresAt || isTokenExpired(account.expiresAt)) {
                await this.refreshAccountTokenInternal(account);
            }

            if (!account.accessToken) {
                this.logger.warn(`No access token for account ${accountId}, cannot fetch realtime quota`);
                return false;
            }

            // Fetch fresh quota
            this.logger.info(`Fetching realtime quota for account ${accountId}...`);
            const quota = await fetchQuota(account.accessToken, account.projectId);
            account.quota = quota;

            // Find earliest reset time from quota data
            const earliestReset = quota.models
                .filter(m => m.resetTime)
                .map(m => m.resetTime)
                .filter(t => t)
                .sort()[0];

            if (earliestReset) {
                this.logger.info(`Account ${accountId} realtime quota fetched, reset_time: ${earliestReset}`);

                // Parse the ISO timestamp and set rate limit
                const resetTimeMs = new Date(earliestReset).getTime();
                if (!isNaN(resetTimeMs) && resetTimeMs > Date.now()) {
                    const retryAfterMs = resetTimeMs - Date.now();
                    this.accountManager.setRateLimitWithResetTime(accountId, resetTimeMs, retryAfterMs, 'quota_exceeded', model);
                    return true;
                }
            }

            this.logger.warn(`Account ${accountId} quota fetched but no valid reset_time found`);
            return false;
        } catch (error) {
            this.logger.warn(`Failed to fetch realtime quota for ${accountId}:`, error);
            return false;
        }
    }

    /**
     * Clear all rate limits
     */
    async clearAllRateLimits(): Promise<void> {
        this.accountManager.clearAllRateLimits();
        await this.saveAccounts();
    }

    /**
     * Get the project ID (from first account for backward compatibility)
     */
    getProjectId(): string | null {
        const accounts = this.accountManager.getAccounts();
        return accounts[0]?.projectId ?? null;
    }

    /**
     * Get the user email (from first account for backward compatibility)
     */
    getEmail(): string | null {
        const accounts = this.accountManager.getAccounts();
        return accounts[0]?.email ?? null;
    }

    /**
     * Get account count
     */
    getAccountCount(): number {
        return this.accountManager.getAccountCount();
    }

    /**
     * Get all accounts info for display
     * Uses quota data for accurate rate limit status
     */
    getAccountsInfo(): Array<{
        index: number;
        email?: string;
        projectId: string;
        isRateLimited?: boolean;
        rateLimitResetAt?: number;
        quota?: QuotaData;
        subscriptionTier?: string;
    }> {
        // Cleanup rate limits using quota data
        this.accountManager.cleanupRateLimitsWithQuota();

        return this.accountManager.getAccounts().map(a => {
            const accountId = a.email || String(a.index);

            // Use quota-based availability check for accurate status
            const isAvailable = this.accountManager.isAccountAvailable(a);
            const isRateLimited = !isAvailable;

            // Get reset time from quota data or timer
            let rateLimitResetAt: number | undefined;
            if (isRateLimited) {
                // Try to get reset time from quota data first
                if (a.quota?.models && a.quota.models.length > 0) {
                    const earliestReset = a.quota.models
                        .filter(m => m.resetTime)
                        .map(m => new Date(m.resetTime).getTime())
                        .filter(t => !isNaN(t) && t > Date.now())
                        .sort((a, b) => a - b)[0];
                    rateLimitResetAt = earliestReset;
                }

                // Fall back to timer-based reset time
                if (!rateLimitResetAt) {
                    const resetSeconds = this.accountManager.getResetSeconds(accountId);
                    if (resetSeconds) {
                        rateLimitResetAt = Date.now() + resetSeconds * 1000;
                    }
                }
            }

            return {
                index: a.index,
                email: a.email,
                projectId: a.projectId,
                isRateLimited,
                rateLimitResetAt,
                quota: a.quota,
                subscriptionTier: a.subscriptionTier,
            };
        });
    }

    /**
     * Refresh quota and clear rate limits for accounts that have recovered
     * This is the proper way to clear rate limits - using real quota data
     *
     * @returns Number of rate limits cleared
     */
    async refreshAndClearRateLimits(): Promise<number> {
        this.logger.info('Refreshing quotas to check for recovered accounts...');
        await this.refreshAllQuotas();
        const cleared = this.accountManager.cleanupRateLimitsWithQuota();
        this.logger.info(`Cleared ${cleared} rate limit(s) based on refreshed quota data`);
        return cleared;
    }

    /**
     * Refresh quota for a specific account (internal, does not save)
     */
    private async refreshAccountQuotaInternal(account: ManagedAccount): Promise<QuotaData | undefined> {
        try {
            // Ensure we have a valid access token
            if (!account.accessToken || !account.expiresAt || isTokenExpired(account.expiresAt)) {
                await this.refreshAccountTokenInternal(account);
                await this.saveAccounts();
            }

            if (!account.accessToken) {
                this.logger.warn(`No access token for account ${account.index}, skipping quota refresh`);
                return undefined;
            }

            this.logger.info(`Fetching quota for account ${account.index} (${account.email || 'unknown'})...`);
            const quota = await fetchQuota(account.accessToken, account.projectId);
            account.quota = quota;
            // Update subscription tier for rotation priority
            if (quota.subscriptionTier) {
                account.subscriptionTier = quota.subscriptionTier;
                this.logger.info(`Account ${account.index} subscription tier: ${quota.subscriptionTier}`);
            } else {
                this.logger.debug(`Account ${account.index} subscription tier: (not available)`);
            }
            this.logger.info(`Got ${quota.models.length} model(s) for account ${account.index}`);
            return quota;
        } catch (error) {
            this.logger.warn(`Failed to refresh quota for account ${account.index} (${account.email || 'unknown'}):`, error);
            return undefined;
        }
    }

    /**
     * Refresh quota for a specific account
     */
    async refreshAccountQuota(account: ManagedAccount): Promise<QuotaData | undefined> {
        const quota = await this.refreshAccountQuotaInternal(account);
        await this.saveAccounts();
        return quota;
    }

    /**
     * Refresh quota for all accounts
     */
    async refreshAllQuotas(): Promise<void> {
        const accounts = this.accountManager.getAccounts();
        this.logger.info(`Refreshing quotas for ${accounts.length} account(s)...`);

        let successCount = 0;
        let modelKeysCached = false;
        for (const account of accounts) {
            const quota = await this.refreshAccountQuotaInternal(account);
            if (quota) {
                successCount++;
                // Cache dynamic model list from the first successful quota response
                if (!modelKeysCached && quota.availableModelKeys && quota.availableModelKeys.length > 0) {
                    const models = buildModelsFromApiKeys(quota.availableModelKeys);
                    setCachedModels(models);
                    modelKeysCached = true;
                    this.logger.info(`Cached ${models.length} models from ${quota.availableModelKeys.length} API keys`);
                }
            }
        }

        // Save all at once
        await this.saveAccounts();
        this.logger.info(`Finished refreshing quotas: ${successCount}/${accounts.length} succeeded`);
    }

    /**
     * Fetch available model keys from the API.
     * Refreshes quotas and returns the model keys from the first successful response.
     */
    async fetchAvailableModelKeys(): Promise<string[] | undefined> {
        const accounts = this.accountManager.getAccounts();
        for (const account of accounts) {
            const quota = await this.refreshAccountQuotaInternal(account);
            if (quota?.availableModelKeys && quota.availableModelKeys.length > 0) {
                await this.saveAccounts();
                return quota.availableModelKeys;
            }
        }
        await this.saveAccounts();
        return undefined;
    }

    // =========================================================================
    // Pending OAuth State Management
    // =========================================================================

    /**
     * Store pending OAuth verifier for code exchange
     */
    async storePendingVerifier(verifier: string): Promise<void> {
        await this.secrets.set(PENDING_VERIFIER_KEY, verifier);
    }

    /**
     * Get and clear pending OAuth verifier
     */
    async getPendingVerifier(): Promise<string | null> {
        const verifier = await this.secrets.get(PENDING_VERIFIER_KEY);
        if (verifier) {
            await this.secrets.delete(PENDING_VERIFIER_KEY);
        }
        return verifier ?? null;
    }

    /**
     * Store pending OAuth state for validation
     */
    async storePendingState(state: string): Promise<void> {
        await this.secrets.set(PENDING_STATE_KEY, state);
    }

    /**
     * Get pending OAuth state
     */
    async getPendingState(): Promise<string | null> {
        const state = await this.secrets.get(PENDING_STATE_KEY);
        return state ?? null;
    }

    /**
     * Clear pending OAuth state
     */
    async clearPendingState(): Promise<void> {
        await this.secrets.delete(PENDING_STATE_KEY);
        await this.secrets.delete(PENDING_VERIFIER_KEY);
    }
}
