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
 * Cross-platform system dark mode — types, platform providers, and public API.
 * OHOS: EtsBridge.OpenDeskGetSystemDarkMode via platforms/bridges/harmonyos.
 * macOS / Windows / Linux: Electron nativeTheme API.
 */

import { nativeTheme } from 'electron';
import {
    createOhosSystemThemeProvider,
    type OhosNativeListenerRegistrar
} from '../../platforms/bridges/harmonyos/system-theme.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type SupportedPlatform = 'ohos' | 'darwin' | 'win32' | 'linux';

export interface SystemThemeProvider {
    readonly platform: SupportedPlatform;
    getSystemDarkMode(): boolean;
    onSystemDarkModeChanged(listener: (isDark: boolean) => void): () => void;
}

export interface SystemThemeModuleOptions {
    platform?: SupportedPlatform;
    /** OHOS: wire Electron main when ArkTS calls SetThemeSource */
    registerOhosNativeListener?: OhosNativeListenerRegistrar;
}

/** @deprecated Use EtsBridge.OpenDeskGetSystemDarkMode via harmonyos/arkts instead. */
export const OHOS_ETS_GET_SYSTEM_DARK_MODE = 'EtsBridge.OpenDeskGetSystemDarkMode';

// ── Platform detection ───────────────────────────────────────────────────────

export function detectPlatform(): SupportedPlatform {
    const forced = process.env.OPENDESK_PLATFORM?.toLowerCase();
    if (forced === 'ohos' || forced === 'darwin' || forced === 'win32' || forced === 'linux') {
        return forced;
    }
    // 鸿蒙 Node 移植的 process.platform 为 'ohos' / 'openharmony'，不在 Node 官方类型联合里
    if ((process.platform as string) === 'ohos' || (process.platform as string) === 'openharmony') return 'ohos';
    if (process.platform === 'darwin') return 'darwin';
    if (process.platform === 'win32') return 'win32';
    return 'linux';
}

// ── Providers ──────────────────────────────────────────────────────────────

function createDesktopProvider(platform: SupportedPlatform): SystemThemeProvider {
    return {
        platform,
        getSystemDarkMode: () => nativeTheme.shouldUseDarkColors,
        onSystemDarkModeChanged(listener) {
            const handler = () => listener(nativeTheme.shouldUseDarkColors);
            nativeTheme.on('updated', handler);
            return () => nativeTheme.off('updated', handler);
        }
    };
}

export function createSystemThemeProvider(options: SystemThemeModuleOptions = {}): SystemThemeProvider {
    const platform = options.platform ?? detectPlatform();
    if (platform === 'ohos') {
        return createOhosSystemThemeProvider(options.registerOhosNativeListener);
    }
    return createDesktopProvider(platform);
}

// ── Singleton API ──────────────────────────────────────────────────────────

let defaultProvider: SystemThemeProvider | undefined;

export function initSystemTheme(options: SystemThemeModuleOptions): SystemThemeProvider {
    defaultProvider = createSystemThemeProvider(options);
    return defaultProvider;
}

export function getSystemThemeProvider(): SystemThemeProvider {
    if (!defaultProvider) {
        defaultProvider = createSystemThemeProvider();
    }
    return defaultProvider;
}

export function getSystemDarkMode(): boolean {
    return getSystemThemeProvider().getSystemDarkMode();
}

export function onSystemDarkModeChanged(listener: (isDark: boolean) => void): () => void {
    return getSystemThemeProvider().onSystemDarkModeChanged(listener);
}
