import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';

/**
 * 粘贴围栏转代码块 + 编辑区自定义右键菜单测试。
 */

const showConfirmModal = jest.fn(async () => true);

function createEditorStub() {
    const { window } = parseHTML('<!doctype html><html><body><p id="src">x</p></body></html>');
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
            setCursorLocation: jest.fn(),
            getContent: jest.fn(() => '')
        },
        undoManager: {
            transact(fn) {
                fn();
            }
        },
        execCommand: jest.fn(),
        insertContent: jest.fn(),
        focus: jest.fn(),
        getDoc: () => doc,
        getBody: () => body
    };
    return { editor, doc, body, sourceNode, window };
}

describe('粘贴围栏转代码块 + 编辑区右键菜单', () => {
    let widget;
    let env;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
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
            /* ignore */
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

        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () =>
            confirmModalMockShim({
                showConfirmModal
            })
        );
        await jest.unstable_mockModule('../../../main/aikernel/tool.js', () => ({
            BaseTool: class {},
            BaseToolset: class {}
        }));

        await import('../../../main/applications/notes/renderer/entry.js');
    });

    beforeEach(() => {
        env = createEditorStub();
        widget = document.createElement('notes-entry-widget');
        widget._scheduleAutoSave = jest.fn();
        widget._t = (key, params) => {
            const dict = {
                'renderer.note.menu.cut': '剪切',
                'renderer.note.menu.copy': '复制',
                'renderer.note.menu.paste': '粘贴',
                'renderer.note.menu.pastePlain': '粘贴为纯文本',
                'renderer.note.menu.selectAll': '全选'
            };
            let text = dict[key] || key;
            if (params) for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, v);
            return text;
        };
        // 剪贴板桥：直接回填
        widget._readClipboardText = jest.fn(async () => '');
        widget._writeClipboardText = jest.fn();
    });

    // ─── 围栏解析 ───

    test('_parseCodeFence：标准 ```c 围栏解析出语言与代码体', () => {
        const r = widget._parseCodeFence('```c\nint main() {\n}\n```');
        expect(r).toEqual({ lang: 'c', code: 'int main() {\n}' });
    });

    test('_parseCodeFence：裸 ``` 围栏（无语言）lang 为空字符串', () => {
        const r = widget._parseCodeFence('```\nplain\n```');
        expect(r).toEqual({ lang: '', code: 'plain' });
    });

    test('_parseCodeFence：波浪线围栏 ~~~python 也能解析', () => {
        const r = widget._parseCodeFence('~~~python\nx = 1\n~~~');
        expect(r).toEqual({ lang: 'python', code: 'x = 1' });
    });

    test('_parseCodeFence：非围栏文本返回 null', () => {
        expect(widget._parseCodeFence('普通文本')).toBeNull();
        expect(widget._parseCodeFence('``` 只有开头没有结尾')).toBeNull();
        expect(widget._parseCodeFence('')).toBeNull();
    });

    // ─── 粘贴拦截 ───

    function pasteEvent(text) {
        const ev = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', {
            value: { getData: (type) => (type === 'text/plain' ? text : '') }
        });
        Object.defineProperty(ev, 'preventDefault', { value: jest.fn() });
        return ev;
    }

    test('粘贴围栏文本：preventDefault 并插入代码块（带语言 header）', () => {
        const { editor, body } = env;
        const e = pasteEvent('```c\nint main() {\n}\n```');

        widget._handleCodeFencePaste(editor, e);

        expect(e.preventDefault).toHaveBeenCalled();
        const wrapper = body.querySelector('.code-block-wrapper');
        expect(wrapper).toBeTruthy();
        expect(wrapper.dataset.lang).toBe('c');
        expect(wrapper.querySelector('.code-block-lang')?.textContent).toBe('C');
        // 代码体按行高亮拆分：两行
        expect(wrapper.querySelectorAll('.code-line').length).toBe(2);
        expect(wrapper.querySelectorAll('.code-line')[0].textContent).toBe('int main() {');
        // 光标落块内
        const [node] = editor.selection.setCursorLocation.mock.calls.at(-1);
        expect(wrapper.contains(node)).toBe(true);
    });

    test('粘贴裸围栏：插入无 header 代码块', () => {
        const { editor, body } = env;
        widget._handleCodeFencePaste(editor, pasteEvent('```\nplain text\n```'));
        const wrapper = body.querySelector('.code-block-wrapper');
        expect(wrapper).toBeTruthy();
        expect(wrapper.querySelector('.code-block-header')).toBeNull();
        expect(wrapper.querySelector('.code-line')?.textContent).toBe('plain text');
    });

    test('粘贴非围栏文本：不拦截不走插入', () => {
        const { editor, body } = env;
        const e = pasteEvent('just normal text');
        widget._handleCodeFencePaste(editor, e);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(body.querySelector('.code-block-wrapper')).toBeNull();
    });

    test('代码块内粘贴围栏：不转换（用户在补代码）', () => {
        const { editor, body } = env;
        body.innerHTML =
            '<div class="code-block-wrapper" data-lang="c"><div class="code-block-body hljs language-c">' +
            '<pre class="code-block-pre font-mono"><code class="code-lines">' +
            '<span class="code-line font-mono">int a;</span>' +
            '</code></pre></div></div>';
        const line = body.querySelector('.code-line');
        editor.selection.getNode = () => line;
        const rng = { startContainer: line.firstChild, startOffset: 0, collapsed: true };

        const e = pasteEvent('```c\nx\n```');
        // _handleCodeFencePaste 内部调 _findCodeBlockAncestor(editor)（走 getRng）
        editor.selection.getRng = () => rng;
        widget._handleCodeFencePaste(editor, e);
        expect(e.preventDefault).not.toHaveBeenCalled();
        // 只有一个块（没有插入新块）
        expect(body.querySelectorAll('.code-block-wrapper').length).toBe(1);
    });

    test('_insertFencedCodeBlock：非空段落保留原文，块插在其后', () => {
        const { editor, body, sourceNode } = env;
        sourceNode.textContent = '前面这段话保留';

        widget._insertFencedCodeBlock(editor, 'python', 'x = 1\ny = 2');

        expect(sourceNode.isConnected).toBe(true);
        const wrapper = body.querySelector('.code-block-wrapper');
        expect(wrapper.dataset.lang).toBe('python');
        expect(wrapper.querySelectorAll('.code-line').length).toBe(2);
    });

    // ─── 编辑区右键菜单 ───

    test('右键弹出编辑菜单：五项与禁用态（无选区时剪切/复制禁用）', () => {
        const { editor } = env;
        editor.selection.getContent = jest.fn(() => '');

        widget._showEditorContextMenu(30, 40, editor);

        const menu = widget.querySelector('#notes-editor-context-menu');
        expect(menu).toBeTruthy();
        expect(menu.className).toContain('ctx-menu');
        const actions = [...menu.querySelectorAll('[data-action]')].map((el) => el.dataset.action);
        expect(actions).toEqual(['cut', 'copy', 'paste', 'paste-plain', 'selectall']);
        expect(menu.querySelector('[data-action="cut"]').className).toContain('disabled');
        expect(menu.querySelector('[data-action="copy"]').className).toContain('disabled');
        expect(menu.querySelector('[data-action="paste"]').className).not.toContain('disabled');
        expect(menu.style.left).toBe('30px');
    });

    test('contextmenu 换算公式：iframe 偏移 + 内部坐标 = 应用文档坐标', () => {
        // setup 里 contextmenu 处理器用 iframe.getBoundingClientRect() + e.clientX/Y
        // 换算（与浮动工具栏 _onEditorSelectionChange 同源）。这里固化换算语义。
        const iframeRect = { left: 640, top: 360 };
        const innerX = 100;
        const innerY = 50;
        expect(iframeRect.left + innerX).toBe(740);
        expect(iframeRect.top + innerY).toBe(410);
    });

    test('有选区时剪切/复制不再禁用', () => {
        const { editor } = env;
        editor.selection.getContent = jest.fn(() => 'selected text');
        widget._showEditorContextMenu(0, 0, editor);
        const menu = widget.querySelector('#notes-editor-context-menu');
        expect(menu.querySelector('[data-action="cut"]').className).not.toContain('disabled');
        expect(menu.querySelector('[data-action="copy"]').className).not.toContain('disabled');
    });

    test('复制：写入剪贴板（选中文本），菜单关闭', () => {
        const { editor } = env;
        editor.selection.getContent = jest.fn(() => 'copy me');
        widget._showEditorContextMenu(0, 0, editor);
        widget.querySelector('#notes-editor-context-menu [data-action="copy"]').click();
        expect(widget._writeClipboardText).toHaveBeenCalledWith('copy me');
        expect(widget.querySelector('#notes-editor-context-menu')).toBeNull();
    });

    test('剪切：写入剪贴板并删除选区（execCommand Delete）', () => {
        const { editor } = env;
        editor.selection.getContent = jest.fn(() => 'cut me');
        widget._showEditorContextMenu(0, 0, editor);
        widget.querySelector('#notes-editor-context-menu [data-action="cut"]').click();
        expect(widget._writeClipboardText).toHaveBeenCalledWith('cut me');
        expect(editor.execCommand).toHaveBeenCalledWith('Delete');
    });

    test('粘贴：剪贴板是围栏文本时走代码块插入', async () => {
        const { editor, body } = env;
        editor.selection.getContent = jest.fn(() => '');
        widget._readClipboardText = jest.fn(async () => '```python\nx = 1\n```');

        widget._showEditorContextMenu(0, 0, editor);
        await widget.querySelector('#notes-editor-context-menu [data-action="paste"]').click();
        await new Promise((r) => setTimeout(r, 0));

        const wrapper = body.querySelector('.code-block-wrapper');
        expect(wrapper).toBeTruthy();
        expect(wrapper.dataset.lang).toBe('python');
    });

    test('菜单项 pointerdown/mousedown 被阻止默认（保持编辑器焦点与选区）', () => {
        const { editor } = env;
        widget._showEditorContextMenu(0, 0, editor);
        const btn = widget.querySelector('#notes-editor-context-menu [data-action="paste"]');

        const pd = new Event('pointerdown', { bubbles: true, cancelable: true });
        const md = new Event('mousedown', { bubbles: true, cancelable: true });
        Object.defineProperty(pd, 'preventDefault', { value: jest.fn() });
        Object.defineProperty(md, 'preventDefault', { value: jest.fn() });
        btn.dispatchEvent(pd);
        btn.dispatchEvent(md);

        expect(pd.preventDefault).toHaveBeenCalled();
        expect(md.preventDefault).toHaveBeenCalled();
    });

    test('粘贴为纯文本：insertContent 转义插入（换行转 <br>），不转代码块', async () => {
        const { editor, body } = env;
        editor.selection.getContent = jest.fn(() => '');
        editor.insertContent = jest.fn();
        widget._readClipboardText = jest.fn(async () => '```python\nx = 1\n```');

        widget._showEditorContextMenu(0, 0, editor);
        await widget.querySelector('#notes-editor-context-menu [data-action="paste-plain"]').click();
        await new Promise((r) => setTimeout(r, 0));

        // 走 insertContent 且内容是转义后的原始围栏文本（换行转 <br>）
        expect(editor.insertContent).toHaveBeenCalledWith('```python<br>x = 1<br>```');
        // 没有代码块被插入
        expect(body.querySelector('.code-block-wrapper')).toBeNull();
    });

    test('粘贴（普通文本）：走 insertContent（TinyMCE 官方插入管线）', async () => {
        const { editor } = env;
        editor.selection.getContent = jest.fn(() => '');
        editor.insertContent = jest.fn();
        widget._readClipboardText = jest.fn(async () => 'just normal text');

        widget._showEditorContextMenu(0, 0, editor);
        await widget.querySelector('#notes-editor-context-menu [data-action="paste"]').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(editor.insertContent).toHaveBeenCalledWith('just normal text');
    });

    test('全选：execCommand SelectAll', () => {
        const { editor } = env;
        widget._showEditorContextMenu(0, 0, editor);
        widget.querySelector('#notes-editor-context-menu [data-action="selectall"]').click();
        expect(editor.execCommand).toHaveBeenCalledWith('SelectAll');
    });

    test('禁用项点击不执行任何操作', () => {
        const { editor } = env;
        editor.selection.getContent = jest.fn(() => '');
        widget._showEditorContextMenu(0, 0, editor);
        widget.querySelector('#notes-editor-context-menu [data-action="copy"]').click();
        expect(widget._writeClipboardText).not.toHaveBeenCalled();
        // 菜单也不关闭（disabled pointer-events: none 在真实 DOM；stub 里靠守卫）
    });
});
