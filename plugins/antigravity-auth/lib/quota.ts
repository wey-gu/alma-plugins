/**
 * Quota API for fetching real quota data from Google Cloud Code API.
 * This mirrors the implementation in Antigravity-Manager.
 */

const CLOUD_CODE_BASE_URL = 'https://cloudcode-pa.googleapis.com';
const QUOTA_API_URL = `${CLOUD_CODE_BASE_URL}/v1internal:fetchAvailableModels`;
const LOAD_CODE_ASSIST_URL = `${CLOUD_CODE_BASE_URL}/v1internal:loadCodeAssist`;

interface QuotaInfo {
    remainingFraction?: number;
    resetTime?: string;
}

interface ModelInfo {
    quotaInfo?: QuotaInfo;
}

interface QuotaResponse {
    models: Record<string, ModelInfo>;
}

interface Tier {
    id?: string;
    quotaTier?: string;
    name?: string;
    slug?: string;
}

interface LoadProjectResponse {
    cloudaicompanionProject?: string;
    currentTier?: Tier;
    paidTier?: Tier;
}

// Subscription tier - pass through whatever the API returns (matches Antigravity-Manager)
export type SubscriptionTier = string;

export interface ModelQuota {
    name: string;
    percentage: number;
    resetTime: string;
}

export interface QuotaData {
    models: ModelQuota[];
    lastUpdated: number;
    subscriptionTier?: SubscriptionTier;
}

/**
 * Fetch subscription tier from loadCodeAssist API.
 * This is used for account rotation priority.
 * @param accessToken - Valid OAuth access token
 * @returns Subscription tier ID or undefined
 */
async function fetchSubscriptionTier(accessToken: string): Promise<SubscriptionTier | undefined> {
    try {
        const response = await fetch(LOAD_CODE_ASSIST_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'antigravity/1.18.3 windows/amd64',
            },
            body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
        });

        if (!response.ok) {
            return undefined;
        }

        const data: LoadProjectResponse = await response.json();

        // Priority: paidTier > currentTier (matches Antigravity-Manager logic)
        // Pass through whatever the API returns
        const tierId = data.paidTier?.id ?? data.currentTier?.id;

        return tierId;
    } catch {
        return undefined;
    }
}

/**
 * Fetch quota data from the Google Cloud Code API.
 * @param accessToken - Valid OAuth access token
 * @param projectId - Antigravity project ID
 * @returns QuotaData with model quotas and subscription tier
 */
export async function fetchQuota(accessToken: string, projectId: string): Promise<QuotaData> {
    // Fetch subscription tier and quota in parallel
    const [subscriptionTier, quotaResponse] = await Promise.all([
        fetchSubscriptionTier(accessToken),
        fetch(QUOTA_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'antigravity/1.18.3 Darwin/arm64',
            },
            body: JSON.stringify({ project: projectId }),
        }),
    ]);

    if (!quotaResponse.ok) {
        const errorText = await quotaResponse.text().catch(() => '');
        throw new Error(`Quota API error: ${quotaResponse.status} - ${errorText}`);
    }

    const data: QuotaResponse = await quotaResponse.json();
    const models: ModelQuota[] = [];

    for (const [name, info] of Object.entries(data.models)) {
        if (info.quotaInfo && (name.includes('gemini') || name.includes('claude'))) {
            models.push({
                name,
                percentage: Math.round((info.quotaInfo.remainingFraction ?? 0) * 100),
                resetTime: info.quotaInfo.resetTime ?? '',
            });
        }
    }

    // Sort models by name for consistent display
    models.sort((a, b) => a.name.localeCompare(b.name));

    return {
        models,
        lastUpdated: Date.now(),
        subscriptionTier,
    };
}
