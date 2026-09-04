import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

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
    test('global editor cleanup suspends preview layout without exiting the selected Browser tab', () => {
        const cleanupSource = sourceBetween(
            rendererHtml,
            'function closeAllEditorOverlays()',
            "document.addEventListener('sidebar-visibility-changed'"
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
