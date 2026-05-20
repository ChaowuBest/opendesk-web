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
