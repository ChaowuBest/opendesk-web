import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import {
    buildChatFindDocuments,
    ChatFind,
    findChatTextMatches,
    readChatFindText,
    registerChatFindShortcut
} from '../../../renderer/components/chatFind.js';
import { guiShortcutManager } from '../../../renderer/components/shortcutManager.js';
import { enhanceCodeBlocks } from '../../../renderer/components/previewer.js';
import { renderCodeBlockHtml } from '../../../common/markdown/code-block-render.js';

beforeAll(() => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        Node: window.Node,
        HTMLElement: window.HTMLElement,
        Element: window.Element,
        MutationObserver: window.MutationObserver,
        CSS: { escape: (value: string) => value }
    });
});

const views: ChatFind[] = [];
afterEach(() => {
    views.splice(0).forEach((view) => view.destroy());
    document.body.innerHTML = '';
    guiShortcutManager.unregister('chat:find');
    jest.restoreAllMocks();
    jest.useRealTimers();
});

function part(text: string) {
    return { type: 'text', text };
}

describe('current conversation search', () => {
    test('literal matching covers Chinese, punctuation, whitespace and Unicode offsets', () => {
        expect(findChatTextMatches('中文中文 a+b A+B aab', 'a+b')).toEqual([
            { start: 5, end: 8 },
            { start: 9, end: 12 }
        ]);
        expect(findChatTextMatches('中文中文', '中文')).toHaveLength(2);
        expect(findChatTextMatches('hello\n  world', 'hello world')).toEqual([{ start: 0, end: 13 }]);
        expect(findChatTextMatches('İ KEY key 😀', 'key')).toEqual([
            { start: 2, end: 5 },
            { start: 6, end: 9 }
        ]);
        expect(findChatTextMatches('anything', '  ')).toEqual([]);
    });

    test('rendered text crosses inline markup, separates blocks and excludes code controls/numbers', () => {
        const root = document.createElement('div');
        root.innerHTML =
            '<p>hello <strong>world</strong></p><p>next</p>' +
            '<div class="code-block-header">TypeScript<button>Copy</button></div>' +
            '<pre><span class="code-line"><span class="code-line-number">1</span>const x = 1;</span>' +
            '<span class="code-line">next();</span></pre><script>secret</script>';
        const snapshot = readChatFindText(root);
        expect(snapshot.text).toContain('hello world\nnext');
        expect(snapshot.text).toContain('const x = 1;\nnext();');
        expect(snapshot.text).not.toMatch(/TypeScript|Copy|secret/);
    });

    test('Mermaid only indexes diagram labels, including a hidden preview in an open shadow root', () => {
        const root = document.createElement('div');
        root.innerHTML = '<div class="mermaid-block" data-mermaid-code="Z3JhcGggVEQ7IEEtLT5C"></div>';
        expect(readChatFindText(root).text).toBe('');
        root.firstElementChild!.innerHTML = '<pre class="mermaid-fallback">graph TD; A--&gt;B</pre>';
        expect(readChatFindText(root).text).toBe('');
        root.firstElementChild!.innerHTML =
            '<div class="mermaid-block-header">Mermaid</div>' +
            '<pre class="mermaid-source">graph TD; A[开始]--&gt;B[结束]</pre>' +
            '<div class="mermaid-rendered" style="display:none"></div>';
        const host = root.querySelector('.mermaid-rendered')!;
        host.textContent = 'not composed';
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML =
            '<svg><style>text {fill:red}</style><defs><text>definition</text></defs>' +
            '<text><tspan>开</tspan><tspan>始</tspan></text><text>结束</text></svg>';
        const snapshot = readChatFindText(root);
        expect(snapshot.text.trim()).toBe('开始\n结束');
        expect(snapshot.spans.at(-1)?.node).toBe(shadow.querySelector('svg')!.lastElementChild!.firstChild);
    });

    test('SVG previews exclude source syntax and controls regardless of the preview toggle', () => {
        const root = document.createElement('div');
        const source = '<svg><text>预览文字</text></svg>';
        root.innerHTML = renderCodeBlockHtml(source.replaceAll('<', '&lt;').replaceAll('>', '&gt;'), {
            lang: 'svg',
            preview: { langs: new Set(['svg']), rawCode: source }
        });
        enhanceCodeBlocks(root);
        expect(readChatFindText(root).text.trim()).toBe('预览文字');
        const toggle = root.querySelector<HTMLInputElement>('.code-preview-toggle-input')!;
        toggle.checked = false;
        toggle.dispatchEvent(new window.Event('change'));
        expect(root.querySelector<HTMLElement>('.code-preview-container')!.style.display).toBe('none');
        expect(readChatFindText(root).text.trim()).toBe('预览文字');
    });

    test('indexes full history text and projected supplements, excluding internal messages and non-text parts', () => {
        const messages = [
            {
                role: 'user',
                message_id: 'old',
                content: [part('**old** question'), { type: 'file', text: 'attachment' }]
            },
            {
                role: 'assistant',
                message_id: 'a',
                content: [
                    part('answer `code`'),
                    { type: 'reasoning', text: 'secret' },
                    { type: 'tool_call', text: 'tool' }
                ]
            },
            { role: 'user', message_id: 'hidden', internal: true, content: [part('internal')] },
            { role: 'assistant', message_id: 'hidden-a', internal: true, content: [part('internal')] },
            {
                role: 'user',
                message_id: 'supplement',
                internal: true,
                rawText: 'displayed',
                metadata: { origin: { reason: 'goal_supplement' } },
                content: [part('protocol')]
            }
        ];
        const docs = buildChatFindDocuments(messages);
        expect(docs.map((doc) => doc.messageId)).toEqual(['old', 'a', 'supplement']);
        expect(docs.map((doc) => doc.text.trim())).toEqual(['old question', 'answer code', 'displayed']);
    });

    function createFind(messages = [{ role: 'user', message_id: 'old', content: [part('hit hit')] }]) {
        const scope = document.createElement('div');
        scope.setAttribute('data-chat-find-scope', '');
        const viewport = document.createElement('div');
        const history = document.createElement('div');
        viewport.append(history);
        scope.append(viewport);
        document.body.append(scope);
        const ensureMessage = jest.fn();
        const pauseFollow = jest.fn();
        const find = new ChatFind(history, {
            getMessages: () => messages,
            ensureMessage,
            pauseFollow,
            translate: (key, params) => (params ? `${params.current}/${params.total}` : key)
        });
        views.push(find);
        return { find, history, scope, ensureMessage, pauseFollow, messages };
    }

    test('counts unrendered history, cycles every occurrence and closes at the current scroll position', () => {
        jest.useFakeTimers({ legacyFakeTimers: true });
        const { find, history, scope, ensureMessage, pauseFollow } = createFind();
        find.show();
        const input = scope.querySelector('input')!;
        input.value = 'hit';
        input.dispatchEvent(new window.Event('input'));
        jest.runAllTimers();
        expect(scope.querySelector('[role="status"]')?.textContent).toBe('1/2');
        expect(ensureMessage).toHaveBeenCalledWith('old');
        expect(pauseFollow).toHaveBeenCalled();
        const next = scope.querySelector<HTMLButtonElement>('[data-find-action="next"]')!;
        next.click();
        expect(scope.querySelector('[role="status"]')?.textContent).toBe('2/2');
        next.click();
        expect(scope.querySelector('[role="status"]')?.textContent).toBe('1/2');
        scope.querySelector<HTMLButtonElement>('[data-find-action="previous"]')!.click();
        expect(scope.querySelector('[role="status"]')?.textContent).toBe('2/2');
        history.scrollTop = 432;
        const close = scope.querySelector<HTMLButtonElement>('[data-find-action="close"]')!;
        const key = Object.assign(new window.Event('keydown', { bubbles: true, cancelable: true }), { key: 'Enter' });
        close.dispatchEvent(key);
        expect(key.defaultPrevented).toBe(false);
        close.click();
        expect(history.scrollTop).toBe(432);
        expect(find.visible).toBe(false);
        expect(scope.querySelector('.od-chat-find')?.hasAttribute('hidden')).toBe(true);
    });

    test('IME composition suppresses searches and navigation, streaming preserves active occurrence, hidden search stops work', () => {
        jest.useFakeTimers({ legacyFakeTimers: true });
        const { find, scope, messages, ensureMessage } = createFind();
        find.show();
        const input = scope.querySelector('input')!;
        input.dispatchEvent(new window.Event('compositionstart'));
        input.value = 'hit';
        input.dispatchEvent(new window.Event('input'));
        input.dispatchEvent(Object.assign(new window.Event('keydown', { bubbles: true }), { key: 'Enter' }));
        input.dispatchEvent(Object.assign(new window.Event('keydown', { bubbles: true }), { key: 'Escape' }));
        expect(find.visible).toBe(true);
        jest.runAllTimers();
        expect(ensureMessage).not.toHaveBeenCalled();
        input.dispatchEvent(new window.Event('compositionend'));
        jest.runAllTimers();
        find.next();
        ensureMessage.mockClear();
        messages[0].content = [part('hit hit hit')];
        find.refresh();
        jest.runAllTimers();
        expect(scope.querySelector('[role="status"]')?.textContent).toBe('2/3');
        expect(ensureMessage).not.toHaveBeenCalled();
        // 前面新增结果后，原命中的序号变化，但仍应保持选中同一处文字。
        messages.unshift({ role: 'user', message_id: 'earlier', content: [part('hit')] });
        find.refresh();
        jest.runAllTimers();
        expect(scope.querySelector('[role="status"]')?.textContent).toBe('3/4');
        // 原命中被删除后，回退到有效序号，不能超出新结果范围。
        messages[1].content = [part('hit')];
        find.refresh();
        jest.runAllTimers();
        expect(scope.querySelector('[role="status"]')?.textContent).toBe('2/2');
        find.hide();
        messages[0].content = [part('changed')];
        find.refresh();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('platform shortcut is scoped to a visible chat and never takes over editor/modal/IME input', () => {
        const task = document.createElement('task-view') as any;
        task.innerHTML = '<div data-chat-find-scope><textarea></textarea></div><aside><input></aside>';
        task.openChatFind = jest.fn();
        task.getClientRects = () => [1];
        document.body.append(task);
        registerChatFindShortcut(guiShortcutManager, { document, isMac: true, translate: (key) => key });
        const entry = guiShortcutManager.getAll().find((item) => item.id === 'chat:find')!;
        const event = (target: Element, extra = {}) =>
            ({
                key: 'f',
                metaKey: true,
                ctrlKey: false,
                altKey: false,
                shiftKey: false,
                target,
                ...extra
            }) as unknown as KeyboardEvent;
        const input = task.querySelector('textarea');
        expect(entry.match(event(input))).toBe(true);
        expect(entry.match(event(input, { metaKey: false, ctrlKey: true }))).toBe(false);
        expect(entry.match(event(input, { isComposing: true }))).toBe(false);
        expect(entry.match(event(task.querySelector('aside input')))).toBe(false);
        const dialog = document.createElement('dialog');
        dialog.setAttribute('open', '');
        document.body.append(dialog);
        expect(entry.match(event(input))).toBe(false);
        dialog.remove();
        entry.handler(event(input));
        expect(task.openChatFind).toHaveBeenCalledTimes(1);
        registerChatFindShortcut(guiShortcutManager, { document, isMac: false, translate: (key) => key });
        const windowsEntry = guiShortcutManager.getAll().find((item) => item.id === 'chat:find')!;
        expect(windowsEntry.match(event(input, { metaKey: false, ctrlKey: true }))).toBe(true);
        expect(windowsEntry.match(event(input))).toBe(false);
        expect(windowsEntry.match(event(input, { metaKey: false, ctrlKey: true, shiftKey: true }))).toBe(false);
    });
});
