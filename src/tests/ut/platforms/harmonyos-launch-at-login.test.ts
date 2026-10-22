import { afterEach, beforeAll, beforeEach, expect, jest, test } from '@jest/globals';

const call = jest.fn<any>();
const available = jest.fn(() => true);
jest.unstable_mockModule('../../../platforms/bridges/harmonyos/arkts.js', () => ({
    callArkTS: call,
    hasArkTSAdapter: available,
    EtsBridgeMethods: {
        STARTUP_STATUS_START: 'EtsBridge.OpenDeskStartupStatusStart',
        STARTUP_SETTINGS_START: 'EtsBridge.OpenDeskStartupSettingsStart',
        STARTUP_RESULT_PEEK: 'EtsBridge.OpenDeskStartupResultPeek'
    }
}));
let HarmonyOSStartupKit: typeof import('../../../platforms/bridges/harmonyos/startup.js').HarmonyOSStartupKit;
beforeAll(async () => {
    ({ HarmonyOSStartupKit } = await import('../../../platforms/bridges/harmonyos/startup.js'));
});
beforeEach(() => {
    call.mockReset();
    available.mockReturnValue(true);
});
afterEach(() => jest.useRealTimers());

test('reads real native status through start/peek and preserves request IDs', async () => {
    call.mockResolvedValueOnce(41).mockResolvedValueOnce(JSON.stringify({ status: 'ok', enabled: true }));
    expect(await new HarmonyOSStartupKit().getState()).toEqual({
        supported: true,
        enabled: true,
        mode: 'system-settings'
    });
    expect(call).toHaveBeenNthCalledWith(1, 'EtsBridge.OpenDeskStartupStatusStart', 'number');
    expect(call).toHaveBeenNthCalledWith(2, 'EtsBridge.OpenDeskStartupResultPeek', 'string', [41]);
});
test('opens the native settings UI without reporting startup as enabled', async () => {
    call.mockResolvedValueOnce(42).mockResolvedValueOnce(JSON.stringify({ status: 'ok' }));
    expect(await new HarmonyOSStartupKit().delegateSetting()).toBeUndefined();
    expect(call).toHaveBeenNthCalledWith(1, 'EtsBridge.OpenDeskStartupSettingsStart', 'number');
});
test('unavailable bridges and unsupported SDKs never claim startup support', async () => {
    available.mockReturnValue(false);
    expect((await new HarmonyOSStartupKit().getState()).supported).toBe(false);
    expect(call).not.toHaveBeenCalled();
    available.mockReturnValue(true);
    call.mockResolvedValueOnce(2).mockResolvedValueOnce('{"status":"unsupported"}');
    expect((await new HarmonyOSStartupKit().getState()).supported).toBe(false);
});
test.each(['{}', '{"status":"ok","enabled":"false"}', '{"status":"error","code":201}', 'invalid json'])(
    'rejects invalid or failed native status instead of fabricating an off value: %s',
    async (result) => {
        call.mockResolvedValueOnce(1).mockResolvedValueOnce(result);
        await expect(new HarmonyOSStartupKit().getState()).rejects.toThrow();
    }
);
test('bounds pending native operations', async () => {
    jest.useFakeTimers();
    call.mockResolvedValueOnce(1).mockResolvedValue('{"status":"pending"}');
    const result = new HarmonyOSStartupKit().getState();
    const assertion = expect(result).rejects.toThrow(/timed out/);
    await jest.advanceTimersByTimeAsync(6000);
    await assertion;
});

test('rejects an older host without the new bindings', async () => {
    call.mockResolvedValueOnce(undefined);
    await expect(new HarmonyOSStartupKit().getState()).rejects.toThrow('Invalid Harmony startup request');
});

test('pending status polls the same request without restarting the OS query', async () => {
    jest.useFakeTimers();
    call.mockResolvedValueOnce(41)
        .mockResolvedValueOnce('{"status":"pending"}')
        .mockResolvedValueOnce('{"status":"pending"}')
        .mockResolvedValueOnce('{"status":"ok","enabled":true}');
    const state = new HarmonyOSStartupKit().getState();
    await jest.advanceTimersByTimeAsync(150);
    expect((await state).enabled).toBe(true);
    expect(call.mock.calls.filter(([method]) => method === 'EtsBridge.OpenDeskStartupStatusStart')).toHaveLength(1);
    const peeks = call.mock.calls.filter(([method]) => method === 'EtsBridge.OpenDeskStartupResultPeek');
    expect(peeks).toHaveLength(3);
    expect(peeks.every(([, type, args]) => type === 'string' && args[0] === 41)).toBe(true);
});

test.each(['status', 'settings'])(
    'backs off %s result reads and stops exactly at the five-second deadline',
    async (operation) => {
        jest.useFakeTimers();
        const started = Date.now();
        const peekTimes: number[] = [];
        call.mockImplementation(async (method: string) => {
            if (method === 'EtsBridge.OpenDeskStartupResultPeek') {
                peekTimes.push(Date.now() - started);
                return '{"status":"pending"}';
            }
            return 41;
        });
        const kit = new HarmonyOSStartupKit();
        const result = operation === 'status' ? kit.getState() : kit.delegateSetting();
        let finished = false;
        void result.then(
            () => {
                finished = true;
            },
            () => {
                finished = true;
            }
        );
        const assertion = expect(result).rejects.toThrow('timed out');
        const expected = [0, 50, 150, 350, 850, 1350, 1850, 2350, 2850, 3350, 3850, 4350, 4850];
        await jest.advanceTimersByTimeAsync(0);
        expect(peekTimes).toEqual([0]);
        for (let i = 1; i < expected.length; i++) {
            await jest.advanceTimersByTimeAsync(expected[i] - expected[i - 1] - 1);
            expect(peekTimes).toHaveLength(i);
            await jest.advanceTimersByTimeAsync(1);
            expect(peekTimes).toEqual(expected.slice(0, i + 1));
        }
        await jest.advanceTimersByTimeAsync(149);
        expect(finished).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        await assertion;
        expect(peekTimes).toEqual(expected);
        expect(jest.getTimerCount()).toBe(0);
        const start =
            operation === 'status' ? 'EtsBridge.OpenDeskStartupStatusStart' : 'EtsBridge.OpenDeskStartupSettingsStart';
        expect(call.mock.calls.filter(([method]) => method === start)).toHaveLength(1);
    }
);

test('immediate results need no delay or further result reads', async () => {
    jest.useFakeTimers();
    call.mockResolvedValueOnce(41).mockResolvedValueOnce('{"status":"ok","enabled":true}');
    expect((await new HarmonyOSStartupKit().getState()).enabled).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
});
