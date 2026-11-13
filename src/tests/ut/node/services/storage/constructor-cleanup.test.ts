import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { VectorIndexDBWasm } from '../../../../../main/services/storage/vector-index-db-wasm.js';
import { ChunkIndexDBWasm } from '../../../../../main/services/storage/chunk-index-db-wasm.js';
import { VectorIndexer } from '../../../../../main/services/storage/vector-indexer.js';
import { ChunkIndexer } from '../../../../../main/services/storage/chunk-indexer.js';
import { BaseStorage } from '../../../../../main/services/storage/abstract-storage.js';
import { HnswAdapter } from '../../../../../main/services/storage/hnsw-adapter.js';
import { getStorageInitializationFailure, SqliteVecLoadError } from '../../../../../main/services/storage/platform.js';
import { FSStorage } from '../../../../../main/applications/filemgr/storage.js';
import FileManagerWorker from '../../../../../main/applications/filemgr/worker.js';
import { LLM } from '../../../../../main/aikernel/llm.js';
import {
    Setting,
    getLogDirectory,
    getOpendeskDirectory,
    setCustomOpendeskDirectory
} from '../../../../../main/utils/setting.js';

const { BaseIndexDB } = await import('../../../../../main/services/storage/base-index-db.js');
const { TagIndexDB } = await import('../../../../../main/services/storage/tag-index-db.js');
const { TagIndexDBWasm } = await import('../../../../../main/services/storage/tag-index-db-wasm.js');
const require = createRequire(import.meta.url);
const Native = require('better-sqlite3'),
    Wasm = require('node-sqlite3-wasm').Database;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-constructor-cleanup-'));
setCustomOpendeskDirectory(profile);
assert.equal(getOpendeskDirectory(), profile);
assert.equal(getLogDirectory(), path.join(profile, 'logs'));
console.log(JSON.stringify({ profile, logs: getLogDirectory(), databaseRoot: profile }));
after(() => fs.rmSync(profile, { recursive: true, force: true }));
const schema = {
    columns: { item_id: { type: 'TEXT', nullable: false }, item_type: { type: 'TEXT', nullable: false } },
    needIndexers: {}
};
for (const [name, Driver, method, construct] of [
    ['native-base', Native, 'exec', (file: string) => new BaseIndexDB(file, schema as any)],
    ['native-tag', Native, 'exec', (file: string) => new TagIndexDB(file)],
    ['wasm-tag', Wasm, 'run', (file: string) => new TagIndexDBWasm(file)]
] as const)
    test(`${name}: table initialization failure releases the newly opened connection`, (t) => {
        let captured: any,
            closes = 0;
        const raw = Driver.prototype[method],
            release = Driver.prototype.close;
        t.mock.method(Driver.prototype, method, function (this: any, sql: string, ...args: any[]) {
            if (sql.includes('CREATE TABLE')) {
                captured = this;
                throw new Error('isolated constructor setup failure');
            }
            return raw.apply(this, [sql, ...args]);
        });
        t.mock.method(Driver.prototype, 'close', function (this: any, ...args: any[]) {
            if (this === captured) closes++;
            return release.apply(this, args);
        });
        try {
            assert.throws(() => construct(path.join(profile, name + '.db')), /isolated constructor setup failure/);
            console.log(JSON.stringify({ name, closes, isOpen: captured?.open }));
            assert.equal(closes, 1, 'The failed factory cannot hand this connection to BaseStorage.close');
        } finally {
            if (captured) {
                try {
                    release.call(captured);
                } catch {}
            }
        }
    });

for (const [name, Database, Indexer, field] of [
    ['vector', VectorIndexDBWasm, VectorIndexer, 'vectorIndexer'],
    ['chunk', ChunkIndexDBWasm, ChunkIndexer, 'chunkIndexer']
] as const) {
    for (const stage of ['journal_mode', 'busy_timeout', 'adapter'])
        for (const closeFails of [false, true])
            test(`wasm-${name}: synchronous ${stage} failure closes; close fails=${closeFails}`, (t) => {
                const primary = new Error(`fixture ${stage}`);
                const cleanup = new Error('fixture close');
                let captured: any,
                    closes = 0;
                const run = Wasm.prototype.run,
                    release = Wasm.prototype.close;
                const oldHnsw = (HnswAdapter as any).HNSW;
                if (stage === 'adapter')
                    (HnswAdapter as any).HNSW = class {
                        constructor() {
                            throw primary;
                        }
                    };
                t.mock.method(Wasm.prototype, 'run', function (this: any, sql: string, ...args: any[]) {
                    captured = this;
                    if (sql.includes(`PRAGMA ${stage}`)) throw primary;
                    return run.apply(this, [sql, ...args]);
                });
                t.mock.method(Wasm.prototype, 'close', function (this: any) {
                    closes++;
                    if (closeFails) throw cleanup;
                    return release.call(this);
                });
                try {
                    assert.throws(
                        () => new Database(path.join(profile, `${name}-${stage}-${closeFails}.db`), 2),
                        (error) => error === primary
                    );
                    assert.ok(captured);
                    assert.equal(closes, 1);
                    const failure = getStorageInitializationFailure(primary)!;
                    assert.equal(failure.backend, 'wasm');
                    assert.equal(failure.indexer, name === 'vector' ? 'VectorIndexer' : 'ChunkIndexer');
                    assert.deepEqual(
                        failure.cleanupFailures.map((entry) => entry.error),
                        closeFails ? [cleanup] : []
                    );
                    if (closeFails)
                        assert.doesNotThrow(() => captured.run('SELECT 1'), 'failed close must not look closed');
                } finally {
                    (HnswAdapter as any).HNSW = oldHnsw;
                    if (captured) {
                        try {
                            release.call(captured);
                        } catch {}
                    }
                }
            });

    test(`wasm-${name}: healthy construction retains its connection`, async (t) => {
        let closes = 0;
        const release = Wasm.prototype.close;
        t.mock.method(Wasm.prototype, 'close', function (this: any) {
            closes++;
            return release.call(this);
        });
        const db = new Database(path.join(profile, `${name}-healthy.db`), 2);
        try {
            assert.equal(await db.count(), 0);
            assert.equal(closes, 0);
        } finally {
            db.close();
        }
        assert.equal(closes, 1);
    });

    test(`wasm-${name}: asynchronous table failure is released by its existing BaseStorage owner`, async (t) => {
        const primary = new Error('fixture async table failure');
        let closes = 0;
        const run = Wasm.prototype.run,
            release = Wasm.prototype.close;
        t.mock.method(Wasm.prototype, 'run', function (this: any, sql: string, ...args: any[]) {
            if (sql.includes('CREATE TABLE')) throw primary;
            return run.apply(this, [sql, ...args]);
        });
        t.mock.method(Wasm.prototype, 'close', function (this: any) {
            closes++;
            return release.call(this);
        });
        const db = new Database(path.join(profile, `${name}-async.db`), 2);
        const indexer = new Indexer(schema as any, path.join(profile, `${name}-unused.db`), { dim: 2 });
        (indexer as any).db = db;
        const storage = Object.create(BaseStorage.prototype);
        storage[field] = indexer;
        assert.equal(closes, 0);
        await assert.rejects(storage.initialize(), (error) => error === primary);
        assert.equal(closes, 1);
        assert.equal((indexer as any).db, null);
    });
}

async function filesystemOwner(t: any, backend: 'native' | 'wasm') {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const arkdata = process.env.ARKDATA_AVAILABLE;
    Object.defineProperty(process, 'platform', { value: backend === 'wasm' ? 'openharmony' : 'darwin' });
    delete process.env.ARKDATA_AVAILABLE;
    t.after(() => {
        Object.defineProperty(process, 'platform', platform);
        if (arkdata === undefined) delete process.env.ARKDATA_AVAILABLE;
        else process.env.ARKDATA_AVAILABLE = arkdata;
    });
    let configured = false;
    t.mock.method(Setting, 'getInstance', () => ({
        getData: () => ({}),
        getDefaultEmbeddingModelInstance: () =>
            configured ? { model_name: 'constructor-owner-fixture', getTimeoutMs: () => 1000 } : null
    }));
    t.mock.method(LLM, 'embed', async () => [1, 0]);
    const directory = fs.mkdtempSync(path.join(profile, `owner-${backend}-`));
    const storage = new FSStorage(directory);
    t.after(() => storage.close());
    await storage.initialize({ syncEmbedding: false });
    return { storage, configure: () => (configured = true) };
}

for (const backend of ['native', 'wasm'] as const) {
    for (const [indexer, targetPragma] of [
        ['vector', 1],
        ['base', 2],
        ['chunk', 3]
    ] as const) {
        test(`review R1 ${backend}/${indexer} failed construction remains owned until production close succeeds`, async (t) => {
            const { storage, configure } = await filesystemOwner(t, backend);
            const Driver = backend === 'wasm' ? Wasm : Native;
            const method = backend === 'wasm' ? 'run' : 'pragma';
            const execute = Driver.prototype[method],
                release = Driver.prototype.close;
            const primary = new Error('review R1 isolated initialization failure');
            const cleanup = new Error('review R1 isolated release failure');
            let captured: any,
                pragmas = 0,
                failing = true;
            const isOpen = () => (backend === 'wasm' ? captured.isOpen : captured.open);
            t.mock.method(Driver.prototype, method, function (this: any, sql: string, ...args: any[]) {
                if (sql.includes('journal_mode') && ++pragmas === targetPragma) {
                    captured = this;
                    throw primary;
                }
                return execute.apply(this, [sql, ...args]);
            });
            t.mock.method(Driver.prototype, 'close', function (this: any) {
                if (this === captured && failing) throw cleanup;
                return release.call(this);
            });
            configure();
            try {
                await assert.rejects(
                    storage.retrieval.prepare({ context: {}, reason: 'review R1 constructor owner', role: 'write' }),
                    (error) => error === primary
                );
                assert.ok(captured);
                assert.equal(isOpen(), true);
                assert.equal(storage._pendingStorageClosures.size, 1, 'FSStorage must retain the failed candidate');
                assert.equal(storage.mode, 'base-only');
                assert.equal(storage.isDeferred(), false);
                assert.equal((await storage.storage!.search([])).items.length, 0);
                failing = false;
                await storage._retryStorageClosures();
                assert.equal(isOpen(), false, 'the production closure chain releases the failed constructor handle');
                assert.equal(storage._pendingStorageClosures.size, 0);
            } finally {
                failing = false;
                if (captured && isOpen()) release.call(captured);
            }
        });
    }
}

for (const backend of ['native', 'wasm'] as const) {
    test(`review R1 ${backend} Worker retains scan ownership until failed constructor release is confirmed`, async (t) => {
        const { storage } = await filesystemOwner(t, backend);
        await storage.close();
        const Driver = backend === 'wasm' ? Wasm : Native;
        const method = backend === 'wasm' ? 'run' : 'pragma';
        const execute = Driver.prototype[method],
            release = Driver.prototype.close;
        const primary = new Error('review R1 Worker base construction failed');
        const cleanup = new Error('review R1 Worker base release failed');
        let captured: any,
            failing = true;
        const isOpen = () => (backend === 'wasm' ? captured.isOpen : captured.open);
        t.mock.method(Driver.prototype, method, function (this: any, sql: string, ...args: any[]) {
            if (!captured && sql.includes('journal_mode')) {
                captured = this;
                throw primary;
            }
            return execute.apply(this, [sql, ...args]);
        });
        t.mock.method(Driver.prototype, 'close', function (this: any) {
            if (this === captured && failing) throw cleanup;
            return release.call(this);
        });
        const worker = new FileManagerWorker('constructor-lock', storage._appDataDirectory);
        worker.config = { entries: [] };
        worker.callApp = async () => {};
        try {
            await worker.initialize();
            assert.equal(worker.status, 'error');
            assert.equal(worker._initError, primary);
            assert.ok(captured);
            assert.equal(isOpen(), true);
            assert.equal(worker.storage!._pendingStorageClosures.size, 1);
            const lockRelease = worker._releaseScanLock;
            assert.equal(typeof lockRelease, 'function');
            await assert.rejects(worker.finalize(), (error) => error === cleanup);
            assert.equal(worker._releaseScanLock, lockRelease, 'failed cleanup cannot release scan.lock');
            assert.equal(isOpen(), true);
            failing = false;
            await worker.finalize();
            assert.equal(isOpen(), false);
            assert.equal(worker.storage, null);
            assert.equal(worker._releaseScanLock, null);
        } finally {
            failing = false;
            await worker.finalize();
            if (captured && isOpen()) release.call(captured);
        }
    });
}

test('review R1 failed native extension cleanup cannot be bypassed by a WASM fallback', async (t) => {
    const { storage, configure } = await filesystemOwner(t, 'native');
    const primary = new Error('fixture native extension unavailable');
    const cleanup = new Error('fixture native extension cleanup failure');
    const release = Native.prototype.close,
        run = Wasm.prototype.run;
    let captured: any,
        failing = true,
        wasmRuns = 0;
    t.mock.method(Native.prototype, 'loadExtension', function (this: any) {
        captured = this;
        throw primary;
    });
    t.mock.method(Native.prototype, 'close', function (this: any) {
        if (this === captured && failing) throw cleanup;
        return release.call(this);
    });
    t.mock.method(Wasm.prototype, 'run', function (this: any, ...args: any[]) {
        wasmRuns++;
        return run.apply(this, args);
    });
    configure();
    try {
        await assert.rejects(
            storage.retrieval.prepare({ context: {}, reason: 'review R1 fallback', role: 'write' }),
            (error: any) => error instanceof SqliteVecLoadError && error.cause === primary
        );
        assert.equal(wasmRuns, 0);
        assert.equal(storage._pendingStorageClosures.size, 1);
        assert.equal(captured.open, true);
        failing = false;
        await storage._retryStorageClosures();
        assert.equal(captured.open, false);
        assert.equal(storage._pendingStorageClosures.size, 0);
    } finally {
        failing = false;
        if (captured?.open) release.call(captured);
    }
});
