/**
 * Renderer: apply resolved theme to DOM and child iframes.
 */

import type { ResolvedTheme } from './theme-manager.js';
import {
    applyThemeToDocument,
    broadcastThemeToAppFrames,
    installThemeMessageListener,
} from './theme-iframe-bridge.js';

export { applyThemeToDocument as applyResolvedTheme } from './theme-iframe-bridge.js';
export { broadcastThemeToAppFrames as broadcastThemeSettings } from './theme-iframe-bridge.js';

declare global {
    interface Window {
        themeAPI?: {
            getResolvedTheme: () => Promise<{ status: string; data?: ResolvedTheme; message?: string }>;
            setPreference: (pref: string) => Promise<{ status: string; data?: ResolvedTheme; message?: string }>;
            onThemeChanged: (callback: (resolved: ResolvedTheme) => void) => () => void;
        };
        broadcastThemeSettings?: (resolved: ResolvedTheme) => void;
    }
}

export async function initRendererTheme(): Promise<ResolvedTheme> {
    if (!window.themeAPI) {
        throw new Error('themeAPI is not exposed in preload');
    }

    installThemeMessageListener();
    window.broadcastThemeSettings = broadcastThemeToAppFrames;

    const result = await window.themeAPI.getResolvedTheme();
    if (result.status !== 'ok' || !result.data) {
        throw new Error(result.message || 'theme:getResolvedTheme failed');
    }

    applyThemeToDocument(result.data.effective);
    broadcastThemeToAppFrames(result.data);

    window.themeAPI.onThemeChanged((resolved) => {
        applyThemeToDocument(resolved.effective);
        broadcastThemeToAppFrames(resolved);
    });

    return result.data;
}
