/**
 * 主题在子应用 iframe 间的传递（与 FONT_SETTINGS / broadcastFontSettings 同一机制）。
 */

import type { ResolvedTheme, ThemeAppearance } from './theme-manager.js';
import { applyThemeToAllShadowHosts } from './theme-shadow-overrides.js';

export const THEME_SETTINGS_MESSAGE = 'THEME_SETTINGS' as const;
export const OPENDESK_THEME_CHANGED = 'opendesk-theme-changed' as const;

export type ThemeSettingsMessage = {
    type: typeof THEME_SETTINGS_MESSAGE;
    theme: ThemeAppearance;
    resolved?: ResolvedTheme;
};

/** 子应用容器：iframe */
export type AppSubFrameElement = HTMLIFrameElement;

export function getAppSubFrameWindow(frame: AppSubFrameElement): Window | null {
    return frame.contentWindow ?? null;
}

declare global {
    interface Window {
        __appFrameCache?: Record<string, AppSubFrameElement>;
        broadcastThemeSettings?: (resolved: ResolvedTheme) => void;
        themeAPI?: {
            getResolvedTheme: () => Promise<{ status: string; data?: ResolvedTheme; message?: string }>;
            setPreference: (pref: string) => Promise<{ status: string; data?: ResolvedTheme; message?: string }>;
            onThemeChanged: (callback: (resolved: ResolvedTheme) => void) => () => void;
        };
    }
}

export function getAppFrameCache(): Record<string, AppSubFrameElement> {
    if (!window.__appFrameCache) {
        window.__appFrameCache = {};
    }
    return window.__appFrameCache;
}

export function buildThemeSettingsPayload(resolved: ResolvedTheme | ThemeAppearance): ThemeSettingsMessage {
    const effective = typeof resolved === 'string' ? resolved : resolved.effective;
    return {
        type: THEME_SETTINGS_MESSAGE,
        theme: effective,
        resolved: typeof resolved === 'string' ? undefined : resolved
    };
}

/** application.html 子应用 iframe：仅用 data-theme 驱动 CSS 变量，禁止 UA 自动深色化 */
export function isApplicationFrameDocument(doc: Document = document): boolean {
    return Boolean(doc.getElementById('application-container'));
}

export function applyThemeToDocument(effective: ThemeAppearance, doc: Document = document): void {
    const appFrame = isApplicationFrameDocument(doc);
    doc.documentElement.dataset.theme = effective;
    if (appFrame) {
        doc.documentElement.dataset.odAppFrame = '1';
    } else {
        delete doc.documentElement.dataset.odAppFrame;
    }
    const scheme = effective === 'dark' ? 'only light' : 'light';
    doc.documentElement.style.colorScheme = appFrame ? 'only light' : scheme;
    applyThemeToAllShadowHosts(effective);
    doc.dispatchEvent(new CustomEvent(OPENDESK_THEME_CHANGED, { detail: { effective }, bubbles: true }));
}

/** 向单个 iframe / 子窗口发送当前主题 */
export function postThemeToWindow(target: Window, resolved: ResolvedTheme | ThemeAppearance): void {
    target.postMessage(buildThemeSettingsPayload(resolved), '*');
}

/** 向当前可见/全部子应用 iframe 同步主题 */
export function broadcastThemeToAppFrames(resolved: ResolvedTheme): void {
    const payload = buildThemeSettingsPayload(resolved);
    for (const frame of Object.values(getAppFrameCache())) {
        getAppSubFrameWindow(frame)?.postMessage(payload, '*');
    }
    window.postMessage(payload, '*');
}

/** 切换回已缓存子应用时补发主题（避免仅 onload 时发送） */
export function syncThemeToAppFrame(frame: AppSubFrameElement): void {
    const effective = document.documentElement.dataset.theme as ThemeAppearance | undefined;
    const win = getAppSubFrameWindow(frame);
    if (effective && win) {
        postThemeToWindow(win, effective);
    }
}

/** 子应用页（application.html）监听主窗口 postMessage */
export function installThemeMessageListener(doc: Document = document): void {
    window.addEventListener('message', (e) => {
        if (e.data?.type === THEME_SETTINGS_MESSAGE && e.data.theme) {
            applyThemeToDocument(e.data.theme, doc);
        }
    });
}

/** 子应用启动：拉取主题 + 监听主进程变更（与字体 preset 初始化对称） */
export function initApplicationThemeHost(doc: Document = document): void {
    installThemeMessageListener(doc);

    void initApplicationThemeFromAPI();

    window.themeAPI?.onThemeChanged?.((resolved) => {
        applyThemeToDocument(resolved.effective, doc);
    });
}

/** 子应用启动时从 themeAPI 拉取并应用 */
export async function initApplicationThemeFromAPI(doc: Document = document): Promise<ThemeAppearance | null> {
    if (!window.themeAPI?.getResolvedTheme) {
        const inherited = doc.documentElement.dataset.theme as ThemeAppearance | undefined;
        if (inherited === 'dark' || inherited === 'light') {
            applyThemeToDocument(inherited, doc);
            return inherited;
        }
        return null;
    }
    try {
        const result = await window.themeAPI.getResolvedTheme();
        if (result.status === 'ok' && result.data) {
            applyThemeToDocument(result.data.effective, doc);
            return result.data.effective;
        }
    } catch (err) {
        console.warn('[theme] application init from themeAPI failed', err);
    }
    return null;
}
