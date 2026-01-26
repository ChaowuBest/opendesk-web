/**
 * Storage Indexer Test Suite
 *
 * 测试 TagIndexer、VectorIndexer 和 BaseStorage 的搜索解释器逻辑
 *
 * 运行方式：
 * nvm use 22
 * npx tsx src/main/services/storage/__tests__/storage.test.ts
 */

import {
    BaseStorage,
    BaseIndexer,
    Item,
    ItemType,
    FilterCondition,
    ColumnSchema,
    SearchItem,
    validateColumnSchema,
    SchemaValidationError,
    ALLOWED_COLUMNS,
    REQUIRED_COLUMNS,
    BM25Query,
} from '../object.js';
import { TagIndexer } from '../tag-indexer.js';
import { TagIndexDB, TagIndexRecord } from '../tag-index-db.js';
import { VectorIndexDB, VectorIndexRecord } from '../vector-index-db.js';
import { VectorIndexer } from '../vector-indexer.js';
import { BM25IndexDB, BM25IndexRecord } from '../bm25-index-db.js';
import { BM25Indexer } from '../bm25-indexer.js';
import { BaseIndexDB } from '../base-index-db.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ============================================================================
// 测试辅助函数
// ============================================================================

const TEST_DB_DIR = path.join(os.tmpdir(), 'storage-indexer-test');

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

function assertDeepEqual<T>(actual: T, expected: T, message: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Assertion failed: ${message}. Expected: ${JSON.stringify(expected)}, Actual: ${JSON.stringify(actual)}`);
    }
}

function cleanupTestDB(): void {
    if (fs.existsSync(TEST_DB_DIR)) {
        fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
}

function getTestDBPath(name: string): string {
    return path.join(TEST_DB_DIR, `${name}.db`);
}

// ============================================================================
// 测试 Schema 定义（用于 BaseIndexDB 和 BaseIndexer 测试）
// ============================================================================

const baseTestSchema: ColumnSchema = {
    columns: {
        'item_id': 'TEXT PRIMARY KEY',
        'item_type': 'TEXT NOT NULL',
        'filename': 'TEXT',
        'size': 'INTEGER',
        'owner': 'TEXT',
        'created_at': 'INTEGER',
        'updated_at': 'INTEGER',
    },
    needIndexers: {
        'filename': ['BaseIndexer'],
        'owner': ['BaseIndexer'],
    }
};

// ============================================================================
// 测试数据
// ============================================================================

const testItems: Item[] = [
    { item_id: 'file_001', item_type: 'document', tag: 'important', text: 'Project proposal', created_at: 1000, updated_at: 2000 },
    { item_id: 'file_002', item_type: 'image', tag: 'photo', text: 'Vacation photo', created_at: 1100, updated_at: 2100 },
    { item_id: 'file_003', item_type: 'document', tag: 'work', text: 'Meeting notes', created_at: 1200, updated_at: 2200 },
    { item_id: 'file_004', item_type: 'video', tag: 'personal', text: 'Birthday video', created_at: 1300, updated_at: 2300 },
    { item_id: 'file_005', item_type: 'document', tag: 'important', text: 'Contract agreement', created_at: 1400, updated_at: 2400 },
];

const testRecords: TagIndexRecord[] = testItems.map(item => ({
    item_id: item.item_id,
    item_type: item.item_type,
    tag: item.tag,
    text: item.text,
}));

// ============================================================================
// TagIndexer 单元测试
// ============================================================================

async function testTagIndexerInitialization(): Promise<void> {
    console.log('\n=== Test: TagIndexer Initialization ===');
    cleanupTestDB();

    const indexer = new TagIndexer(getTestDBPath('init'));
    await indexer.initialize();

    assertEqual(indexer.name, 'TagIndexer', 'Name should be TagIndexer');
    assert(indexer.supportedFields.includes('item_id'), 'Should support item_id field');
    assert(indexer.supportedFields.includes('tag'), 'Should support tag field');
    assert(indexer.supportsOperator('='), 'Should support = operator');
    assert(indexer.supportsOperator('like'), 'Should support like operator');
    assert(!indexer.supportsOperator('vector_similarity'), 'Should not support vector_similarity');

    indexer.close();
    console.log('✓ TagIndexer Initialization test passed');
}

async function testTagIndexerCRUD(): Promise<void> {
    console.log('\n=== Test: TagIndexer CRUD ===');
    cleanupTestDB();

    const indexer = new TagIndexer(getTestDBPath('crud'));
    await indexer.initialize();

    // Insert
    await indexer.insert(testItems);
    const result1 = await indexer.search([
        { indexer: 'TagIndexer', field: 'item_type', operator: '=', value: 'document' }
    ]);
    assertEqual(result1.items.length, 3, 'Should find 3 documents after insert');

    // Update
    const updatedItem = { ...testItems[0], tag: 'urgent' };
    await indexer.update([updatedItem]);
    const result2 = await indexer.search([
        { indexer: 'TagIndexer', field: 'item_id', operator: '=', value: 'file_001' }
    ]);
    assertEqual(result2.items[0].tag, 'urgent', 'Tag should be updated to urgent');

    // Delete
    await indexer.delete(['file_001', 'file_002']);
    const result3 = await indexer.search([]);
    assertEqual(result3.items.length, 3, 'Should have 3 items after deleting 2');

    indexer.close();
    console.log('✓ TagIndexer CRUD test passed');
}

async function testTagIndexerOperators(): Promise<void> {
    console.log('\n=== Test: TagIndexer Operators ===');
    cleanupTestDB();

    const indexer = new TagIndexer(getTestDBPath('operators'));
    await indexer.initialize();
    await indexer.insert(testItems);

    // Test = operator
    let result = await indexer.search([
        { indexer: 'TagIndexer', field: 'item_type', operator: '=', value: 'document' }
    ]);
    assertEqual(result.items.length, 3, '= operator: Should find 3 documents');

    // Test != operator
    result = await indexer.search([
        { indexer: 'TagIndexer', field: 'item_type', operator: '!=', value: 'document' }
    ]);
    assertEqual(result.items.length, 2, '!= operator: Should find 2 non-documents');

    // Test like operator
    result = await indexer.search([
        { indexer: 'TagIndexer', field: 'text', operator: 'like', value: '%video%' }
    ]);
    assertEqual(result.items.length, 1, 'like operator: Should find 1 item with "video"');
    assertEqual(result.items[0].item_id, 'file_004', 'Should be file_004');

    // Test in operator
    result = await indexer.search([
        { indexer: 'TagIndexer', field: 'tag', operator: 'in', value: ['important', 'work'] }
    ]);
    assertEqual(result.items.length, 3, 'in operator: Should find 3 items');

    // Test multiple conditions (AND)
    result = await indexer.search([
        { indexer: 'TagIndexer', field: 'item_type', operator: '=', value: 'document' },
        { indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'important' }
    ]);
    assertEqual(result.items.length, 2, 'Multiple conditions: Should find 2 important documents');

    indexer.close();
    console.log('✓ TagIndexer Operators test passed');
}

async function testTagIndexerUnsupportedOperator(): Promise<void> {
    console.log('\n=== Test: TagIndexer Unsupported Operator ===');
    cleanupTestDB();

    const indexer = new TagIndexer(getTestDBPath('unsupported'));
    await indexer.initialize();
    await indexer.insert(testItems);

    let errorThrown = false;
    try {
        await indexer.search([
            { indexer: 'TagIndexer', field: 'text', operator: 'VECTOR_SIMILARITY' as any, value: 'test' }
        ]);
    } catch (error: any) {
        errorThrown = true;
        assert(error.message.includes('does not support operator'), 'Error should mention unsupported operator');
    }
    assert(errorThrown, 'Should throw error for unsupported operator');

    indexer.close();
    console.log('✓ TagIndexer Unsupported Operator test passed');
}

async function testTagIndexerJoinFiltering(): Promise<void> {
    console.log('\n=== Test: TagIndexer Join Filtering ===');
    cleanupTestDB();

    const indexer = new TagIndexer(getTestDBPath('join'));
    await indexer.initialize();
    await indexer.insert(testItems);

    // Simulate join with existing results
    const existingResults: Item[] = [
        testItems[0], // file_001, document, important
        testItems[2], // file_003, document, work
        testItems[4], // file_005, document, important
    ];

    const result = await indexer.search(
        [{ indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'important' }],
        { existingResults }
    );

    assertEqual(result.items.length, 2, 'Join filtering: Should find 2 important items from existing results');

    // Verify metadata is preserved from existingResults
    const item001 = result.items.find(i => i.item_id === 'file_001');
    assertEqual(item001?.created_at, 1000, 'created_at should be preserved from existingResults');
    assertEqual(item001?.updated_at, 2000, 'updated_at should be preserved from existingResults');

    indexer.close();
    console.log('✓ TagIndexer Join Filtering test passed');
}

async function testTagIndexerPagination(): Promise<void> {
    console.log('\n=== Test: TagIndexer Pagination ===');
    cleanupTestDB();

    const indexer = new TagIndexer(getTestDBPath('pagination'));
    await indexer.initialize();
    await indexer.insert(testItems);

    // Test limit
    let result = await indexer.search([], { limit: 2 });
    assertEqual(result.items.length, 2, 'Limit: Should return 2 items');

    // Test offset
    result = await indexer.search([], { limit: 2, offset: 2 });
    assertEqual(result.items.length, 2, 'Offset: Should return 2 items starting from offset 2');

    // Test orderBy
    result = await indexer.search([], { orderBy: { field: 'item_id', direction: 'DESC' } });
    assertEqual(result.items[0].item_id, 'file_005', 'OrderBy DESC: First item should be file_005');

    indexer.close();
    console.log('✓ TagIndexer Pagination test passed');
}

// ============================================================================
// BaseStorage 集成测试
// ============================================================================

// BaseStorage 测试用 Schema
const storageTestSchema: ColumnSchema = {
    columns: {
        'item_id': 'TEXT PRIMARY KEY',
        'item_type': 'TEXT NOT NULL',
        'tag': 'TEXT',
        'filename': 'TEXT',
        'size': 'INTEGER',
        'owner': 'TEXT',
        'created_at': 'INTEGER',
        'updated_at': 'INTEGER',
    },
    needIndexers: {
        'tag': ['TagIndexer'],
        'filename': ['BaseIndexer'],
        'owner': ['BaseIndexer'],
    }
};

async function testBaseStorageSingleIndexer(): Promise<void> {
    console.log('\n=== Test: BaseStorage Single Indexer ===');
    cleanupTestDB();

    const storage = new BaseStorage('test-storage', storageTestSchema, TEST_DB_DIR);
    await storage.initialize();

    // Insert via storage
    await storage.insert(testItems);

    // Search via BaseIndexer
    const result = await storage.search([], [
        { indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'document' }
    ]);

    assertEqual(result.length, 3, 'Should find 3 documents');

    storage.close();
    console.log('✓ BaseStorage Single Indexer test passed');
}

async function testBaseStorageMultipleConditions(): Promise<void> {
    console.log('\n=== Test: BaseStorage Multiple Conditions ===');
    cleanupTestDB();

    const storage = new BaseStorage('test-storage', storageTestSchema, TEST_DB_DIR);
    await storage.initialize();
    await storage.insert(testItems);

    // Multiple conditions on same indexer
    const result = await storage.search([], [
        { indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'document' },
        { indexer: 'BaseIndexer', field: 'tag', operator: 'in', value: ['important', 'work'] }
    ]);

    assertEqual(result.length, 3, 'Should find 3 documents with important or work tag');

    storage.close();
    console.log('✓ BaseStorage Multiple Conditions test passed');
}

async function testBaseStorageNoConditions(): Promise<void> {
    console.log('\n=== Test: BaseStorage No Conditions ===');
    cleanupTestDB();

    const storage = new BaseStorage('test-storage', storageTestSchema, TEST_DB_DIR);
    await storage.initialize();
    await storage.insert(testItems);

    // No conditions should return empty array
    const result = await storage.search([], []);
    assertEqual(result.length, 0, 'No conditions should return empty array');

    storage.close();
    console.log('✓ BaseStorage No Conditions test passed');
}

async function testBaseStorageUnknownIndexer(): Promise<void> {
    console.log('\n=== Test: BaseStorage Unknown Indexer ===');
    cleanupTestDB();

    const storage = new BaseStorage('test-storage', storageTestSchema, TEST_DB_DIR);
    await storage.initialize();
    await storage.insert(testItems);

    // Unknown indexer conditions should be skipped
    const result = await storage.search([], [
        { indexer: 'UnknownIndexer', field: 'item_type', operator: '=', value: 'document' }
    ]);

    assertEqual(result.length, 0, 'Unknown indexer should return empty array');

    storage.close();
    console.log('✓ BaseStorage Unknown Indexer test passed');
}

async function testBaseStorageDeleteAndUpdate(): Promise<void> {
    console.log('\n=== Test: BaseStorage Delete and Update ===');
    cleanupTestDB();

    const storage = new BaseStorage('test-storage', storageTestSchema, TEST_DB_DIR);
    await storage.initialize();
    await storage.insert(testItems);

    // Delete
    await storage.delete([testItems[0], testItems[1]]);
    let result = await storage.search([], [
        { indexer: 'BaseIndexer', field: 'item_id', operator: 'in', value: ['file_001', 'file_002'] }
    ]);
    assertEqual(result.length, 0, 'Deleted items should not be found');

    // Update
    const updatedItem = { ...testItems[2], tag: 'archived' };
    await storage.update([updatedItem]);
    result = await storage.search([], [
        { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'file_003' }
    ]);
    assertEqual(result[0].item.tag, 'archived', 'Tag should be updated to archived');

    storage.close();
    console.log('✓ BaseStorage Delete and Update test passed');
}

// ============================================================================
// VectorIndexDB 单元测试
// ============================================================================

// 向量测试辅助函数
const VECTOR_DIMENSION = 128; // 使用较小维度加速测试

function generateRandomVector(dimension: number): number[] {
    const vec = Array.from({ length: dimension }, () => Math.random() - 0.5);
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    return vec.map(v => v / norm);
}

function generateSimilarVector(base: number[], noise: number = 0.1): number[] {
    const vec = base.map(v => v + (Math.random() - 0.5) * noise);
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    return vec.map(v => v / norm);
}

async function testVectorIndexDBInitialization(): Promise<void> {
    console.log('\n=== Test: VectorIndexDB Initialization ===');
    cleanupTestDB();

    const db = new VectorIndexDB(getTestDBPath('vec-init'), VECTOR_DIMENSION);

    assertEqual(db.getDimension(), VECTOR_DIMENSION, 'Dimension should match');
    assertEqual(db.count(), 0, 'Initial count should be 0');

    db.close();
    console.log('✓ VectorIndexDB Initialization test passed');
}

async function testVectorIndexDBInsertAndSearch(): Promise<void> {
    console.log('\n=== Test: VectorIndexDB Insert and Search ===');
    cleanupTestDB();

    const db = new VectorIndexDB(getTestDBPath('vec-insert'), VECTOR_DIMENSION);

    // 创建测试向量
    const baseVector = generateRandomVector(VECTOR_DIMENSION);
    const similarVector = generateSimilarVector(baseVector, 0.05);
    const differentVector = generateRandomVector(VECTOR_DIMENSION);

    // 插入记录
    db.insert({ item_id: 'vec_001', item_type: 'document', repr: baseVector });
    db.insert({ item_id: 'vec_002', item_type: 'document', repr: similarVector });
    db.insert({ item_id: 'vec_003', item_type: 'image', repr: differentVector });

    assertEqual(db.count(), 3, 'Should have 3 records');

    // 搜索相似向量
    const results = db.search(baseVector, { metric: 'cosine', topK: 3 });

    assertEqual(results.length, 3, 'Should return 3 results');
    assertEqual(results[0].item_id, 'vec_001', 'First result should be exact match');
    assert(results[0].similarity > 0.99, 'Exact match should have high similarity');
    assertEqual(results[1].item_id, 'vec_002', 'Second result should be similar vector');
    assert(results[1].similarity > results[2].similarity, 'Similar vector should rank higher');

    db.close();
    console.log('✓ VectorIndexDB Insert and Search test passed');
}

async function testVectorIndexDBUpsert(): Promise<void> {
    console.log('\n=== Test: VectorIndexDB Upsert ===');
    cleanupTestDB();

    const db = new VectorIndexDB(getTestDBPath('vec-upsert'), VECTOR_DIMENSION);

    const vector1 = generateRandomVector(VECTOR_DIMENSION);
    const vector2 = generateRandomVector(VECTOR_DIMENSION);

    // 初始插入
    db.insert({ item_id: 'vec_001', item_type: 'document', repr: vector1 });

    // Upsert 更新
    db.upsert({ item_id: 'vec_001', item_type: 'updated', repr: vector2 });

    assertEqual(db.count(), 1, 'Should still have 1 record');

    // 验证更新
    const record = db.findById('vec_001');
    assertEqual(record?.item_type, 'updated', 'item_type should be updated');

    // 搜索验证向量已更新
    const results = db.search(vector2, { metric: 'cosine', topK: 1 });
    assertEqual(results[0].item_id, 'vec_001', 'Should find updated vector');
    assert(results[0].similarity > 0.99, 'Updated vector should match');

    db.close();
    console.log('✓ VectorIndexDB Upsert test passed');
}

async function testVectorIndexDBDelete(): Promise<void> {
    console.log('\n=== Test: VectorIndexDB Delete ===');
    cleanupTestDB();

    const db = new VectorIndexDB(getTestDBPath('vec-delete'), VECTOR_DIMENSION);

    // 插入多条记录
    for (let i = 0; i < 5; i++) {
        db.insert({
            item_id: `vec_${i}`,
            item_type: 'document',
            repr: generateRandomVector(VECTOR_DIMENSION)
        });
    }

    assertEqual(db.count(), 5, 'Should have 5 records');

    // 删除单条
    const deleted = db.delete('vec_0');
    assert(deleted, 'Delete should return true');
    assertEqual(db.count(), 4, 'Should have 4 records after delete');
    assert(!db.exists('vec_0'), 'Deleted record should not exist');

    // 批量删除
    const deletedCount = db.deleteMany(['vec_1', 'vec_2']);
    assertEqual(deletedCount, 2, 'Should delete 2 records');
    assertEqual(db.count(), 2, 'Should have 2 records after batch delete');

    db.close();
    console.log('✓ VectorIndexDB Delete test passed');
}

async function testVectorIndexDBBatchOperations(): Promise<void> {
    console.log('\n=== Test: VectorIndexDB Batch Operations ===');
    cleanupTestDB();

    const db = new VectorIndexDB(getTestDBPath('vec-batch'), VECTOR_DIMENSION);

    // 批量插入
    const records: VectorIndexRecord[] = [];
    for (let i = 0; i < 20; i++) {
        records.push({
            item_id: `batch_${i}`,
            item_type: i % 2 === 0 ? 'document' : 'image',
            repr: generateRandomVector(VECTOR_DIMENSION)
        });
    }

    const insertedCount = db.insertMany(records);
    assertEqual(insertedCount, 20, 'Should insert 20 records');
    assertEqual(db.count(), 20, 'Should have 20 records');

    // 测试重复插入（应跳过）
    const duplicateCount = db.insertMany(records.slice(0, 5));
    assertEqual(duplicateCount, 0, 'Duplicate inserts should be skipped');

    db.close();
    console.log('✓ VectorIndexDB Batch Operations test passed');
}

async function testVectorIndexDBFilteredSearch(): Promise<void> {
    console.log('\n=== Test: VectorIndexDB Filtered Search ===');
    cleanupTestDB();

    const db = new VectorIndexDB(getTestDBPath('vec-filter'), VECTOR_DIMENSION);

    const baseVector = generateRandomVector(VECTOR_DIMENSION);

    // 插入多条记录
    for (let i = 0; i < 10; i++) {
        db.insert({
            item_id: `filter_${i}`,
            item_type: i % 2 === 0 ? 'document' : 'image',
            repr: generateSimilarVector(baseVector, 0.1 * (i + 1))
        });
    }

    // 带过滤的搜索
    const filterIds = ['filter_0', 'filter_2', 'filter_4', 'filter_6'];
    const results = db.search(baseVector, { metric: 'cosine', topK: 10 }, filterIds);

    assertEqual(results.length, 4, 'Should only return filtered items');
    assert(results.every(r => filterIds.includes(r.item_id)), 'All results should be in filter list');

    db.close();
    console.log('✓ VectorIndexDB Filtered Search test passed');
}

async function testVectorIndexDBThreshold(): Promise<void> {
    console.log('\n=== Test: VectorIndexDB Threshold ===');
    cleanupTestDB();

    const db = new VectorIndexDB(getTestDBPath('vec-threshold'), VECTOR_DIMENSION);

    const baseVector = generateRandomVector(VECTOR_DIMENSION);

    // 插入不同相似度的向量
    db.insert({ item_id: 'exact', item_type: 'doc', repr: baseVector });
    db.insert({ item_id: 'similar', item_type: 'doc', repr: generateSimilarVector(baseVector, 0.1) });
    db.insert({ item_id: 'different', item_type: 'doc', repr: generateRandomVector(VECTOR_DIMENSION) });

    // 高阈值搜索
    const highThresholdResults = db.search(baseVector, { metric: 'cosine', threshold: 0.95, topK: 10 });
    assert(highThresholdResults.length >= 1, 'Should find at least exact match');
    assert(highThresholdResults.every(r => r.similarity >= 0.95), 'All results should meet threshold');

    // 低阈值搜索
    const lowThresholdResults = db.search(baseVector, { metric: 'cosine', threshold: 0.3, topK: 10 });
    assert(lowThresholdResults.length >= highThresholdResults.length, 'Lower threshold should return more results');

    db.close();
    console.log('✓ VectorIndexDB Threshold test passed');
}

// ============================================================================
// VectorIndexer 单元测试
// ============================================================================

async function testVectorIndexerInitialization(): Promise<void> {
    console.log('\n=== Test: VectorIndexer Initialization ===');
    cleanupTestDB();

    const indexer = new VectorIndexer(getTestDBPath('vidx-init'), VECTOR_DIMENSION);
    await indexer.initialize();

    assertEqual(indexer.name, 'VectorIndexer', 'Name should be VectorIndexer');
    assert(indexer.supportedFields.includes('repr'), 'Should support repr field');
    assert(indexer.supportsOperator('vector_similarity'), 'Should support vector_similarity');
    assert(indexer.supportsOperator('vector_near'), 'Should support vector_near');
    assert(!indexer.supportsOperator('='), 'Should not support = operator');
    assert(!indexer.supportsOperator('like'), 'Should not support like operator');

    indexer.close();
    console.log('✓ VectorIndexer Initialization test passed');
}

async function testVectorIndexerCRUD(): Promise<void> {
    console.log('\n=== Test: VectorIndexer CRUD ===');
    cleanupTestDB();

    const indexer = new VectorIndexer(getTestDBPath('vidx-crud'), VECTOR_DIMENSION);
    await indexer.initialize();

    const baseVector = generateRandomVector(VECTOR_DIMENSION);

    // Insert with vectors
    const items: Array<Item & { repr: number[] }> = [
        { item_id: 'v_001', item_type: 'document', tag: 'test', text: 'Test 1', created_at: 1000, updated_at: 2000, repr: baseVector },
        { item_id: 'v_002', item_type: 'document', tag: 'test', text: 'Test 2', created_at: 1100, updated_at: 2100, repr: generateSimilarVector(baseVector, 0.1) },
        { item_id: 'v_003', item_type: 'image', tag: 'test', text: 'Test 3', created_at: 1200, updated_at: 2200, repr: generateRandomVector(VECTOR_DIMENSION) },
    ];

    await indexer.insertWithVectors(items);

    // Search
    const result = await indexer.search([
        { indexer: 'VectorIndexer', field: 'repr', operator: 'vector_near', value: baseVector, vectorQuery: { threshold: 0.5, topK: 3 } }
    ]);

    assertEqual(result.items.length, 3, 'Should find 3 items');
    assertEqual(result.items[0].item_id, 'v_001', 'First result should be exact match');

    // Delete
    await indexer.delete(['v_001']);
    const result2 = await indexer.search([
        { indexer: 'VectorIndexer', field: 'repr', operator: 'vector_near', value: baseVector, vectorQuery: { threshold: 0.5, topK: 3 } }
    ]);
    assertEqual(result2.items.length, 2, 'Should have 2 items after delete');

    indexer.close();
    console.log('✓ VectorIndexer CRUD test passed');
}

async function testVectorIndexerVectorSimilarity(): Promise<void> {
    console.log('\n=== Test: VectorIndexer vector_similarity ===');
    cleanupTestDB();

    const indexer = new VectorIndexer(getTestDBPath('vidx-sim'), VECTOR_DIMENSION);
    await indexer.initialize();

    const baseVector = generateRandomVector(VECTOR_DIMENSION);

    const items: Array<Item & { repr: number[] }> = [
        { item_id: 'sim_001', item_type: 'doc', tag: '', text: '', created_at: 0, updated_at: 0, repr: baseVector },
        { item_id: 'sim_002', item_type: 'doc', tag: '', text: '', created_at: 0, updated_at: 0, repr: generateSimilarVector(baseVector, 0.05) },
        { item_id: 'sim_003', item_type: 'doc', tag: '', text: '', created_at: 0, updated_at: 0, repr: generateSimilarVector(baseVector, 0.3) },
        { item_id: 'sim_004', item_type: 'doc', tag: '', text: '', created_at: 0, updated_at: 0, repr: generateRandomVector(VECTOR_DIMENSION) },
    ];

    await indexer.insertWithVectors(items);

    // vector_similarity with high threshold
    const result = await indexer.search([
        { indexer: 'VectorIndexer', field: 'repr', operator: 'vector_similarity', value: baseVector, vectorQuery: { threshold: 0.9 } }
    ]);

    assert(result.items.length >= 1, 'Should find at least 1 similar item');
    assert(result.scores !== undefined, 'Should have scores');
    assert(result.scores!.get('sim_001')! >= 0.9, 'Exact match should have high score');

    indexer.close();
    console.log('✓ VectorIndexer vector_similarity test passed');
}

async function testVectorIndexerVectorNear(): Promise<void> {
    console.log('\n=== Test: VectorIndexer vector_near ===');
    cleanupTestDB();

    const indexer = new VectorIndexer(getTestDBPath('vidx-near'), VECTOR_DIMENSION);
    await indexer.initialize();

    const baseVector = generateRandomVector(VECTOR_DIMENSION);

    // Insert 10 items
    const items: Array<Item & { repr: number[] }> = [];
    for (let i = 0; i < 10; i++) {
        items.push({
            item_id: `near_${i}`,
            item_type: 'doc',
            tag: '',
            text: '',
            created_at: 0,
            updated_at: 0,
            repr: generateSimilarVector(baseVector, 0.1 * i)
        });
    }
    await indexer.insertWithVectors(items);

    // vector_near with topK=3
    const result = await indexer.search([
        { indexer: 'VectorIndexer', field: 'repr', operator: 'vector_near', value: baseVector, vectorQuery: { threshold: 0, topK: 3 } }
    ]);

    assertEqual(result.items.length, 3, 'Should return exactly 3 items');
    assertEqual(result.items[0].item_id, 'near_0', 'First should be most similar');

    indexer.close();
    console.log('✓ VectorIndexer vector_near test passed');
}

async function testVectorIndexerVectorNotSimilar(): Promise<void> {
    console.log('\n=== Test: VectorIndexer vector_not_similar ===');
    cleanupTestDB();

    const indexer = new VectorIndexer(getTestDBPath('vidx-notsim'), VECTOR_DIMENSION);
    await indexer.initialize();

    const baseVector = generateRandomVector(VECTOR_DIMENSION);

    const items: Array<Item & { repr: number[] }> = [
        { item_id: 'ns_001', item_type: 'doc', tag: '', text: '', created_at: 0, updated_at: 0, repr: baseVector },
        { item_id: 'ns_002', item_type: 'doc', tag: '', text: '', created_at: 0, updated_at: 0, repr: generateSimilarVector(baseVector, 0.05) },
        { item_id: 'ns_003', item_type: 'doc', tag: '', text: '', created_at: 0, updated_at: 0, repr: generateRandomVector(VECTOR_DIMENSION) },
        { item_id: 'ns_004', item_type: 'doc', tag: '', text: '', created_at: 0, updated_at: 0, repr: generateRandomVector(VECTOR_DIMENSION) },
    ];

    await indexer.insertWithVectors(items);

    // vector_not_similar - find items NOT similar to base
    const result = await indexer.search([
        { indexer: 'VectorIndexer', field: 'repr', operator: 'vector_not_similar', value: baseVector, vectorQuery: { threshold: 0.8 } }
    ]);

    // Should exclude exact match and very similar items
    assert(result.items.every(item => item.item_id !== 'ns_001'), 'Should not include exact match');

    indexer.close();
    console.log('✓ VectorIndexer vector_not_similar test passed');
}

async function testVectorIndexerUnsupportedOperator(): Promise<void> {
    console.log('\n=== Test: VectorIndexer Unsupported Operator ===');
    cleanupTestDB();

    const indexer = new VectorIndexer(getTestDBPath('vidx-unsup'), VECTOR_DIMENSION);
    await indexer.initialize();

    let errorThrown = false;
    try {
        await indexer.search([
            { indexer: 'VectorIndexer', field: 'repr', operator: '=' as any, value: 'test' }
        ]);
    } catch (error: any) {
        errorThrown = true;
        assert(error.message.includes('does not support operator'), 'Error should mention unsupported operator');
    }
    assert(errorThrown, 'Should throw error for unsupported operator');

    indexer.close();
    console.log('✓ VectorIndexer Unsupported Operator test passed');
}

async function testVectorIndexerJoinFiltering(): Promise<void> {
    console.log('\n=== Test: VectorIndexer Join Filtering ===');
    cleanupTestDB();

    const indexer = new VectorIndexer(getTestDBPath('vidx-join'), VECTOR_DIMENSION);
    await indexer.initialize();

    const baseVector = generateRandomVector(VECTOR_DIMENSION);

    const items: Array<Item & { repr: number[] }> = [];
    for (let i = 0; i < 10; i++) {
        items.push({
            item_id: `join_${i}`,
            item_type: 'doc',
            tag: `tag_${i}`,
            text: `Text ${i}`,
            created_at: 1000 + i * 100,
            updated_at: 2000 + i * 100,
            repr: generateSimilarVector(baseVector, 0.05 * i)
        });
    }
    await indexer.insertWithVectors(items);

    // Simulate join with existing results (only even indices)
    const existingResults: Item[] = items.filter((_, i) => i % 2 === 0);

    const result = await indexer.search(
        [{ indexer: 'VectorIndexer', field: 'repr', operator: 'vector_near', value: baseVector, vectorQuery: { threshold: 0, topK: 10 } }],
        { existingResults }
    );

    assertEqual(result.items.length, 5, 'Should only return items from existingResults');
    assert(result.items.every(item => parseInt(item.item_id.split('_')[1]) % 2 === 0), 'All results should be even indices');

    // Verify metadata is preserved
    const item0 = result.items.find(i => i.item_id === 'join_0');
    assertEqual(item0?.tag, 'tag_0', 'Tag should be preserved from existingResults');
    assertEqual(item0?.created_at, 1000, 'created_at should be preserved');

    indexer.close();
    console.log('✓ VectorIndexer Join Filtering test passed');
}

// ============================================================================
// Multi-Indexer 集成测试
// ============================================================================

async function testMultiIndexerCombinedSearch(): Promise<void> {
    console.log('\n=== Test: Multi-Indexer Combined Search ===');
    cleanupTestDB();

    // 使用独立的 TagIndexer 和 VectorIndexer 进行组合搜索测试
    const tagIndexer = new TagIndexer(getTestDBPath('multi-tag'));
    const vectorIndexer = new VectorIndexer(getTestDBPath('multi-vec'), VECTOR_DIMENSION);

    await tagIndexer.initialize();
    await vectorIndexer.initialize();

    const baseVector = generateRandomVector(VECTOR_DIMENSION);

    // 创建测试数据
    const items: Array<Item & { repr: number[] }> = [
        { item_id: 'multi_001', item_type: 'document' as ItemType, tag: 'important', text: 'Project plan', created_at: 1000, updated_at: 2000, repr: baseVector },
        { item_id: 'multi_002', item_type: 'document' as ItemType, tag: 'important', text: 'Budget report', created_at: 1100, updated_at: 2100, repr: generateSimilarVector(baseVector, 0.1) },
        { item_id: 'multi_003', item_type: 'document' as ItemType, tag: 'normal', text: 'Meeting notes', created_at: 1200, updated_at: 2200, repr: generateSimilarVector(baseVector, 0.05) },
        { item_id: 'multi_004', item_type: 'image' as ItemType, tag: 'important', text: 'Chart image', created_at: 1300, updated_at: 2300, repr: generateRandomVector(VECTOR_DIMENSION) },
        { item_id: 'multi_005', item_type: 'document' as ItemType, tag: 'archived', text: 'Old document', created_at: 1400, updated_at: 2400, repr: generateRandomVector(VECTOR_DIMENSION) },
    ];

    // 插入到两个索引器
    await tagIndexer.insert(items);
    await vectorIndexer.insertWithVectors(items);

    // 组合查询：先按标签过滤，再按向量相似度排序
    // Step 1: TagIndexer 过滤 important 标签
    const tagResults = await tagIndexer.search([
        { indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'important' }
    ]);
    assertEqual(tagResults.items.length, 3, 'Should find 3 important items');

    // Step 2: 使用 TagIndexer 结果作为 existingResults 进行向量搜索
    const combinedResult = await vectorIndexer.search(
        [{ indexer: 'VectorIndexer', field: 'repr', operator: 'vector_near', value: baseVector, vectorQuery: { threshold: 0, topK: 10 } }],
        { existingResults: tagResults.items }
    );

    assertEqual(combinedResult.items.length, 3, 'Combined search should return 3 items');
    assertEqual(combinedResult.items[0].item_id, 'multi_001', 'First result should be exact match');

    tagIndexer.close();
    vectorIndexer.close();
    console.log('✓ Multi-Indexer Combined Search test passed');
}

// ============================================================================
// 边界情况测试
// ============================================================================

async function testEdgeCasesUnicode(): Promise<void> {
    console.log('\n=== Test: Edge Cases - Unicode ===');
    cleanupTestDB();

    const indexer = new TagIndexer(getTestDBPath('unicode'));
    await indexer.initialize();

    const unicodeItems: Item[] = [
        { item_id: 'cn_001', item_type: '文档', tag: '重要', text: '项目计划书', created_at: 1000, updated_at: 2000 },
        { item_id: 'jp_001', item_type: 'ドキュメント', tag: '重要', text: 'プロジェクト計画', created_at: 1100, updated_at: 2100 },
        { item_id: 'emoji_001', item_type: 'note', tag: '🎉', text: 'Party planning 🎊', created_at: 1200, updated_at: 2200 },
    ];

    await indexer.insert(unicodeItems);

    // Search Chinese
    let result = await indexer.search([
        { indexer: 'TagIndexer', field: 'item_type', operator: '=', value: '文档' }
    ]);
    assertEqual(result.items.length, 1, 'Should find Chinese document');

    // Search with like for Chinese
    result = await indexer.search([
        { indexer: 'TagIndexer', field: 'text', operator: 'like', value: '%计划%' }
    ]);
    assertEqual(result.items.length, 1, 'Should find item with Chinese text');

    // Search emoji tag
    result = await indexer.search([
        { indexer: 'TagIndexer', field: 'tag', operator: '=', value: '🎉' }
    ]);
    assertEqual(result.items.length, 1, 'Should find item with emoji tag');

    indexer.close();
    console.log('✓ Edge Cases - Unicode test passed');
}

async function testEdgeCasesSpecialCharacters(): Promise<void> {
    console.log('\n=== Test: Edge Cases - Special Characters ===');
    cleanupTestDB();

    const indexer = new TagIndexer(getTestDBPath('special'));
    await indexer.initialize();

    const specialItems: Item[] = [
        { item_id: 'special_001', item_type: 'doc', tag: "tag'with\"quotes", text: "Text with 'single' and \"double\" quotes", created_at: 1000, updated_at: 2000 },
        { item_id: 'special_002', item_type: 'doc', tag: 'tag%percent', text: 'Text with % percent', created_at: 1100, updated_at: 2100 },
    ];

    await indexer.insert(specialItems);

    // Search with quotes
    let result = await indexer.search([
        { indexer: 'TagIndexer', field: 'tag', operator: '=', value: "tag'with\"quotes" }
    ]);
    assertEqual(result.items.length, 1, 'Should find item with quotes in tag');

    // Search with like and %
    result = await indexer.search([
        { indexer: 'TagIndexer', field: 'text', operator: 'like', value: '%percent%' }
    ]);
    assertEqual(result.items.length, 1, 'Should find item with percent in text');

    indexer.close();
    console.log('✓ Edge Cases - Special Characters test passed');
}

async function testEdgeCasesEmptyResults(): Promise<void> {
    console.log('\n=== Test: Edge Cases - Empty Results ===');
    cleanupTestDB();

    const indexer = new TagIndexer(getTestDBPath('empty'));
    await indexer.initialize();
    await indexer.insert(testItems);

    // Search for non-existent value
    let result = await indexer.search([
        { indexer: 'TagIndexer', field: 'item_type', operator: '=', value: 'nonexistent' }
    ]);
    assertEqual(result.items.length, 0, 'Should return empty array for non-existent value');

    // Empty in array
    result = await indexer.search([
        { indexer: 'TagIndexer', field: 'item_id', operator: 'in', value: [] }
    ]);
    assertEqual(result.items.length, 0, 'Empty in array should return empty results');

    indexer.close();
    console.log('✓ Edge Cases - Empty Results test passed');
}

async function testEdgeCasesConcurrency(): Promise<void> {
    console.log('\n=== Test: Edge Cases - Concurrency ===');
    cleanupTestDB();

    const indexer = new TagIndexer(getTestDBPath('concurrency'));
    await indexer.initialize();

    // Concurrent inserts
    const insertPromises: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
        insertPromises.push(indexer.insert([{
            item_id: `concurrent_${i}`,
            item_type: 'file',
            tag: `tag_${i % 5}`,
            text: `Concurrent test ${i}`,
            created_at: Date.now(),
            updated_at: Date.now(),
        }]));
    }
    await Promise.all(insertPromises);

    // Verify all inserted
    const result = await indexer.search([
        { indexer: 'TagIndexer', field: 'item_type', operator: '=', value: 'file' }
    ]);
    assertEqual(result.items.length, 50, 'All 50 concurrent inserts should succeed');

    // Concurrent reads and writes
    const mixedPromises: Promise<any>[] = [];
    for (let i = 0; i < 20; i++) {
        mixedPromises.push(indexer.search([
            { indexer: 'TagIndexer', field: 'tag', operator: '=', value: `tag_${i % 5}` }
        ]));
        mixedPromises.push(indexer.update([{
            item_id: `concurrent_${i}`,
            item_type: 'file',
            tag: 'updated',
            text: `Updated ${i}`,
            created_at: Date.now(),
            updated_at: Date.now(),
        }]));
    }
    await Promise.all(mixedPromises);

    indexer.close();
    console.log('✓ Edge Cases - Concurrency test passed');
}

// ============================================================================
// BM25IndexDB 单元测试
// ============================================================================

async function testBM25IndexDBInitialization(): Promise<void> {
    console.log('\n=== Test: BM25IndexDB Initialization ===');
    cleanupTestDB();

    const db = new BM25IndexDB(getTestDBPath('bm25-init'));

    assertEqual(db.count(), 0, 'Initial count should be 0');

    db.close();
    console.log('✓ BM25IndexDB Initialization test passed');
}

async function testBM25IndexDBCRUD(): Promise<void> {
    console.log('\n=== Test: BM25IndexDB CRUD ===');
    cleanupTestDB();

    const db = new BM25IndexDB(getTestDBPath('bm25-crud'));

    // Insert
    const record: BM25IndexRecord = {
        item_id: 'bm25_001',
        item_type: 'document',
        tag: 'test',
        text: 'This is a test document for BM25 indexing',
        created_at: Date.now(),
        updated_at: Date.now(),
    };

    const inserted = db.insert(record);
    assert(inserted, 'Insert should return true');
    assertEqual(db.count(), 1, 'Count should be 1 after insert');

    // Find by ID
    const found = db.findById('bm25_001');
    assertEqual(found?.text, record.text, 'Found record should match');

    // Update (upsert)
    const updatedRecord = { ...record, text: 'Updated text content', updated_at: Date.now() };
    db.upsert(updatedRecord);
    const updated = db.findById('bm25_001');
    assertEqual(updated?.text, 'Updated text content', 'Text should be updated');

    // Delete
    const deleted = db.delete('bm25_001');
    assert(deleted, 'Delete should return true');
    assertEqual(db.count(), 0, 'Count should be 0 after delete');

    db.close();
    console.log('✓ BM25IndexDB CRUD test passed');
}

async function testBM25IndexDBBatchOperations(): Promise<void> {
    console.log('\n=== Test: BM25IndexDB Batch Operations ===');
    cleanupTestDB();

    const db = new BM25IndexDB(getTestDBPath('bm25-batch'));

    // Batch insert
    const records: BM25IndexRecord[] = [];
    for (let i = 0; i < 100; i++) {
        records.push({
            item_id: `batch_${i}`,
            item_type: 'document',
            tag: `tag_${i % 5}`,
            text: `Document number ${i} with some searchable content`,
            created_at: Date.now(),
            updated_at: Date.now(),
        });
    }

    const insertedCount = db.insertMany(records);
    assertEqual(insertedCount, 100, 'Should insert 100 records');
    assertEqual(db.count(), 100, 'Should have 100 records');

    // Test duplicate insert (should skip)
    const duplicateCount = db.insertMany(records.slice(0, 5));
    assertEqual(duplicateCount, 0, 'Duplicate inserts should be skipped');

    // Batch delete
    const idsToDelete = records.slice(0, 10).map(r => r.item_id);
    const deletedCount = db.deleteMany(idsToDelete);
    assertEqual(deletedCount, 10, 'Should delete 10 records');
    assertEqual(db.count(), 90, 'Should have 90 records after delete');

    db.close();
    console.log('✓ BM25IndexDB Batch Operations test passed');
}

async function testBM25IndexDBUpsert(): Promise<void> {
    console.log('\n=== Test: BM25IndexDB Upsert ===');
    cleanupTestDB();

    const db = new BM25IndexDB(getTestDBPath('bm25-upsert'));

    const record: BM25IndexRecord = {
        item_id: 'upsert_001',
        item_type: 'document',
        tag: 'original',
        text: 'Original text',
        created_at: 1000,
        updated_at: 2000,
    };

    // Initial insert via upsert
    db.upsert(record);
    assertEqual(db.count(), 1, 'Should have 1 record');

    // Update via upsert
    const updatedRecord = { ...record, tag: 'updated', text: 'Updated text', updated_at: 3000 };
    db.upsert(updatedRecord);
    assertEqual(db.count(), 1, 'Should still have 1 record');

    const found = db.findById('upsert_001');
    assertEqual(found?.tag, 'updated', 'Tag should be updated');
    assertEqual(found?.text, 'Updated text', 'Text should be updated');
    assertEqual(found?.created_at, 1000, 'created_at should be preserved');

    db.close();
    console.log('✓ BM25IndexDB Upsert test passed');
}

// ============================================================================
// BM25Indexer 单元测试
// ============================================================================

async function testBM25IndexerInitialization(): Promise<void> {
    console.log('\n=== Test: BM25Indexer Initialization ===');
    cleanupTestDB();

    const indexer = new BM25Indexer(getTestDBPath('bm25idx-init'));
    await indexer.initialize();

    assertEqual(indexer.name, 'BM25Indexer', 'Name should be BM25Indexer');
    assert(indexer.supportedFields.includes('text'), 'Should support text field');
    assert(indexer.supportsOperator('bm25_match'), 'Should support bm25_match operator');
    assert(!indexer.supportsOperator('='), 'Should not support = operator');
    assert(!indexer.supportsOperator('vector_similarity'), 'Should not support vector_similarity');

    assertEqual(indexer.getDocumentCount(), 0, 'Initial document count should be 0');

    indexer.close();
    console.log('✓ BM25Indexer Initialization test passed');
}

async function testBM25IndexerCRUD(): Promise<void> {
    console.log('\n=== Test: BM25Indexer CRUD ===');
    cleanupTestDB();

    const indexer = new BM25Indexer(getTestDBPath('bm25idx-crud'));
    await indexer.initialize();

    const items: Item[] = [
        { item_id: 'doc_001', item_type: 'document', tag: 'work', text: 'Project proposal for Q4 planning', created_at: 1000, updated_at: 2000 },
        { item_id: 'doc_002', item_type: 'document', tag: 'work', text: 'Meeting notes from Monday standup', created_at: 1100, updated_at: 2100 },
        { item_id: 'doc_003', item_type: 'article', tag: 'tech', text: 'Introduction to machine learning algorithms', created_at: 1200, updated_at: 2200 },
    ];

    // Insert
    await indexer.insert(items);
    assertEqual(indexer.getDocumentCount(), 3, 'Should have 3 documents after insert');

    // Update
    const updatedItem = { ...items[0], text: 'Updated project proposal for Q4 planning and budget' };
    await indexer.update([updatedItem]);
    assertEqual(indexer.getDocumentCount(), 3, 'Should still have 3 documents after update');

    // Delete
    await indexer.delete(['doc_001']);
    assertEqual(indexer.getDocumentCount(), 2, 'Should have 2 documents after delete');

    indexer.close();
    console.log('✓ BM25Indexer CRUD test passed');
}

async function testBM25IndexerSearch(): Promise<void> {
    console.log('\n=== Test: BM25Indexer Search ===');
    cleanupTestDB();

    const indexer = new BM25Indexer(getTestDBPath('bm25idx-search'));
    await indexer.initialize();

    const items: Item[] = [
        { item_id: 'doc_001', item_type: 'document', tag: 'work', text: 'Project proposal for Q4 planning and budget allocation', created_at: 1000, updated_at: 2000 },
        { item_id: 'doc_002', item_type: 'document', tag: 'work', text: 'Meeting notes from Monday standup discussion', created_at: 1100, updated_at: 2100 },
        { item_id: 'doc_003', item_type: 'article', tag: 'tech', text: 'Introduction to machine learning algorithms and neural networks', created_at: 1200, updated_at: 2200 },
        { item_id: 'doc_004', item_type: 'document', tag: 'work', text: 'Quarterly budget review and financial planning', created_at: 1300, updated_at: 2300 },
    ];

    await indexer.insert(items);

    // BM25 search
    const result = await indexer.search([
        { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: 'project planning budget', topK: 10 } as BM25Query }
    ]);

    assert(result.items.length > 0, 'Should find results');
    assert(result.scores !== undefined, 'Should have scores');

    // The most relevant documents should be about project/planning/budget
    const topResultIds = result.items.slice(0, 2).map(i => i.item_id);
    assert(topResultIds.includes('doc_001') || topResultIds.includes('doc_004'), 'Top results should include relevant documents');

    indexer.close();
    console.log('✓ BM25Indexer Search test passed');
}

async function testBM25IndexerUnsupportedOperator(): Promise<void> {
    console.log('\n=== Test: BM25Indexer Unsupported Operator ===');
    cleanupTestDB();

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

    indexer.close();
    console.log('✓ BM25Indexer Unsupported Operator test passed');
}

async function testBM25IndexerJoinFiltering(): Promise<void> {
    console.log('\n=== Test: BM25Indexer Join Filtering ===');
    cleanupTestDB();

    const indexer = new BM25Indexer(getTestDBPath('bm25idx-join'));
    await indexer.initialize();

    const items: Item[] = [
        { item_id: 'doc_001', item_type: 'document', tag: 'important', text: 'Important project proposal document', created_at: 1000, updated_at: 2000 },
        { item_id: 'doc_002', item_type: 'document', tag: 'normal', text: 'Regular project update report', created_at: 1100, updated_at: 2100 },
        { item_id: 'doc_003', item_type: 'document', tag: 'important', text: 'Critical project deadline reminder', created_at: 1200, updated_at: 2200 },
        { item_id: 'doc_004', item_type: 'document', tag: 'normal', text: 'Weekly project status summary', created_at: 1300, updated_at: 2300 },
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

    // Verify metadata is preserved
    const item001 = result.items.find(i => i.item_id === 'doc_001');
    if (item001) {
        assertEqual(item001.tag, 'important', 'Tag should be preserved from existingResults');
        assertEqual(item001.created_at, 1000, 'created_at should be preserved');
    }

    indexer.close();
    console.log('✓ BM25Indexer Join Filtering test passed');
}

async function testBM25IndexerPagination(): Promise<void> {
    console.log('\n=== Test: BM25Indexer Pagination ===');
    cleanupTestDB();

    const indexer = new BM25Indexer(getTestDBPath('bm25idx-page'));
    await indexer.initialize();

    // Insert many items
    const items: Item[] = [];
    for (let i = 0; i < 20; i++) {
        items.push({
            item_id: `page_${i}`,
            item_type: 'document',
            tag: 'test',
            text: `Document number ${i} about software development and programming`,
            created_at: 1000 + i * 100,
            updated_at: 2000 + i * 100,
        });
    }
    await indexer.insert(items);

    // Test topK limit
    const result1 = await indexer.search([
        { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: 'software development', topK: 5 } as BM25Query }
    ]);
    assertEqual(result1.items.length, 5, 'Should return 5 items with topK=5');

    // Test offset
    const result2 = await indexer.search(
        [{ indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: 'software development', topK: 10 } as BM25Query }],
        { offset: 3 }
    );
    assert(result2.items.length <= 7, 'Should return at most 7 items with offset=3');

    // Test limit option
    const result3 = await indexer.search(
        [{ indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: 'software development', topK: 10 } as BM25Query }],
        { limit: 3 }
    );
    assertEqual(result3.items.length, 3, 'Should return 3 items with limit=3');

    indexer.close();
    console.log('✓ BM25Indexer Pagination test passed');
}

// ============================================================================
// BM25 边界情况测试
// ============================================================================

async function testBM25EdgeCasesEmptyQuery(): Promise<void> {
    console.log('\n=== Test: BM25 Edge Cases - Empty Query ===');
    cleanupTestDB();

    const indexer = new BM25Indexer(getTestDBPath('bm25-empty'));
    await indexer.initialize();

    const items: Item[] = [
        { item_id: 'doc_001', item_type: 'document', tag: 'test', text: 'Test document content', created_at: 1000, updated_at: 2000 },
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

    indexer.close();
    emptyIndexer.close();
    console.log('✓ BM25 Edge Cases - Empty Query test passed');
}

async function testBM25EdgeCasesConcurrency(): Promise<void> {
    console.log('\n=== Test: BM25 Edge Cases - Concurrency ===');
    cleanupTestDB();

    const indexer = new BM25Indexer(getTestDBPath('bm25-concurrent'));
    await indexer.initialize();

    // Concurrent inserts
    const insertPromises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
        insertPromises.push(indexer.insert([{
            item_id: `concurrent_${i}`,
            item_type: 'document',
            tag: 'test',
            text: `Concurrent document number ${i} about testing`,
            created_at: Date.now(),
            updated_at: Date.now(),
        }]));
    }
    await Promise.all(insertPromises);

    // Verify all inserted
    assertEqual(indexer.getDocumentCount(), 10, 'All 10 concurrent inserts should succeed');

    // Concurrent searches
    const searchPromises: Promise<any>[] = [];
    for (let i = 0; i < 5; i++) {
        searchPromises.push(indexer.search([
            { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: 'document testing', topK: 20 } as BM25Query }
        ]));
    }

    const results = await Promise.all(searchPromises);
    for (const result of results) {
        assert(result.items.length > 0, 'Concurrent search should return results');
    }

    indexer.close();
    console.log('✓ BM25 Edge Cases - Concurrency test passed');
}

// ============================================================================
// BaseIndexDB 单元测试
// ============================================================================

async function testBaseIndexDBInitialization(): Promise<void> {
    console.log('\n=== Test: BaseIndexDB Initialization ===');
    cleanupTestDB();

    const db = new BaseIndexDB(getTestDBPath('base-init'), baseTestSchema);

    assertEqual(db.count(), 0, 'Initial count should be 0');

    db.close();
    console.log('✓ BaseIndexDB Initialization test passed');
}

async function testBaseIndexDBCRUD(): Promise<void> {
    console.log('\n=== Test: BaseIndexDB CRUD ===');
    cleanupTestDB();

    const db = new BaseIndexDB(getTestDBPath('base-crud'), baseTestSchema);

    // Insert
    const record = {
        item_id: 'base_001',
        filename: 'report.pdf',
        created_at: 1000,
        updated_at: 2000,
        size: 1024000,
        owner: 'user@example.com',
        item_type: 'document',
    };

    const inserted = db.insert(record);
    assert(inserted, 'Insert should return true');
    assertEqual(db.count(), 1, 'Count should be 1 after insert');

    // Find by ID
    const found = db.findById('base_001');
    assertEqual(found?.filename, 'report.pdf', 'Found record should match');
    assertEqual(found?.size, 1024000, 'Size should match');
    assertEqual(found?.owner, 'user@example.com', 'Owner should match');

    // Update
    db.update('base_001', { filename: 'updated_report.pdf', size: 2048000 });
    const updated = db.findById('base_001');
    assertEqual(updated?.filename, 'updated_report.pdf', 'Filename should be updated');
    assertEqual(updated?.size, 2048000, 'Size should be updated');

    // Delete
    const deleted = db.delete('base_001');
    assert(deleted, 'Delete should return true');
    assertEqual(db.count(), 0, 'Count should be 0 after delete');

    db.close();
    console.log('✓ BaseIndexDB CRUD test passed');
}

async function testBaseIndexDBBatchOperations(): Promise<void> {
    console.log('\n=== Test: BaseIndexDB Batch Operations ===');
    cleanupTestDB();

    const db = new BaseIndexDB(getTestDBPath('base-batch'), baseTestSchema);

    // Batch insert
    const records: Record<string, any>[] = [];
    for (let i = 0; i < 50; i++) {
        records.push({
            item_id: `batch_${i}`,
            filename: `file_${i}.txt`,
            created_at: 1000 + i * 100,
            updated_at: 2000 + i * 100,
            size: 1000 * (i + 1),
            owner: `user_${i % 5}@example.com`,
            item_type: i % 2 === 0 ? 'document' : 'image',
        });
    }

    const insertedCount = db.insertMany(records);
    assertEqual(insertedCount, 50, 'Should insert 50 records');
    assertEqual(db.count(), 50, 'Should have 50 records');

    // Test duplicate insert (should skip)
    const duplicateCount = db.insertMany(records.slice(0, 5));
    assertEqual(duplicateCount, 0, 'Duplicate inserts should be skipped');

    // Batch delete
    const idsToDelete = records.slice(0, 10).map(r => r.item_id);
    const deletedCount = db.deleteMany(idsToDelete);
    assertEqual(deletedCount, 10, 'Should delete 10 records');
    assertEqual(db.count(), 40, 'Should have 40 records after delete');

    db.close();
    console.log('✓ BaseIndexDB Batch Operations test passed');
}

async function testBaseIndexDBScalarOperators(): Promise<void> {
    console.log('\n=== Test: BaseIndexDB Scalar Operators ===');
    cleanupTestDB();

    const db = new BaseIndexDB(getTestDBPath('base-operators'), baseTestSchema);

    // Insert test data
    const records = [
        { item_id: 'op_001', filename: 'small.txt', created_at: 1000, updated_at: 2000, size: 100, owner: 'alice', item_type: 'document' },
        { item_id: 'op_002', filename: 'medium.pdf', created_at: 1100, updated_at: 2100, size: 5000, owner: 'bob', item_type: 'document' },
        { item_id: 'op_003', filename: 'large.zip', created_at: 1200, updated_at: 2200, size: 100000, owner: 'alice', item_type: 'archive' },
        { item_id: 'op_004', filename: 'image.png', created_at: 1300, updated_at: 2300, size: 50000, owner: 'charlie', item_type: 'image' },
        { item_id: 'op_005', filename: 'report.pdf', created_at: 1400, updated_at: 2400, size: 10000, owner: 'alice', item_type: 'document' },
    ];
    db.insertMany(records);

    // Test = operator
    let result = db.query([{ field: 'owner', operator: '=', value: 'alice' }]);
    assertEqual(result.length, 3, '= operator: Should find 3 items owned by alice');

    // Test != operator
    result = db.query([{ field: 'item_type', operator: '!=', value: 'document' }]);
    assertEqual(result.length, 2, '!= operator: Should find 2 non-documents');

    // Test > operator
    result = db.query([{ field: 'size', operator: '>', value: 10000 }]);
    assertEqual(result.length, 2, '> operator: Should find 2 items larger than 10000');

    // Test >= operator
    result = db.query([{ field: 'size', operator: '>=', value: 10000 }]);
    assertEqual(result.length, 3, '>= operator: Should find 3 items >= 10000');

    // Test < operator
    result = db.query([{ field: 'size', operator: '<', value: 5000 }]);
    assertEqual(result.length, 1, '< operator: Should find 1 item smaller than 5000');

    // Test like operator (lowercase)
    result = db.query([{ field: 'filename', operator: 'like', value: '%.pdf' }]);
    assertEqual(result.length, 2, 'like operator: Should find 2 PDF files');

    // Test in operator (lowercase)
    result = db.query([{ field: 'owner', operator: 'in', value: ['alice', 'bob'] }]);
    assertEqual(result.length, 4, 'in operator: Should find 4 items owned by alice or bob');

    // Test between operator (lowercase)
    result = db.query([{ field: 'size', operator: 'between', value: [1000, 50000] }]);
    assertEqual(result.length, 3, 'between operator: Should find 3 items with size between 1000 and 50000');

    // Test multiple conditions (AND)
    result = db.query([
        { field: 'owner', operator: '=', value: 'alice' },
        { field: 'item_type', operator: '=', value: 'document' }
    ]);
    assertEqual(result.length, 2, 'Multiple conditions: Should find 2 documents owned by alice');

    db.close();
    console.log('✓ BaseIndexDB Scalar Operators test passed');
}

async function testBaseIndexDBPagination(): Promise<void> {
    console.log('\n=== Test: BaseIndexDB Pagination ===');
    cleanupTestDB();

    const db = new BaseIndexDB(getTestDBPath('base-pagination'), baseTestSchema);

    // Insert test data
    const records: Record<string, any>[] = [];
    for (let i = 0; i < 20; i++) {
        records.push({
            item_id: `page_${String(i).padStart(3, '0')}`,
            filename: `file_${i}.txt`,
            created_at: 1000 + i * 100,
            updated_at: 2000 + i * 100,
            size: 1000 * (i + 1),
            owner: 'user',
            item_type: 'document',
        });
    }
    db.insertMany(records);

    // Test limit
    let result = db.findAll({ limit: 5 });
    assertEqual(result.length, 5, 'Limit: Should return 5 items');

    // Test offset
    result = db.findAll({ limit: 5, offset: 10 });
    assertEqual(result.length, 5, 'Offset: Should return 5 items starting from offset 10');

    // Test orderBy DESC
    result = db.findAll({ orderBy: { field: 'size', direction: 'DESC' }, limit: 3 });
    assertEqual(result[0].item_id, 'page_019', 'OrderBy DESC: First item should have largest size');

    // Test orderBy ASC
    result = db.findAll({ orderBy: { field: 'created_at', direction: 'ASC' }, limit: 3 });
    assertEqual(result[0].item_id, 'page_000', 'OrderBy ASC: First item should have smallest created_at');

    db.close();
    console.log('✓ BaseIndexDB Pagination test passed');
}

// ============================================================================
// BaseIndexer 单元测试
// ============================================================================

async function testBaseIndexerInitialization(): Promise<void> {
    console.log('\n=== Test: BaseIndexer Initialization ===');
    cleanupTestDB();

    const indexer = new BaseIndexer(baseTestSchema, getTestDBPath('baseidx-init'));
    await indexer.initialize();

    assertEqual(indexer.name, 'BaseIndexer', 'Name should be BaseIndexer');
    assert(indexer.supportedFields.includes('item_id'), 'Should support item_id field');
    assert(indexer.supportedFields.includes('filename'), 'Should support filename field');
    assert(indexer.supportedFields.includes('size'), 'Should support size field');
    assert(indexer.supportedFields.includes('owner'), 'Should support owner field');
    assert(indexer.supportsOperator('='), 'Should support = operator');
    assert(indexer.supportsOperator('like'), 'Should support like operator');
    assert(indexer.supportsOperator('between'), 'Should support between operator');
    assert(!indexer.supportsOperator('vector_similarity' as any), 'Should not support vector_similarity');
    assert(!indexer.supportsOperator('bm25_match' as any), 'Should not support bm25_match');

    assertEqual(indexer.getCount(), 0, 'Initial count should be 0');

    indexer.close();
    console.log('✓ BaseIndexer Initialization test passed');
}

async function testBaseIndexerCRUD(): Promise<void> {
    console.log('\n=== Test: BaseIndexer CRUD ===');
    cleanupTestDB();

    const indexer = new BaseIndexer(baseTestSchema, getTestDBPath('baseidx-crud'));
    await indexer.initialize();

    // Insert Items
    const items: Item[] = [
        { item_id: 'file_001', item_type: 'file', text: 'Report content', created_at: 1000, updated_at: 2000, filename: 'report.pdf', size: 1024000, owner: 'alice' },
        { item_id: 'file_002', item_type: 'file', text: 'Vacation', created_at: 1100, updated_at: 2100, filename: 'photo.jpg', size: 2048000, owner: 'bob' },
        { item_id: 'file_003', item_type: 'file', text: 'Notes', created_at: 1200, updated_at: 2200, filename: 'notes.txt', size: 512, owner: 'alice' },
    ];

    await indexer.insert(items);
    assertEqual(indexer.getCount(), 3, 'Should have 3 items after insert');

    // Search by owner
    const result1 = await indexer.search([
        { indexer: 'BaseIndexer', field: 'owner', operator: '=', value: 'alice' }
    ]);
    assertEqual(result1.items.length, 2, 'Should find 2 items owned by alice');

    // Search by size
    const result2 = await indexer.search([
        { indexer: 'BaseIndexer', field: 'size', operator: '>', value: 1000000 }
    ]);
    assertEqual(result2.items.length, 2, 'Should find 2 items larger than 1MB');

    // Update
    const updatedItem: Item = { ...items[0], filename: 'updated_report.pdf', size: 2000000 };
    await indexer.update([updatedItem]);

    const result3 = await indexer.search([
        { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'file_001' }
    ]);
    assertEqual(result3.items[0].filename, 'updated_report.pdf', 'Filename should be updated');
    assertEqual(result3.items[0].size, 2000000, 'Size should be updated');

    // Delete
    await indexer.delete(['file_001', 'file_002']);
    assertEqual(indexer.getCount(), 1, 'Should have 1 item after delete');

    indexer.close();
    console.log('✓ BaseIndexer CRUD test passed');
}

async function testBaseIndexerJoinFiltering(): Promise<void> {
    console.log('\n=== Test: BaseIndexer Join Filtering ===');
    cleanupTestDB();

    const indexer = new BaseIndexer(baseTestSchema, getTestDBPath('baseidx-join'));
    await indexer.initialize();

    const items: Item[] = [
        { item_id: 'join_001', item_type: 'file', text: 'Doc 1', created_at: 1000, updated_at: 2000, filename: 'doc1.pdf', size: 1000, owner: 'alice' },
        { item_id: 'join_002', item_type: 'file', text: 'Doc 2', created_at: 1100, updated_at: 2100, filename: 'doc2.pdf', size: 2000, owner: 'bob' },
        { item_id: 'join_003', item_type: 'file', text: 'Img 1', created_at: 1200, updated_at: 2200, filename: 'img1.png', size: 3000, owner: 'alice' },
        { item_id: 'join_004', item_type: 'file', text: 'Doc 3', created_at: 1300, updated_at: 2300, filename: 'doc3.pdf', size: 4000, owner: 'charlie' },
    ];

    await indexer.insert(items);

    // Simulate existing results from another indexer (only some items)
    const existingResults: Item[] = [
        { item_id: 'join_001', item_type: 'file' },
        { item_id: 'join_003', item_type: 'file' },
        { item_id: 'join_004', item_type: 'file' },
    ];

    // Search with join filtering
    const result = await indexer.search(
        [{ indexer: 'BaseIndexer', field: 'owner', operator: '=', value: 'alice' }],
        { existingResults }
    );

    assertEqual(result.items.length, 2, 'Should find 2 items owned by alice from existingResults');

    indexer.close();
    console.log('✓ BaseIndexer Join Filtering test passed');
}

async function testBaseIndexerUnsupportedOperator(): Promise<void> {
    console.log('\n=== Test: BaseIndexer Unsupported Operator ===');
    cleanupTestDB();

    const indexer = new BaseIndexer(baseTestSchema, getTestDBPath('baseidx-unsup'));
    await indexer.initialize();

    let errorThrown = false;
    try {
        await indexer.search([
            { indexer: 'BaseIndexer', field: 'filename', operator: 'vector_similarity' as any, value: 'test' }
        ]);
    } catch (error: any) {
        errorThrown = true;
        assert(error.message.includes('does not support operator'), 'Error should mention unsupported operator');
    }
    assert(errorThrown, 'Should throw error for unsupported operator');

    indexer.close();
    console.log('✓ BaseIndexer Unsupported Operator test passed');
}

async function testBaseIndexerConcurrency(): Promise<void> {
    console.log('\n=== Test: BaseIndexer Concurrency ===');
    cleanupTestDB();

    const indexer = new BaseIndexer(baseTestSchema, getTestDBPath('baseidx-concurrent'));
    await indexer.initialize();

    // Concurrent inserts
    const insertPromises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
        insertPromises.push(indexer.insert([{
            item_id: `concurrent_${i}`,
            item_type: 'file',
            text: `Concurrent document number ${i}`,
            created_at: Date.now(),
            updated_at: Date.now(),
            filename: `file_${i}.txt`,
            size: 1000 * i,
            owner: `user_${i % 3}`,
        }]));
    }
    await Promise.all(insertPromises);

    // Verify all inserted
    assertEqual(indexer.getCount(), 10, 'All 10 concurrent inserts should succeed');

    // Concurrent searches
    const searchPromises: Promise<any>[] = [];
    for (let i = 0; i < 5; i++) {
        searchPromises.push(indexer.search([
            { indexer: 'BaseIndexer', field: 'owner', operator: '=', value: 'user_0' }
        ]));
    }

    const results = await Promise.all(searchPromises);
    for (const result of results) {
        assert(result.items.length > 0, 'Concurrent search should return results');
    }

    indexer.close();
    console.log('✓ BaseIndexer Concurrency test passed');
}

// ============================================================================
// BM25 + 其他 Indexer 集成测试
// ============================================================================

async function testBM25WithTagIndexerJoin(): Promise<void> {
    console.log('\n=== Test: BM25 + TagIndexer Combined Search ===');
    cleanupTestDB();

    // 使用独立的 TagIndexer 和 BM25Indexer 进行组合搜索测试
    const tagIndexer = new TagIndexer(getTestDBPath('bm25-multi-tag'));
    const bm25Indexer = new BM25Indexer(getTestDBPath('bm25-multi-bm25'));

    await tagIndexer.initialize();
    await bm25Indexer.initialize();

    const items: Item[] = [
        { item_id: 'multi_001', item_type: 'document' as ItemType, tag: 'important', text: 'Important project proposal for Q4', created_at: 1000, updated_at: 2000 },
        { item_id: 'multi_002', item_type: 'document' as ItemType, tag: 'important', text: 'Critical budget review document', created_at: 1100, updated_at: 2100 },
        { item_id: 'multi_003', item_type: 'document' as ItemType, tag: 'normal', text: 'Regular project update notes', created_at: 1200, updated_at: 2200 },
        { item_id: 'multi_004', item_type: 'image' as ItemType, tag: 'important', text: 'Project chart image', created_at: 1300, updated_at: 2300 },
        { item_id: 'multi_005', item_type: 'document' as ItemType, tag: 'archived', text: 'Old project documentation', created_at: 1400, updated_at: 2400 },
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
    bm25Indexer.close();
    console.log('✓ BM25 + TagIndexer Combined Search test passed');
}

// ============================================================================
// 运行所有测试
// ============================================================================

async function runAllTests(): Promise<void> {
    console.log('========================================');
    console.log('Storage Indexer Test Suite');
    console.log('========================================');

    const tests = [
        // TagIndexer 单元测试
        testTagIndexerInitialization,
        testTagIndexerCRUD,
        testTagIndexerOperators,
        testTagIndexerUnsupportedOperator,
        testTagIndexerJoinFiltering,
        testTagIndexerPagination,

        // BaseStorage 集成测试
        testBaseStorageSingleIndexer,
        testBaseStorageMultipleConditions,
        testBaseStorageNoConditions,
        testBaseStorageUnknownIndexer,
        testBaseStorageDeleteAndUpdate,

        // VectorIndexDB 单元测试
        testVectorIndexDBInitialization,
        testVectorIndexDBInsertAndSearch,
        testVectorIndexDBUpsert,
        testVectorIndexDBDelete,
        testVectorIndexDBBatchOperations,
        testVectorIndexDBFilteredSearch,
        testVectorIndexDBThreshold,

        // VectorIndexer 单元测试
        testVectorIndexerInitialization,
        testVectorIndexerCRUD,
        testVectorIndexerVectorSimilarity,
        testVectorIndexerVectorNear,
        testVectorIndexerVectorNotSimilar,
        testVectorIndexerUnsupportedOperator,
        testVectorIndexerJoinFiltering,

        // Multi-Indexer 集成测试
        testMultiIndexerCombinedSearch,

        // 边界情况测试
        testEdgeCasesUnicode,
        testEdgeCasesSpecialCharacters,
        testEdgeCasesEmptyResults,
        testEdgeCasesConcurrency,

        // BM25IndexDB 单元测试
        testBM25IndexDBInitialization,
        testBM25IndexDBCRUD,
        testBM25IndexDBBatchOperations,
        testBM25IndexDBUpsert,

        // BM25Indexer 单元测试
        testBM25IndexerInitialization,
        testBM25IndexerCRUD,
        testBM25IndexerSearch,
        testBM25IndexerUnsupportedOperator,
        testBM25IndexerJoinFiltering,
        testBM25IndexerPagination,

        // BM25 边界情况测试
        testBM25EdgeCasesEmptyQuery,
        testBM25EdgeCasesConcurrency,

        // BM25 + 其他 Indexer 集成测试
        testBM25WithTagIndexerJoin,

        // BaseIndexDB 单元测试
        testBaseIndexDBInitialization,
        testBaseIndexDBCRUD,
        testBaseIndexDBBatchOperations,
        testBaseIndexDBScalarOperators,
        testBaseIndexDBPagination,

        // BaseIndexer 单元测试
        testBaseIndexerInitialization,
        testBaseIndexerCRUD,
        testBaseIndexerJoinFiltering,
        testBaseIndexerUnsupportedOperator,
        testBaseIndexerConcurrency,
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

// 执行测试
runAllTests().catch(console.error);
