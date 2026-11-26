import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import {
    getLogDirectory,
    getOpendeskDirectory,
    setCustomOpendeskDirectory
} from '../../../../../main/utils/setting.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { serializeAppError } from '../../../../../../packages/app-sdk/src/index.js';
import { stripTypeScriptTypes } from 'node:module';
import { setArkdataDatabaseKit } from '../../../../../main/services/storage/arkdata-bridge.js';
import { ArkDataBridgeError } from '../../../../../platforms/bridges/common.js';
import { BaseIndexDBArkdata } from '../../../../../main/services/storage/base-index-db-arkdata.js';
import { VectorIndexDBArkdata } from '../../../../../main/services/storage/vector-index-db-arkdata.js';
import { ChunkIndexDBArkdata } from '../../../../../main/services/storage/chunk-index-db-arkdata.js';
const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'arkdata-cross-repo-'));
setCustomOpendeskDirectory(profileDirectory);
assert.equal(getOpendeskDirectory(), profileDirectory);
assert.equal(getLogDirectory(), path.join(profileDirectory, 'logs'));
console.log(JSON.stringify({ profile: profileDirectory, logs: getLogDirectory() }));
after(() => fs.rmSync(profileDirectory, { recursive: true, force: true }));
const app = fileURLToPath(new URL('../../../../../../', import.meta.url)).replace(/\/$/, '');
const adapterRoot = process.env.OPENDESK_ARKDATA_ADAPTER_DIR;
if (adapterRoot) {
    const strip = (source: string) =>
        stripTypeScriptTypes(source.replace(/^import[\s\S]*?;\s*/gm, ''), { mode: 'transform' }).replace(
            /^export /gm,
            ''
        );
    const adapterSource =
        fs.readFileSync(adapterRoot + '/ArkDataAdapterContract.ets', 'utf8') +
        '\n' +
        fs
            .readFileSync(adapterRoot + '/ArkDataAdapter.ets', 'utf8')
            .replace('@injectable()', '')
            .replace('@inject(MODULE_TYPE.Context) ', '');
    const loadAdapter = new Function(
        'relationalStore',
        'BaseAdapter',
        'LogUtil',
        strip(adapterSource) + '\nreturn ArkDataAdapter;'
    );
    const bridgeSource = fs.readFileSync(app + '/src/platforms/bridges/harmonyos/database.ts', 'utf8');
    const loadBridge = new Function(
        'createHash',
        'logger',
        'ArkDataBridgeError',
        'executePreparedManyBatchedWith',
        'callArkTS',
        'EtsBridgeMethods',
        'hasArkTSAdapter',
        'Date',
        strip(bridgeSource) + '\nreturn HarmonyOSDatabaseKit;'
    );
    const routes = {
        'ArkData.DeleteStoreStart': 'deleteStoreStart',
        'ArkData.DeleteStoreReady': 'deleteStoreReady',
        'ArkData.OpenStoreStart': 'openStoreStart',
        'ArkData.OpenStoreReady': 'openStoreReady',
        'ArkData.CloseStoreStart': 'closeStoreStart',
        'ArkData.CloseStoreReady': 'closeStoreReady',
        'ArkData.CloseStoreForceStart': 'closeStoreForceStart',
        'ArkData.CloseStoreForceReady': 'closeStoreForceReady'
    };
    const methods = Object.fromEntries(
        Object.keys(routes).map((name) => [
            name
                .replace('ArkData.', 'ARKDATA_')
                .replace(/([a-z])([A-Z])/g, '$1_$2')
                .toUpperCase(),
            name
        ])
    );
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((yes) => (resolve = yes));
        return { promise, resolve };
    };
    const schema = {
        columns: { item_id: { type: 'TEXT', nullable: false }, item_type: { type: 'TEXT', nullable: false } },
        needIndexers: {}
    };
    const backends = [
        ['base', (file: string) => new BaseIndexDBArkdata(file, schema as any)],
        ['vector', (file: string) => new VectorIndexDBArkdata(file, 2)],
        ['chunk', (file: string) => new ChunkIndexDBArkdata(file, 2)]
    ] as const;
    for (const [name, create] of backends)
        for (const scenario of ['late-open', 'late-close', 'late-close-aba']) {
            test(`production bridge ${name}: ${scenario} preserves the correct owners`, async () => {
                const open = deferred(),
                    close = deferred();
                let gateOpen = scenario === 'late-open',
                    gateClose = false,
                    timeout = false,
                    time = 0;
                let sdkCloses = 0;
                const sdk = {
                    SecurityLevel: { S1: 1, S2: 2, S3: 3, S4: 4 },
                    getRdbStore: async () => {
                        if (gateOpen) await open.promise;
                        return {
                            close: async () => {
                                sdkCloses++;
                                if (gateClose) await close.promise;
                            }
                        };
                    }
                };
                const Adapter = loadAdapter(sdk, class {}, { info() {}, warn() {}, error() {} });
                const adapter = new Adapter({});
                const Clock = { now: () => (timeout ? (time += 31001) : Date.now()) };
                const call = async (method: string, _type: string, args: string[]) =>
                    adapter[(routes as any)[method]](...args);
                const Bridge = loadBridge(
                    createHash,
                    { warn() {} },
                    ArkDataBridgeError,
                    undefined,
                    call,
                    methods,
                    () => true,
                    Clock
                );
                const kit = new Bridge();
                let db: any;
                kit.execSql = async () => {};
                kit.queryPrepared = async (_id: string, sql: string) =>
                    sql.includes('meta_value') && name === 'base'
                        ? [{ meta_value: db.computeSchemaHash() }]
                        : sql.includes('GROUP BY')
                          ? []
                          : [{ count: 0 }];
                const previous = setArkdataDatabaseKit(kit);
                const file = path.join(profileDirectory, `filemgr-timeout-${name}-${scenario}.db`);
                db = create(file);
                let other: any;
                const refs = () =>
                    [...adapter.stores.values()].reduce((sum: number, rec: any) => sum + rec.refCount, 0);
                try {
                    if (scenario === 'late-open') {
                        timeout = true;
                        await assert.rejects(db.count(), (e: any) => e.code === 'operation_timeout');
                        timeout = false;
                        gateOpen = false;
                        open.resolve();
                        await tick();
                        await db.close();
                        console.log(JSON.stringify({ name, scenario, refs: refs(), sdkCloses }));
                        assert.equal(refs(), 0, 'A late successful open must be released after the owner exits');
                    } else {
                        await db.count();
                        gateClose = true;
                        timeout = true;
                        await assert.rejects(db.close(), (e: any) => e.code === 'operation_timeout');
                        timeout = false;
                        gateClose = false;
                        close.resolve();
                        await tick();
                        if (scenario === 'late-close') {
                            console.log(JSON.stringify({ name, scenario, refs: refs(), sdkCloses }));
                            await assert.doesNotReject(
                                db.close(),
                                'An already completed close must settle its original owner'
                            );
                        } else {
                            other = create(file);
                            await other.count();
                            assert.equal(refs(), 1);
                            await db.close();
                            console.log(JSON.stringify({ name, scenario, refs: refs(), sdkCloses }));
                            assert.equal(refs(), 1, 'Retrying the old close must not release a new generation owner');
                        }
                    }
                } finally {
                    timeout = false;
                    gateOpen = false;
                    gateClose = false;
                    open.resolve();
                    close.resolve();
                    await Promise.allSettled([db.close(), other?.close()]);
                    for (const id of adapter.stores.keys()) {
                        adapter.closeStoreForceStart(id);
                    }
                    await tick();
                    setArkdataDatabaseKit(previous);
                }
            });
        }

    for (const [name] of backends)
        for (const scenario of ['rpc-open-timeout', 'rpc-close-timeout', 'rpc-close-aba']) {
            test(`worker RPC ${name}: ${scenario} retains one acquisition identity`, async () => {
                const open = deferred(),
                    close = deferred();
                let gateOpen = scenario === 'rpc-open-timeout',
                    gateClose = false;
                let sdkOpens = 0,
                    sdkCloses = 0;
                const sdk = {
                    SecurityLevel: { S1: 1, S2: 2, S3: 3, S4: 4 },
                    getRdbStore: async () => {
                        sdkOpens++;
                        if (gateOpen) await open.promise;
                        return {
                            close: async () => {
                                sdkCloses++;
                                if (gateClose) await close.promise;
                            }
                        };
                    }
                };
                const Adapter = loadAdapter(sdk, class {}, { info() {}, warn() {}, error() {} });
                const adapter = new Adapter({});
                const call = async (method: string, _type: string, args: string[]) =>
                    adapter[(routes as any)[method]](...args);
                const Bridge = loadBridge(
                    createHash,
                    { warn() {} },
                    ArkDataBridgeError,
                    undefined,
                    call,
                    methods,
                    () => true,
                    Date
                );
                const kit = new Bridge();
                kit.execSql = async () => {};
                kit.queryPrepared = async (_id: string, sql: string) => {
                    if (sql.includes('meta_value') && name === 'base')
                        return [
                            {
                                meta_value: createHash('sha256')
                                    .update(
                                        JSON.stringify([
                                            ['item_id', 'item_id TEXT PRIMARY KEY'],
                                            ['item_type', 'item_type TEXT NOT NULL']
                                        ])
                                    )
                                    .digest('hex')
                            }
                        ];
                    if (sql.includes('GROUP BY')) return [];
                    return [{ count: 0 }];
                };
                const profile = fs.mkdtempSync(path.join(profileDirectory, 'arkdata-rpc-profile-'));
                const worker = new Worker(new URL('./fixtures/arkdata-rpc-worker.ts', import.meta.url), {
                    // tsx 的自动 --import 注册仅在主线程执行；Worker 必须显式注册 ESM hooks。
                    execArgv: [
                        '--import',
                        'data:text/javascript,' +
                            encodeURIComponent(
                                `import { register } from '${import.meta.resolve('tsx/esm/api')}'; register();`
                            )
                    ],
                    workerData: { name, scenario, profile, paths: { opendeskDirectory: profile } }
                });
                const errors: unknown[] = [],
                    requests: any[] = [];
                const refs = () =>
                    [...adapter.stores.values()].reduce((sum: number, rec: any) => sum + rec.refCount, 0);
                const completed = new Promise<any>((resolve, reject) => {
                    worker.on('error', reject);
                    worker.on('message', (message) => {
                        if (message.type === 'callApp') {
                            const [method, ...args] = message.args;
                            requests.push({ method, args });
                            if (method === 'closeStore' && scenario !== 'rpc-open-timeout') gateClose = true;
                            Promise.resolve(kit[method](...args))
                                .then(
                                    (data) =>
                                        worker.postMessage({
                                            type: 'response',
                                            id: message.requestId,
                                            status: 'ok',
                                            data
                                        }),
                                    (error) =>
                                        worker.postMessage({
                                            type: 'response',
                                            id: message.requestId,
                                            status: 'error',
                                            ...serializeAppError(error)
                                        })
                                )
                                .catch((error) => errors.push(error));
                        } else if (message.type === 'timeoutObserved') {
                            gateOpen = false;
                            gateClose = false;
                            open.resolve();
                            close.resolve();
                        } else if (message.type === 'done') resolve(message);
                        else if (message.type === 'failure') reject(new Error(message.message));
                    });
                });
                try {
                    const result = await completed;
                    assert.equal(result.code, 'rpc_timeout');
                    assert.equal(refs(), 0);
                    assert.ok(sdkOpens >= 1);
                    assert.equal(sdkCloses, sdkOpens);
                    const opens = requests.filter(({ method }) => method === 'openStore');
                    const releases = requests.filter(({ method }) => method === 'closeStore');
                    assert.ok(opens.every(({ args }) => typeof args[1]?.sessionId === 'string'));
                    assert.ok(
                        releases.every(({ args }) => opens.some((open) => open.args[1].sessionId === args[1].sessionId))
                    );
                    assert.equal(errors.length, 0);
                } finally {
                    gateOpen = false;
                    gateClose = false;
                    open.resolve();
                    close.resolve();
                    await worker.terminate();
                    fs.rmSync(profile, { recursive: true, force: true });
                    for (const id of adapter.stores.keys()) adapter.closeStoreForceStart(id);
                    await tick();
                }
            });
        }

    for (const scenario of [
        'pending-open-timeout',
        'pending-open-bad-ready',
        'pending-open-bad-start',
        'pending-close-timeout',
        'failed-force-close'
    ]) {
        test(`production force close ${scenario} preserves SDK ownership and revokes old sessions`, async () => {
            const openingGate = deferred(),
                closingGate = deferred();
            const gateOpen = scenario.startsWith('pending-open');
            let timeout = false,
                time = 0,
                badResponse = '',
                failClose = scenario === 'failed-force-close';
            let sdkOpens = 0,
                sdkCloses = 0,
                forceStarts = 0,
                forceOpId = '';
            const sdk = {
                SecurityLevel: { S1: 1, S2: 2, S3: 3, S4: 4 },
                getRdbStore: async () => {
                    sdkOpens++;
                    if (gateOpen) await openingGate.promise;
                    return {
                        close: async () => {
                            sdkCloses++;
                            if (failClose) throw new Error('isolated force close failure');
                            await closingGate.promise;
                        }
                    };
                },
                deleteRdbStore: async () => {}
            };
            const Adapter = loadAdapter(sdk, class {}, { info() {}, warn() {}, error() {} }),
                adapter = new Adapter({});
            const call = async (method: string, _type: string, args: string[]) => {
                const response = adapter[(routes as any)[method]](...args);
                if (method === 'ArkData.CloseStoreForceStart') {
                    forceStarts++;
                    forceOpId = JSON.parse(response).opId;
                }
                return method === badResponse ? '{' : response;
            };
            const Clock = { now: () => (timeout ? (time += 31001) : Date.now()) };
            const Bridge = loadBridge(
                    createHash,
                    { warn() {} },
                    ArkDataBridgeError,
                    undefined,
                    call,
                    methods,
                    () => true,
                    Clock
                ),
                kit = new Bridge();
            const options = {
                path: path.join(profileDirectory, `force-${scenario}.db`),
                vector: true,
                sessionId: 'old'
            };
            const acquired = kit.openStore('force-fixture', options).then(
                () => null,
                (error: any) => error
            );
            await tick();
            if (!gateOpen) assert.equal(await acquired, null);
            try {
                timeout = scenario.endsWith('timeout');
                if (scenario.endsWith('bad-ready')) badResponse = 'ArkData.CloseStoreForceReady';
                if (scenario.endsWith('bad-start')) badResponse = 'ArkData.CloseStoreForceStart';
                const expected = failClose
                    ? 'store_close_failed'
                    : timeout
                      ? 'operation_timeout'
                      : 'envelope_parse_failed';
                await assert.rejects(kit.closeStore('force-fixture', { force: true }), (e: any) => e.code === expected);
                timeout = false;
                badResponse = '';
                await acquired;
                assert.equal(forceStarts, 1);
                assert.equal(
                    adapter.stores.has('force-fixture'),
                    true,
                    'unconfirmed release must retain the SDK owner'
                );
                assert.equal(adapter.stores.get('force-fixture').refCount, 0);
                assert.equal(
                    JSON.parse(adapter.closeStoreForceReady(forceOpId)).state,
                    failClose ? 'error' : 'pending'
                );
                adapter.gcTerminalOperations(Date.now() + 10 * 60 * 1000);
                await assert.rejects(
                    kit.openStore('force-fixture', options),
                    (e: any) => e.code === (scenario.endsWith('bad-start') ? 'store_force_closed' : 'store_id_conflict')
                );
                await assert.rejects(
                    kit.openStore('force-fixture', { ...options, sessionId: 'during-force' }),
                    (e: any) => e.code === 'store_closing'
                );
                await assert.rejects(
                    kit.deleteStore('force-fixture', options),
                    (e: any) => e.code === 'store_busy_with_pending_ops'
                );
                assert.equal(sdkOpens, 1);
                openingGate.resolve();
                await tick();
                if (gateOpen) assert.equal(sdkCloses, 1);
                closingGate.resolve();
                await tick();
                if (failClose) {
                    failClose = false;
                    await kit.closeStore('force-fixture', { force: true });
                } else {
                    assert.equal(JSON.parse(adapter.closeStoreForceReady(forceOpId)).state, 'success');
                }
                await kit.openStore('force-fixture', { ...options, sessionId: 'after-force' });
                await kit.closeStore('force-fixture', { sessionId: 'after-force' });
                assert.equal(sdkOpens, 2);
                assert.equal(sdkCloses, scenario === 'failed-force-close' ? 3 : 2);
            } finally {
                timeout = false;
                badResponse = '';
                failClose = false;
                openingGate.resolve();
                closingGate.resolve();
                await acquired;
                for (const id of adapter.stores.keys()) adapter.closeStoreForceStart(id);
                await tick();
            }
        });
    }

    for (const start of [{ ok: true }, { ok: true, opId: '' }, { ok: true, opId: 17 }]) {
        test(`production force close malformed Start ${JSON.stringify(start)} keeps the previous owner releasable`, async () => {
            let sdkOpens = 0,
                sdkCloses = 0;
            const sdk = {
                SecurityLevel: { S1: 1, S2: 2, S3: 3, S4: 4 },
                getRdbStore: async () => {
                    sdkOpens++;
                    return {
                        close: async () => {
                            sdkCloses++;
                        }
                    };
                }
            };
            const Adapter = loadAdapter(sdk, class {}, { info() {}, warn() {}, error() {} }),
                adapter = new Adapter({});
            const call = async (method: string, _type: string, args: string[]) =>
                method === 'ArkData.CloseStoreForceStart'
                    ? JSON.stringify(start)
                    : adapter[(routes as any)[method]](...args);
            const Bridge = loadBridge(
                    createHash,
                    { warn() {} },
                    ArkDataBridgeError,
                    undefined,
                    call,
                    methods,
                    () => true,
                    Date
                ),
                kit = new Bridge();
            const options = {
                path: path.join(profileDirectory, 'malformed-force.db'),
                vector: true,
                sessionId: 'original'
            };
            try {
                await kit.openStore('malformed-force', options);
                await assert.rejects(
                    kit.closeStore('malformed-force', { force: true }),
                    (e: any) => e.code === 'param_op_id_invalid'
                );
                await kit.openStore('malformed-force', options);
                assert.equal(sdkOpens, 1, 'a replay must not acquire a second reference');
                await kit.closeStore('malformed-force', { sessionId: 'original' });
                assert.equal(sdkCloses, 1, 'an unconfirmed force Start must not consume normal release responsibility');
                assert.equal(adapter.stores.size, 0);
            } finally {
                for (const id of adapter.stores.keys()) adapter.closeStoreForceStart(id);
                await tick();
            }
        });
    }

    for (const scenario of ['release-before-open', 'immediate-release', 'terminal-cache-after-gc']) {
        test(`production bridge session: ${scenario}`, async () => {
            let sdkOpens = 0,
                sdkCloses = 0;
            const sdk = {
                SecurityLevel: { S1: 1, S2: 2, S3: 3, S4: 4 },
                getRdbStore: async () => {
                    sdkOpens++;
                    return {
                        close: async () => {
                            sdkCloses++;
                        }
                    };
                }
            };
            const Adapter = loadAdapter(sdk, class {}, { info() {}, warn() {}, error() {} }),
                adapter = new Adapter({});
            const call = async (method: string, _type: string, args: string[]) =>
                adapter[(routes as any)[method]](...args);
            const Bridge = loadBridge(
                    createHash,
                    { warn() {} },
                    ArkDataBridgeError,
                    undefined,
                    call,
                    methods,
                    () => true,
                    Date
                ),
                kit = new Bridge();
            const options = {
                path: path.join(profileDirectory, `session-${scenario}.db`),
                vector: true,
                sessionId: 'one-acquisition'
            };
            try {
                if (scenario === 'release-before-open') {
                    await kit.closeStore('session-fixture', options);
                    await assert.rejects(
                        kit.openStore('session-fixture', options),
                        (e: any) => e.code === 'store_id_conflict'
                    );
                    assert.equal(sdkOpens, 0);
                } else if (scenario === 'immediate-release') {
                    await Promise.all([
                        kit.openStore('session-fixture', options),
                        kit.closeStore('session-fixture', options)
                    ]);
                    assert.equal(adapter.stores.size, 0);
                    assert.equal(sdkCloses, 1);
                } else {
                    await kit.openStore('session-fixture', options);
                    await kit.closeStore('session-fixture', options);
                    // Same observable result as ArkTS terminal TTL eviction; old holder retries
                    // use the cached main-process outcome and never query the removed opId.
                    adapter.operations.clear();
                    await kit.openStore('session-fixture', { ...options, sessionId: 'new-acquisition' });
                    await kit.closeStore('session-fixture', options);
                    assert.equal([...adapter.stores.values()][0].refCount, 1);
                    await kit.closeStore('session-fixture', { sessionId: 'new-acquisition' });
                    assert.equal(adapter.stores.size, 0);
                    assert.equal(sdkCloses, 2);
                }
            } finally {
                for (const id of adapter.stores.keys()) adapter.closeStoreForceStart(id);
                await tick();
            }
        });
    }
} else {
    test.skip('production ArkTS timeout and RPC integration requires OPENDESK_ARKDATA_ADAPTER_DIR', () => {});
}
