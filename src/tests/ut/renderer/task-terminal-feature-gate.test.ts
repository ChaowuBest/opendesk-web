import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 内置终端实验性功能门禁（debug.experimental_features.builtin_terminal）：
 *
 * 1. 隔离必须用组件内联 style.display：宿主 taskartifacts 对 task-terminal-panel
 *    声明了 display:block 作者样式，恒覆盖 hidden 属性的 UA 规则（黑屏 bug 同构陷阱）。
 * 2. 开关关闭时不加载 profile、不建立会话；运行中关闭要停掉已有会话（防 PTY 泄漏）。
 * 3. 设置读取失败保持隐藏（默认关闭），与 homepage 的 immersive_desktop 消费模式一致。
 * 4. 开关开启后面板默认收起：只预载 profile、不建联，用户展开（toggle）才建联。
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

const flushMicrotasks = async (rounds = 16): Promise<void> => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
};

describe('task-terminal-panel 实验性功能门禁（builtin_terminal）', () => {
    let win: any;
    let doc: any;
    let visibilityState: string;
    let listProfilesCalls: number;
    let createCalls: number;
    let startCalls: number;
    let closeCalls: number;
    let builtinTerminalEnabled: boolean;
    let settingCallbacks: Array<(setting: unknown) => void>;

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

        visibilityState = 'visible';
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
            close: async () => {
                closeCalls++;
            },
            resize: async () => undefined,
            acknowledge: async () => undefined,
            write: async () => undefined
        };
        (win as any).settingAPI = {
            loadSettingObject: async () => ({
                debug: { experimental_features: { builtin_terminal: builtinTerminalEnabled } }
            }),
            onSettingChanged: (callback: (setting: unknown) => void) => {
                settingCallbacks.push(callback);
                return () => {
                    const index = settingCallbacks.indexOf(callback);
                    if (index >= 0) settingCallbacks.splice(index, 1);
                };
            }
        };

        await import('../../../renderer/components/taskTerminalPanel.js');
    });

    beforeEach(() => {
        doc.body.innerHTML = '';
        visibilityState = 'visible';
        listProfilesCalls = 0;
        createCalls = 0;
        startCalls = 0;
        closeCalls = 0;
        builtinTerminalEnabled = false;
        settingCallbacks = [];
    });

    function createPanel(hostHeight: number): any {
        const container = doc.createElement('div');
        const panel = doc.createElement('task-terminal-panel');
        container.appendChild(panel);
        doc.body.appendChild(container);
        // host 几何可见：证明门禁拦截靠 featureEnabled 而非几何不可见
        panel.querySelector('[data-task-terminal-host]').getBoundingClientRect = rect(300, 300 + hostHeight);
        // linkedom 的 <select>.value 是 getter-only（真实浏览器可写）：
        // 补成可写数据属性，避免 loadProfiles 在填充 profile 时被环境限制打断。
        Object.defineProperty(panel.querySelector('[data-task-terminal-profile]'), 'value', {
            value: '',
            writable: true,
            configurable: true
        });
        return panel;
    }

    function emitSettingChanged(enabled: boolean): void {
        for (const callback of [...settingCallbacks]) {
            callback({ debug: { experimental_features: { builtin_terminal: enabled } } });
        }
    }

    function clickToggle(panel: any): void {
        panel.querySelector('[data-task-terminal-toggle]').dispatchEvent(new win.Event('click', { bubbles: true }));
    }

    test('开关关闭：面板以内联 display 隔离，且不加载 profile、不建立会话', async () => {
        const panel = createPanel(300);
        await flushMicrotasks();
        // 必须是内联 style 而非 hidden 属性：宿主 display:block 作者样式
        // 恒覆盖 hidden 的 UA 规则，hidden 会导致面板照常显示（黑屏 bug 同构）。
        expect(panel.style.display).toBe('none');
        expect(listProfilesCalls).toBe(0);
        expect(createCalls).toBe(0);
    });

    test('开关开启：面板显示但默认收起，用户展开后建立会话', async () => {
        builtinTerminalEnabled = true;
        const panel = createPanel(300);
        await flushMicrotasks();
        expect(panel.style.display).toBe('');
        expect(listProfilesCalls).toBe(1);
        // 默认收起：profile 已预载但不建联
        expect(createCalls).toBe(0);
        clickToggle(panel);
        await flushMicrotasks();
        expect(createCalls).toBe(1);
        expect(startCalls).toBe(1);
    });

    test('运行中关闭开关：隐藏面板并关闭已有会话', async () => {
        builtinTerminalEnabled = true;
        const panel = createPanel(300);
        await flushMicrotasks();
        clickToggle(panel);
        await flushMicrotasks();
        expect(createCalls).toBe(1);
        emitSettingChanged(false);
        await flushMicrotasks();
        expect(panel.style.display).toBe('none');
        // 已有会话必须关闭，否则后台 PTY 进程泄漏
        expect(closeCalls).toBe(1);
    });

    test('运行中重新开启：恢复显示并重建会话（profile 已在内存，不重新加载）', async () => {
        builtinTerminalEnabled = true;
        const panel = createPanel(300);
        await flushMicrotasks();
        clickToggle(panel);
        await flushMicrotasks();
        emitSettingChanged(false);
        await flushMicrotasks();
        emitSettingChanged(true);
        await flushMicrotasks();
        expect(panel.style.display).toBe('');
        expect(listProfilesCalls).toBe(1);
        expect(createCalls).toBe(2);
        expect(startCalls).toBe(2);
    });

    test('开关关闭时 host 恢复可见也不建立会话（visibilitychange 兜底被门禁拦截）', async () => {
        const panel = createPanel(0);
        await flushMicrotasks();
        panel.querySelector('[data-task-terminal-host]').getBoundingClientRect = rect(300, 600);
        visibilityState = 'visible';
        doc.dispatchEvent(new win.Event('visibilitychange'));
        await flushMicrotasks();
        expect(createCalls).toBe(0);
    });

    test('面板销毁后退订设置变更', async () => {
        builtinTerminalEnabled = true;
        const panel = createPanel(300);
        await flushMicrotasks();
        expect(settingCallbacks.length).toBe(1);
        panel.remove();
        await flushMicrotasks();
        // disconnectedCallback 必须退订，否则已销毁面板仍响应设置变更
        expect(settingCallbacks.length).toBe(0);
        const closeCallsAfterDispose = closeCalls;
        emitSettingChanged(false);
        await flushMicrotasks();
        expect(closeCalls).toBe(closeCallsAfterDispose);
    });
});
