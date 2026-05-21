/**
 * Shadow DOM 子应用深色主题（如 skillmgr-entry-widget）。
 * 仅覆盖壳层与对比度，避免 !important 刷掉卡片/图标原有样式。
 */

import type { ThemeAppearance } from './theme-manager.js';

export const SHADOW_THEME_STYLE_ID = 'opendesk-theme-host-style';

export const SHADOW_HOST_SELECTORS = ['skillmgr-entry-widget'] as const;

const SKILLMGR_DARK_CSS = `
:host {
    color-scheme: dark;
    background: #1e1e1e !important;
    color: #cccccc !important;
}
.header-area {
    background: rgba(37, 37, 38, 0.95) !important;
    border-bottom: 1px solid rgba(255, 255, 255, 0.2) !important;
}
.header-title {
    color: #cccccc !important;
    -webkit-text-fill-color: #cccccc !important;
    background: none !important;
}
.seg-control {
    background: #333333 !important;
}
.seg-item { color: rgba(255, 255, 255, 0.55) !important; }
.seg-item.active {
    background: #252526 !important;
    color: #fff !important;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35) !important;
}
.action-btn {
    background: #333333 !important;
    border-color: rgba(255, 255, 255, 0.2) !important;
    color: #cccccc !important;
}
.search-input {
    background: #333333 !important;
    border-color: rgba(255, 255, 255, 0.2) !important;
    color: #cccccc !important;
}
.search-input::placeholder { color: #9d9d9d !important; }
.skill-card {
    background: #252526 !important;
    border-color: rgba(255, 255, 255, 0.18) !important;
    color: #cccccc !important;
}
.card-name, .detail-name, .hero-title, .empty-title { color: #cccccc !important; }
.card-id, .card-desc, .empty-hint, .loading-state, .loading-more { color: #9d9d9d !important; }
.add-dropdown, .modal-dialog, .detail-dialog {
    background: #252526 !important;
    border-color: rgba(255, 255, 255, 0.2) !important;
    color: #cccccc !important;
}
.url-dialog-overlay, .detail-overlay { background: rgba(0, 0, 0, 0.55) !important; }
`;

function cssForHost(tagName: string, effective: ThemeAppearance): string {
    if (effective !== 'dark') {
        return '';
    }
    if (tagName === 'skillmgr-entry-widget') {
        return SKILLMGR_DARK_CSS;
    }
    return `
:host {
    color-scheme: dark;
    background: #1e1e1e !important;
    color: #cccccc !important;
}
`;
}

export function syncShadowHostTheme(host: HTMLElement, effective?: ThemeAppearance): void {
    const theme =
        effective ??
        ((host.closest('[data-theme]') as HTMLElement | null)?.dataset.theme as ThemeAppearance | undefined) ??
        (document.documentElement.dataset.theme as ThemeAppearance | undefined) ??
        'light';

    host.dataset.theme = theme;
    const root = host.shadowRoot;
    if (!root) {
        return;
    }

    const css = cssForHost(host.tagName.toLowerCase(), theme);
    let styleEl = root.getElementById(SHADOW_THEME_STYLE_ID) as HTMLStyleElement | null;
    if (!css) {
        styleEl?.remove();
        return;
    }
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = SHADOW_THEME_STYLE_ID;
        root.insertBefore(styleEl, root.firstChild);
    }
    styleEl.textContent = css;
}

export function applyThemeToAllShadowHosts(effective: ThemeAppearance): void {
    for (const selector of SHADOW_HOST_SELECTORS) {
        document.querySelectorAll(selector).forEach((el) => {
            syncShadowHostTheme(el as HTMLElement, effective);
        });
    }
}
