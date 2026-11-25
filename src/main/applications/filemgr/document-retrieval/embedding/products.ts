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

import type { Stats } from 'node:fs';
import type {
    EmbeddingChunk,
    EmbeddingState,
    EmbeddingStateAccess,
    Item,
    RetrievalAccess,
    RetrievalData,
    RetrievalHost,
    SemanticResetOptions
} from '../contract.js';
import { logger } from '../../../../utils/logger.js';
import { normalizeSemanticWriteState } from './state.js';

const ACCEPTING_SEMANTIC_WRITE_STATE = Object.freeze({
    vector: Object.freeze({ acceptingWrites: true }),
    chunk: Object.freeze({ acceptingWrites: true })
});

export async function advanceGeneration(access: EmbeddingStateAccess, embeddingState: Partial<EmbeddingState> = {}) {
    const generation = (access.readState().embedding_generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error('embedding_generation overflow');
    const nextState = {
        ...access.readState(),
        ...embeddingState,
        embedding_generation: generation,
        semantic_reset_pending: true
    };
    // Persist invalidation and the new model together before deleting any vectors.
    await access.writeStateSnapshot(nextState, () => {
        Object.assign(access.readState(), embeddingState, {
            embedding_generation: generation,
            semantic_reset_pending: true
        });
        access.invalidateCounts();
    });
}

export async function reconcileGeneration(access: EmbeddingStateAccess, storage: RetrievalData) {
    const generation = access.readState().embedding_generation ?? 0;
    // Each backend repairs only its own base rows when it becomes available.
    // Updating the generation removes each batch from this query, so no offset is needed.
    while (true) {
        const { items } = await storage.search(
            [
                { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
                { indexer: 'BaseIndexer', field: 'embedding_generation', operator: '!=', value: generation }
            ],
            { limit: 500 }
        );
        if (items.length === 0) return;
        await storage.update(
            items.map(({ item }) => ({
                item_id: item.item_id,
                item_type: item.item_type,
                embedded: 0,
                embedding_generation: generation
            })),
            { indexers: ['BaseIndexer'] }
        );
    }
}

export async function getSemanticWriteState(access: RetrievalAccess) {
    if (access.mode() !== 'full') return ACCEPTING_SEMANTIC_WRITE_STATE;
    return normalizeSemanticWriteState(await access.data('read')?.getSemanticWriteState?.());
}

export async function markFileEmbedded(
    access: RetrievalAccess,
    baseRow: Item,
    stat: Pick<Stats, 'mtimeMs' | 'size' | 'atimeMs'>
) {
    await access.data('write')!.update(
        [
            {
                item_id: baseRow.item_id,
                item_type: 'file',
                modified: Math.floor(Number(stat.mtimeMs) || 0),
                size: stat.size,
                accessed: Math.floor(Number(stat.atimeMs) || 0),
                embedded: 1,
                embedding_generation: access.readState().embedding_generation ?? 0
            }
        ],
        { indexers: ['BaseIndexer'] }
    );
}
export async function publishProducts(
    access: RetrievalAccess,
    baseRow: Item,
    statAfter: Pick<Stats, 'mtimeMs' | 'size' | 'atimeMs'>,
    selectedChunks: EmbeddingChunk[],
    embeddings: number[][]
): Promise<void> {
    const indexer_columns: NonNullable<Item['indexer_columns']> = {
        VectorIndexer: [{ column: 'filename', content: embeddings[0] }]
    };
    if (selectedChunks.length > 0) {
        indexer_columns.ChunkIndexer = selectedChunks.map((c, i) => ({
            column: 'chunk_text',
            id: c.id,
            text: c.text,
            content: embeddings[i + 1]
        }));
    }

    const targets = selectedChunks.length > 0 ? ['VectorIndexer', 'ChunkIndexer'] : ['VectorIndexer'];
    await access.data('write')!.clearIndexerForItem(baseRow.item_id, 'ChunkIndexer');
    await access.data('write')!.upsert(
        [
            {
                item_id: baseRow.item_id,
                item_type: 'file',
                filename: baseRow.filename,
                chunk_text: null,
                indexer_columns
            }
        ],
        { indexers: targets }
    );

    await markFileEmbedded(access, baseRow, statAfter);
}

export async function resetProducts(
    access: RetrievalHost,
    reason: string,
    { dim, mode, embeddingState = {}, resume = false }: SemanticResetOptions
): Promise<void> {
    let failure: any = null;
    try {
        if (typeof dim !== 'number' || (mode !== 'full' && mode !== 'base-only')) {
            throw new Error(`_resetVectorChunk: dim and mode are required (got dim=${dim}, mode=${mode})`);
        }
        await access.retryClosures();
        if (!resume) await advanceGeneration(access, embeddingState);
        logger.warn(`[filemgr] _resetVectorChunk: ${reason} (dim=${dim}, mode=${mode})`);
        await access.resetStorage(
            { dim, mode },
            async (candidate) => {
                const { items: fileItems } = await candidate.search([
                    { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' }
                ]);
                await candidate.upsert(
                    fileItems.map((r) => ({
                        ...r.item,
                        embedded: 0,
                        embedding_generation: access.readState().embedding_generation ?? 0
                    })),
                    { indexers: ['BaseIndexer'] }
                );
            },
            async (candidate) => {
                if (mode !== 'full') return;
                // Completion is persisted only after drops, reconciliation and old-owner release.
                const actual = candidate.getSemanticBackends();
                const patch = {
                    vector_backend: actual.vector,
                    chunk_backend: actual.chunk,
                    semantic_reset_pending: false
                };
                await access.writeStateSnapshot(patch, () => Object.assign(access.readState(), patch));
            }
        );
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        access.readState().last_rebuild_event = {
            type: 'vector',
            reason,
            status: failure ? 'failed' : 'completed',
            ts: Date.now(),
            ...(failure && { message: failure.message })
        };
        await access.persistRebuildEvent(failure);
    }
}

export async function demoteToBaseOnly(access: RetrievalHost, reason: string) {
    await access.retryClosures();
    if (access.mode() === 'base-only' && access.data('read')) return;
    logger.info(`[filemgr] _demoteToBaseOnly: ${reason}`);
    await access.replaceStorage({ dim: access.readState().vec_dim ?? 1024, mode: 'base-only' });
}

export async function markFileFailed(access: RetrievalAccess, file: Item, embedded = -1) {
    await access.data('write')!.update(
        [
            {
                item_id: file.item_id,
                item_type: 'file',
                embedded,
                embedding_generation: access.readState().embedding_generation ?? 0
            }
        ],
        { indexers: ['BaseIndexer'] }
    );
}
