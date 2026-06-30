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

function seedRawChunkRow(db: ChunkIndexDBWasm, chunkPk: string, dim: number): void {
    const raw = (db as any).db as { run(sql: string, params?: any[]): unknown };
    const vec = randVec(dim);
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    raw.run(
        `INSERT INTO chunk_index_meta (chunk_pk, item_id, chunk_id, chunk_text, active, repr) VALUES (?, ?, ?, ?, 1, ?)`,
        [chunkPk, chunkPk, chunkPk, 'seeded', buf]
    );
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

async function testPointCapIsDimensionAware(): Promise<void> {
    const dir = tmpDir('cap-dim');
    try {
        const dbSmallDim = new ChunkIndexDBWasm(path.join(dir, 'small.db'), 1024);
        const dbLargeDim = new ChunkIndexDBWasm(path.join(dir, 'large.db'), 4096);
        await dbSmallDim.getStoredDim();
        await dbLargeDim.getStoredDim();

        const capSmallDim = (dbSmallDim as any).pointCap as number;
        const capLargeDim = (dbLargeDim as any).pointCap as number;

        assert.equal(capSmallDim, Math.floor(17_550_000 / 1024));
        assert.equal(capLargeDim, Math.floor(17_550_000 / 4096));
        assert.ok(capLargeDim < capSmallDim, 'higher dimension must yield a lower point cap');

        dbSmallDim.close();
        dbLargeDim.close();
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testPointCapIsDimensionAware');
}

async function testInsertManyStopsAcceptingPastCap(): Promise<void> {
    const dir = tmpDir('cap-budget');
    const dbPath = path.join(dir, 'chunk-index.db');
    try {
        const db = new ChunkIndexDBWasm(dbPath, 4);
        await db.getStoredDim();
        (db as any).pointCap = 3;

        const inserted = await db.insertMany([
            { chunk_pk: 'pk1', item_id: 'item1', chunk_id: 'c1', chunk_text: 'a', repr: randVec(4) },
            { chunk_pk: 'pk2', item_id: 'item2', chunk_id: 'c2', chunk_text: 'b', repr: randVec(4) },
            { chunk_pk: 'pk3', item_id: 'item3', chunk_id: 'c3', chunk_text: 'c', repr: randVec(4) },
            { chunk_pk: 'pk4', item_id: 'item4', chunk_id: 'c4', chunk_text: 'd', repr: randVec(4) },
            { chunk_pk: 'pk5', item_id: 'item5', chunk_id: 'c5', chunk_text: 'e', repr: randVec(4) }
        ]);

        assert.equal(inserted, 3, 'only pointCap-many records should be accepted');
        assert.equal(await db.count(), 3);

        const writeState = await db.getWriteState();
        assert.equal(writeState.acceptingWrites, false);
        assert.equal(writeState.reason, 'capacity_limit');
        assert.equal(writeState.cap, 3);

        db.close();
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testInsertManyStopsAcceptingPastCap');
}

async function testRebuildEvictsOldestBeyondCapAndKeepsNewest(): Promise<void> {
    const dir = tmpDir('rebuild-evict');
    const dbPath = path.join(dir, 'chunk-index.db');
    try {
        const db = new ChunkIndexDBWasm(dbPath, 4);
        await db.getStoredDim();
        (db as any).pointCap = 3;

        for (let i = 1; i <= 5; i++) {
            seedRawChunkRow(db, `legacy-pk-${i}`, 4);
        }
        (db as any).refreshActiveCount();
        assert.equal((db as any).activeChunkCount, 5, 'precondition: 5 rows seeded as active');

        await (db as any).rebuildIndexLocked();

        assert.equal(await db.count(), 3, 'rebuild must trim active count down to pointCap');

        const raw = (db as any).db as { all(sql: string): Array<{ chunk_pk: string }> };
        const remaining = raw
            .all(`SELECT chunk_pk FROM chunk_index_meta WHERE active = 1 ORDER BY rowid ASC`)
            .map((r) => r.chunk_pk);
        assert.deepEqual(remaining, ['legacy-pk-3', 'legacy-pk-4', 'legacy-pk-5']);

        const evicted = raw.all(`SELECT chunk_pk FROM chunk_index_meta WHERE active = 0 ORDER BY rowid ASC`) as Array<{
            chunk_pk: string;
        }>;
        assert.deepEqual(
            evicted.map((r) => r.chunk_pk),
            ['legacy-pk-1', 'legacy-pk-2']
        );

        db.close();
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testRebuildEvictsOldestBeyondCapAndKeepsNewest');
}

async function testRebuildLeavesUnderCapDataUntouched(): Promise<void> {
    const dir = tmpDir('rebuild-under-cap');
    const dbPath = path.join(dir, 'chunk-index.db');
    try {
        const db = new ChunkIndexDBWasm(dbPath, 4);
        await db.insertMany([
            { chunk_pk: 'pk1', item_id: 'item1', chunk_id: 'c1', chunk_text: 'a', repr: randVec(4) },
            { chunk_pk: 'pk2', item_id: 'item2', chunk_id: 'c2', chunk_text: 'b', repr: randVec(4) }
        ]);

        await (db as any).rebuildIndexLocked();

        assert.equal(await db.count(), 2, 'rebuild must not evict anything when under cap');
        db.close();
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testRebuildLeavesUnderCapDataUntouched');
}

async function testColdStartSkipsLoadWhenDirty(): Promise<void> {
    const dir = tmpDir('cold-start-dirty');
    const dbPath = path.join(dir, 'chunk-index.db');
    try {
        const first = new ChunkIndexDBWasm(dbPath, 4);
        await first.insertMany([
            { chunk_pk: 'pk1', item_id: 'item1', chunk_id: 'c1', chunk_text: 'a', repr: randVec(4) },
            { chunk_pk: 'pk2', item_id: 'item2', chunk_id: 'c2', chunk_text: 'b', repr: randVec(4) }
        ]);
        (first as any).setState('hnsw_dirty', '1');
        first.close();

        const second = new ChunkIndexDBWasm(dbPath, 4);
        assert.equal(await second.count(), 2, 'cold start with hnsw_dirty=1 must rebuild from sqlite, not crash');
        second.close();
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testColdStartSkipsLoadWhenDirty');
}

async function main(): Promise<void> {
    console.log('=== ChunkIndexDBWasm path isolation tests ===\n');
    const tests = [
        testConstructorWritesToWasmSuffixedPath,
        testProbeUsesWasmSuffixedPath,
        testDropRemovesWasmFilesIncludingSnapshot,
        testPointCapIsDimensionAware,
        testInsertManyStopsAcceptingPastCap,
        testRebuildEvictsOldestBeyondCapAndKeepsNewest,
        testRebuildLeavesUnderCapDataUntouched,
        testColdStartSkipsLoadWhenDirty
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
