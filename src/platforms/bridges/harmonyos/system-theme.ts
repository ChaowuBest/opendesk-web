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

import { nativeTheme } from 'electron';
import { getSystemDarkMode as queryOhosSystemDarkMode, getSystemLanguage as queryOhosSystemLanguage } from './arkts.js';

let cachedSystemDark: boolean | null = null;
let cachedSystemLanguage: string | null = null;

function fallbackFromNativeTheme(): boolean {
    return nativeTheme.shouldUseDarkColors;
}

/** Refresh cache via EtsBridge.OpenDeskGetSystemDarkMode. */
export async function refreshOhosSystemDarkMode(): Promise<boolean> {
    try {
        cachedSystemDark = await queryOhosSystemDarkMode();
    } catch {
        cachedSystemDark = fallbackFromNativeTheme();
    }
    return cachedSystemDark;
}

/** Sync read for ThemeManager; triggers async refresh when cache is cold. */
export function getCachedOhosSystemDarkMode(): boolean {
    if (cachedSystemDark === null) {
        void refreshOhosSystemDarkMode();
        return fallbackFromNativeTheme();
    }
    return cachedSystemDark;
}

/** Refresh system language cache via EtsBridge.OpenDeskGetSystemLanguage. */
export async function refreshOhosSystemLanguage(): Promise<string> {
    try {
        cachedSystemLanguage = await queryOhosSystemLanguage();
    } catch {
        cachedSystemLanguage = '';
    }
    return cachedSystemLanguage;
}

/** Sync read for system language; triggers async refresh when cache is cold. */
export function getCachedOhosSystemLanguage(): string {
    if (cachedSystemLanguage === null) {
        void refreshOhosSystemLanguage();
        return '';
    }
    return cachedSystemLanguage;
}

export type OhosNativeListenerRegistrar = (listener: (isDark: boolean) => void) => () => void;

export interface OhosSystemThemeProvider {
    readonly platform: 'ohos';
    getSystemDarkMode(): boolean;
    onSystemDarkModeChanged(listener: (isDark: boolean) => void): () => void;
}

export function createOhosSystemThemeProvider(
    registerOhosNativeListener?: OhosNativeListenerRegistrar
): OhosSystemThemeProvider {
    void refreshOhosSystemDarkMode();
    void refreshOhosSystemLanguage();

    return {
        platform: 'ohos',
        getSystemDarkMode: () => getCachedOhosSystemDarkMode(),
        onSystemDarkModeChanged(listener) {
            if (!registerOhosNativeListener) {
                throw new Error(
                    'OHOS: pass registerOhosNativeListener — hook SetThemeSource / theme-source-changed in main'
                );
            }
            return registerOhosNativeListener((isDark) => listener(isDark));
        }
    };
}
