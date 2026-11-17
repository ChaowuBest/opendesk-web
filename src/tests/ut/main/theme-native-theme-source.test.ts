import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

type ThemeSource = 'system' | 'light' | 'dark';

/** 记录 themeSource 写入并支持 'updated' 派发的 nativeTheme 桩 */
class NativeThemeStub {
    themeSource: ThemeSource = 'system';
    shouldUseDarkColors = false;
    private readonly handlers = new Map<string, Set<() => void>>();

    on(event: string, handler: () => void): void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Set());
        }
        this.handlers.get(event)!.add(handler);
    }

    off(event: string, handler: () => void): void {
        this.handlers.get(event)?.delete(handler);
    }

    emit(event: string): void {
        for (const handler of this.handlers.get(event) ?? []) {
            handler();
        }
    }
}

const nativeTheme = new NativeThemeStub();

/** Setting 桩读取的主题偏好，由各用例改写 */
let storedPreference: string = 'system';
const setData = jest.fn<(data: unknown) => void>();

jest.unstable_mockModule('electron', () => ({
    app: { on: jest.fn(), quit: jest.fn() },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: jest.fn() },
    webContents: { getAllWebContents: () => [] },
    nativeTheme
}));
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: {
        getInstance: () => ({
            getData: () => ({ gui_config: { theme_preference: storedPreference } }),
            setData: setData
        }),
        afterSetDataCallbacks: []
    }
}));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.unstable_mockModule('../../../main/utils/electron-ipc.js', () => ({
    safeSendToWebContents: jest.fn()
}));
jest.unstable_mockModule('../../../main/windows/task-status-widget-window.js', () => ({
    isTransparentShadowWindow: () => false
}));
jest.unstable_mockModule('../../../platforms/bridges/harmonyos/arkts.js', () => ({
    hasArkTSAdapter: () => false
}));
jest.unstable_mockModule('../../../platforms/bridges/harmonyos/system-theme.js', () => ({
    refreshOhosSystemDarkMode: async () => false,
    getCachedOhosSystemDarkMode: () => false,
    createOhosSystemThemeProvider: () => ({
        platform: 'ohos',
        getSystemDarkMode: () => false,
        onSystemDarkModeChanged: () => () => {}
    })
}));

describe('main theme service mirrors the app preference into nativeTheme.themeSource', () => {
    let MainThemeServiceClass: any;
    beforeAll(async () => {
        ({ MainThemeService: MainThemeServiceClass } = await import('../../../renderer/theme/main-theme-service.js'));
    });

    afterEach(() => {
        delete process.env.OPENDESK_PLATFORM;
        nativeTheme.shouldUseDarkColors = false;
    });

    test('init mirrors a stored dark preference into themeSource so tray menus follow the app theme', () => {
        storedPreference = 'dark';
        const service = new MainThemeServiceClass();
        service.init();
        // Electron 自渲染的原生 UI（托盘上下文菜单、devtools 等）跟随 themeSource，
        // 应用偏好为深色时原生菜单也必须是深色
        expect(nativeTheme.themeSource).toBe('dark');
    });

    test('init mirrors a stored light preference into themeSource', () => {
        storedPreference = 'light';
        const service = new MainThemeServiceClass();
        service.init();
        expect(nativeTheme.themeSource).toBe('light');
    });

    test('setPreference mirrors every preference value into themeSource', () => {
        storedPreference = 'light';
        const service = new MainThemeServiceClass();
        service.init();
        service.setPreference('dark');
        expect(nativeTheme.themeSource).toBe('dark');
        service.setPreference('system');
        expect(nativeTheme.themeSource).toBe('system');
        service.setPreference('light');
        expect(nativeTheme.themeSource).toBe('light');
    });

    test('css data-theme resolution still follows the preference and system state', () => {
        storedPreference = 'light';
        const service = new MainThemeServiceClass();
        service.init();
        service.setPreference('dark');
        expect(service.getResolvedTheme().effective).toBe('dark');
        nativeTheme.shouldUseDarkColors = true;
        service.setPreference('system');
        expect(service.getResolvedTheme().effective).toBe('dark');
        nativeTheme.shouldUseDarkColors = false;
        expect(service.getResolvedTheme().effective).toBe('light');
    });

    test('ohos platform never touches themeSource (ArkTS bridge owns it)', () => {
        process.env.OPENDESK_PLATFORM = 'ohos';
        nativeTheme.themeSource = 'dark';
        const ohosService = new MainThemeServiceClass();
        try {
            ohosService.init();
            expect(nativeTheme.themeSource).toBe('dark');
        } finally {
            delete process.env.OPENDESK_PLATFORM;
        }
    });
});
