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

import type { ColumnSchema, FilterCondition, Item } from '../../../../services/storage/abstract-storage.js';
import { classifyBM25Failure } from '../../../../services/storage/bm25-indexer.js';
import { getStorageInitializationFailure } from '../../../../services/storage/platform.js';
import { chunkStructured } from '../../parser/chunk.js';
import { EXTRACT_TEXT_SUPPORTED_EXTENSIONS } from '../../parser/extract.js';

export function isFullTextPlatformSupported(): boolean {
    return true;
}

export const FULL_TEXT_RULE_VERSION = 1;
export const FULL_TEXT_MAX_CHARS = 10_000_000;
export const FULL_TEXT_FIELD = 'full_text';
export interface FullTextState {
    bm25_generation: number | null;
    bm25_rule_version: number | null;
    bm25_reset_pending: boolean;
}
export function isFullTextIndexable(filePath: string): boolean {
    // PARSER.md: chunk/abstract identify formats with extractable document content.
    const { chunk_type: type } = chunkStructured(null, filePath);
    return type === 'chunk' || type === 'abstract';
}
export const FULL_TEXT_INDEXABLE_EXTENSIONS: string[] = EXTRACT_TEXT_SUPPORTED_EXTENSIONS.map(
    (extension) => `.${extension}`
).filter((extension) => isFullTextIndexable(`document${extension}`));
export function fullTextColumns(): ColumnSchema['columns'] {
    return {
        bm25: { type: 'INTEGER', nullable: false, defaultValue: 0 },
        bm25_generation: { type: 'INTEGER', nullable: false, defaultValue: 0 },
        bm25_modified: { type: 'INTEGER', nullable: true },
        full_text: { type: 'TEXT', nullable: true }
    };
}
function timestamp(value: unknown): number {
    return Math.floor(Number(value) || 0);
}
export function isFullTextReady(row: Item, generation: number): boolean {
    return (
        row.bm25 === 1 && row.bm25_generation === generation && timestamp(row.bm25_modified) === timestamp(row.modified)
    );
}
export function nextFailureState(row: Item, generation: number): number {
    return row.bm25 === -1 &&
        row.bm25_generation === generation &&
        timestamp(row.bm25_modified) === timestamp(row.modified)
        ? -2
        : -1;
}
export function fullTextScanPatch(row: Item, modified: number): { bm25?: number } {
    return (row.bm25 === 1 || row.bm25 === -2) && timestamp(row.bm25_modified) !== modified ? { bm25: 0 } : {};
}
export function fullTextPendingConditions(generation: number, group: 'new' | 'old' | 'retry'): FilterCondition[] {
    const conditions: FilterCondition[] = [
        { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
        { indexer: 'BaseIndexer', field: 'ref_count', operator: '>', value: 0 },
        { indexer: 'BaseIndexer', field: 'ext', operator: 'in', value: FULL_TEXT_INDEXABLE_EXTENSIONS }
    ];
    if (group === 'new') conditions.push({ indexer: 'BaseIndexer', field: 'bm25', operator: '=', value: 0 });
    else if (group === 'old')
        conditions.push({ indexer: 'BaseIndexer', field: 'bm25_generation', operator: '!=', value: generation });
    else
        conditions.push(
            { indexer: 'BaseIndexer', field: 'bm25', operator: '=', value: -1 },
            { indexer: 'BaseIndexer', field: 'bm25_generation', operator: '=', value: generation }
        );
    return conditions;
}
export function defaultFullTextState(): FullTextState {
    return { bm25_generation: null, bm25_rule_version: null, bm25_reset_pending: false };
}
export function normalizeFullTextState(state: FullTextState, parsed: Record<string, unknown>): void {
    const validInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
    state.bm25_rule_version = validInteger(parsed.bm25_rule_version) ? parsed.bm25_rule_version : null;
    state.bm25_reset_pending = parsed.bm25_reset_pending === true;
    state.bm25_generation =
        validInteger(parsed.bm25_generation) &&
        state.bm25_rule_version !== null &&
        typeof parsed.bm25_reset_pending === 'boolean'
            ? parsed.bm25_generation
            : null;
}
export function fullTextResetRequired(state: FullTextState): boolean {
    return (
        state.bm25_reset_pending || state.bm25_generation === null || state.bm25_rule_version !== FULL_TEXT_RULE_VERSION
    );
}
export function classifyFullTextOpenFailure(error: unknown): 'not_bm25' | 'retain' | 'reset' | 'fallback' {
    const failure = getStorageInitializationFailure(error);
    if (failure?.indexer !== 'BM25Indexer') return 'not_bm25';
    if (failure.operation === 'close' || failure.operation === 'delete' || failure.cleanupFailures.length > 0)
        return 'retain';
    const classification = classifyBM25Failure(error);
    // A BM25 store is derived from source files, so damaged or foreign schemas are rebuilt once.
    return classification.kind === 'corrupt' || ['incompatible', 'invalid_schema'].includes(classification.reason)
        ? 'reset'
        : 'fallback';
}
