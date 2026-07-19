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

export {
    type SupportedPlatform,
    type SystemThemeProvider,
    type SystemThemeModuleOptions,
    OHOS_ETS_GET_SYSTEM_DARK_MODE,
    detectPlatform,
    createSystemThemeProvider,
    initSystemTheme,
    getSystemThemeProvider,
    getSystemDarkMode,
    onSystemDarkModeChanged
} from './system-theme.js';

export { type ThemePreference, type ThemeAppearance, type ResolvedTheme, ThemeManager } from './theme-manager.js';

export { applyResolvedTheme, broadcastThemeSettings, initRendererTheme } from './theme-renderer.js';

export {
    THEME_SETTINGS_MESSAGE,
    OPENDESK_THEME_CHANGED,
    broadcastThemeToAppFrames,
    postThemeToWindow,
    syncThemeToAppFrame,
    installThemeMessageListener,
    initApplicationThemeHost,
    initApplicationThemeFromAPI,
    applyThemeToDocument
} from './theme-iframe-bridge.js';

export { syncShadowHostTheme, applyThemeToAllShadowHosts, SHADOW_HOST_SELECTORS } from './theme-shadow-overrides.js';
