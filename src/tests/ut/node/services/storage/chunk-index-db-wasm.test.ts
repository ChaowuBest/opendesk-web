import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    ChunkIndexDBWasm,
    probeChunkIndexStoreWasm,
    dropChunkIndexStoreWasm
} from '../../../../../main/services/storage/chunk-index-db-wasm.js';
import { toWasmDbPath } from '../../../../../main/services/storage/wasm-path.js';

function tmpDir(name: string): string {
    const dir = path.join(os.tmpdir(), `chunk-wasm-test-${name}-${Date.now()}`);
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

async function testConstructorWritesToWasmSuffixedPath(): Promise<void> {
    const dir = tmpDir('ctor');
    const dbPath = path.join(dir, 'chunk-index.db');
    try {
        const db = new ChunkIndexDBWasm(dbPath, 4);
        await db.insertMany([
            { chunk_pk: 'pk1', item_id: 'item1', chunk_id: 'c1', chunk_text: 'hello', repr: randVec(4) }
        ]);
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
    const dbPath = path.join(dir, 'chunk-index.db');
    try {
        assert.equal(probeChunkIndexStoreWasm(dbPath), 'missing');

        const db = new ChunkIndexDBWasm(dbPath, 4);
        await db.insertMany([
            { chunk_pk: 'pk1', item_id: 'item1', chunk_id: 'c1', chunk_text: 'hello', repr: randVec(4) }
        ]);
        db.close();

        assert.equal(probeChunkIndexStoreWasm(dbPath), 'exists');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testProbeUsesWasmSuffixedPath');
}

async function testDropRemovesWasmFilesIncludingSnapshot(): Promise<void> {
    const dir = tmpDir('drop');
    const dbPath = path.join(dir, 'chunk-index.db');
    try {
        const db = new ChunkIndexDBWasm(dbPath, 4);
        await db.insertMany([
            { chunk_pk: 'pk1', item_id: 'item1', chunk_id: 'c1', chunk_text: 'hello', repr: randVec(4) }
        ]);
        db.close();

        const wasmPath = toWasmDbPath(dbPath);
        assert.ok(fs.existsSync(wasmPath));
        assert.ok(fs.existsSync(`${wasmPath}.hnsw.json`), 'expected a snapshot file to exist before drop');

        await dropChunkIndexStoreWasm(dbPath);

        assert.ok(!fs.existsSync(wasmPath), 'sqlite file should be gone after drop');
        assert.ok(!fs.existsSync(`${wasmPath}.hnsw.json`), 'snapshot file should be gone after drop');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testDropRemovesWasmFilesIncludingSnapshot');
}

async function main(): Promise<void> {
    console.log('=== ChunkIndexDBWasm path isolation tests ===\n');
    const tests = [
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
