import { afterAll, beforeAll, beforeEach, expect, jest, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const handlers = new Map<string, (...args: any[]) => Promise<any>>();
const app = {
    isPackaged: true,
    getLoginItemSettings: jest.fn(() => ({ openAtLogin: true, executableWillLaunchAtLogin: true })),
    setLoginItemSettings: jest.fn()
};
const arktsCall = jest.fn(async (method: string) =>
    method === 'peek' ? JSON.stringify({ status: 'ok', enabled: true }) : 1
);
jest.unstable_mockModule('electron', () => ({
    app,
    ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) }
}));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({ logger: { info: jest.fn() } }));
jest.unstable_mockModule('../../../platforms/bridges/darwin/speech.js', () => ({ DarwinSpeechKit: class {} }));
jest.unstable_mockModule('../../../platforms/bridges/harmonyos/speech.js', () => ({ HarmonyOSSpeechKit: class {} }));
jest.unstable_mockModule('../../../platforms/bridges/harmonyos/database.js', () => ({
    HarmonyOSDatabaseKit: class {}
}));
jest.unstable_mockModule('../../../platforms/bridges/harmonyos/account.js', () => ({
    HarmonyOSHuaweiAccountKit: class {}
}));
jest.unstable_mockModule('../../../platforms/bridges/harmonyos/arkts.js', () => ({
    hasArkTSAdapter: () => true,
    callArkTS: arktsCall,
    EtsBridgeMethods: {
        STARTUP_STATUS_START: 'status',
        STARTUP_SETTINGS_START: 'settings',
        STARTUP_RESULT_PEEK: 'peek'
    }
}));
let registerNativeBridge: typeof import('../../../platforms/bridges/main.js').registerNativeBridge;
let NativeBridgeProxy: typeof import('../../../platforms/bridges/renderer.js').NativeBridgeProxy;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const configHome = mkdtempSync(path.join(tmpdir(), 'opendesk-startup-bridge-'));
beforeAll(async () => {
    ({ registerNativeBridge } = await import('../../../platforms/bridges/main.js'));
    ({ NativeBridgeProxy } = await import('../../../platforms/bridges/renderer.js'));
    (globalThis as any).window = {
        native: {
            call: async (method: string, ...args: any[]) =>
                (await handlers.get('native:call')!({}, method, ...args)).data
        }
    };
    process.env.XDG_CONFIG_HOME = configHome;
});
beforeEach(() => {
    app.isPackaged = true;
    jest.clearAllMocks();
});
afterAll(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;
    delete (globalThis as any).window;
    rmSync(configHome, { recursive: true, force: true });
});

test.each(['darwin', 'win32', 'linux', 'openharmony'])(
    '%s startup uses the existing renderer proxy and native:call dispatcher',
    async (platform) => {
        Object.defineProperty(process, 'platform', { value: platform });
        registerNativeBridge();
        const kit = await new NativeBridgeProxy().getStartupKit();
        expect(await kit.getState()).toEqual({
            supported: true,
            enabled: platform !== 'linux',
            mode: platform === 'openharmony' ? 'system-settings' : 'toggle'
        });
        await kit.delegateSetting(platform === 'openharmony' ? undefined : false);
        if (platform === 'openharmony') {
            expect(arktsCall).toHaveBeenCalledWith('settings', 'number');
            expect(app.setLoginItemSettings).not.toHaveBeenCalled();
        } else if (platform !== 'linux') {
            expect(app.setLoginItemSettings).toHaveBeenCalledWith({
                openAtLogin: false,
                ...(platform === 'win32' ? { path: process.execPath, args: [] } : {})
            });
        }
        expect([...handlers.keys()]).toEqual(['native:call']);
    }
);

test.each(['darwin', 'win32', 'linux', 'openharmony'])(
    '%s debug instances cannot change OS startup settings',
    async (platform) => {
        Object.defineProperty(process, 'platform', { value: platform });
        registerNativeBridge({ debug: true });
        const kit = await new NativeBridgeProxy().getStartupKit();
        expect(await kit.getState()).toMatchObject({ supported: false, enabled: null, reason: 'development' });
        await expect(kit.delegateSetting(platform === 'openharmony' ? undefined : true)).rejects.toThrow();
        expect(app.getLoginItemSettings).not.toHaveBeenCalled();
        expect(app.setLoginItemSettings).not.toHaveBeenCalled();
        expect(arktsCall).not.toHaveBeenCalled();
    }
);

test.each(['darwin', 'win32', 'linux', 'openharmony'])('%s keeps its correct installation guard', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    app.isPackaged = false;
    registerNativeBridge();
    const kit = await new NativeBridgeProxy().getStartupKit();
    // Harmony HAP directory resources report unpackaged even after a real installation.
    expect((await kit.getState()).supported).toBe(platform === 'openharmony');
});

test('invalid IPC arguments never reach the operating system', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    registerNativeBridge();
    await expect(handlers.get('native:call')!({}, 'startupKit:delegateSetting', 'false')).rejects.toThrow(TypeError);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
});

test('Harmony delegation rejects a toggle request instead of silently discarding the desired state', async () => {
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    registerNativeBridge();
    const kit = await new NativeBridgeProxy().getStartupKit();
    await expect(kit.delegateSetting(true)).rejects.toThrow(TypeError);
    expect(arktsCall).not.toHaveBeenCalled();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
});
