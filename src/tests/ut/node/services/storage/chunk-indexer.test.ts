/**
 * ChunkIndexer integration tests
 *
 * 运行方式：
 *   npx tsx --test src/tests/ut/node/services/storage/chunk-indexer.test.ts
 */

import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
    BaseStorage,
    ColumnSchema,
    Item,
    SearchItem,
    ScopedSearchValidationError,
    mergeScopedChunkHits
} from '../../../../../main/services/storage/abstract-storage.js';
import { setArkdataDatabaseKit } from '../../../../../main/services/storage/arkdata-bridge.js';
import type { DatabaseKit } from '../../../../../platforms/bridges/common.js';

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

async function testScopedChunkSearchFiltersAndRestoresMetadata(): Promise<void> {
    const storage = new BaseStorage('scoped-chunk', testSchema, tmpDir('scoped-chunk'));
    const calls: string[] = [];
    (storage as any).baseIndexer = {
        search: async () => {
            calls.push('base');
            return {
                items: [
                    { item_id: 'a', item_type: 'file', filename: 'A' },
                    { item_id: 'b', item_type: 'file', filename: 'B' }
                ],
                totalCount: 2
            };
        }
    };
    (storage as any).chunkIndexer = {
        getBackend: () => 'native',
        searchChunks: async (_value: unknown, _query: unknown, ids: string[]) => {
            calls.push(`chunk:${ids.join(',')}`);
            return [
                { item_id: 'outside', chunk_id: 'x', chunk_text: 'outside', similarity: 1 },
                { item_id: 'b', chunk_id: '2', chunk_text: 'B2', similarity: 0.7 },
                { item_id: 'a', chunk_id: '2', chunk_text: 'A2', similarity: 0.7 },
                { item_id: 'a', chunk_id: '1', chunk_text: 'A1', similarity: 0.7 }
            ];
        }
    };
    const result = await storage.searchScope({
        preconditions: [{ indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }],
        targetCondition: {
            indexer: 'ChunkIndexer',
            field: 'chunk_text',
            operator: 'vector_near',
            value: makeOneHot(0),
            vectorQuery: { topK: 3 }
        }
    });
    assert.deepEqual(calls, ['base', 'chunk:a,b']);
    assert.deepEqual(
        result.items.map((hit) => [hit.item.item_id, hit.chunk_id, hit.item.filename]),
        [
            ['a', '1', 'A'],
            ['a', '2', 'A'],
            ['b', '2', 'B']
        ]
    );

    assert.throws(
        () =>
            mergeScopedChunkHits(
                [
                    [
                        { item_id: 'a', chunk_id: '1', chunk_text: 'A', similarity: 0.5 },
                        { item_id: 'a', chunk_id: '1', chunk_text: 'A', similarity: 0.4 }
                    ]
                ],
                new Map([['a', { item_id: 'a', item_type: 'file' }]]),
                3
            ),
        /duplicate chunk hit/
    );
    for (const similarity of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(
            () =>
                mergeScopedChunkHits(
                    [[{ item_id: 'a', chunk_id: 'x', chunk_text: 'A', similarity } as any]],
                    new Map([['a', { item_id: 'a', item_type: 'file' }]]),
                    1
                ),
            /finite similarity/
        );
    }
}

async function testScopedChunkTargetValidationPrecedesBasePrefilter(): Promise<void> {
    const invalidTargets: Array<[string, any]> = [
        ['non-object target', null],
        ['empty field', { indexer: 'ChunkIndexer', field: '', operator: 'vector_near', value: [1] }],
        ['unsupported operator', { indexer: 'ChunkIndexer', field: 'chunk_text', operator: '=', value: [1] }],
        ['non-array vector', { indexer: 'ChunkIndexer', field: 'chunk_text', operator: 'vector_near', value: '1' }],
        [
            'non-finite typed vector',
            {
                indexer: 'ChunkIndexer',
                field: 'chunk_text',
                operator: 'vector_near',
                value: new Float32Array([Number.POSITIVE_INFINITY])
            }
        ],
        [
            'null vectorQuery',
            {
                indexer: 'ChunkIndexer',
                field: 'chunk_text',
                operator: 'vector_near',
                value: [1],
                vectorQuery: null
            }
        ],
        [
            'fractional topK',
            {
                indexer: 'ChunkIndexer',
                field: 'chunk_text',
                operator: 'vector_near',
                value: [1],
                vectorQuery: { topK: 1.5 }
            }
        ],
        [
            'non-string metric',
            {
                indexer: 'ChunkIndexer',
                field: 'chunk_text',
                operator: 'vector_near',
                value: [1],
                vectorQuery: { metric: 1 }
            }
        ],
        [
            'non-finite threshold',
            {
                indexer: 'ChunkIndexer',
                field: 'chunk_text',
                operator: 'vector_near',
                value: [1],
                vectorQuery: { threshold: Number.NaN }
            }
        ]
    ];

    for (const candidateItems of [[], [{ item_id: 'candidate', item_type: 'file' as const }]]) {
        const storage = new BaseStorage('scoped-chunk-validation', testSchema, tmpDir('scoped-chunk-validation'));
        let baseCalls = 0;
        let backendCalls = 0;
        let targetCalls = 0;
        (storage as any).baseIndexer = {
            search: async () => {
                baseCalls++;
                return { items: candidateItems, totalCount: candidateItems.length };
            }
        };
        (storage as any).chunkIndexer = {
            getBackend: () => {
                backendCalls++;
                return 'native';
            },
            searchChunks: async (_value: unknown, _query: unknown, ids: string[]) => {
                targetCalls++;
                assert.deepEqual(
                    ids,
                    candidateItems.map((item) => item.item_id)
                );
                return candidateItems.map((item) => ({
                    item_id: item.item_id,
                    chunk_id: 'chunk-1',
                    chunk_text: 'control',
                    similarity: 0.75
                }));
            }
        };
        const control = await storage.searchScope({
            preconditions: [{ indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }],
            targetCondition: {
                indexer: 'ChunkIndexer',
                field: 'chunk_text',
                operator: 'vector_near',
                value: [1],
                vectorQuery: { topK: 1 }
            }
        });
        assert.equal(baseCalls, 1);
        assert.equal(backendCalls, 1);
        assert.equal(targetCalls, candidateItems.length === 0 ? 0 : 1);
        assert.deepEqual(
            control.items.map((hit) => hit.item.item_id),
            candidateItems.map((item) => item.item_id)
        );
        baseCalls = 0;
        backendCalls = 0;
        targetCalls = 0;
        for (const [name, targetCondition] of invalidTargets) {
            await assert.rejects(
                () =>
                    storage.searchScope({
                        preconditions: [
                            { indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }
                        ],
                        targetCondition
                    }),
                ScopedSearchValidationError,
                `${name} must fail before a ${candidateItems.length === 0 ? 'potentially empty' : 'non-empty'} prefilter`
            );
        }
        assert.equal(baseCalls, 0);
        assert.equal(backendCalls, 0);
        assert.equal(targetCalls, 0);
    }
}

async function testNativeScopedChunkUsesExactCandidateTopK(): Promise<void> {
    const dir = tmpDir('native-scoped-chunk');
    const storage = await createTestStorage(dir);
    await storage.insert([
        makeItemWithChunks('outside', ['outside'], [0]),
        makeItemWithChunks('inside-best', ['inside best'], [1]),
        makeItemWithChunks('inside-worse', ['inside worse'], [2])
    ]);
    const result = await storage.searchScope({
        preconditions: [{ indexer: 'BaseIndexer', field: 'item_id', operator: 'like', value: 'inside%' }],
        targetCondition: {
            indexer: 'ChunkIndexer',
            field: 'chunk_text',
            operator: 'vector_near',
            value: makeOneHot(0),
            vectorQuery: { topK: 1, metric: 'cosine' }
        }
    });
    assert.equal(result.items.length, 1);
    assert.notEqual(result.items[0].item.item_id, 'outside');
    storage.close();
    cleanup(dir);
}

async function testArkDataScopedChunkBatchesGloballyAndFailsWholeTarget(): Promise<void> {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const previousArkData = process.env.ARKDATA_AVAILABLE;
    Object.defineProperty(process, 'platform', { value: 'openharmony', configurable: true });
    process.env.ARKDATA_AVAILABLE = '1';
    const candidates = Array.from({ length: 10001 }, (_, index) => ({
        item_id: `item-${index}`,
        item_type: 'file' as const,
        filename: `item-${index}`
    }));
    let searchCalls = 0;
    let failCall = 0;
    const sqlShapes: string[] = [];
    const batchSizes: number[] = [];
    const fakeKit: DatabaseKit = {
        available: async () => true,
        execSql: async () => {},
        execSqlParams: async () => {},
        querySqlShort: async () => [],
        openStore: async () => {},
        closeStore: async () => {},
        executePrepared: async () => ({ affectedRows: 0 }),
        executePreparedMany: async () => ({ affectedRows: 0 }),
        executePreparedManyBatched: async () => ({ affectedRows: 0 }),
        queryPrepared: async (_storeId, sql, params) => {
            if (!/AS distance/.test(sql)) return [];
            searchCalls++;
            sqlShapes.push(sql);
            batchSizes.push(params.length - 2);
            if (searchCalls === failCall) throw new Error('ark chunk batch failed');
            const rows = [
                { item_id: 'item-4999', chunk_id: 'c1', chunk_text: 'first', distance: 0.3 },
                { item_id: 'item-9999', chunk_id: 'c2', chunk_text: 'second', distance: 0.2 },
                { item_id: 'item-10000', chunk_id: 'c3', chunk_text: 'third', distance: 0.1 }
            ];
            return [rows[(searchCalls - 1) % 3]];
        },
        beginTransaction: async () => ({ id: 'fake-tx' }),
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        transaction: async (_storeId, txFn) => txFn({ id: 'fake-tx' })
    };
    const previousKit = setArkdataDatabaseKit(fakeKit);
    const storage = new BaseStorage('arkdata-scoped-chunk', testSchema, tmpDir('arkdata-scoped-chunk'));
    (storage as any).baseIndexer = {
        search: async () => ({ items: candidates, totalCount: candidates.length }),
        close: () => {}
    };
    await (storage as any).chunkIndexer.initialize();
    const request = {
        preconditions: [{ indexer: 'BaseIndexer', field: 'item_type', operator: '=' as const, value: 'file' }],
        targetCondition: {
            indexer: 'ChunkIndexer',
            field: 'chunk_text',
            operator: 'vector_near' as const,
            value: makeOneHot(0),
            vectorQuery: { topK: 2, metric: 'cosine' as const }
        }
    };
    try {
        const result = await storage.searchScope(request);
        assert.deepEqual(batchSizes, [5000, 5000, 1]);
        assert.equal(searchCalls, 3);
        assert(sqlShapes.every((sql) => /WHERE item_id IN \(/.test(sql)));
        assert.deepEqual(
            result.items.map((hit) => hit.item.item_id),
            ['item-10000', 'item-9999']
        );

        searchCalls = 0;
        failCall = 2;
        await assert.rejects(() => storage.searchScope(request), /ark chunk batch failed/);
        assert.equal(searchCalls, 2);
    } finally {
        storage.close();
        setArkdataDatabaseKit(previousKit);
        if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
        if (previousArkData === undefined) delete process.env.ARKDATA_AVAILABLE;
        else process.env.ARKDATA_AVAILABLE = previousArkData;
    }
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
        testInsertMissingFieldThrows,
        testScopedChunkSearchFiltersAndRestoresMetadata,
        testScopedChunkTargetValidationPrecedesBasePrefilter,
        testNativeScopedChunkUsesExactCandidateTopK,
        testArkDataScopedChunkBatchesGloballyAndFailsWholeTarget
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
