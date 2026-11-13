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

import type { BaseStorage } from '../../../services/storage/abstract-storage.js';
export type { Item } from '../../../services/storage/abstract-storage.js';

export interface RebuildEvent {
    type: 'full' | 'vector';
    reason: string;
    status: 'completed' | 'failed';
    ts: number;
    message?: string;
}

export interface EmbeddingState {
    embedding_generation: number;
    semantic_reset_pending: boolean;
    vec_dim: number | null;
    embedding_model: string | null;
    vector_backend: string | null;
    chunk_backend: string | null;
    last_embedding_task_at: number | null;
    chunk_level: string | null;
    embedding_request_dim: number | null;
    _requestDimResolved: boolean;
    embedded_migrated: boolean;
    probe_error: { code: string; ts: number } | null;
    last_rebuild_event: RebuildEvent | null;
}

export type EmbeddingErrorKind = 'quota' | 'config' | 'file' | 'transient' | 'unknown';

export interface EmbeddingFailure {
    kind: EmbeddingErrorKind;
    code: string;
    retryable: boolean;
    scope: 'file' | 'global';
    status: number | null;
    message: unknown;
}

export type RetrievalMode = 'full' | 'base-only';
export type InitializationRecovery = 'full' | 'semantic' | 'compatibility' | null;

export type RetrievalData = Pick<
    BaseStorage,
    | 'search'
    | 'searchScope'
    | 'searchVectorMeta'
    | 'upsert'
    | 'update'
    | 'delete'
    | 'clearIndexerForItem'
    | 'countGrouped'
    | 'getStatus'
    | 'getSemanticBackends'
    | 'getSemanticWriteState'
    | 'probeBaseIndexStore'
    | 'probeIndexers'
> & { readonly identity: object };

export interface EmbeddingStateAccess {
    readState(): EmbeddingState;
    saveState(): Promise<void>;
    writeStateSnapshot(patch: Partial<EmbeddingState>, commit: () => void): Promise<void>;
    invalidateCounts(): void;
    notifyStateChanged(): void;
}

export interface RetrievalAccess extends EmbeddingStateAccess {
    data(intent?: 'read' | 'write'): RetrievalData | null;
    mode(): RetrievalMode;
}

export interface EmbeddingChunk {
    id: string;
    text: string;
}

export const CODES = {
    EMBED_UNAVAILABLE: 'EMBED_UNAVAILABLE',
    EMBED_API_DOWN: 'EMBED_API_DOWN',
    INDEX_NOT_READY: 'INDEX_NOT_READY',
    SEMANTIC_PARTIAL: 'SEMANTIC_PARTIAL',
    SEARCH_FAILED: 'SEARCH_FAILED',
    SEARCH_PARTIAL: 'SEARCH_PARTIAL',
    INVALID_SCOPE: 'INVALID_SCOPE'
};

export type FileSearchScope = { type: 'path'; path: string } | { type: 'paths'; paths: string[] };
export interface RetrievalSearchOptions {
    topK?: number;
    scope?: FileSearchScope;
}
export interface RetrievalSearchResult<T = unknown> {
    query: string;
    results: T[];
    totalHits: number;
    warning?: string;
    code?: string;
}
export interface SemanticSearchContext {
    storage: object;
    generation: number;
    model: string | null;
    dim: number | null;
    chunkLevel: string | null;
    vectorBackend: string | null;
    chunkBackend: string | null;
}
export interface RetrievalSearchAccess extends RetrievalAccess {
    formatSearchResult<T>(query: string, results: T[], totalHits: number, code?: string): RetrievalSearchResult<T>;
}

export interface ProbeOptions {
    probeTimeoutMs?: number;
    probeRetries?: number;
    rateLimitMaxRetries?: number;
}
export type ProbeResult =
    | { ok: true; dim: number; model_name: string; requestDim: number | null }
    | { ok: false; code: string };
export interface PrepareRequest {
    context: Readonly<Record<string, unknown>>;
    reason: string;
    role: 'read' | 'write' | 'maintenance';
    startup?: boolean;
    forceProbe?: boolean;
}
export interface StorageAssembly {
    dim: number;
    mode: RetrievalMode;
}
export type CandidateDecision = { publish: true } | { publish: false; afterDiscard: () => Promise<void> };
export type ReadonlySelection = { mode: RetrievalMode } | { deferredReason: 'missing_base_index' | 'open_failed' };
export interface RetrievalHost extends RetrievalSearchAccess {
    rebuildAllStorage(reason: string): Promise<void>;
    persistRebuildEvent(failure: unknown): Promise<void>;
    refreshSettings(): void;
    retryClosures(): Promise<void>;
    replaceStorage(
        request: StorageAssembly,
        prepare?: (candidate: RetrievalData) => Promise<CandidateDecision>
    ): Promise<void>;
    resetStorage(
        request: StorageAssembly,
        reconcile: (candidate: RetrievalData) => Promise<void>,
        complete: (candidate: RetrievalData) => Promise<void>
    ): Promise<void>;
    openReadonly(
        dim: number,
        select: (
            base: RetrievalData,
            probeFull: () => ReturnType<RetrievalData['probeIndexers']>
        ) => Promise<ReadonlySelection>,
        compatible: (candidate: RetrievalData) => boolean
    ): Promise<void>;
}
export interface SemanticResetOptions extends StorageAssembly {
    embeddingState?: Partial<EmbeddingState>;
    resume?: boolean;
}
export type ProductRequest =
    | ({ kind: 'semantic-reset'; reason: string } & SemanticResetOptions)
    | { kind: 'reconcile-current' }
    | { kind: 'full-invalidation'; embeddingState?: Partial<EmbeddingState> };
export type BuildStepResult =
    | { kind: 'completed' }
    | { kind: 'skipped'; reason: 'input_changed' | 'write_limited' }
    | { kind: 'failed'; error: unknown; failure: EmbeddingFailure; consecutiveFailure: boolean }
    | { kind: 'unavailable'; reason: string }
    | { kind: 'yield' }
    | { kind: 'wait' };
export interface FileRules {
    initializationRecovery(error: unknown): InitializationRecovery;
    baseAssembly(fresh?: boolean): StorageAssembly;
    fullResetPatch(openFailed: boolean): Partial<EmbeddingState>;
    canBuild(): boolean;
    pendingConditions(embedded: number): import('../../../services/storage/abstract-storage.js').FilterCondition[];
    rootGroupCounts(values: Record<string, unknown>, count: number): { embedded_count: number; failed_count: number };
    globalGroupEmbedded(values: Record<string, unknown>, count: number): number;
    taskFinishedPatch(at: number): Partial<EmbeddingState>;
    defaultState(): EmbeddingState;
    normalizeState(state: EmbeddingState, parsed: unknown): void;
    queryConditions(options: {
        requireEmbedded?: boolean;
        embeddingGeneration?: number;
    }): import('../../../services/storage/abstract-storage.js').FilterCondition[];
    semanticWriteState(): ReturnType<RetrievalData['getSemanticWriteState']>;
}
export interface DocumentRetrieval {
    prepare(request: PrepareRequest): Promise<void>;
    buildStep(file: import('../../../services/storage/abstract-storage.js').Item): Promise<BuildStepResult>;
    searchNames(query: string, options?: RetrievalSearchOptions): Promise<RetrievalSearchResult>;
    searchContent(query: string, options?: RetrievalSearchOptions): Promise<RetrievalSearchResult>;
    captureSearchContext(): SemanticSearchContext | null;
    isSearchContextCurrent(context: SemanticSearchContext | null | undefined): boolean;
    rebuildProducts(request: ProductRequest): Promise<void>;
    getFilePatch(
        event: 'content-changed' | 'reference-only'
    ): Partial<import('../../../services/storage/abstract-storage.js').Item>;
    getFileRules(): FileRules;
    getRuntimeState(): RuntimeState;
    dispose(): Promise<void>;
}

export interface RuntimeState {
    mode: RetrievalMode;
    available: boolean;
    resetPending: boolean;
    probeError: EmbeddingState['probe_error'];
    lastEmbeddingTaskAt: number | null;
    readonly modelConfigured: boolean;
    readonly baseOnlyAlert: string;
}
