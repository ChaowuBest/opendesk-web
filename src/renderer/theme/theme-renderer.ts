/**
 * Renderer: apply resolved theme to DOM and child iframes.
 */

import type { ResolvedTheme, ThemeAppearance } from './theme-manager.js';

export function applyResolvedTheme(resolved: ResolvedTheme, doc: Document = document): void {
    const effective: ThemeAppearance = resolved.effective;
    doc.documentElement.dataset.theme = effective;
    doc.documentElement.style.colorScheme = effective;
}

/** Broadcast to application iframes (same pattern as font settings). */
export function broadcastThemeSettings(resolved: ResolvedTheme): void {
    const payload = { type: 'THEME_SETTINGS', theme: resolved.effective, resolved };
    const cache = (window as Window & { appFrameCache?: Record<string, HTMLIFrameElement> }).appFrameCache;
    if (cache) {
        Object.values(cache).forEach((iframe) => {
            iframe.contentWindow?.postMessage(payload, '*');
        });
    }
    window.postMessage(payload, '*');
}

declare global {
    interface Window {
        themeAPI?: {
            getResolvedTheme: () => Promise<{ status: string; data?: ResolvedTheme; message?: string }>;
            setPreference: (pref: string) => Promise<{ status: string; data?: ResolvedTheme; message?: string }>;
            onThemeChanged: (callback: (resolved: ResolvedTheme) => void) => () => void;
        };
        broadcastThemeSettings?: (resolved: ResolvedTheme) => void;
        appFrameCache?: Record<string, HTMLIFrameElement>;
    }
}

export async function initRendererTheme(): Promise<ResolvedTheme> {
    if (!window.themeAPI) {
        throw new Error('themeAPI is not exposed in preload');
    }
    const result = await window.themeAPI.getResolvedTheme();
    if (result.status !== 'ok' || !result.data) {
        throw new Error(result.message || 'theme:getResolvedTheme failed');
    }
    applyResolvedTheme(result.data);
    window.broadcastThemeSettings = broadcastThemeSettings;
    broadcastThemeSettings(result.data);

    window.themeAPI.onThemeChanged((resolved) => {
        applyResolvedTheme(resolved);
        broadcastThemeSettings(resolved);
    });

    return result.data;
}
