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
import fs from 'node:fs';
import { extractText } from '../../parser/extract.js';
import { logger } from '../../../../utils/logger.js';
import { FULL_TEXT_FIELD, FULL_TEXT_MAX_CHARS, isFullTextIndexable, nextFailureState } from './full-text-state.js';

export type FullTextBuildResult = { kind: 'completed' | 'skipped' | 'failed' | 'storage_error'; error?: unknown };
export function truncateFullText(text: string, filePath: string): string {
    if (text.length <= FULL_TEXT_MAX_CHARS) return text;
    let end = FULL_TEXT_MAX_CHARS;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    logger.warn(
        `[filemgr] full text truncated file=${filePath} originalChars=${text.length} limit=${FULL_TEXT_MAX_CHARS}`
    );
    return text.slice(0, end);
}
export const FULL_TEXT_BATCH_LIMIT = 50;
// Extracted characters written per BM25 transaction; a single larger file is written alone.
export const FULL_TEXT_BATCH_CHARS = 500_000;
interface PreparedFullText {
    row: Item;
    kind: 'completed' | 'failed' | 'skipped';
    state?: number;
    text?: string;
    observed?: Pick<fs.Stats, 'mtimeMs' | 'size'>;
}
async function prepareFullTextFile(row: Item, generation: number): Promise<PreparedFullText> {
    const skipped: PreparedFullText = { row, kind: 'skipped' };
    let before: fs.Stats;
    try {
        before = await fs.promises.stat(row.item_id);
    } catch {
        return skipped;
    }
    if (
        Math.floor(before.mtimeMs) !== Math.floor(Number(row.modified) || 0) ||
        (row.size !== null && row.size !== undefined && before.size !== Number(row.size))
    )
        return skipped;
    if (!isFullTextIndexable(row.item_id)) return { row, kind: 'completed', state: 1, observed: before };
    let text: string | null;
    try {
        text = await extractText(row.item_id);
    } catch {
        text = null;
    }
    let after: fs.Stats;
    try {
        after = await fs.promises.stat(row.item_id);
    } catch {
        return skipped;
    }
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) return skipped;
    if (text === null) {
        const state = nextFailureState(row, generation);
        logger.warn(`[filemgr] full text extraction failed file=${row.item_id} state=${state}`);
        return { row, kind: 'failed', state, observed: after };
    }
    return { row, kind: 'completed', state: 1, text: truncateFullText(text, row.item_id), observed: after };
}
export async function buildFullTextBatch(
    storage: Pick<BaseStorage, 'upsert' | 'update'>,
    rows: Item[],
    generation: number,
    isCurrent: () => boolean = () => true
): Promise<FullTextBuildResult[]> {
    if (rows.length > FULL_TEXT_BATCH_LIMIT) throw new RangeError('Full text batch exceeds its file limit');
    const results: FullTextBuildResult[] = [];
    const finish = (): FullTextBuildResult[] => [
        ...results,
        ...rows.slice(results.length).map((): FullTextBuildResult => ({ kind: 'skipped' }))
    ];
    // Write in groups bounded by extracted characters so a batch never holds 50 large texts at once.
    let group: PreparedFullText[] = [];
    let chars = 0;
    for (const row of rows) {
        if (!isCurrent()) return finish();
        const file = await prepareFullTextFile(row, generation);
        const size = file.text?.length ?? 0;
        if (group.length && chars + size > FULL_TEXT_BATCH_CHARS) {
            const written = await writeFullTextGroup(storage, group, generation, isCurrent);
            if (!written) return finish();
            results.push(...written);
            if (written.some((result) => result.kind === 'storage_error')) return finish();
            group = [];
            chars = 0;
        }
        group.push(file);
        chars += size;
    }
    if (!isCurrent()) return finish();
    if (group.length) {
        const written = await writeFullTextGroup(storage, group, generation, isCurrent);
        if (written) results.push(...written);
    }
    return finish();
}
async function writeFullTextGroup(
    storage: Pick<BaseStorage, 'upsert' | 'update'>,
    prepared: PreparedFullText[],
    generation: number,
    isCurrent: () => boolean
): Promise<FullTextBuildResult[] | null> {
    if (!isCurrent()) return null;
    try {
        // Earlier files can change while later files in the same batch are being extracted.
        for (const file of prepared) {
            if (!isCurrent()) return null;
            if (!file.observed) continue;
            let unchanged = false;
            try {
                const stat = await fs.promises.stat(file.row.item_id);
                unchanged = stat.mtimeMs === file.observed.mtimeMs && stat.size === file.observed.size;
            } catch {
                /* A disappeared file remains pending for scanner reconciliation. */
            }
            if (!unchanged) {
                file.kind = 'skipped';
                file.state = undefined;
                file.text = undefined;
            }
        }
        if (!isCurrent()) return null;
        const writes: Item[] = prepared
            .filter((file) => file.text !== undefined)
            .map((file) => ({
                item_id: file.row.item_id,
                item_type: 'file',
                indexer_columns: { BM25Indexer: [{ column: FULL_TEXT_FIELD, content: file.text! }] }
            }));
        if (writes.length) await storage.upsert(writes, { indexers: ['BM25Indexer'] });
        if (!isCurrent()) return null;
        const updates: Item[] = prepared
            .filter((file) => file.state !== undefined)
            .map((file) => ({
                item_id: file.row.item_id,
                item_type: 'file',
                bm25: file.state,
                bm25_generation: generation,
                bm25_modified: file.row.modified
            }));
        if (updates.length) await storage.update(updates, { indexers: ['BaseIndexer'] });
        return prepared.map((file) => ({ kind: file.kind }));
    } catch (error) {
        logger.warn(`[filemgr] full text batch storage error: ${error instanceof Error ? error.message : error}`);
        return prepared.map((file) =>
            file.kind === 'skipped' ? { kind: 'skipped' } : { kind: 'storage_error', error }
        );
    }
}
export async function buildFullTextFile(
    storage: Pick<BaseStorage, 'upsert' | 'update'>,
    row: Item,
    generation: number
): Promise<FullTextBuildResult> {
    return (await buildFullTextBatch(storage, [row], generation))[0];
}
