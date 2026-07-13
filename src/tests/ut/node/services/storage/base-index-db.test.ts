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

async function withFakeArkDataKit<T>(rows: Record<string, any>[], fn: (queries: string[]) => Promise<T>): Promise<T> {
    const { setArkdataDatabaseKit } = await import('../../../../../main/services/storage/arkdata-bridge.js');
    const queries: string[] = [];
    const fakeKit: DatabaseKit = {
        available: async () => true,
        execSql: async () => {},
        execSqlParams: async () => {},
        querySqlShort: async (_storeId, sql) => {
            queries.push(sql);
            return [];
        },
        openStore: async () => {},
        closeStore: async () => {},
        executePrepared: async () => ({ affectedRows: 0 }),
        executePreparedMany: async () => ({ affectedRows: 0 }),
        executePreparedManyBatched: async () => ({ affectedRows: 0 }),
        queryPrepared: async (_storeId, sql) => {
            queries.push(sql);
            if (/^\s*SELECT\s+meta_value\s+FROM\s+__schema_meta_safe\b/i.test(sql)) {
                return [];
            }
            if (/^\s*SELECT\s+\*\s+FROM\s+base_index\b/i.test(sql)) {
                const limit = /\bLIMIT\s+(\d+)\b/i.exec(sql);
                const offset = /\bOFFSET\s+(\d+)\b/i.exec(sql);
                assert.ok(limit, `fake ArkData SELECT needs LIMIT: ${sql}`);
                const limitValue = Number(limit[1]);
                const offsetValue = offset ? Number(offset[1]) : 0;
                return sortRowsForSql(rows, sql).slice(offsetValue, offsetValue + limitValue);
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
        return await fn(queries);
    } finally {
        setArkdataDatabaseKit(previous);
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

    await withFakeArkDataKit(rows, async (queries) => {
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
            assert.ok(queries.some((sql) => /ORDER BY\s+item_id\s+ASC/i.test(sql)));
            assert.ok(queries.some((sql) => /\bOFFSET\s+0\b/i.test(sql)));
            assert.ok(queries.some((sql) => /\bOFFSET\s+5000\b/i.test(sql)));
            assert.ok(queries.some((sql) => /\bOFFSET\s+10000\b/i.test(sql)));
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

    await withFakeArkDataKit(rows, async (queries) => {
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
            const dataQueries = queries.filter((sql) => /\bFROM\s+base_index\b/i.test(sql));

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

    await withFakeArkDataKit(rows, async (queries) => {
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
            assert.ok(queries.some((sql) => /\bLIMIT\s+5000\s+OFFSET\s+0\b/i.test(sql)));
            assert.ok(queries.some((sql) => /\bLIMIT\s+5000\s+OFFSET\s+5000\b/i.test(sql)));
            assert.ok(queries.some((sql) => /\bLIMIT\s+2000\s+OFFSET\s+10000\b/i.test(sql)));
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

    await withFakeArkDataKit(rows, async (queries) => {
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
            assert.ok(queries.some((sql) => /ORDER BY\s+item_id\s+ASC/i.test(sql)));
            assert.ok(queries.some((sql) => /\bLIMIT\s+1200\b/i.test(sql)));
            assert.ok(queries.some((sql) => /\bOFFSET\s+6000\b/i.test(sql)));
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
    await testNativeSqliteFallbackUsesWasmForMissingBinding();
    await testNativeSqliteFallbackRethrowsUnrelatedErrors();
    await testNativeSqliteFallbackRespectsForcedWasmPlatform();
    await testDropIndexersDeletesOwnedFilesAndSidecars();
    await testDropIndexersNoopAndPostDropCloseAreSafe();
    await testDropIndexersPartialFailurePoisonsStorage();
    console.log('=== Results: 20 passed ===');
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
