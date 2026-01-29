/**
 * BM25 Indexer Test
 */

import { BM25Indexer } from '../bm25-indexer.js';
import { Item, BM25Query } from '../abstrac-storage.js';
import { TagIndexer } from '../tag-indexer.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

const TEST_DB_DIR = path.join(os.tmpdir(), 'bm25-indexer-test-' + Date.now());

function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
        throw new Error(`Assertion failed: ${message}. Expected: ${expected}, Actual: ${actual}`);
    }
}

function cleanupTestDB(): void {
    if (fs.existsSync(TEST_DB_DIR)) {
        fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
}

function getTestDBPath(name: string): string {
    if (!fs.existsSync(TEST_DB_DIR)) {
        fs.mkdirSync(TEST_DB_DIR, { recursive: true });
    }
    return path.join(TEST_DB_DIR, name);
}

async function testBM25IndexerInitialization(): Promise<void> {
    console.log('\n=== Test: BM25Indexer Initialization ===');

    const indexer = new BM25Indexer(getTestDBPath('bm25idx-init'));
    await indexer.initialize();

    assertEqual(indexer.name, 'BM25Indexer', 'Name should be BM25Indexer');
    assert(indexer.supportedFields.includes('text'), 'Should support text field');
    assert(indexer.supportsOperator('bm25_match'), 'Should support bm25_match operator');
    assert(!indexer.supportsOperator('='), 'Should not support = operator');

    const count = await indexer.getDocumentCount();
    assertEqual(count, 0, 'Initial document count should be 0');

    await indexer.flush();
    indexer.close();
    console.log('✓ BM25Indexer Initialization test passed');
}

async function testBM25IndexerCRUD(): Promise<void> {
    console.log('\n=== Test: BM25Indexer CRUD ===');

    const indexer = new BM25Indexer(getTestDBPath('bm25idx-crud'));
    await indexer.initialize();

    const items: Item[] = [
        { item_id: 'doc_001', item_type: 'file', tag: 'work', text: 'Project proposal for Q4 planning', created_at: 1000, updated_at: 2000 },
        { item_id: 'doc_002', item_type: 'file', tag: 'work', text: 'Meeting notes from Monday standup', created_at: 1100, updated_at: 2100 },
        { item_id: 'doc_003', item_type: 'file', tag: 'tech', text: 'Introduction to machine learning algorithms', created_at: 1200, updated_at: 2200 },
    ];

    // Insert
    await indexer.insert(items);
    const countAfterInsert = await indexer.getDocumentCount();
    assertEqual(countAfterInsert, 3, 'Should have 3 documents after insert');

    // Update
    const updatedItem = { ...items[0], text: 'Updated project proposal for Q4 planning and budget' };
    await indexer.update([updatedItem]);
    const countAfterUpdate = await indexer.getDocumentCount();
    assertEqual(countAfterUpdate, 3, 'Should still have 3 documents after update');

    // Delete
    await indexer.delete(['doc_001']);
    const countAfterDelete = await indexer.getDocumentCount();
    assertEqual(countAfterDelete, 2, 'Should have 2 documents after delete');

    await indexer.flush();
    indexer.close();
    console.log('✓ BM25Indexer CRUD test passed');
}

async function testBM25IndexerSearch(): Promise<void> {
    console.log('\n=== Test: BM25Indexer Search ===');

    const indexer = new BM25Indexer(getTestDBPath('bm25idx-search'));
    await indexer.initialize();

    const items: Item[] = [
        { item_id: 'doc_001', item_type: 'file', tag: 'work', text: 'Project proposal for Q4 planning and budget allocation', created_at: 1000, updated_at: 2000 },
        { item_id: 'doc_002', item_type: 'file', tag: 'work', text: 'Meeting notes from Monday standup discussion', created_at: 1100, updated_at: 2100 },
        { item_id: 'doc_003', item_type: 'file', tag: 'tech', text: 'Introduction to machine learning algorithms and neural networks', created_at: 1200, updated_at: 2200 },
        { item_id: 'doc_004', item_type: 'file', tag: 'work', text: 'Quarterly budget review and financial planning', created_at: 1300, updated_at: 2300 },
    ];

    await indexer.insert(items);

    // BM25 search
    const result = await indexer.search([
        { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: 'project planning budget', topK: 10 } as BM25Query }
    ]);

    assert(result.items.length > 0, 'Should find results');

    await indexer.flush();
    indexer.close();
    console.log('✓ BM25Indexer Search test passed');
}

async function testBM25IndexerChineseSearch(): Promise<void> {
    console.log('\n=== Test: BM25Indexer Chinese Search ===');

    const indexer = new BM25Indexer(getTestDBPath('bm25idx-chinese'));
    await indexer.initialize();

    const items: Item[] = [
        { item_id: 'cn_001', item_type: 'file', tag: 'work', text: '项目计划书和预算分配方案', created_at: 1000, updated_at: 2000 },
        { item_id: 'cn_002', item_type: 'file', tag: 'work', text: '周一站会会议纪要', created_at: 1100, updated_at: 2100 },
        { item_id: 'cn_003', item_type: 'file', tag: 'tech', text: '机器学习算法和神经网络介绍', created_at: 1200, updated_at: 2200 },
        { item_id: 'cn_004', item_type: 'file', tag: 'work', text: '季度预算审查和财务规划', created_at: 1300, updated_at: 2300 },
    ];

    await indexer.insert(items);

    // Chinese search with jieba tokenization
    const result = await indexer.search([
        { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: '项目预算', topK: 10 } as BM25Query }
    ]);

    assert(result.items.length > 0, 'Should find Chinese results');

    await indexer.flush();
    indexer.close();
    console.log('✓ BM25Indexer Chinese Search test passed');
}

async function testBM25IndexerUnsupportedOperator(): Promise<void> {
    console.log('\n=== Test: BM25Indexer Unsupported Operator ===');

    const indexer = new BM25Indexer(getTestDBPath('bm25idx-unsup'));
    await indexer.initialize();

    let errorThrown = false;
    try {
        await indexer.search([
            { indexer: 'BM25Indexer', field: 'text', operator: '=' as any, value: 'test' }
        ]);
    } catch (error: any) {
        errorThrown = true;
        assert(error.message.includes('does not support operator'), 'Error should mention unsupported operator');
    }
    assert(errorThrown, 'Should throw error for unsupported operator');

    await indexer.flush();
    indexer.close();
    console.log('✓ BM25Indexer Unsupported Operator test passed');
}

async function testBM25IndexerJoinFiltering(): Promise<void> {
    console.log('\n=== Test: BM25Indexer Join Filtering ===');

    const indexer = new BM25Indexer(getTestDBPath('bm25idx-join'));
    await indexer.initialize();

    const items: Item[] = [
        { item_id: 'doc_001', item_type: 'file', tag: 'important', text: 'Important project proposal document', created_at: 1000, updated_at: 2000 },
        { item_id: 'doc_002', item_type: 'file', tag: 'normal', text: 'Regular project update report', created_at: 1100, updated_at: 2100 },
        { item_id: 'doc_003', item_type: 'file', tag: 'important', text: 'Critical project deadline reminder', created_at: 1200, updated_at: 2200 },
        { item_id: 'doc_004', item_type: 'file', tag: 'normal', text: 'Weekly project status summary', created_at: 1300, updated_at: 2300 },
    ];

    await indexer.insert(items);

    // Simulate TagIndexer results (only important items)
    const existingResults: Item[] = [items[0], items[2]];

    const result = await indexer.search(
        [{ indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: 'project', topK: 10 } as BM25Query }],
        { existingResults }
    );

    // Should only return items from existingResults
    assert(result.items.length <= 2, 'Should only return items from existingResults');
    for (const item of result.items) {
        assert(['doc_001', 'doc_003'].includes(item.item_id), 'Should only contain doc_001 or doc_003');
    }

    await indexer.flush();
    indexer.close();
    console.log('✓ BM25Indexer Join Filtering test passed');
}

async function testBM25IndexerEmptyQuery(): Promise<void> {
    console.log('\n=== Test: BM25Indexer Empty Query ===');

    const indexer = new BM25Indexer(getTestDBPath('bm25-empty'));
    await indexer.initialize();

    const items: Item[] = [
        { item_id: 'doc_001', item_type: 'file', tag: 'test', text: 'Test document content', created_at: 1000, updated_at: 2000 },
    ];
    await indexer.insert(items);

    // Empty conditions should return empty
    const result1 = await indexer.search([]);
    assertEqual(result1.items.length, 0, 'Empty conditions should return empty array');

    // Search on empty index
    const emptyIndexer = new BM25Indexer(getTestDBPath('bm25-empty2'));
    await emptyIndexer.initialize();

    const result2 = await emptyIndexer.search([
        { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: 'test', topK: 10 } as BM25Query }
    ]);
    assertEqual(result2.items.length, 0, 'Search on empty index should return empty array');

    await indexer.flush();
    indexer.close();
    await emptyIndexer.flush();
    emptyIndexer.close();
    console.log('✓ BM25Indexer Empty Query test passed');
}

async function testBM25WithTagIndexerJoin(): Promise<void> {
    console.log('\n=== Test: BM25 + TagIndexer Combined Search ===');

    const tagIndexer = new TagIndexer(getTestDBPath('bm25-multi-tag.db'));
    const bm25Indexer = new BM25Indexer(getTestDBPath('bm25-multi-bm25'));

    await tagIndexer.initialize();
    await bm25Indexer.initialize();

    // 为 TagIndexer 准备带 indexer_columns 的数据
    const items: Item[] = [
        {
            item_id: 'multi_001', item_type: 'file', tag: 'important', text: 'Important project proposal for Q4',
            created_at: 1000, updated_at: 2000,
            indexer_columns: { TagIndexer: [{ column: 'tag', content: 'important' }] }
        },
        {
            item_id: 'multi_002', item_type: 'file', tag: 'important', text: 'Critical budget review document',
            created_at: 1100, updated_at: 2100,
            indexer_columns: { TagIndexer: [{ column: 'tag', content: 'important' }] }
        },
        {
            item_id: 'multi_003', item_type: 'file', tag: 'normal', text: 'Regular project update notes',
            created_at: 1200, updated_at: 2200,
            indexer_columns: { TagIndexer: [{ column: 'tag', content: 'normal' }] }
        },
        {
            item_id: 'multi_004', item_type: 'file', tag: 'important', text: 'Project chart image',
            created_at: 1300, updated_at: 2300,
            indexer_columns: { TagIndexer: [{ column: 'tag', content: 'important' }] }
        },
        {
            item_id: 'multi_005', item_type: 'file', tag: 'archived', text: 'Old project documentation',
            created_at: 1400, updated_at: 2400,
            indexer_columns: { TagIndexer: [{ column: 'tag', content: 'archived' }] }
        },
    ];

    // Insert to both indexers
    await tagIndexer.insert(items);
    await bm25Indexer.insert(items);

    // Step 1: Filter by tag using TagIndexer
    const tagResults = await tagIndexer.search([
        { indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'important' }
    ]);
    assertEqual(tagResults.items.length, 3, 'Should find 3 important items');

    // Step 2: Use tag results as existingResults for BM25 search
    const combinedResult = await bm25Indexer.search(
        [{ indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: 'project', topK: 10 } as BM25Query }],
        { existingResults: tagResults.items }
    );

    // Should only return important items that match "project"
    assert(combinedResult.items.length > 0, 'Combined search should return results');
    assert(combinedResult.items.length <= 3, 'Should not exceed existingResults count');

    // All results should be from the important tag
    for (const item of combinedResult.items) {
        assert(['multi_001', 'multi_002', 'multi_004'].includes(item.item_id), 'Results should be from important items');
    }

    tagIndexer.close();
    await bm25Indexer.flush();
    bm25Indexer.close();
    console.log('✓ BM25 + TagIndexer Combined Search test passed');
}

async function runAllTests(): Promise<void> {
    console.log('========================================');
    console.log('BM25 Indexer Test Suite');
    console.log('========================================');

    const tests = [
        testBM25IndexerInitialization,
        testBM25IndexerCRUD,
        testBM25IndexerSearch,
        testBM25IndexerChineseSearch,
        testBM25IndexerUnsupportedOperator,
        testBM25IndexerJoinFiltering,
        testBM25IndexerEmptyQuery,
        testBM25WithTagIndexerJoin,
    ];

    let passed = 0;
    let failed = 0;

    for (const test of tests) {
        try {
            await test();
            passed++;
        } catch (error: any) {
            console.error(`✗ ${test.name} failed: ${error.message}`);
            failed++;
        }
    }

    console.log('\n========================================');
    console.log(`Test Results: ${passed} passed, ${failed} failed`);
    console.log('========================================');

    // 清理
    cleanupTestDB();

    if (failed > 0) {
        process.exit(1);
    }
}

runAllTests().catch(console.error);
