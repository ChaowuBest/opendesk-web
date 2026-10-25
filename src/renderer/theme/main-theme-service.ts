/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * Main-process theme: system dark mode + user preference + IPC broadcast.
 * Lives under renderer/theme for a single module root; imported only from src/main/main.ts.
 */

import { app, BrowserWindow, ipcMain, nativeTheme, webContents } from 'electron';
import { Setting } from '../../main/utils/setting.js';
import { logger } from '../../main/utils/logger.js';
import { safeSendToWebContents } from '../../main/utils/electron-ipc.js';
import { hasArkTSAdapter } from '../../platforms/bridges/harmonyos/arkts.js';
import {
    refreshOhosSystemDarkMode,
    getCachedOhosSystemDarkMode
} from '../../platforms/bridges/harmonyos/system-theme.js';
import { ThemeManager, type ResolvedTheme, type ThemePreference } from './theme-manager.js';
import { FONT_PRESET_CHANNEL, normalizeFontPreset } from './font-preset.js';
import { initSystemTheme, detectPlatform, type SystemThemeModuleOptions } from './system-theme.js';
import { isTransparentShadowWindow } from '../../main/windows/task-status-widget-window.js';

const THEME_CHANNEL = 'theme:changed';

function isOhosPlatform(): boolean {
    return (
        // 鸿蒙 Node 移植的 process.platform 为 'openharmony'，不在 Node 官方类型联合里
        (process.platform as string) === 'openharmony' ||
        process.env.OPENDESK_PLATFORM === 'ohos' ||
        detectPlatform() === 'ohos'
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

/** 读取设置中的字体预设（未设置或非法值回退 default）。 */
function readFontPreset(): string {
    return normalizeFontPreset(Setting.getInstance().getData().gui_config?.font_preset);
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
    private fontPresetHookInstalled = false;

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
        this.installFontPresetHook();
        logger.info(`[theme] initialized effective=${this.manager.getResolvedTheme().effective}`);
    }

    /**
     * 设置面板修改 gui_config.font_preset（保存设置触发 setData）后，向所有窗口
     * （含任务浮窗等独立 BrowserWindow）广播最新预设，让未挂接设置面板的页面跟随。
     */
    private installFontPresetHook(): void {
        if (this.fontPresetHookInstalled) {
            return;
        }
        this.fontPresetHookInstalled = true;
        Setting.afterSetDataCallbacks.push(() => {
            this.broadcastFontPreset(readFontPreset());
        });
    }

    getFontPreset(): string {
        this.init();
        return readFontPreset();
    }

    private broadcastFontPreset(preset: string): void {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                safeSendToWebContents(win.webContents, FONT_PRESET_CHANNEL, preset);
            }
        }
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
            if (win.isDestroyed()) {
                continue;
            }
            // 透明窗口（Linux 圆角阴影主窗口、任务浮窗）的底色必须保持全透明，
            // 否则主题底色会填满自绘圆角/阴影的透明区域（表现为方形底色）。
            // 透明窗口的页面背景由 CSS 变量随主题切换，无需设置窗口底色。
            if (!isTransparentShadowWindow(win)) {
                win.setBackgroundColor(bgColor);
            }
            safeSendToWebContents(win.webContents, THEME_CHANNEL, resolved);
        }
        for (const contents of webContents.getAllWebContents()) {
            safeSendToWebContents(contents, 'app:theme-changed', resolved.preference);
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

    ipcMain.handle('app:get-theme', () => {
        service.init();
        return service.getResolvedTheme().preference;
    });

    ipcMain.handle('theme:getResolvedTheme', () => {
        try {
            service.init();
            return { status: 'ok', data: service.getResolvedTheme() };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    ipcMain.handle('theme:getFontPreset', () => {
        try {
            return { status: 'ok', data: service.getFontPreset() };
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
