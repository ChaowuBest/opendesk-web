import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

type PreviewerModule = typeof import('../../../renderer/components/previewer.js');

let resolveRender: ((value: { svg: string }) => void) | undefined;
const pendingRender = new Promise<{ svg: string }>((resolve) => {
    resolveRender = resolve;
});
const initialize = jest.fn();
const render = jest.fn<(id: string, code: string) => Promise<{ svg: string }>>(() => pendingRender);

jest.unstable_mockModule('mermaid', () => ({
    default: { initialize, render }
}));
jest.unstable_mockModule('dompurify', () => ({
    default: { sanitize: (svg: string) => svg }
}));

async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('condition was not reached');
}

describe('Mermaid rendering during streaming updates', () => {
    let renderMermaidBlocks: PreviewerModule['renderMermaidBlocks'];

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            SVGElement: window.SVGElement
        });
        ({ renderMermaidBlocks } = await import('../../../renderer/components/previewer.js'));
    });

    test('deduplicates in-flight work and restores rebuilt blocks from cache synchronously', async () => {
        const source = 'flowchart LR\nA --> B';
        const encoded = Buffer.from(source).toString('base64');
        const root = document.createElement('div');
        root.innerHTML = `<div class="mermaid-block" data-mermaid-code="${encoded}"></div>`;

        renderMermaidBlocks(root);
        renderMermaidBlocks(root);
        await waitUntil(() => render.mock.calls.length > 0);

        root.innerHTML = `<div class="mermaid-block" data-mermaid-code="${encoded}"></div>`;
        renderMermaidBlocks(root);
        await new Promise((resolve) => setTimeout(resolve, 0));

        try {
            expect(render).toHaveBeenCalledTimes(1);
        } finally {
            resolveRender?.({
                svg: '<svg viewBox="0 0 120 60"><style>.node{fill:#ececff;}</style><rect class="node" /></svg>'
            });
        }
        await waitUntil(() => root.querySelector<HTMLElement>('.mermaid-block')?.dataset.mermaidRendered === 'true');

        root.innerHTML = `<div class="mermaid-block" data-mermaid-code="${encoded}"></div>`;
        renderMermaidBlocks(root);

        const rebuilt = root.querySelector<HTMLElement>('.mermaid-block');
        expect(rebuilt?.dataset.mermaidRendered).toBe('true');
        expect(
            rebuilt?.querySelector<HTMLElement>('.mermaid-rendered')?.shadowRoot?.querySelector('svg')
        ).not.toBeNull();
        expect(render).toHaveBeenCalledTimes(1);
    });
});
