import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';

/**
 * 内置终端面板布局：
 *
 * 1. workspace tab 的 .tab-content 必须是 flex 列布局——否则文件树按内容自然撑高，
 *    会把常驻底部的终端面板顶出主窗口可视区（表现为终端显示不全）。
 * 2. 终端面板底部与主窗口最外框之间要保留可见间距。
 * 3. 终端高度可拖拽调整（手柄在面板顶部边缘），走 pointer 事件
 *    （触摸拖动不派发 mousemove），并声明 touch-action: none、
 *    标记 data-od-no-longpress 跳过全局触摸长按脚本。
 */

const HEIGHT_STORAGE_KEY = 'od-task-terminal-height';
const DEFAULT_HEIGHT = 220;
const MIN_HEIGHT = 120;
const MIN_SIBLING_HEIGHT = 120;

function pointerEvent(win: any, type: string, init: Record<string, unknown>): any {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(init)) {
        Object.defineProperty(event, key, { value, configurable: true });
    }
    return event;
}

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

describe('task-terminal-panel 终端面板拖拽调整高度', () => {
    let win: any;
    let doc: any;
    let storage: Map<string, string>;

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
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        storage = new Map();
        (win as any).localStorage = {
            getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
            setItem: (key: string, value: string) => void storage.set(key, String(value)),
            removeItem: (key: string) => void storage.delete(key)
        };
        (win as any).terminalAPI = {
            onData: () => () => undefined,
            onExit: () => () => undefined,
            listProfiles: async () => [],
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
        storage.clear();
    });

    function createPanel(): any {
        // 宿主容器：top 0 / bottom 600（linkedom 默认几何全 0，手动给出稳定矩形）
        const container = doc.createElement('div');
        container.getBoundingClientRect = rect(0, 600);
        const panel = doc.createElement('task-terminal-panel');
        // 面板初始位于容器底部：top 300；手柄同样在 300
        panel.getBoundingClientRect = rect(300, 600);
        container.appendChild(panel);
        doc.body.appendChild(container);
        return panel;
    }

    function getResizer(panel: any): any {
        return panel.querySelector('[data-task-terminal-resizer]');
    }

    function getBody(panel: any): any {
        return panel.querySelector('.task-terminal-body');
    }

    test('默认高度 220px（未持久化时）', () => {
        const panel = createPanel();
        expect(getBody(panel).style.height).toBe(`${DEFAULT_HEIGHT}px`);
    });

    test('挂载时从持久化存储恢复高度', () => {
        storage.set(HEIGHT_STORAGE_KEY, '360');
        const panel = createPanel();
        expect(getBody(panel).style.height).toBe('360px');
    });

    test('面板顶部有拖拽手柄，标记为拖拽表面并带无障碍语义', () => {
        const panel = createPanel();
        const resizer = getResizer(panel);
        expect(resizer).toBeTruthy();
        expect(resizer.getAttribute('data-od-no-longpress')).toBe('1');
        expect(resizer.getAttribute('role')).toBe('separator');
        expect(resizer.getAttribute('aria-orientation')).toBe('horizontal');
        expect(resizer.getAttribute('aria-label')).toBeTruthy();
        // 手柄必须声明 touch-action: none，否则触摸拖动被判为滚动手势派发 pointercancel
        const style = panel.querySelector('style').textContent;
        expect(style).toContain('touch-action: none');
    });

    test('pointerdown 后向上拖动增大高度，结束后写入持久化存储', () => {
        const panel = createPanel();
        const resizer = getResizer(panel);
        const body = getBody(panel);

        resizer.dispatchEvent(pointerEvent(win, 'pointerdown', { button: 0, pointerId: 1, clientY: 300 }));
        expect(resizer.hasAttribute('dragging')).toBe(true);

        win.dispatchEvent(pointerEvent(win, 'pointermove', { pointerId: 1, clientY: 200 }));
        expect(body.style.height).toBe('320px');

        win.dispatchEvent(pointerEvent(win, 'pointerup', { pointerId: 1 }));
        expect(resizer.hasAttribute('dragging')).toBe(false);
        expect(storage.get(HEIGHT_STORAGE_KEY)).toBe('320');
    });

    test('高度受最小值限制，向下拖不会把终端压到不可用', () => {
        const panel = createPanel();
        const resizer = getResizer(panel);
        const body = getBody(panel);

        resizer.dispatchEvent(pointerEvent(win, 'pointerdown', { button: 0, pointerId: 1, clientY: 300 }));
        win.dispatchEvent(pointerEvent(win, 'pointermove', { pointerId: 1, clientY: 500 }));
        expect(body.style.height).toBe(`${MIN_HEIGHT}px`);

        win.dispatchEvent(pointerEvent(win, 'pointerup', { pointerId: 1 }));
    });

    test('高度受宿主容器可用空间限制，终端不会顶穿文件树', () => {
        const panel = createPanel();
        const resizer = getResizer(panel);
        const body = getBody(panel);

        resizer.dispatchEvent(pointerEvent(win, 'pointerdown', { button: 0, pointerId: 1, clientY: 300 }));
        // 手柄 top 300，容器 top 0，为上方文件树至少留 120px：最大高度 = 220 + 300 - 120 = 400
        win.dispatchEvent(pointerEvent(win, 'pointermove', { pointerId: 1, clientY: 50 }));
        expect(body.style.height).toBe('400px');

        win.dispatchEvent(pointerEvent(win, 'pointerup', { pointerId: 1 }));
    });

    test('pointercancel 结束拖拽，不留全局监听', () => {
        const panel = createPanel();
        const resizer = getResizer(panel);
        const body = getBody(panel);

        resizer.dispatchEvent(pointerEvent(win, 'pointerdown', { button: 0, pointerId: 3, clientY: 300 }));
        win.dispatchEvent(pointerEvent(win, 'pointercancel', { pointerId: 3 }));
        expect(resizer.hasAttribute('dragging')).toBe(false);

        // 拖拽已结束，后续移动不应再改变高度
        win.dispatchEvent(pointerEvent(win, 'pointermove', { pointerId: 3, clientY: 100 }));
        expect(body.style.height).toBe(`${DEFAULT_HEIGHT}px`);
    });

    test('多指同按只跟随发起拖动的那根手指', () => {
        const panel = createPanel();
        const resizer = getResizer(panel);
        const body = getBody(panel);

        resizer.dispatchEvent(pointerEvent(win, 'pointerdown', { button: 0, pointerId: 1, clientY: 300 }));
        // 第二根手指移动不能驱动高度，抬起也不能结束拖拽
        win.dispatchEvent(pointerEvent(win, 'pointermove', { pointerId: 2, clientY: 100 }));
        expect(body.style.height).toBe(`${DEFAULT_HEIGHT}px`);
        win.dispatchEvent(pointerEvent(win, 'pointerup', { pointerId: 2 }));
        expect(resizer.hasAttribute('dragging')).toBe(true);

        win.dispatchEvent(pointerEvent(win, 'pointermove', { pointerId: 1, clientY: 250 }));
        expect(body.style.height).toBe('270px');

        win.dispatchEvent(pointerEvent(win, 'pointerup', { pointerId: 1 }));
        expect(resizer.hasAttribute('dragging')).toBe(false);
    });

    test('断开连接时清理全局指针监听', () => {
        const panel = createPanel();
        const resizer = getResizer(panel);
        resizer.dispatchEvent(pointerEvent(win, 'pointerdown', { button: 0, pointerId: 1, clientY: 300 }));
        panel.remove();
        // 组件已销毁，再派发移动不应抛错或生效
        win.dispatchEvent(pointerEvent(win, 'pointermove', { pointerId: 1, clientY: 100 }));
        win.dispatchEvent(pointerEvent(win, 'pointerup', { pointerId: 1 }));
    });

    test('xterm 基础样式随面板自身注入（面板在 taskartifacts 的 shadow 树内，document 级 CSS 无法命中）', async () => {
        const inlineCss = (await import('@xterm/xterm/css/xterm.css?inline')).default;
        const panel = createPanel();
        const style = panel.querySelector('style').textContent;
        // xterm.css（.xterm/.xterm-viewport/.xterm-screen canvas 的布局规则）必须内联进面板样式，
        // 否则 canvas 渲染层失去绝对定位、错位被裁剪，表现为输入命令后内容不显示（黑屏）。
        expect(style).toContain(inlineCss);
    });
});

describe('workspace tab 终端布局（taskartifacts）', () => {
    const read = (rel: string): string => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

    test('workspace tab 的内容区使用 flex 列布局并裁剪溢出', () => {
        const source = read('src/renderer/components/taskartifacts.ts');
        expect(source).toMatch(/\.tab-content\[data-tab="workspace"\]\s*\{[^}]*display:\s*flex/);
        expect(source).toMatch(/\.tab-content\[data-tab="workspace"\]\s*\{[^}]*flex-direction:\s*column/);
        expect(source).toMatch(/\.tab-content\[data-tab="workspace"\]\s*\{[^}]*overflow:\s*hidden/);
    });

    test('终端面板底部与主窗口外框之间保留间距（≥ 10px）', () => {
        const source = read('src/renderer/components/taskartifacts.ts');
        const match = source.match(/task-terminal-panel\s*\{[^}]*padding:\s*0\s+\d+px\s+(\d+)px/);
        expect(match).toBeTruthy();
        expect(Number(match![1])).toBeGreaterThanOrEqual(10);
    });

    test('终端面板高度不被固定值锁死（可随拖拽调整）', () => {
        const source = read('src/renderer/components/taskTerminalPanel.ts');
        // 手柄走 pointer 事件（触摸拖动不派发 mousemove），监听挂 window 以跟出面板
        expect(source).toContain("resizerElement?.addEventListener('pointerdown'");
        expect(source).toContain("window.addEventListener('pointermove'");
        expect(source).not.toContain("resizerElement?.addEventListener('mousedown'");
    });

    test('xterm.css 不走全局副作用导入（会被 vite 提取进 document head，无法穿透 shadow 边界）', () => {
        const source = read('src/renderer/components/taskTerminalPanel.ts');
        expect(source).not.toMatch(/import\s+'@xterm\/xterm\/css\/xterm\.css'\s*;/);
        expect(source).toMatch(/from\s+'@xterm\/xterm\/css\/xterm\.css\?inline'/);
    });

    test('面板自有样式不使用 :host（light DOM 组件的 :host 会错配宿主 taskartifacts）', () => {
        const source = read('src/renderer/components/taskTerminalPanel.ts');
        const match = source.match(/const PANEL_CSS = `([\s\S]*?)`;/);
        expect(match).toBeTruthy();
        // 面板的 <style> 落在 taskartifacts 的 shadow 树内，:host 匹配的是 taskartifacts：
        // 会把宿主的 display:flex 覆盖成 display:block 并注入 flex:0 0 auto，整个 tab 布局塌陷。
        expect(match![1]).not.toContain(':host');
    });

    test('taskartifacts 为终端面板声明布局兜底（不依赖组件自身的 :host）', () => {
        const source = read('src/renderer/components/taskartifacts.ts');
        // 自定义元素默认 display:inline；min-width:0 允许 flex 收缩，fit 才能拿到正确宽度
        const match = source.match(/task-terminal-panel\s*\{[^}]*\}/);
        expect(match).toBeTruthy();
        expect(match![0]).toMatch(/min-width:\s*0/);
    });
});
