/**
 * Cursor model discovery via GetUsableModels gRPC endpoint.
 * Uses Node.js http2 for transport. Falls back to hardcoded list on failure.
 */

import * as http2 from 'node:http2';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
    GetUsableModelsRequestSchema,
    GetUsableModelsResponseSchema,
} from '../proto/agent_pb';
import type { CursorModel } from './types';

const CURSOR_BASE_URL = 'https://api2.cursor.sh';
const CURSOR_CLIENT_VERSION = 'cli-2026.02.13-41ac335';
const GET_USABLE_MODELS_PATH = '/agent.v1.AgentService/GetUsableModels';

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

// --- Hardcoded fallback models ---

const FALLBACK_MODELS: CursorModel[] = [
    { id: 'composer-2', name: 'Composer 2', reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
    { id: 'claude-4-sonnet', name: 'Claude 4 Sonnet', reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
    { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', reasoning: false, contextWindow: 200_000, maxTokens: 8_192 },
    { id: 'gpt-4o', name: 'GPT-4o', reasoning: false, contextWindow: 128_000, maxTokens: 16_384 },
    { id: 'cursor-small', name: 'Cursor Small', reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536 },
];

/**
 * Get cursor models: try dynamic discovery, fall back to hardcoded list.
 */
export async function getCursorModels(apiKey: string): Promise<CursorModel[]> {
    const discovered = await fetchCursorUsableModels(apiKey);
    return discovered && discovered.length > 0 ? discovered : FALLBACK_MODELS;
}

export function getFallbackModels(): CursorModel[] {
    return FALLBACK_MODELS;
}

/**
 * Fetch models from Cursor's GetUsableModels gRPC endpoint using Node.js http2.
 */
async function fetchCursorUsableModels(apiKey: string): Promise<CursorModel[] | null> {
    try {
        const requestPayload = create(GetUsableModelsRequestSchema, {});
        const body = toBinary(GetUsableModelsRequestSchema, requestPayload);

        const responseBuffer = await fetchViaHttp2(body, apiKey);
        if (!responseBuffer) return null;

        const decoded = decodeGetUsableModelsResponse(responseBuffer);
        if (!decoded) return null;

        const models = (decoded as any).models;
        if (!Array.isArray(models) || models.length === 0) return null;

        return normalizeModels(models);
    } catch {
        return null;
    }
}

function fetchViaHttp2(body: Uint8Array, apiKey: string): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
        const client = http2.connect(CURSOR_BASE_URL);
        const chunks: Buffer[] = [];
        let statusOk = false;

        const timeout = setTimeout(() => {
            client.destroy();
            resolve(null);
        }, 5000);

        client.on('error', () => {
            clearTimeout(timeout);
            resolve(null);
        });

        const stream = client.request({
            ':method': 'POST',
            ':path': GET_USABLE_MODELS_PATH,
            'content-type': 'application/proto',
            'te': 'trailers',
            'authorization': `Bearer ${apiKey}`,
            'x-ghost-mode': 'true',
            'x-cursor-client-version': CURSOR_CLIENT_VERSION,
            'x-cursor-client-type': 'cli',
        });

        // Check HTTP/2 response status (matching opencode-cursor's curl status check)
        stream.on('response', (headers) => {
            const status = headers[':status'];
            statusOk = typeof status === 'number' && status >= 200 && status < 300;
        });

        stream.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });

        stream.on('end', () => {
            clearTimeout(timeout);
            client.close();
            if (!statusOk) { resolve(null); return; }
            const result = Buffer.concat(chunks);
            resolve(new Uint8Array(result));
        });

        stream.on('error', () => {
            clearTimeout(timeout);
            client.close();
            resolve(null);
        });

        stream.write(body);
        stream.end();
    });
}

function decodeGetUsableModelsResponse(payload: Uint8Array): unknown {
    if (payload.length === 0) return null;

    // Try Connect framing first (5-byte header)
    const framedBody = decodeConnectUnaryBody(payload);
    if (framedBody) {
        try {
            return fromBinary(GetUsableModelsResponseSchema, framedBody);
        } catch {
            // fall through
        }
    }

    // Raw protobuf
    try {
        return fromBinary(GetUsableModelsResponseSchema, payload);
    } catch {
        return null;
    }
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
    if (payload.length < 5) return null;

    let offset = 0;
    while (offset + 5 <= payload.length) {
        const flags = payload[offset]!;
        const view = new DataView(
            payload.buffer,
            payload.byteOffset + offset,
            payload.byteLength - offset,
        );
        const messageLength = view.getUint32(1, false);
        const frameEnd = offset + 5 + messageLength;
        if (frameEnd > payload.length) return null;

        if ((flags & 0b0000_0001) !== 0) return null; // Compression not supported
        if (!((flags & 0b0000_0010) !== 0)) {
            return payload.subarray(offset + 5, frameEnd);
        }

        offset = frameEnd;
    }

    return null;
}

function normalizeModels(models: unknown[]): CursorModel[] {
    const byId = new Map<string, CursorModel>();
    for (const model of models) {
        const normalized = normalizeSingleModel(model);
        if (normalized) byId.set(normalized.id, normalized);
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeSingleModel(model: unknown): CursorModel | null {
    if (!model || typeof model !== 'object') return null;
    const m = model as Record<string, unknown>;
    const id = typeof m.modelId === 'string' ? m.modelId.trim() : '';
    if (!id) return null;

    const name = pickDisplayName(m, id);
    const reasoning = Boolean(m.thinkingDetails);

    return {
        id,
        name,
        reasoning,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
    };
}

function pickDisplayName(model: Record<string, unknown>, fallbackId: string): string {
    const candidates = [
        model.displayName,
        model.displayNameShort,
        model.displayModelId,
    ];

    const aliases = model.aliases;
    if (Array.isArray(aliases)) {
        candidates.push(...aliases);
    }

    candidates.push(fallbackId);

    for (const candidate of candidates) {
        if (typeof candidate === 'string') {
            const trimmed = candidate.trim();
            if (trimmed) return trimmed;
        }
    }
    return fallbackId;
}
