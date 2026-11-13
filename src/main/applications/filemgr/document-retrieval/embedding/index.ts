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

import type {
    BuildStepResult,
    CandidateDecision,
    DocumentRetrieval,
    EmbeddingState,
    Item,
    PrepareRequest,
    ProbeOptions,
    ProbeResult,
    ProductRequest,
    RetrievalData,
    RetrievalHost,
    RetrievalSearchOptions,
    SemanticResetOptions
} from '../contract.js';
import { LLM } from '../../../../aikernel/llm.js';
import { Setting } from '../../../../utils/setting.js';
import { logger } from '../../../../utils/logger.js';
import { withRateLimitRetry } from '../../../../utils/rate-limit-retry.js';
import { shouldUseArkData, shouldUseWasm } from '../../../../services/storage/platform.js';
import { CHUNK_LEVEL, buildWholeFile, embedWithRetry, recordBuildFailure } from './build.js';
import {
    advanceGeneration,
    reconcileGeneration,
    resetProducts,
    getSemanticWriteState,
    demoteToBaseOnly
} from './products.js';
import { captureSearchContext, isSearchContextCurrent, searchNames, searchContent } from './search.js';
import {
    setProbeError,
    clearProbeError,
    baseAssembly,
    fullResetPatch,
    rootGroupCounts,
    globalGroupEmbedded,
    runtimeState,
    completedFileConditions,
    defaultEmbeddingState,
    currentModelName,
    isTransientNetworkError,
    normalizeSavedEmbeddingState,
    initializationRecovery
} from './state.js';

const STARTUP_EMBEDDING_PROBE_RETRIES = 1;
const OPENHARMONY_MAX_EMBED_DIM = 1024; // Preserve ArkData's existing floatvector ceiling.

interface PreparationOptions extends ProbeOptions {
    forceProbe?: boolean;
    isCurrent?: () => boolean;
}

export class EmbeddingRetrieval implements DocumentRetrieval {
    constructor(readonly host: RetrievalHost) {}
    get scannerState() {
        return this.host.readState();
    }
    get storage() {
        return this.host.data('read');
    }
    get mode() {
        return this.host.mode();
    }

    async prepare(request: PrepareRequest): Promise<void> {
        if (request.role === 'read') return this._prepareReadonly();
        const isCurrent = request.context.isCurrent;
        const options: PreparationOptions = {
            ...(request.forceProbe && { forceProbe: true }),
            ...(typeof isCurrent === 'function' && { isCurrent: isCurrent as () => boolean })
        };
        return request.startup
            ? this._syncModeForStartup(request.reason, options)
            : this._syncMode(request.reason, options);
    }
    async buildStep(file: Item): Promise<BuildStepResult> {
        try {
            const result = await this._buildWholeFile(file);
            if (result?.status === 'skipped_drift') return { kind: 'skipped', reason: 'input_changed' };
            if (result?.status === 'semantic_write_limited') return { kind: 'skipped', reason: 'write_limited' };
            return { kind: 'completed' };
        } catch (error) {
            return recordBuildFailure(this.host, file, error);
        }
    }
    searchNames(query: string, options?: RetrievalSearchOptions) {
        return searchNames(this.host, query, options);
    }
    searchContent(query: string, options?: RetrievalSearchOptions) {
        return searchContent(this.host, query, options);
    }
    captureSearchContext() {
        return captureSearchContext(this.host);
    }
    isSearchContextCurrent(context: ReturnType<typeof captureSearchContext>) {
        return isSearchContextCurrent(this.host, context);
    }
    async rebuildProducts(request: ProductRequest): Promise<void> {
        if (request.kind === 'semantic-reset') return resetProducts(this.host, request.reason, request);
        if (request.kind === 'full-invalidation') return advanceGeneration(this.host, request.embeddingState);
        return reconcileGeneration(this.host, this.host.data('read')!);
    }
    getFilePatch(event: 'content-changed' | 'reference-only') {
        return event === 'reference-only'
            ? {}
            : { embedded: 0, embedding_generation: this.scannerState.embedding_generation ?? 0 };
    }
    getFileRules() {
        return {
            initializationRecovery,
            defaultState: defaultEmbeddingState,
            normalizeState: (state: EmbeddingState, parsed: unknown) =>
                normalizeSavedEmbeddingState(state, parsed as any),
            queryConditions: completedFileConditions,
            semanticWriteState: () => this._getSemanticWriteState(),
            baseAssembly: (fresh = false) => baseAssembly(this.scannerState, fresh),
            fullResetPatch,
            canBuild: () => this.mode === 'full' && !this.scannerState.semantic_reset_pending,
            pendingConditions: (embedded: number) => [
                { indexer: 'BaseIndexer', field: 'embedded', operator: '=' as const, value: embedded }
            ],
            rootGroupCounts: (values: Record<string, unknown>, count: number) =>
                rootGroupCounts(this.scannerState, this.mode, values, count),
            globalGroupEmbedded: (values: Record<string, unknown>, count: number) =>
                globalGroupEmbedded(this.scannerState, values, count),
            taskFinishedPatch: (at: number) => ({ last_embedding_task_at: at })
        };
    }
    getRuntimeState() {
        return runtimeState(this.host);
    }
    async dispose(): Promise<void> {}
    _isOpenHarmony() {
        return (process.platform as string) === 'openharmony';
    }
    _buildWholeFile(file: Item) {
        return buildWholeFile(this.host, file);
    }
    _getSemanticWriteState() {
        return getSemanticWriteState(this.host);
    }
    _syncModeForStartup(reason: string, options: PreparationOptions = {}) {
        return this._syncMode(reason, {
            probeRetries: STARTUP_EMBEDDING_PROBE_RETRIES,
            rateLimitMaxRetries: 1,
            ...options
        });
    }
    _embedWithRetry(texts: string[]) {
        return embedWithRetry(this.host, texts);
    }
    _reconcileEmbeddingGeneration(candidate: RetrievalData) {
        return reconcileGeneration(this.host, candidate);
    }
    _resetVectorChunk(reason: string, options: SemanticResetOptions) {
        return resetProducts(this.host, reason, options);
    }

    async _probeCallOnce(dimensions: number | undefined, rateLimitMaxRetries = 3) {
        const vec = await withRateLimitRetry(() => LLM.embed('__filemgr_dim_probe__', dimensions), {
            maxRetries: rateLimitMaxRetries
        });
        return vec.length;
    }

    async _withProbeTimeout(promise: Promise<number>, timeoutMs: number | undefined) {
        if (!timeoutMs) {
            return promise;
        }

        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            return await Promise.race([
                promise,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`embedding probe timed out after ${timeoutMs}ms`)),
                        timeoutMs
                    );
                })
            ]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    async _probeDim(dimensions: number | undefined, options: ProbeOptions = {}) {
        const {
            probeTimeoutMs = Setting.getInstance().getDefaultEmbeddingModelInstance()!.getTimeoutMs(),
            probeRetries = 2,
            rateLimitMaxRetries = 3
        } = options;
        const maxAttempts = Math.max(1, probeRetries + 1);
        let lastErr;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                return await this._withProbeTimeout(
                    this._probeCallOnce(dimensions, rateLimitMaxRetries),
                    probeTimeoutMs
                );
            } catch (value) {
                const err = value as Error & { status?: unknown };
                lastErr = err;
                if (!isTransientNetworkError(err)) throw err;
                if (attempt < maxAttempts - 1) {
                    logger.warn(
                        `[filemgr] probe transient error (attempt ${attempt + 1}/${maxAttempts}): ${err?.message ?? ''}, retrying...`
                    );
                    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
                }
            }
        }
        throw lastErr;
    }

    _classifyFailure(err: any): Extract<ProbeResult, { ok: false }> {
        logger.warn(`[filemgr] probe failed: status=${err?.status ?? 'none'} msg=${err?.message ?? String(err)}`);
        return { ok: false, code: 'embedding_config_error' };
    }

    async _probeEmbedding(options: ProbeOptions = {}): Promise<ProbeResult> {
        try {
            const modelName = currentModelName();
            const nativeDim = await this._probeDim(undefined, options);
            if (!this._isOpenHarmony() || nativeDim <= OPENHARMONY_MAX_EMBED_DIM) {
                return { ok: true, dim: nativeDim, model_name: modelName, requestDim: null };
            }

            let reducedDim;
            try {
                reducedDim = await this._probeDim(OPENHARMONY_MAX_EMBED_DIM, options);
            } catch (value) {
                const err = value as Error & { status?: unknown };
                return this._classifyFailure(err);
            }

            if (reducedDim !== OPENHARMONY_MAX_EMBED_DIM) {
                return { ok: false, code: 'dim_unsupported' };
            }
            return {
                ok: true,
                dim: OPENHARMONY_MAX_EMBED_DIM,
                model_name: modelName,
                requestDim: OPENHARMONY_MAX_EMBED_DIM
            };
        } catch (value) {
            const err = value as Error & { status?: unknown };
            return this._classifyFailure(err);
        }
    }

    async _setProbeError(code: string) {
        return setProbeError(this.host, code);
    }

    async _clearProbeError() {
        return clearProbeError(this.host);
    }

    async _recordProbeResolution(probe: Extract<ProbeResult, { ok: true }>) {
        if (
            this.scannerState.embedding_request_dim === probe.requestDim &&
            this.scannerState._requestDimResolved === true
        ) {
            return;
        }
        this.scannerState.embedding_request_dim = probe.requestDim;
        this.scannerState._requestDimResolved = true;
        await this.host.saveState();
    }

    async _syncMode(reason: string, options: PreparationOptions = {}) {
        // A persisted model/generation describes the target, not a live connection.
        // Finish failed releases before deciding that the current mode can be reused.
        await this.host.retryClosures();
        const isCurrent = options.isCurrent ?? (() => true);
        if (!isCurrent()) return;
        this.host.refreshSettings();

        // Step 1: no embedding model configured
        let currentModelName;
        try {
            currentModelName = Setting.getInstance().getDefaultEmbeddingModelInstance()!.model_name;
        } catch {
            await this._clearProbeError();
            if (!isCurrent()) return;
            await this._demoteToBaseOnly(`${reason}: no embedding model configured`);
            return;
        }

        const openedBackends = this.mode === 'full' ? this.storage?.getSemanticBackends?.() : null;
        // Platform preference is provisional until factories finish opening.
        const currentBackend =
            openedBackends?.vector ?? (shouldUseArkData() ? 'arkdata' : shouldUseWasm() ? 'wasm' : 'native');
        const currentChunkBackend = openedBackends?.chunk ?? currentBackend;

        // Step 2: fast no-op — already full and state matches current setting (incl. vector backend)
        if (
            !options.forceProbe &&
            this.storage &&
            this.mode === 'full' &&
            !this.scannerState.semantic_reset_pending &&
            this.scannerState.embedding_model === currentModelName &&
            this.scannerState.vec_dim !== null &&
            this.scannerState.chunk_level === CHUNK_LEVEL &&
            this.scannerState.vector_backend === currentBackend &&
            (this.scannerState.chunk_backend ?? this.scannerState.vector_backend) === currentChunkBackend &&
            (!this._isOpenHarmony() || this.scannerState._requestDimResolved === true)
        ) {
            return;
        }

        // Step 3: probe
        const probe = await this._probeEmbedding(options);
        if (!isCurrent()) return;
        if (!probe.ok) {
            await this._setProbeError(probe.code);
            if (!isCurrent()) return;
            await this._demoteToBaseOnly(`${reason}: probe failed`);
            return;
        }
        await this._clearProbeError();
        if (!isCurrent()) return;
        await this._recordProbeResolution(probe);
        if (!isCurrent()) return;

        const hasEmbeddingInfo =
            this.scannerState.vec_dim !== null &&
            this.scannerState.embedding_model !== null &&
            this.scannerState.chunk_level !== null;

        const hasBackendInfo = this.scannerState.vector_backend !== null;

        const inferLegacyBackend = () => {
            if (
                (process.platform as string) === 'openharmony' ||
                (process.platform === 'win32' && process.arch === 'arm64')
            ) {
                return 'wasm';
            }
            return 'native';
        };
        const effectiveStateBackend = hasBackendInfo
            ? this.scannerState.vector_backend
            : hasEmbeddingInfo
              ? inferLegacyBackend()
              : null;

        const stateConsistent =
            hasEmbeddingInfo &&
            effectiveStateBackend !== null &&
            this.scannerState.embedding_model === probe.model_name &&
            this.scannerState.vec_dim === probe.dim &&
            this.scannerState.chunk_level === CHUNK_LEVEL;

        if (stateConsistent) {
            if (!hasBackendInfo) {
                this.scannerState.vector_backend = effectiveStateBackend;
                this.scannerState.chunk_backend = effectiveStateBackend;
                await this.host.saveState();
            }
            // 3b: state matches probe — try to reuse existing vector/chunk data
            try {
                await this._openFull(probe.dim);
            } catch (value) {
                // A resumed reset already owns its generation; preserve its failure
                // and completion marker instead of starting another invalidation.
                await this._recoverFullOpen(value, probe.dim);
            }
        } else if (!hasEmbeddingInfo) {
            // 3c: state missing — record probe info first, then try to reuse
            logger.info(
                `[filemgr] syncEmbeddingMode: state missing, recording probe (dim=${probe.dim}, model=${probe.model_name}, backend=${currentBackend})`
            );
            this.scannerState.vec_dim = probe.dim;
            this.scannerState.embedding_model = probe.model_name;
            this.scannerState.chunk_level = CHUNK_LEVEL;
            // No prior model metadata: record actual backends only after factories open.
            this.scannerState.vector_backend = null;
            this.scannerState.chunk_backend = null;
            await this.host.saveState();
            try {
                await this._openFull(probe.dim);
            } catch (value) {
                await this._recoverFullOpen(value, probe.dim);
            }
        } else {
            const reasonCode =
                effectiveStateBackend !== currentBackend ? 'vector_backend_changed' : 'embedding_config_changed';
            // 3d: state inconsistent — model/dim/chunk_level/backend changed, existing vectors invalid
            logger.info(
                `[filemgr] syncEmbeddingMode: state inconsistent (stored: dim=${this.scannerState.vec_dim}, model=${this.scannerState.embedding_model}, backend=${effectiveStateBackend}; probe: dim=${probe.dim}, model=${probe.model_name}, backend=${currentBackend}), reason=${reasonCode}, resetting`
            );
            await this._resetVectorChunk(reasonCode, {
                dim: probe.dim,
                mode: 'full',
                embeddingState: {
                    vec_dim: probe.dim,
                    embedding_model: probe.model_name,
                    chunk_level: CHUNK_LEVEL,
                    vector_backend: currentBackend,
                    chunk_backend: currentChunkBackend
                }
            });
        }
    }

    async _demoteToBaseOnly(reason: string) {
        return demoteToBaseOnly(this.host, reason);
    }
    async _recoverFullOpen(error: unknown, dim: number) {
        if (this.scannerState.semantic_reset_pending) throw error;
        const recovery = initializationRecovery(error);
        if (!recovery) throw error;
        if (recovery === 'full') return this.host.rebuildAllStorage('base_init_failed');
        return this._resetVectorChunk(recovery === 'compatibility' ? 'embedding_config_changed' : 'open_full_failed', {
            dim,
            mode: 'full'
        });
    }
    async _openFull(dim: number) {
        await this.host.retryClosures();
        if (this.scannerState.semantic_reset_pending) {
            const reason =
                this.scannerState.last_rebuild_event?.status === 'failed'
                    ? (this.scannerState.last_rebuild_event.reason ?? 'embedding_config_changed')
                    : 'embedding_config_changed';
            return this._resetVectorChunk(reason, { dim, mode: 'full', resume: true });
        }
        if (this.mode === 'full' && this.storage) return;
        logger.info(`[filemgr] _openFull: dim=${dim}`);
        await this.host.replaceStorage({ dim, mode: 'full' }, async (candidate): Promise<CandidateDecision> => {
            const actual = candidate.getSemanticBackends();
            const expectedChunk = this.scannerState.chunk_backend ?? this.scannerState.vector_backend;
            if (this.scannerState.vector_backend === null) {
                await this.host.writeStateSnapshot(
                    { vector_backend: actual.vector, chunk_backend: actual.chunk },
                    () => {
                        this.scannerState.vector_backend = actual.vector;
                        this.scannerState.chunk_backend = actual.chunk;
                    }
                );
            } else if (actual.vector !== this.scannerState.vector_backend || actual.chunk !== expectedChunk) {
                return {
                    publish: false,
                    afterDiscard: () =>
                        this._resetVectorChunk('vector_backend_changed', {
                            dim,
                            mode: 'full',
                            embeddingState: { vector_backend: actual.vector, chunk_backend: actual.chunk }
                        })
                };
            }
            await this._reconcileEmbeddingGeneration(candidate);
            return { publish: true };
        });
    }
    async _prepareReadonly() {
        const dim = this.scannerState.vec_dim ?? 1024;
        await this.host.openReadonly(
            dim,
            async (base, probeFull) => {
                const baseProbe = await base.probeBaseIndexStore();
                logger.info(`[filemgr] readonly probe base result=${baseProbe}`);
                if (baseProbe === 'missing') return { deferredReason: 'missing_base_index' };
                if (baseProbe === 'open_failed') return { deferredReason: 'open_failed' };
                const hasEmbeddingState = Boolean(
                    this.scannerState.embedding_model &&
                    this.scannerState.vec_dim &&
                    !this.scannerState.semantic_reset_pending
                );
                if (hasEmbeddingState) {
                    const semanticProbe = await probeFull();
                    const vectorProbe = semanticProbe.VectorIndexer ?? 'missing';
                    const chunkProbe = semanticProbe.ChunkIndexer ?? 'missing';
                    logger.info(
                        `[filemgr] readonly probe semantic vector=${vectorProbe} chunk=${chunkProbe} embeddingModel=${this.scannerState.embedding_model ?? 'none'} dim=${dim}`
                    );
                    if (vectorProbe === 'exists' && chunkProbe === 'exists') return { mode: 'full' };
                    if (vectorProbe === 'open_failed' || chunkProbe === 'open_failed')
                        logger.warn(
                            `[filemgr] readonly semantic probe failed; falling back to base-only vector=${vectorProbe} chunk=${chunkProbe}`
                        );
                }
                return { mode: 'base-only' };
            },
            (candidate) => {
                const actual = candidate.getSemanticBackends();
                const recorded = this.scannerState.vector_backend;
                const recordedChunk = this.scannerState.chunk_backend ?? recorded;
                return !recorded || (actual.vector === recorded && actual.chunk === recordedChunk);
            }
        );
    }
}
