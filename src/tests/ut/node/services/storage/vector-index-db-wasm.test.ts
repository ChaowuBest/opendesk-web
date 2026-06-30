import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    VectorIndexDBWasm,
    probeVectorIndexStoreWasm,
    dropVectorIndexStoreWasm
} from '../../../../../main/services/storage/vector-index-db-wasm.js';
import {
    shouldSkipLoadSnapshot,
    HNSW_SNAPSHOT_SIZE_CIRCUIT_BREAKER_BYTES
} from '../../../../../main/services/storage/hnsw-snapshot-guard.js';
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

function seedRawVectorRow(db: VectorIndexDBWasm, pointId: string, dim: number, createdAt: number): void {
    const raw = (db as any).db as { run(sql: string, params?: any[]): unknown };
    const vec = randVec(dim);
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    raw.run(
        `INSERT INTO vector_index_meta (point_id, vector_id, item_id, item_type, active, repr, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [pointId, pointId, pointId, 'filename', buf, createdAt]
    );
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

async function testPointCapIsDimensionAware(): Promise<void> {
    const dir = tmpDir('cap-dim');
    try {
        const dbSmallDim = new VectorIndexDBWasm(path.join(dir, 'small.db'), 1024);
        const dbLargeDim = new VectorIndexDBWasm(path.join(dir, 'large.db'), 4096);
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
    const dbPath = path.join(dir, 'vector-index.db');
    try {
        const db = new VectorIndexDBWasm(dbPath, 4);
        await db.getStoredDim();
        (db as any).pointCap = 3;

        const inserted = await db.insertMany([
            { vector_id: 'v1', item_id: 'item1', item_type: 'filename', repr: randVec(4) },
            { vector_id: 'v2', item_id: 'item2', item_type: 'filename', repr: randVec(4) },
            { vector_id: 'v3', item_id: 'item3', item_type: 'filename', repr: randVec(4) },
            { vector_id: 'v4', item_id: 'item4', item_type: 'filename', repr: randVec(4) },
            { vector_id: 'v5', item_id: 'item5', item_type: 'filename', repr: randVec(4) }
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
    const dbPath = path.join(dir, 'vector-index.db');
    try {
        const db = new VectorIndexDBWasm(dbPath, 4);
        await db.getStoredDim();
        (db as any).pointCap = 3;

        for (let i = 1; i <= 5; i++) {
            seedRawVectorRow(db, `legacy-${i}`, 4, 1000 + i);
        }
        (db as any).refreshActiveCounts();
        assert.equal((db as any).activeCount, 5, 'precondition: 5 rows seeded as active');

        await (db as any).rebuildIndexLocked();

        assert.equal(await db.count(), 3, 'rebuild must trim active count down to pointCap');

        const raw = (db as any).db as { all(sql: string): Array<{ point_id: string }> };
        const remaining = raw
            .all(`SELECT point_id FROM vector_index_meta WHERE active = 1 ORDER BY created_at ASC`)
            .map((r) => r.point_id);
        assert.deepEqual(remaining, ['legacy-3', 'legacy-4', 'legacy-5']);

        db.close();
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testRebuildEvictsOldestBeyondCapAndKeepsNewest');
}

async function testRebuildLeavesUnderCapDataUntouched(): Promise<void> {
    const dir = tmpDir('rebuild-under-cap');
    const dbPath = path.join(dir, 'vector-index.db');
    try {
        const db = new VectorIndexDBWasm(dbPath, 4);
        await db.insertMany([
            { vector_id: 'v1', item_id: 'item1', item_type: 'filename', repr: randVec(4) },
            { vector_id: 'v2', item_id: 'item2', item_type: 'filename', repr: randVec(4) }
        ]);

        await (db as any).rebuildIndexLocked();

        assert.equal(await db.count(), 2, 'rebuild must not evict anything when under cap');
        db.close();
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testRebuildLeavesUnderCapDataUntouched');
}

async function testSnapshotGuardSkipsWhenActiveCountExceedsCap(): Promise<void> {
    const result = shouldSkipLoadSnapshot({ activeCount: 10, pointCap: 5, dirty: false, snapshotSizeBytes: 100 });
    assert.equal(result, true);
    console.log('  ✅ testSnapshotGuardSkipsWhenActiveCountExceedsCap');
}

async function testSnapshotGuardSkipsWhenDirty(): Promise<void> {
    const result = shouldSkipLoadSnapshot({ activeCount: 1, pointCap: 5, dirty: true, snapshotSizeBytes: 100 });
    assert.equal(result, true);
    console.log('  ✅ testSnapshotGuardSkipsWhenDirty');
}

async function testSnapshotGuardSkipsWhenSnapshotFileExceedsCircuitBreaker(): Promise<void> {
    const result = shouldSkipLoadSnapshot({
        activeCount: 1,
        pointCap: 5,
        dirty: false,
        snapshotSizeBytes: HNSW_SNAPSHOT_SIZE_CIRCUIT_BREAKER_BYTES + 1
    });
    assert.equal(result, true);
    console.log('  ✅ testSnapshotGuardSkipsWhenSnapshotFileExceedsCircuitBreaker');
}

async function testSnapshotGuardDoesNotSkipForNormalState(): Promise<void> {
    const result = shouldSkipLoadSnapshot({ activeCount: 3, pointCap: 5, dirty: false, snapshotSizeBytes: 1024 });
    assert.equal(result, false);
    console.log('  ✅ testSnapshotGuardDoesNotSkipForNormalState');
}

async function testSnapshotGuardBoundaryActiveCountEqualToCapDoesNotSkip(): Promise<void> {
    const result = shouldSkipLoadSnapshot({ activeCount: 5, pointCap: 5, dirty: false, snapshotSizeBytes: 1024 });
    assert.equal(result, false, 'active count exactly at cap is not "exceeding" the cap');
    console.log('  ✅ testSnapshotGuardBoundaryActiveCountEqualToCapDoesNotSkip');
}

async function main(): Promise<void> {
    console.log('=== VectorIndexDBWasm path isolation tests ===\n');
    const tests = [
        testToWasmDbPathAppendsSuffixForDbExtension,
        testToWasmDbPathHandlesPathWithoutDbExtension,
        testToWasmDbPathIsIdempotent,
        testConstructorWritesToWasmSuffixedPath,
        testProbeUsesWasmSuffixedPath,
        testDropRemovesWasmFilesIncludingSnapshot,
        testPointCapIsDimensionAware,
        testInsertManyStopsAcceptingPastCap,
        testRebuildEvictsOldestBeyondCapAndKeepsNewest,
        testRebuildLeavesUnderCapDataUntouched,
        testSnapshotGuardSkipsWhenActiveCountExceedsCap,
        testSnapshotGuardSkipsWhenDirty,
        testSnapshotGuardSkipsWhenSnapshotFileExceedsCircuitBreaker,
        testSnapshotGuardDoesNotSkipForNormalState,
        testSnapshotGuardBoundaryActiveCountEqualToCapDoesNotSkip
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
