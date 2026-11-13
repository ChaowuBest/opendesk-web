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

import type { FilterCondition, VectorQuery } from '../../../../services/storage/abstract-storage.js';
import type {
    RetrievalAccess,
    RetrievalSearchAccess,
    RetrievalSearchOptions,
    SemanticSearchContext
} from '../contract.js';
import { CODES } from '../contract.js';
import { LLM } from '../../../../aikernel/llm.js';
import { logger } from '../../../../utils/logger.js';
import { withRateLimitRetry } from '../../../../utils/rate-limit-retry.js';
import {
    buildIndexedFilePreconditions,
    logScopedSearchDiagnostics,
    normalizeFilemgrSearchScope,
    scopedSearchDiagnosticsEnabled
} from '../../search/indexed.js';
import { currentModelName, completedFileConditions } from './state.js';

function baseOnlyResult(access: RetrievalSearchAccess, query: string) {
    const code = access.readState().probe_error ? CODES.EMBED_API_DOWN : CODES.EMBED_UNAVAILABLE;
    return access.formatSearchResult(query, [], 0, code);
}

// ── Search APIs ─────────────────────────────────────────────────

// A query embedding and its results belong to one FileMgr model generation.
// Network and SQL awaits may overlap a reset; common storage has no model semantics.
export function captureSearchContext(access: RetrievalAccess): SemanticSearchContext | null {
    if (!access.data('read') || access.mode() !== 'full' || access.readState().semantic_reset_pending) return null;
    const state = access.readState();
    try {
        if (currentModelName() !== state.embedding_model) return null;
    } catch {
        return null;
    }
    return {
        storage: access.data('read')!.identity,
        generation: state.embedding_generation ?? 0,
        model: state.embedding_model,
        dim: state.vec_dim,
        chunkLevel: state.chunk_level,
        vectorBackend: state.vector_backend,
        chunkBackend: state.chunk_backend
    };
}

export function isSearchContextCurrent(
    access: RetrievalAccess,
    context: SemanticSearchContext | null | undefined
): boolean {
    const current = captureSearchContext(access);
    return (
        !!context &&
        !!current &&
        (Object.keys(current) as Array<keyof SemanticSearchContext>).every((key) => current[key] === context[key])
    );
}

/**
 * @param {string} query
 * @param {{ topK?: number }} [opts]
 */
export async function searchNames(
    access: RetrievalSearchAccess,
    query: string,
    { topK = 20, scope }: RetrievalSearchOptions = {}
) {
    scope = normalizeFilemgrSearchScope(scope);
    if (!query?.trim()) {
        return access.formatSearchResult(query, [], 0);
    }

    if (!access.data('read') || access.readState().semantic_reset_pending) {
        return access.formatSearchResult(query, [], 0, CODES.INDEX_NOT_READY);
    }

    if (access.mode() === 'base-only') {
        return baseOnlyResult(access, query);
    }

    const context = captureSearchContext(access);
    const interrupted = () => access.formatSearchResult(query, [], 0, CODES.INDEX_NOT_READY);
    if (!context) return interrupted();
    let queryEmbedding;
    try {
        // Short retry for transient 429s; user-waiting path so cap small.
        queryEmbedding = await withRateLimitRetry(
            () => LLM.embed(query, access.readState().embedding_request_dim ?? undefined),
            { maxRetries: 2 }
        );
    } catch (err) {
        if (!isSearchContextCurrent(access, context)) return interrupted();
        logger.warn(`[filemgr] searchFileByName embed failed: ${(err as Error).message}`);
        return access.formatSearchResult(query, [], 0, CODES.EMBED_API_DOWN);
    }

    if (!isSearchContextCurrent(access, context)) return interrupted();

    const conditions: FilterCondition[] = [
        {
            indexer: 'VectorIndexer',
            field: 'filename',
            operator: 'vector_near',
            value: queryEmbedding,
            vectorQuery: { topK, metric: 'cosine' } as VectorQuery
        },
        ...buildIndexedFilePreconditions({
            scope,
            algorithmConditions: completedFileConditions({
                requireEmbedded: true,
                embeddingGeneration: context.generation
            })
        })
    ];
    const collectDiagnostics = scope && scopedSearchDiagnosticsEnabled();
    let result;
    try {
        result = scope
            ? await access.data('read')!.searchScope(
                  { preconditions: conditions.slice(1), targetCondition: conditions[0] },
                  {
                      collectDiagnostics
                  }
              )
            : await access.data('read')!.search(conditions);
    } catch (error) {
        if (!isSearchContextCurrent(access, context)) return interrupted();
        throw error;
    }
    if (!isSearchContextCurrent(access, context)) return interrupted();
    logScopedSearchDiagnostics('name_semantic', scope, result);

    let items = result.items.map((it) => ({
        path: it.item.item_id,
        filename: it.item.filename,
        modified: it.item.modified,
        size: it.item.size,
        snippet: null,
        semanticScore: it.VecScore ?? 0
    }));

    try {
        items = await LLM.rerank(query, items, (item) => item.filename);
    } catch (err) {
        logger.warn(`[filemgr] searchFileByName rerank failed: ${(err as Error).message}`);
    }

    if (!isSearchContextCurrent(access, context)) return interrupted();
    return access.formatSearchResult(query, items, result.totalCount);
}

/**
 * @param {string} query
 * @param {{ topK?: number }} [opts]
 */
export async function searchContent(
    access: RetrievalSearchAccess,
    query: string,
    { topK, scope }: RetrievalSearchOptions = {}
) {
    const normalizedTopK = Number(topK);
    if (!Number.isInteger(normalizedTopK) || normalizedTopK < 1 || normalizedTopK > 5000) {
        throw new TypeError('searchIndexedChunks topK must be an integer in 1..5000');
    }
    scope = normalizeFilemgrSearchScope(scope);
    if (!query?.trim()) {
        return access.formatSearchResult(query, [], 0);
    }

    if (!access.data('read') || access.readState().semantic_reset_pending) {
        return access.formatSearchResult(query, [], 0, CODES.INDEX_NOT_READY);
    }

    if (access.mode() === 'base-only') {
        return baseOnlyResult(access, query);
    }

    const context = captureSearchContext(access);
    const interrupted = () => access.formatSearchResult(query, [], 0, CODES.INDEX_NOT_READY);
    if (!context) return interrupted();
    let queryEmbedding;
    try {
        // Short retry for transient 429s; user-waiting path so cap small.
        queryEmbedding = await withRateLimitRetry(
            () => LLM.embed(query, access.readState().embedding_request_dim ?? undefined),
            { maxRetries: 2 }
        );
    } catch (err) {
        if (!isSearchContextCurrent(access, context)) return interrupted();
        logger.warn(`[filemgr] searchIndexedChunks embed failed: ${(err as Error).message}`);
        return access.formatSearchResult(query, [], 0, CODES.EMBED_API_DOWN);
    }

    if (!isSearchContextCurrent(access, context)) return interrupted();

    const conditions: FilterCondition[] = [
        {
            indexer: 'ChunkIndexer',
            field: 'chunk_text',
            operator: 'vector_near',
            value: queryEmbedding,
            vectorQuery: { topK: normalizedTopK, metric: 'cosine' } as VectorQuery
        },
        ...buildIndexedFilePreconditions({
            scope,
            algorithmConditions: completedFileConditions({
                requireEmbedded: true,
                embeddingGeneration: context.generation
            })
        })
    ];
    const collectDiagnostics = scope && scopedSearchDiagnosticsEnabled();
    let result;
    try {
        result = scope
            ? await access.data('read')!.searchScope(
                  { preconditions: conditions.slice(1), targetCondition: conditions[0] },
                  {
                      collectDiagnostics
                  }
              )
            : await access.data('read')!.search(conditions);
    } catch (error) {
        if (!isSearchContextCurrent(access, context)) return interrupted();
        throw error;
    }
    if (!isSearchContextCurrent(access, context)) return interrupted();
    logScopedSearchDiagnostics('content_semantic', scope, result);
    let items = result.items.slice(0, normalizedTopK).map((it) => ({
        chunk: { id: it.chunk_id, text: it.chunk_text },
        score: it.ChunkScore ?? 0,
        source: {
            path: it.item.item_id,
            filename: it.item.filename,
            modified: it.item.modified,
            size: it.item.size,
            refCount: it.item.ref_count,
            rootRefs: it.item.root_refs
        }
    }));

    try {
        items = await LLM.rerank(query, items, (item) => item.chunk.text!);
    } catch (err) {
        logger.warn(`[filemgr] searchIndexedChunks rerank failed: ${(err as Error).message}`);
    }
    if (!isSearchContextCurrent(access, context)) return interrupted();
    return access.formatSearchResult(query, items, items.length);
}
