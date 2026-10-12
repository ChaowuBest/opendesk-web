import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
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
        'legacy-empty-options'
    ])
        test(scenario, async () => {
            let sdkOpens = 0,
                sdkCloses = 0,
                corrupt = null;
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
            const ActualAdapter = Adapter(sdk, class {}, { info() {}, warn() {}, error() {} }),
                adapter = new ActualAdapter({});
            const bindings = new Map();
            Binding(
                { bindFunction: (name, fn) => bindings.set(name, fn) },
                { getOrCreate: () => adapter },
                ActualAdapter
            ).bind();
            const call = async (name, _type, args) => {
                const response = bindings.get(name)(...args);
                if (name === corrupt) {
                    corrupt = null;
                    return scenario === 'open-empty-op-id'
                        ? JSON.stringify({ ...JSON.parse(response), opId: '' })
                        : '{lost-response';
                }
                return response;
            };
            const ActualBridge = Bridge(
                    createHash,
                    { warn() {} },
                    BridgeError,
                    undefined,
                    call,
                    methods,
                    () => true,
                    Date
                ),
                kit = new ActualBridge();
            const options = (id) => ({ sessionId: id, path: '/isolated-start-response.db', vector: true });
            const refs = () => [...adapter.stores.values()].reduce((n, s) => n + s.refCount, 0);
            try {
                if (scenario === 'legacy-empty-options') {
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
                for (const id of adapter.stores.keys()) adapter.closeStoreForceStart(id);
                await tick();
            }
        });
}
