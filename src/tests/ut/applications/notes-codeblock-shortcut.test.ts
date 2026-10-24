import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 笔记编辑器 ``` + 回车 -> 代码块快捷转换测试。
 *
 * entry.js 依赖 TinyMCE（仅真实浏览器可用），这里 mock 掉 TinyMCE 与桥接，
 * 直接实例化 notes-entry-widget 并调用 `_handleCodeBlockShortcut` /
 * `_insertCodeBlock` / `_handleCodeBlockEnter`，用最小 EditorStub 驱动。
 */

const showConfirmModal = jest.fn(async () => true);

/** 最小 TinyMCE editor 桩：DOM 用 linkedom 文档承载 */
function createEditorStub() {
    const { window } = parseHTML('<!doctype html><html><body><p id="src">```</p></body></html>');
    const doc = window.document;
    const body = doc.body;
    const sourceNode = doc.getElementById('src');
    body.appendChild(sourceNode);

    const editor = {
        dom: {
            create(tag, attrs) {
                const el = doc.createElement(tag);
                for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
                return el;
            },
            insertAfter(node, ref) {
                ref.parentNode.insertBefore(node, ref.nextSibling);
                return node;
            },
            select(selector) {
                return Array.from(body.querySelectorAll(selector));
            }
        },
        selection: {
            getNode: () => sourceNode,
            setCursorLocation: jest.fn()
        },
        undoManager: {
            transact(fn) {
                fn();
            }
        },
        getDoc: () => doc,
        getBody: () => body
    };
    return { editor, doc, body, sourceNode, window };
}

/** 手写光标 Range 桩（linkedom 的 Range 不支持 setStart 等定位 API） */
function caretRange(container, offset) {
    return { startContainer: container, startOffset: offset, collapsed: true };
}

/** 方向键事件桩 */
function arrowEvent(key) {
    const ev = new Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'key', { value: key });
    Object.defineProperty(ev, 'isComposing', { value: false });
    Object.defineProperty(ev, 'shiftKey', { value: false });
    Object.defineProperty(ev, 'preventDefault', { value: jest.fn() });
    return ev;
}

describe('笔记代码块快捷转换（``` + 回车）', () => {
    let widget;
    let env;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        // TinyMCE 模块顶层会做设备探测与文档基址解析，需要 matchMedia/location
        window.matchMedia = (query) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false
        });
        try {
            Object.defineProperty(window.document, 'location', {
                value: new URL('http://localhost/'),
                configurable: true
            });
        } catch {
            /* 部分实现 location 不可配置，忽略 */
        }
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Event: window.Event,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            MutationObserver: window.MutationObserver,
            Node: window.Node,
            requestAnimationFrame: (callback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined,
            ResizeObserver: class {
                observe() {}
                disconnect() {}
            }
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () => ({
            showConfirmModal
        }));
        await jest.unstable_mockModule('../../../main/aikernel/tool.js', () => ({
            BaseTool: class {},
            BaseToolset: class {}
        }));

        await import('../../../main/applications/notes/renderer/entry.js');
    });

    beforeEach(() => {
        env = createEditorStub();
        // 只创建实例不挂载（避免触发完整 connectedCallback 生命周期），
        // 自动保存以桩替代
        widget = document.createElement('notes-entry-widget');
        widget._scheduleAutoSave = jest.fn();
    });

    /** 供快捷键处理的 keydown 事件桩 */
    function enterEvent() {
        const ev = new Event('keydown', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'key', { value: 'Enter' });
        Object.defineProperty(ev, 'isComposing', { value: false });
        Object.defineProperty(ev, 'preventDefault', {
            value: jest.fn()
        });
        return ev;
    }

    test('``` + 回车：当前段落被替换为无 header 代码块，并补空段落', () => {
        const { editor, sourceNode } = env;
        const e = enterEvent();

        widget._handleCodeBlockShortcut(editor, e);

        expect(e.preventDefault).toHaveBeenCalled();
        const block = editor.getBody().querySelector('.code-block-wrapper');
        expect(block).toBeTruthy();
        expect(block.querySelector('.code-block-header')).toBeNull();
        expect(block.querySelector('code.code-lines')).toBeTruthy();
        // 源段落已被移除
        expect(sourceNode.isConnected).toBe(false);
        // 代码块后有可聚焦的空段落
        const after = block.nextElementSibling;
        expect(after?.tagName).toBe('P');
        // 光标落入 code-lines
        expect(editor.selection.setCursorLocation).toHaveBeenCalled();
    });

    test('```c + 回车：带 C 语言 header，且行内携带 hljs 结构（外观同 taskview）', () => {
        const { editor } = env;
        const source = editor.getBody().querySelector('#src');
        source.textContent = '```c';

        const e = enterEvent();
        widget._handleCodeBlockShortcut(editor, e);

        const block = editor.getBody().querySelector('.code-block-wrapper');
        expect(block).toBeTruthy();
        expect(block.querySelector('.code-block-lang')?.textContent).toBe('C');
        expect(block.querySelector('.code-block-body')?.className).toContain('language-c');
        // 至少一行 code-line（空代码块用占位空格保证行存在）
        expect(block.querySelectorAll('.code-line').length).toBe(1);
    });

    test('```javascript + 回车：language-javascript 且显示名映射为 JavaScript', () => {
        const { editor } = env;
        const source = editor.getBody().querySelector('#src');
        source.textContent = '```javascript';

        widget._handleCodeBlockShortcut(editor, enterEvent());

        const block = editor.getBody().querySelector('.code-block-wrapper');
        expect(block.querySelector('.code-block-lang')?.textContent).toBe('JavaScript');
        expect(block.querySelector('.code-block-body')?.className).toContain('language-javascript');
    });

    test('未知语言 ```wisp + 回车：回退 plaintext 语义（无高亮数据），显示名首字母大写', () => {
        const { editor } = env;
        const source = editor.getBody().querySelector('#src');
        source.textContent = '```wisp';

        widget._handleCodeBlockShortcut(editor, enterEvent());

        const block = editor.getBody().querySelector('.code-block-wrapper');
        expect(block.querySelector('.code-block-lang')?.textContent).toBe('Wisp');
        // 占位空格内容，没有 hljs 高亮标记
        expect(block.querySelector('.code-line')?.textContent).toBe(' ');
    });

    test('非 ``` 段落（---、普通文本）不触发代码块转换', () => {
        const { editor } = env;
        const source = editor.getBody().querySelector('#src');
        source.textContent = '---';
        const e = enterEvent();
        widget._handleCodeBlockShortcut(editor, e);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(editor.getBody().querySelector('.code-block-wrapper')).toBeNull();

        source.textContent = '普通文本';
        const e2 = enterEvent();
        widget._handleCodeBlockShortcut(editor, e2);
        expect(e2.preventDefault).not.toHaveBeenCalled();
    });

    test('````（四反引号）与 `x` 不匹配快捷语法', () => {
        const { editor } = env;
        const source = editor.getBody().querySelector('#src');

        source.textContent = '````';
        const e = enterEvent();
        widget._handleCodeBlockShortcut(editor, e);
        expect(e.preventDefault).not.toHaveBeenCalled();

        source.textContent = '`x`';
        const e2 = enterEvent();
        widget._handleCodeBlockShortcut(editor, e2);
        expect(e2.preventDefault).not.toHaveBeenCalled();
    });

    test('``` 后带空格/参数（```c arg）不触发（避免吞掉普通输入）', () => {
        const { editor } = env;
        const source = editor.getBody().querySelector('#src');
        source.textContent = '```c arg';
        const e = enterEvent();
        widget._handleCodeBlockShortcut(editor, e);
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    test('代码块内回车：非空行拆分为两个 code-line，行号结构保持', () => {
        const { editor, body } = env;
        // 构造已有代码块：两行
        body.innerHTML =
            '<div class="code-block-wrapper"><div class="code-block-body hljs language-c">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            '<span class="code-line font-mono">int a;</span>' +
            '<span class="code-line font-mono">int b;</span>' +
            '</code></pre></div></div>';
        const block = body.querySelector('.code-block-wrapper');
        const firstLine = block.querySelectorAll('.code-line')[0];
        const textNode = firstLine.firstChild;

        // 光标在第一行 "int |a;" 之间（offset 4）
        const rng = caretRange(textNode, 4);
        editor.selection.getRng = () => rng;
        editor.selection.getNode = () => firstLine;

        const e = enterEvent();
        const handled = widget._handleCodeBlockEnter(editor, e);

        expect(handled).toBe(true);
        expect(e.preventDefault).toHaveBeenCalled();
        const lines = block.querySelectorAll('.code-line');
        expect(lines.length).toBe(3);
        expect(lines[0].textContent).toBe('int ');
        expect(lines[1].textContent).toBe('a;');
        expect(lines[2].textContent).toBe('int b;');
        // 光标必须落在新行（lines[1]）内部的文本节点上，而非元素边界——
        // 元素边界点会被 TinyMCE 选区归一化挪回上一行行尾（回车 bug 根因）
        const [cursorNode] = editor.selection.setCursorLocation.mock.calls.at(-1);
        expect(cursorNode.nodeType).toBe(3);
        expect(lines[1].contains(cursorNode)).toBe(true);
    });

    test('拆分带行内高亮 span 的行：壳层级在新行重建，文本正确切分', () => {
        const { editor, body } = env;
        body.innerHTML =
            '<div class="code-block-wrapper"><div class="code-block-body hljs language-c">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            '<span class="code-line font-mono"><span class="hljs-keyword">int</span> a = <span class="hljs-number">1</span>;</span>' +
            '</code></pre></div></div>';
        const block = body.querySelector('.code-block-wrapper');
        const line = block.querySelector('.code-line');
        // 光标位于 "a" 文本节点 offset 3 处（"a =" 中间）："a | = 1;"
        const textNode = line.childNodes[1]; // " a = " 文本节点
        const offset = 3; // " a " 之后

        const rng = caretRange(textNode, offset);
        editor.selection.getRng = () => rng;
        editor.selection.getNode = () => line;

        const e = enterEvent();
        widget._handleCodeBlockEnter(editor, e);

        const lines = block.querySelectorAll('.code-line');
        expect(lines.length).toBe(2);
        // 第一行：keyword + " a"（" a " 的尾部空格留在第一行）
        expect(lines[0].querySelector('.hljs-keyword')?.textContent).toBe('int');
        expect(lines[0].textContent).toBe('int a ');
        // 第二行：重建了 number 壳，"= 1;" 在其中
        expect(lines[1].querySelectorAll('.hljs-number').length).toBe(1);
        expect(lines[1].querySelector('.hljs-number')?.textContent).toBe('1');
        expect(lines[1].textContent).toBe('= 1;');
        // 光标落在新行内部文本节点（number 壳里的文本）
        const [cursorNode] = editor.selection.setCursorLocation.mock.calls.at(-1);
        expect(cursorNode.nodeType).toBe(3);
        expect(lines[1].contains(cursorNode)).toBe(true);
    });

    test('行尾拆分出新空行时补空格占位，光标落在占位文本节点内', () => {
        const { editor, body } = env;
        body.innerHTML =
            '<div class="code-block-wrapper"><div class="code-block-body hljs language-c">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            '<span class="code-line font-mono">abc</span>' +
            '</code></pre></div></div>';
        const block = body.querySelector('.code-block-wrapper');
        const line = block.querySelector('.code-line');

        // 光标在行尾（offset 3），回车拆出空新行
        const rng = caretRange(line.firstChild, 3);
        editor.selection.getRng = () => rng;
        editor.selection.getNode = () => line;

        const e = enterEvent();
        widget._handleCodeBlockEnter(editor, e);

        const lines = block.querySelectorAll('.code-line');
        expect(lines.length).toBe(2);
        expect(lines[1].textContent).toBe(' ');
        const [cursorNode, cursorOffset] = editor.selection.setCursorLocation.mock.calls.at(-1);
        expect(cursorNode.nodeType).toBe(3);
        expect(lines[1].contains(cursorNode)).toBe(true);
        expect(cursorOffset).toBe(0);
    });

    test('代码块内最后一行为空时回车退出代码块', () => {
        const { editor, body } = env;
        body.innerHTML =
            '<div class="code-block-wrapper"><div class="code-block-body hljs">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            '<span class="code-line font-mono">code</span>' +
            '<span class="code-line font-mono"> </span>' +
            '</code></pre></div></div>';
        const block = body.querySelector('.code-block-wrapper');
        const lastLine = block.querySelectorAll('.code-line')[1];

        const rng = caretRange(lastLine.firstChild, 0);
        editor.selection.getRng = () => rng;
        editor.selection.getNode = () => lastLine;

        const e = enterEvent();
        const handled = widget._handleCodeBlockEnter(editor, e);

        expect(handled).toBe(true);
        // 代码块后新增空段落
        const after = block.nextElementSibling;
        expect(after?.tagName).toBe('P');
    });

    test('代码块外回车不走 _handleCodeBlockEnter（返回 false，交给其他快捷逻辑）', () => {
        const { editor } = env;
        const e = enterEvent();
        expect(widget._handleCodeBlockEnter(editor, e)).toBe(false);
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    // ─── 语法高亮（光标离开块后整体刷新）───

    function setupHighlightCase(lines) {
        const { editor, body } = env;
        body.innerHTML =
            '<div class="code-block-wrapper" data-lang="c"><div class="code-block-body hljs language-c">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            lines.map((t) => `<span class="code-line font-mono">${t}</span>`).join('') +
            '</code></pre></div></div>';
        const block = body.querySelector('.code-block-wrapper');
        const line = block.querySelectorAll('.code-line')[0];
        editor.selection.getNode = () => line;
        return { block, body };
    }

    test('光标在块内时该块完全不动 DOM（选区安全）', () => {
        const { editor, body } = env;
        const { block } = setupHighlightCase(['int a;', 'plain']);
        const line0 = block.querySelectorAll('.code-line')[0];
        const line1 = block.querySelectorAll('.code-line')[1];
        const innerBefore = line1.innerHTML;

        editor.selection.getRng = () => caretRange(line0.firstChild, 0);
        widget._refreshCodeBlockHighlight(editor);

        // 两个行元素都是原节点，内容未变
        expect(block.querySelectorAll('.code-line')[0]).toBe(line0);
        expect(block.querySelectorAll('.code-line')[1]).toBe(line1);
        expect(line1.innerHTML).toBe(innerBefore);
    });

    test('光标不在块内时整块刷新：所有行获得 hljs 标记', () => {
        const { editor, body } = env;
        const { block } = setupHighlightCase(['int a;', 'next']);
        // 光标在块外（body 上）
        editor.selection.getRng = () => ({ startContainer: body, startOffset: 0, collapsed: true });
        editor.selection.getNode = () => body;

        widget._refreshCodeBlockHighlight(editor);

        const lines = block.querySelectorAll('.code-line');
        expect(lines[0].querySelector('.hljs-keyword, .hljs-type')).toBeTruthy();
        expect(lines[1].textContent).toBe('next');
    });

    test('框选（非折叠选区）时跳过刷新，不动 DOM', () => {
        const { editor, body } = env;
        const { block } = setupHighlightCase(['int a;']);
        const line = block.querySelector('.code-line');
        const before = line.outerHTML;

        const rng = caretRange(line.firstChild, 0);
        rng.collapsed = false; // 模拟拖选
        editor.selection.getRng = () => rng;

        widget._refreshCodeBlockHighlight(editor);

        expect(line.outerHTML).toBe(before);
    });

    test('语言可从 body 类名 language-* 回退读取（data-lang 被剥离时仍可高亮）', () => {
        const { editor, body } = env;
        body.innerHTML =
            '<div class="code-block-wrapper"><div class="code-block-body hljs language-c">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            '<span class="code-line font-mono">int a;</span>' +
            '</code></pre></div></div>';
        const block = body.querySelector('.code-block-wrapper');
        // 光标在代码块外，保证整块可刷新
        editor.selection.getRng = () => ({ startContainer: body, startOffset: 0, collapsed: true });
        editor.selection.getNode = () => body;

        widget._refreshCodeBlockHighlight(editor);

        expect(block.querySelectorAll('.hljs-keyword, .hljs-type').length).toBeGreaterThan(0);
    });

    test('首行行首按 ↑ 离开代码块到前一元素末尾', () => {
        const { editor, body } = env;
        body.innerHTML =
            '<p id="before">hello</p>' +
            '<div class="code-block-wrapper" data-lang="c"><div class="code-block-body hljs language-c">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            '<span class="code-line font-mono">int a;</span>' +
            '</code></pre></div></div>';
        const block = body.querySelector('.code-block-wrapper');
        const line = block.querySelector('.code-line');
        editor.selection.getNode = () => line;
        editor.selection.getRng = () => caretRange(line.firstChild, 0);

        const e = arrowEvent('ArrowUp');
        const handled = widget._handleCodeBlockArrowKeys(editor, e);

        expect(handled).toBe(true);
        expect(e.preventDefault).toHaveBeenCalled();
        const [node, offset] = editor.selection.setCursorLocation.mock.calls.at(-1);
        expect(node.textContent).toContain('hello');
        expect(offset).toBe(5);
    });

    test('首行非行首按 ↑ 不拦截（浏览器默认行为）', () => {
        const { editor, body } = env;
        body.innerHTML =
            '<div class="code-block-wrapper" data-lang="c"><div class="code-block-body hljs language-c">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            '<span class="code-line font-mono">int a;</span>' +
            '</code></pre></div></div>';
        const block = body.querySelector('.code-block-wrapper');
        const line = block.querySelector('.code-line');
        editor.selection.getNode = () => line;
        editor.selection.getRng = () => caretRange(line.firstChild, 3);

        const e = arrowEvent('ArrowUp');
        expect(widget._handleCodeBlockArrowKeys(editor, e)).toBe(false);
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    test('末行行尾按 ↓ 离开代码块到后一元素', () => {
        const { editor, body } = env;
        body.innerHTML =
            '<div class="code-block-wrapper" data-lang="c"><div class="code-block-body hljs language-c">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            '<span class="code-line font-mono">int a;</span>' +
            '<span class="code-line font-mono">}</span>' +
            '</code></pre></div></div><p id="after">next</p>';
        const block = body.querySelector('.code-block-wrapper');
        const lastLine = block.querySelectorAll('.code-line')[1];
        editor.selection.getNode = () => lastLine;
        editor.selection.getRng = () => caretRange(lastLine.firstChild, 1);

        const e = arrowEvent('ArrowDown');
        const handled = widget._handleCodeBlockArrowKeys(editor, e);

        expect(handled).toBe(true);
        expect(e.preventDefault).toHaveBeenCalled();
        const [node] = editor.selection.setCursorLocation.mock.calls.at(-1);
        expect(node.id).toBe('after');
    });

    test('末行行尾按 ↓ 且块后无段落时自动补空段落', () => {
        const { editor, body } = env;
        body.innerHTML =
            '<div class="code-block-wrapper" data-lang="c"><div class="code-block-body hljs language-c">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            '<span class="code-line font-mono">int a;</span>' +
            '</code></pre></div></div>';
        const block = body.querySelector('.code-block-wrapper');
        const line = block.querySelector('.code-line');
        editor.selection.getNode = () => line;
        editor.selection.getRng = () => caretRange(line.firstChild, 6);

        const e = arrowEvent('ArrowDown');
        const handled = widget._handleCodeBlockArrowKeys(editor, e);

        expect(handled).toBe(true);
        const after = block.nextElementSibling;
        expect(after?.tagName).toBe('P');
        const [node] = editor.selection.setCursorLocation.mock.calls.at(-1);
        expect(node).toBe(after);
    });

    test('非首末行或非边界位置不拦截方向键', () => {
        const { editor, body } = env;
        body.innerHTML =
            '<div class="code-block-wrapper" data-lang="c"><div class="code-block-body hljs language-c">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            '<span class="code-line font-mono">l1</span>' +
            '<span class="code-line font-mono">l2</span>' +
            '</code></pre></div></div>';
        const block = body.querySelector('.code-block-wrapper');
        const firstLine = block.querySelectorAll('.code-line')[0];
        editor.selection.getNode = () => firstLine;
        editor.selection.getRng = () => caretRange(firstLine.firstChild, 0);

        const e = arrowEvent('ArrowDown');
        expect(widget._handleCodeBlockArrowKeys(editor, e)).toBe(false);
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    test('无语言标记（裸 ``` 创建）的代码块跳过重高亮', () => {
        const { editor, body } = env;
        body.innerHTML =
            '<div class="code-block-wrapper"><div class="code-block-body hljs">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            '<span class="code-line font-mono">plain text</span>' +
            '</code></pre></div></div>';
        const block = body.querySelector('.code-block-wrapper');
        const line = block.querySelector('.code-line');
        editor.selection.getNode = () => line;
        editor.selection.getRng = () => caretRange(line.firstChild, 0);

        widget._refreshCodeBlockHighlight(editor);

        // 内容未被改写（plain text 无 hljs 标记产生）
        expect(line.textContent).toBe('plain text');
        expect(line.querySelector('[class*="hljs-"]')).toBeNull();
    });

    test('_getCodeBlockPlainText 汇总各行为 \\n 连接的纯文本', () => {
        const { body } = env;
        body.innerHTML =
            '<div class="code-block-wrapper"><div class="code-block-body hljs language-c">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            '<span class="code-line font-mono"><span class="hljs-keyword">int</span> a;</span>' +
            '<span class="code-line font-mono"> </span>' +
            '</code></pre></div></div>';
        const block = body.querySelector('.code-block-wrapper');
        expect(widget._getCodeBlockPlainText(block)).toBe('int a;\n ');
    });
});
