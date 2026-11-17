import { beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';

/**
 * 分割线（splitter-widget）触摸拖动。
 *
 * 触摸拖动不会派发 mousemove：只监听 mousedown/mousemove/mouseup 时，
 * 手指按住分割线拖动完全无法调整宽度。实现必须走 pointer 事件，
 * 并在分割线上声明 touch-action: none（否则浏览器会把按住拖动判定为
 * 滚动/缩放手势并派发 pointercancel）。
 */

function pointerEvent(win: any, type: string, init: Record<string, unknown>): any {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(init)) {
        Object.defineProperty(event, key, { value, configurable: true });
    }
    return event;
}

describe('splitter-widget 分割线触摸拖动', () => {
    let win: any;
    let doc: any;
    let splitter: any;
    let resizer: any;
    let leftPanel: any;

    beforeAll(async () => {
        const parsed = parseHTML('<html><body></body></html>');
        win = parsed.window;
        doc = parsed.document;
        Object.assign(globalThis, {
            window: win,
            document: doc,
            HTMLElement: win.HTMLElement,
            customElements: win.customElements,
            CustomEvent: win.CustomEvent,
            Event: win.Event
        });
        await import('../../../renderer/components/splitter.js');
    });

    beforeEach(() => {
        doc.body.innerHTML = '';
        splitter = doc.createElement('splitter-widget');
        // 触摸拖动依赖容器几何：linkedom 默认返回全 0，这里给出稳定的容器矩形
        splitter.getBoundingClientRect = () => ({
            left: 0,
            top: 0,
            right: 1000,
            bottom: 600,
            width: 1000,
            height: 600,
            x: 0,
            y: 0
        });
        doc.body.appendChild(splitter);
        resizer = splitter.shadowRoot.getElementById('resizer');
        leftPanel = splitter.shadowRoot.getElementById('leftPanel');
    });

    test('触摸按下分割线后由 pointermove 调整左面板宽度', () => {
        resizer.dispatchEvent(pointerEvent(win, 'pointerdown', { button: 0, pointerId: 1, pointerType: 'touch' }));
        expect(splitter.hasAttribute('resizing')).toBe(true);

        win.dispatchEvent(pointerEvent(win, 'pointermove', { pointerId: 1, pointerType: 'touch', clientX: 420 }));
        expect(leftPanel.style.width).toBe('420px');

        win.dispatchEvent(pointerEvent(win, 'pointerup', { pointerId: 1, pointerType: 'touch' }));
        expect(splitter.hasAttribute('resizing')).toBe(false);
    });

    test('pointercancel 也能结束拖动，不会卡住分割线', () => {
        resizer.dispatchEvent(pointerEvent(win, 'pointerdown', { button: 0, pointerId: 2, pointerType: 'touch' }));
        expect(splitter.hasAttribute('resizing')).toBe(true);

        win.dispatchEvent(pointerEvent(win, 'pointercancel', { pointerId: 2, pointerType: 'touch' }));
        expect(splitter.hasAttribute('resizing')).toBe(false);
    });

    test('多指同按只跟随发起拖动的那根手指', () => {
        resizer.dispatchEvent(pointerEvent(win, 'pointerdown', { button: 0, pointerId: 1, pointerType: 'touch' }));

        // 第二根手指（触摸屏掌压）移动不能驱动宽度、抬起也不能结束拖动
        win.dispatchEvent(pointerEvent(win, 'pointermove', { pointerId: 2, pointerType: 'touch', clientX: 500 }));
        expect(leftPanel.style.width).toBe('316px');

        win.dispatchEvent(pointerEvent(win, 'pointerup', { pointerId: 2, pointerType: 'touch' }));
        expect(splitter.hasAttribute('resizing')).toBe(true);

        win.dispatchEvent(pointerEvent(win, 'pointermove', { pointerId: 1, pointerType: 'touch', clientX: 420 }));
        expect(leftPanel.style.width).toBe('420px');

        win.dispatchEvent(pointerEvent(win, 'pointerup', { pointerId: 1, pointerType: 'touch' }));
        expect(splitter.hasAttribute('resizing')).toBe(false);
    });

    test('仅鼠标事件不再驱动分割线（触摸拖动不派发 mousemove）', () => {
        resizer.dispatchEvent(pointerEvent(win, 'mousedown', { button: 0, clientX: 400 }));
        expect(splitter.hasAttribute('resizing')).toBe(false);

        win.dispatchEvent(pointerEvent(win, 'mousemove', { clientX: 420 }));
        expect(leftPanel.style.width).toBe('316px');
    });

    test('分割线声明 touch-action: none 并标记为拖拽表面', () => {
        const style = splitter.shadowRoot.querySelector('style').textContent;
        expect(style).toContain('touch-action: none');
        expect(resizer.getAttribute('data-od-no-longpress')).toBe('1');
    });

    test('分割线需要压住两侧面板，否则扩展命中区会被定位内容盖掉', () => {
        const style = splitter.shadowRoot.querySelector('style').textContent;
        // .resizer 规则里必须有层级，面板内的 position: relative 卡片会盖住 ::after 命中区
        expect(style).toMatch(/\.resizer\s*\{[^}]*z-index/);
    });
});

describe('分割线触摸拖动：其它面板接线', () => {
    const read = (rel: string): string => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

    test('taskview 右侧面板分割线使用指针事件并声明 touch-action: none', () => {
        const source = read('src/renderer/components/taskview.js');
        expect(source).toContain('resizer-group taskview-resizer');
        expect(source).toContain('touch-action: none');
        expect(source).toContain("resizer.addEventListener('pointerdown'");
        expect(source).not.toContain("resizer.addEventListener('mousedown'");
    });

    test('全局待办应用分割线使用指针事件', () => {
        const source = read('src/main/applications/todomgr/renderer/entry.ts');
        expect(source).toContain("resizer.addEventListener('pointerdown'");
        expect(source).not.toContain("resizer.addEventListener('mousedown'");
        expect(source).toContain('data-od-no-longpress="1"');
    });

    test('taskview 右侧面板分割线颜色跟随主题，不硬编码浅色', () => {
        const source = read('src/renderer/components/taskview.js');
        const tagStart = source.indexOf('class="resizer-group taskview-resizer');
        const resizerTag = source.slice(tagStart, source.indexOf('>', tagStart));
        // 硬编码的浅灰在深色模式下会变成一条刺眼的白线
        expect(resizerTag).not.toMatch(/#e0e0e0|#e5e7eb/);
        expect(read('src/renderer/styles/custom.css')).toMatch(
            /\.taskview-resizer\s*\{[^}]*linear-gradient\([^)]*var\(--od-border\)/
        );
    });
});
