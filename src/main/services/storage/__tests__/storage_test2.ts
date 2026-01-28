/**
 * Minimal BaseStorage test scaffold
 *
 * 运行方式：
 * npx tsx src/main/services/storage/__tests__/storage_test2.ts
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { BaseStorage, ColumnSchema, Item } from '../abstrac-storage.js';

const TEST_DB_DIR = path.join(os.tmpdir(), 'storage-test2');

function cleanupTestDb(): void {
    if (fs.existsSync(TEST_DB_DIR)) {
        fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
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
            text: ['VectorIndexer'],
        },
    };

    const storage = new BaseStorage('storage-test2', schema, TEST_DB_DIR);
    await storage.initialize();

    await seedItems(storage);
    await testBaseSearch(storage);
    await testVectorSearch(storage);
    await testTagSearch(storage);
}

main().catch((error) => {
    console.error('[storage_test2] failed:', error);
    process.exit(1);
});
