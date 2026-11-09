import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 空消息遮罩 hidden 语义（黑屏根因回归）：
 *
 * .task-terminal-message 是 position:absolute;inset:0 的全尺寸遮罩，
 * 基础规则声明了作者源 display:grid。HTML hidden 属性仅通过 UA 样式表的
 * [hidden]{display:none} 生效，而作者源声明恒覆盖 UA 源——遮罩从挂载起
 * 永久可见：纯黑背景（#101216）盖住终端主体，absolute 定位截获 mousedown，
 * terminal.focus() 永不触发，表现为黑屏 + 输入无响应。
 *
 * 修复要求：面板样式必须提供 [hidden] 救场规则显式恢复 display:none。
 * linkedom 不执行 CSS 级联（无法断言 computed display），因此以样式文本
 * 包含该规则作为可测代理。
 */

const flushMicrotasks = async (rounds = 12): Promise<void> => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
};

describe('task-terminal-panel 空消息遮罩 hidden 语义', () => {
    let win: any;
    let doc: any;
    let listProfiles: () => Promise<unknown[]>;

    beforeAll(async () => {
        jest.unstable_mockModule('@xterm/xterm', () => ({
            Terminal: class {
                cols = 80;
                rows = 24;
                loadAddon() {}
                onData() {
                    return { dispose() {} };
                }
                onResize() {
                    return { dispose() {} };
                }
                write() {}
                reset() {}
                dispose() {}
                open() {}
                focus() {}
            }
        }));
        jest.unstable_mockModule('@xterm/addon-fit', () => ({
            FitAddon: class {
                fit() {}
            }
        }));

        const parsed = parseHTML('<!doctype html><html><body></body></html>');
        win = parsed.window;
        doc = parsed.document;
        Object.assign(globalThis, {
            window: win,
            document: doc,
            HTMLElement: win.HTMLElement,
            Element: win.Element,
            CustomEvent: win.CustomEvent,
            customElements: win.customElements,
            Event: win.Event,
            ResizeObserver: class {
                observe() {}
                disconnect() {}
            },
            requestAnimationFrame: () => 0,
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        (win as any).localStorage = {
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined
        };
        (win as any).terminalAPI = {
            onData: () => () => undefined,
            onExit: () => () => undefined,
            listProfiles: async () => listProfiles(),
            create: async () => ({ sessionId: 'session-1', backend: 'pty' }),
            start: async () => undefined,
            close: async () => undefined,
            resize: async () => undefined,
            acknowledge: async () => undefined,
            write: async () => undefined
        };

        await import('../../../renderer/components/taskTerminalPanel.js');
    });

    beforeEach(() => {
        doc.body.innerHTML = '';
        listProfiles = async () => [{ id: 'powershell:pwsh', kind: 'powershell' }];
    });

    function createPanel(): any {
        const container = doc.createElement('div');
        const panel = doc.createElement('task-terminal-panel');
        container.appendChild(panel);
        doc.body.appendChild(container);
        // linkedom 的 <select>.value 是 getter-only（真实浏览器可写）：
        // 补成可写数据属性，避免 profile 填充被环境限制打断。
        Object.defineProperty(panel.querySelector('[data-task-terminal-profile]'), 'value', {
            value: '',
            writable: true,
            configurable: true
        });
        return panel;
    }

    test('遮罩初始带 hidden，且样式必须显式恢复 [hidden] 的 display:none 语义', async () => {
        const panel = createPanel();
        await flushMicrotasks();
        const message = panel.querySelector('[data-task-terminal-message]');
        // 挂载即隐藏：没有待展示消息时遮罩不得出现
        expect(message.hasAttribute('hidden')).toBe(true);
        // 作者源 .task-terminal-message{display:grid} 恒覆盖 UA 样式表
        // [hidden]{display:none}（作者源优先级高于 UA 源），必须提供同源
        // [hidden] 救场规则，否则纯黑 absolute 遮罩永久盖住终端并截获点击
        // （黑屏 + 输入无响应）。
        const css = panel.querySelector('style').textContent;
        expect(css).toMatch(/\.task-terminal-message\[hidden\][^{}]*\{[^}]*display:\s*none/);
    });

    test('showMessage 显示遮罩、hideMessage 恢复 hidden 属性', async () => {
        listProfiles = async () => [];
        const panel = createPanel();
        await flushMicrotasks();
        const message = panel.querySelector('[data-task-terminal-message]');
        // 无可用 profile：遮罩取消 hidden 显示提示文本
        expect(message.hasAttribute('hidden')).toBe(false);
        expect(String(message.textContent).length).toBeGreaterThan(0);
        // 会话重建路径会隐藏遮罩：hidden 属性必须恢复
        (panel as any).hideMessage();
        expect(message.hasAttribute('hidden')).toBe(true);
    });
});
