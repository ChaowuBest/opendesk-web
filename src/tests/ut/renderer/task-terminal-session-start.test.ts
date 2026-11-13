import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 内置终端会话启动时序（页面后台 / rAF 冻结场景）：
 *
 * 1. 面板可能挂载在后台页面（窗口被遮挡/最小化，Electron backgroundThrottling）。
 *    此时 requestAnimationFrame 与 ResizeObserver 回调随渲染帧一起被冻结、永不执行；
 *    若 loadProfiles 依赖 rAF 调度，sessionId 永远为 null —— PTY 无输出（黑屏），
 *    且 terminal.onData 的 sessionId 拦截导致无法输入。
 * 2. hidden 期间切换 tab 的 display 变化同样不会触发 ResizeObserver 回调：
 *    页面恢复可见时（visibilitychange）需要兜底补启动尚未建立的会话。
 * 3. 默认收起、展开才建联：rAF 冻结不能阻断 profile 预载；会话由用户展开触发，
 *    visibilitychange 兜底覆盖“已展开但 host 几何不可见”的补启动场景。
 */

function rect(top: number, bottom: number): () => object {
    return () => ({
        left: 0,
        top,
        right: 1000,
        bottom,
        width: 1000,
        height: bottom - top,
        x: 0,
        y: top
    });
}

/** 依次清空微任务队列：queueMicrotask 与 async 续体都走微任务。 */
const flushMicrotasks = async (rounds = 12): Promise<void> => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
};

describe('task-terminal-panel 会话启动时序（页面后台 / rAF 冻结）', () => {
    let win: any;
    let doc: any;
    let visibilityState: string;
    let listProfilesCalls: number;
    let createCalls: number;
    let startCalls: number;

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
            // 模拟后台页面：rAF 回调被渲染帧冻结——只入队，永不执行。
            requestAnimationFrame: () => 0,
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        visibilityState = 'hidden';
        Object.defineProperty(doc, 'visibilityState', {
            get: () => visibilityState,
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
            listProfiles: async () => {
                listProfilesCalls++;
                return [{ id: 'powershell:pwsh', kind: 'powershell' }];
            },
            create: async () => {
                createCalls++;
                return { sessionId: `session-${createCalls}`, backend: 'pty' };
            },
            start: async () => {
                startCalls++;
            },
            close: async () => undefined,
            resize: async () => undefined,
            acknowledge: async () => undefined,
            write: async () => undefined
        };
        (win as any).settingAPI = {
            loadSettingObject: async () => ({
                debug: { experimental_features: { builtin_terminal: true } }
            }),
            onSettingChanged: () => () => undefined
        };

        await import('../../../renderer/components/taskTerminalPanel.js');
    });

    beforeEach(() => {
        doc.body.innerHTML = '';
        visibilityState = 'hidden';
        listProfilesCalls = 0;
        createCalls = 0;
        startCalls = 0;
    });

    function createPanel(hostHeight: number): any {
        const container = doc.createElement('div');
        const panel = doc.createElement('task-terminal-panel');
        container.appendChild(panel);
        doc.body.appendChild(container);
        // linkedom 默认几何全 0，手动给出 host 矩形以驱动 isTerminalVisible
        panel.querySelector('[data-task-terminal-host]').getBoundingClientRect = rect(300, 300 + hostHeight);
        // linkedom 的 <select>.value 是 getter-only，赋值抛 TypeError（真实浏览器可写）：
        // 补成可写数据属性，避免 loadProfiles 在填充 profile 时被环境限制打断。
        Object.defineProperty(panel.querySelector('[data-task-terminal-profile]'), 'value', {
            value: '',
            writable: true,
            configurable: true
        });
        return panel;
    }

    function setHostHeight(panel: any, height: number): void {
        panel.querySelector('[data-task-terminal-host]').getBoundingClientRect = rect(300, 300 + height);
    }

    function fireVisibilityChange(): void {
        doc.dispatchEvent(new win.Event('visibilitychange'));
    }

    function clickToggle(panel: any): void {
        panel.querySelector('[data-task-terminal-toggle]').dispatchEvent(new win.Event('click', { bubbles: true }));
    }

    test('页面后台挂载（rAF 冻结）时仍会加载 profile；展开后建立会话', async () => {
        const panel = createPanel(300);
        await flushMicrotasks();
        // rAF 冻结不能阻断 profile 加载：否则 sessionId 永远为 null，
        // PTY 无输出（黑屏）且输入被 onData 拦截。
        expect(listProfilesCalls).toBe(1);
        const select = panel.querySelector('[data-task-terminal-profile]');
        expect(select.children.length).toBe(1);
        // 默认收起：profile 就绪也不建联
        expect(createCalls).toBe(0);
        clickToggle(panel);
        await flushMicrotasks();
        expect(createCalls).toBe(1);
        expect(startCalls).toBe(1);
    });

    test('后台挂载且 host 不可见：展开不建联，恢复可见时 visibilitychange 兜底补启动', async () => {
        const panel = createPanel(0);
        await flushMicrotasks();
        expect(listProfilesCalls).toBe(1);
        expect(createCalls).toBe(0); // 默认收起
        clickToggle(panel);
        await flushMicrotasks();
        // host 不可见（tab 未激活）：已展开也不建联，等几何可见
        expect(createCalls).toBe(0);
        // hidden 期间用户切到 workspace tab：ResizeObserver 同样被冻结不回调，
        // 只有恢复可见后的 visibilitychange 能补启动。
        setHostHeight(panel, 300);
        visibilityState = 'visible';
        fireVisibilityChange();
        await flushMicrotasks();
        expect(createCalls).toBe(1);
    });

    test('恢复可见时已有会话则不重启（防切窗丢会话）', async () => {
        const panel = createPanel(300);
        await flushMicrotasks();
        clickToggle(panel);
        await flushMicrotasks();
        expect(createCalls).toBe(1);
        visibilityState = 'visible';
        fireVisibilityChange();
        await flushMicrotasks();
        // 已建立会话时 visibilitychange 不得重启，否则窗口每次遮挡-恢复都丢会话
        expect(createCalls).toBe(1);
    });

    test('断开连接后移除 visibilitychange 监听', async () => {
        const panel = createPanel(0);
        await flushMicrotasks();
        clickToggle(panel); // 展开后无会话（host 不可见），销毁后不得再补建
        await flushMicrotasks();
        panel.remove();
        await flushMicrotasks();
        setHostHeight(panel, 300);
        visibilityState = 'visible';
        fireVisibilityChange();
        await flushMicrotasks();
        // 面板已销毁，visibilitychange 不应再触发会话创建
        expect(createCalls).toBe(0);
    });
});
