import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { updateStreamingText } from '../../../renderer/utils/streaming-text.js';
import { enhanceCodeBlocks } from '../../../renderer/components/previewer.js';

const clipboard = jest.fn(async (_text: string) => undefined);

describe('streaming Markdown snapshots', () => {
    beforeAll(() => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, { document: window.document, Node: window.Node });
        Object.defineProperty(globalThis, 'navigator', {
            value: { clipboard: { writeText: clipboard } },
            configurable: true
        });
    });

    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(async () => {
        await jest.runOnlyPendingTimersAsync();
        jest.useRealTimers();
    });

    function code(text: string, preview = false): string {
        const attrs = preview
            ? ` data-previewable="true" data-preview-lang="svg" data-raw-code="${Buffer.from(text).toString('base64')}"`
            : '';
        return `<div class="code-block-wrapper"${attrs}><div class="code-block-header">Code</div><div class="code-block-body"><pre class="code-block-pre"><code class="code-lines"><span class="code-line">${text.replaceAll('<', '&lt;')}</span></code></pre></div></div>`;
    }

    test('keeps copy listeners and preview state when another block grows', async () => {
        const container = document.createElement('div');
        const source = code('<svg><text>Hello</text></svg>', true);
        updateStreamingText(container, source + '<p>Tail</p>');
        enhanceCodeBlocks(container);
        const copy = container.querySelector<HTMLButtonElement>('.code-copy-btn')!;
        const preview = container.querySelector('.code-preview-shadow-host');
        const toggle = container.querySelector<HTMLInputElement>('.code-preview-toggle-input')!;
        toggle.checked = false;
        toggle.dispatchEvent(new document.defaultView!.Event('change'));
        updateStreamingText(container, source + '<p>Tail grows</p>');
        enhanceCodeBlocks(container);
        expect(container.querySelector('.code-preview-shadow-host')).toBe(preview);
        expect(container.querySelector('.code-copy-btn')).toBe(copy);
        expect(toggle.checked).toBe(false);
        expect(container.querySelector<HTMLElement>('.code-block-body')!.style.display).toBe('');
        copy.click();
        await Promise.resolve();
        expect(clipboard).toHaveBeenLastCalledWith('<svg><text>Hello</text></svg>');
        expect(copy.classList.contains('code-copy-btn--copied')).toBe(true);
        await jest.advanceTimersByTimeAsync(1500);
        expect(copy.classList.contains('code-copy-btn--copied')).toBe(false);
    });

    test('rebuilds a changed code block so its copy handler reads the new body', () => {
        const container = document.createElement('div');
        updateStreamingText(container, code('old'));
        enhanceCodeBlocks(container);
        const old = container.querySelector('.code-copy-btn');
        updateStreamingText(container, code('new'));
        enhanceCodeBlocks(container);
        const button = container.querySelector<HTMLButtonElement>('.code-copy-btn')!;
        expect(button).not.toBe(old);
        button.click();
        expect(clipboard).toHaveBeenLastCalledWith('new');
        expect(container.querySelectorAll('.code-copy-btn')).toHaveLength(1);
    });

    test('legacy persisted table structure still copies code (old task rendered HTML)', () => {
        const container = document.createElement('div');
        // 旧版 messages.ts 渲染的逐行表格结构，随任务 JSON 持久化，历史消息会原样加载
        container.innerHTML =
            '<div class="code-block-wrapper"><div class="code-block-header">Code</div>' +
            '<div class="code-block-body"><table class="code-table"><tbody>' +
            '<tr><td class="code-ln">1</td><td class="code-line">legacy-line-1</td></tr>' +
            '<tr><td class="code-ln">2</td><td class="code-line">legacy-line-2</td></tr>' +
            '</tbody></table></div></div>';
        enhanceCodeBlocks(container);
        const copy = container.querySelector<HTMLButtonElement>('.code-copy-btn')!;
        copy.click();
        expect(clipboard).toHaveBeenLastCalledWith('legacy-line-1\nlegacy-line-2');
    });

    test('updates earlier blocks when later Markdown resolves references or changes structure', () => {
        const container = document.createElement('div');
        const snapshots = [
            '<p>[link][ref]</p><p>Heading</p>',
            '<p><a href="https://example.com">link</a></p><h2>Heading</h2>',
            '<ul><li>one</li><li>two</li></ul>\n<table><tbody><tr><td>x</td></tr></tbody></table>',
            '<!-- comment -->text<p>replacement &amp; suffix</p>',
            ''
        ];
        for (const html of snapshots) {
            updateStreamingText(container, html);
            const expected = document.createElement('div');
            expected.innerHTML = html;
            expect(container.innerHTML).toBe(expected.innerHTML);
        }
    });

    test('handles history replacement and externally removed nodes', () => {
        const container = document.createElement('div');
        updateStreamingText(container, '<p>one</p><p>two</p>');
        container.innerHTML = '<p>history reload</p>';
        updateStreamingText(container, '<p>one</p><p>two</p>');
        expect(container.innerHTML).toBe('<p>one</p><p>two</p>');
        container.firstChild!.remove();
        updateStreamingText(container, '<p>one</p><p>two</p>');
        expect(container.innerHTML).toBe('<p>one</p><p>two</p>');
    });

    test('identical snapshots do not parse HTML or mutate content', () => {
        const container = document.createElement('div');
        updateStreamingText(container, '<p>same</p>');
        const original = container.firstChild;
        const create = jest.spyOn(document, 'createElement');
        updateStreamingText(container, '<p>same</p>');
        expect(create).not.toHaveBeenCalled();
        expect(container.firstChild).toBe(original);
        create.mockRestore();
    });

    test('stream cursor at container end keeps stable blocks and stays last', () => {
        const container = document.createElement('div');
        updateStreamingText(container, '<p>one</p><p>two</p>');
        const first = container.children[0];
        const second = container.children[1];
        // taskview 每快照把流式光标追加到容器末尾；它不属于任何 Markdown 块，
        // 不能破坏头部冻结（否则每快照全量重建，超长回合下打脏整棵样式树）。
        container.insertAdjacentHTML('beforeend', '<span class="stream-cursor"></span>');
        updateStreamingText(container, '<p>one</p><p>two</p><p>three</p>');
        expect(container.children[0]).toBe(first);
        expect(container.children[1]).toBe(second);
        expect(container.children[2].textContent).toBe('three');
        expect(container.lastElementChild!.classList.contains('stream-cursor')).toBe(true);
        expect(container.querySelectorAll('.stream-cursor')).toHaveLength(1);
    });

    test('stream cursor inside the last block keeps earlier blocks and updates the tail', () => {
        const container = document.createElement('div');
        updateStreamingText(container, '<p>one</p><p>tail</p>');
        const first = container.children[0];
        container
            .querySelector('p:last-of-type')!
            .insertAdjacentHTML('beforeend', '<span class="stream-cursor"></span>');
        updateStreamingText(container, '<p>one</p><p>tail grows</p>');
        expect(container.children[0]).toBe(first);
        expect(container.textContent).toBe('onetail grows');
        expect(container.querySelectorAll('.stream-cursor')).toHaveLength(0);
    });
});
