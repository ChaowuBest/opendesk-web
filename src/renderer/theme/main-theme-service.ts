/**
 * Main-process theme: system dark mode + user preference + IPC broadcast.
 * Lives under renderer/theme for a single module root; imported only from src/main/main.ts.
 */

import { app, BrowserWindow, ipcMain, nativeTheme, systemPreferences } from 'electron';
import { Setting } from '../../main/utils/setting.js';
import { logger } from '../../main/utils/logger.js';
import { ThemeManager, type ResolvedTheme, type ThemePreference } from './theme-manager.js';
import {
    initSystemTheme,
    detectPlatform,
    getSystemDarkMode,
    OHOS_NATIVE_GET_SYSTEM_THEME,
    OhosColorMode,
    parseOhosColorMode,
    unwrapCallArkTSValue,
    type CallArkTSFunction,
    type SystemThemeModuleOptions,
} from './system-theme.js';

const THEME_CHANNEL = 'theme:changed';

function isOhosPlatform(): boolean {
    return (
        process.platform === 'openharmony' ||
        process.env.OPENDESK_PLATFORM === 'ohos' ||
        detectPlatform() === 'ohos'
    );
}

function resolveCallArkTS(): CallArkTSFunction | undefined {
    const sp = systemPreferences as typeof systemPreferences & {
        callArkTSFunction?: CallArkTSFunction;
    };
    if (typeof sp.callArkTSFunction === 'function') {
        return sp.callArkTSFunction.bind(sp);
    }
    return undefined;
}

/** OHOS bridge may be async and always returns `{ type, value }` — cache for sync theme reads. */
function wrapOhosCallArkTS(raw: CallArkTSFunction): {
    callArkTS: CallArkTSFunction;
    refresh: () => Promise<void>;
} {
    let cachedColorMode = OhosColorMode.NOT_SET;

    const refresh = async (): Promise<void> => {
        try {
            const result = await Promise.resolve(
                raw(OHOS_NATIVE_GET_SYSTEM_THEME, 'number', []),
            );
            const mode = parseOhosColorMode(unwrapCallArkTSValue(result));
            if (mode !== OhosColorMode.NOT_SET) {
                cachedColorMode = mode;
            }
        } catch (err) {
            logger.warn('[theme] async refresh GetSystemNativeTheme failed', err);
        }
    };

    void refresh();

    const callArkTS: CallArkTSFunction = () => {
        if (cachedColorMode !== OhosColorMode.NOT_SET) {
            return cachedColorMode;
        }
        try {
            const result = raw(OHOS_NATIVE_GET_SYSTEM_THEME, 'number', []);
            const unwrapped = unwrapCallArkTSValue(result);
            if (unwrapped != null && typeof unwrapped === 'object' && 'then' in (unwrapped as object)) {
                void refresh();
                return nativeTheme.shouldUseDarkColors ? OhosColorMode.DARK : OhosColorMode.LIGHT;
            }
            const mode = parseOhosColorMode(unwrapped);
            if (mode !== OhosColorMode.NOT_SET) {
                cachedColorMode = mode;
            }
            return mode !== OhosColorMode.NOT_SET
                ? mode
                : nativeTheme.shouldUseDarkColors
                  ? OhosColorMode.DARK
                  : OhosColorMode.LIGHT;
        } catch {
            return nativeTheme.shouldUseDarkColors ? OhosColorMode.DARK : OhosColorMode.LIGHT;
        }
    };

    return { callArkTS, refresh };
}

function readStoredPreference(): ThemePreference {
    const pref = Setting.getInstance().getData().gui_config?.theme_preference;
    if (pref === 'light' || pref === 'dark' || pref === 'system') {
        return pref;
    }
    return 'system';
}

function persistPreference(preference: ThemePreference): void {
    const data = Setting.getInstance().getData();
    Setting.getInstance().setData({
        ...data,
        gui_config: { ...(data.gui_config || {}), theme_preference: preference },
    });
}

function syncDesktopNativeTheme(preference: ThemePreference): void {
    if (isOhosPlatform()) {
        return;
    }
    nativeTheme.themeSource = preference;
}

export class MainThemeService {
    private manager: ThemeManager | null = null;

    init(): void {
        if (this.manager) {
            return;
        }

        const options: SystemThemeModuleOptions = { platform: detectPlatform() };

        if (isOhosPlatform()) {
            options.platform = 'ohos';
            const callArkTS = resolveCallArkTS();
            if (!callArkTS) {
                logger.warn('[theme] OHOS: callArkTSFunction unavailable, system theme may be inaccurate');
            } else {
                const wrapped = wrapOhosCallArkTS(callArkTS);
                options.callArkTS = wrapped.callArkTS;
                const refreshOhos = wrapped.refresh;
                options.registerOhosNativeListener = (listener) => {
                    const handlers: Array<() => void> = [];
                    const invoke = () => {
                        void refreshOhos().then(() => listener(getSystemDarkMode()));
                    };
                    const onThemeSource = () => invoke();
                    if (typeof (app as NodeJS.EventEmitter).on === 'function') {
                        app.on('theme-source-changed' as any, onThemeSource);
                        handlers.push(() => app.removeListener('theme-source-changed' as any, onThemeSource));
                    }
                    nativeTheme.on('updated', onThemeSource);
                    handlers.push(() => nativeTheme.off('updated', onThemeSource));
                    return () => {
                        for (const off of handlers) {
                            off();
                        }
                    };
                };
            }
        }

        initSystemTheme(options);
        this.manager = new ThemeManager(options);
        this.manager.setPreference(readStoredPreference());
        syncDesktopNativeTheme(readStoredPreference());

        this.manager.on('changed', (resolved: ResolvedTheme) => {
            persistPreference(resolved.preference);
            syncDesktopNativeTheme(resolved.preference);
            this.broadcast(resolved);
        });

        this.broadcast(this.manager.getResolvedTheme());
        logger.info(`[theme] initialized effective=${this.manager.getResolvedTheme().effective}`);
    }

    getResolvedTheme(): ResolvedTheme {
        if (!this.manager) {
            this.init();
        }
        return this.manager!.getResolvedTheme();
    }

    applyFromSettings(): ResolvedTheme {
        if (!this.manager) {
            this.init();
        }
        return this.setPreference(readStoredPreference());
    }

    setPreference(preference: ThemePreference): ResolvedTheme {
        if (!this.manager) {
            this.init();
        }
        this.manager!.setPreference(preference);
        persistPreference(preference);
        syncDesktopNativeTheme(preference);
        const resolved = this.manager!.getResolvedTheme();
        this.broadcast(resolved);
        return resolved;
    }

    private broadcast(resolved: ResolvedTheme): void {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                win.webContents.send(THEME_CHANNEL, resolved);
            }
        }
    }
}

let singleton: MainThemeService | null = null;

export function getMainThemeService(): MainThemeService {
    if (!singleton) {
        singleton = new MainThemeService();
    }
    return singleton;
}

export function registerThemeHandlers(): void {
    const service = getMainThemeService();

    ipcMain.handle('theme:getResolvedTheme', () => {
        try {
            service.init();
            return { status: 'ok', data: service.getResolvedTheme() };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    ipcMain.handle('theme:setPreference', (_event, preference: ThemePreference) => {
        try {
            if (preference !== 'system' && preference !== 'light' && preference !== 'dark') {
                return { status: 'error', message: `invalid theme preference: ${preference}` };
            }
            service.init();
            return { status: 'ok', data: service.setPreference(preference) };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
}
