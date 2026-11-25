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

import type { BaseStorage, Item } from '../../../../services/storage/abstract-storage.js';
import type { FileSearchScope } from '../contract.js';

import { buildIndexedFilePreconditions } from '../../search/indexed.js';
import { FULL_TEXT_FIELD, isFullTextReady } from './full-text-state.js';

type SearchStorage = Pick<BaseStorage, 'searchBM25' | 'searchScope' | 'search'>;
interface FullTextOwner {
    storage: SearchStorage | null;
    scannerState: { bm25_generation: number | null };
    getFullTextState(): { available: boolean };
}
interface FullTextContext {
    owner: FullTextOwner;
    holder: SearchStorage | null;
    generation: number | null;
}
export async function searchFullText(
    storage: SearchStorage,
    query: string,
    { topK = 50, scope, generation }: { topK?: number; scope?: FileSearchScope; generation: number }
): Promise<Item[]> {
    const limit = Math.min(topK * 2, 200);
    let rows: Array<Item | undefined>;
    if (scope) {
        const result = await storage.searchScope({
            preconditions: buildIndexedFilePreconditions({
                scope,
                algorithmConditions: [
                    { indexer: 'BaseIndexer', field: 'bm25', operator: '=', value: 1 },
                    { indexer: 'BaseIndexer', field: 'bm25_generation', operator: '=', value: generation }
                ]
            }),
            targetCondition: {
                indexer: 'BM25Indexer',
                field: FULL_TEXT_FIELD,
                operator: 'bm25_match',
                value: { query, topK: limit }
            }
        });
        rows = result.items.map((hit) => hit.item);
    } else {
        const hits = await storage.searchBM25(query, { field: FULL_TEXT_FIELD, topK: limit });
        if (!hits.length) return [];
        const result = await storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: 'in', value: hits.map((hit) => hit.item_id) }
        ]);
        const byId = new Map(result.items.map((hit) => [hit.item.item_id, hit.item]));
        rows = hits.map((hit) => byId.get(hit.item_id));
    }
    return rows
        .filter((row): row is Item =>
            Boolean(row && row.type === 'file' && row.ref_count > 0 && isFullTextReady(row, generation))
        )
        .map((row, index) => ({ ...row, bm25Rank: index + 1 }));
}
export function captureFullTextContext(owner: FullTextOwner): FullTextContext {
    return { owner, holder: owner.storage, generation: owner.scannerState.bm25_generation };
}
export function isFullTextContextCurrent(owner: FullTextOwner, context: FullTextContext | undefined): boolean {
    return (
        context?.owner === owner &&
        context.holder === owner.storage &&
        context.generation === owner.scannerState.bm25_generation &&
        owner.getFullTextState().available
    );
}
