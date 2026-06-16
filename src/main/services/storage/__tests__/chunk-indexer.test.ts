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

/**
 * ChunkIndexer integration tests
 *
 * 运行方式：
 *   npx tsx src/main/services/storage/__tests__/chunk-indexer.test.ts
 */

import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { BaseStorage, ColumnSchema, Item, SearchItem } from '../abstract-storage.js';

// ── Constants & Helpers ─────────────────────────────────────────────

const VECTOR_DIM = 1024;

function makeOneHot(index: number, dim = VECTOR_DIM): number[] {
    const v = Array(dim).fill(0);
    v[index] = 1;
    return v;
}

function tmpDir(name: string): string {
    return path.join(os.tmpdir(), `chunk-test-${name}-${Date.now()}`);
}

function cleanup(dir: string): void {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function extractSearchItems(result: Awaited<ReturnType<BaseStorage['search']>>): SearchItem[] {
    assert(
        result && Array.isArray(result.items) && typeof result.totalCount === 'number',
        'storage.search() must return { items, totalCount }'
    );
    return result.items;
}

async function createTestStorage(dir: string, schema?: ColumnSchema): Promise<BaseStorage> {
    cleanup(dir);
    const storage = new BaseStorage('test', schema ?? testSchema, dir);
    await storage.initialize();
    return storage;
}

// ── Schemas ──────────────────────────────────────────────────────────

const testSchema: ColumnSchema = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false },
        filename: { type: 'TEXT', nullable: true },
        chunk_text: { type: 'TEXT', nullable: true }
    },
    needIndexers: {
        chunk_text: [{ indexer: 'ChunkIndexer' }]
    }
};

const conflictingChunkDimSchema: ColumnSchema = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false },
        chunk_text_a: { type: 'TEXT', nullable: true },
        chunk_text_b: { type: 'TEXT', nullable: true }
    },
    needIndexers: {
        chunk_text_a: [{ indexer: 'ChunkIndexer' }],
        chunk_text_b: [{ indexer: 'ChunkIndexer', options: { dim: 1536 } }]
    }
};

// ── Item builders ───────────────────────────────────────────────────

function makeItemWithChunks(itemId: string, chunkTexts: string[], vectorIndices: number[]): Item {
    return {
        item_id: itemId,
        item_type: 'file',
        filename: `${itemId}.txt`,
        chunk_text: null,
        indexer_columns: {
            ChunkIndexer: chunkTexts.map((text, i) => ({
                column: 'chunk_text',
                content: makeOneHot(vectorIndices[i]),
                id: `${itemId}:chunk:${i}`,
                text
            }))
        }
    };
}

function chunkSearch(vecIndex: number, threshold = 0.0) {
    return [
        {
            indexer: 'ChunkIndexer' as const,
            field: 'chunk_text',
            operator: 'vector_near' as const,
            value: makeOneHot(vecIndex),
            vectorQuery: { topK: 5, metric: 'cosine' as const, threshold }
        }
    ];
}

// ── Tests ────────────────────────────────────────────────────────────

/** 1. Insert, search, double-insert, item without chunks */
async function testInsertSearchAndEdgeCases(): Promise<void> {
    const dir = tmpDir('insert-search');
    const storage = await createTestStorage(dir);

    await storage.insert([
        makeItemWithChunks('doc-1', ['第一段内容', '第二段内容'], [0, 1]),
        makeItemWithChunks('doc-2', ['第三段内容', '第四段内容'], [2, 3])
    ]);

    const r = extractSearchItems(await storage.search(chunkSearch(0)));
    assert(r.length > 0, 'Should return at least 1 result');
    assert(r[0].chunk_id !== undefined && r[0].chunk_text !== undefined && r[0].ChunkScore !== undefined);
    assert.equal(r[0].chunk_text, '第一段内容');
    assert.equal(r[0].item.item_id, 'doc-1');

    // Double insert — first-write-only
    await storage.insert([makeItemWithChunks('doc-1', ['新内容', '更新内容'], [4, 5])]);
    const status = await storage.getStatus();
    assert.equal(status.ChunkIndexer.size, 4, 'Double insert should not add chunks');
    const r2 = extractSearchItems(await storage.search(chunkSearch(0, 0.9)));
    assert.equal(r2.length, 1);
    assert.equal(r2[0].chunk_text, '第一段内容');

    // Item without chunks — no error
    await storage.insert([{ item_id: 'doc-empty', item_type: 'file', filename: 'empty.txt', chunk_text: null }]);

    storage.close();
    cleanup(dir);
    console.log('[testInsertSearchAndEdgeCases] PASS');
}

/** 2. Status, clear, conflicting dims */
async function testStatusClearAndConflictingDims(): Promise<void> {
    const dir = tmpDir('status-clear');
    const storage = await createTestStorage(dir);
    await storage.insert([makeItemWithChunks('doc-1', ['A', 'B'], [0, 1])]);

    const before = await storage.getStatus();
    assert(before.ChunkIndexer !== undefined);
    assert.equal(before.ChunkIndexer.size, 2);
    assert.equal(before.ChunkIndexer.dim, VECTOR_DIM);

    await storage.clear();
    assert.equal((await storage.getStatus()).ChunkIndexer.size, 0);

    storage.close();
    cleanup(dir);

    // Conflicting dims should throw at construction
    let threw = false;
    try {
        new BaseStorage('test', conflictingChunkDimSchema, dir);
    } catch (e: any) {
        threw = true;
        assert(e.message.includes('ChunkIndexer dim must be consistent'));
    }
    assert(threw, 'Should reject conflicting ChunkIndexer dims');

    console.log('[testStatusClearAndConflictingDims] PASS');
}

/** 3. Delete removes all chunks */
async function testDeleteCleansChunks(): Promise<void> {
    const dir = tmpDir('delete');
    const storage = await createTestStorage(dir);
    await storage.insert([makeItemWithChunks('doc-1', ['A', 'B'], [0, 1])]);
    await storage.delete([{ item_id: 'doc-1', item_type: 'file' }]);

    assert.equal(extractSearchItems(await storage.search(chunkSearch(0))).length, 0);

    storage.close();
    cleanup(dir);
    console.log('[testDeleteCleansChunks] PASS');
}

/** 4. Update = full replace */
async function testUpdateFullReplace(): Promise<void> {
    const dir = tmpDir('update');
    const storage = await createTestStorage(dir);
    await storage.insert([makeItemWithChunks('doc-1', ['旧A', '旧B'], [0, 1])]);
    await storage.update([makeItemWithChunks('doc-1', ['新C', '新D'], [2, 3])]);

    assert.equal(extractSearchItems(await storage.search(chunkSearch(0, 0.6))).length, 0, 'Old chunks should be gone');
    const newR = extractSearchItems(await storage.search(chunkSearch(2, 0.5)));
    assert(newR.length > 0 && newR[0].chunk_text === '新C');

    storage.close();
    cleanup(dir);
    console.log('[testUpdateFullReplace] PASS');
}

/** 5. BaseIndexer filter in chunk search */
async function testBaseIndexerFilterInSearch(): Promise<void> {
    const dir = tmpDir('base-filter');
    const storage = await createTestStorage(dir);

    await storage.insert([
        makeItemWithChunks('doc-file', ['内容', ''], [0, 1]),
        {
            item_id: 'mail-1',
            item_type: 'mail' as any,
            filename: null,
            chunk_text: null,
            indexer_columns: {
                ChunkIndexer: [
                    { column: 'chunk_text', content: makeOneHot(0), id: 'mail-1:chunk:0', text: 'mail 内容' }
                ]
            }
        }
    ]);

    const r = extractSearchItems(
        await storage.search([
            ...chunkSearch(0),
            { indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }
        ])
    );
    const ids = r.map((x) => x.item.item_id);
    assert(!ids.includes('mail-1'));
    assert(ids.includes('doc-file'));

    storage.close();
    cleanup(dir);
    console.log('[testBaseIndexerFilterInSearch] PASS');
}

/** 6. Same item_id appears multiple times (no dedup) */
async function testChunkScoreNotDeduped(): Promise<void> {
    const dir = tmpDir('no-dedup');
    const storage = await createTestStorage(dir);
    await storage.insert([makeItemWithChunks('doc-1', ['A', 'B', 'C'], [0, 0, 0])]);

    const r = extractSearchItems(await storage.search(chunkSearch(0)));
    assert.equal(r.length, 3, 'All 3 chunks should appear');
    assert(r.every((x) => x.item.item_id === 'doc-1'));

    storage.close();
    cleanup(dir);
    console.log('[testChunkScoreNotDeduped] PASS');
}

/** 7. ChunkIndexer + BM25Indexer should throw */
async function testForbiddenMixThrows(): Promise<void> {
    const dir = tmpDir('forbidden-mix');
    const storage = await createTestStorage(dir);

    await assert.rejects(
        () =>
            storage.search([
                ...chunkSearch(0),
                { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: 'hello' }
            ]),
        (e: any) => e.message.includes('BM25Indexer')
    );

    storage.close();
    cleanup(dir);
    console.log('[testForbiddenMixThrows] PASS');
}

/** 8. Insert missing required field should throw */
async function testInsertMissingFieldThrows(): Promise<void> {
    const dir = tmpDir('missing-field');
    const storage = await createTestStorage(dir);

    await assert.rejects(
        () =>
            storage.insert([
                {
                    item_id: 'doc-bad',
                    item_type: 'file',
                    chunk_text: null,
                    indexer_columns: {
                        ChunkIndexer: [{ column: 'chunk_text', content: makeOneHot(0), id: 'doc-bad:chunk:0' }]
                    }
                }
            ]),
        (e: any) => e.message.includes("missing 'text'")
    );

    storage.close();
    cleanup(dir);
    console.log('[testInsertMissingFieldThrows] PASS');
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('=== ChunkIndexer Integration Tests ===\n');

    const tests = [
        testInsertSearchAndEdgeCases,
        testStatusClearAndConflictingDims,
        testDeleteCleansChunks,
        testUpdateFullReplace,
        testBaseIndexerFilterInSearch,
        testChunkScoreNotDeduped,
        testForbiddenMixThrows,
        testInsertMissingFieldThrows
    ];

    let passed = 0,
        failed = 0;
    for (const test of tests) {
        try {
            await test();
            passed++;
        } catch (e: any) {
            console.error(`  FAIL ${test.name}: ${e.message}`);
            failed++;
        }
    }

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
});
