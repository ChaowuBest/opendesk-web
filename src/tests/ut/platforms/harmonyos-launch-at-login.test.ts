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
