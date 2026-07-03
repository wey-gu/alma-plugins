/**
 * Model catalog for xAI Grok.
 *
 * A static fallback list keeps the provider usable offline; fetchModels()
 * pulls the live catalog from api.x.ai and caches it here for the session.
 */

export interface XaiModel {
    id: string;
    name: string;
    description?: string;
    contextWindow: number;
    maxOutputTokens: number;
    reasoning: boolean;
    vision: boolean;
}

// Fallback catalog (context/output limits from models.dev, July 2026).
const FALLBACK_MODELS: XaiModel[] = [
    {
        id: 'grok-4.3',
        name: 'Grok 4.3',
        description: 'Flagship reasoning model',
        contextWindow: 1_000_000,
        maxOutputTokens: 30_000,
        reasoning: true,
        vision: true,
    },
    {
        id: 'grok-4.20-0309-reasoning',
        name: 'Grok 4.20 (Reasoning)',
        contextWindow: 1_000_000,
        maxOutputTokens: 30_000,
        reasoning: true,
        vision: true,
    },
    {
        id: 'grok-4.20-0309-non-reasoning',
        name: 'Grok 4.20 (Non-Reasoning)',
        contextWindow: 1_000_000,
        maxOutputTokens: 30_000,
        reasoning: false,
        vision: true,
    },
    {
        id: 'grok-build-0.1',
        name: 'Grok Build 0.1',
        description: 'Agentic coding model',
        contextWindow: 256_000,
        maxOutputTokens: 256_000,
        reasoning: true,
        vision: true,
    },
];

let cachedModels: XaiModel[] | null = null;

export function getActiveModels(): XaiModel[] {
    return cachedModels ?? FALLBACK_MODELS;
}

export function setCachedModels(models: XaiModel[]): void {
    if (models.length > 0) {
        cachedModels = models;
    }
}

// ============================================================================
// Live catalog parsing
// ============================================================================

/** Media/embedding models can't back a chat provider — drop them. */
function isChatModelId(id: string): boolean {
    return !/imagine|image|video|embed|tts|whisper/i.test(id);
}

function titleCase(id: string): string {
    return id
        .split('-')
        .map(part => (part.match(/^\d/) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join(' ');
}

function readNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return value;
        }
    }
    return undefined;
}

/**
 * Build models from GET /v1/language-models (rich metadata) or
 * GET /v1/models (bare OpenAI-style list). Field names are read defensively
 * since xAI has evolved this schema over time.
 */
export function buildModelsFromApiResponse(data: unknown): XaiModel[] {
    const root = data as { models?: unknown[]; data?: unknown[] } | null;
    const rawList = Array.isArray(root?.models) ? root.models : Array.isArray(root?.data) ? root.data : [];

    const models: XaiModel[] = [];
    for (const raw of rawList) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as Record<string, unknown>;
        const id = typeof entry.id === 'string' ? entry.id : undefined;
        if (!id || !isChatModelId(id)) continue;

        const inputModalities = Array.isArray(entry.input_modalities) ? (entry.input_modalities as unknown[]) : null;
        const outputModalities = Array.isArray(entry.output_modalities) ? (entry.output_modalities as unknown[]) : null;
        // When modality metadata exists, require text-in/text-out.
        if (inputModalities && !inputModalities.includes('text')) continue;
        if (outputModalities && !outputModalities.includes('text')) continue;

        models.push({
            id,
            name: titleCase(id),
            contextWindow: readNumber(entry, ['context_window', 'max_prompt_length', 'context_length']) ?? 256_000,
            maxOutputTokens: readNumber(entry, ['max_output_tokens', 'max_completion_tokens']) ?? 30_000,
            reasoning: !/non-reasoning/i.test(id),
            vision: inputModalities ? inputModalities.includes('image') : true,
        });
    }
    return models;
}
