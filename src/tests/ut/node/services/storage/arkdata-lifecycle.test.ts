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

