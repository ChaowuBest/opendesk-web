import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

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

function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('agentoffice composer send shortcut', () => {
    let WidgetClass: new () => HTMLElement;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            HTMLTextAreaElement: window.HTMLTextAreaElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        (window as any).applicationAPI = {
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };
        if (!(window.HTMLElement.prototype as any).getBoundingClientRect) {
            (window.HTMLElement.prototype as any).getBoundingClientRect = () => ({
                left: 0,
                top: 0,
                right: 200,
                bottom: 120,
                width: 200,
                height: 120
            });
        }

        const module = await import('../../../main/applications/agentoffice/renderer/entry.js');
        WidgetClass = module.AgentOfficeEntryWidget;
    });

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    /** 构造最小 chat 输入 DOM 并绑定事件，避免完整渲染 staff/messages */
    function setupWidget() {
        const widget = new WidgetClass() as any;
        widget.attachShadow({ mode: 'open' });
        widget.shadowRoot.innerHTML = '<textarea id="message-input"></textarea>';
        widget.strings = {
            'agentoffice.messagePlaceholder':
                '输入消息 · 拖拽文件 · 按 {iconEnter}Enter 发送 · {iconShift}Shift + {iconEnter}Enter 换行',
            'agentoffice.messagePlaceholder.ctrlEnter':
                '输入消息 · 拖拽文件 · 按 {iconCtrl}Ctrl + {iconEnter}Enter 发送 · {iconShift}Shift + {iconEnter}Enter 换行'
        };
        widget.bindEvents();
        const textarea = widget.shadowRoot.querySelector('#message-input') as HTMLTextAreaElement;
        // linkedom 的 textarea 未实现 setRangeText，用插入模拟替代
        textarea.setRangeText = jest.fn(function (this: HTMLTextAreaElement, text: string, start: number, end: number) {
            this.value = this.value.slice(0, start) + text + this.value.slice(end);
        });
        textarea.focus = jest.fn();
        return { widget, textarea };
    }

    test('Enter 发送模式下，Ctrl+Enter 插入换行且不发送', async () => {
        const { widget, textarea } = setupWidget();
        textarea.value = 'hello';
        textarea.selectionStart = 5;
        textarea.selectionEnd = 5;
        widget.sendMessage = jest.fn();

        textarea.dispatchEvent(createKeydownEvent('Enter', { ctrlKey: true }));
        await flush();

        expect(textarea.value).toBe('hello\n');
        expect(widget.sendMessage).not.toHaveBeenCalled();
    });

    test('Enter 发送模式下，Ctrl+Shift+Enter 同样插入换行且不发送', async () => {
        const { widget, textarea } = setupWidget();
        textarea.value = 'hello';
        textarea.selectionStart = 5;
        textarea.selectionEnd = 5;
        widget.sendMessage = jest.fn();

        textarea.dispatchEvent(createKeydownEvent('Enter', { ctrlKey: true, shiftKey: true }));
        await flush();

        expect(textarea.value).toBe('hello\n');
        expect(widget.sendMessage).not.toHaveBeenCalled();
    });

    test('Enter 发送模式下，Enter 触发发送', async () => {
        const { widget, textarea } = setupWidget();
        textarea.value = 'hello';
        widget.sendMessage = jest.fn();

        textarea.dispatchEvent(createKeydownEvent('Enter'));
        await flush();

        expect(widget.sendMessage).toHaveBeenCalledTimes(1);
    });

    test('Ctrl+Enter 发送模式下，Ctrl+Enter 触发发送且不插入换行', async () => {
        const { widget, textarea } = setupWidget();
        widget.ctrlEnterSend = true;
        textarea.value = 'hello';
        widget.sendMessage = jest.fn();

        textarea.dispatchEvent(createKeydownEvent('Enter', { ctrlKey: true }));
        await flush();

        expect(widget.sendMessage).toHaveBeenCalledTimes(1);
        expect(textarea.value).toBe('hello');
    });

    test('占位符富文本包含拖拽提示、回车键图标与快捷键文案', () => {
        const { widget } = setupWidget();
        const html = widget.getPlaceholderHTML();
        expect(html).toContain('输入消息');
        expect(html).toContain('拖拽文件');
        expect(html).toContain('composer-placeholder-icon');
        expect(html).toContain('<svg');
        expect(html).toContain('Enter');
        // 发送提示与换行提示各有一个键图标（Enter / Shift），共出现 3 处图标
        expect(html.match(/composer-placeholder-icon/g)).toHaveLength(3);
        // 发送提示的 Enter 图标应插在「按」之后、Enter 之前
        expect(html.indexOf('composer-placeholder-icon')).toBeLessThan(html.indexOf('Enter'));

        const plain = widget.getInputPlaceholder();
        expect(plain).toContain('按 Enter 发送');
        expect(plain).toContain('Shift + Enter 换行');
        expect(plain).not.toContain('{iconEnter}');
        expect(plain).not.toContain('{iconShift}');
    });

    test('切换 Ctrl+Enter 发送后占位符文案同步更新', () => {
        const { widget } = setupWidget();
        widget.ctrlEnterSend = true;
        expect(widget.getInputPlaceholder()).toContain('Ctrl + Enter');
        expect(widget.getInputPlaceholder()).toContain('Shift + Enter 换行');
    });
});
