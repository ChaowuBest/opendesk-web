import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    createChunkIndexDB,
    dropChunkIndexStore
} from '../../../../../main/services/storage/chunk-index-db-factory.js';
import {
    createVectorIndexDB,
    dropVectorIndexStore
} from '../../../../../main/services/storage/vector-index-db-factory.js';
import { toWasmDbPath } from '../../../../../main/services/storage/wasm-path.js';

function tmpDir(name: string): string {
    const dir = path.join(os.tmpdir(), `factory-drop-test-${name}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
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

async function main(): Promise<void> {
    console.log('=== factory drop cleans up both backends tests ===\n');
    const tests = [
        testDropChunkIndexStoreCleansUpBothNativeAndWasmFiles,
        testDropVectorIndexStoreCleansUpBothNativeAndWasmFiles,
        testDropStoresWithoutWasmLeftoversDoesNotCreateWasmFiles
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
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
});
