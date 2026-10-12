import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { setArkdataDatabaseKit } from '../../../../../main/services/storage/arkdata-bridge.js';
import { setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';
import { BaseIndexDBArkdata } from '../../../../../main/services/storage/base-index-db-arkdata.js';
import { VectorIndexDBArkdata } from '../../../../../main/services/storage/vector-index-db-arkdata.js';
import { ChunkIndexDBArkdata } from '../../../../../main/services/storage/chunk-index-db-arkdata.js';
import type { ColumnSchema } from '../../../../../main/services/storage/abstract-storage.js';
import type { DatabaseKit } from '../../../../../platforms/bridges/common.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arkdata-lifecycle-'));
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}
function isCloseFailure(error: any, failure: Error): boolean {
    return (
        error === failure || (error?.code === 'store_close_failed' && error?.details?.sdkMessage === failure.message)
    );
}
const schema: ColumnSchema = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false }
    },
    needIndexers: {}
};

// Set OPENDESK_ARKDATA_ADAPTER_DIR to run the same lifecycle cases through the
// production ArkTS adapter, mocking only the HarmonyOS SDK and SQL responses.
const adapterDirectory = process.env.OPENDESK_ARKDATA_ADAPTER_DIR;
let loadAdapter: ((sdk: any, base: any, log: any) => any) | undefined;
if (adapterDirectory) {
    const contract = fs
        .readFileSync(path.join(adapterDirectory, 'ArkDataAdapterContract.ets'), 'utf8')
        .replace(/^import[\s\S]*?;\s*/gm, '');
    const adapter = fs
        .readFileSync(path.join(adapterDirectory, 'ArkDataAdapter.ets'), 'utf8')
        .replace(/^import[\s\S]*?;\s*/gm, '')
        .replace('@injectable()', '')
        .replace('@inject(MODULE_TYPE.Context) ', '');
    const code = stripTypeScriptTypes(contract + '\n' + adapter, { mode: 'transform' }).replace(/^export /gm, '');
    loadAdapter = new Function('relationalStore', 'BaseAdapter', 'LogUtil', code + '\nreturn ArkDataAdapter;') as any;
}

const backends = [
    { name: 'base', create: (file: string) => new BaseIndexDBArkdata(file, schema) },
    { name: 'vector', create: (file: string) => new VectorIndexDBArkdata(file, 2) },
    { name: 'chunk', create: (file: string) => new ChunkIndexDBArkdata(file, 2) }
];

async function fixture(backend: (typeof backends)[number], run: (f: any) => Promise<void>) {
    const calls = { acquires: 0, releases: 0, sdkOpens: 0, sdkCloses: 0, tables: 0 };
    const control = {
        openGate: null as ReturnType<typeof deferred> | null,
        tableGate: null as ReturnType<typeof deferred> | null,
        closeGate: null as ReturnType<typeof deferred> | null,
        openError: null as Error | null,
        tableError: null as Error | null,
        closeError: null as Error | null,
        closeFailuresRemaining: 0,
        sqlKit: null as any
    };
    const store = {
        close: async () => {
            calls.sdkCloses++;
            await control.closeGate?.promise;
            if (control.closeFailuresRemaining > 0) {
                control.closeFailuresRemaining--;
                throw new Error('synthetic transient close failure');
            }
            if (control.closeError) throw control.closeError;
        }
    };
    const sdk = {
        SecurityLevel: { S1: 1, S2: 2, S3: 3, S4: 4 },
        getRdbStore: async () => {
            calls.sdkOpens++;
            await control.openGate?.promise;
            if (control.openError) throw control.openError;
            return store;
        }
    };
    const Adapter = loadAdapter?.(sdk, class {}, { info() {}, warn() {}, error() {} });
    const adapter = Adapter ? new Adapter({}) : null;
    const stores = new Map<string, { references: number; opening: Promise<typeof store> }>();
    const checked = (raw: string) => {
        const result = JSON.parse(raw);
        if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
        return result;
    };
    const ready = async (method: string, id: string) => {
        for (let i = 0; i < 1000; i++) {
            const raw = adapter[method](id);
            const result = JSON.parse(raw);
            if (result.state !== 'pending') {
                checked(raw);
                assert.equal(result.state, 'success');
                return;
            }
            await tick();
        }
        assert.fail('Isolated adapter operation did not finish');
    };
    const closePromises: Promise<void>[] = [];
    const kit = {
        async openStore(id: string, options: any) {
            calls.acquires++;
            if (adapter) {
                const result = checked(
                    adapter.openStoreStart(id, 'fixture.db', JSON.stringify({ vector: options.vector }))
                );
                if (result.opId) await ready('openStoreReady', result.opId);
                return;
            }
            let record = stores.get(id);
            if (record) record.references++;
            else {
                record = { references: 1, opening: sdk.getRdbStore() };
                stores.set(id, record);
            }
            try {
                await record.opening;
            } catch (error) {
                stores.delete(id);
                throw error;
            }
        },
        closeStore(id: string) {
            calls.releases++;
            const close = (async () => {
                if (adapter) {
                    const result = checked(adapter.closeStoreStart(id));
                    await ready('closeStoreReady', result.opId);
                    return;
                }
                const record = stores.get(id);
                assert.ok(record, 'Only an acquired reference may be released');
                if (record.references > 1) {
                    record.references--;
                    return;
                }
                await (await record.opening).close();
                stores.delete(id);
            })();
            closePromises.push(close);
            return close;
        },
        async execSql(id: string, sql: string) {
            calls.tables++;
            await control.tableGate?.promise;
            if (control.tableError) throw control.tableError;
            await control.sqlKit?.execSql(id, sql);
        },
        async queryPrepared(_id: string, sql: string, params: any[] = []) {
            if (control.sqlKit) return control.sqlKit.queryPrepared(_id, sql, params);
            if (sql.includes('meta_value')) return [{ meta_value: (db as any).computeSchemaHash() }];
            return sql.includes('GROUP BY') ? [] : [{ count: 0 }];
        },
        async executePrepared(id: string, sql: string, params: any[]) {
            return control.sqlKit.executePrepared(id, sql, params);
        },
        async executePreparedManyBatched(id: string, sql: string, rows: any[][]) {
            return control.sqlKit.executePreparedManyBatched(id, sql, rows);
        },
        async transaction(id: string, run: any) {
            return control.sqlKit.transaction(id, run);
        }
    };
    const previous = setArkdataDatabaseKit(kit as unknown as DatabaseKit);
    const file = path.join(profile, `${backend.name}.db`);
    const db = backend.create(file);
    const owners = [db];
    const reads: Promise<unknown>[] = [];
    const drain = async () => {
        for (let i = 0; i < 4; i++) await tick();
        await Promise.allSettled(closePromises);
        await tick();
    };
    const references = () =>
        adapter
            ? [...adapter.stores.values()].reduce((n, record: any) => n + record.refCount, 0)
            : [...stores.values()].reduce((n, record) => n + record.references, 0);
    try {
        await run({
            db,
            calls,
            control,
            references,
            drain,
            another() {
                const owner = backend.create(file);
                owners.push(owner);
                return owner;
            },
            read(owner = db) {
                const result = owner.count();
                reads.push(
                    result.then(
                        () => undefined,
                        () => undefined
                    )
                );
                return result;
            }
        });
    } finally {
        control.openGate?.resolve();
        control.tableGate?.resolve();
        control.closeGate?.resolve();
        control.closeError = null;
        await Promise.allSettled(reads);
        await Promise.allSettled(owners.map((owner) => owner.close()));
        await drain();
        // Cleanup is limited to the in-memory SDK fixture, never a user store.
        if (adapter)
            for (const id of adapter.stores.keys()) {
                const result = checked(adapter.closeStoreForceStart(id));
                await ready('closeStoreForceReady', result.opId);
            }
        stores.clear();
        setArkdataDatabaseKit(previous);
    }
}

for (const backend of backends) {
    test(`${backend.name}: concurrent first reads acquire one reference and final close reaches SDK`, async () => {
        await fixture(backend, async (f) => {
            f.control.openGate = deferred();
            const reads = Promise.allSettled([f.read(), f.read(), f.read()]);
            await tick();
            f.control.openGate.resolve();
            assert.deepEqual(await reads, Array(3).fill({ status: 'fulfilled', value: 0 }));
            assert.equal(f.calls.acquires, 1);
            assert.equal(f.references(), 1);
            f.db.close();
            f.db.close();
            await f.drain();
            assert.equal(f.calls.releases, 1);
            assert.equal(f.calls.sdkCloses, 1);
            assert.equal(f.references(), 0);
        });
    });

    test(`${backend.name}: failed open is shared and can retry without a spurious release`, async () => {
        await fixture(backend, async (f) => {
            f.control.openError = new Error('synthetic open failure');
            const results = await Promise.allSettled([f.read(), f.read()]);
            assert.ok(results.every((result) => result.status === 'rejected'));
            assert.equal(f.calls.acquires, 1);
            assert.equal(f.calls.releases, 0);
            assert.equal(f.references(), 0);
            f.control.openError = null;
            assert.equal(await f.read(), 0);
            f.db.close();
            await f.drain();
            assert.equal(f.calls.acquires, 2);
            assert.equal(f.calls.releases, 1);
            assert.equal(f.references(), 0);
        });
    });

    test(`${backend.name}: failed table initialization releases its reference before retry`, async () => {
        await fixture(backend, async (f) => {
            const failure = (f.control.tableError = new Error('synthetic table failure'));
            const results = await Promise.allSettled([f.read(), f.read()]);
            for (const result of results) assert.deepEqual(result, { status: 'rejected', reason: failure });
            assert.equal(f.calls.acquires, 1);
            assert.equal(f.calls.releases, 1);
            assert.equal(f.references(), 0);
            f.control.tableError = null;
            assert.equal(await f.read(), 0);
            f.db.close();
            await f.drain();
            assert.equal(f.calls.acquires, 2);
            assert.equal(f.calls.releases, 2);
            assert.equal(f.references(), 0);
        });
    });

    test(`${backend.name}: failed cleanup preserves the original error and ownership for retry`, async () => {
        await fixture(backend, async (f) => {
            const failure = (f.control.tableError = new Error('synthetic table failure'));
            f.control.closeError = new Error('synthetic close failure');
            await assert.rejects(f.read(), (error) => error === failure);
            assert.equal(f.references(), 1);
            f.control.tableError = null;
            f.control.closeError = null;
            assert.equal(await f.read(), 0);
            assert.equal(f.calls.acquires, 1, 'Retry must reuse the reference retained after failed cleanup');
            f.db.close();
            await f.drain();
            assert.equal(f.calls.releases, 2);
            assert.equal(f.references(), 0);
        });
    });

    for (const stage of ['open', 'table'] as const) {
        test(`${backend.name}: close during ${stage} initialization cancels old reads and allows reopening`, async () => {
            await fixture(backend, async (f) => {
                const gate = deferred();
                f.control[stage === 'open' ? 'openGate' : 'tableGate'] = gate;
                const first = Promise.allSettled([f.read(), f.read()]);
                await tick();
                f.db.close();
                f.db.close();
                const reopened = f.read();
                gate.resolve();
                const results = await first;
                assert.ok(results.every((result) => result.status === 'rejected'));
                assert.equal(await reopened, 0);
                assert.equal(f.calls.acquires, 2);
                assert.equal(f.calls.releases, 1);
                assert.equal(f.references(), 1);
                f.db.close();
                await f.drain();
                assert.equal(f.calls.releases, 2);
                assert.equal(f.references(), 0);
            });
        });
    }

    test(`${backend.name}: independent objects share a store and release only their own reference`, async () => {
        await fixture(backend, async (f) => {
            const second = f.another();
            assert.deepEqual(await Promise.all([f.read(), f.read(second)]), [0, 0]);
            assert.equal(f.calls.acquires, 2);
            assert.equal(f.calls.sdkOpens, 1);
            f.db.close();
            f.db.close();
            await f.drain();
            assert.equal(f.references(), 1);
            assert.equal(f.calls.sdkCloses, 0);
            assert.equal(await f.read(second), 0);
            second.close();
            await f.drain();
            assert.equal(f.calls.releases, 2);
            assert.equal(f.calls.sdkCloses, 1);
            assert.equal(f.references(), 0);
        });
    });

    test(`${backend.name}: failed initialization releases only its own shared reference`, async () => {
        await fixture(backend, async (f) => {
            await f.read();
            const second = f.another();
            const failure = (f.control.tableError = new Error('synthetic shared-owner table failure'));
            await assert.rejects(f.read(second), (error) => error === failure);
            assert.equal(f.calls.acquires, 2);
            assert.equal(f.calls.releases, 1);
            assert.equal(f.calls.sdkCloses, 0);
            assert.equal(f.references(), 1);
            f.control.tableError = null;
            assert.equal(await f.read(), 0);
            f.db.close();
            await f.drain();
            assert.equal(f.calls.releases, 2);
            assert.equal(f.calls.sdkCloses, 1);
            assert.equal(f.references(), 0);
        });
    });

    test(`${backend.name}: reopening waits for this object's pending final close`, async () => {
        await fixture(backend, async (f) => {
            await f.read();
            f.control.closeGate = deferred();
            f.db.close();
            await tick();
            const reopened = f.read();
            await tick();
            assert.equal(f.calls.acquires, 1);
            f.control.closeGate.resolve();
            assert.equal(await reopened, 0);
            assert.equal(f.calls.acquires, 2);
            assert.equal(f.calls.releases, 1);
            assert.equal(f.references(), 1);
            f.db.close();
            await f.drain();
            assert.equal(f.calls.releases, 2);
            assert.equal(f.references(), 0);
        });
    });

    test(`${backend.name}: BaseStorage retains a failed owner and closes it before a later owner exits`, async () => {
        const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
        const { makeSchema } = await import('../../../../../main/applications/filemgr/storage.js');
        await fixture(backend, async (f) => {
            const name = backend.name + 'Indexer';
            const oldStorage = new BaseStorage('old', makeSchema(2, { mode: 'full' }), profile);
            (oldStorage as any)[name].db = f.db;
            await f.read();
            const failure = (f.control.closeError = new Error('synthetic final close failure'));
            await assert.rejects(
                async () => oldStorage.close(),
                (error) => isCloseFailure(error, failure)
            );
            assert.equal((oldStorage as any)[name].db, f.db, 'Failed ownership must remain reachable');
            assert.equal(f.references(), 1);
            f.control.closeError = null;
            await oldStorage.close();
            assert.equal((oldStorage as any)[name].db, null);
            assert.equal(f.references(), 0);
            const nextStorage = new BaseStorage('next', makeSchema(2, { mode: 'full' }), profile);
            const next = f.another();
            (nextStorage as any)[name].db = next;
            await f.read(next);
            await nextStorage.close();
            assert.equal(f.references(), 0);
            assert.equal(f.calls.acquires, 2);
            assert.equal(f.calls.sdkCloses, 3, 'One failed and two successful physical closes');
        });
    });

    test(`${backend.name}: drop failure keeps the owner reachable for BaseStorage cleanup`, async () => {
        const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
        const { makeSchema } = await import('../../../../../main/applications/filemgr/storage.js');
        await fixture(backend, async (f) => {
            const storage = new BaseStorage('drop', makeSchema(2, { mode: 'full' }), profile);
            const name = backend.name + 'Indexer';
            (storage as any)[name].db = f.db;
            await f.read();
            f.control.closeError = new Error('synthetic drop close failure');
            await assert.rejects(
                storage.dropIndexers([backend.name[0].toUpperCase() + backend.name.slice(1) + 'Indexer'] as any)
            );
            assert.equal((storage as any)[name].db, f.db);
            assert.equal(f.references(), 1);
            f.control.closeError = null;
            await storage.close();
            assert.equal(f.references(), 0);
        });
    });

    test(`${backend.name}: FileMgr teardown retries a transient close before releasing its scan lock`, async () => {
        const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
        const { FSStorage, makeSchema } = await import('../../../../../main/applications/filemgr/storage.js');
        const { default: FileManagerWorker } = await import('../../../../../main/applications/filemgr/worker.js');
        await fixture(backend, async (f) => {
            const storage = new BaseStorage('teardown', makeSchema(2, { mode: 'full' }), profile);
            (storage as any)[backend.name + 'Indexer'].db = f.db;
            const fss = new FSStorage(profile);
            fss.storage = storage;
            const worker = new FileManagerWorker('com.test.close', profile);
            worker.storage = fss;
            let released = 0;
            worker._releaseScanLock = async () => {
                assert.equal(f.references(), 0, 'Release the lock only after releasing the database');
                released++;
            };
            await f.read();
            f.control.closeFailuresRemaining = 1;
            await worker._teardownRuntime('isolated transient failure');
            assert.equal(f.references(), 0);
            assert.equal(worker.storage, null);
            assert.equal(released, 1);
        });
    });

    test(`${backend.name}: final close failure can be retried without forgetting ownership`, async () => {
        await fixture(backend, async (f) => {
            await f.read();
            const failure = (f.control.closeError = new Error('synthetic close failure'));
            await assert.rejects(f.db.close(), (error) => isCloseFailure(error, failure));
            await f.drain();
            assert.equal(f.references(), 1);
            f.control.closeError = null;
            f.db.close();
            await f.drain();
            assert.equal(f.calls.releases, 2);
            assert.equal(f.references(), 0);
        });
    });
}

test('readonly startup status pushes share the lazy base store reference', async () => {
    const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
    const { FSStorage, makeSchema } = await import('../../../../../main/applications/filemgr/storage.js');
    const { default: FileManagerWorker } = await import('../../../../../main/applications/filemgr/worker.js');
    const readonlySchema = makeSchema(2, { mode: 'base-only' });
    await fixture({ name: 'readonly', create: (file) => new BaseIndexDBArkdata(file, readonlySchema) }, async (f) => {
        const storage = new BaseStorage('review', readonlySchema, path.join(profile, 'readonly-storage'));
        (storage.baseIndexer as any).db = f.db;
        const fss = new FSStorage(profile);
        fss.storage = storage;
        const worker = new FileManagerWorker('com.test.filemgr', profile);
        worker.storage = fss;
        worker._readonlyMode = true;
        worker.config = { entries: [] };
        let pushes = 0;
        worker.callApp = () => {
            pushes++;
        };
        f.control.openGate = deferred();
        try {
            worker._setStatus('readonly', 'test');
            worker._ensureStatusPushHooks();
            await worker.runSequentially(async () => {});
            await tick();
            f.control.openGate.resolve();
            for (let i = 0; i < 100 && pushes < 2; i++) await tick();
            assert.equal(pushes, 2);
            assert.equal(f.calls.acquires, 1);
            assert.equal(f.references(), 1);
            await storage.close();
            await f.drain();
            assert.equal(f.calls.releases, 1);
            assert.equal(f.calls.sdkCloses, 1);
            assert.equal(f.references(), 0);
        } finally {
            f.control.openGate.resolve();
            worker.storage = null;
            await worker.finalize();
        }
    });
});

test('persistent teardown failure keeps storage and lock available for a later retry', async () => {
    const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
    const { FSStorage } = await import('../../../../../main/applications/filemgr/storage.js');
    const { default: FileManagerWorker } = await import('../../../../../main/applications/filemgr/worker.js');
    await fixture(backends[0], async (f) => {
        const storage = new BaseStorage('persistent', schema, profile);
        (storage.baseIndexer as any).db = f.db;
        const fss = new FSStorage(profile);
        fss.storage = storage;
        const worker = new FileManagerWorker('com.test.close', profile);
        worker.storage = fss;
        let releases = 0;
        worker._releaseScanLock = async () => {
            releases++;
        };
        await f.read();
        const failure = (f.control.closeError = new Error('synthetic persistent close failure'));
        await assert.rejects(worker._teardownRuntime('failed'), (error) => isCloseFailure(error, failure));
        assert.equal(worker.storage, fss);
        assert.equal(fss.storage, null, 'The retained holder is not available for database operations');
        assert.ok(fss._pendingStorageClosures.has(storage));
        assert.equal((storage.baseIndexer as any).db, f.db);
        assert.equal(releases, 0);
        f.control.closeError = null;
        await worker._teardownRuntime('retry');
        assert.equal(f.references(), 0);
        assert.equal(worker.storage, null);
        assert.equal(releases, 1);
    });
});

test('failed temporary candidate survives its local scope and is released by FSStorage.close', async () => {
    const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
    const { FSStorage } = await import('../../../../../main/applications/filemgr/storage.js');
    await fixture(backends[0], async (f) => {
        const fss = new FSStorage(profile);
        await f.read();
        const failure = (f.control.closeError = new Error('synthetic candidate close failure'));
        {
            const candidate = new BaseStorage('candidate', schema, profile);
            (candidate.baseIndexer as any).db = f.db;
            await assert.rejects(fss._closeBaseStorage(candidate), (error) => isCloseFailure(error, failure));
        }
        assert.equal(fss.storage, null);
        assert.equal(fss._pendingStorageClosures.size, 1);
        assert.equal(f.references(), 1);
        f.control.closeError = null;
        await fss.close();
        assert.equal(fss._pendingStorageClosures.size, 0);
        assert.equal(f.references(), 0);
    });
});

test('BaseStorage.close waits for every indexer, coalesces callers and rejects new work', async () => {
    const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
    const storage = new BaseStorage('all', schema, profile);
    const gate = deferred();
    const failure = new Error('synthetic indexer close failure');
    let attempts = 0;
    let released = 0;
    (storage.baseIndexer as any).close = async () => {
        attempts++;
        await gate.promise;
        if (attempts === 1) throw failure;
    };
    (storage as any).vectorIndexer = {
        close() {
            released++;
        }
    };
    const first = storage.close();
    assert.equal(storage.close(), first);
    await assert.rejects(storage.getStatus(), /closing or closed/);
    gate.resolve();
    await assert.rejects(first, (error) => isCloseFailure(error, failure));
    assert.equal(released, 1, 'Other indexers are cleaned even when one fails');
    await storage.close();
    assert.equal(attempts, 2);
});

for (const backend of backends.slice(1)) {
    test(`${backend.name}: an unopened indexer retains a raw-drop owner after failed close`, async () => {
        const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
        const { makeSchema } = await import('../../../../../main/applications/filemgr/storage.js');
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const available = process.env.ARKDATA_AVAILABLE;
        Object.defineProperty(process, 'platform', { value: 'openharmony' });
        process.env.ARKDATA_AVAILABLE = '1';
        try {
            await fixture(backend, async (f) => {
                const storage = new BaseStorage('raw-drop', makeSchema(2, { mode: 'full' }), profile);
                f.control.closeError = new Error('synthetic raw-drop close failure');
                const name = backend.name[0].toUpperCase() + backend.name.slice(1) + 'Indexer';
                await assert.rejects(storage.dropIndexers([name] as any));
                assert.ok((storage as any)[backend.name + 'Indexer'].db);
                assert.equal(f.references(), 1);
                assert.equal(
                    f.calls.tables,
                    2,
                    'Raw drop executes only two DROP statements, without CREATE or dim reads'
                );
                f.control.closeError = null;
                await storage.close();
                assert.equal(f.references(), 0);
            });
        } finally {
            Object.defineProperty(process, 'platform', platform);
            if (available === undefined) delete process.env.ARKDATA_AVAILABLE;
            else process.env.ARKDATA_AVAILABLE = available;
        }
    });
}

test('failed mode-transition candidate remains reachable for final cleanup', async () => {
    const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
    const { FSStorage } = await import('../../../../../main/applications/filemgr/storage.js');
    const initialize = BaseStorage.prototype.initialize;
    try {
        await fixture(backends[0], async (f) => {
            const fss = new FSStorage(profile);
            fss.mode = 'full';
            const old = new BaseStorage('old', schema, profile);
            fss.storage = old;
            const failure = new Error('synthetic candidate initialization failure');
            BaseStorage.prototype.initialize = async function () {
                (this.baseIndexer as any).db = f.db;
                await f.read();
                throw failure;
            };
            f.control.closeError = new Error('synthetic candidate cleanup failure');
            await assert.rejects(fss._demoteToBaseOnly('isolated'), (error) => error === failure);
            assert.equal(fss.storage, old, 'Failed initialization must not publish the candidate');
            assert.equal(fss._pendingStorageClosures.size, 1);
            assert.equal(f.references(), 1);
            f.control.closeError = null;
            await fss.close();
            assert.equal(fss._pendingStorageClosures.size, 0);
            assert.equal(f.references(), 0);
        });
    } finally {
        BaseStorage.prototype.initialize = initialize;
    }
});

test('initialization keeps its original failure and a holder whose asynchronous cleanup failed', async () => {
    const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
    await fixture(backends[0], async (f) => {
        const storage = new BaseStorage('initialization', schema, profile);
        (storage.baseIndexer as any).db = f.db;
        const failure = new Error('synthetic upper initialization failure');
        storage.baseIndexer.initialize = async () => {
            await f.read();
            throw failure;
        };
        f.control.closeError = new Error('synthetic asynchronous cleanup failure');
        await assert.rejects(storage.initialize(), (error) => error === failure);
        assert.equal((storage.baseIndexer as any).db, f.db);
        assert.equal(f.references(), 1);
        f.control.closeError = null;
        await storage.close();
        assert.equal(f.references(), 0);
    });
});

// SQLite executes the SQL boundary for recovery cases. The SDK lifecycle still
// runs through the same reference fixture / optional production ArkTS adapter.
function sqliteSqlFixture() {
    const SQLite = createRequire(import.meta.url)('better-sqlite3');
    // Resolve the host native binding before the test simulates HarmonyOS.
    new SQLite(':memory:').close();
    const databases = new Map<string, any>();
    const database = (id: string) => {
        if (!databases.has(id)) {
            const db = new SQLite(':memory:');
            // SQLite supplies storage; only the SDK vector-distance operator is simulated.
            db.function('fixture_cosine', (left: Buffer, right: Buffer) => {
                let dot = 0;
                let leftNorm = 0;
                let rightNorm = 0;
                for (let offset = 0; offset < left.length; offset += 4) {
                    const a = left.readFloatLE(offset);
                    const b = right.readFloatLE(offset);
                    dot += a * b;
                    leftNorm += a * a;
                    rightNorm += b * b;
                }
                return 1 - dot / Math.sqrt(leftNorm * rightNorm);
            });
            databases.set(id, db);
        }
        return databases.get(id);
    };
    const values = (params: any[]) =>
        params.map(({ t, v }) => (t === 'vector' ? Buffer.from(new Float32Array(v).buffer) : v));
    const kit = {
        execSql(id: string, sql: string) {
            database(id).exec(sql);
        },
        queryPrepared(id: string, sql: string, params: any[]) {
            return database(id)
                .prepare(sql.replace(/repr <=> \?/g, 'fixture_cosine(repr, ?)'))
                .all(...values(params));
        },
        executePrepared(id: string, sql: string, params: any[]) {
            return {
                affectedRows: database(id)
                    .prepare(sql)
                    .run(...values(params)).changes
            };
        },
        executePreparedManyBatched(id: string, sql: string, rows: any[][]) {
            const statement = database(id).prepare(sql);
            return { affectedRows: rows.reduce((count, row) => count + statement.run(...values(row)).changes, 0) };
        },
        async transaction(id: string, run: any) {
            const db = database(id);
            db.exec('BEGIN');
            try {
                const result = await run({ id: 'fixture-transaction' });
                db.exec('COMMIT');
                return result;
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        }
    };
    return {
        kit,
        close: () => {
            for (const db of databases.values()) db.close();
        }
    };
}

const recoveryCases: Array<{ recovery: 'sync' | 'scan' | 'restart'; rootCount: number; content: string }> = [];
for (const recovery of ['sync', 'scan'] as const) {
    for (const rootCount of [1, 2]) {
        for (const content of ['normal', 'empty', 'oversize']) {
            recoveryCases.push({ recovery, rootCount, content });
        }
    }
}
for (const content of ['normal', 'empty', 'oversize']) {
    recoveryCases.push({ recovery: 'restart', rootCount: 2, content });
}
for (const { recovery, rootCount, content } of recoveryCases) {
    test(`failed model transition recovers via ${recovery} with ${rootCount} roots and ${content} content`, async () => {
        const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
        const { FSStorage, makeSchema } = await import('../../../../../main/applications/filemgr/storage.js');
        const { default: FileManagerWorker } = await import('../../../../../main/applications/filemgr/worker.js');
        const { Setting } = await import('../../../../../main/utils/setting.js');
        const { LLM } = await import('../../../../../main/aikernel/llm.js');
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const available = process.env.ARKDATA_AVAILABLE;
        const getInstance = Setting.getInstance;
        const batchEmbed = LLM.batchEmbed;
        const embed = LLM.embed;
        const rerank = LLM.rerank;
        LLM.embed = async () => [1, 0];
        LLM.rerank = async (_query: string, items: any[]) => items;
        const sql = sqliteSqlFixture();
        Object.defineProperty(process, 'platform', { value: 'openharmony' });
        process.env.ARKDATA_AVAILABLE = '1';
        (Setting as any).getInstance = () => ({
            getDefaultEmbeddingModelInstance: () => ({ model_name: 'model-b' }),
            getData: () => ({})
        });
        let embeddings = 0;
        LLM.batchEmbed = async (texts: string[]) => {
            embeddings += texts.length;
            return texts.map(() => [1, 0]);
        };
        try {
            await fixture(backends[1], async (f) => {
                f.control.sqlKit = sql.kit;
                const directory = fs.mkdtempSync(path.join(profile, `recovery-${recovery}-${rootCount}-`));
                const roots = Array.from({ length: rootCount }, (_, i) => path.join(directory, `files-${i}`));
                for (const root of roots) fs.mkdirSync(root);
                const [root] = roots;
                const extraFiles = roots.slice(1).map((otherRoot) => {
                    const file = path.join(otherRoot, 'other.md');
                    fs.writeFileSync(file, '# Other fixture\nA file in another configured root.');
                    return file;
                });
                const oldFile = path.join(root, 'old.md');
                const newFile = path.join(root, 'new.md');
                fs.writeFileSync(oldFile, '# Old fixture\nA file needing generation reconciliation.');
                fs.writeFileSync(newFile, '# New fixture\nA file discovered after recovery.');
                let fss = new FSStorage(directory);
                const old = new BaseStorage('filemgr', makeSchema(2, { mode: 'full' }), fss._storageDir);
                fss.storage = old;
                fss.mode = 'full';
                Object.assign(fss.scannerState, {
                    embedding_model: 'model-a',
                    vec_dim: 2,
                    chunk_level: 'structured',
                    vector_backend: 'arkdata',
                    embedding_generation: 0,
                    embedding_request_dim: 2,
                    _requestDimResolved: true,
                    embedded_migrated: true,
                    _migratedRefCount: true
                });
                for (const configuredRoot of roots) {
                    fss.scannerState.roots[configuredRoot] = {
                        last_full_scan: 0,
                        last_scan_at: null,
                        total_files: configuredRoot === root ? 1 : 0,
                        last_file_count: configuredRoot === root ? 1 : 0,
                        paused: false
                    };
                }
                const worker = new FileManagerWorker('com.test.recovery', directory);
                worker.storage = fss;
                const entries = roots.map((root) => ({ root, include_patterns: ['**/*'], exclude_patterns: [] }));
                worker.config = { entries };
                worker.callApp = async () => {};
                worker.taskQueue.pause();
                let probes = 0;
                fss._probeEmbedding = async () => {
                    probes++;
                    return { ok: true, dim: 2, model_name: 'model-b', requestDim: 2 };
                };
                try {
                    await old.initialize();
                    await old.upsert(
                        [
                            {
                                item_id: oldFile,
                                item_type: 'file',
                                type: 'file',
                                filename: 'old.md',
                                root_refs: JSON.stringify([root]),
                                ref_count: 1,
                                embedded: 1,
                                embedding_generation: 0
                            }
                        ],
                        { indexers: ['BaseIndexer'] }
                    );
                    // Seed real semantic records as well as base completion. An old
                    // chunk must never become visible under the new generation.
                    await old.upsert(
                        [
                            {
                                item_id: oldFile,
                                item_type: 'file',
                                indexer_columns: {
                                    VectorIndexer: [{ column: 'filename', content: [0, 1] }],
                                    ChunkIndexer: [
                                        {
                                            column: 'chunk_text',
                                            id: 'obsolete-model-a',
                                            text: 'Obsolete content from model A',
                                            content: [0, 1]
                                        }
                                    ]
                                }
                            }
                        ],
                        { indexers: ['VectorIndexer', 'ChunkIndexer'] }
                    );
                    if (content === 'empty') fs.writeFileSync(oldFile, '');
                    if (content === 'oversize') {
                        const { RAW_TEXT_MAX_FILE_SIZE } =
                            await import('../../../../../main/applications/filemgr/parser/extract.js');
                        fs.writeFileSync(oldFile, 'x'.repeat(RAW_TEXT_MAX_FILE_SIZE + 1));
                    }
                    const scanners = new Map();
                    for (const entry of entries) {
                        scanners.set(entry.root, await worker._startScanner(entry, entries));
                    }
                    f.control.closeError = new Error('synthetic persistent SDK close failure');
                    await assert.rejects(fss.syncEmbeddingMode('embedding config changed'));
                    assert.equal(fss.scannerState.embedding_model, 'model-b');
                    assert.equal(fss.scannerState.embedding_generation, 1);
                    assert.equal(fss._pendingStorageClosures.size, 1);
                    assert.equal(fss.isDeferred(), true, 'A closing holder must not be advertised as usable');
                    const acquires = f.calls.acquires;
                    await assert.rejects(fss.syncEmbeddingMode('still failed'));
                    assert.equal(
                        f.calls.acquires,
                        acquires,
                        'Persistent close failure must prevent opening new holders'
                    );
                    assert.equal(probes, 1, 'Failed cleanup must run before probing or the already-full shortcut');
                    f.control.closeError = null;
                    if (recovery === 'restart') {
                        const probe = fss._probeEmbedding;
                        await worker._stopScanners();
                        await fss.close();
                        fss = new FSStorage(directory);
                        fss._probeEmbedding = probe;
                        worker.storage = fss;
                        await fss.initialize();
                        scanners.clear();
                        for (const entry of entries) {
                            scanners.set(entry.root, await worker._startScanner(entry, entries));
                        }
                    }
                    if (recovery === 'sync') {
                        await fss.syncEmbeddingMode('recovered');
                        assert.equal(fss._pendingStorageClosures.size, 0);
                        assert.notEqual(fss.storage, old);
                        const rows = (await fss.storage.search([])).items;
                        assert.equal(rows.length, 1);
                        assert.equal(rows[0].item.embedding_generation, 1);
                        assert.equal(rows[0].item.embedded, 0, 'Reopen must reconcile stale generation before success');
                    }
                    worker.taskQueue.start();
                    await worker.taskQueue.onIdle();
                    assert.equal(worker.storage, fss, 'Recovery must reuse the running FileMgr instance');
                    for (const configuredRoot of roots) {
                        const scanner = scanners.get(configuredRoot);
                        assert.equal(worker.scanners.get(configuredRoot), scanner, 'Recovery must keep every scanner');
                        assert.equal(
                            scanner.state,
                            fss.scannerState.roots[configuredRoot],
                            'Every scanner must use the current root checkpoint state'
                        );
                    }
                    assert.equal(fss.isDeferred(), false);
                    assert.equal(fss._pendingStorageClosures.size, 0);
                    const rows = (await fss.storage.search([])).items;
                    const expectedFiles = [oldFile, newFile, ...extraFiles];
                    assert.deepEqual(rows.map(({ item }: any) => item.item_id).sort(), expectedFiles.sort());
                    assert.ok(rows.every(({ item }: any) => item.embedding_generation === 1 && item.embedded === 1));
                    assert.ok(embeddings > 0, 'Recovered scan must actually reach embedding');
                    assert.equal(fss.scannerState.semantic_reset_pending, false);
                    const search = await fss.searchIndexedChunks('obsolete content', { topK: 10 });
                    assert.equal(
                        search.results.some((hit: any) => hit.chunk.id === 'obsolete-model-a'),
                        false,
                        'Content search must not return a chunk from the interrupted old model'
                    );
                    if (content !== 'normal') {
                        assert.equal(
                            search.results.some((hit: any) => hit.source.path === oldFile),
                            false,
                            'A filename-only embedding must have no content hits'
                        );
                    }
                    for (const configuredRoot of roots) {
                        assert.ok(
                            fss.scannerState.roots[configuredRoot].last_full_scan > 0,
                            'Every root checkpoint must reach the current scanner state'
                        );
                    }
                    assert.equal(
                        fss.scannerState.embedding_generation,
                        1,
                        'Recovery must not repeat a completed invalidation'
                    );
                    const status = await fss.storage.getStatus();
                    assert.equal(status.BaseIndexer.size, expectedFiles.length);
                    assert.equal(status.VectorIndexer.size, expectedFiles.length);
                    assert.equal(status.ChunkIndexer.size, expectedFiles.length - (content === 'normal' ? 0 : 1));
                    assert.equal(probes, 2, 'A healthy already-full storage must reuse the resolved model');
                    const persisted = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8'));
                    for (const configuredRoot of roots) {
                        const state = fss.scannerState.roots[configuredRoot];
                        assert.equal(persisted.roots[configuredRoot].last_full_scan, state.last_full_scan);
                        assert.equal(persisted.roots[configuredRoot].last_scan_at, state.last_scan_at);
                        assert.equal(
                            persisted.roots[configuredRoot].total_files,
                            expectedFiles.filter((file) => path.dirname(file) === configuredRoot).length
                        );
                    }
                    assert.equal(persisted.embedding_generation, 1);
                } finally {
                    f.control.closeError = null;
                    worker.taskQueue.start();
                    await worker.taskQueue.onIdle();
                    await worker.finalize();
                    assert.equal(f.references(), 0, 'All recovered holders must eventually exit');
                    sql.close();
                }
            });
        } finally {
            Setting.getInstance = getInstance;
            LLM.batchEmbed = batchEmbed;
            LLM.embed = embed;
            LLM.rerank = rerank;
            Object.defineProperty(process, 'platform', platform);
            if (available === undefined) delete process.env.ARKDATA_AVAILABLE;
            else process.env.ARKDATA_AVAILABLE = available;
        }
    });
}

for (const timing of ['before-initialize', 'during-initialize']) {
    test(`BaseStorage close ${timing} prevents subsequent indexer acquisitions`, async (t) => {
        const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
        const sql = sqliteSqlFixture();
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const available = process.env.ARKDATA_AVAILABLE;
        Object.defineProperty(process, 'platform', { value: 'openharmony' });
        process.env.ARKDATA_AVAILABLE = '1';
        try {
            await fixture(backends[0], async (f) => {
                f.control.sqlKit = sql.kit;
                const genericSchema: ColumnSchema = {
                    columns: { ...schema.columns, caption: { type: 'TEXT' }, content: { type: 'TEXT' } },
                    needIndexers: {
                        caption: [{ indexer: 'VectorIndexer', options: { dim: 2 } }],
                        content: [{ indexer: 'ChunkIndexer', options: { dim: 2 } }]
                    }
                };
                const storage = new BaseStorage('fixture', genericSchema, profile);
                const gate = deferred();
                try {
                    let initialization: Promise<void>;
                    if (timing === 'during-initialize') {
                        t.mock.method(storage.vectorIndexer!, 'initialize', async () => gate.promise);
                        initialization = storage.initialize();
                        await tick();
                        let closed = false;
                        const closing = storage.close().then(() => {
                            closed = true;
                        });
                        await tick();
                        assert.equal(closed, false, 'Close must await accepted initialization work');
                        gate.resolve();
                        await closing;
                    } else {
                        await storage.close();
                        initialization = storage.initialize();
                    }
                    await assert.rejects(initialization, /closing or closed/);
                    assert.equal(f.calls.acquires, 0, 'Initialization must not acquire stores after close');
                } finally {
                    gate.resolve();
                    await storage.close();
                    assert.equal(f.references(), 0);
                    sql.close();
                }
            });
        } finally {
            Object.defineProperty(process, 'platform', platform);
            if (available === undefined) delete process.env.ARKDATA_AVAILABLE;
            else process.env.ARKDATA_AVAILABLE = available;
        }
    });
}

test('BaseStorage close awaits a real in-flight first ArkData acquisition', async () => {
    const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
    const sql = sqliteSqlFixture();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const available = process.env.ARKDATA_AVAILABLE;
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    process.env.ARKDATA_AVAILABLE = '1';
    try {
        await fixture(backends[1], async (f) => {
            f.control.sqlKit = sql.kit;
            const gate = deferred();
            f.control.openGate = gate;
            const genericSchema: ColumnSchema = {
                columns: { ...schema.columns, caption: { type: 'TEXT' }, content: { type: 'TEXT' } },
                needIndexers: {
                    caption: [{ indexer: 'VectorIndexer', options: { dim: 2 } }],
                    content: [{ indexer: 'ChunkIndexer', options: { dim: 2 } }]
                }
            };
            const storage = new BaseStorage('generic-fixture', genericSchema, path.join(profile, 'pending-factory'));
            const initialization = storage.initialize();
            const rejected = assert.rejects(initialization, /closing or closed/);
            while (f.calls.sdkOpens === 0) await tick();
            let closed = false;
            const closing = storage.close().then(() => {
                closed = true;
            });
            try {
                await tick();
                assert.equal(closed, false, 'The factory/open still owns pending acquisition work');
            } finally {
                gate.resolve();
                await Promise.all([rejected, closing]);
            }
            assert.equal(f.calls.sdkOpens, 1, 'Close prevents acquiring later base/chunk stores');
            assert.equal(f.calls.sdkCloses, 1);
            assert.equal(f.references(), 0);
        });
    } finally {
        sql.close();
        Object.defineProperty(process, 'platform', platform);
        if (available === undefined) delete process.env.ARKDATA_AVAILABLE;
        else process.env.ARKDATA_AVAILABLE = available;
    }
});
