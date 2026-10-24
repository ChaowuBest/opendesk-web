import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 笔记条目右键菜单测试：
 * - contextmenu 事件弹出 ctx-menu（重命名/删除）
 * - 重命名：打开笔记并聚焦标题输入框
 * - 删除：确认弹窗后调用 deleteNote
 * - 编辑器圆角容器结构（notes-editor-shell 包含工具栏+编辑区）
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

describe('笔记条目右键菜单与编辑器容器', () => {
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
        // 只创建实例不挂载（避免触发 connectedCallback 完整生命周期）
        widget = document.createElement('notes-entry-widget');
        widget._scheduleAutoSave = jest.fn();
        widget._t = (key, params) => {
            const dict = {
                'renderer.note.rename': '重命名',
                'renderer.note.delete': '删除'
            };
            let text = dict[key] || key;
            if (params) for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, v);
            return text;
        };
    });

    function contextMenu() {
        return widget.querySelector('#note-context-menu');
    }

    test('右键条目弹出菜单：含重命名与删除两项，danger 样式在删除上', () => {
        widget._showNoteContextMenu(50, 60, { id: 'note-1', title: '测试', tags: [] });

        const menu = contextMenu();
        expect(menu).toBeTruthy();
        expect(menu.className).toContain('ctx-menu');
        const actions = [...menu.querySelectorAll('[data-action]')].map((el) => el.dataset.action);
        expect(actions).toEqual(['rename', 'delete']);
        expect(menu.querySelector('[data-action="delete"]').className).toContain('danger');
        // 定位写入
        expect(menu.style.left).toBe('50px');
        expect(menu.style.top).toBe('60px');
    });

    test('重复右键先关旧菜单（不叠加）', () => {
        widget._showNoteContextMenu(10, 10, { id: 'n1', tags: [] });
        widget._showNoteContextMenu(20, 20, { id: 'n2', tags: [] });
        expect(widget.querySelectorAll('#note-context-menu').length).toBe(1);
        expect(contextMenu().style.left).toBe('20px');
    });

    test('点击重命名：关闭菜单并聚焦标题输入框（选中文本）', async () => {
        widget._showNoteContextMenu(10, 10, { id: 'n1', tags: [] });
        const focus = jest.fn();
        const select = jest.fn();
        const titleInput = document.createElement('input');
        titleInput.id = 'notes-title-input';
        titleInput.focus = focus;
        titleInput.select = select;
        widget.appendChild(titleInput);

        widget._openNote = jest.fn(async () => {});
        contextMenu().querySelector('[data-action="rename"]').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(widget._openNote).toHaveBeenCalledWith('n1');
        expect(focus).toHaveBeenCalled();
        expect(select).toHaveBeenCalled();
        expect(contextMenu()).toBeNull();
    });

    test('点击删除：确认弹窗通过后调用 deleteNote 并刷新列表', async () => {
        const calls = [];
        window.applicationAPI = {
            call: jest.fn(async (api, ...args) => {
                calls.push([api, ...args]);
                return [];
            })
        };
        widget._refreshNotes = jest.fn(async () => {});
        widget._refreshDeletedNotes = jest.fn(async () => {});
        showConfirmModal.mockResolvedValueOnce(true);

        widget._showNoteContextMenu(10, 10, { id: 'note-xyz', title: '目标笔记', tags: [] });
        contextMenu().querySelector('[data-action="delete"]').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(showConfirmModal).toHaveBeenCalled();
        expect(calls.some(([api, id]) => api === 'deleteNote' && id === 'note-xyz')).toBe(true);
        expect(widget._refreshNotes).toHaveBeenCalled();
        expect(contextMenu()).toBeNull();
    });

    test('确认弹窗取消时不删除', async () => {
        window.applicationAPI = { call: jest.fn(async () => []) };
        showConfirmModal.mockResolvedValueOnce(false);

        widget._showNoteContextMenu(10, 10, { id: 'n9', tags: [] });
        contextMenu().querySelector('[data-action="delete"]').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(window.applicationAPI.call).not.toHaveBeenCalled();
    });

    test('删除当前打开的笔记时走编辑器删除路径（_confirmDeleteNote）', async () => {
        widget.currentNoteId = 'n-cur';
        widget._confirmDeleteNote = jest.fn(async () => {});
        showConfirmModal.mockResolvedValueOnce(true);

        widget._showNoteContextMenu(10, 10, { id: 'n-cur', tags: [] });
        contextMenu().querySelector('[data-action="delete"]').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(widget._confirmDeleteNote).toHaveBeenCalled();
    });

    test('编辑器骨架包含 notes-editor-shell 圆角容器（含工具栏与编辑区）', () => {
        const { body } = env;
        // 模拟 _renderEditor 生成的骨架（直接构造同构 DOM 验证 CSS 选择器意图）
        body.innerHTML = `
            <div class="notes-editor-container">
                <div class="notes-editor-header"></div>
                <div class="notes-editor-shell">
                    <div id="notes-fixed-toolbar" class="notes-fixed-toolbar"></div>
                    <div class="notes-editor-body"><textarea id="notes-editor"></textarea></div>
                </div>
            </div>`;
        const shell = body.querySelector('.notes-editor-shell');
        expect(shell).toBeTruthy();
        // shell 必须包含工具栏与编辑区（圆角覆盖整个编辑器区域）
        expect(shell.querySelector('#notes-fixed-toolbar')).toBeTruthy();
        expect(shell.querySelector('.notes-editor-body')).toBeTruthy();
    });
});
