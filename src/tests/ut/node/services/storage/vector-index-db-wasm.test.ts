import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    VectorIndexDBWasm,
    probeVectorIndexStoreWasm,
    dropVectorIndexStoreWasm
} from '../../../../../main/services/storage/vector-index-db-wasm.js';
import { toWasmDbPath } from '../../../../../main/services/storage/wasm-path.js';

function tmpDir(name: string): string {
    const dir = path.join(os.tmpdir(), `vector-wasm-test-${name}-${Date.now()}`);
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

async function testToWasmDbPathAppendsSuffixForDbExtension(): Promise<void> {
    assert.equal(toWasmDbPath('/data/vector-index.db'), '/data/vector-index.wasm.db');
    assert.equal(toWasmDbPath('/data/chunk-index.db'), '/data/chunk-index.wasm.db');
    console.log('  ✅ testToWasmDbPathAppendsSuffixForDbExtension');
}

async function testToWasmDbPathHandlesPathWithoutDbExtension(): Promise<void> {
    assert.equal(toWasmDbPath('/data/vector-index'), '/data/vector-index.wasm.db');
    console.log('  ✅ testToWasmDbPathHandlesPathWithoutDbExtension');
}

async function testToWasmDbPathIsIdempotent(): Promise<void> {
    const once = toWasmDbPath('/data/vector-index.db');
    assert.equal(toWasmDbPath(once), once);
    console.log('  ✅ testToWasmDbPathIsIdempotent');
}

async function testConstructorWritesToWasmSuffixedPath(): Promise<void> {
    const dir = tmpDir('ctor');
    const dbPath = path.join(dir, 'vector-index.db');
    try {
        const db = new VectorIndexDBWasm(dbPath, 4);
        await db.insertMany([{ vector_id: 'v1', item_id: 'item1', item_type: 'filename', repr: randVec(4) }]);
        db.close();

        assert.ok(fs.existsSync(toWasmDbPath(dbPath)), 'expected the wasm-suffixed sqlite file to exist');
        assert.ok(!fs.existsSync(dbPath), 'the original un-suffixed dbPath must not be used as the actual file');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testConstructorWritesToWasmSuffixedPath');
}

async function testProbeUsesWasmSuffixedPath(): Promise<void> {
    const dir = tmpDir('probe');
    const dbPath = path.join(dir, 'vector-index.db');
    try {
        assert.equal(probeVectorIndexStoreWasm(dbPath), 'missing');

        const db = new VectorIndexDBWasm(dbPath, 4);
        await db.insertMany([{ vector_id: 'v1', item_id: 'item1', item_type: 'filename', repr: randVec(4) }]);
        db.close();

        assert.equal(probeVectorIndexStoreWasm(dbPath), 'exists');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testProbeUsesWasmSuffixedPath');
}

async function testDropRemovesWasmFilesIncludingSnapshot(): Promise<void> {
    const dir = tmpDir('drop');
    const dbPath = path.join(dir, 'vector-index.db');
    try {
        const db = new VectorIndexDBWasm(dbPath, 4);
        await db.insertMany([{ vector_id: 'v1', item_id: 'item1', item_type: 'filename', repr: randVec(4) }]);
        db.close();

        const wasmPath = toWasmDbPath(dbPath);
        assert.ok(fs.existsSync(wasmPath));
        assert.ok(fs.existsSync(`${wasmPath}.hnsw.json`), 'expected a snapshot file to exist before drop');

        await dropVectorIndexStoreWasm(dbPath);

        assert.ok(!fs.existsSync(wasmPath), 'sqlite file should be gone after drop');
        assert.ok(!fs.existsSync(`${wasmPath}.hnsw.json`), 'snapshot file should be gone after drop');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testDropRemovesWasmFilesIncludingSnapshot');
}

async function main(): Promise<void> {
    console.log('=== VectorIndexDBWasm path isolation tests ===\n');
    const tests = [
        testToWasmDbPathAppendsSuffixForDbExtension,
        testToWasmDbPathHandlesPathWithoutDbExtension,
        testToWasmDbPathIsIdempotent,
        testConstructorWritesToWasmSuffixedPath,
        testProbeUsesWasmSuffixedPath,
        testDropRemovesWasmFilesIncludingSnapshot
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
