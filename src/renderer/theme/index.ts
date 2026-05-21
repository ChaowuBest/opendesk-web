export {
  type SupportedPlatform,
  type CallArkTSFunction,
  type SystemThemeProvider,
  type SystemThemeModuleOptions,
  OHOS_NATIVE_GET_SYSTEM_THEME,
  OhosColorMode,
  isOhosColorModeDark,
  detectPlatform,
  createSystemThemeProvider,
  initSystemTheme,
  getSystemThemeProvider,
  getSystemDarkMode,
  onSystemDarkModeChanged,
} from './system-theme.js';

export {
  type ThemePreference,
  type ThemeAppearance,
  type ResolvedTheme,
  ThemeManager,
} from './theme-manager.js';

export {
  applyResolvedTheme,
  broadcastThemeSettings,
  initRendererTheme,
} from './theme-renderer.js';

export {
  THEME_SETTINGS_MESSAGE,
  OPENDESK_THEME_CHANGED,
  broadcastThemeToAppFrames,
  postThemeToWindow,
  syncThemeToAppFrame,
  installThemeMessageListener,
  initApplicationThemeHost,
  initApplicationThemeFromAPI,
  applyThemeToDocument,
} from './theme-iframe-bridge.js';

export {
  syncShadowHostTheme,
  applyThemeToAllShadowHosts,
  SHADOW_HOST_SELECTORS,
} from './theme-shadow-overrides.js';
