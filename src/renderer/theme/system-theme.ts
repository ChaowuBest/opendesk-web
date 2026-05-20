/**
 * Cross-platform system dark mode — types, platform providers, and public API.
 * OHOS: Harmony Electron callArkTS → NativeThemeAdapter.GetSystemNativeTheme (web_engine JSBind).
 * macOS / Windows / Linux: Electron nativeTheme API.
 */

import { nativeTheme } from 'electron';

// ── Types ────────────────────────────────────────────────────────────────────

export type SupportedPlatform = 'ohos' | 'darwin' | 'win32' | 'linux';

/** Harmony Electron bridge — may return a value or `{ type, value }` (see docs/_callArkTS). */
export type CallArkTSFunction = (
  method: string,
  returnType: string,
  args: unknown[],
) => unknown;

/** Unwrap `callArkTSFunction` result envelope. */
export function unwrapCallArkTSValue(raw: unknown): unknown {
  if (raw != null && typeof raw === 'object') {
    const envelope = raw as { type?: unknown; value?: unknown };
    if ('type' in envelope && 'value' in envelope) {
      return envelope.value;
    }
  }
  return raw;
}

/** Normalize ArkTS ConfigurationConstant.ColorMode (or bridge quirks) to OhosColorMode. */
export function parseOhosColorMode(raw: unknown): number {
  const v = unwrapCallArkTSValue(raw);
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'boolean') {
    return v ? OhosColorMode.DARK : OhosColorMode.LIGHT;
  }
  if (typeof v === 'string') {
    const upper = v.toUpperCase();
    if (upper.includes('DARK')) return OhosColorMode.DARK;
    if (upper.includes('LIGHT')) return OhosColorMode.LIGHT;
    if (upper.includes('NOT_SET')) return OhosColorMode.NOT_SET;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  if (v != null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('colorMode' in o) return parseOhosColorMode(o.colorMode);
    if ('value' in o) return parseOhosColorMode(o.value);
    if (typeof (o as { valueOf?: () => unknown }).valueOf === 'function') {
      const primitive = (o as { valueOf: () => unknown }).valueOf();
      if (primitive !== v) return parseOhosColorMode(primitive);
    }
  }
  return OhosColorMode.NOT_SET;
}

function fallbackColorModeFromNativeTheme(): number {
  return nativeTheme.shouldUseDarkColors ? OhosColorMode.DARK : OhosColorMode.LIGHT;
}

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
  if (process.platform === 'ohos' || process.platform === 'openharmony') return 'ohos';
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
    try {
      const raw = callArkTS(OHOS_NATIVE_GET_SYSTEM_THEME, 'number', []);
      const unwrapped = unwrapCallArkTSValue(raw);
      if (unwrapped != null && typeof unwrapped === 'object' && 'then' in (unwrapped as object)) {
        return fallbackColorModeFromNativeTheme();
      }
      const mode = parseOhosColorMode(unwrapped);
      if (mode === OhosColorMode.NOT_SET) {
        return fallbackColorModeFromNativeTheme();
      }
      return mode;
    } catch (err) {
      console.warn('[theme] GetSystemNativeTheme failed, using nativeTheme fallback', err);
      return fallbackColorModeFromNativeTheme();
    }
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
