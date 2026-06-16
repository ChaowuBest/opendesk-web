import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { BaseStorage, ColumnSchema, Item } from '../abstract-storage.js';
import { createBaseIndexDB, probeBaseIndexStore } from '../base-index-db-factory.js';
import { toArkDataDbPath } from '../arkdata-path.js';
import { createWithNativeSqliteFallback } from '../platform.js';

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
    await testEnsureColumnsAddsMissing();
    await testBaseStorageSearchLimit();
    await testBaseIndexStoreProbeMissingDoesNotCreateFile();
    await testBaseIndexStoreProbeExisting();
    await testBaseStorageProbeIndexers();
    await testArkDataDbPathUsesFormalDatabaseSuffix();
    await testNativeSqliteFallbackUsesWasmForMissingBinding();
    await testNativeSqliteFallbackRethrowsUnrelatedErrors();
    await testNativeSqliteFallbackRespectsForcedWasmPlatform();
    await testDropIndexersDeletesOwnedFilesAndSidecars();
    await testDropIndexersNoopAndPostDropCloseAreSafe();
    await testDropIndexersPartialFailurePoisonsStorage();
    console.log('=== Results: 12 passed ===');
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
