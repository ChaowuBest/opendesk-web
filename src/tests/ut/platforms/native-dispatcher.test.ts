import { describe, expect, jest, test } from '@jest/globals';
import type { NativeBridge } from '../../../platforms/bridges/common.js';
import { dispatchNativeBridgeCall, NATIVE_BRIDGE_METHODS } from '../../../platforms/bridges/dispatcher.js';

const cases: Array<{ method: string; kit?: string; operation: string; args: unknown[] }> = [
    { method: 'getPlatform', operation: 'getPlatform', args: [] },
    { method: 'getVariant', operation: 'getVariant', args: [] },
    { method: 'startupKit:getState', kit: 'startupKit', operation: 'getState', args: [] },
    { method: 'startupKit:delegateSetting', kit: 'startupKit', operation: 'delegateSetting', args: [false] },
    { method: 'quickCaptureKit:getState', kit: 'quickCaptureKit', operation: 'getState', args: [] },
    { method: 'quickCaptureKit:setEnabled', kit: 'quickCaptureKit', operation: 'setEnabled', args: [false] },
    { method: 'quickCaptureKit:takePendingCapture', kit: 'quickCaptureKit', operation: 'takePendingCapture', args: [] },
    ...['available', 'start', 'peek', 'stop', 'release'].map((operation) => ({
        method: `speechKit:${operation}`,
        kit: 'speechKit',
        operation,
        args: []
    })),
    { method: 'speechKit:initialize', kit: 'speechKit', operation: 'initialize', args: ['zh-CN'] },
    { method: 'databaseKit:available', kit: 'databaseKit', operation: 'available', args: [] },
    { method: 'databaseKit:execSql', kit: 'databaseKit', operation: 'execSql', args: ['store', 'select 1'] },
    {
        method: 'databaseKit:execSqlParams',
        kit: 'databaseKit',
        operation: 'execSqlParams',
        args: ['store', 'select ?', [{ t: 'scalar', v: 7 }]]
    },
    {
        method: 'databaseKit:querySqlShort',
        kit: 'databaseKit',
        operation: 'querySqlShort',
        args: ['store', 'select 1']
    },
    {
        method: 'databaseKit:openStore',
        kit: 'databaseKit',
        operation: 'openStore',
        args: ['store', { sessionId: 'session', vector: true }]
    },
    {
        method: 'databaseKit:closeStore',
        kit: 'databaseKit',
        operation: 'closeStore',
        args: ['store', { sessionId: 'session' }]
    },
    {
        method: 'databaseKit:executePrepared',
        kit: 'databaseKit',
        operation: 'executePrepared',
        args: ['store', 'update x set y=?', [{ t: 'scalar', v: null }], { txId: 'tx' }]
    },
    {
        method: 'databaseKit:executePreparedMany',
        kit: 'databaseKit',
        operation: 'executePreparedMany',
        args: ['store', 'insert into x values (?)', [[{ t: 'vector', v: [1, 2] }]], { txId: 'tx' }]
    },
    {
        method: 'databaseKit:executePreparedManyBatched',
        kit: 'databaseKit',
        operation: 'executePreparedManyBatched',
        args: ['store', 'insert into x values (?)', [[{ t: 'scalar', v: 'text' }]], { maxRows: 2, maxBytes: 512 }]
    },
    {
        method: 'databaseKit:queryPrepared',
        kit: 'databaseKit',
        operation: 'queryPrepared',
        args: ['store', 'select ?', [{ t: 'scalar', v: false }], { txId: 'tx' }]
    },
    {
        method: 'databaseKit:beginTransaction',
        kit: 'databaseKit',
        operation: 'beginTransaction',
        args: ['store', { mode: 'read' }]
    },
    {
        method: 'databaseKit:deleteStore',
        kit: 'databaseKit',
        operation: 'deleteStore',
        args: ['store', { path: 'bm25.db', vector: false }]
    },
    {
        method: 'databaseKit:bm25Query',
        kit: 'databaseKit',
        operation: 'bm25Query',
        args: ['store', { deadline: 1, kind: 'search', field: 'body', terms: ['word'] }, 'otx_1_1']
    },
    {
        method: 'databaseKit:commitTransaction',
        kit: 'databaseKit',
        operation: 'commitTransaction',
        args: ['store', { id: 'tx' }]
    },
    {
        method: 'databaseKit:rollbackTransaction',
        kit: 'databaseKit',
        operation: 'rollbackTransaction',
        args: ['store', { id: 'tx' }]
    },
    ...['available', 'startLogin', 'peekLogin', 'closeLogin'].map((operation) => ({
        method: `accountKit:${operation}`,
        kit: 'accountKit',
        operation,
        args: []
    }))
];

function createBridge() {
    const groups: Record<string, Record<string, jest.Mock<(...args: unknown[]) => Promise<unknown>>>> = {};
    for (const row of cases) {
        const group = (groups[row.kit ?? 'bridge'] ??= {});
        group[row.operation] = jest.fn(async function (this: unknown, ...args: unknown[]) {
            expect(this).toBe(group);
            return { operation: row.method, args };
        });
    }
    const bridge = groups.bridge;
    Object.assign(bridge, {
        getStartupKit: async () => groups.startupKit,
        getSpeechKit: async () => groups.speechKit,
        getDatabaseKit: async () => groups.databaseKit,
        getHuaweiAccountKit: async () => groups.accountKit,
        getQuickCaptureKit: async () => groups.quickCaptureKit
    });
    return { bridge: bridge as unknown as NativeBridge, groups };
}

describe('shared native bridge dispatcher', () => {
    test('the public method list is completely covered', () => {
        expect([...NATIVE_BRIDGE_METHODS].sort()).toEqual(cases.map(({ method }) => method).sort());
    });

    test.each(cases)(
        '$method maps JSON arguments to the corresponding native method',
        async ({ method, kit, operation, args }) => {
            const { bridge, groups } = createBridge();
            const wireArguments = JSON.parse(JSON.stringify([...args, 'ignored-extra-argument']));

            expect(await dispatchNativeBridgeCall(bridge, method, wireArguments)).toEqual({
                status: 'ok',
                data: { operation: method, args }
            });
            expect(groups[kit ?? 'bridge'][operation]).toHaveBeenCalledTimes(1);
            expect(groups[kit ?? 'bridge'][operation]).toHaveBeenCalledWith(...args);
        }
    );

    test.each([undefined, null, 42, false])(
        'speech initialization normalizes a non-string locale %s to null',
        async (locale) => {
            const { bridge, groups } = createBridge();
            await dispatchNativeBridgeCall(bridge, 'speechKit:initialize', [locale]);
            expect(groups.speechKit.initialize).toHaveBeenCalledWith(null);
        }
    );

    test('omitted startup and database options retain their undefined argument positions', async () => {
        const { bridge, groups } = createBridge();
        await dispatchNativeBridgeCall(bridge, 'startupKit:delegateSetting');
        await dispatchNativeBridgeCall(bridge, 'databaseKit:openStore', ['store']);
        expect(groups.startupKit.delegateSetting).toHaveBeenCalledWith(undefined);
        expect(groups.databaseKit.openStore).toHaveBeenCalledWith('store', undefined);
    });

    test.each(['missing', '__proto__', 'constructor', 'getDatabaseKit', 'accountKit:restoreLogin', 'ocrKit:available'])(
        'unknown method %s returns the existing error contract',
        async (method) => {
            const { bridge } = createBridge();
            expect(await dispatchNativeBridgeCall(bridge, method)).toEqual({
                status: 'error',
                message: `Method not found: ${method}`
            });
        }
    );

    test('a native failure is propagated to the host transport unchanged', async () => {
        const { bridge, groups } = createBridge();
        const error = Object.assign(new Error('native unavailable'), { code: 'UNAVAILABLE' });
        groups.databaseKit.openStore.mockRejectedValue(error);
        await expect(dispatchNativeBridgeCall(bridge, 'databaseKit:openStore', ['store'])).rejects.toBe(error);
    });
});
