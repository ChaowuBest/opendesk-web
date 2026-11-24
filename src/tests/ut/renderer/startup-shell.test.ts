import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createTranslatorForBrowser } from '../../../main/applications/browser/locale/renderer.js';
import { createRendererTranslator, notifyRendererSettingChanged } from '../../../renderer/locale.js';

const rendererHtml = readFileSync(new URL('../../../renderer/index.html', import.meta.url), 'utf8');
const rendererEntry = readFileSync(new URL('../../../renderer/scripts/index.js', import.meta.url), 'utf8');

function sourceBetween(source: string, start: string, end: string): string {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    return source.slice(startIndex, endIndex);
}

describe('renderer startup shell', () => {
    test('uses the saved language in the shared browser translator at startup', async () => {
        notifyRendererSettingChanged({ locale: 'en-US' });
        const shell = vm.createContext({
            window: { settingAPI: { loadSettingObject: async () => ({ locale: 'zh-CN' }) } },
            createRendererTranslator,
            notifyRendererSettingChanged,
            onLocalePacksChanged: undefined
        });

        try {
            vm.runInContext(
                sourceBetween(rendererEntry, '// 暴露翻译器实例', '// 启动时把持久化的快速截图开关'),
                shell
            );
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(createTranslatorForBrowser()('renderer.browser.certWarning.title')).toBe('无法验证此网站的身份');
        } finally {
            notifyRendererSettingChanged({ locale: 'en-US' });
        }
    });

    test('expanding navigation does not invoke preview cleanup', () => {
        const suspendPreviewLayout = jest.fn();
        const document = Object.assign(new EventTarget(), {
            querySelectorAll: () => [{ suspendPreviewLayout }]
        });
        const shell = vm.createContext({ document });
        vm.runInContext(
            sourceBetween(rendererHtml, 'function closeAllEditorOverlays()', 'async function openTask('),
            shell
        );

        document.dispatchEvent(new CustomEvent('sidebar-visibility-changed', { detail: { collapsed: false } }));

        expect(suspendPreviewLayout).not.toHaveBeenCalled();
        // Explicit cleanup remains available when switching tasks or applications.
        vm.runInContext('closeAllEditorOverlays()', shell);
        expect(suspendPreviewLayout).toHaveBeenCalledTimes(1);
    });

    test('global editor cleanup suspends preview layout without exiting the selected Browser tab', () => {
        const cleanupSource = sourceBetween(
            rendererHtml,
            'function closeAllEditorOverlays()',
            'async function openTask('
        );

        expect(cleanupSource).toContain('suspendPreviewLayout');
        expect(cleanupSource).not.toContain('el.exitPreview()');
    });

    test('renders a dependency-free shell before the renderer module loads', () => {
        const shellSource = sourceBetween(rendererHtml, '<div id="startup-shell"', 'id="app-root"');

        expect(rendererHtml.indexOf('id="startup-shell-styles"')).toBeLessThan(
            rendererHtml.indexOf('src="./scripts/index.js"')
        );
        expect(shellSource).not.toMatch(/<(splitter-widget|main-sidebar|home-page)\b/);
        expect(shellSource).toContain('aria-hidden="true"');
    });

    test('keeps the real application hidden and inert until its critical elements are ready', () => {
        expect(rendererHtml).toMatch(
            /<div\s+id="app-root"[^>]*\binert\b[^>]*aria-hidden="true"[^>]*style="[^"]*opacity:\s*0/
        );
        expect(rendererEntry).toContain("customElements.whenDefined('splitter-widget')");
        expect(rendererEntry).toContain("customElements.whenDefined('main-sidebar')");
        expect(rendererEntry).toContain("customElements.whenDefined('home-page')");
        expect(rendererEntry).toContain('await waitForInitialHomeContent()');
        expect(rendererEntry).toContain('new MutationObserver');
        expect(rendererEntry).toContain("appRoot.removeAttribute('inert')");
        expect(rendererEntry).toContain("appRoot.removeAttribute('aria-hidden')");
    });

    test('cross-fades only after two animation frames and removes the shell', () => {
        const revealSource = sourceBetween(
            rendererEntry,
            'async function revealStartupShell()',
            'void revealStartupShell()'
        );

        expect(revealSource.match(/requestAnimationFrame/g)).toHaveLength(2);
        expect(revealSource).toContain("appRoot.style.opacity = '1'");
        expect(revealSource).toContain("startupShell.classList.add('startup-shell-hidden')");
        expect(revealSource).toContain('startupShell.remove()');
    });
});
