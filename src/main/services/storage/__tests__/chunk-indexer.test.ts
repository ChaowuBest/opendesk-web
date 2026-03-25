/**
 * ChunkIndexer 集成测试
 *
 * 运行方式：
 *   npx tsx src/main/services/storage/__tests__/chunk-indexer.test.ts
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { BaseStorage, ColumnSchema, Item, SearchItem } from '../abstract-storage.js';

const TEST_DB_DIR = path.join(os.tmpdir(), 'chunk-indexer-test');
// BaseStorage 初始化 ChunkIndexer 时固定使用 dimension=1024（与 VectorIndexer 保持一致）
// 测试必须使用相同维度，否则 validateDimension 会在 insertMany 时报错
const VECTOR_DIM = 1024;

function cleanupTestDb(): void {
    if (fs.existsSync(TEST_DB_DIR)) {
        fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
}

// ── 测试用 Schema（包含 ChunkIndexer）─────────────────────────────
const testSchema: ColumnSchema = {
    columns: {
        item_id:    { type: 'TEXT', nullable: false },
        item_type:  { type: 'TEXT', nullable: false },
        filename:   { type: 'TEXT', nullable: true },
        chunk_text: { type: 'TEXT', nullable: true },  // 占位列，BaseIndexer 中永远 NULL
    },
    needIndexers: {
        chunk_text: [{ indexer: 'ChunkIndexer' }],
    },
};

const conflictingChunkDimSchema: ColumnSchema = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false },
        chunk_text_a: { type: 'TEXT', nullable: true },
        chunk_text_b: { type: 'TEXT', nullable: true },
    },
    needIndexers: {
        chunk_text_a: [{ indexer: 'ChunkIndexer' }],
        chunk_text_b: [{ indexer: 'ChunkIndexer', options: { dim: 1536 } }],
    },
};

// ── 向量工具 ────────────────────────────────────────────────────────
function makeOneHot(index: number, dim = VECTOR_DIM): number[] {
    const v = Array(dim).fill(0);
    v[index] = 1;
    return v;
}

// ── 测试用 Item ──────────────────────────────────────────────────────
function makeItemWithChunks(itemId: string, chunkTexts: string[], vectorIndices: number[]): Item {
    return {
        item_id: itemId,
        item_type: 'file',
        filename: `${itemId}.txt`,
        chunk_text: null,  // BaseIndexer 中永远 NULL
        indexer_columns: {
            ChunkIndexer: chunkTexts.map((text, i) => ({
                column: 'chunk_text',
                content: makeOneHot(vectorIndices[i]),
                id: `${itemId}:chunk:${i}`,
                text,
            })),
        },
    };
}

function makeItemWithoutChunks(itemId: string): Item {
    return {
        item_id: itemId,
        item_type: 'file',
        filename: `${itemId}.txt`,
        chunk_text: null,
    };
}

// ── 断言工具 ─────────────────────────────────────────────────────────
function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(`ASSERTION FAILED: ${message}`);
    }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
        throw new Error(`ASSERTION FAILED: ${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual:   ${JSON.stringify(actual)}`);
    }
}

// ── 测试套件 ─────────────────────────────────────────────────────────

async function testInsertAndSearch(): Promise<void> {
    console.log('  [1] insert + search (basic)');
    cleanupTestDb();
    const storage = new BaseStorage('test', testSchema, TEST_DB_DIR);
    await storage.initialize();

    // 插入两个文件，各有 2 个 chunk
    const items = [
        makeItemWithChunks('doc-1', ['第一段内容', '第二段内容'], [0, 1]),
        makeItemWithChunks('doc-2', ['第三段内容', '第四段内容'], [2, 3]),
    ];
    await storage.insert(items);

    // 查询与 chunk[0] (index=0) 最相似的 chunk
    const results = await storage.search([
        {
            indexer: 'ChunkIndexer',
            field: 'chunk_text',
            operator: 'vector_near',
            value: makeOneHot(0),
            vectorQuery: { topK: 4, metric: 'cosine', threshold: 0.0 },
        },
    ]);

    assert(results.length > 0, 'Should return at least 1 result');
    assert(results[0].chunk_id !== undefined, 'Result should have chunk_id');
    assert(results[0].chunk_text !== undefined, 'Result should have chunk_text');
    assert(results[0].ChunkScore !== undefined, 'Result should have ChunkScore');
    assertEqual(results[0].chunk_text, '第一段内容', 'Top result should be chunk 0 of doc-1');
    assertEqual(results[0].item.item_id, 'doc-1', 'Top result item should be doc-1');

    storage.close();
    console.log('    ✓ insert + search passed');
}

async function testChunkDoubleInsert(storage: BaseStorage): Promise<void> {
    const item = makeItemWithChunks('double-insert-item', ['内容A', '内容B'], [0, 1]); // 使用现有的 makeItemWithChunks 辅助函数
    await storage.insert([item]);
    // 第二次 insert 相同 item，不应抛错，应覆盖旧 chunk records
    await storage.insert([item]);
    // 验证数据正确性：upsert 语义应覆盖，chunk 数量应为 2（不应变成 4）
    const status = await storage.getStatus();
    assertEqual(status.ChunkIndexer.size, 2, 'Double insert should upsert (chunk count should be 2, not 4)');
}

async function testDeleteCleansChunks(): Promise<void> {
    console.log('  [3] delete removes all chunks');
    cleanupTestDb();
    const storage = new BaseStorage('test', testSchema, TEST_DB_DIR);
    await storage.initialize();

    const item = makeItemWithChunks('doc-1', ['内容A', '内容B'], [0, 1]);
    await storage.insert([item]);
    await storage.delete([{ item_id: 'doc-1', item_type: 'file' }]);

    // 搜索应无结果
    const results = await storage.search([
        {
            indexer: 'ChunkIndexer',
            field: 'chunk_text',
            operator: 'vector_near',
            value: makeOneHot(0),
            vectorQuery: { topK: 5, metric: 'cosine', threshold: 0.0 },
        },
    ]);
    assertEqual(results.length, 0, 'After delete, search should return empty');

    storage.close();
    console.log('    ✓ delete clears chunks');
}

async function testUpdateFullReplace(): Promise<void> {
    console.log('  [4] update = full replace');
    cleanupTestDb();
    const storage = new BaseStorage('test', testSchema, TEST_DB_DIR);
    await storage.initialize();

    // 插入初始 chunk（index=0, index=1）
    const item = makeItemWithChunks('doc-1', ['旧内容A', '旧内容B'], [0, 1]);
    await storage.insert([item]);

    // update: 全量替换为 index=2, index=3
    const updated = makeItemWithChunks('doc-1', ['新内容C', '新内容D'], [2, 3]);
    await storage.update([updated]);

    // 查询旧 chunk（index=0），应无结果
    // threshold: 0.6 > 0.5（正交向量相似度），确保新 chunk（index=2,3）不被误召回
    const oldResults = await storage.search([
        {
            indexer: 'ChunkIndexer',
            field: 'chunk_text',
            operator: 'vector_near',
            value: makeOneHot(0),
            vectorQuery: { topK: 4, metric: 'cosine', threshold: 0.6 },
        },
    ]);
    assertEqual(oldResults.length, 0, 'Old chunks should be gone after update');

    // 查询新 chunk（index=2），应命中
    const newResults = await storage.search([
        {
            indexer: 'ChunkIndexer',
            field: 'chunk_text',
            operator: 'vector_near',
            value: makeOneHot(2),
            vectorQuery: { topK: 4, metric: 'cosine', threshold: 0.5 },
        },
    ]);
    assert(newResults.length > 0, 'New chunks should be found after update');
    assertEqual(newResults[0].chunk_text, '新内容C', 'Should find new chunk text');

    storage.close();
    console.log('    ✓ update full replace works');
}

async function testItemWithoutChunksInsertOK(): Promise<void> {
    console.log('  [5] item without chunks inserts ok');
    cleanupTestDb();
    const storage = new BaseStorage('test', testSchema, TEST_DB_DIR);
    await storage.initialize();

    // 无 chunk 的文件
    const item = makeItemWithoutChunks('doc-empty');
    await storage.insert([item]);  // 不应报错

    storage.close();
    console.log('    ✓ item without chunks insert ok');
}

async function testBaseIndexerFilterInSearch(): Promise<void> {
    console.log('  [6] BaseIndexer filter in searchWithChunkIndexer');
    cleanupTestDb();
    const storage = new BaseStorage('test', testSchema, TEST_DB_DIR);
    await storage.initialize();

    // 插入两个文件，chunk 向量相同（index=0）
    const items = [
        makeItemWithChunks('doc-file', ['内容', ''], [0, 1]),
        {
            item_id: 'mail-1',
            item_type: 'mail' as const,
            filename: null,
            chunk_text: null,
            indexer_columns: {
                ChunkIndexer: [
                    { column: 'chunk_text', content: makeOneHot(0), id: 'mail-1:chunk:0', text: 'mail 内容' },
                ],
            },
        },
    ];
    await storage.insert(items);

    // 搜索时加 BaseIndexer 过滤：只要 item_type = 'file'
    const results = await storage.search([
        {
            indexer: 'ChunkIndexer',
            field: 'chunk_text',
            operator: 'vector_near',
            value: makeOneHot(0),
            vectorQuery: { topK: 4, metric: 'cosine', threshold: 0.0 },
        },
        {
            indexer: 'BaseIndexer',
            field: 'item_type',
            operator: '=',
            value: 'file',
        },
    ]);

    // mail-1 应被过滤掉
    const itemIds = results.map(r => r.item.item_id);
    assert(!itemIds.includes('mail-1'), 'mail-1 should be filtered by BaseIndexer condition');
    assert(itemIds.includes('doc-file'), 'doc-file should be in results');

    storage.close();
    console.log('    ✓ BaseIndexer filter works in chunk search');
}

async function testChunkScoreNotDeduped(): Promise<void> {
    console.log('  [7] same item_id appears multiple times (no dedup)');
    cleanupTestDb();
    const storage = new BaseStorage('test', testSchema, TEST_DB_DIR);
    await storage.initialize();

    // doc-1 有 3 个 chunk，均在 index=0 附近
    const item = makeItemWithChunks('doc-1', ['chunk A', 'chunk B', 'chunk C'], [0, 0, 0]);
    await storage.insert([item]);

    const results = await storage.search([
        {
            indexer: 'ChunkIndexer',
            field: 'chunk_text',
            operator: 'vector_near',
            value: makeOneHot(0),
            vectorQuery: { topK: 5, metric: 'cosine', threshold: 0.0 },
        },
    ]);

    // 3 个 chunk 都应命中，item_id 可重复
    assertEqual(results.length, 3, 'All 3 chunks should appear (no dedup)');
    const allSameItem = results.every(r => r.item.item_id === 'doc-1');
    assert(allSameItem, 'All results should have same item_id (doc-1)');

    storage.close();
    console.log('    ✓ no dedup: same item_id appears multiple times');
}

async function testForbiddenMixThrows(): Promise<void> {
    console.log('  [8] ChunkIndexer + BM25Indexer combination should throw');
    cleanupTestDb();
    const storage = new BaseStorage('test', testSchema, TEST_DB_DIR);
    await storage.initialize();

    let threw = false;
    try {
        await storage.search([
            {
                indexer: 'ChunkIndexer',
                field: 'chunk_text',
                operator: 'vector_near',
                value: makeOneHot(0),
                vectorQuery: { topK: 5, metric: 'cosine', threshold: 0.0 },
            },
            {
                indexer: 'BM25Indexer',
                field: 'text',
                operator: 'bm25_match',
                value: 'hello',
            },
        ]);
    } catch (e: any) {
        threw = true;
        assert(e.message.includes('BM25Indexer'), `Error should mention BM25Indexer: ${e.message}`);
    }
    assert(threw, 'Should throw when mixing ChunkIndexer with BM25Indexer');

    storage.close();
    console.log('    ✓ forbidden mix throws');
}

async function testInsertMissingFieldThrows(): Promise<void> {
    console.log('  [9] insert entry missing id/text/content should throw');
    cleanupTestDb();
    const storage = new BaseStorage('test', testSchema, TEST_DB_DIR);
    await storage.initialize();

    // 缺少 text
    let threw = false;
    try {
        await storage.insert([{
            item_id: 'doc-bad',
            item_type: 'file',
            chunk_text: null,
            indexer_columns: {
                ChunkIndexer: [
                    { column: 'chunk_text', content: makeOneHot(0), id: 'doc-bad:chunk:0' },
                    // 缺少 text
                ],
            },
        }]);
    } catch (e: any) {
        threw = true;
        assert(e.message.includes("missing 'text'"), `Error should mention missing text: ${e.message}`);
    }
    assert(threw, 'Should throw when text is missing');

    storage.close();
    console.log('    ✓ missing required field throws');
}

async function testChunkStatusAndClear(): Promise<void> {
    console.log('  [10] ChunkIndexer getStatus + clear');
    cleanupTestDb();
    const storage = new BaseStorage('test', testSchema, TEST_DB_DIR);
    await storage.initialize();

    await storage.insert([
        makeItemWithChunks('doc-1', ['内容A', '内容B'], [0, 1]),
    ]);

    const before = await storage.getStatus();
    assert(before.ChunkIndexer !== undefined, 'getStatus should include ChunkIndexer');
    assertEqual(before.ChunkIndexer.size, 2, 'ChunkIndexer size should equal chunk count');
    assertEqual(before.ChunkIndexer.dim, VECTOR_DIM, 'ChunkIndexer dim should be reported');

    await storage.clear();

    const after = await storage.getStatus();
    assertEqual(after.ChunkIndexer.size, 0, 'ChunkIndexer size should be 0 after clear');

    storage.close();
    console.log('    ✓ ChunkIndexer getStatus + clear works');
}

async function testConflictingChunkDimsRejected(): Promise<void> {
    console.log('  [11] conflicting ChunkIndexer dims should throw');
    cleanupTestDb();

    let threw = false;
    try {
        new BaseStorage('test', conflictingChunkDimSchema, TEST_DB_DIR);
    } catch (e: any) {
        threw = true;
        assert(
            e.message.includes('ChunkIndexer dim must be consistent'),
            `Error should mention ChunkIndexer dim consistency: ${e.message}`,
        );
    }

    assert(threw, 'BaseStorage construction should reject conflicting ChunkIndexer dims');
    console.log('    ✓ conflicting ChunkIndexer dims rejected');
}

// ── Main ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
    console.log('=== ChunkIndexer Integration Tests ===');
    const tests = [
        testInsertAndSearch,
        testDeleteCleansChunks,
        testUpdateFullReplace,
        testItemWithoutChunksInsertOK,
        testBaseIndexerFilterInSearch,
        testChunkScoreNotDeduped,
        testForbiddenMixThrows,
        testInsertMissingFieldThrows,
        testChunkStatusAndClear,
        testConflictingChunkDimsRejected,
    ];

    let passed = 0;
    let failed = 0;
    for (const test of tests) {
        try {
            await test();
            passed++;
        } catch (e: any) {
            console.error(`  ✗ ${test.name}: ${e.message}`);
            failed++;
        }
    }

    // testChunkDoubleInsert 需要一个 storage 实例，单独运行
    console.log('  [11+] testChunkDoubleInsert (double insert upsert semantics)');
    cleanupTestDb();
    {
        const storage = new BaseStorage('test', testSchema, TEST_DB_DIR);
        await storage.initialize();
        try {
            await testChunkDoubleInsert(storage);
            passed++;
            console.log('    ✓ double insert upsert semantics verified');
        } catch (e: any) {
            console.error(`  ✗ testChunkDoubleInsert: ${e.message}`);
            failed++;
        }
        storage.close();
    }

    cleanupTestDb();

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exit(1);
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
