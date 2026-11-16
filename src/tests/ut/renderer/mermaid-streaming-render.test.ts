import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

type PreviewerModule = typeof import('../../../renderer/components/previewer.js');

let resolveRender: ((value: { svg: string }) => void) | undefined;
const pendingRender = new Promise<{ svg: string }>((resolve) => {
    resolveRender = resolve;
});
const initialize = jest.fn();
const render = jest.fn<(id: string, code: string, container?: HTMLElement) => Promise<{ svg: string }>>(
    () => pendingRender
);
const writeText = jest.fn<(text: string) => Promise<void>>(async () => {});
// 生产 preload 的 setting:changed 是共享分发（settingChangedDispatcher 多播），
// 桩需保存全部订阅者（previewer 与 locale.ts 都会订阅）并保留触发入口
let settingChangedSubscribers: Array<(setting: { resolved_locale: string }) => void> = [];
const notifySettingChanged = (setting: { resolved_locale: string }): void => {
    for (const subscriber of [...settingChangedSubscribers]) subscriber(setting);
};
const customStyles = readFileSync(new URL('../../../renderer/styles/custom.css', import.meta.url), 'utf8');

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
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: { clipboard: { writeText } }
        });
        Object.assign(window, {
            settingAPI: {
                loadSettingObject: async () => ({ resolved_locale: 'en-US' }),
                onSettingChanged: (callback: (setting: { resolved_locale: string }) => void) => {
                    settingChangedSubscribers.push(callback);
                    return () => {
                        settingChangedSubscribers = settingChangedSubscribers.filter((item) => item !== callback);
                    };
                }
            }
        });
        ({ renderMermaidBlocks } = await import('../../../renderer/components/previewer.js'));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    test('does not give Mermaid copy and preview controls competing automatic margins', () => {
        expect(customStyles).toContain('.markdown-body .code-block-header .code-copy-btn:last-child');
        expect(customStyles).not.toMatch(/\.markdown-body \.code-copy-btn:last-child\s*\{/);
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

        const renderHost = render.mock.calls[0]?.[2];
        expect(renderHost?.isConnected).toBe(true);
        expect(renderHost?.style.visibility).toBe('hidden');
        expect(root.querySelector('.mermaid-fallback')?.textContent).toBe(source);

        try {
            expect(render).toHaveBeenCalledTimes(1);
        } finally {
            resolveRender?.({
                svg: '<svg viewBox="0 0 120 60"><style>.node{fill:#ececff;}</style><rect class="node" /></svg>'
            });
        }
        await waitUntil(() => root.querySelector<HTMLElement>('.mermaid-block')?.dataset.mermaidRendered === 'true');
        expect(renderHost?.isConnected).toBe(false);

        root.innerHTML = `<div class="mermaid-block" data-mermaid-code="${encoded}"></div>`;
        renderMermaidBlocks(root);

        const rebuilt = root.querySelector<HTMLElement>('.mermaid-block');
        expect(rebuilt?.dataset.mermaidRendered).toBe('true');
        expect(
            rebuilt?.querySelector<HTMLElement>('.mermaid-rendered')?.shadowRoot?.querySelector('svg')
        ).not.toBeNull();
        expect(render).toHaveBeenCalledTimes(1);
    });

    test('keeps incomplete streamed Mermaid as source without starting a render', async () => {
        const source = 'flowchart LR\nPendingA --> PendingB';
        const encoded = Buffer.from(source).toString('base64');
        const root = document.createElement('div');
        root.innerHTML = `<div class="mermaid-block" data-mermaid-code="${encoded}" data-mermaid-complete="false"></div>`;
        const renderCallsBefore = render.mock.calls.length;

        renderMermaidBlocks(root);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(render.mock.calls.length).toBe(renderCallsBefore);
        expect(root.querySelector('.mermaid-fallback')?.textContent).toBe(source);
        expect(root.querySelector('.mermaid-rendered')).toBeNull();
    });

    test('defers completed Mermaid while the message is still streaming', async () => {
        render.mockImplementation(async () => ({
            svg: '<svg viewBox="0 0 120 60"><rect /></svg>'
        }));
        const source = 'flowchart LR\nDeferredA --> DeferredB';
        const encoded = Buffer.from(source).toString('base64');
        const root = document.createElement('div');
        root.innerHTML = `<div class="mermaid-block" data-mermaid-code="${encoded}" data-mermaid-complete="true"></div>`;
        const renderCallsBefore = render.mock.calls.length;

        renderMermaidBlocks(root, { defer: true });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(render.mock.calls.length).toBe(renderCallsBefore);
        expect(root.querySelector('.mermaid-fallback')?.textContent).toBe(source);
        expect(root.querySelector<HTMLElement>('.mermaid-block')?.dataset.mermaidDeferred).toBe('true');

        renderMermaidBlocks(root);
        await waitUntil(() => root.querySelector<HTMLElement>('.mermaid-block')?.dataset.mermaidRendered === 'true');
        expect(render.mock.calls.length).toBe(renderCallsBefore + 1);
        expect(root.querySelector('.mermaid-rendered')).not.toBeNull();
    });

    test('reinitializes Mermaid and rerenders connected blocks when the theme changes', async () => {
        render.mockImplementation(async () => ({
            svg: '<svg viewBox="0 0 120 60"><style>.node{fill:#ececff;}</style><rect class="node" /></svg>'
        }));
        document.documentElement.dataset.theme = 'light';
        const source = 'flowchart LR\nThemeA --> ThemeB';
        const encoded = Buffer.from(source).toString('base64');
        const root = document.createElement('div');
        root.innerHTML = `<div class="mermaid-block" data-mermaid-code="${encoded}"></div>`;
        document.body.appendChild(root);

        const renderCallsBefore = render.mock.calls.length;
        renderMermaidBlocks(root);
        await waitUntil(() => root.querySelector<HTMLElement>('.mermaid-block')?.dataset.mermaidTheme === 'light');
        const previewToggle = root.querySelector<HTMLInputElement>('.code-preview-toggle-input');
        expect(previewToggle).not.toBeNull();
        previewToggle!.checked = false;

        document.documentElement.dataset.theme = 'dark';
        document.dispatchEvent(
            new window.CustomEvent('opendesk-theme-changed', {
                detail: { effective: 'dark' }
            })
        );

        await waitUntil(() => root.querySelector<HTMLElement>('.mermaid-block')?.dataset.mermaidTheme === 'dark');

        expect(render.mock.calls.length).toBe(renderCallsBefore + 2);
        expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));
        expect(root.querySelector<HTMLInputElement>('.code-preview-toggle-input')?.checked).toBe(false);

        document.dispatchEvent(
            new window.CustomEvent('opendesk-theme-changed', {
                detail: { effective: 'dark' }
            })
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(render.mock.calls.length).toBe(renderCallsBefore + 2);
        root.remove();
    });

    test('copies Mermaid source and localizes visible controls after a locale change', async () => {
        notifySettingChanged?.({ resolved_locale: 'en-US' });
        render.mockImplementation(async () => ({
            svg: '<svg viewBox="0 0 120 60"><rect /></svg>'
        }));
        const source = 'flowchart LR\nLocaleA --> LocaleB';
        const encoded = Buffer.from(source).toString('base64');
        const root = document.createElement('div');
        root.innerHTML = `<div class="mermaid-block" data-mermaid-code="${encoded}"></div>`;
        document.body.appendChild(root);

        renderMermaidBlocks(root);
        await waitUntil(() => root.querySelector<HTMLElement>('.mermaid-block')?.dataset.mermaidRendered === 'true');

        const toggle = root.querySelector<HTMLLabelElement>('.code-preview-toggle');
        const copyButton = root.querySelector<HTMLButtonElement>('.mermaid-block-header .code-copy-btn');
        expect(toggle?.hasAttribute('title')).toBe(false);
        expect(root.querySelector('.code-preview-toggle-label')?.textContent).toBe('Preview');
        expect(copyButton?.hasAttribute('title')).toBe(false);
        expect(copyButton?.getAttribute('aria-label')).toBe('Copy');

        jest.useFakeTimers();
        try {
            copyButton?.click();
            await Promise.resolve();
            expect(writeText).toHaveBeenLastCalledWith(source);
            expect(copyButton?.classList.contains('code-copy-btn--copied')).toBe(true);
            jest.runOnlyPendingTimers();
        } finally {
            jest.useRealTimers();
        }

        notifySettingChanged?.({ resolved_locale: 'zh-CN' });
        expect(toggle?.hasAttribute('title')).toBe(false);
        expect(root.querySelector('.code-preview-toggle-label')?.textContent).toBe('预览');
        expect(copyButton?.getAttribute('aria-label')).toBe('复制');
        root.remove();
    });
});
