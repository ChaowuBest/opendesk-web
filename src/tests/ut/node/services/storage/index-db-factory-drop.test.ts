import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mock } from 'node:test';
import {
    createChunkIndexDB,
    dropChunkIndexStore
} from '../../../../../main/services/storage/chunk-index-db-factory.js';
import {
    createVectorIndexDB,
    dropVectorIndexStore
} from '../../../../../main/services/storage/vector-index-db-factory.js';
import { toWasmDbPath } from '../../../../../main/services/storage/wasm-path.js';
import { createBaseIndexDB, dropBaseIndexStore } from '../../../../../main/services/storage/base-index-db-factory.js';
import { BaseIndexDBWasm } from '../../../../../main/services/storage/base-index-db-wasm.js';
import { setArkdataDatabaseKit } from '../../../../../main/services/storage/arkdata-bridge.js';

function tmpDir(name: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `factory-drop-test-${name}-`));
}

function cleanup(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

function randVec(dim: number): Float32Array {
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) v[i] = Math.random() * 2 - 1;
    return v;
}

async function testDropChunkIndexStoreCleansUpBothNativeAndWasmFiles(): Promise<void> {
    const dir = tmpDir('chunk');
    const dbPath = path.join(dir, 'chunk-index.db');
    try {
        // Directly seed a wasm-shaped leftover at the wasm path, simulating a machine
        // that fell back to wasm before this fix shipped.
        const { ChunkIndexDBWasm } = await import('../../../../../main/services/storage/chunk-index-db-wasm.js');
        const wasmDb = new ChunkIndexDBWasm(dbPath, 4);
        await wasmDb.insertMany([
            { chunk_pk: 'pk1', item_id: 'item1', chunk_id: 'c1', chunk_text: 'hello', repr: randVec(4) }
        ]);
        wasmDb.close();

        const db = await createChunkIndexDB(dbPath, 4);
        db.close();

        const wasmPath = toWasmDbPath(dbPath);
        assert.ok(fs.existsSync(wasmPath), 'precondition: wasm leftover file should exist before drop');

        await dropChunkIndexStore(dbPath);

        assert.ok(!fs.existsSync(dbPath), 'native dbPath should be cleaned up');
        assert.ok(!fs.existsSync(wasmPath), 'wasm dbPath should also be cleaned up');
        assert.ok(!fs.existsSync(`${wasmPath}.hnsw.json`), 'wasm snapshot file should also be cleaned up');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testDropChunkIndexStoreCleansUpBothNativeAndWasmFiles');
}

async function testDropVectorIndexStoreCleansUpBothNativeAndWasmFiles(): Promise<void> {
    const dir = tmpDir('vector');
    const dbPath = path.join(dir, 'vector-index.db');
    try {
        const { VectorIndexDBWasm } = await import('../../../../../main/services/storage/vector-index-db-wasm.js');
        const wasmDb = new VectorIndexDBWasm(dbPath, 4);
        await wasmDb.insertMany([{ vector_id: 'v1', item_id: 'item1', item_type: 'filename', repr: randVec(4) }]);
        wasmDb.close();

        const db = await createVectorIndexDB(dbPath, 4);
        db.close();

        const wasmPath = toWasmDbPath(dbPath);
        assert.ok(fs.existsSync(wasmPath), 'precondition: wasm leftover file should exist before drop');

        await dropVectorIndexStore(dbPath);

        assert.ok(!fs.existsSync(dbPath), 'native dbPath should be cleaned up');
        assert.ok(!fs.existsSync(wasmPath), 'wasm dbPath should also be cleaned up');
        assert.ok(!fs.existsSync(`${wasmPath}.hnsw.json`), 'wasm snapshot file should also be cleaned up');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testDropVectorIndexStoreCleansUpBothNativeAndWasmFiles');
}

async function testDropStoresWithoutWasmLeftoversDoesNotCreateWasmFiles(): Promise<void> {
    const dir = tmpDir('no-wasm');
    const chunkDbPath = path.join(dir, 'chunk-index.db');
    const vectorDbPath = path.join(dir, 'vector-index.db');
    try {
        await dropChunkIndexStore(chunkDbPath);
        await dropVectorIndexStore(vectorDbPath);

        assert.ok(!fs.existsSync(toWasmDbPath(chunkDbPath)), 'chunk drop should not create a wasm db file');
        assert.ok(!fs.existsSync(toWasmDbPath(vectorDbPath)), 'vector drop should not create a wasm db file');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testDropStoresWithoutWasmLeftoversDoesNotCreateWasmFiles');
}

async function testSingleStoreWasmLocksProtectBothBackendVariants(): Promise<void> {
    const failures: unknown[] = [];
    const stores = [
        ['vector', dropVectorIndexStore],
        ['chunk', dropChunkIndexStore],
        ['base', dropBaseIndexStore]
    ] as const;
    for (const [name, drop] of stores) {
        for (const present of [true, false]) {
            const dir = tmpDir(`${name}-locked-${present}`);
            const dbPath = path.join(dir, `${name}-index.db`);
            const wasmPath = toWasmDbPath(dbPath);
            fs.writeFileSync(dbPath, 'isolated unopened native product');
            if (present) fs.writeFileSync(wasmPath, 'isolated unopened WASM product');
            fs.writeFileSync(`${wasmPath}.hnsw.json`, '{}');
            fs.mkdirSync(`${wasmPath}.lock`);
            const removed: string[] = [];
            const remove = fs.rmSync;
            mock.method(fs, 'rmSync', (...args) => {
                removed.push(String(args[0]));
                return remove(...args);
            });
            try {
                let received: any;
                try {
                    await drop(dbPath);
                } catch (error) {
                    received = error;
                }
                assert.deepEqual(removed, [], 'lock preflight happens before native files or snapshots are removed');
                assert.equal(received?.code, 'EBUSY');
                assert.equal(fs.readFileSync(dbPath, 'utf8'), 'isolated unopened native product');
                assert.equal(fs.existsSync(wasmPath), present);
                assert.ok(fs.existsSync(`${wasmPath}.lock`));
                console.log(`CASE ${name} locked, WASM main=${present}: PASS`);
            } catch (error) {
                failures.push(error);
                console.error(`CASE ${name} locked, WASM main=${present}: FAIL`, error);
            } finally {
                mock.restoreAll();
                cleanup(dir);
            }
        }
    }
    console.log(
        `WF1_LOCK_CASE_COUNTS ${JSON.stringify({ tests: stores.length * 2, passed: stores.length * 2 - failures.length, failed: failures.length, skipped: 0 })}`
    );
    assert.equal(failures.length, 0, 'all single-store lock cases must protect both variants');
}

async function testBaseRawDropCleansBothVariantsWithoutReopening(): Promise<void> {
    const dir = tmpDir('base-raw');
    const file = path.join(dir, 'base-index.db');
    const schema = {
        columns: {
            item_id: { type: 'TEXT' as const, nullable: false },
            item_type: { type: 'TEXT' as const, nullable: false }
        },
        needIndexers: {}
    };
    try {
        const wasm = new BaseIndexDBWasm(file, schema);
        await wasm.insert({ item_id: 'old-wasm', item_type: 'file' });
        await wasm.close();
        const native = await createBaseIndexDB(file, schema);
        await native.insert({ item_id: 'old-native', item_type: 'file' });
        await native.close();
        assert.ok(fs.existsSync(file));
        assert.ok(fs.existsSync(toWasmDbPath(file)));
        await dropBaseIndexStore(file);
        for (const target of [file, toWasmDbPath(file)]) {
            assert.equal(fs.existsSync(target), false);
            assert.equal(fs.existsSync(`${target}-wal`), false);
            assert.equal(fs.existsSync(`${target}-shm`), false);
        }
        await dropBaseIndexStore(file);
        assert.deepEqual(fs.readdirSync(dir), [], 'dropping absent stores does not open or recreate either variant');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testBaseRawDropCleansBothVariantsWithoutReopening');
}

async function testArkDataFactoriesRespectSingleStoreWasmLocks(): Promise<void> {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const available = process.env.ARKDATA_AVAILABLE;
    const deleted: string[] = [];
    const previousKit = setArkdataDatabaseKit({
        deleteStore: async (id: string) => {
            deleted.push(id);
        }
    } as any);
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    process.env.ARKDATA_AVAILABLE = '1';
    let failures = 0;
    try {
        for (const [name, drop] of [
            ['vector', dropVectorIndexStore],
            ['chunk', dropChunkIndexStore],
            ['base', dropBaseIndexStore]
        ] as const) {
            for (const present of [true, false]) {
                const directory = tmpDir(`arkdata-${name}-${present}`);
                const file = path.join(directory, `${name}-index.db`);
                const wasm = toWasmDbPath(file);
                fs.writeFileSync(file, 'isolated native product');
                if (present) fs.writeFileSync(wasm, 'isolated WASM product');
                fs.mkdirSync(wasm + '.lock');
                try {
                    const before = deleted.length;
                    await assert.rejects(drop(file), { code: 'EBUSY' });
                    assert.equal(deleted.length, before, 'No SDK delete may precede the lock preflight');
                    assert.equal(fs.readFileSync(file, 'utf8'), 'isolated native product');
                    assert.equal(fs.existsSync(wasm), present);
                    assert.equal(fs.existsSync(wasm + '.lock'), true);
                    console.log(`CASE ArkData ${name} locked, WASM main=${present}: PASS`);
                } catch (error) {
                    failures++;
                    console.error(`CASE ArkData ${name} locked, WASM main=${present}: FAIL`, error);
                } finally {
                    cleanup(directory);
                }
            }
        }
    } finally {
        Object.defineProperty(process, 'platform', platform);
        if (available === undefined) delete process.env.ARKDATA_AVAILABLE;
        else process.env.ARKDATA_AVAILABLE = available;
        setArkdataDatabaseKit(previousKit);
    }
    console.log(
        `WF1_ARKDATA_LOCK_CASE_COUNTS ${JSON.stringify({ tests: 6, passed: 6 - failures, failed: failures, skipped: 0 })}`
    );
    assert.equal(failures, 0);
}

async function main(): Promise<void> {
    console.log('=== factory drop cleans up both backends tests ===\n');
    const tests = [
        testDropChunkIndexStoreCleansUpBothNativeAndWasmFiles,
        testDropVectorIndexStoreCleansUpBothNativeAndWasmFiles,
        testDropStoresWithoutWasmLeftoversDoesNotCreateWasmFiles,
        testSingleStoreWasmLocksProtectBothBackendVariants,
        testBaseRawDropCleansBothVariantsWithoutReopening,
        testArkDataFactoriesRespectSingleStoreWasmLocks
    ];
    let passed = 0,
        failed = 0;
    for (const test of tests) {
        try {
            await test();
            passed++;
        } catch (e: any) {
            console.error(`  FAIL ${test.name}: ${e.message}`);
            failed++;
        }
    }
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    console.log(`WF1_CASE_COUNTS ${JSON.stringify({ tests: tests.length, passed, failed, skipped: 0 })}`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
});
