import { composeCardSrcDoc, hasCardContent } from '../../../renderer/components/desktop/cardContent.js';
import { buildDesktopStyles } from '../../../renderer/components/desktop/desktopStyles.js';
import { nextThemePreference } from '../../../renderer/components/desktop/desktopTheme.js';
import { readFileSync } from 'node:fs';

const immersiveDesktopSource = readFileSync(
    new URL('../../../renderer/components/desktop/immersiveDesktop.ts', import.meta.url),
    'utf8'
);
const desktopEffectsSource = readFileSync(
    new URL('../../../renderer/components/desktop/desktopEffects.ts', import.meta.url),
    'utf8'
);
const desktopEntrySource = readFileSync(
    new URL('../../../renderer/components/desktop/entry.ts', import.meta.url),
    'utf8'
);
const titlebarStylesSource = readFileSync(new URL('../../../renderer/styles/titlebar.css', import.meta.url), 'utf8');

describe('immersive desktop card srcdoc composition', () => {
    test('cycles theme preferences in the same order as the main sidebar', () => {
        expect(nextThemePreference('light')).toBe('dark');
        expect(nextThemePreference('dark')).toBe('system');
        expect(nextThemePreference('system')).toBe('light');
    });

    test('provides a localized theme toggle without changing native fullscreen state', () => {
        expect(immersiveDesktopSource).toContain('data-desktop-theme-toggle');
        expect(immersiveDesktopSource).toContain('globalWindow.themeAPI.setPreference(next)');
        expect(immersiveDesktopSource).toContain("'renderer.sidebar.themeToggleToLight'");
        expect(immersiveDesktopSource).not.toContain('enterFullscreen');
        expect(immersiveDesktopSource).not.toContain('exitFullscreen');
        expect(immersiveDesktopSource).not.toContain('settingAPI?.setFullscreen');
    });

    test('generated card styling uses one-shot entrance animation and hover-only title overlay', () => {
        const styles = buildDesktopStyles();
        expect(styles).toContain('.od-card.od-card-enter { animation: od-card-in');
        expect(styles).toContain('.od-card.od-card-done .od-card-header');
        expect(styles).toContain('.od-card.od-card-done:hover .od-card-header');
        expect(styles).toContain('.od-card.od-card-done .od-card-body { margin: 0; }');
        expect(styles).not.toContain('.od-card.od-card-done { border-color: rgba(16, 185, 129');
    });

    test('uses the main interface semantic palette and restrained desktop surfaces', () => {
        const styles = buildDesktopStyles();
        expect(styles).toContain('--od-ink: var(--od-text, #1f2937);');
        expect(styles).toContain('--od-blue: var(--od-accent, #3b82f6);');
        expect(styles).toContain('--od-panel: var(--od-bg-elevated, #ffffff);');
        expect(styles).not.toContain('.od-blob');
        expect(styles).not.toContain('var(--od-violet)');
    });

    test('uses one coherent spatial transition without confetti-style particles', () => {
        const styles = buildDesktopStyles();
        expect(styles).toContain('clip-path: inset(');
        expect(styles).toContain('immersive-desktop.od-leaving');
        expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
        expect(desktopEffectsSource).not.toContain('spawnParticles');
        expect(desktopEffectsSource).toContain('data-desktop-transition');
    });

    test('uses the compact embedded task layout inside floating conversation windows', () => {
        const styles = buildDesktopStyles();
        const embeddedTaskMounts = immersiveDesktopSource.match(/<task-view embedded task_id=/g) ?? [];

        expect(embeddedTaskMounts).toHaveLength(2);
        expect(styles).toContain('.od-floating-window-content > task-view');
        expect(styles).toContain('width: 100%; height: 100%;');
        expect(styles).toContain('min-width: 0; min-height: 0; overflow: hidden;');
    });

    test('mounts the desktop under the main app root so embedded conversations inherit the main theme', () => {
        expect(desktopEntrySource).toContain("document.getElementById('app-root') ?? document.body");
        expect(desktopEntrySource).toContain('desktopHost.appendChild(desktop);');
    });

    test('keeps desktop toolbar controls outside the native window drag region', () => {
        const styles = buildDesktopStyles();

        expect(immersiveDesktopSource).toContain("document.body.classList.add('immersive-desktop-open');");
        expect(immersiveDesktopSource).toContain("document.body.classList.remove('immersive-desktop-open');");
        expect(titlebarStylesSource).toMatch(/body\.immersive-desktop-open\s+\.drag-overlay\s*\{[^}]*display:\s*none;/);
        expect(styles).toMatch(/\.od-topbar\s*\{[^}]*-webkit-app-region:\s*drag;/);
        expect(styles).toMatch(/\.od-status,\s*\.od-status\s+\*\s*\{[^}]*-webkit-app-region:\s*no-drag;/);
    });

    test('keeps the card grid equally inset from the header, sides, and dock', () => {
        const styles = buildDesktopStyles();

        expect(styles).toContain('--od-grid-edge: 28px;');
        expect(styles).toContain('--od-grid-card-inset: 8px;');
        expect(styles).toContain('padding-inline: calc(var(--od-grid-edge) - var(--od-grid-card-inset));');
        expect(styles).toContain('gap: calc(var(--od-grid-edge) - var(--od-grid-card-inset));');
        expect(styles).toContain(
            'padding-bottom: calc(var(--od-dock-bottom) + var(--od-dock-height) + var(--od-grid-edge) - var(--od-grid-card-inset));'
        );
        expect(styles).toMatch(/\.od-topbar\s*\{[^}]*border-bottom:\s*1px solid var\(--od-card-line\);/);
    });

    test('uses one compact pill dock without prompt suggestions', () => {
        const styles = buildDesktopStyles();

        expect(immersiveDesktopSource).not.toContain('SUGGESTION_KEYS');
        expect(immersiveDesktopSource).not.toContain('data-suggests');
        expect(immersiveDesktopSource).not.toContain('data-suggest=');
        expect(styles).not.toContain('.od-suggests');
        expect(styles).not.toContain('.od-sug');
        expect(styles).toMatch(/\.od-dock\s*\{[^}]*border-radius:\s*999px;/);
        expect(styles).toMatch(/\.od-icon-btn\s*\{[^}]*border-radius:\s*50%;/);
    });

    test('opens a main-interface-style application menu above the launcher button', () => {
        const styles = buildDesktopStyles();

        expect(immersiveDesktopSource).toMatch(
            /<div class="od-dock">[\s\S]*<div class="od-applist"[^>]*data-applist[^>]*><\/div>[\s\S]*data-apps-btn/
        );
        expect(immersiveDesktopSource).toContain('<rect x="3" y="3" width="7" height="7" rx="3.5"/>');
        expect(immersiveDesktopSource).toContain('`./applications/${app.bundleName}/icon.svg`');
        expect(immersiveDesktopSource).toContain("'./applications/default_icon.png'");
        expect(styles).toMatch(/\.od-applist\s*\{[^}]*bottom:\s*calc\(100% \+ 8px\);[^}]*width:\s*220px;/);
        expect(styles).toMatch(/\.od-applist-item\s*\{[^}]*flex-direction:\s*row;/);
    });

    test('matches the main application menu scrollbar in light and dark themes', () => {
        const styles = buildDesktopStyles();

        expect(styles).toMatch(/\.od-applist::-webkit-scrollbar\s*\{[^}]*width:\s*4px;/);
        expect(styles).toMatch(/\.od-applist::-webkit-scrollbar-track\s*\{[^}]*background:\s*transparent;/);
        expect(styles).toMatch(
            /immersive-desktop\.theme-dark \.od-applist::-webkit-scrollbar-thumb\s*\{[^}]*rgba\(255, 255, 255, 0\.18\)/
        );
        expect(styles).toMatch(
            /immersive-desktop\.theme-dark \.od-applist::-webkit-scrollbar-thumb:hover\s*\{[^}]*rgba\(255, 255, 255, 0\.28\)/
        );
    });

    test('only plays card entrance animations for the first card load, not a theme redraw', () => {
        const applyThemeSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private applyTheme(): void'),
            immersiveDesktopSource.indexOf('private getTheme():')
        );
        const loadCardsSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private async loadCards(): Promise<void>'),
            immersiveDesktopSource.indexOf('private normalizeCard(')
        );
        const renderCardsSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private renderCards('),
            immersiveDesktopSource.indexOf('private updateEmptyState(): void')
        );

        expect(applyThemeSource).toContain('this.renderCards(false);');
        expect(loadCardsSource).toContain('this.renderCards(true);');
        expect(renderCardsSource).toContain('private renderCards(enter = false): void');
        expect(renderCardsSource).toContain('this.createCardElement(card, enter)');
    });

    test('card stacking is restored after drag and resize snapping', () => {
        expect(immersiveDesktopSource).toContain('this.restoreCardStacking(element);');
        expect(immersiveDesktopSource).toContain("element.style.removeProperty('z-index');");
    });
    test('card links use the browser readiness-aware URL entry point', () => {
        expect(immersiveDesktopSource).toContain('browser?.openUrl?.(url);');
    });
    test('mounts and sizes card containers before loading iframe content', () => {
        const renderCardsSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private renderCards('),
            immersiveDesktopSource.indexOf('private updateEmptyState(): void')
        );
        const createCardSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private createCardElement('),
            immersiveDesktopSource.indexOf('private renderCardErrorBadge(')
        );
        const updateCardSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private updateSingleCard('),
            immersiveDesktopSource.indexOf('private beginCardRefresh(')
        );

        expect(renderCardsSource).toMatch(
            /stage\.appendChild\(element\);[\s\S]*this\.positionCardElement\(element, card\);[\s\S]*this\.renderCardContent\(element, card\);/
        );
        expect(createCardSource).not.toContain('this.renderCardContent(element, card);');
        expect(updateCardSource).toMatch(
            /existing\.replaceWith\(next\);[\s\S]*this\.positionCardElement\(next, card\);[\s\S]*this\.renderCardContent\(next, card\);/
        );
    });
    test('hides unconfigured cards without hiding configured cards awaiting generation', () => {
        expect(hasCardContent({ prompt: '', html: '' })).toBe(false);
        expect(hasCardContent({ prompt: '   ', html: '' })).toBe(false);
        expect(hasCardContent({ prompt: '天气', html: '' })).toBe(true);
        expect(hasCardContent({ prompt: '', html: '<div>已有内容</div>' })).toBe(true);
    });
    test('injects base style and link interceptor after <head> when present', () => {
        const html = '<!doctype html><html><head><title>x</title></head><body><p>hi</p></body></html>';
        const result = composeCardSrcDoc(html, 'light');
        expect(result).toContain('<head><style>');
        expect(result).toContain('html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;}');
        expect(result).toContain('color-scheme:light;');
        expect(result).toContain('od-open-link');
        // 原有内容保持完整
        expect(result).toContain('<title>x</title>');
    });

    test('pins generated card CSS to the current desktop theme instead of the operating system theme', () => {
        const html = '<html><head><style>:root{color-scheme:light dark}</style></head><body>card</body></html>';
        const result = composeCardSrcDoc(html, 'dark');
        expect(result).toContain("document.documentElement.dataset.theme='dark'");
    });

    test('falls back to <html> injection when head is missing', () => {
        const html = '<html><body><p>x</p></body></html>';
        const result = composeCardSrcDoc(html, 'dark');
        expect(result.startsWith('<html>')).toBe(true);
        expect(result).toContain('color-scheme:dark;');
        expect(result).toContain('od-open-link');
    });

    test('prepends injection for bare fragments', () => {
        const result = composeCardSrcDoc('<div>card</div>', 'light');
        expect(result.startsWith('<style>')).toBe(true);
        expect(result.endsWith('<div>card</div>')).toBe(true);
        expect(result).toContain('color-scheme:light;');
    });

    test('link interceptor captures clicks in capture phase and forwards to parent', () => {
        const result = composeCardSrcDoc('<a href="https://a.com">x</a>', 'light');
        expect(result).toContain("addEventListener('click'");
        expect(result).toContain(',true);');
        expect(result).toContain('e.preventDefault()');
        expect(result).toContain('parent.postMessage');
    });

    test('reflows generated content after its first stable frame', () => {
        const result = composeCardSrcDoc('<div id="chart"></div>', 'light');
        expect(result).toContain("addEventListener('load'");
        expect(result).toContain(
            "requestAnimationFrame(function(){requestAnimationFrame(function(){window.dispatchEvent(new Event('resize'));});});"
        );
    });
});
