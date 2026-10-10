import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import {
    retryArkdataStoreReleases,
    setArkdataDatabaseKit
} from '../../../../../main/services/storage/arkdata-bridge.js';
import { ArkDataBridgeError } from '../../../../../platforms/bridges/common.js';
import {
    BaseIndexDBArkdata,
    probeBaseIndexStoreArkdata
} from '../../../../../main/services/storage/base-index-db-arkdata.js';
import {
    VectorIndexDBArkdata,
    probeVectorIndexStoreArkdata,
    dropVectorIndexStoreArkdata
} from '../../../../../main/services/storage/vector-index-db-arkdata.js';
import {
    ChunkIndexDBArkdata,
    probeChunkIndexStoreArkdata,
    dropChunkIndexStoreArkdata
} from '../../../../../main/services/storage/chunk-index-db-arkdata.js';
const profileDirectory = fs.mkdtempSync('/private/tmp/arkdata-cross-repo-');
setCustomOpendeskDirectory(profileDirectory);
after(() => fs.rmSync(profileDirectory, { recursive: true, force: true }));
const app = new URL('../../../../../../', import.meta.url).pathname.replace(/\/$/, '');
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

    const helperCases = [
        ['base probe', probeBaseIndexStoreArkdata, backends[0]],
        ['vector probe', probeVectorIndexStoreArkdata, backends[1]],
        ['chunk probe', probeChunkIndexStoreArkdata, backends[2]],
        ['vector raw drop', dropVectorIndexStoreArkdata, backends[1]],
        ['chunk raw drop', dropChunkIndexStoreArkdata, backends[2]]
    ] as const;
    for (const [label, helper, [name, create]] of helperCases)
        test(`${label}: a transient release failure must not leave an unowned reference`, async () => {
            let fail = true,
                sdkCloses = 0;
            const sdk = {
                SecurityLevel: { S1: 1, S2: 2, S3: 3, S4: 4 },
                getRdbStore: async () => ({
                    close: async () => {
                        sdkCloses++;
                        if (fail) throw new Error('fixture transient close error');
                    }
                })
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
            let owner: any;
            kit.execSql = async () => {};
            kit.querySqlShort = async () => [{ item_id: 'fixture' }];
            kit.queryPrepared = async (_id: string, sql: string) =>
                sql.includes('meta_value') && name === 'base'
                    ? [{ meta_value: owner.computeSchemaHash() }]
                    : [{ count: 0 }];
            const previous = setArkdataDatabaseKit(kit);
            const file = '/private/tmp/filemgr-helper-release-' + name + '.db';
            try {
                const result = await helper(file);
                const afterProbe = [...adapter.stores.values()].map((x: any) => x.refCount);
                fail = false;
                owner = create(file);
                await owner.count();
                await owner.close();
                const references = [...adapter.stores.values()].reduce((sum: number, x: any) => sum + x.refCount, 0);
                console.log(JSON.stringify({ label, result, afterProbe, references, sdkCloses }));
                assert.equal(
                    references,
                    0,
                    'A successfully closed later owner must not leave the temporary helper reference behind'
                );
            } finally {
                fail = false;
                await owner?.close();
                for (const id of adapter.stores.keys()) adapter.closeStoreForceStart(id);
                await tick();
                setArkdataDatabaseKit(previous);
            }
        });

    test('generic BaseStorage close releases failed temporary probe ownership for its own stores', async () => {
        const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
        const directory = '/private/tmp/isolated-temp-probe-owner';
        const file = directory + '/base-index.db';
        let fail = true,
            closes = 0;
        const sdk = {
            SecurityLevel: { S1: 1, S2: 2, S3: 3, S4: 4 },
            getRdbStore: async () => ({
                close: async () => {
                    closes++;
                    if (fail) throw new Error('isolated release failure');
                }
            })
        };
        const Adapter = loadAdapter(sdk, class {}, { info() {}, warn() {}, error() {} }),
            adapter = new Adapter({});
        const call = async (method: string, _type: string, args: string[]) => adapter[(routes as any)[method]](...args);
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
        kit.querySqlShort = async () => [];
        const previous = setArkdataDatabaseKit(kit);
        const owner = new BaseStorage('generic-fixture', schema as any, directory);
        try {
            assert.equal(await probeBaseIndexStoreArkdata(file), 'exists');
            assert.equal([...adapter.stores.values()][0].refCount, 1);
            await assert.rejects(owner.close(), (e: any) => e.code === 'store_close_failed');
            fail = false;
            await owner.close();
            assert.equal(adapter.stores.size, 0);
            assert.equal(closes, 3);
            await owner.close();
            assert.equal(closes, 3);
        } finally {
            fail = false;
            await retryArkdataStoreReleases([file]);
            setArkdataDatabaseKit(previous);
        }
    });
} else {
    test.skip('production ArkTS temporary-owner integration requires OPENDESK_ARKDATA_ADAPTER_DIR', () => {});
}
