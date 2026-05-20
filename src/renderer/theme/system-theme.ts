/**
 * Cross-platform system dark mode — types, platform providers, and public API.
 * OHOS: Harmony Electron callArkTS → NativeThemeAdapter.GetSystemNativeTheme (web_engine JSBind).
 * macOS / Windows / Linux: Electron nativeTheme API.
 */

import { nativeTheme } from 'electron';

// ── Types ────────────────────────────────────────────────────────────────────

export type SupportedPlatform = 'ohos' | 'darwin' | 'win32' | 'linux';

export type CallArkTSFunction = (
  method: string,
  returnType: string,
  args: unknown[],
) => string | number | boolean | string[] | number[] | void;

export interface SystemThemeProvider {
  readonly platform: SupportedPlatform;
  getSystemDarkMode(): boolean;
  /** Returns raw colorMode on OHOS; undefined on desktop platforms. */
  getSystemColorMode?(): number | undefined;
  onSystemDarkModeChanged(listener: (isDark: boolean) => void): () => void;
}

export interface SystemThemeModuleOptions {
  platform?: SupportedPlatform;
  /** Required when platform is `ohos`. Typically systemPreferences.callArkTSFunction. */
  callArkTS?: CallArkTSFunction;
  /** OHOS: wire Electron main when ArkTS calls SetThemeSource */
  registerOhosNativeListener?: (listener: (isDark: boolean) => void) => () => void;
}

/** web_engine NativeThemeAdapterBind — ConfigurationConstant.ColorMode as number */
export const OHOS_NATIVE_GET_SYSTEM_THEME = 'NativeThemeAdapter.GetSystemNativeTheme';

/** @see @ohos.app.ability.ConfigurationConstant.ColorMode */
export const OhosColorMode = {
  DARK: 0,
  LIGHT: 1,
  NOT_SET: -1,
} as const;

export function isOhosColorModeDark(colorMode: number): boolean {
  return colorMode === OhosColorMode.DARK;
}

// ── Platform detection ─────────────────────────────────────────────────────────

export function detectPlatform(): SupportedPlatform {
  const forced = process.env.OPENDESK_PLATFORM?.toLowerCase();
  if (forced === 'ohos' || forced === 'darwin' || forced === 'win32' || forced === 'linux') {
    return forced;
  }
  if (process.platform === 'ohos') return 'ohos';
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
}

// ── Providers ────────────────────────────────────────────────────────────────

function createDesktopProvider(platform: SupportedPlatform): SystemThemeProvider {
  return {
    platform,
    getSystemDarkMode: () => nativeTheme.shouldUseDarkColors,
    onSystemDarkModeChanged(listener) {
      const handler = () => listener(nativeTheme.shouldUseDarkColors);
      nativeTheme.on('updated', handler);
      return () => nativeTheme.off('updated', handler);
    },
  };
}

function createOhosProvider(options: SystemThemeModuleOptions): SystemThemeProvider {
  const { callArkTS, registerOhosNativeListener } = options;
  if (!callArkTS) {
    throw new Error('OHOS system theme requires callArkTS (systemPreferences.callArkTSFunction)');
  }

  const readColorMode = (): number => {
    const mode = callArkTS(OHOS_NATIVE_GET_SYSTEM_THEME, 'number', []);
    if (typeof mode !== 'number') {
      throw new Error(`GetSystemNativeTheme expected number, got ${typeof mode}`);
    }
    return mode;
  };

  return {
    platform: 'ohos',
    getSystemColorMode: readColorMode,
    getSystemDarkMode: () => isOhosColorModeDark(readColorMode()),
    onSystemDarkModeChanged(listener) {
      if (!registerOhosNativeListener) {
        throw new Error(
          'OHOS: pass registerOhosNativeListener — hook SetThemeSource / theme-source-changed in main',
        );
      }
      return registerOhosNativeListener((isDark) => listener(isDark));
    },
  };
}

export function createSystemThemeProvider(options: SystemThemeModuleOptions = {}): SystemThemeProvider {
  const platform = options.platform ?? detectPlatform();
  if (platform === 'ohos') {
    return createOhosProvider(options);
  }
  return createDesktopProvider(platform);
}

// ── Singleton API ────────────────────────────────────────────────────────────

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
