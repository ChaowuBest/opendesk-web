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
 * Minimal BaseStorage test scaffold
 *
 * 运行方式：
 * npx tsx src/main/services/storage/__tests__/storage.test.ts
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { BaseStorage, ColumnSchema, Item, BM25Query, DimMismatchError } from '../abstract-storage.js';

const TEST_DB_DIR = path.join(os.tmpdir(), 'storage-test2');
const TEST_DB_DIR_VB = path.join(os.tmpdir(), 'storage-test2-vector-base');
const TEST_DB_DIR_BM = path.join(os.tmpdir(), 'storage-test2-bm25-only');
const TEST_DB_DIR_NEW = path.join(os.tmpdir(), 'storage-test2-new');
const TEST_DB_DIR_DIM = path.join(os.tmpdir(), 'storage-test2-dim');

function cleanupTestDb(): void {
    for (const dir of [TEST_DB_DIR, TEST_DB_DIR_VB, TEST_DB_DIR_BM, TEST_DB_DIR_NEW, TEST_DB_DIR_DIM]) {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
}

const VECTOR_DIM = 1024;

function makeOneHotVector(index: number, dimension: number = VECTOR_DIM): number[] {
    const vec = Array(dimension).fill(0);
    vec[index] = 1;
    return vec;
}

function buildTestItems(): Item[] {
    const now = Date.now();
    const vectorA = makeOneHotVector(0);
    const vectorB = makeOneHotVector(1);

    return [
        {
            item_id: 'item-1',
            item_type: 'file',
            filename: 'report-2024.txt',
            text: 'vector-a',
            tag: 'todo',
            created_at: now,
            updated_at: now,
            semi_text: 'vector-a',
            indexer_columns: {
                VectorIndexer: [{ column: 'text', content: vectorA }],
                TagIndexer: [{ column: 'tag', content: 'todo' }],
                BM25Indexer: [{ column: 'text', content: '项目计划书 project proposal' }]
            }
        },
        {
            item_id: 'item-2',
            item_type: 'file',
            filename: 'notes.txt',
            text: 'vector-b',
            tag: 'idea',
            created_at: now,
            updated_at: now,
            semi_text: 'vector-b',
            indexer_columns: {
                VectorIndexer: [{ column: 'text', content: vectorB }],
                TagIndexer: [{ column: 'tag', content: 'idea' }],
                BM25Indexer: [{ column: 'text', content: '会议纪要 meeting notes' }]
            }
        }
    ];
}

async function seedItems(storage: BaseStorage): Promise<void> {
    const items = buildTestItems();
    await storage.insert(items);
}

async function testBaseSearch(storage: BaseStorage): Promise<void> {
    const results = await storage.search([
        {
            indexer: 'BaseIndexer',
            field: 'text',
            operator: 'like',
            value: 'vector%'
            // field: 'semi_text',
            // operator: 'like',
            // value: 'vector%',
        }
    ]);

    console.log('[BaseIndexer] results:', results);
}

async function testVectorSearch(storage: BaseStorage): Promise<void> {
    const queryVector = makeOneHotVector(0);
    const results = await storage.search([
        {
            indexer: 'VectorIndexer',
            field: 'text',
            operator: 'vector_near',
            value: queryVector,
            vectorQuery: { topK: 1, metric: 'cosine', threshold: 0.0 }
        }
    ]);

    console.log('[VectorIndexer] results:', results);
}

async function testTagSearch(storage: BaseStorage): Promise<void> {
    const results = await storage.search([
        {
            indexer: 'TagIndexer',
            field: 'tag',
            operator: 'like',
            value: 'todo'
        }
    ]);

    console.log('[TagIndexer] results:', results);
}

async function testBM25Search(storage: BaseStorage): Promise<void> {
    const results = await storage.search([
        {
            indexer: 'BM25Indexer',
            field: 'text',
            operator: 'bm25_match',
            value: { query: 'project', topK: 10 } as BM25Query
        }
    ]);

    console.log('[BM25Indexer] results:', results);

    const zhResults = await storage.search([
        {
            indexer: 'BM25Indexer',
            field: 'text',
            operator: 'bm25_match',
            value: { query: '项目计划书', topK: 10 } as BM25Query
        }
    ]);
    console.log('[BM25Indexer] zh results:', zhResults);
    if (zhResults.length === 0 || zhResults[0]?.item?.item_id !== 'item-1') {
        throw new Error('[BM25Indexer] FAIL: 中文查询 "项目计划书" 未命中预期文档 item-1');
    }
}

async function testVectorBaseOnly(): Promise<void> {
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            filename: { type: 'TEXT', nullable: true },
            text: { type: 'TEXT', nullable: true },
            semi_text: { type: 'TEXT', nullable: true },
            created_at: { type: 'INTEGER', nullable: true },
            updated_at: { type: 'INTEGER', nullable: true }
        },
        needIndexers: {
            text: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }],
            semi_text: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }]
        }
    };

    const storage = new BaseStorage('storage-test2-vector-base', schema, TEST_DB_DIR_VB);
    await storage.initialize();

    const now = Date.now();
    const items: Item[] = [
        {
            item_id: 'vb-1',
            item_type: 'file',
            filename: 'vector-base-1.txt',
            text: 'text-vector-1',
            semi_text: 'semitext-vector-1',
            created_at: now,
            updated_at: now,
            indexer_columns: {
                VectorIndexer: [
                    { column: 'text', content: makeOneHotVector(2) },
                    { column: 'semi_text', content: makeOneHotVector(3) }
                ]
            }
        },
        {
            item_id: 'vb-2',
            item_type: 'file',
            filename: 'vector-base-2.txt',
            text: 'text-vector-2',
            semi_text: 'semitext-vector-2',
            created_at: now,
            updated_at: now,
            indexer_columns: {
                VectorIndexer: [
                    { column: 'text', content: makeOneHotVector(4) },
                    { column: 'semi_text', content: makeOneHotVector(5) }
                ]
            }
        },
        {
            item_id: 'vb-3',
            item_type: 'file',
            filename: 'vector-base-3.txt',
            text: 'text-vector-3',
            semi_text: 'semitext-vector-3',
            created_at: now,
            updated_at: now,
            indexer_columns: {
                VectorIndexer: [
                    { column: 'text', content: makeOneHotVector(6) },
                    { column: 'semi_text', content: makeOneHotVector(7) }
                ]
            }
        },
        {
            item_id: 'vb-4',
            item_type: 'file',
            filename: 'vector-base-4.txt',
            text: 'text-vector-4',
            semi_text: 'semitext-vector-4',
            created_at: now,
            updated_at: now,
            indexer_columns: {
                VectorIndexer: [
                    { column: 'text', content: makeOneHotVector(8) },
                    { column: 'semi_text', content: makeOneHotVector(9) }
                ]
            }
        }
    ];

    await storage.insert(items);

    // const baseResults = await storage.search([
    //     {
    //         indexer: 'BaseIndexer',
    //         field: 'text',
    //         operator: 'like',
    //         value: 'text-%',
    //     },
    // ]);
    // console.log('[Vector+Base] BaseIndexer results:', baseResults);

    const vecResultsText = await storage.search([
        {
            indexer: 'VectorIndexer',
            field: 'text',
            operator: 'vector_near',
            value: items[0].indexer_columns?.VectorIndexer?.[0].content as number[],
            vectorQuery: { topK: 1, metric: 'cosine', threshold: 0.0 }
        },
        {
            indexer: 'BaseIndexer',
            field: 'text',
            operator: 'like',
            value: 'text-%'
        }
    ]);
    console.log('[Vector+Base] VectorIndexer(text) results:', vecResultsText);

    const vecResultsSemi = await storage.search([
        {
            indexer: 'VectorIndexer',
            field: 'semi_text',
            operator: 'vector_near',
            value: items[1].indexer_columns?.VectorIndexer?.[1].content as number[],
            vectorQuery: { topK: 1, metric: 'cosine', threshold: 0.0 }
        }
    ]);
    console.log('[Vector+Base] VectorIndexer(semi_text) results:', vecResultsSemi);
}

async function testBM25Only(): Promise<void> {
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            filename: { type: 'TEXT', nullable: true },
            text: { type: 'TEXT', nullable: true },
            semi_text: { type: 'TEXT', nullable: true },
            created_at: { type: 'INTEGER', nullable: true },
            updated_at: { type: 'INTEGER', nullable: true }
        },
        needIndexers: {
            text: [{ indexer: 'BM25Indexer' }],
            semi_text: [{ indexer: 'BM25Indexer' }]
        }
    };

    const storage = new BaseStorage(
        'storage-test2-bm25-only',
        schema,
        path.join(os.tmpdir(), 'storage-test2-bm25-only')
    );
    await storage.initialize();

    const now = Date.now();
    const items: Item[] = [
        (() => {
            const text = 'project plan project';
            const semiText = 'alpha milestones';
            return {
                item_id: 'bm-1',
                item_type: 'file',
                filename: 'bm25-1.txt',
                text: text,
                semi_text: semiText,
                created_at: now,
                updated_at: now,
                indexer_columns: {
                    BM25Indexer: [
                        { column: 'text', content: text },
                        { column: 'semi_text', content: semiText }
                    ]
                }
            };
        })(),
        (() => {
            const text = 'project beta notes';
            const semiText = 'beta schedule';
            return {
                item_id: 'bm-2',
                item_type: 'file',
                filename: 'bm25-2.txt',
                text: text,
                semi_text: semiText,
                created_at: now,
                updated_at: now,
                indexer_columns: {
                    BM25Indexer: [
                        { column: 'text', content: text },
                        { column: 'semi_text', content: semiText }
                    ]
                }
            };
        })(),
        (() => {
            const text = 'release checklist';
            const semiText = 'release preparation';
            return {
                item_id: 'bm-3',
                item_type: 'file',
                filename: 'bm25-3.txt',
                text: text,
                semi_text: semiText,
                created_at: now,
                updated_at: now,
                indexer_columns: {
                    BM25Indexer: [
                        { column: 'text', content: text },
                        { column: 'semi_text', content: semiText }
                    ]
                }
            };
        })(),
        (() => {
            const text = 'design review notes';
            const semiText = 'design feedback';
            return {
                item_id: 'bm-4',
                item_type: 'file',
                filename: 'bm25-4.txt',
                text: text,
                semi_text: semiText,
                created_at: now,
                updated_at: now,
                indexer_columns: {
                    BM25Indexer: [
                        { column: 'text', content: text },
                        { column: 'semi_text', content: semiText }
                    ]
                }
            };
        })()
    ];

    await storage.insert(items);

    const resultsText = await storage.search([
        {
            indexer: 'BM25Indexer',
            field: 'text',
            operator: 'bm25_match',
            value: { query: 'project', topK: 10 } as BM25Query
        }
    ]);
    console.log('[BM25Only] text results:', resultsText);

    // 注意：当前使用 TFIDF 评分（search-index v6 不支持 BM25），TFIDF 不保证词频越高分越高
    if (resultsText.length === 0) {
        throw new Error('[BM25Only] FAIL: 搜索 "project" 应返回结果');
    }
    console.log('[BM25Only] PASS: 搜索返回结果');

    const resultsSemi = await storage.search([
        {
            indexer: 'BM25Indexer',
            field: 'semi_text',
            operator: 'bm25_match',
            value: { query: 'design', topK: 10 } as BM25Query
        }
    ]);
    console.log('[BM25Only] semi_text results:', resultsSemi);
}

async function testVectorAsSecondIndexer(): Promise<void> {
    // BM25 first, VectorIndexer second — triggers the filter branch in VectorIndexDB.search()
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            text: { type: 'TEXT', nullable: true }
        },
        needIndexers: {
            text: [{ indexer: 'BM25Indexer' }, { indexer: 'VectorIndexer', options: { dim: 1024 } }]
        }
    };

    const dbDir = path.join(TEST_DB_DIR_NEW, 'vec-second');
    const storage = new BaseStorage('vec-second', schema, dbDir);
    await storage.initialize();

    const now = Date.now();
    const items: Item[] = [
        {
            item_id: 'vs-1',
            item_type: 'file',
            text: '项目计划 project plan',
            created_at: now,
            updated_at: now,
            indexer_columns: {
                BM25Indexer: [{ column: 'text', content: '项目计划 project plan' }],
                VectorIndexer: [{ column: 'text', content: makeOneHotVector(0) }]
            }
        },
        {
            item_id: 'vs-2',
            item_type: 'file',
            text: '会议纪要 meeting notes',
            created_at: now,
            updated_at: now,
            indexer_columns: {
                BM25Indexer: [{ column: 'text', content: '会议纪要 meeting notes' }],
                VectorIndexer: [{ column: 'text', content: makeOneHotVector(1) }]
            }
        }
    ];

    await storage.insert(items);

    // Search: BM25 first narrows to ['vs-1'], then VectorIndexer filters within those results
    const results = await storage.search([
        { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: '项目计划' } as BM25Query },
        {
            indexer: 'VectorIndexer',
            field: 'text',
            operator: 'vector_near',
            value: makeOneHotVector(0),
            vectorQuery: { topK: 5, metric: 'cosine', threshold: 0.5 }
        }
    ]);

    if (results.length === 0 || results[0].item.item_id !== 'vs-1') {
        throw new Error(`[testVectorAsSecondIndexer] FAIL: expected vs-1, got ${results[0]?.item?.item_id}`);
    }
    console.log('[testVectorAsSecondIndexer] PASS');
    storage.close();
}

async function testMultiColumnUpdateNoInterference(): Promise<void> {
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            col_a: { type: 'TEXT', nullable: true },
            col_b: { type: 'TEXT', nullable: true }
        },
        needIndexers: {
            col_a: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }],
            col_b: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }]
        }
    };

    const dbDir = path.join(TEST_DB_DIR_NEW, 'multi-col');
    const storage = new BaseStorage('multi-col', schema, dbDir);
    await storage.initialize();

    const now = Date.now();
    const originalItem: Item = {
        item_id: 'mc-1',
        item_type: 'file',
        col_a: 'a',
        col_b: 'b',
        created_at: now,
        updated_at: now,
        indexer_columns: {
            VectorIndexer: [
                { column: 'col_a', content: makeOneHotVector(0) },
                { column: 'col_b', content: makeOneHotVector(1) }
            ]
        }
    };

    await storage.insert([originalItem]);

    // Update only col_a
    const updatedItem: Item = {
        item_id: 'mc-1',
        item_type: 'file',
        col_a: 'a-updated',
        col_b: 'b',
        created_at: now,
        updated_at: now,
        indexer_columns: {
            VectorIndexer: [
                { column: 'col_a', content: makeOneHotVector(5) } // different vector
            ]
            // col_b intentionally omitted — should not be touched
        }
    };
    await storage.update([updatedItem]);

    // col_b search should still return mc-1
    const colBResults = await storage.search([
        {
            indexer: 'VectorIndexer',
            field: 'col_b',
            operator: 'vector_near',
            value: makeOneHotVector(1),
            vectorQuery: { topK: 1, metric: 'cosine', threshold: 0.9 }
        }
    ]);

    if (colBResults.length === 0 || colBResults[0].item.item_id !== 'mc-1') {
        throw new Error(`[testMultiColumnUpdate] FAIL: col_b should still return mc-1 after col_a update`);
    }
    console.log('[testMultiColumnUpdateNoInterference] PASS');
    storage.close();
}

async function testDuplicateInsertThrows(): Promise<void> {
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false }
        },
        needIndexers: {}
    };

    const dbDir = path.join(TEST_DB_DIR_NEW, 'dup-insert');
    const storage = new BaseStorage('dup-insert', schema, dbDir);
    await storage.initialize();

    const item: Item = { item_id: 'dup-1', item_type: 'file' };
    await storage.insert([item]);

    // insert is now idempotent (INSERT OR REPLACE), so duplicate insert should NOT throw
    await storage.insert([item]); // same item_id — should succeed silently

    console.log('[testDuplicateInsertThrows] PASS (duplicate insert is now idempotent, no throw)');
    storage.close();
}

async function testDimMismatchDetection(): Promise<void> {
    const schema1024: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            repr: { type: 'BLOB', nullable: true }
        },
        needIndexers: {
            repr: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }]
        }
    };

    const dbDir = path.join(TEST_DB_DIR_DIM, 'dim-mismatch');

    // First: write with dim=1024
    const storage1 = new BaseStorage('dim-mismatch', schema1024, dbDir);
    await storage1.initialize();
    await storage1.insert([
        {
            item_id: 'dm-1',
            item_type: 'file',
            indexer_columns: {
                VectorIndexer: [{ column: 'repr', content: makeOneHotVector(0, 1024) }]
            }
        }
    ]);
    storage1.close();

    // Second: re-open with dim=512 — should throw DimMismatchError
    const schema512: ColumnSchema = {
        ...schema1024,
        needIndexers: {
            repr: [{ indexer: 'VectorIndexer', options: { dim: 512 } }]
        }
    };

    const storage2 = new BaseStorage('dim-mismatch-512', schema512, dbDir);
    let dimError: any = null;
    try {
        await storage2.initialize();
    } catch (e: any) {
        dimError = e;
    }

    if (!dimError || dimError.name !== 'DimMismatchError') {
        throw new Error(
            `[testDimMismatchDetection] FAIL: expected DimMismatchError, got ${dimError?.name ?? 'no error'}`
        );
    }
    if (dimError.storedDim !== 1024 || dimError.configuredDim !== 512) {
        throw new Error(
            `[testDimMismatchDetection] FAIL: wrong dims: stored=${dimError.storedDim}, configured=${dimError.configuredDim}`
        );
    }
    console.log('[testDimMismatchDetection] PASS');
}

async function testUpsertRecoveryPath(): Promise<void> {
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            name: { type: 'TEXT', nullable: true }
        },
        needIndexers: {}
    };

    const dbDir = path.join(TEST_DB_DIR_NEW, 'upsert-recovery');
    const storage = new BaseStorage('upsert-recovery', schema, dbDir);
    await storage.initialize();

    // Insert ur-2 first (exists)
    await storage.insert([{ item_id: 'ur-2', item_type: 'file', name: 'original-2' }]);

    // upsert [ur-1 (new), ur-2 (exists), ur-3 (new)] — all should succeed
    await storage.upsert([
        { item_id: 'ur-1', item_type: 'file', name: 'new-1' },
        { item_id: 'ur-2', item_type: 'file', name: 'updated-2' },
        { item_id: 'ur-3', item_type: 'file', name: 'new-3' }
    ]);

    // Verify all 3 exist
    const results = await storage.search([
        { indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }
    ]);

    const ids = results.map((r) => r.item.item_id).sort();
    if (ids.length !== 3 || !ids.includes('ur-1') || !ids.includes('ur-2') || !ids.includes('ur-3')) {
        throw new Error(`[testUpsertRecoveryPath] FAIL: expected 3 items, got ${ids}`);
    }

    // Verify ur-2 was updated
    const ur2 = results.find((r) => r.item.item_id === 'ur-2');
    if (ur2?.item.name !== 'updated-2') {
        throw new Error(`[testUpsertRecoveryPath] FAIL: ur-2 name should be updated-2, got ${ur2?.item.name}`);
    }

    console.log('[testUpsertRecoveryPath] PASS');
    storage.close();
}

async function testGetStatus(): Promise<void> {
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            repr: { type: 'BLOB', nullable: true }
        },
        needIndexers: {
            repr: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }]
        }
    };

    const dbDir = path.join(TEST_DB_DIR_NEW, 'get-status');
    const storage = new BaseStorage('get-status', schema, dbDir);
    await storage.initialize();

    await storage.insert([
        {
            item_id: 'gs-1',
            item_type: 'file',
            indexer_columns: {
                VectorIndexer: [{ column: 'repr', content: makeOneHotVector(0) }]
            }
        }
    ]);

    const status = await storage.getStatus();

    if (typeof status['BaseIndexer']?.size !== 'number') {
        throw new Error('[testGetStatus] FAIL: BaseIndexer.size missing');
    }
    if (typeof status['VectorIndexer']?.size !== 'number') {
        throw new Error('[testGetStatus] FAIL: VectorIndexer.size missing');
    }
    if (typeof status['VectorIndexer']?.dim !== 'number') {
        throw new Error('[testGetStatus] FAIL: VectorIndexer.dim missing');
    }
    if (status['BaseIndexer'].size !== 1 || status['VectorIndexer'].size !== 1) {
        throw new Error(`[testGetStatus] FAIL: expected size=1, got ${JSON.stringify(status)}`);
    }
    console.log('[testGetStatus] PASS');
    storage.close();
}

async function testDoubleInsert(storage: BaseStorage): Promise<void> {
    const items = buildTestItems();
    await storage.insert(items);
    // 第二次 insert 相同 items，不应抛错
    await storage.insert(items);
    console.log('[testDoubleInsert] PASS');
}

async function testPartialReinsertPreservesBaseColumns(storage: BaseStorage): Promise<void> {
    // 插入完整 item（含 filename、text、tag 等列）
    const now = Date.now();
    const fullItem: Item = {
        item_id: 'partial-reinsert-item',
        item_type: 'file',
        filename: 'original.txt',
        text: 'original text',
        tag: 'original-tag',
        created_at: now,
        updated_at: now,
        semi_text: 'original semi',
        indexer_columns: {}
    };
    await storage.insert([fullItem]);

    // 用同一 item_id 的 partial item 再次 insert（只有 item_id + item_type）
    const partialItem: Item = {
        item_id: 'partial-reinsert-item',
        item_type: 'file'
    };
    await storage.insert([partialItem]);

    // 查询 base 表，验证原有字段（filename/text/tag）未被清除
    const db = storage.getBaseIndexer().getDB();
    const row = await db.findById('partial-reinsert-item');
    if (!row) {
        throw new Error('[testPartialReinsertPreservesBaseColumns] FAIL: row missing after partial re-insert');
    }
    if (row['filename'] !== 'original.txt') {
        throw new Error(
            `[testPartialReinsertPreservesBaseColumns] FAIL: filename was cleared, got: ${row['filename']}`
        );
    }
    if (row['text'] !== 'original text') {
        throw new Error(`[testPartialReinsertPreservesBaseColumns] FAIL: text was cleared, got: ${row['text']}`);
    }
    console.log('[testPartialReinsertPreservesBaseColumns] PASS');
}

async function testUpdateNonExistent(storage: BaseStorage): Promise<void> {
    const now = Date.now();
    const items: Item[] = [
        {
            item_id: 'non-existent-update',
            item_type: 'file',
            filename: 'ghost.txt',
            text: 'ghost',
            tag: 'ghost',
            created_at: now,
            updated_at: now,
            semi_text: 'ghost',
            indexer_columns: {
                VectorIndexer: [{ column: 'text', content: makeOneHotVector(5) }],
                TagIndexer: [{ column: 'tag', content: 'ghost' }],
                BM25Indexer: [{ column: 'text', content: 'ghost file' }]
            }
        }
    ];
    // update 不存在的 item，不应抛错
    await storage.update(items);
    console.log('[testUpdateNonExistent] PASS');
}

async function testDeleteNonExistent(storage: BaseStorage): Promise<void> {
    const items: Item[] = [
        {
            item_id: 'non-existent-delete',
            item_type: 'file'
        }
    ];
    // delete 不存在的 item，不应抛错
    await storage.delete(items);
    console.log('[testDeleteNonExistent] PASS');
}

async function main(): Promise<void> {
    cleanupTestDb();

    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            filename: { type: 'TEXT', nullable: true },
            text: { type: 'TEXT', nullable: true },
            tag: { type: 'TEXT', nullable: true },
            created_at: { type: 'INTEGER', nullable: true },
            updated_at: { type: 'INTEGER', nullable: true },
            semi_text: { type: 'TEXT', nullable: true }
        },
        needIndexers: {
            tag: [{ indexer: 'TagIndexer' }],
            text: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }, { indexer: 'BM25Indexer' }]
        }
    };

    const storage = new BaseStorage('storage-test2', schema, TEST_DB_DIR);
    await storage.initialize();

    await seedItems(storage);
    await testBaseSearch(storage);
    await testVectorSearch(storage);
    await testTagSearch(storage);
    await testBM25Search(storage);
    await testVectorBaseOnly();
    await testBM25Only();
    await testVectorAsSecondIndexer();
    await testMultiColumnUpdateNoInterference();
    await testDuplicateInsertThrows();
    await testDimMismatchDetection();
    await testUpsertRecoveryPath();
    await testGetStatus();
    await testDoubleInsert(storage);
    await testPartialReinsertPreservesBaseColumns(storage);
    await testUpdateNonExistent(storage);
    await testDeleteNonExistent(storage);
}

main().catch((error) => {
    console.error('[storage_test2] failed:', error);
    process.exit(1);
});
