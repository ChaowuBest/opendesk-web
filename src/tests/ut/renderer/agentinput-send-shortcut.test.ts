import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

const showConfirmModal = jest.fn(async () => true);
const executeSlashCommand = jest.fn();

/** 构造可取消的 keydown 事件（linkedom 无原生 KeyboardEvent 修饰键，用 defineProperty 注入） */
function createKeydownEvent(key: string, options: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
    const ev = new Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'key', { value: key });
    Object.defineProperty(ev, 'ctrlKey', { value: !!options.ctrlKey });
    Object.defineProperty(ev, 'shiftKey', { value: !!options.shiftKey });
    Object.defineProperty(ev, 'isComposing', { value: false });
    Object.defineProperty(ev, 'keyCode', { value: key === 'Enter' ? 13 : 0 });
    return ev;
}

/** 等待异步的 handleSubmit（含内部 await）执行完毕 */
function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('agent-input send shortcut', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Event: window.Event,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            MutationObserver: window.MutationObserver,
            Node: window.Node,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
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
        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));
        await jest.unstable_mockModule('../../../platforms/bridges/renderer.ts', () => ({
            NativeBridgeProxy: class {
                async getSpeechKit() {
                    return {
                        available: async () => false
                    };
                }
            }
        }));
        await jest.unstable_mockModule('../../../renderer/components/slash-command.ts', () => ({
            getSlashCommands: jest.fn(() => []),
            filterSlashCommands: jest.fn(() => []),
            executeSlashCommand
        }));

        await import('../../../renderer/components/agentinput.js');
    });

    beforeEach(() => {
        showConfirmModal.mockClear();
        executeSlashCommand.mockReset();
        document.body.innerHTML = '';
        window.taskManagerAPI = {
            getAttachmentFileSupport: jest.fn(async () => ({
                supportedExtensions: ['doc', 'docx', 'xls', 'xlsx', 'pptx', 'odt', 'odp', 'ods', 'pdf', 'ofd', 'rtf'],
                knownUnsupportedExtensions: ['ppt']
            }))
        };
    });

    function setupInput() {
        const input = document.createElement('agent-input') as HTMLElement & {
            render: () => void;
            ctrlEnterSend: boolean;
            updatePlaceholder: () => void;
            applySendShortcutSetting: (data: unknown) => void;
            getUnsupportedFilePaths: () => Promise<string[]>;
            _parseSlashCommandInput: (msg: string) => unknown;
        };
        input.render();
        const textarea = input.querySelector('#agent-input-textarea') as HTMLTextAreaElement;
        // linkedom 的 textarea 未实现 setRangeText，用插入模拟替代
        textarea.setRangeText = jest.fn(function (this: HTMLTextAreaElement, text: string, start: number, end: number) {
            this.value = this.value.slice(0, start) + text + this.value.slice(end);
        });
        textarea.focus = jest.fn();
        input.getUnsupportedFilePaths = jest.fn(async () => []);
        input._parseSlashCommandInput = jest.fn(() => null);
        return { input, textarea };
    }

    test('按 Enter 发送模式下，Ctrl+Enter 插入换行且不发送', async () => {
        const { input, textarea } = setupInput();
        textarea.value = 'hello';
        textarea.selectionStart = 5;
        textarea.selectionEnd = 5;
        const onSubmit = jest.fn();
        input.addEventListener('submit', onSubmit);

        textarea.dispatchEvent(createKeydownEvent('Enter', { ctrlKey: true }));
        await flush();

        expect(textarea.value).toBe('hello\n');
        expect(onSubmit).not.toHaveBeenCalled();
    });

    test('按 Enter 发送模式下，Ctrl+Shift+Enter 同样插入换行且不发送', async () => {
        const { input, textarea } = setupInput();
        textarea.value = 'hello';
        textarea.selectionStart = 5;
        textarea.selectionEnd = 5;
        const onSubmit = jest.fn();
        input.addEventListener('submit', onSubmit);

        textarea.dispatchEvent(createKeydownEvent('Enter', { ctrlKey: true, shiftKey: true }));
        await flush();

        expect(textarea.value).toBe('hello\n');
        expect(onSubmit).not.toHaveBeenCalled();
    });

    test('按 Enter 发送模式下，Enter 触发发送', async () => {
        const { input, textarea } = setupInput();
        textarea.value = 'hello';
        const onSubmit = jest.fn();
        input.addEventListener('submit', onSubmit);

        textarea.dispatchEvent(createKeydownEvent('Enter'));
        await flush();

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    test('按 Enter 发送模式下，Shift+Enter 不触发发送', async () => {
        const { input, textarea } = setupInput();
        textarea.value = 'hello';
        const onSubmit = jest.fn();
        input.addEventListener('submit', onSubmit);

        textarea.dispatchEvent(createKeydownEvent('Enter', { shiftKey: true }));
        await flush();

        expect(onSubmit).not.toHaveBeenCalled();
    });

    test('Ctrl+Enter 发送模式下，Ctrl+Enter 触发发送且不插入换行', async () => {
        const { input, textarea } = setupInput();
        input.ctrlEnterSend = true;
        textarea.value = 'hello';
        textarea.selectionStart = 5;
        textarea.selectionEnd = 5;
        const onSubmit = jest.fn();
        input.addEventListener('submit', onSubmit);

        textarea.dispatchEvent(createKeydownEvent('Enter', { ctrlKey: true }));
        await flush();

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    test('占位符覆盖层：Enter 发送模式展示拖拽提示、回车键图标与文案', () => {
        const { input } = setupInput();
        const overlay = input.querySelector('#agent-input-placeholder');
        expect(overlay).not.toBeNull();
        const html = (overlay as HTMLElement).innerHTML;
        expect(html).toContain('输入消息');
        expect(html).toContain('拖拽文件');
        expect(html).toContain('agent-input-ph-key');
        expect(html).toContain('<svg');
        expect(html).toContain('Enter');
        // 发送提示与换行提示各有一个键图标（Enter / Shift），共出现 3 处图标
        expect(html.match(/agent-input-ph-key/g)).toHaveLength(3);
        // 发送提示的 Enter 图标应插在「按」之后、Enter 之前
        expect(html.indexOf('agent-input-ph-key')).toBeLessThan(html.indexOf('Enter'));
    });

    test('占位符覆盖层：切换为 Ctrl+Enter 发送后文案同步更新', () => {
        const { input } = setupInput();
        input.ctrlEnterSend = true;
        input.updatePlaceholder();
        const overlay = input.querySelector('#agent-input-placeholder');
        const html = (overlay as HTMLElement).innerHTML;
        // 富文本中键名之间被图标 HTML 隔断，分别断言文本片段
        expect(html).toContain('Ctrl +');
        expect(html).toContain('Enter 发送');
        expect(html).toContain('Shift +');
        expect(html).toContain('Enter 换行');
        // 纯文本版保留完整快捷键文案（不含图标）
        const plain = input.getInputPlaceholder();
        expect(plain).toContain('Ctrl + Enter');
        expect(plain).toContain('Shift + Enter 换行');
    });

    test('原生 placeholder 文本为纯文本（不含图标占位符）', () => {
        const { input } = setupInput();
        const textarea = input.querySelector('#agent-input-textarea') as HTMLTextAreaElement;
        expect(textarea.placeholder).toContain('输入消息');
        expect(textarea.placeholder).toContain('拖拽文件');
        expect(textarea.placeholder).toContain('按 Enter 发送');
        expect(textarea.placeholder).toContain('Shift + Enter 换行');
        expect(textarea.placeholder).not.toContain('{iconEnter}');
        expect(textarea.placeholder).not.toContain('{iconShift}');
        expect(textarea.placeholder).not.toContain('{iconCtrl}');
    });

    test('设置面板切换发送快捷键后已有组件实时同步', () => {
        const { input } = setupInput();
        expect(input.ctrlEnterSend).toBe(false);

        // 模拟设置面板广播的 onSettingChanged 回调
        input.applySendShortcutSetting({ gui_config: { ctrl_enter_send: true } });
        expect(input.ctrlEnterSend).toBe(true);
        const overlay = input.querySelector('#agent-input-placeholder');
        const html = (overlay as HTMLElement).innerHTML;
        expect(html).toContain('Ctrl +');
        // Ctrl 模式：Ctrl + Enter 发送（Ctrl/Enter 图标）+ Shift + Enter 换行（Shift/Enter 图标），共 4 处键图标
        expect(html.match(/agent-input-ph-key/g)).toHaveLength(4);

        // 切回 Enter 发送
        input.applySendShortcutSetting({ gui_config: { ctrl_enter_send: false } });
        expect(input.ctrlEnterSend).toBe(false);
        expect((input.querySelector('#agent-input-placeholder') as HTMLElement).innerHTML).not.toContain('Ctrl +');
    });

    test('搜索模式下占位符覆盖层为纯文本（无图标）', () => {
        const { input } = setupInput();
        (input as HTMLElement & { searchMode: boolean }).searchMode = true;
        input.updatePlaceholder();
        const overlay = input.querySelector('#agent-input-placeholder');
        const html = (overlay as HTMLElement).innerHTML;
        expect(html).not.toContain('agent-input-ph-key');
    });
});
