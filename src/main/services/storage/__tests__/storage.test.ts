/**
 * Minimal BaseStorage test scaffold
 *
 * 运行方式：
 * npx tsx src/main/services/storage/__tests__/storage.test.ts
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { BaseStorage, ColumnSchema, Item, BM25Query } from '../abstrac-storage.js';

const TEST_DB_DIR = path.join(os.tmpdir(), 'storage-test2');
const TEST_DB_DIR_VB = path.join(os.tmpdir(), 'storage-test2-vector-base');
const TEST_DB_DIR_BM = path.join(os.tmpdir(), 'storage-test2-bm25-only');

function cleanupTestDb(): void {
    if (fs.existsSync(TEST_DB_DIR)) {
        fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
    if (fs.existsSync(TEST_DB_DIR_VB)) {
        fs.rmSync(TEST_DB_DIR_VB, { recursive: true, force: true });
    }
    if (fs.existsSync(TEST_DB_DIR_BM)) {
        fs.rmSync(TEST_DB_DIR_BM, { recursive: true, force: true });
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
                BM25Indexer: [{ column: 'text', content: '项目计划书 project proposal' }],
            },
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
                BM25Indexer: [{ column: 'text', content: '会议纪要 meeting notes' }],
            },
        },
    ];
}

async function seedItems(storage: BaseStorage): Promise<void> {
    const items = buildTestItems();
    await storage.insert(items);
}

async function testBaseSearch(storage: BaseStorage): Promise<void> {
    const results = await storage.search([], [
        {
            indexer: 'BaseIndexer',
            field: 'text',
            operator: 'like',
            value: 'vector%',
            // field: 'semi_text',
            // operator: 'like',
            // value: 'vector%',
        },
    ]);

    console.log('[BaseIndexer] results:', results);
}

async function testVectorSearch(storage: BaseStorage): Promise<void> {
    const queryVector = makeOneHotVector(0);
    const results = await storage.search([], [
        {
            indexer: 'VectorIndexer',
            field: 'repr',
            operator: 'vector_near',
            value: queryVector,
            vectorQuery: { topK: 1, metric: 'cosine', threshold: 0.0 },
        },
    ]);

    console.log('[VectorIndexer] results:', results);
}

async function testTagSearch(storage: BaseStorage): Promise<void> {
    const results = await storage.search([], [
        {
            indexer: 'TagIndexer',
            field: 'tag',
            operator: 'like',
            value: 'todo',
        },
    ]);

    console.log('[TagIndexer] results:', results);
}

async function testBM25Search(storage: BaseStorage): Promise<void> {
    const results = await storage.search([], [
        {
            indexer: 'BM25Indexer',
            field: 'text',
            operator: 'bm25_match',
            value: { query: 'project', topK: 10 } as BM25Query,
        },
    ]);

    console.log('[BM25Indexer] results:', results);
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
            updated_at: { type: 'INTEGER', nullable: true },
        },
        needIndexers: {
            text: ['VectorIndexer'],
            semi_text: ['VectorIndexer'],
        },
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
                    { column: 'semi_text', content: makeOneHotVector(3) },
                ],
            },
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
                    { column: 'semi_text', content: makeOneHotVector(5) },
                ],
            },
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
                    { column: 'semi_text', content: makeOneHotVector(7) },
                ],
            },
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
                    { column: 'semi_text', content: makeOneHotVector(9) },
                ],
            },
        },
    ];

    await storage.insert(items);

    // const baseResults = await storage.search([], [
    //     {
    //         indexer: 'BaseIndexer',
    //         field: 'text',
    //         operator: 'like',
    //         value: 'text-%',
    //     },
    // ]);
    // console.log('[Vector+Base] BaseIndexer results:', baseResults);

    const vecResultsText = await storage.search([], [
        {
            indexer: 'VectorIndexer',
            field: 'text',
            operator: 'vector_near',
            value: items[0].indexer_columns?.VectorIndexer?.[0].content as number[],
            vectorQuery: { topK: 1, metric: 'cosine', threshold: 0.0 },
        },
        {
            indexer: 'BaseIndexer',
            field: 'text',
            operator: 'like',
            value: 'text-%',
        }
    ]);
    console.log('[Vector+Base] VectorIndexer(text) results:', vecResultsText);

    const vecResultsSemi = await storage.search([], [
        {
            indexer: 'VectorIndexer',
            field: 'semi_text',
            operator: 'vector_near',
            value: items[1].indexer_columns?.VectorIndexer?.[1].content as number[],
            vectorQuery: { topK: 1, metric: 'cosine', threshold: 0.0 },
        },
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
            updated_at: { type: 'INTEGER', nullable: true },
        },
        needIndexers: {
            text: ['BM25Indexer'],
            semi_text: ['BM25Indexer'],
        },
    };

    const storage = new BaseStorage('storage-test2-bm25-only', schema, path.join(os.tmpdir(), 'storage-test2-bm25-only'));
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
                        { column: 'semi_text', content: semiText },
                    ],
                },
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
                        { column: 'semi_text', content: semiText },
                    ],
                },
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
                        { column: 'semi_text', content: semiText },
                    ],
                },
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
                        { column: 'semi_text', content: semiText },
                    ],
                },
            };
        })(),
    ];

    await storage.insert(items);

    const resultsText = await storage.search([], [
        {
            indexer: 'BM25Indexer',
            field: 'text',
            operator: 'bm25_match',
            value: { query: 'project', topK: 10 } as BM25Query,
        },
    ]);
    console.log('[BM25Only] text results:', resultsText);

    // 校验词频：'project plan project' 包含 2 个 project，应该排在 'project beta notes' 前面
    if (resultsText.length >= 2) {
        const scores = resultsText.map(r => r.BM25Score ?? 0);
        if (scores[0] <= scores[1]) {
            console.error('[BM25Only] FAIL: 词频高的文档应该有更高的 BM25Score');
            console.error(`  bm-1 (2个project) score: ${scores[0]}, bm-2 (1个project) score: ${scores[1]}`);
        } else {
            console.log('[BM25Only] PASS: 词频校验通过');
        }
    }

    const resultsSemi = await storage.search([], [
        {
            indexer: 'BM25Indexer',
            field: 'semi_text',
            operator: 'bm25_match',
            value: { query: 'design', topK: 10 } as BM25Query,
        },
    ]);
    console.log('[BM25Only] semi_text results:', resultsSemi);
}

async function main(): Promise<void> {
    cleanupTestDb();
    // TODO: 在这里补充/调整 schema 字段
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            filename: { type: 'TEXT', nullable: true },
            text: { type: 'TEXT', nullable: true },
            tag: { type: 'TEXT', nullable: true },
            created_at: { type: 'INTEGER', nullable: true },
            updated_at: { type: 'INTEGER', nullable: true },
            semi_text: { type: 'TEXT', nullable: true },
        },
        needIndexers: {
            tag: ['TagIndexer'],
            text: ['VectorIndexer', 'BM25Indexer'],
        },
    };

    const storage = new BaseStorage('storage-test2', schema, TEST_DB_DIR);
    await storage.initialize();

    await seedItems(storage);
    // await testBaseSearch(storage);
    // await testVectorSearch(storage);
    // await testTagSearch(storage);
    // await testBM25Search(storage);
    // await testVectorBaseOnly();
    await testBM25Only();
}

main().catch((error) => {
    console.error('[storage_test2] failed:', error);
    process.exit(1);
});
