import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import {
    ARKDATA_SCOPED_SEARCH_BATCH_SIZE,
    BaseStorage,
    ColumnSchema,
    Item
} from '../../../../../main/services/storage/abstract-storage.js';
import { BaseIndexDBArkdata } from '../../../../../main/services/storage/base-index-db-arkdata.js';
import { BaseIndexDBWasm } from '../../../../../main/services/storage/base-index-db-wasm.js';
import { VectorIndexDBArkdata } from '../../../../../main/services/storage/vector-index-db-arkdata.js';
import { ChunkIndexDBArkdata } from '../../../../../main/services/storage/chunk-index-db-arkdata.js';
import { createBaseIndexDB, probeBaseIndexStore } from '../../../../../main/services/storage/base-index-db-factory.js';
import { VectorIndexDBHm } from '../../../../../main/services/storage/vector-index-db-hm.js';
import { ChunkIndexDBHm } from '../../../../../main/services/storage/chunk-index-db-hm.js';

assert.equal((VectorIndexDBHm as any).backend, 'native', 'HM vector DB is a native sqlite/vec0 backend');
assert.equal((ChunkIndexDBHm as any).backend, 'native', 'HM chunk DB is a native sqlite/vec0 backend');
import {
    escapeSqlLikePattern,
    normalizePathDescendantOrSelfValue,
    pathDescendantOrSelfSqlValues
} from '../../../../../main/services/storage/path-scope.js';
import { toArkDataDbPath } from '../../../../../main/services/storage/arkdata-path.js';
import { createWithNativeSqliteFallback } from '../../../../../main/services/storage/platform.js';
import type { DatabaseKit } from '../../../../../platforms/bridges/common.js';

function sortRowsForSql(rows: Record<string, any>[], sql: string): Record<string, any>[] {
    const sorted = rows.map((row) => ({ ...row }));
    const normalized = sql.replace(/\s+/g, ' ').toUpperCase();
    if (normalized.includes('ORDER BY FILENAME ASC, ITEM_ID ASC')) {
        return sorted.sort((left, right) => {
            const byFilename = String(left.filename).localeCompare(String(right.filename));
            return byFilename !== 0 ? byFilename : String(left.item_id).localeCompare(String(right.item_id));
        });
    }
    if (normalized.includes('ORDER BY ITEM_ID ASC')) {
        return sorted.sort((left, right) => String(left.item_id).localeCompare(String(right.item_id)));
    }
    return sorted;
}

type PreparedCall = {
    sql: string;
    params: any[];
    opts?: any;
};

type PreparedManyBatchedCall = {
    sql: string;
    rows: any[][];
    opts?: any;
};

type FakeArkDataContext = {
    queries: string[];
    executePreparedCalls: PreparedCall[];
    executePreparedManyBatchedCalls: PreparedManyBatchedCall[];
    rows: Record<string, any>[];
};

function arkParamValue(param: any): any {
    if (param && typeof param === 'object' && param.t === 'scalar') return param.v;
    return param;
}

function arkParamValues(params: any[] | undefined): any[] {
    return (params ?? []).map((param) => arkParamValue(param));
}

function cloneRows(rows: Record<string, any>[]): Record<string, any>[] {
    return rows.map((row) => ({ ...row }));
}

function applyInsertSql(rows: Record<string, any>[], sql: string, values: any[]): number {
    const match = /^\s*INSERT\s+INTO\s+base_index\s+\(([^)]+)\)\s+VALUES\s+\(([^)]+)\)\s*$/i.exec(sql);
    assert.ok(match, `fake ArkData INSERT only supports fixed base_index shape: ${sql}`);
    const columns = match[1].split(',').map((column) => column.trim());
    const row: Record<string, any> = {};
    columns.forEach((column, index) => {
        row[column] = values[index];
    });
    const itemId = String(row.item_id);
    if (rows.some((existing) => String(existing.item_id) === itemId)) return 0;
    rows.push(row);
    return 1;
}

function applyUpdateSql(rows: Record<string, any>[], sql: string, values: any[]): number {
    const match = /^\s*UPDATE\s+base_index\s+SET\s+(.+)\s+WHERE\s+item_id\s*=\s*\?\s*$/i.exec(sql);
    assert.ok(match, `fake ArkData UPDATE only supports fixed base_index shape: ${sql}`);
    const assignments = match[1].split(',').map((assignment) => {
        const assignmentMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\?\s*$/.exec(assignment);
        assert.ok(assignmentMatch, `fake ArkData UPDATE assignment needs "column = ?": ${assignment}`);
        return assignmentMatch[1];
    });
    const itemId = String(values[assignments.length]);
    const row = rows.find((existing) => String(existing.item_id) === itemId);
    if (!row) return 0;
    assignments.forEach((column, index) => {
        row[column] = values[index];
    });
    return 1;
}

function applyPreparedSql(rows: Record<string, any>[], sql: string, params: any[]): number {
    if (/^\s*INSERT\s+INTO\s+base_index\b/i.test(sql)) {
        return applyInsertSql(rows, sql, params);
    }
    if (/^\s*UPDATE\s+base_index\s+SET\b/i.test(sql)) {
        return applyUpdateSql(rows, sql, params);
    }
    return 0;
}

function selectBaseIndexRows(rows: Record<string, any>[], sql: string, params: any[] = []): Record<string, any>[] {
    let selected = cloneRows(rows);
    if (/\bWHERE\s+item_id\s+IN\s*\(/i.test(sql)) {
        const ids = new Set(params.map((value) => String(value)));
        selected = selected.filter((row) => ids.has(String(row.item_id)));
    } else if (/\bWHERE\s+item_id\s*=\s*\?/i.test(sql)) {
        selected = selected.filter((row) => String(row.item_id) === String(params[0]));
    }
    const limit = /\bLIMIT\s+(\d+)\b/i.exec(sql);
    const offset = /\bOFFSET\s+(\d+)\b/i.exec(sql);
    if (!limit) return sortRowsForSql(selected, sql);
    const limitValue = Number(limit[1]);
    const offsetValue = offset ? Number(offset[1]) : 0;
    return sortRowsForSql(selected, sql).slice(offsetValue, offsetValue + limitValue);
}

async function withFakeArkDataKit<T>(
    seedRows: Record<string, any>[],
    fn: (context: FakeArkDataContext) => Promise<T>
): Promise<T> {
    const { setArkdataDatabaseKit } = await import('../../../../../main/services/storage/arkdata-bridge.js');
    const context: FakeArkDataContext = {
        queries: [],
        executePreparedCalls: [],
        executePreparedManyBatchedCalls: [],
        rows: cloneRows(seedRows)
    };
    const fakeKit: DatabaseKit = {
        available: async () => true,
        execSql: async () => {},
        execSqlParams: async () => {},
        querySqlShort: async (_storeId, sql) => {
            context.queries.push(sql);
            return [];
        },
        openStore: async () => {},
        closeStore: async () => {},
        executePrepared: async (_storeId, sql, params, opts) => {
            const values = arkParamValues(params);
            context.executePreparedCalls.push({ sql, params: values, opts });
            return { affectedRows: applyPreparedSql(context.rows, sql, values) };
        },
        executePreparedMany: async () => ({ affectedRows: 0 }),
        executePreparedManyBatched: async (_storeId, sql, rowParams, opts) => {
            const valueRows = rowParams.map((params) => arkParamValues(params));
            context.executePreparedManyBatchedCalls.push({ sql, rows: valueRows, opts });
            const affectedRows = valueRows.reduce(
                (count, values) => count + applyPreparedSql(context.rows, sql, values),
                0
            );
            return { affectedRows };
        },
        queryPrepared: async (_storeId, sql, params) => {
            context.queries.push(sql);
            if (/^\s*SELECT\s+meta_value\s+FROM\s+__schema_meta_safe\b/i.test(sql)) {
                return [];
            }
            if (/^\s*SELECT\s+\*\s+FROM\s+base_index\b/i.test(sql)) {
                return selectBaseIndexRows(context.rows, sql, arkParamValues(params));
            }
            return [];
        },
        beginTransaction: async () => ({ id: 'fake-tx' }),
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        transaction: async (_storeId, txFn) => txFn({ id: 'fake-tx' })
    };
    const previous = setArkdataDatabaseKit(fakeKit);
    try {
        return await fn(context);
    } finally {
        setArkdataDatabaseKit(previous);
    }
}

function createFakeArkDataBaseIndexDB(name: string): BaseIndexDBArkdata {
    return new BaseIndexDBArkdata(`/tmp/${name}.db`, {
        columns: {
            item_id: { type: 'TEXT' },
            item_type: { type: 'TEXT' },
            filename: { type: 'TEXT' },
            size: { type: 'INTEGER' },
            mtime: { type: 'INTEGER' }
        },
        needIndexers: {}
    });
}

function rowById(context: FakeArkDataContext, itemId: string): Record<string, any> {
    const row = context.rows.find((candidate) => String(candidate.item_id) === itemId);
    assert.ok(row, `expected fake base_index row for item_id=${itemId}`);
    return row;
}

function preparedBaseIndexWrites(context: FakeArkDataContext): PreparedCall[] {
    return context.executePreparedCalls.filter((call) =>
        /^\s*(INSERT\s+INTO\s+base_index|UPDATE\s+base_index\s+SET)\b/i.test(call.sql)
    );
}

function assertBatchedBaseIndexWritesUseFakeTx(calls: PreparedManyBatchedCall[]): void {
    for (const call of calls.filter((candidate) =>
        /^\s*(INSERT\s+INTO\s+base_index|UPDATE\s+base_index\s+SET)\b/i.test(candidate.sql)
    )) {
        assert.equal(call.opts?.txId, 'fake-tx');
        assert.equal(call.opts?.maxRows, 1000);
    }
}

async function testEnsureColumnsAddsMissing() {
    console.log('  testEnsureColumnsAddsMissing...');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensurecols-'));
    const dbPath = path.join(dir, 'b.db');

    const v1 = await createBaseIndexDB(dbPath, {
        columns: { item_id: { type: 'TEXT' }, item_type: { type: 'TEXT' } },
        needIndexers: {}
    });
    await v1.insert({ item_id: 'a', item_type: 'file' });
    v1.close?.();

    const v2 = await createBaseIndexDB(dbPath, {
        columns: {
            item_id: { type: 'TEXT' },
            item_type: { type: 'TEXT' },
            embedded: { type: 'INTEGER', nullable: false, defaultValue: 0 }
        },
        needIndexers: {}
    });
    const row = await v2.findById('a');
    assert.equal(row.embedded, 0, 'new column with DEFAULT 0 backfills existing rows');
    v2.close?.();

    // idempotent — opening a third time must not throw
    const v3 = await createBaseIndexDB(dbPath, {
        columns: {
            item_id: { type: 'TEXT' },
            item_type: { type: 'TEXT' },
            embedded: { type: 'INTEGER', nullable: false, defaultValue: 0 }
        },
        needIndexers: {}
    });
    assert.ok(v3);
    v3.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ✅ testEnsureColumnsAddsMissing');
}

async function testBaseStorageSearchLimit() {
    console.log('  testBaseStorageSearchLimit...');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basestorage-search-limit-'));
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT' },
            item_type: { type: 'TEXT' },
            filename: { type: 'TEXT' }
        },
        needIndexers: {
            filename: [{ indexer: 'BaseIndexer' }]
        }
    };
    const storage = new BaseStorage('search-limit', schema, dir);
    await storage.initialize();

    try {
        const items: Item[] = Array.from({ length: 5 }, (_, i) => ({
            item_id: `file-${i + 1}`,
            item_type: 'file',
            filename: `file-${i + 1}.txt`
        }));
        await storage.insert(items);

        const result = await storage.search(
            [{ indexer: 'BaseIndexer', field: 'filename', operator: 'like', value: '%file%' }],
            { limit: 2, orderBy: { field: 'filename', direction: 'ASC' } }
        );

        assert.equal(result.items.length, 2);
        assert.deepEqual(
            result.items.map((it) => it.item.filename),
            ['file-1.txt', 'file-2.txt']
        );
    } finally {
        await storage.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('  ✅ testBaseStorageSearchLimit');
}

const pathScopeSchema: ColumnSchema = {
    columns: { item_id: { type: 'TEXT' }, item_type: { type: 'TEXT' } },
    needIndexers: {}
};

const pathScopeRows: Item[] = [
    { item_id: '/a/b', item_type: 'file' },
    { item_id: '/a/b/file.txt', item_type: 'file' },
    { item_id: '/a/bb/file.txt', item_type: 'file' },
    { item_id: '/a/%_dir', item_type: 'file' },
    { item_id: '/a/%_dir/child.txt', item_type: 'file' },
    { item_id: '/a/xxdir/child.txt', item_type: 'file' },
    { item_id: '/a/dir\\name', item_type: 'file' },
    { item_id: '/a/dir\\name/child.txt', item_type: 'file' },
    { item_id: '/a/dirname/child.txt', item_type: 'file' },
    { item_id: 'C:/', item_type: 'file' },
    { item_id: 'C:/folder/file.txt', item_type: 'file' }
];

async function assertPathOperator(db: {
    insertMany(records: Record<string, any>[]): Promise<number>;
    search(conditions: any[]): Promise<Record<string, any>[]>;
    count(conditions?: any[]): Promise<number>;
    close(): void;
}) {
    await db.insertMany(pathScopeRows);
    const condition = (value: unknown) => [{ field: 'item_id', operator: 'path_descendant_or_self', value }];

    assert.deepEqual((await db.search(condition('/a/b/'))).map((row) => row.item_id).sort(), ['/a/b', '/a/b/file.txt']);
    assert.deepEqual((await db.search(condition('/a/%_dir'))).map((row) => row.item_id).sort(), [
        '/a/%_dir',
        '/a/%_dir/child.txt'
    ]);
    assert.deepEqual((await db.search(condition('/a/dir\\name'))).map((row) => row.item_id).sort(), [
        '/a/dir\\name',
        '/a/dir\\name/child.txt'
    ]);
    assert.equal(await db.count(condition('C:/')), 2);
    await assert.rejects(() => db.search(condition('')), /non-empty string/);
    await assert.rejects(() => db.search(condition(42)), /non-empty string/);
}

async function testPathScopeHelpers() {
    console.log('  testPathScopeHelpers...');
    assert.equal(normalizePathDescendantOrSelfValue('/'), '/');
    assert.equal(normalizePathDescendantOrSelfValue('C:/'), 'C:/');
    assert.equal(normalizePathDescendantOrSelfValue('//server/share/'), '//server/share');
    assert.equal(normalizePathDescendantOrSelfValue('/a/b///'), '/a/b');
    assert.equal(escapeSqlLikePattern('/a/%_dir\\name'), '/a/\\%\\_dir\\\\name');
    assert.deepEqual(pathDescendantOrSelfSqlValues('/'), ['/', '/%']);
    assert.deepEqual(pathDescendantOrSelfSqlValues('C:/'), ['C:/', 'C:/%']);
    assert.throws(() => normalizePathDescendantOrSelfValue(''), /non-empty string/);
    assert.throws(() => normalizePathDescendantOrSelfValue(1), /non-empty string/);
    console.log('  ✅ testPathScopeHelpers');
}

async function testNativePathDescendantOrSelfOperator() {
    console.log('  testNativePathDescendantOrSelfOperator...');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-path-scope-'));
    const db = await createBaseIndexDB(path.join(dir, 'base-index.db'), pathScopeSchema);
    try {
        await assertPathOperator(db);
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('  ✅ testNativePathDescendantOrSelfOperator');
}

async function testWasmPathDescendantOrSelfOperator() {
    console.log('  testWasmPathDescendantOrSelfOperator...');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-path-scope-'));
    const db = new BaseIndexDBWasm(path.join(dir, 'base-index.db'), pathScopeSchema);
    try {
        await assertPathOperator(db);
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('  ✅ testWasmPathDescendantOrSelfOperator');
}

async function testArkDataPathDescendantOrSelfBindings() {
    console.log('  testArkDataPathDescendantOrSelfBindings...');
    const calls: Array<{ sql: string; params: unknown[] }> = [];
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
        queryPrepared: async (_storeId, sql, params = []) => {
            calls.push({ sql, params });
            if (/COUNT\(\*\)/i.test(sql)) return [{ count: 0 }];
            return [];
        },
        beginTransaction: async () => ({ id: 'fake-tx' }),
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        transaction: async (_storeId, txFn) => txFn({ id: 'fake-tx' })
    };
    const { setArkdataDatabaseKit } = await import('../../../../../main/services/storage/arkdata-bridge.js');
    const previous = setArkdataDatabaseKit(fakeKit);
    const db = new BaseIndexDBArkdata('/tmp/fake-arkdata-path-scope.db', pathScopeSchema);
    try {
        const condition = [{ field: 'item_id', operator: 'path_descendant_or_self' as const, value: '/a/%_dir/' }];
        await db.search(condition);
        await db.count(condition);
        const scopedCalls = calls.filter((call) => call.sql.includes('ESCAPE'));
        assert.ok(scopedCalls.length >= 2);
        for (const call of scopedCalls) {
            assert.ok(call.sql.includes(`(item_id = ? OR item_id LIKE ? ESCAPE '\\')`));
            assert.deepEqual(call.params.slice(0, 2), [
                { t: 'scalar', v: '/a/%_dir' },
                { t: 'scalar', v: '/a/\\%\\_dir/%' }
            ]);
        }
    } finally {
        db.close();
        setArkdataDatabaseKit(previous);
    }
    console.log('  ✅ testArkDataPathDescendantOrSelfBindings');
}

async function testBaseIndexStoreProbeMissingDoesNotCreateFile() {
    console.log('  testBaseIndexStoreProbeMissingDoesNotCreateFile...');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-probe-missing-'));
    const dbPath = path.join(dir, 'base-index.db');

    try {
        const result = await probeBaseIndexStore(dbPath);

        assert.equal(result, 'missing');
        assert.equal(fs.existsSync(dbPath), false, 'missing probe must not create a sqlite file');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('  ✅ testBaseIndexStoreProbeMissingDoesNotCreateFile');
}

async function testBaseIndexStoreProbeExisting() {
    console.log('  testBaseIndexStoreProbeExisting...');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-probe-existing-'));
    const dbPath = path.join(dir, 'base-index.db');

    try {
        const db = await createBaseIndexDB(dbPath, {
            columns: { item_id: { type: 'TEXT' }, item_type: { type: 'TEXT' } },
            needIndexers: {}
        });
        db.close?.();

        assert.equal(await probeBaseIndexStore(dbPath), 'exists');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('  ✅ testBaseIndexStoreProbeExisting');
}

async function testBaseStorageProbeIndexers() {
    console.log('  testBaseStorageProbeIndexers...');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-probe-indexers-'));
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT' },
            item_type: { type: 'TEXT' },
            filename: { type: 'TEXT' },
            chunk_text: { type: 'TEXT' }
        },
        needIndexers: {
            filename: [{ indexer: 'VectorIndexer', options: { dim: 4 } }],
            chunk_text: [{ indexer: 'ChunkIndexer', options: { dim: 4 } }]
        }
    };
    const storage = new BaseStorage('probe-indexers', schema, dir);

    try {
        assert.equal(await storage.probeBaseIndexStore(), 'missing');
        assert.deepEqual(await storage.probeIndexers(['VectorIndexer', 'ChunkIndexer']), {
            VectorIndexer: 'missing',
            ChunkIndexer: 'missing'
        });

        await storage.initialize();

        assert.equal(await storage.probeBaseIndexStore(), 'exists');
        assert.deepEqual(await storage.probeIndexers(['VectorIndexer', 'ChunkIndexer']), {
            VectorIndexer: 'exists',
            ChunkIndexer: 'exists'
        });
    } finally {
        storage.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('  ✅ testBaseStorageProbeIndexers');
}

async function testArkDataDbPathUsesFormalDatabaseSuffix() {
    console.log('  testArkDataDbPathUsesFormalDatabaseSuffix...');
    assert.equal(toArkDataDbPath('/tmp/base-index.db'), '/tmp/base-index-arkdata-database.db');
    assert.equal(toArkDataDbPath('/tmp/vector-index.db'), '/tmp/vector-index-arkdata-database.db');
    assert.equal(toArkDataDbPath('/tmp/chunk-index.db'), '/tmp/chunk-index-arkdata-database.db');
    assert.equal(
        toArkDataDbPath('/tmp/base-index-arkdata-database.db'),
        '/tmp/base-index-arkdata-database.db',
        'formal ArkData path conversion must be idempotent'
    );
    console.log('  ✅ testArkDataDbPathUsesFormalDatabaseSuffix');
}

async function testArkDataFindAllPaginatesUnboundedSearch() {
    console.log('  testArkDataFindAllPaginatesUnboundedSearch...');
    const rows = Array.from({ length: 12001 }, (_, index) => {
        const itemNumber = 12001 - index;
        return {
            item_id: `file-${String(itemNumber).padStart(5, '0')}`,
            item_type: 'file',
            filename: `file-${index + 1}.txt`
        };
    });

    await withFakeArkDataKit(rows, async (context) => {
        const db = new BaseIndexDBArkdata('/tmp/fake-arkdata-unbounded.db', {
            columns: {
                item_id: { type: 'TEXT' },
                item_type: { type: 'TEXT' },
                filename: { type: 'TEXT' }
            },
            needIndexers: {}
        });

        try {
            const result = await db.search([]);

            assert.equal(result.length, 12001);
            assert.equal(result[0].item_id, 'file-00001');
            assert.equal(result[12000].item_id, 'file-12001');
            assert.ok(context.queries.some((sql) => /ORDER BY\s+item_id\s+ASC/i.test(sql)));
            assert.ok(context.queries.some((sql) => /\bOFFSET\s+0\b/i.test(sql)));
            assert.ok(context.queries.some((sql) => /\bOFFSET\s+5000\b/i.test(sql)));
            assert.ok(context.queries.some((sql) => /\bOFFSET\s+10000\b/i.test(sql)));
        } finally {
            db.close();
        }
    });

    console.log('  ✅ testArkDataFindAllPaginatesUnboundedSearch');
}

async function testArkDataFindAllPreservesSmallExplicitLimitShape() {
    console.log('  testArkDataFindAllPreservesSmallExplicitLimitShape...');
    const rows = Array.from({ length: 3000 }, (_, index) => ({
        item_id: `small-${String(index + 1).padStart(5, '0')}`,
        item_type: 'file',
        filename: `small-${index + 1}.txt`
    }));

    await withFakeArkDataKit(rows, async (context) => {
        const db = new BaseIndexDBArkdata('/tmp/fake-arkdata-small-limit.db', {
            columns: {
                item_id: { type: 'TEXT' },
                item_type: { type: 'TEXT' },
                filename: { type: 'TEXT' }
            },
            needIndexers: {}
        });

        try {
            const result = await db.search([], { limit: 1200 });
            const dataQueries = context.queries.filter((sql) => /\bFROM\s+base_index\b/i.test(sql));

            assert.equal(result.length, 1200);
            assert.equal(dataQueries.length, 1);
            assert.ok(/\bLIMIT\s+1200\b/i.test(dataQueries[0]));
            assert.ok(!/\bORDER\s+BY\b/i.test(dataQueries[0]));
        } finally {
            db.close();
        }
    });

    console.log('  ✅ testArkDataFindAllPreservesSmallExplicitLimitShape');
}

async function testArkDataFindAllPaginatesExplicitLimitGreaterThanCap() {
    console.log('  testArkDataFindAllPaginatesExplicitLimitGreaterThanCap...');
    const rows = Array.from({ length: 13000 }, (_, index) => {
        const itemNumber = 13000 - index;
        return {
            item_id: `large-${String(itemNumber).padStart(5, '0')}`,
            item_type: 'file',
            filename: `large-${index + 1}.txt`
        };
    });

    await withFakeArkDataKit(rows, async (context) => {
        const db = new BaseIndexDBArkdata('/tmp/fake-arkdata-large-limit.db', {
            columns: {
                item_id: { type: 'TEXT' },
                item_type: { type: 'TEXT' },
                filename: { type: 'TEXT' }
            },
            needIndexers: {}
        });

        try {
            const result = await db.search([], { limit: 12000 });

            assert.equal(result.length, 12000);
            assert.equal(result[0].item_id, 'large-00001');
            assert.equal(result[11999].item_id, 'large-12000');
            assert.ok(context.queries.some((sql) => /\bLIMIT\s+5000\s+OFFSET\s+0\b/i.test(sql)));
            assert.ok(context.queries.some((sql) => /\bLIMIT\s+5000\s+OFFSET\s+5000\b/i.test(sql)));
            assert.ok(context.queries.some((sql) => /\bLIMIT\s+2000\s+OFFSET\s+10000\b/i.test(sql)));
        } finally {
            db.close();
        }
    });

    console.log('  ✅ testArkDataFindAllPaginatesExplicitLimitGreaterThanCap');
}

async function testArkDataFindAllPaginatesExplicitOffset() {
    console.log('  testArkDataFindAllPaginatesExplicitOffset...');
    const rows = Array.from({ length: 9000 }, (_, index) => {
        const itemNumber = 9000 - index;
        return {
            item_id: `offset-${String(itemNumber).padStart(5, '0')}`,
            item_type: 'file',
            filename: `offset-${index + 1}.txt`
        };
    });

    await withFakeArkDataKit(rows, async (context) => {
        const db = new BaseIndexDBArkdata('/tmp/fake-arkdata-offset.db', {
            columns: {
                item_id: { type: 'TEXT' },
                item_type: { type: 'TEXT' },
                filename: { type: 'TEXT' }
            },
            needIndexers: {}
        });

        try {
            const result = await db.search([], { limit: 1200, offset: 6000 });

            assert.equal(result.length, 1200);
            assert.equal(result[0].item_id, 'offset-06001');
            assert.equal(result[1199].item_id, 'offset-07200');
            assert.ok(context.queries.some((sql) => /ORDER BY\s+item_id\s+ASC/i.test(sql)));
            assert.ok(context.queries.some((sql) => /\bLIMIT\s+1200\b/i.test(sql)));
            assert.ok(context.queries.some((sql) => /\bOFFSET\s+6000\b/i.test(sql)));
        } finally {
            db.close();
        }
    });

    console.log('  ✅ testArkDataFindAllPaginatesExplicitOffset');
}

async function testArkDataSemanticFiltersUseExactInSql(): Promise<void> {
    const { setArkdataDatabaseKit } = await import('../../../../../main/services/storage/arkdata-bridge.js');
    const queries: Array<{ sql: string; params: any[] }> = [];
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
        queryPrepared: async (_storeId, sql, params = []) => {
            queries.push({ sql, params });
            return [];
        },
        beginTransaction: async () => ({ id: 'fake-tx' }),
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        transaction: async (_storeId, txFn) => txFn({ id: 'fake-tx' })
    };
    const previous = setArkdataDatabaseKit(fakeKit);
    try {
        await new VectorIndexDBArkdata('/tmp/scoped-vector-sql.db', 4).search(
            [1, 0, 0, 0],
            { columnName: 'filename', topK: 2 },
            ['a', 'b']
        );
        await new ChunkIndexDBArkdata('/tmp/scoped-chunk-sql.db', 4).search([1, 0, 0, 0], { topK: 2 }, ['a', 'b']);
    } finally {
        setArkdataDatabaseKit(previous);
    }
    const [vector, chunk] = queries;
    assert.match(vector.sql, /WHERE item_type = \? AND item_id IN \(\?,\?\)/);
    assert.equal(vector.params.length, 5, 'query vector + column + two IDs + order vector');
    assert.match(chunk.sql, /WHERE item_id IN \(\?,\?\)/);
    assert.equal(chunk.params.length, 4, 'query vector + two IDs + order vector');
}

async function testArkDataInsertManyBatchesSameInsertShape() {
    console.log('  testArkDataInsertManyBatchesSameInsertShape...');
    await withFakeArkDataKit([], async (context) => {
        const db = createFakeArkDataBaseIndexDB('fake-arkdata-insert-many-same-shape');
        try {
            const inserted = await db.insertMany([
                { item_id: 'a', item_type: 'file', filename: 'a.txt', size: 10 },
                { item_id: 'b', item_type: 'file', filename: 'b.txt', size: 20 }
            ]);

            assert.equal(inserted, 2);
            assert.equal(context.executePreparedManyBatchedCalls.length, 1);
            assertBatchedBaseIndexWritesUseFakeTx(context.executePreparedManyBatchedCalls);
            assert.equal(preparedBaseIndexWrites(context).length, 0, 'batched insertMany must not use per-row fallback');
            assert.match(
                context.executePreparedManyBatchedCalls[0].sql,
                /^INSERT INTO base_index \(item_id, item_type, filename, size\) VALUES \(\?, \?, \?, \?\)$/
            );
            assert.deepEqual(context.executePreparedManyBatchedCalls[0].rows, [
                ['a', 'file', 'a.txt', 10],
                ['b', 'file', 'b.txt', 20]
            ]);
            assert.deepEqual(rowById(context, 'a'), {
                item_id: 'a',
                item_type: 'file',
                filename: 'a.txt',
                size: 10
            });
            assert.deepEqual(rowById(context, 'b'), {
                item_id: 'b',
                item_type: 'file',
                filename: 'b.txt',
                size: 20
            });
        } finally {
            db.close();
        }
    });
    console.log('  ✅ testArkDataInsertManyBatchesSameInsertShape');
}

async function testArkDataInsertManySplitsDifferentInsertShapes() {
    console.log('  testArkDataInsertManySplitsDifferentInsertShapes...');
    await withFakeArkDataKit([], async (context) => {
        const db = createFakeArkDataBaseIndexDB('fake-arkdata-insert-many-split-shapes');
        try {
            const inserted = await db.insertMany([
                { item_id: 'a', item_type: 'file', filename: 'a.txt' },
                { item_id: 'b', item_type: 'file', filename: 'b.txt', size: 20 },
                { item_id: 'c', item_type: 'file', filename: 'c.txt' }
            ]);

            assert.equal(inserted, 3);
            assert.equal(context.executePreparedManyBatchedCalls.length, 2);
            assertBatchedBaseIndexWritesUseFakeTx(context.executePreparedManyBatchedCalls);
            assert.equal(preparedBaseIndexWrites(context).length, 0, 'batched insertMany must not use per-row fallback');
            assert.deepEqual(
                context.executePreparedManyBatchedCalls.map((call) => call.rows.length).sort((left, right) => left - right),
                [1, 2]
            );
            assert.ok(
                context.executePreparedManyBatchedCalls.some(
                    (call) =>
                        call.sql === 'INSERT INTO base_index (item_id, item_type, filename) VALUES (?, ?, ?)' &&
                        call.rows.length === 2
                )
            );
            assert.ok(
                context.executePreparedManyBatchedCalls.some(
                    (call) =>
                        call.sql === 'INSERT INTO base_index (item_id, item_type, filename, size) VALUES (?, ?, ?, ?)' &&
                        call.rows.length === 1
                )
            );
            assert.equal(rowById(context, 'b').size, 20);
        } finally {
            db.close();
        }
    });
    console.log('  ✅ testArkDataInsertManySplitsDifferentInsertShapes');
}

async function testArkDataUpsertManyHandlesMixedInsertUpdateNoopRows() {
    console.log('  testArkDataUpsertManyHandlesMixedInsertUpdateNoopRows...');
    await withFakeArkDataKit(
        [
            { item_id: 'existing-update', item_type: 'file', filename: 'old.txt', size: 10 },
            { item_id: 'existing-noop', item_type: 'file', filename: 'same.txt', size: 20 }
        ],
        async (context) => {
            const db = createFakeArkDataBaseIndexDB('fake-arkdata-upsert-many-mixed');
            try {
                const changed = await db.upsertMany([
                    { item_id: 'new-row', item_type: 'file', filename: 'new.txt', size: 30 },
                    { item_id: 'existing-update', item_type: 'file', filename: 'newer.txt', size: 10 },
                    { item_id: 'existing-noop', item_type: 'file', filename: 'same.txt', size: 20 }
                ]);

                assert.equal(changed, 2);
                assert.equal(context.executePreparedManyBatchedCalls.length, 2);
                assertBatchedBaseIndexWritesUseFakeTx(context.executePreparedManyBatchedCalls);
                assert.equal(preparedBaseIndexWrites(context).length, 0, 'non-duplicate upsertMany must batch writes');
                const insertCall = context.executePreparedManyBatchedCalls.find(
                    (call) => call.sql === 'INSERT INTO base_index (item_id, item_type, filename, size) VALUES (?, ?, ?, ?)'
                );
                const updateCall = context.executePreparedManyBatchedCalls.find(
                    (call) => call.sql === 'UPDATE base_index SET item_type = ?, filename = ?, size = ? WHERE item_id = ?'
                );
                assert.ok(insertCall);
                assert.ok(updateCall);
                assert.deepEqual(insertCall.rows, [['new-row', 'file', 'new.txt', 30]]);
                assert.deepEqual(updateCall.rows, [['file', 'newer.txt', 10, 'existing-update']]);
                assert.equal(rowById(context, 'new-row').filename, 'new.txt');
                assert.equal(rowById(context, 'existing-update').filename, 'newer.txt');
                assert.equal(rowById(context, 'existing-noop').filename, 'same.txt');
            } finally {
                db.close();
            }
        }
    );
    console.log('  ✅ testArkDataUpsertManyHandlesMixedInsertUpdateNoopRows');
}

async function testArkDataUpsertManyUpdatesAllProvidedColumnsWhenAnyChanges() {
    console.log('  testArkDataUpsertManyUpdatesAllProvidedColumnsWhenAnyChanges...');
    await withFakeArkDataKit(
        [{ item_id: 'a', item_type: 'file', filename: 'old.txt', size: 10, mtime: 1 }],
        async (context) => {
            const db = createFakeArkDataBaseIndexDB('fake-arkdata-upsert-many-all-provided-columns');
            try {
                const changed = await db.upsertMany([{ item_id: 'a', filename: 'new.txt', size: 10, mtime: 2 }]);

                assert.equal(changed, 1);
                assert.equal(context.executePreparedManyBatchedCalls.length, 1);
                assertBatchedBaseIndexWritesUseFakeTx(context.executePreparedManyBatchedCalls);
                assert.equal(preparedBaseIndexWrites(context).length, 0, 'non-duplicate upsertMany must batch writes');
                assert.equal(
                    context.executePreparedManyBatchedCalls[0].sql,
                    'UPDATE base_index SET filename = ?, size = ?, mtime = ? WHERE item_id = ?'
                );
                assert.deepEqual(context.executePreparedManyBatchedCalls[0].rows, [['new.txt', 10, 2, 'a']]);
                assert.deepEqual(rowById(context, 'a'), {
                    item_id: 'a',
                    item_type: 'file',
                    filename: 'new.txt',
                    size: 10,
                    mtime: 2
                });
            } finally {
                db.close();
            }
        }
    );
    console.log('  ✅ testArkDataUpsertManyUpdatesAllProvidedColumnsWhenAnyChanges');
}

async function testArkDataUpdateManyGroupsByProvidedUpdateColumns() {
    console.log('  testArkDataUpdateManyGroupsByProvidedUpdateColumns...');
    await withFakeArkDataKit(
        [
            { item_id: 'a', item_type: 'file', filename: 'a-old.txt', size: 1 },
            { item_id: 'b', item_type: 'file', filename: 'b-old.txt', size: 2 },
            { item_id: 'c', item_type: 'file', filename: 'c-old.txt', size: 3 }
        ],
        async (context) => {
            const db = createFakeArkDataBaseIndexDB('fake-arkdata-update-many-groups');
            try {
                const changed = await db.updateMany([
                    { item_id: 'a', filename: 'a-new.txt', size: 10 },
                    { item_id: 'b', filename: 'b-new.txt', size: 20 },
                    { item_id: 'c', filename: 'c-new.txt' }
                ]);

                assert.equal(changed, 3);
                assert.equal(context.executePreparedManyBatchedCalls.length, 2);
                assertBatchedBaseIndexWritesUseFakeTx(context.executePreparedManyBatchedCalls);
                assert.equal(preparedBaseIndexWrites(context).length, 0, 'non-duplicate updateMany must batch writes');
                const filenameSizeCall = context.executePreparedManyBatchedCalls.find(
                    (call) => call.sql === 'UPDATE base_index SET filename = ?, size = ? WHERE item_id = ?'
                );
                const filenameCall = context.executePreparedManyBatchedCalls.find(
                    (call) => call.sql === 'UPDATE base_index SET filename = ? WHERE item_id = ?'
                );
                assert.ok(filenameSizeCall);
                assert.ok(filenameCall);
                assert.deepEqual(filenameSizeCall.rows, [
                    ['a-new.txt', 10, 'a'],
                    ['b-new.txt', 20, 'b']
                ]);
                assert.deepEqual(filenameCall.rows, [['c-new.txt', 'c']]);
                assert.equal(rowById(context, 'a').size, 10);
                assert.equal(rowById(context, 'b').filename, 'b-new.txt');
                assert.equal(rowById(context, 'c').filename, 'c-new.txt');
                assert.equal(rowById(context, 'c').size, 3);
            } finally {
                db.close();
            }
        }
    );
    console.log('  ✅ testArkDataUpdateManyGroupsByProvidedUpdateColumns');
}

async function testArkDataDuplicateItemIdUsesSequentialFallback() {
    console.log('  testArkDataDuplicateItemIdUsesSequentialFallback...');
    await withFakeArkDataKit([], async (context) => {
        const db = createFakeArkDataBaseIndexDB('fake-arkdata-duplicate-sequential-fallback');
        try {
            const changed = await db.upsertMany([
                { item_id: 'dup', item_type: 'file', filename: 'first.txt' },
                { item_id: 'dup', item_type: 'file', filename: 'second.txt' }
            ]);

            assert.equal(changed, 2);
            assert.equal(context.executePreparedManyBatchedCalls.length, 0, 'duplicate rows must avoid batch writes');
            assert.equal(preparedBaseIndexWrites(context).length, 2, 'duplicate rows must use sequential fallback');
            assert.deepEqual(
                preparedBaseIndexWrites(context).map((call) => call.sql),
                [
                    'INSERT INTO base_index (item_id, item_type, filename) VALUES (?, ?, ?)',
                    'UPDATE base_index SET item_type = ?, filename = ? WHERE item_id = ?'
                ]
            );
            assert.equal(rowById(context, 'dup').filename, 'second.txt');
        } finally {
            db.close();
        }
    });
    console.log('  ✅ testArkDataDuplicateItemIdUsesSequentialFallback');
}

async function testArkDataDuplicateDetectionNormalizesItemIdToString() {
    console.log('  testArkDataDuplicateDetectionNormalizesItemIdToString...');
    await withFakeArkDataKit([], async (context) => {
        const db = createFakeArkDataBaseIndexDB('fake-arkdata-duplicate-string-normalization');
        try {
            const changed = await db.upsertMany([
                { item_id: 1, item_type: 'file', filename: 'numeric.txt' },
                { item_id: '1', item_type: 'file', filename: 'string.txt' }
            ]);

            assert.equal(changed, 2);
            assert.equal(context.executePreparedManyBatchedCalls.length, 0, 'normalized duplicate ids must avoid batch writes');
            assert.equal(preparedBaseIndexWrites(context).length, 2, 'normalized duplicate ids must use sequential fallback');
            assert.equal(rowById(context, '1').filename, 'string.txt');
        } finally {
            db.close();
        }
    });
    console.log('  ✅ testArkDataDuplicateDetectionNormalizesItemIdToString');
}

async function testArkDataDifferentObjectKeyOrderUsesSameShape() {
    console.log('  testArkDataDifferentObjectKeyOrderUsesSameShape...');
    await withFakeArkDataKit([], async (context) => {
        const db = createFakeArkDataBaseIndexDB('fake-arkdata-key-order-shape');
        try {
            const inserted = await db.insertMany([
                { filename: 'a.txt', item_type: 'file', item_id: 'a', size: 10 },
                { size: 20, item_id: 'b', filename: 'b.txt', item_type: 'file' }
            ]);

            assert.equal(inserted, 2);
            assert.equal(context.executePreparedManyBatchedCalls.length, 1);
            assertBatchedBaseIndexWritesUseFakeTx(context.executePreparedManyBatchedCalls);
            assert.equal(preparedBaseIndexWrites(context).length, 0, 'same effective field set must batch together');
            assert.equal(
                context.executePreparedManyBatchedCalls[0].sql,
                'INSERT INTO base_index (item_id, item_type, filename, size) VALUES (?, ?, ?, ?)'
            );
            assert.deepEqual(context.executePreparedManyBatchedCalls[0].rows, [
                ['a', 'file', 'a.txt', 10],
                ['b', 'file', 'b.txt', 20]
            ]);
        } finally {
            db.close();
        }
    });
    console.log('  ✅ testArkDataDifferentObjectKeyOrderUsesSameShape');
}

async function testArkDataUndefinedFieldsExcludedFromShapeAndDoNotOverwrite() {
    console.log('  testArkDataUndefinedFieldsExcludedFromShapeAndDoNotOverwrite...');
    await withFakeArkDataKit(
        [{ item_id: 'a', item_type: 'file', filename: 'keep.txt', size: 10, mtime: 1 }],
        async (context) => {
            const db = createFakeArkDataBaseIndexDB('fake-arkdata-undefined-excluded');
            try {
                const changed = await db.updateMany([{ item_id: 'a', filename: undefined, size: 20 }]);

                assert.equal(changed, 1);
                assert.equal(context.executePreparedManyBatchedCalls.length, 1);
                assertBatchedBaseIndexWritesUseFakeTx(context.executePreparedManyBatchedCalls);
                assert.equal(preparedBaseIndexWrites(context).length, 0, 'non-duplicate updateMany must batch writes');
                assert.equal(
                    context.executePreparedManyBatchedCalls[0].sql,
                    'UPDATE base_index SET size = ? WHERE item_id = ?'
                );
                assert.deepEqual(context.executePreparedManyBatchedCalls[0].rows, [[20, 'a']]);
                assert.equal(rowById(context, 'a').filename, 'keep.txt');
                assert.equal(rowById(context, 'a').size, 20);
            } finally {
                db.close();
            }
        }
    );
    console.log('  ✅ testArkDataUndefinedFieldsExcludedFromShapeAndDoNotOverwrite');
}

async function testNativeSqliteFallbackUsesWasmForMissingBinding() {
    console.log('  testNativeSqliteFallbackUsesWasmForMissingBinding...');
    const calls: string[] = [];
    const result = await createWithNativeSqliteFallback(
        async () => {
            calls.push('native');
            const error = new Error('Could not locate the bindings file. Tried: better_sqlite3.node');
            (error as Error & { code?: string }).code = 'MODULE_NOT_FOUND';
            throw error;
        },
        async () => {
            calls.push('wasm');
            return 'wasm-db';
        },
        { forceWasm: false }
    );

    assert.equal(result, 'wasm-db');
    assert.deepEqual(calls, ['native', 'wasm']);
    console.log('  ✅ testNativeSqliteFallbackUsesWasmForMissingBinding');
}

async function testNativeSqliteFallbackRethrowsUnrelatedErrors() {
    console.log('  testNativeSqliteFallbackRethrowsUnrelatedErrors...');
    await assert.rejects(
        () =>
            createWithNativeSqliteFallback(
                async () => {
                    throw new Error('SQLITE_CORRUPT: database disk image is malformed');
                },
                async () => 'wasm-db',
                { forceWasm: false }
            ),
        /SQLITE_CORRUPT/
    );
    console.log('  ✅ testNativeSqliteFallbackRethrowsUnrelatedErrors');
}

async function testNativeSqliteFallbackRespectsForcedWasmPlatform() {
    console.log('  testNativeSqliteFallbackRespectsForcedWasmPlatform...');
    const calls: string[] = [];
    const result = await createWithNativeSqliteFallback(
        async () => {
            calls.push('native');
            return 'native-db';
        },
        async () => {
            calls.push('wasm');
            return 'wasm-db';
        },
        { forceWasm: true }
    );

    assert.equal(result, 'wasm-db');
    assert.deepEqual(calls, ['wasm']);
    console.log('  ✅ testNativeSqliteFallbackRespectsForcedWasmPlatform');
}

async function testDropIndexersDeletesOwnedFilesAndSidecars() {
    console.log('  testDropIndexersDeletesOwnedFilesAndSidecars...');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-indexers-files-'));
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT' },
            item_type: { type: 'TEXT' },
            filename: { type: 'TEXT' },
            chunk_text: { type: 'TEXT' }
        },
        needIndexers: {
            filename: [{ indexer: 'VectorIndexer', options: { dim: 4 } }],
            chunk_text: [{ indexer: 'ChunkIndexer', options: { dim: 4 } }]
        }
    };
    const storage = new BaseStorage('drop-indexers-files', schema, dir);
    await storage.initialize();

    const vectorDb = path.join(dir, 'vector-index.db');
    const chunkDb = path.join(dir, 'chunk-index.db');

    await storage.dropIndexers(['VectorIndexer', 'ChunkIndexer']);
    storage.close();

    assert.equal(fs.existsSync(vectorDb), false, 'VectorIndexer DB file must be removed');
    assert.equal(fs.existsSync(chunkDb), false, 'ChunkIndexer DB file must be removed');
    assert.equal(fs.existsSync(path.join(dir, 'base-index.db')), true, 'BaseIndexer DB must be preserved');

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ✅ testDropIndexersDeletesOwnedFilesAndSidecars');
}

async function testDropIndexersNoopAndPostDropCloseAreSafe() {
    console.log('  testDropIndexersNoopAndPostDropCloseAreSafe...');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-indexers-noop-'));
    const schema: ColumnSchema = {
        columns: { item_id: { type: 'TEXT' }, item_type: { type: 'TEXT' } },
        needIndexers: {}
    };
    const storage = new BaseStorage('drop-indexers-noop', schema, dir);
    await storage.initialize();

    await storage.dropIndexers([]);
    await storage.dropIndexers(['BaseIndexer']);
    storage.close();

    assert.equal(fs.existsSync(path.join(dir, 'base-index.db')), false, 'BaseIndexer DB file must be removed');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ✅ testDropIndexersNoopAndPostDropCloseAreSafe');
}

async function testDropIndexersPartialFailurePoisonsStorage() {
    console.log('  testDropIndexersPartialFailurePoisonsStorage...');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-indexers-poison-'));
    const schema: ColumnSchema = {
        columns: { item_id: { type: 'TEXT' }, item_type: { type: 'TEXT' } },
        needIndexers: {}
    };
    const storage = new BaseStorage('drop-indexers-poison', schema, dir);
    await storage.initialize();

    (storage as any).bm25Indexer = {
        dropStorage: async () => {
            throw new Error('synthetic bm25 drop failure');
        },
        close: () => {},
        getInfo: async () => ({})
    };

    await assert.rejects(() => storage.dropIndexers(['BaseIndexer', 'BM25Indexer']), /synthetic bm25 drop failure/);
    await assert.rejects(
        () => storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'x' }]),
        /partially-dropped state/
    );

    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ✅ testDropIndexersPartialFailurePoisonsStorage');
}

async function main() {
    assert.equal(ARKDATA_SCOPED_SEARCH_BATCH_SIZE, 5000);
    await testEnsureColumnsAddsMissing();
    await testBaseStorageSearchLimit();
    await testPathScopeHelpers();
    await testNativePathDescendantOrSelfOperator();
    await testWasmPathDescendantOrSelfOperator();
    await testArkDataPathDescendantOrSelfBindings();
    await testBaseIndexStoreProbeMissingDoesNotCreateFile();
    await testBaseIndexStoreProbeExisting();
    await testBaseStorageProbeIndexers();
    await testArkDataDbPathUsesFormalDatabaseSuffix();
    await testArkDataFindAllPaginatesUnboundedSearch();
    await testArkDataFindAllPreservesSmallExplicitLimitShape();
    await testArkDataFindAllPaginatesExplicitLimitGreaterThanCap();
    await testArkDataFindAllPaginatesExplicitOffset();
    await testArkDataSemanticFiltersUseExactInSql();
    await testArkDataInsertManyBatchesSameInsertShape();
    await testArkDataInsertManySplitsDifferentInsertShapes();
    await testArkDataUpsertManyHandlesMixedInsertUpdateNoopRows();
    await testArkDataUpsertManyUpdatesAllProvidedColumnsWhenAnyChanges();
    await testArkDataUpdateManyGroupsByProvidedUpdateColumns();
    await testArkDataDuplicateItemIdUsesSequentialFallback();
    await testArkDataDuplicateDetectionNormalizesItemIdToString();
    await testArkDataDifferentObjectKeyOrderUsesSameShape();
    await testArkDataUndefinedFieldsExcludedFromShapeAndDoNotOverwrite();
    await testNativeSqliteFallbackUsesWasmForMissingBinding();
    await testNativeSqliteFallbackRethrowsUnrelatedErrors();
    await testNativeSqliteFallbackRespectsForcedWasmPlatform();
    await testDropIndexersDeletesOwnedFilesAndSidecars();
    await testDropIndexersNoopAndPostDropCloseAreSafe();
    await testDropIndexersPartialFailurePoisonsStorage();
    console.log('=== Results: 30 passed ===');
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
