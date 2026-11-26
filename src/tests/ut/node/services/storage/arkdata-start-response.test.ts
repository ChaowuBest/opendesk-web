import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { setArkdataDatabaseKit } from '../../../../../main/services/storage/arkdata-bridge.js';
import { dropBaseIndexStoreArkdata } from '../../../../../main/services/storage/base-index-db-arkdata.js';
import { dropVectorIndexStoreArkdata } from '../../../../../main/services/storage/vector-index-db-arkdata.js';
import { dropChunkIndexStoreArkdata } from '../../../../../main/services/storage/chunk-index-db-arkdata.js';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../../../', import.meta.url)).replace(/\/$/, '');
const adapterRoot = process.env.OPENDESK_ARKDATA_ADAPTER_DIR;
if (adapterRoot) {
    const strip = (source) =>
        stripTypeScriptTypes(source.replace(/^import[\s\S]*?;\s*/gm, ''), { mode: 'transform' }).replace(
            /^export /gm,
            ''
        );
    const common = strip(fs.readFileSync(root + '/src/platforms/bridges/common.ts', 'utf8'));
    const BridgeError = new Function(common + '\nreturn ArkDataBridgeError;')();
    const adapterSource =
        fs.readFileSync(adapterRoot + '/ArkDataAdapterContract.ets', 'utf8') +
        '\n' +
        fs
            .readFileSync(adapterRoot + '/ArkDataAdapter.ets', 'utf8')
            .replace('@injectable()', '')
            .replace('@inject(MODULE_TYPE.Context) ', '');
    const Adapter = new Function(
        'relationalStore',
        'BaseAdapter',
        'LogUtil',
        strip(adapterSource) + '\nreturn ArkDataAdapter;'
    );
    const bridgeSource = fs.readFileSync(root + '/src/platforms/bridges/harmonyos/database.ts', 'utf8');
    const Bridge = new Function(
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
    const bindingSource = fs.readFileSync(adapterRoot + '/../jsbindings/ArkDataAdapterBind.ets', 'utf8');
    const Binding = new Function(
        'JsBindingUtils',
        'Inject',
        'ArkDataAdapter',
        strip(bindingSource) + '\nreturn ArkDataAdapterBind;'
    );
    const routes = {
        'ArkData.DeleteStoreStart': 'deleteStoreStart',
        'ArkData.DeleteStoreReady': 'deleteStoreReady',
        'ArkData.OpenStoreStart': 'openStoreStart',
        'ArkData.OpenStoreReady': 'openStoreReady',
        'ArkData.CloseStoreStart': 'closeStoreStart',
        'ArkData.CloseStoreReady': 'closeStoreReady'
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
    for (const scenario of [
        'open-response-lost',
        'close-response-lost',
        'close-response-lost-new-owner',
        'open-empty-op-id',
        'legacy-empty-options',
        'delete-identities',
        'delete-sdk-failure',
        'delete-timeout',
        'delete-bad-start',
        'delete-bad-ready',
        'delete-empty-op-id',
        'delete-unknown-ready'
    ])
        test(scenario, async () => {
            let sdkOpens = 0,
                sdkCloses = 0,
                corrupt = null;
            let finishDelete!: () => void;
            const deleteGate = new Promise<void>((resolve) => {
                finishDelete = resolve;
            });
            let timeout = false,
                clock = 0,
                sdkDeletes = 0;
            const configs = { opened: [] as any[], deleted: [] as any[] };
            const context = {};
            const requests: string[] = [];
            const sdk = {
                SecurityLevel: { S1: 1, S2: 2, S3: 3, S4: 4 },
                deleteRdbStore: async (ctx: any, config: any) => {
                    assert.equal(ctx, context);
                    sdkDeletes++;
                    configs.deleted.push(structuredClone(config));
                    if (scenario === 'delete-sdk-failure')
                        throw Object.assign(new Error('isolated SDK deletion failure'), { code: 14800011 });
                    if (scenario.startsWith('delete-') && scenario !== 'delete-identities') await deleteGate;
                },
                getRdbStore: async (ctx: any, config: any) => {
                    assert.equal(ctx, context);
                    configs.opened.push(structuredClone(config));
                    sdkOpens++;
                    return {
                        close: async () => {
                            sdkCloses++;
                        }
                    };
                }
            };
            const ActualAdapter = Adapter(sdk, class {}, { info() {}, warn() {}, error() {} }),
                adapter = new ActualAdapter(context);
            const bindings = new Map();
            Binding(
                { bindFunction: (name, fn) => bindings.set(name, fn) },
                { getOrCreate: () => adapter },
                ActualAdapter
            ).bind();
            const call = async (name, _type, args) => {
                requests.push(name);
                const response = bindings.get(name)(...args);
                if (name === corrupt) {
                    corrupt = null;
                    return scenario.endsWith('empty-op-id')
                        ? JSON.stringify({ ...JSON.parse(response), opId: '' })
                        : scenario === 'delete-unknown-ready'
                          ? JSON.stringify({ ok: true, state: 'unknown' })
                          : '{lost-response';
                }
                return response;
            };
            const ActualBridge = Bridge(createHash, { warn() {} }, BridgeError, undefined, call, methods, () => true, {
                    now: () => (timeout ? (clock += 31_001) : Date.now())
                }),
                kit = new ActualBridge();
            const options = (id) => ({
                sessionId: id,
                path: path.join(process.env.OPENDESK_CONFIG_DIRECTORY!, 'isolated-start-response.db'),
                vector: true
            });
            const previousKit = setArkdataDatabaseKit(kit);
            const refs = () => [...adapter.stores.values()].reduce((n, s) => n + s.refCount, 0);
            try {
                if (scenario === 'delete-identities') {
                    assert.ok(bindings.has('ArkData.DeleteStoreStart'));
                    assert.ok(bindings.has('ArkData.DeleteStoreReady'));
                    for (const [kind, drop] of [
                        ['base', dropBaseIndexStoreArkdata],
                        ['vector', dropVectorIndexStoreArkdata],
                        ['chunk', dropChunkIndexStoreArkdata]
                    ] as const) {
                        for (const directory of ['one', 'two']) {
                            const file = path.join(process.env.OPENDESK_CONFIG_DIRECTORY!, directory, 'same-name.db');
                            const formal = file.replace(/\.db$/, '-arkdata-database.db');
                            const id =
                                `arkdata-${kind}:` + createHash('sha1').update(formal).digest('hex').slice(0, 16);
                            const expectedName =
                                id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48) +
                                '-' +
                                createHash('sha1')
                                    .update(id + '\0' + formal)
                                    .digest('hex')
                                    .slice(0, 24) +
                                '.db';
                            await kit.openStore(id, { path: formal, vector: true });
                            await kit.closeStore(id);
                            const opens = sdkOpens;
                            await drop(file);
                            assert.equal(sdkOpens, opens, 'Raw deletion cannot acquire a connection');
                            assert.equal(configs.deleted.at(-1).name, expectedName);
                            assert.deepEqual(configs.deleted.at(-1), configs.opened.at(-1));
                        }
                    }
                    assert.equal(new Set(configs.deleted.map((config) => config.name)).size, 6);
                    assert.equal(sdkDeletes, 6);
                    assert.equal(sdkOpens, 6);
                    assert.equal(sdkCloses, 6);
                } else if (scenario.startsWith('delete-')) {
                    const opts = { path: options('unused').path, vector: true };
                    if (scenario === 'delete-timeout') timeout = true;
                    if (['delete-bad-start', 'delete-empty-op-id'].includes(scenario))
                        corrupt = 'ArkData.DeleteStoreStart';
                    if (['delete-bad-ready', 'delete-unknown-ready'].includes(scenario))
                        corrupt = 'ArkData.DeleteStoreReady';
                    const expectedCode =
                        scenario === 'delete-sdk-failure'
                            ? 'store_delete_failed'
                            : scenario === 'delete-timeout'
                              ? 'operation_timeout'
                              : scenario === 'delete-empty-op-id'
                                ? 'payload_shape_invalid'
                                : scenario === 'delete-unknown-ready'
                                  ? 'unknown_error'
                                  : 'envelope_parse_failed';
                    let rejected: any;
                    await assert.rejects(kit.deleteStore('store', opts), (error: any) => {
                        rejected = error;
                        return error.code === expectedCode;
                    });
                    timeout = false;
                    assert.equal(sdkDeletes, 1);
                    assert.equal(sdkOpens, 0);
                    assert.equal(sdkCloses, 0);
                    assert.equal(requests.filter((name) => name === 'ArkData.DeleteStoreStart').length, 1);
                    const op = [...adapter.operations.values()].find((op: any) => op.type === 'deleteStore') as any;
                    if (scenario === 'delete-sdk-failure') {
                        assert.equal(rejected.details.sdkErrorCode, 14800011);
                        assert.equal(rejected.details.storeId, 'store');
                        assert.equal(rejected.details.opId, op.opId);
                        assert.equal(rejected.details.path, configs.deleted[0].name);
                        assert.equal(op.state, 'error');
                    } else {
                        adapter.gcTerminalOperations(Date.now() + 10 * 60 * 1000);
                        assert.equal(JSON.parse(adapter.deleteStoreReady(op.opId)).state, 'pending');
                        await assert.rejects(kit.openStore('store', opts), { code: 'store_busy_with_pending_ops' });
                        await assert.rejects(kit.deleteStore('store', opts), { code: 'store_busy_with_pending_ops' });
                        assert.equal(sdkOpens, 0);
                        assert.equal(sdkDeletes, 1);
                        assert.equal(refs(), 0);
                        finishDelete();
                        await tick();
                        assert.equal(JSON.parse(adapter.deleteStoreReady(op.opId)).state, 'success');
                    }
                    await kit.openStore('store', opts);
                    await kit.closeStore('store');
                    assert.equal(sdkOpens, 1);
                    assert.equal(sdkCloses, 1);
                    assert.equal(rejected.code, expectedCode, 'The original failed request remains failed');
                } else if (scenario === 'legacy-empty-options') {
                    await kit.openStore('store');
                    await kit.closeStore('store');
                    assert.equal(refs(), 0);
                    assert.equal(sdkOpens, 1);
                    assert.equal(sdkCloses, 1);
                } else if (scenario === 'open-response-lost' || scenario === 'open-empty-op-id') {
                    corrupt = 'ArkData.OpenStoreStart';
                    const firstError = await kit.openStore('store', options('a')).then(
                        () => null,
                        (e) => e.code
                    );
                    if (firstError)
                        assert.ok(
                            ['envelope_parse_failed', 'operation_unresolved', 'param_op_id_invalid'].includes(
                                firstError
                            )
                        );
                    await tick();
                    await kit.closeStore('store', options('a'));
                    console.log(JSON.stringify({ scenario, refs: refs(), sdkOpens, sdkCloses }));
                    assert.equal(
                        refs(),
                        0,
                        'An accepted open with a lost Start response still needs a matching release'
                    );
                    assert.equal(sdkOpens, 1, 'Lost Start cannot create a second SDK acquisition');
                    assert.equal(sdkCloses, 1);
                } else {
                    await kit.openStore('store', options('a'));
                    corrupt = 'ArkData.CloseStoreStart';
                    const firstError = await kit.closeStore('store', options('a')).then(
                        () => null,
                        (e) => e.code
                    );
                    if (firstError) assert.ok(['envelope_parse_failed', 'operation_unresolved'].includes(firstError));
                    await tick();
                    if (scenario.endsWith('new-owner')) await kit.openStore('store', options('b'));
                    const expected = scenario.endsWith('new-owner') ? 1 : 0;
                    const retry = await kit.closeStore('store', options('a')).then(
                        () => null,
                        (e) => e.code
                    );
                    await tick();
                    console.log(JSON.stringify({ scenario, refs: refs(), sdkOpens, sdkCloses, retry }));
                    assert.equal(retry, null, 'Retry must settle the original accepted release');
                    assert.equal(refs(), expected, 'An old release must not close a new owner');
                }
            } finally {
                timeout = false;
                finishDelete();
                await tick();
                setArkdataDatabaseKit(previousKit);
                for (const id of adapter.stores.keys()) adapter.closeStoreForceStart(id);
                await tick();
            }
        });
}
