import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { BaseStorage, ColumnSchema, Item } from '../abstract-storage.js';
import { createBaseIndexDB } from '../base-index-db-factory.js';
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

async function main() {
    await testEnsureColumnsAddsMissing();
    await testBaseStorageSearchLimit();
    await testNativeSqliteFallbackUsesWasmForMissingBinding();
    await testNativeSqliteFallbackRethrowsUnrelatedErrors();
    await testNativeSqliteFallbackRespectsForcedWasmPlatform();
    console.log('=== Results: 5 passed ===');
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
