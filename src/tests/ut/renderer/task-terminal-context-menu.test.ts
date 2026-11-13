import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 任务终端专属右键菜单：
 *
 * 背景：xterm 的选区在内部模型（非 DOM 选区），全局自绘编辑菜单（touchLongPressScript）
 * 判定不了；xterm 右键还会把隐藏 helper textarea 停靠到指针处（下一次右键会被全局
 * 脚本误判为编辑区）。全局脚本已对 .xterm 表面放行（另见 touch-long-press.test.ts），
 * 右键菜单由本面板自绘。
 *
 * 1. 右键终端主体弹出专属菜单（复制/粘贴/全选/清屏），并 preventDefault 抑制原生菜单；
 * 2. 复制随 terminal.hasSelection() 启停：无选区置灰且点击无副作用，有选区写出剪贴板；
 * 3. 粘贴经 preload 剪贴板桥读取后 terminal.paste()；会话断开后置灰；
 * 4. 全选/清屏直接调用 terminal.selectAll()/clear()；
 * 5. 菜单外 pointerdown、Escape 关闭；面板销毁（disconnectedCallback）清理菜单。
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

describe('task-terminal-panel 终端专属右键菜单', () => {
    let win: any;
    let doc: any;
    let visibilityState: string;
    let exitCallback: ((event: { sessionId: string; exitCode: number }) => void) | null;
    let terminalOpenCalls: number;
    let terminalCalls: string[];
    let terminalHasSelection: boolean;
    let terminalSelection: string;
    let clipboardWrites: string[];
    let clipboardReadCalls: number;
    let clipboardText: string;

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
                open() {
                    terminalOpenCalls++;
                }
                focus() {}
                hasSelection() {
                    return terminalHasSelection;
                }
                getSelection() {
                    return terminalSelection;
                }
                selectAll() {
                    terminalCalls.push('selectAll');
                }
                clear() {
                    terminalCalls.push('clear');
                }
                paste(text: string) {
                    terminalCalls.push(`paste:${text}`);
                }
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
            value: {
                languages: ['zh-CN'],
                language: 'zh-CN',
                clipboard: {
                    writeText: (text: string) => {
                        clipboardWrites.push(text);
                        return Promise.resolve();
                    }
                }
            },
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
        // preload 暴露的剪贴板读桥：面板粘贴优先走它（沙箱渲染器 readText 不可靠）
        (win as any).childFrameClipboard = {
            readText: async () => {
                clipboardReadCalls++;
                return clipboardText;
            },
            writeText: async () => undefined
        };
        (win as any).terminalAPI = {
            onData: () => () => undefined,
            onExit: (callback: (event: { sessionId: string; exitCode: number }) => void) => {
                exitCallback = callback;
                return () => undefined;
            },
            listProfiles: async () => [
                { id: 'powershell:pwsh', kind: 'powershell' },
                { id: 'bash:git-bash', kind: 'bash' }
            ],
            create: async () => ({ sessionId: 'session-1', backend: 'pty' }),
            start: async () => undefined,
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
        // 先移除面板再清空 body：panel.remove() 经 disconnectedCallback 关闭菜单
        // （菜单挂 document.body）。linkedom 的 replaceChildren 迭代器不容忍
        // 迭代中被移除的兄弟节点——若先 innerHTML='' 再间接触发菜单移除会
        // 崩溃（真实浏览器按规范安全，此处仅测试环境约束）。
        Array.from(doc.body.querySelectorAll('task-terminal-panel')).forEach((panel: any) => panel.remove());
        doc.body.innerHTML = '';
        visibilityState = 'visible';
        exitCallback = null;
        terminalOpenCalls = 0;
        terminalCalls = [];
        terminalHasSelection = false;
        terminalSelection = '';
        clipboardWrites = [];
        clipboardReadCalls = 0;
        clipboardText = '';
    });

    async function expandedPanel(): Promise<any> {
        const container = doc.createElement('div');
        const panel = doc.createElement('task-terminal-panel');
        container.appendChild(panel);
        doc.body.appendChild(container);
        panel.querySelector('[data-task-terminal-host]').getBoundingClientRect = rect(300, 600);
        // linkedom 的 <select>.value 是 getter-only，补成可写数据属性
        Object.defineProperty(panel.querySelector('[data-task-terminal-profile]'), 'value', {
            value: '',
            writable: true,
            configurable: true
        });
        await flushMicrotasks();
        panel.querySelector('[data-task-terminal-toggle]').dispatchEvent(new win.Event('click', { bubbles: true }));
        await flushMicrotasks();
        expect(terminalOpenCalls).toBe(1);
        return panel;
    }

    function openMenu(panel: any): any {
        const host = panel.querySelector('[data-task-terminal-host]');
        const event = new win.Event('contextmenu', { bubbles: true, cancelable: true });
        Object.assign(event, { clientX: 120, clientY: 80 });
        host.dispatchEvent(event);
        return event;
    }

    function getMenu(): any {
        return doc.querySelector('.od-task-terminal-menu');
    }

    function menuButton(action: string): any {
        return getMenu().querySelector(`[data-action="${action}"]`);
    }

    function clickButton(button: any): void {
        button.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
    }

    function dismissByPointer(): void {
        doc.body.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
    }

    test('右键终端主体弹出四项专属菜单并抑制原生菜单', async () => {
        const panel = await expandedPanel();
        const event = openMenu(panel);

        expect(event.defaultPrevented).toBe(true);
        const menu = getMenu();
        expect(menu).toBeTruthy();
        const actions = Array.from(menu.querySelectorAll('[data-action]')).map((b: any) =>
            b.getAttribute('data-action')
        );
        expect(actions).toEqual(['copy', 'paste', 'selectAll', 'clear']);
        // 菜单挂载在 document.body：不受面板内 overflow 裁剪，也不随面板重绘被清
        expect(menu.parentElement).toBe(doc.body);
    });

    test('复制：无选区置灰且点击无副作用；有选区时写出剪贴板并关闭菜单', async () => {
        const panel = await expandedPanel();

        terminalHasSelection = false;
        openMenu(panel);
        expect(menuButton('copy').classList.contains('disabled')).toBe(true);
        clickButton(menuButton('copy'));
        expect(clipboardWrites).toEqual([]);
        expect(terminalCalls).toEqual([]);

        dismissByPointer();
        expect(getMenu()).toBeNull();

        terminalHasSelection = true;
        terminalSelection = 'echo hi';
        openMenu(panel);
        expect(menuButton('copy').classList.contains('disabled')).toBe(false);
        clickButton(menuButton('copy'));
        expect(clipboardWrites).toEqual(['echo hi']);
        expect(getMenu()).toBeNull();
    });

    test('粘贴：经剪贴板桥读取后 terminal.paste；会话断开后置灰', async () => {
        const panel = await expandedPanel();

        clipboardText = 'pasted-text';
        openMenu(panel);
        expect(menuButton('paste').classList.contains('disabled')).toBe(false);
        clickButton(menuButton('paste'));
        await flushMicrotasks();
        expect(clipboardReadCalls).toBe(1);
        expect(terminalCalls).toEqual(['paste:pasted-text']);

        // 会话退出（onExit 回调）后：粘贴无意义，置灰
        dismissByPointer();
        exitCallback!({ sessionId: 'session-1', exitCode: 0 });
        await flushMicrotasks();
        openMenu(panel);
        expect(menuButton('paste').classList.contains('disabled')).toBe(true);
    });

    test('全选/清屏直接调用 terminal API', async () => {
        const panel = await expandedPanel();

        openMenu(panel);
        clickButton(menuButton('selectAll'));
        expect(terminalCalls).toEqual(['selectAll']);

        openMenu(panel);
        clickButton(menuButton('clear'));
        expect(terminalCalls).toEqual(['selectAll', 'clear']);
    });

    test('菜单外 pointerdown / Escape 关闭菜单', async () => {
        const panel = await expandedPanel();

        openMenu(panel);
        expect(getMenu()).toBeTruthy();
        dismissByPointer();
        expect(getMenu()).toBeNull();

        openMenu(panel);
        const keydown = new win.Event('keydown', { bubbles: true });
        Object.assign(keydown, { key: 'Escape' });
        doc.dispatchEvent(keydown);
        expect(getMenu()).toBeNull();
    });

    test('面板销毁（disconnectedCallback）时清理菜单', async () => {
        const panel = await expandedPanel();

        openMenu(panel);
        expect(getMenu()).toBeTruthy();
        panel.remove();
        expect(getMenu()).toBeNull();
    });
});
