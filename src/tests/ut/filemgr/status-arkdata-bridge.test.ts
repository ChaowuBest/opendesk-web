import { jest, test, expect, beforeAll } from '@jest/globals';

// Mock only the Electron -> ArkTS boundary. Keep the Node database adapter,
// parameter encoding, polling and envelope decoding on their production path.
const callArkTSFunction = jest.fn<(...args: any[]) => Promise<unknown>>();
jest.unstable_mockModule('electron', () => ({ systemPreferences: { callArkTSFunction } }));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info() {}, warn() {}, error() {}, debug() {} }
}));
let HarmonyOSDatabaseKit: typeof import('../../../platforms/bridges/harmonyos/database.js').HarmonyOSDatabaseKit;
let BaseIndexDBArkdata: typeof import('../../../main/services/storage/base-index-db-arkdata.js').BaseIndexDBArkdata;
beforeAll(async () => {
    // ESM mocks must be installed before importing the bridge's Electron dependency.
    ({ HarmonyOSDatabaseKit } = await import('../../../platforms/bridges/harmonyos/database.js'));
    ({ BaseIndexDBArkdata } = await import('../../../main/services/storage/base-index-db-arkdata.js'));
});

test('grouped count SQL and scalar parameters survive the real Node ArkData bridge', async () => {
    const fields = ['root_refs', 'embedded'];
    const sql =
        'SELECT root_refs, embedded, COUNT(*) AS group_count FROM base_index WHERE type = ? AND item_id >= ? AND item_id < ?' +
        ' GROUP BY root_refs, embedded ORDER BY root_refs, embedded LIMIT 5000 OFFSET 0';
    const params = ['file', "/资料/引号'/", "/资料/引号'0"].map((v) => ({ t: 'scalar' as const, v }));
    const rows = [{ root_refs: JSON.stringify(["/资料/引号'"]), embedded: -2, group_count: 2 }];
    let polls = 0;
    callArkTSFunction.mockReset();
    callArkTSFunction.mockImplementation(async (name, returnType, args) => {
        expect(returnType).toBe('string');
        let envelope: any = { ok: true };
        switch (name) {
            case 'ArkData.BeginPrepared':
                expect(args).toEqual(['isolated-status-store', sql]);
                envelope.statementId = 'statement-1';
                break;
            case 'ArkData.BindParams':
                expect(args[0]).toBe('statement-1');
                expect(JSON.parse(args[1])).toEqual(params);
                break;
            case 'ArkData.ExecutePreparedStart':
                expect(args).toEqual(['isolated-status-store', 'statement-1', '']);
                envelope.opId = 'operation-1';
                break;
            case 'ArkData.ExecutePreparedReady':
                expect(args).toEqual(['operation-1']);
                envelope = ++polls === 1 ? { ok: true, state: 'pending' } : { ok: true, state: 'success', rows };
                break;
            case 'ArkData.ClosePrepared':
                expect(args).toEqual(['statement-1']);
                break;
            default:
                throw new Error(`Unexpected bridge call: ${name}`);
        }
        return { value: JSON.stringify(envelope) };
    });
    const backend = Object.assign(Object.create(BaseIndexDBArkdata.prototype), {
        tableName: 'base_index',
        validFields: [...fields, 'type', 'item_id'],
        storeId: 'isolated-status-store',
        dbKit: new HarmonyOSDatabaseKit(),
        isInitialized: true
    });
    expect(
        await backend.countGrouped(fields, [
            { field: 'type', operator: '=', value: 'file' },
            { field: 'item_id', operator: '>=', value: "/资料/引号'/" },
            { field: 'item_id', operator: '<', value: "/资料/引号'0" }
        ])
    ).toEqual([{ values: { root_refs: JSON.stringify(["/资料/引号'"]), embedded: -2 }, count: 2 }]);
    expect(polls).toBe(2);
    expect(callArkTSFunction.mock.calls.at(-1)?.[0]).toBe('ArkData.ClosePrepared');
});

test('ArkData query failure propagates and closes the prepared statement', async () => {
    callArkTSFunction.mockReset();
    callArkTSFunction.mockImplementation(async (name) => {
        if (name === 'ArkData.BeginPrepared') return JSON.stringify({ ok: true, statementId: 'statement-2' });
        if (name === 'ArkData.ExecutePreparedStart') return JSON.stringify({ ok: true, opId: 'operation-2' });
        if (name === 'ArkData.ExecutePreparedReady')
            return JSON.stringify({
                ok: false,
                state: 'failed',
                error: { code: 'sql_query_failed', message: 'synthetic database failure' }
            });
        return JSON.stringify({ ok: true });
    });
    await expect(
        new HarmonyOSDatabaseKit().queryPrepared('isolated-status-store', 'SELECT COUNT(*) FROM base_index', [])
    ).rejects.toMatchObject({ code: 'sql_query_failed' });
    expect(callArkTSFunction.mock.calls.at(-1)).toEqual(['ArkData.ClosePrepared', 'string', ['statement-2']]);
});
