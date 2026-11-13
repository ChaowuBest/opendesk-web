/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { Setting } from '../../../../utils/setting.js';
import { DimMismatchError } from '../../../../services/storage/abstract-storage.js';
import { getStorageInitializationFailure } from '../../../../services/storage/platform.js';
import type {
    FilterCondition,
    SemanticWriteAvailability,
    SemanticWriteState
} from '../../../../services/storage/abstract-storage.js';
import type {
    EmbeddingErrorKind,
    EmbeddingFailure,
    EmbeddingState,
    EmbeddingStateAccess,
    InitializationRecovery,
    RetrievalAccess,
    RetrievalMode,
    RuntimeState,
    StorageAssembly
} from '../contract.js';

export function initializationRecovery(error: unknown): InitializationRecovery {
    const failure = getStorageInitializationFailure(error);
    if (failure?.operation === 'close' || failure?.operation === 'delete' || failure?.cleanupFailures.length)
        return null;
    if (error instanceof DimMismatchError) return 'compatibility';
    if (!failure) return null;
    const seen = new Set<object>();
    let current: unknown = error;
    while (current !== null && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        const details = current as { code?: unknown; details?: { sdkErrorCode?: unknown }; cause?: unknown };
        if (details.code === 'store_close_failed') return null;
        const corrupt =
            failure.backend === 'native'
                ? /^SQLITE_CORRUPT(?:_[A-Z0-9]+)*$/.test(String(details.code ?? ''))
                : failure.backend === 'arkdata' &&
                  (String(details.code) === '14800011' || String(details.details?.sdkErrorCode) === '14800011');
        if (corrupt) {
            if (failure.indexer === 'BaseIndexer') return 'full';
            return failure.indexer === 'VectorIndexer' || failure.indexer === 'ChunkIndexer' ? 'semantic' : null;
        }
        current = details.cause;
    }
    return null;
}

interface ErrorDetails {
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    name?: unknown;
    code?: unknown;
    type?: unknown;
    error?: ErrorDetails;
    cause?: ErrorDetails;
    response?: { status?: unknown; data?: { error?: ErrorDetails } };
    body?: { error?: ErrorDetails };
}

interface EmbeddingErrorRule {
    kind: EmbeddingErrorKind;
    code: string;
    match: 'status' | 'pattern' | 'status+pattern';
    statuses?: number[];
    patterns?: RegExp[];
}

type LegacyEmbeddingState = Partial<EmbeddingState> & {
    probe_permanent_error?: { ts?: number };
};

export function defaultEmbeddingState(): EmbeddingState {
    return {
        embedding_generation: 0,
        semantic_reset_pending: false,
        vec_dim: null,
        embedding_model: null,
        vector_backend: null,
        chunk_backend: null,
        last_embedding_task_at: null,
        chunk_level: null,
        embedding_request_dim: null,
        _requestDimResolved: false,
        embedded_migrated: false,
        probe_error: null,
        last_rebuild_event: null
    };
}

export function normalizeSavedEmbeddingState(
    state: EmbeddingState & LegacyEmbeddingState,
    parsed: LegacyEmbeddingState
): void {
    // Older failed rebuilds have no completion marker. Conservatively
    // finish their semantic cleanup before reusing the stored model.
    if (parsed.semantic_reset_pending === undefined) {
        state.semantic_reset_pending =
            parsed.last_rebuild_event?.status === 'failed' &&
            ['vector', 'full'].includes(parsed.last_rebuild_event?.type);
    }
    // Old state used one backend for both semantic stores. Preserve
    // that meaning; newly opened storage records each actual fallback.
    if (parsed.chunk_backend === undefined) state.chunk_backend = state.vector_backend;
    if (state.chunk_backend !== null && typeof state.chunk_backend !== 'string') {
        throw new Error('invalid chunk_backend field');
    }
    if (typeof state.semantic_reset_pending !== 'boolean') {
        throw new Error('invalid semantic_reset_pending field');
    }
    if (state.probe_error === null && parsed.probe_permanent_error) {
        state.probe_error = {
            code: 'embedding_config_error',
            ts: parsed.probe_permanent_error.ts ?? Date.now()
        };
    }
    delete state.probe_permanent_error;
    if (!Number.isSafeInteger(state.embedding_generation) || state.embedding_generation < 0) {
        throw new Error('invalid embedding_generation field');
    }
    if (state.vec_dim !== null && typeof state.vec_dim !== 'number') {
        throw new Error('invalid vec_dim field');
    }
    if (state.embedding_model !== null && typeof state.embedding_model !== 'string') {
        throw new Error('invalid embedding_model field');
    }
    if (state.last_embedding_task_at !== null && typeof state.last_embedding_task_at !== 'number') {
        throw new Error('invalid last_embedding_task_at field');
    }
    if (state.chunk_level !== null && typeof state.chunk_level !== 'string') {
        throw new Error('invalid chunk_level field');
    }
    if (state.embedding_request_dim !== null && typeof state.embedding_request_dim !== 'number') {
        throw new Error('invalid embedding_request_dim field');
    }
    if (typeof state._requestDimResolved !== 'boolean') {
        throw new Error('invalid _requestDimResolved field');
    }
    if (
        state.probe_error !== null &&
        (!state.probe_error || typeof state.probe_error !== 'object' || typeof state.probe_error.code !== 'string')
    ) {
        throw new Error('invalid probe_error field');
    }
}

// ── Embedding helpers ──────────────────────────────────────────────
function safeStringify(value: unknown) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function normalizeEmbeddingError(value: unknown) {
    const err = value as ErrorDetails | null | undefined;
    const status = Number(
        err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.cause?.status ?? err?.error?.status
    );
    const normalizedStatus = Number.isFinite(status) ? status : null;
    const messageParts = [
        err?.message,
        err?.name,
        err?.code,
        err?.type,
        err?.error?.message,
        err?.error?.code,
        err?.error?.type,
        err?.response?.data?.error?.message,
        err?.response?.data?.error?.code,
        err?.response?.data?.error?.type,
        err?.body?.error?.message,
        err?.body?.error?.code,
        err?.body?.error?.type,
        safeStringify(err?.response?.data),
        safeStringify(err?.body)
    ].filter(Boolean);
    const message = messageParts.join(' ');
    return {
        status: normalizedStatus,
        message,
        haystack: `${normalizedStatus ?? ''} ${message}`.toLowerCase()
    };
}

const EMBEDDING_ERROR_RULES: EmbeddingErrorRule[] = [
    {
        kind: 'quota',
        code: 'quota_exceeded',
        match: 'pattern',
        patterns: [
            /quota/i,
            /monthly limit/i,
            /key limit/i,
            /insufficient balance/i,
            /insufficient credit/i,
            /billing/i,
            /余额/,
            /额度/,
            /欠费/
        ]
    },
    { kind: 'quota', code: 'quota_exceeded', match: 'status', statuses: [402] },
    { kind: 'config', code: 'invalid_api_key', match: 'status', statuses: [401] },
    {
        kind: 'config',
        code: 'invalid_api_key',
        match: 'pattern',
        patterns: [/invalid api key/i, /unauthorized/i, /authentication/i, /invalid token/i]
    },
    { kind: 'config', code: 'model_not_found', match: 'status', statuses: [404] },
    {
        kind: 'config',
        code: 'invalid_model',
        match: 'status+pattern',
        statuses: [400],
        patterns: [
            /invalid model/i,
            /unsupported model/i,
            /model not found/i,
            /model does not exist/i,
            /unknown model/i,
            /invalid provider/i
        ]
    },
    { kind: 'file', code: 'payload_too_large', match: 'status', statuses: [413, 422] },
    {
        kind: 'file',
        code: 'payload_too_large',
        match: 'status+pattern',
        statuses: [400],
        patterns: [
            /payload too large/i,
            /request too large/i,
            /input too long/i,
            /maximum context/i,
            /context length/i,
            /too many tokens/i,
            /token limit/i,
            /invalid input/i,
            /empty input/i
        ]
    },
    {
        kind: 'transient',
        code: 'rate_limited',
        match: 'status',
        statuses: [408, 409, 425, 429, 500, 502, 503, 504]
    },
    {
        kind: 'transient',
        code: 'network_error',
        match: 'pattern',
        patterns: [
            /rate limit/i,
            /too many requests/i,
            /timeout/i,
            /temporarily unavailable/i,
            /overloaded/i,
            /server error/i,
            /econnreset/i,
            /etimedout/i,
            /enotfound/i,
            /econnrefused/i,
            /fetch failed/i,
            /network/i,
            /terminated/i
        ]
    }
];

function embeddingErrorRuleMatches(rule: EmbeddingErrorRule, evidence: ReturnType<typeof normalizeEmbeddingError>) {
    const statusMatches =
        Array.isArray(rule.statuses) && evidence.status !== null && rule.statuses.includes(evidence.status);
    const patternMatches =
        Array.isArray(rule.patterns) && rule.patterns.some((pattern) => pattern.test(evidence.haystack));
    if (rule.match === 'status') return statusMatches;
    if (rule.match === 'pattern') return patternMatches;
    if (rule.match === 'status+pattern') return statusMatches && patternMatches;
    return false;
}

export function classifyEmbeddingError(value: unknown): EmbeddingFailure {
    const err = value as ErrorDetails | null | undefined;
    const evidence = normalizeEmbeddingError(err);
    const rule = EMBEDDING_ERROR_RULES.find((candidate) => embeddingErrorRuleMatches(candidate, evidence));
    const kind = rule?.kind ?? 'unknown';
    return {
        kind,
        code: rule?.code ?? 'unknown',
        retryable: kind === 'transient' || kind === 'unknown',
        scope: kind === 'file' ? 'file' : 'global',
        status: evidence.status,
        message: err?.message ?? evidence.message ?? ''
    };
}

const TRANSIENT_PROBE_PATTERN = /terminated|socket hang up|ECONNRESET|ETIMEDOUT|fetch failed|timed out|network/i;

export function isTransientNetworkError(err: unknown) {
    const evidence = normalizeEmbeddingError(err);
    return evidence.status === null && TRANSIENT_PROBE_PATTERN.test(evidence.haystack);
}

export function normalizeSemanticWriteState(state: SemanticWriteState | null | undefined) {
    const normalize = (availability: SemanticWriteAvailability | undefined) => ({
        ...availability,
        acceptingWrites: availability?.acceptingWrites !== false
    });
    return {
        vector: normalize(state?.vector),
        chunk: normalize(state?.chunk)
    };
}

export function currentModelName(): string {
    return Setting.getInstance().getDefaultEmbeddingModelInstance()!.model_name;
}

export function completedFileConditions({
    requireEmbedded = false,
    embeddingGeneration
}: {
    requireEmbedded?: boolean;
    embeddingGeneration?: number;
}): FilterCondition[] {
    return [
        ...(requireEmbedded ? [{ indexer: 'BaseIndexer', field: 'embedded', operator: '=' as const, value: 1 }] : []),
        ...(requireEmbedded && embeddingGeneration !== undefined
            ? [
                  {
                      indexer: 'BaseIndexer',
                      field: 'embedding_generation',
                      operator: '=' as const,
                      value: embeddingGeneration
                  }
              ]
            : [])
    ];
}

export async function setProbeError(access: EmbeddingStateAccess, code: string) {
    const error = { code, ts: Date.now() };
    const prev = access.readState().probe_error;
    if (prev && prev.code === error.code) return;
    access.readState().probe_error = error;
    await access.saveState();
    access.notifyStateChanged();
}

export async function clearProbeError(access: EmbeddingStateAccess) {
    if (access.readState().probe_error === null) return;
    access.readState().probe_error = null;
    await access.saveState();
    access.notifyStateChanged();
}

export function baseAssembly(state: EmbeddingState, fresh = false): StorageAssembly {
    return { dim: fresh ? 1024 : (state.vec_dim ?? 1024), mode: 'base-only' };
}
export function fullResetPatch(openFailed: boolean): Partial<EmbeddingState> {
    const cleared = { vec_dim: null, embedding_model: null, vector_backend: null, chunk_backend: null };
    return openFailed
        ? cleared
        : { ...cleared, chunk_level: null, embedded_migrated: false, last_embedding_task_at: null };
}
export function rootGroupCounts(
    state: EmbeddingState,
    mode: RetrievalMode,
    values: Record<string, unknown>,
    count: number
) {
    const current =
        !state.semantic_reset_pending && (values.embedding_generation ?? 0) === (state.embedding_generation ?? 0);
    return {
        embedded_count:
            mode !== 'base-only' && current && (values.embedded === 1 || values.embedded === true) ? count : 0,
        failed_count: mode !== 'base-only' && current && values.embedded === -2 ? count : 0
    };
}
export function globalGroupEmbedded(state: EmbeddingState, values: Record<string, unknown>, count: number) {
    return !state.semantic_reset_pending &&
        values.embedded === 1 &&
        (values.embedding_generation ?? 0) === (state.embedding_generation ?? 0)
        ? count
        : 0;
}
export function runtimeState(access: Pick<RetrievalAccess, 'readState' | 'mode' | 'data'>): RuntimeState {
    const state = access.readState();
    const mode = access.mode();
    return {
        mode,
        available: Boolean(access.data('read') && mode === 'full' && !state.semantic_reset_pending),
        resetPending: state.semantic_reset_pending,
        probeError: state.probe_error,
        lastEmbeddingTaskAt: state.last_embedding_task_at,
        get modelConfigured() {
            return Boolean(Setting.getInstance().getDefaultEmbeddingModelInstance());
        },
        get baseOnlyAlert() {
            if (state.probe_error)
                return state.probe_error.code === 'dim_unsupported' ? 'dim_unsupported' : 'embedding_unavailable';
            return Setting.getInstance().getDefaultEmbeddingModelInstance()
                ? 'embedding_pending'
                : 'embed_model_missing';
        }
    };
}
