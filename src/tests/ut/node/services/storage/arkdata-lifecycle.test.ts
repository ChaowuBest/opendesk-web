import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { createArkDataStoreId, toArkDataDbPath } from '../../../../../main/services/storage/arkdata-path.js';
import { setArkdataDatabaseKit } from '../../../../../main/services/storage/arkdata-bridge.js';
import { setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';
import { BaseIndexDBArkdata } from '../../../../../main/services/storage/base-index-db-arkdata.js';
import { VectorIndexDBArkdata } from '../../../../../main/services/storage/vector-index-db-arkdata.js';
import { ChunkIndexDBArkdata } from '../../../../../main/services/storage/chunk-index-db-arkdata.js';
import type { ColumnSchema } from '../../../../../main/services/storage/abstract-storage.js';
import { ArkDataBridgeError, type DatabaseKit } from '../../../../../platforms/bridges/common.js';
import { getStorageInitializationFailure } from '../../../../../main/services/storage/platform.js';
import { initializationRecovery } from '../../../../../main/applications/filemgr/document-retrieval/embedding/state.js';
import { FSStorage } from '../../../../../main/applications/filemgr/storage.js';

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

const bridgeCode = stripTypeScriptTypes(
    fs
        .readFileSync(new URL('../../../../../platforms/bridges/harmonyos/database.ts', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\s*/gm, ''),
    { mode: 'transform' }
).replace(/^export /gm, '');
const loadBridge = new Function(
    'createHash',
    'logger',
    'ArkDataBridgeError',
    'executePreparedManyBatchedWith',
    'callArkTS',
    'EtsBridgeMethods',
    'hasArkTSAdapter',
    'Date',
    bridgeCode + '\nreturn { HarmonyOSDatabaseKit, arkDataStoreName };'
);

const backends = [
    { name: 'base', create: (file: string) => new BaseIndexDBArkdata(file, schema) },
    { name: 'vector', create: (file: string) => new VectorIndexDBArkdata(file, 2) },
    { name: 'chunk', create: (file: string) => new ChunkIndexDBArkdata(file, 2) }
];

async function fixture(backend: (typeof backends)[number], run: (f: any) => Promise<void>) {
    const calls = {
        acquires: 0,
        releases: 0,
        sdkOpens: 0,
        sdkCloses: 0,
        tables: 0,
        sdkDeletes: 0,
        deletes: 0,
        deleteIds: [] as string[]
    };
    const control = {
        openGate: null as ReturnType<typeof deferred> | null,
        tableGate: null as ReturnType<typeof deferred> | null,
        closeGate: null as ReturnType<typeof deferred> | null,
        openError: null as Error | null,
        openErrorStorePrefix: null as string | null,
        openErrorOnce: false,
        tableError: null as Error | null,
        closeError: null as Error | null,
        closeFailuresRemaining: 0,
        deleteError: null as Error | null,
        deleteGate: null as ReturnType<typeof deferred> | null,
        deleteTimeout: false,
        deleteTarget: null as string | null,
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
    const sdkIdentities = new Map<string, string>();
    const sdk = {
        SecurityLevel: { S1: 1, S2: 2, S3: 3, S4: 4 },
        deleteRdbStore: async (_context: any, config: any) => {
            calls.sdkDeletes++;
            const id = sdkIdentities.get(config.name)!;
            calls.deleteIds.push(id);
            if (!control.deleteTarget || control.deleteTarget === id) {
                await control.deleteGate?.promise;
                if (control.deleteError) throw control.deleteError;
            }
            control.sqlKit?.deleteStore(id);
        },
        getRdbStore: async (_context: any, config: { name: string }) => {
            calls.sdkOpens++;
            await control.openGate?.promise;
            if (
                control.openError &&
                (!control.openErrorStorePrefix ||
                    sdkIdentities.get(config.name)?.startsWith(control.openErrorStorePrefix))
            ) {
                const error = control.openError;
                if (control.openErrorOnce) control.openError = null;
                throw error;
            }
            return store;
        }
    };
    const Adapter = loadAdapter?.(sdk, class {}, { info() {}, warn() {}, error() {} });
    const adapter = Adapter ? new Adapter({}) : null;
    const routes: Record<string, string> = {
        'ArkData.DeleteStoreStart': 'deleteStoreStart',
        'ArkData.DeleteStoreReady': 'deleteStoreReady'
    };
    let clock = 0,
        deletingId = '';
    const { HarmonyOSDatabaseKit, arkDataStoreName } = loadBridge(
        createHash,
        { warn() {} },
        ArkDataBridgeError,
        undefined,
        async (method: string, _type: string, args: string[]) => adapter[routes[method]](...args),
        {
            ARKDATA_DELETE_STORE_START: 'ArkData.DeleteStoreStart',
            ARKDATA_DELETE_STORE_READY: 'ArkData.DeleteStoreReady'
        },
        () => true,
        {
            now: () =>
                control.deleteTimeout && (!control.deleteTarget || control.deleteTarget === deletingId)
                    ? (clock += 31_001)
                    : Date.now()
        }
    );
    const deletionBridge = new HarmonyOSDatabaseKit();
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
        async deleteStore(id: string, options: any) {
            calls.deletes++;
            deletingId = id;
            const name = arkDataStoreName(id, options.path);
            sdkIdentities.set(name, id);
            if (adapter) return deletionBridge.deleteStore(id, options);
            try {
                await sdk.deleteRdbStore({}, { name });
            } catch (error) {
                // This branch stands in for DatabaseKit, including the adapter's SDK error envelope.
                const sdkError = error as Error & { code?: unknown };
                throw new ArkDataBridgeError('store_delete_failed', 'diagnostic', 'Failed to delete store', {
                    storeId: id,
                    operation: 'DeleteStoreStart',
                    path: name,
                    sdkErrorCode: typeof sdkError.code === 'number' ? sdkError.code : null,
                    sdkMessage: sdkError.message
                });
            }
        },
        async openStore(id: string, options: any) {
            calls.acquires++;
            const name = arkDataStoreName(id, options.path);
            sdkIdentities.set(name, id);
            if (adapter) {
                const result = checked(adapter.openStoreStart(id, name, JSON.stringify({ vector: options.vector })));
                if (result.opId) await ready('openStoreReady', result.opId);
                return;
            }
            let record = stores.get(id);
            if (record) record.references++;
            else {
                record = { references: 1, opening: sdk.getRdbStore({}, { name }) };
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
    // This legacy fixture covers Base/Vector/Chunk; BM25 object transactions has its own host fixture.
    const create = FSStorage.prototype._newStorageHolder;
    const dropFullText = FSStorage.prototype._dropFullTextStore;
    FSStorage.prototype._newStorageHolder = function (options) {
        return create.call(this, { ...options, fullText: 'off' });
    };
    FSStorage.prototype._dropFullTextStore = async function () {
        assert.equal(this._fullTextStoreOwned(), false);
    };
    try {
        await run({
            db,
            kit,
            calls,
            control,
            adapter,
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
        FSStorage.prototype._newStorageHolder = create;
        FSStorage.prototype._dropFullTextStore = dropFullText;
        control.openGate?.resolve();
        control.tableGate?.resolve();
        control.closeGate?.resolve();
        control.closeError = null;
        control.deleteError = null;
        control.deleteTimeout = false;
        control.deleteGate?.resolve();
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
    test(`${backend.name}: P3a an old-reference close error carrying 14800011 is not opening corruption`, async (t) => {
        await fixture(backend, async (f) => {
            await f.read();
            const close = f.kit.closeStore.bind(f.kit);
            let timedOut = false;
            t.mock.method(f.kit, 'closeStore', async (...args: any[]) => {
                if (!timedOut) {
                    timedOut = true;
                    throw Object.assign(new Error('isolated bridge close timeout before dispatch'), {
                        code: 'operation_timeout'
                    });
                }
                return close(...args);
            });
            await assert.rejects(f.db.close(), { code: 'operation_timeout' });
            const sdkError = Object.assign(new Error('isolated SDK close failure with corruption code'), {
                code: 14800011
            });
            // The next close attempt fails once, then cleanup successfully releases it.
            let reads = 2;
            Object.defineProperty(f.control, 'closeError', {
                configurable: true,
                get: () => (reads-- > 0 ? sdkError : null),
                set: () => {
                    reads = 0;
                }
            });
            let received: unknown;
            await assert.rejects(f.read(), (error: unknown) => {
                received = error;
                return true;
            });
            const failure = getStorageInitializationFailure(received)!;
            assert.equal(failure.cleanupFailures.length, 0);
            assert.equal(failure.operation, 'close');
            assert.equal(
                initializationRecovery(received),
                null,
                'a successful cleanup does not turn a close failure into corruption'
            );
            assert.equal(f.calls.acquires, 1, 'no replacement store was opened');
            assert.equal(f.references(), 0);
        });
    });

    for (const code of [14800011, 14800010, 'SQLITE_CORRUPT']) {
        test(`${backend.name}: P3a actual lazy acquisition records ArkData source and code ${code}`, async () => {
            await fixture(backend, async (f) => {
                f.control.openError = Object.assign(new Error('isolated SDK open failure'), { code });
                let received: unknown;
                await assert.rejects(f.read(), (error: unknown) => {
                    received = error;
                    return true;
                });
                const failure = getStorageInitializationFailure(received)!;
                assert.equal(failure.indexer, backend.name[0].toUpperCase() + backend.name.slice(1) + 'Indexer');
                assert.equal(failure.backend, 'arkdata');
                assert.equal(failure.cause, received);
                assert.equal(
                    initializationRecovery(received),
                    code === 14800011 ? (backend.name === 'base' ? 'full' : 'semantic') : null
                );
                assert.equal(f.references(), 0);
            });
        });
    }

    test(`${backend.name}: P3a cleanup failure preserves the original corruption and blocks automatic deletion`, async () => {
        await fixture(backend, async (f) => {
            const original = (f.control.tableError = Object.assign(new Error('isolated SDK table failure'), {
                code: 14800011
            }));
            const cleanup = (f.control.closeError = new Error('isolated SDK release failure'));
            await assert.rejects(f.read(), (error: unknown) => error === original);
            const failure = getStorageInitializationFailure(original)!;
            assert.equal(failure.indexer, backend.name[0].toUpperCase() + backend.name.slice(1) + 'Indexer');
            assert.ok(failure.cleanupFailures.some(({ error }) => isCloseFailure(error, cleanup)));
            assert.equal(initializationRecovery(original), null);
            assert.equal(f.references(), 1);
            f.control.closeError = null;
            await f.db.close();
            await f.drain();
            assert.equal(f.references(), 0);
        });
    });

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

for (const code of [14800011, 14800010]) {
    test(`base: P3a actual schema reconciliation preserves and classifies wrapped SDK cause ${code}`, async () => {
        await fixture(backends[0], async (f) => {
            const original = new ArkDataBridgeError('query_failed', 'diagnostic', 'isolated SDK schema query failure', {
                sdkErrorCode: code
            });
            f.control.sqlKit = {
                async execSql() {},
                async executePrepared() {
                    throw original;
                },
                async queryPrepared(_id: string, sql: string) {
                    if (sql.includes('meta_value')) return [];
                    throw original;
                }
            };
            let received: any;
            await assert.rejects(f.read(), (error: unknown) => {
                received = error;
                return true;
            });
            assert.match(received.message, /schema upgrade failed/);
            assert.equal(received.cause, original);
            assert.equal(getStorageInitializationFailure(received)?.cause, original);
            assert.equal(getStorageInitializationFailure(received)?.operation, 'initialize');
            assert.equal(initializationRecovery(received), code === 14800011 ? 'full' : null);
            assert.equal(f.references(), 0);
        });
    });
}

test('P13 raw delete keeps the SDK error and never manufactures a cleanup owner', async () => {
    const { FSStorage } = await import('../../../../../main/applications/filemgr/storage.js');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const available = process.env.ARKDATA_AVAILABLE;
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    process.env.ARKDATA_AVAILABLE = '1';
    try {
        await fixture(backends[1], async (f) => {
            const fss = new FSStorage(fs.mkdtempSync(path.join(profile, 'legacy-drop-')));
            const primary = new ArkDataBridgeError('execute_failed', 'diagnostic', 'isolated SDK delete failure', {
                sdkErrorCode: 14800011
            });
            f.control.deleteError = Object.assign(new Error(primary.message), { code: 14800011 });
            f.control.closeError = new Error('isolated unused close failure');
            let received: any;
            try {
                await assert.rejects(
                    fss.retrieval.rebuildProducts({
                        kind: 'semantic-reset',
                        reason: 'P13 raw SDK delete',
                        dim: 2,
                        mode: 'full'
                    }),
                    (error: any) => {
                        received = error;
                        return (
                            error === f.control.deleteError ||
                            (error.code === 'store_delete_failed' && error.details.sdkErrorCode === 14800011)
                        );
                    }
                );
                assert.equal(getStorageInitializationFailure(received)?.operation, 'delete');
                assert.equal(initializationRecovery(received), null);
                assert.equal(fss._pendingStorageClosures.size, 0);
                assert.equal(fss.storage, null);
                assert.equal(f.references(), 0);
                assert.equal(f.calls.sdkDeletes, 1);
                assert.equal(f.calls.sdkOpens, 0);
                assert.equal(f.calls.sdkCloses, 0);
            } finally {
                f.control.deleteError = null;
                f.control.closeError = null;
                await fss.close();
            }
            assert.equal(fss._pendingStorageClosures.size, 0);
            assert.equal(f.references(), 0);
        });
    } finally {
        Object.defineProperty(process, 'platform', platform);
        if (available === undefined) delete process.env.ARKDATA_AVAILABLE;
        else process.env.ARKDATA_AVAILABLE = available;
    }
});

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
    test(`${backend.name}: an unopened indexer propagates raw SDK failure without acquiring a drop owner`, async () => {
        const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
        const { makeSchema } = await import('../../../../../main/applications/filemgr/storage.js');
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const available = process.env.ARKDATA_AVAILABLE;
        Object.defineProperty(process, 'platform', { value: 'openharmony' });
        process.env.ARKDATA_AVAILABLE = '1';
        try {
            await fixture(backend, async (f) => {
                const storage = new BaseStorage('raw-drop', makeSchema(2, { mode: 'full' }), profile);
                f.control.deleteError = new Error('synthetic raw SDK delete failure');
                const name = backend.name[0].toUpperCase() + backend.name.slice(1) + 'Indexer';
                await assert.rejects(storage.dropIndexers([name] as any));
                assert.equal((storage as any)[backend.name + 'Indexer'].db, null);
                assert.equal(f.references(), 0);
                assert.equal(f.calls.tables, 0);
                assert.equal(f.calls.sdkOpens, 0);
                assert.equal(f.calls.sdkCloses, 0);
                assert.equal(f.calls.sdkDeletes, 1);
                f.control.deleteError = null;
                await assert.rejects(storage.dropIndexers([name] as any), /partially-dropped/);
                assert.equal(f.calls.sdkDeletes, 1);
                const replacement = new BaseStorage('raw-drop-retry', makeSchema(2, { mode: 'full' }), profile);
                await replacement.dropIndexers([name] as any);
                await replacement.close();
                assert.equal(f.calls.sdkDeletes, 2);
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
            await assert.rejects(fss.retrieval._demoteToBaseOnly('isolated'), (error) => error === failure);
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
        deleteStore(id: string) {
            databases.get(id)?.close();
            databases.delete(id);
        },
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

for (const phase of ['delete', 'candidate-init', 'reconcile', 'success', ...(adapterDirectory ? ['pending'] : [])]) {
    test(`R1 F1 actual ArkData base-only semantic reset ${phase} retains the base owner until publication`, async (t) => {
        const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
        const { FSStorage, makeSchema } = await import('../../../../../main/applications/filemgr/storage.js');
        const sql = sqliteSqlFixture();
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const available = process.env.ARKDATA_AVAILABLE;
        Object.defineProperty(process, 'platform', { value: 'openharmony' });
        process.env.ARKDATA_AVAILABLE = '1';
        try {
            await fixture(backends[1], async (f) => {
                f.control.sqlKit = sql.kit;
                const directory = fs.mkdtempSync(path.join(profile, `r1-base-only-${phase}-`));
                const fss = new FSStorage(directory);
                const old = new BaseStorage('filemgr', makeSchema(2, { mode: 'base-only' }), fss._storageDir);
                fss.storage = old;
                fss.mode = 'base-only';
                const file = path.join(directory, 'kept.md');
                const primary = new Error(`isolated ArkData ${phase}`);
                const gate = deferred();
                let failing = true;
                try {
                    await old.initialize();
                    await old.upsert([
                        { item_id: file, item_type: 'file', type: 'file', filename: 'kept.md', ref_count: 1 }
                    ]);
                    await fss.saveScannerState();
                    f.control.deleteTarget = createArkDataStoreId(
                        'arkdata-chunk',
                        toArkDataDbPath(path.join(fss._storageDir, 'chunk-index.db'))
                    );
                    if (phase === 'delete') f.control.deleteError = primary;
                    if (phase === 'pending') {
                        f.control.deleteTimeout = true;
                        f.control.deleteGate = gate;
                    }
                    const initialize = BaseStorage.prototype.initialize;
                    t.mock.method(BaseStorage.prototype, 'initialize', async function () {
                        await initialize.call(this);
                        if (failing && phase === 'candidate-init') throw primary;
                    });
                    const upsert = BaseStorage.prototype.upsert;
                    t.mock.method(BaseStorage.prototype, 'upsert', async function (items: any[], options?: any) {
                        if (failing)
                            assert.equal(
                                fss.storage,
                                old,
                                'The candidate must not displace the live base during reconciliation'
                            );
                        const result = await upsert.call(this, items, options);
                        if (failing && phase === 'reconcile') throw primary;
                        return result;
                    });
                    const reset = (resume = false) =>
                        fss.retrieval.rebuildProducts({
                            kind: 'semantic-reset',
                            reason: 'R1 F1 ArkData',
                            dim: 2,
                            mode: 'full',
                            resume,
                            embeddingState: { embedding_model: 'isolated-model', vec_dim: 2 }
                        });
                    if (phase === 'success') await reset();
                    else {
                        await assert.rejects(reset(), (error: any) => {
                            if (phase === 'pending') return error.code === 'operation_timeout';
                            if (phase === 'delete')
                                return (
                                    error === primary ||
                                    (error.code === 'store_delete_failed' &&
                                        error.details.sdkMessage === primary.message)
                                );
                            return error === primary;
                        });
                        assert.equal(fss.storage, old);
                        assert.equal(fss.mode, 'base-only');
                        assert.equal(f.references(), 1, 'Candidate cleanup must release only its own SDK references');
                        assert.deepEqual(
                            (await fss.searchFilesByKeyword('kept')).map((row) => row.path),
                            [file]
                        );
                        assert.equal(fss.scannerState.semantic_reset_pending, true);
                        assert.equal(fss.scannerState.embedding_generation, 1);
                        if (phase === 'pending') {
                            assert.ok(
                                [...f.adapter.operations.values()].some(
                                    (op: any) =>
                                        op.type === 'deleteStore' &&
                                        op.storeId === f.control.deleteTarget &&
                                        op.state === 'pending'
                                )
                            );
                            assert.equal(f.calls.sdkOpens, 1, 'A timed-out delete must not open a replacement');
                        }
                    }
                    failing = false;
                    f.control.deleteError = null;
                    f.control.deleteTimeout = false;
                    gate.resolve();
                    await f.drain();
                    if (phase !== 'success') await reset(true);
                    assert.equal(fss.mode, 'full');
                    assert.notEqual(fss.storage, old);
                    assert.equal(fss.scannerState.embedding_generation, 1);
                    assert.equal(fss.scannerState.semantic_reset_pending, false);
                    assert.equal(fss._pendingStorageClosures.size, 0);
                    assert.deepEqual(
                        (await fss.searchFilesByKeyword('kept')).map((row) => row.path),
                        [file]
                    );
                } finally {
                    failing = false;
                    f.control.deleteError = null;
                    f.control.deleteTimeout = false;
                    gate.resolve();
                    await f.drain();
                    await fss.close();
                    assert.equal(f.references(), 0);
                }
            });
        } finally {
            sql.close();
            Object.defineProperty(process, 'platform', platform);
            if (available === undefined) delete process.env.ARKDATA_AVAILABLE;
            else process.env.ARKDATA_AVAILABLE = available;
        }
    });
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
                fss.retrieval._probeEmbedding = async () => {
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
                        const block = Buffer.alloc(1024 * 1024, 'x');
                        fs.writeFileSync(oldFile, '');
                        for (let remaining = RAW_TEXT_MAX_FILE_SIZE + 1; remaining > 0; ) {
                            const size = Math.min(remaining, block.length);
                            fs.appendFileSync(oldFile, block.subarray(0, size));
                            remaining -= size;
                        }
                    }
                    const scanners = new Map();
                    for (const entry of entries) {
                        scanners.set(entry.root, await worker._startScanner(entry, entries));
                    }
                    f.control.closeError = new Error('synthetic persistent SDK close failure');
                    await assert.rejects(fss.retrieval._syncMode('embedding config changed'));
                    assert.equal(f.calls.sdkDeletes, 0, 'Failed resource close must prevent every SDK delete');
                    assert.equal(fss.scannerState.embedding_model, 'model-b');
                    assert.equal(fss.scannerState.embedding_generation, 1);
                    assert.equal(fss._pendingStorageClosures.size, 1);
                    assert.equal(fss.isDeferred(), true, 'A closing holder must not be advertised as usable');
                    const acquires = f.calls.acquires;
                    await assert.rejects(fss.retrieval._syncMode('still failed'));
                    assert.equal(
                        f.calls.acquires,
                        acquires,
                        'Persistent close failure must prevent opening new holders'
                    );
                    assert.equal(probes, 1, 'Failed cleanup must run before probing or the already-full shortcut');
                    f.control.closeError = null;
                    if (recovery === 'restart') {
                        const probe = fss.retrieval._probeEmbedding;
                        await worker._stopScanners();
                        await fss.close();
                        fss = new FSStorage(directory);
                        fss.retrieval._probeEmbedding = probe;
                        worker.storage = fss;
                        await fss.initialize();
                        scanners.clear();
                        for (const entry of entries) {
                            scanners.set(entry.root, await worker._startScanner(entry, entries));
                        }
                    }
                    if (recovery === 'sync') {
                        await fss.retrieval._syncMode('recovered');
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
                    const search = await fss.retrieval.searchContent('obsolete content', { topK: 10 });
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
                    // Each oversize fixture is 100 MiB; do not retain all cases until file teardown.
                    fs.rmSync(directory, { recursive: true, force: true });
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

for (const target of ['base', 'vector', 'chunk'])
    for (const code of [14800011, 14800010, 'SQLITE_CORRUPT', undefined])
        test(`P13 actual ArkData ${target} opening ${code ?? 'unknown'} uses only its approved recovery targets`, async (t) => {
            const { FSStorage } = await import('../../../../../main/applications/filemgr/storage.js');
            const { Setting } = await import('../../../../../main/utils/setting.js');
            const sql = sqliteSqlFixture();
            const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
            const available = process.env.ARKDATA_AVAILABLE;
            Object.defineProperty(process, 'platform', { value: 'openharmony' });
            process.env.ARKDATA_AVAILABLE = '1';
            t.mock.method(
                Setting,
                'getInstance',
                () =>
                    ({
                        data: { locale: 'en-US' },
                        getData: () => ({}),
                        getDefaultEmbeddingModelInstance: () => ({ model_name: 'p13-fixture' })
                    }) as any
            );
            try {
                await fixture(backends[0], async (f) => {
                    f.control.sqlKit = sql.kit;
                    const directory = fs.mkdtempSync(path.join(profile, `p13-open-${target}-`));
                    const fss = new FSStorage(directory);
                    fss.retrieval._probeEmbedding = async () => ({
                        ok: true,
                        dim: 2,
                        model_name: 'p13-fixture',
                        requestDim: 2
                    });
                    try {
                        if (target !== 'base') {
                            await fss.initialize({ syncEmbedding: false });
                            await fss.storage!.upsert(
                                [
                                    {
                                        item_id: 'retained-base-row',
                                        item_type: 'file',
                                        filename: 'retained.md',
                                        root_refs: '[]',
                                        ref_count: 1
                                    }
                                ],
                                { indexers: ['BaseIndexer'] }
                            );
                        }
                        f.control.openError = Object.assign(
                            new Error('isolated SDK opening failure'),
                            code === undefined ? {} : { code }
                        );
                        f.control.openErrorStorePrefix = `arkdata-${target}:`;
                        f.control.openErrorOnce = true;
                        const operation =
                            target === 'base'
                                ? fss.initialize({ syncEmbedding: false })
                                : fss.retrieval.prepare({
                                      context: {},
                                      reason: 'P13 actual SDK opening',
                                      role: 'write'
                                  });
                        if (code === 14800011) {
                            await operation;
                            assert.deepEqual(
                                f.calls.deleteIds.map((id: string) => id.split(':')[0]),
                                target === 'base'
                                    ? [
                                          'arkdata-vector',
                                          'arkdata-chunk',
                                          'arkdata-base',
                                          'arkdata-vector',
                                          'arkdata-chunk'
                                      ]
                                    : ['arkdata-vector', 'arkdata-chunk']
                            );
                            assert.equal(fss.scannerState.embedding_generation, 1);
                            assert.equal(fss.scannerState.semantic_reset_pending, false);
                            if (target !== 'base')
                                assert.deepEqual(
                                    (await fss.storage!.search([])).items.map(({ item }: any) => item.item_id),
                                    ['retained-base-row']
                                );
                        } else {
                            await assert.rejects(operation);
                            assert.deepEqual(f.calls.deleteIds, []);
                            assert.equal(fss.scannerState.embedding_generation, 0);
                            if (target !== 'base')
                                assert.deepEqual(
                                    (await fss.storage!.search([])).items.map(({ item }: any) => item.item_id),
                                    ['retained-base-row']
                                );
                        }
                        assert.equal(fss._pendingStorageClosures.size, 0);
                    } finally {
                        await fss.close();
                        sql.close();
                    }
                    assert.equal(f.references(), 0);
                });
            } finally {
                Object.defineProperty(process, 'platform', platform);
                if (available === undefined) delete process.env.ARKDATA_AVAILABLE;
                else process.env.ARKDATA_AVAILABLE = available;
            }
        });

if (adapterDirectory)
    for (const failed of [false, true])
        test(`P13 pending base deletion survives reset failure and error refresh; late SDK failure=${failed}`, async (t) => {
            const { FSStorage } = await import('../../../../../main/applications/filemgr/storage.js');
            const { default: FileManagerWorker } = await import('../../../../../main/applications/filemgr/worker.js');
            const { Setting } = await import('../../../../../main/utils/setting.js');
            const sql = sqliteSqlFixture();
            const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
            const available = process.env.ARKDATA_AVAILABLE;
            Object.defineProperty(process, 'platform', { value: 'openharmony' });
            process.env.ARKDATA_AVAILABLE = '1';
            t.mock.method(
                Setting,
                'getInstance',
                () =>
                    ({
                        data: { locale: 'en-US' },
                        getData: () => ({}),
                        getDefaultEmbeddingModelInstance: () => null
                    }) as any
            );
            try {
                await fixture(backends[0], async (f) => {
                    f.control.sqlKit = sql.kit;
                    const directory = fs.mkdtempSync(path.join(profile, 'p13-pending-reset-'));
                    const root = path.join(directory, 'files');
                    fs.mkdirSync(root);
                    const fss = new FSStorage(directory);
                    const worker = new FileManagerWorker('com.test.p13-pending', directory);
                    worker.storage = fss;
                    worker.config = { entries: [{ root, include_patterns: ['**/*'], exclude_patterns: [] }] };
                    worker.callApp = async () => {};
                    worker.callAppWithResponse = async (name: string, method: string, ...args: any[]) => {
                        assert.equal(name, 'databaseKitCall');
                        return f.kit[method](...args);
                    };
                    const gate = deferred();
                    const target = createArkDataStoreId(
                        'arkdata-base',
                        toArkDataDbPath(path.join(fss._storageDir, 'base-index.db'))
                    );
                    f.control.deleteTarget = target;
                    f.control.deleteGate = gate;
                    f.control.deleteTimeout = true;
                    try {
                        const first = await worker.resetFileSystemStorage();
                        assert.equal(first.status, 'error');
                        assert.equal(worker.status, 'error');
                        const op = [...f.adapter.operations.values()].find(
                            (op: any) => op.type === 'deleteStore' && op.storeId === target
                        ) as any;
                        assert.equal(op.state, 'pending');
                        assert.equal(f.calls.sdkOpens, 0);
                        assert.deepEqual(
                            f.calls.deleteIds.map((id: string) => id.split(':')[0]),
                            ['arkdata-vector', 'arkdata-chunk', 'arkdata-base']
                        );
                        const refresh = await worker.forceRefreshScan();
                        assert.equal(refresh.status, 'error');
                        assert.equal(worker.status, 'error');
                        assert.equal(f.calls.sdkOpens, 0, 'Pending target open is rejected before SDK creation');
                        assert.equal(f.calls.deleteIds.length, 3, 'Refresh must never reissue SDK deletion');
                        assert.equal((await worker.resetFileSystemStorage()).status, 'error');
                        assert.equal(f.calls.deleteIds.filter((id: string) => id === target).length, 1);
                        assert.equal(f.calls.sdkOpens, 0);
                        assert.equal(op.state, 'pending');
                        if (failed)
                            f.control.deleteError = Object.assign(new Error('isolated late deletion failure'), {
                                code: 14800011
                            });
                        gate.resolve();
                        await tick();
                        assert.equal(op.state, failed ? 'error' : 'success');
                        assert.equal(first.status, 'error');
                        f.control.deleteError = null;
                        f.control.deleteTimeout = false;
                        const retry = await worker.resetFileSystemStorage();
                        assert.equal(retry.status, 'ok');
                        await worker.taskQueue.onIdle();
                        assert.equal(f.calls.deleteIds.filter((id: string) => id === target).length, 2);
                        assert.notEqual(worker.status, 'error');
                        assert.equal(worker._initError, null);
                        assert.equal(worker.storage!.mode, 'base-only');
                        assert.ok(worker.storage!.scannerState.roots[root]);
                    } finally {
                        gate.resolve();
                        f.control.deleteError = null;
                        f.control.deleteTimeout = false;
                        await worker.finalize();
                        sql.close();
                    }
                    assert.equal(f.references(), 0);
                });
            } finally {
                Object.defineProperty(process, 'platform', platform);
                if (available === undefined) delete process.env.ARKDATA_AVAILABLE;
                else process.env.ARKDATA_AVAILABLE = available;
            }
        });

for (const mode of ['full', 'base-only', 'none'])
    for (const target of ['vector', 'chunk', 'base'])
        test(`P13 ${mode} reset aborts at SDK ${target} deletion failure without reopening`, async (t) => {
            const { FSStorage } = await import('../../../../../main/applications/filemgr/storage.js');
            const { default: FileManagerWorker } = await import('../../../../../main/applications/filemgr/worker.js');
            const { Setting } = await import('../../../../../main/utils/setting.js');
            const sql = sqliteSqlFixture();
            const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
            const available = process.env.ARKDATA_AVAILABLE;
            Object.defineProperty(process, 'platform', { value: 'openharmony' });
            process.env.ARKDATA_AVAILABLE = '1';
            t.mock.method(
                Setting,
                'getInstance',
                () =>
                    ({
                        data: { locale: 'en-US' },
                        getData: () => ({}),
                        getDefaultEmbeddingModelInstance: () => (mode === 'full' ? { model_name: 'p13-fixture' } : null)
                    }) as any
            );
            try {
                await fixture(backends[0], async (f) => {
                    f.control.sqlKit = sql.kit;
                    const directory = fs.mkdtempSync(path.join(profile, `p13-reset-failure-${target}-`));
                    const root = path.join(directory, 'files');
                    fs.mkdirSync(root);
                    const fss = new FSStorage(directory);
                    fss.retrieval._probeEmbedding = async () => ({
                        ok: true,
                        dim: 2,
                        model_name: 'p13-fixture',
                        requestDim: 2
                    });
                    const worker = new FileManagerWorker('com.test.p13-reset-failure', directory);
                    worker.callApp = async () => {};
                    worker.callAppWithResponse = async (name: string, method: string, ...args: any[]) => {
                        assert.equal(name, 'databaseKitCall');
                        return f.kit[method](...args);
                    };
                    worker.config = { entries: [{ root, include_patterns: ['**/*'], exclude_patterns: [] }] };
                    try {
                        if (mode !== 'none') {
                            await fss.initialize();
                            assert.equal(fss.mode, mode);
                            worker.storage = fss;
                        }
                        const before = f.calls.sdkOpens;
                        f.control.deleteTarget = createArkDataStoreId(
                            `arkdata-${target}`,
                            toArkDataDbPath(path.join(fss._storageDir, `${target}-index.db`))
                        );
                        f.control.deleteError = Object.assign(new Error('isolated SDK raw deletion failure'), {
                            code: 14800011
                        });
                        const result = await worker.resetFileSystemStorage();
                        assert.equal(result.status, 'error');
                        assert.equal(worker.status, 'error');
                        assert.equal(worker._initError.code, 'store_delete_failed');
                        assert.equal(worker._initError.category, 'diagnostic');
                        assert.equal(worker._initError.details.sdkErrorCode, 14800011);
                        assert.equal(worker._initError.details.storeId, f.control.deleteTarget);
                        assert.equal(initializationRecovery(worker._initError), null);
                        assert.deepEqual(
                            f.calls.deleteIds.map((id: string) => id.split(':')[0]),
                            ['vector', 'chunk', 'base']
                                .slice(0, ['vector', 'chunk', 'base'].indexOf(target) + 1)
                                .map((kind) => `arkdata-${kind}`)
                        );
                        assert.equal(f.calls.sdkOpens, before);
                        assert.equal(f.references(), 0);
                        assert.equal(worker.scanners.size, 0);
                        await worker.embeddingConfigChanged();
                        await worker.applicationConfigChanged(worker.config);
                        await worker.runSequentially(() => worker._restartScanners());
                        assert.equal(worker.status, 'error');
                        assert.equal(
                            f.calls.sdkOpens,
                            before,
                            'Automatic entries cannot reopen after a raw reset failure'
                        );
                    } finally {
                        f.control.deleteError = null;
                        await worker.finalize();
                        await fss.close();
                        sql.close();
                    }
                });
            } finally {
                Object.defineProperty(process, 'platform', platform);
                if (available === undefined) delete process.env.ARKDATA_AVAILABLE;
                else process.env.ARKDATA_AVAILABLE = available;
            }
        });
