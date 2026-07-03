/**
 * Main-process theme: system dark mode + user preference + IPC broadcast.
 * Lives under renderer/theme for a single module root; imported only from src/main/main.ts.
 */

import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import { Setting } from '../../main/utils/setting.js';
import { logger } from '../../main/utils/logger.js';
import { safeSendToWebContents } from '../../main/utils/electron-ipc.js';
import { hasArkTSAdapter } from '../../platforms/bridges/harmonyos/arkts.js';
import {
    refreshOhosSystemDarkMode,
    getCachedOhosSystemDarkMode
} from '../../platforms/bridges/harmonyos/system-theme.js';
import { ThemeManager, type ResolvedTheme, type ThemePreference } from './theme-manager.js';
import { initSystemTheme, detectPlatform, type SystemThemeModuleOptions } from './system-theme.js';

const THEME_CHANNEL = 'theme:changed';

function isOhosPlatform(): boolean {
    return (
        process.platform === 'openharmony' || process.env.OPENDESK_PLATFORM === 'ohos' || detectPlatform() === 'ohos'
    );
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
        gui_config: { ...(data.gui_config || {}), theme_preference: preference }
    });
}

/**
 * `themeSource = dark` forces Chromium to auto-darken web contents (iframe sub-apps go blank).
 * User "dark" preference is applied via CSS `data-theme` only; `system` keeps OS detection.
 */
function syncDesktopNativeTheme(preference: ThemePreference): void {
    if (isOhosPlatform()) {
        return;
    }
    nativeTheme.themeSource = preference === 'system' ? 'system' : 'light';
}

function buildOhosNativeListenerRegistrar(): SystemThemeModuleOptions['registerOhosNativeListener'] {
    return (listener) => {
        const handlers: Array<() => void> = [];
        const invoke = () => {
            void refreshOhosSystemDarkMode().then(() => listener(getCachedOhosSystemDarkMode()));
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

export class MainThemeService {
    private manager: ThemeManager | null = null;

    init(): void {
        if (this.manager) {
            return;
        }

        const options: SystemThemeModuleOptions = { platform: detectPlatform() };

        if (isOhosPlatform()) {
            options.platform = 'ohos';
            if (!hasArkTSAdapter()) {
                logger.warn('[theme] OHOS: callArkTSFunction unavailable, system theme may be inaccurate');
            } else {
                options.registerOhosNativeListener = buildOhosNativeListenerRegistrar();
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
        const bgColor = resolved.effective === 'dark' ? '#1e1e1e' : '#f5f5f5';
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                win.setBackgroundColor(bgColor);
                safeSendToWebContents(win.webContents, THEME_CHANNEL, resolved);
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
