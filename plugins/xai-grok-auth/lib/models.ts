/**
 * Model catalog for xAI Grok.
 *
 * A static fallback list keeps the provider usable offline; fetchModels()
 * pulls the live catalog from api.x.ai and caches it here for the session.
 *
 * Note xAI splits its catalog across endpoints: /v1/language-models lists
 * only text-output chat models, while image generation models live on
 * /v1/image-generation-models (verified live with a SuperGrok OAuth token).
 */

export interface XaiModel {
    id: string;
    name: string;
    description?: string;
    contextWindow: number;
    maxOutputTokens?: number;
    reasoning: boolean;
    vision: boolean;
    /** Dedicated image generation model (served by /v1/images/generations) */
    imageOutput: boolean;
}

// Fallback catalog (context/output limits from models.dev + live API, July 2026).
//
// Keep current flagship chat models here even though the live catalog also
// returns them: a cold start serves this list until a live fetch populates the
// in-memory cache, and any *enabled* model missing from it gets all-false
// capabilities from the app (functionCalling:false), which silently hides the
// composer's Project/Tools/Skills row. See initialize() in main.ts.
const FALLBACK_MODELS: XaiModel[] = [
    {
        id: 'grok-4.5',
        name: 'Grok 4.5',
        description: 'Flagship reasoning model',
        contextWindow: 2_000_000,
        maxOutputTokens: 30_000,
        reasoning: true,
        vision: true,
        imageOutput: false,
    },
    {
        id: 'grok-4.3',
        name: 'Grok 4.3',
        description: 'Flagship reasoning model',
        contextWindow: 1_000_000,
        maxOutputTokens: 30_000,
        reasoning: true,
        vision: true,
        imageOutput: false,
    },
    {
        id: 'grok-4.20-0309-reasoning',
        name: 'Grok 4.20 (Reasoning)',
        contextWindow: 1_000_000,
        maxOutputTokens: 30_000,
        reasoning: true,
        vision: true,
        imageOutput: false,
    },
    {
        id: 'grok-4.20-0309-non-reasoning',
        name: 'Grok 4.20 (Non-Reasoning)',
        contextWindow: 1_000_000,
        maxOutputTokens: 30_000,
        reasoning: false,
        vision: true,
        imageOutput: false,
    },
    {
        id: 'grok-build-0.1',
        name: 'Grok Build 0.1',
        description: 'Agentic coding model',
        contextWindow: 256_000,
        maxOutputTokens: 256_000,
        reasoning: true,
        vision: true,
        imageOutput: false,
    },
    {
        id: 'grok-imagine-image',
        name: 'Grok Imagine (Image)',
        description: 'Image generation and image-to-image editing',
        contextWindow: 8_000,
        reasoning: false,
        vision: true,
        imageOutput: true,
    },
    {
        id: 'grok-imagine-image-quality',
        name: 'Grok Imagine (Image, Quality)',
        description: 'Higher-quality image generation and editing',
        contextWindow: 8_000,
        reasoning: false,
        vision: true,
        imageOutput: true,
    },
];

// Callable via SuperGrok OAuth on api.x.ai but deliberately omitted from
// models.dev, /v1/models AND /v1/language-models (verified live 2026-07-03;
// discovery credit: hermes-agent PR #47908). Merged into every catalog since
// no live fetch will ever return them.
const CURATED_EXTRAS: XaiModel[] = [
    {
        id: 'grok-composer-2.5-fast',
        name: 'Grok Composer 2.5 Fast',
        description: 'Grok Build CLI coding model (hidden from xAI catalogs; tuned for agent harnesses)',
        contextWindow: 200_000,
        reasoning: false,
        vision: false,
        imageOutput: false,
    },
];

/** Append curated extras, slotting them right after grok-build when present. */
function mergeCuratedExtras(models: XaiModel[]): XaiModel[] {
    const out = [...models];
    for (const extra of CURATED_EXTRAS) {
        if (out.some(m => m.id === extra.id)) continue;
        const buildIdx = out.findIndex(m => m.id.startsWith('grok-build'));
        out.splice(buildIdx >= 0 ? buildIdx + 1 : out.length, 0, extra);
    }
    return out;
}

let cachedModels: XaiModel[] | null = null;

export function getActiveModels(): XaiModel[] {
    return mergeCuratedExtras(cachedModels ?? FALLBACK_MODELS);
}

export function setCachedModels(models: XaiModel[]): void {
    if (models.length > 0) {
        cachedModels = models;
    }
}

/**
 * Whether a live/persisted catalog has been loaded into the in-memory cache.
 * When false, getActiveModels() is serving the bundled FALLBACK_MODELS snapshot,
 * so callers should hydrate from persisted storage before trusting the list.
 */
export function isCatalogCached(): boolean {
    return cachedModels !== null;
}

// ============================================================================
// Live catalog parsing
// ============================================================================

/**
 * Models we can't drive from a chat provider at all: video generation,
 * embeddings, speech. Image generation IS supported (routed to
 * /v1/images/generations by Alma), so imagine-image stays.
 */
function isSupportedModelId(id: string): boolean {
    return !/video|embed|tts|whisper/i.test(id);
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
 * Build models from xAI catalog endpoints:
 * - GET /v1/language-models        (rich metadata, text models)
 * - GET /v1/image-generation-models (rich metadata, image models)
 * - GET /v1/models                 (bare OpenAI-style list, mixed)
 * Field names are read defensively since xAI has evolved this schema.
 */
export function buildModelsFromApiResponse(data: unknown): XaiModel[] {
    const root = data as { models?: unknown[]; data?: unknown[] } | null;
    const rawList = Array.isArray(root?.models) ? root.models : Array.isArray(root?.data) ? root.data : [];

    const models: XaiModel[] = [];
    for (const raw of rawList) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as Record<string, unknown>;
        const id = typeof entry.id === 'string' ? entry.id : undefined;
        if (!id || !isSupportedModelId(id)) continue;

        const inputModalities = Array.isArray(entry.input_modalities) ? (entry.input_modalities as unknown[]) : null;
        const outputModalities = Array.isArray(entry.output_modalities) ? (entry.output_modalities as unknown[]) : null;

        // Image output: from modality metadata when present, name heuristic
        // for the bare /v1/models list.
        const imageOutput = outputModalities ? outputModalities.includes('image') : /imagine-image/i.test(id);

        // Text-capable check only applies to non-image models.
        if (!imageOutput) {
            if (inputModalities && !inputModalities.includes('text')) continue;
            if (outputModalities && !outputModalities.includes('text')) continue;
        }

        models.push({
            id,
            name: titleCase(id),
            contextWindow: readNumber(entry, ['context_window', 'max_prompt_length', 'context_length']) ?? (imageOutput ? 8_000 : 256_000),
            maxOutputTokens: imageOutput ? undefined : (readNumber(entry, ['max_output_tokens', 'max_completion_tokens']) ?? 30_000),
            reasoning: !imageOutput && !/non-reasoning/i.test(id),
            vision: inputModalities ? inputModalities.includes('image') : true,
            imageOutput,
        });
    }
    return models;
}
