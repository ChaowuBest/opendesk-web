import { beforeAll, describe, expect, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fixedLayerOrigin, viewportToLayer, visibleViewportRect } from '../../../renderer/utils/window-frame.js';

/**
 * Linux 自绘圆角窗口（html.window-rounded）下浮层坐标换算的回归测试。
 *
 * window-rounded 下 #app-root 是 fixed 后代的包含块且相对视口内缩 --od-window-margin
 * （20px），视口坐标直接赋给其子树内的 fixed 浮层会整体偏移一个边距：
 * https:// 复现路径为侧边栏应用菜单/输入区模型面板等（fixed + 视口坐标）。
 */

interface FakeStyle {
    transform?: string;
    perspective?: string;
    filter?: string;
    borderLeftWidth?: string;
    borderTopWidth?: string;
    willChange?: string;
    contain?: string;
    getPropertyValue?: (name: string) => string;
}

function makeStyle(overrides: FakeStyle = {}): FakeStyle {
    return {
        transform: 'none',
        perspective: 'none',
        filter: 'none',
        borderLeftWidth: '0px',
        borderTopWidth: '0px',
        willChange: 'auto',
        contain: 'none',
        getPropertyValue: () => 'none',
        ...overrides
    };
}

describe('window-frame fixed layer origin', () => {
    let document: any;
    let window: any;

    beforeAll(async () => {
        ({ window } = parseHTML('<!doctype html><html><body></body></html>'));
        document = window.document;
        Object.assign(globalThis, {
            window,
            document,
            Node: window.Node,
            Element: window.Element,
            HTMLElement: window.HTMLElement,
            ShadowRoot: window.ShadowRoot
        });
    });

    function installStyles(styleMap: Map<Element, FakeStyle>): void {
        window.getComputedStyle = (el: Element) => styleMap.get(el) ?? makeStyle();
    }

    function stubRect(el: Element, left: number, top: number, width = 100, height = 80): void {
        (el as any).getBoundingClientRect = () => ({
            left,
            top,
            right: left + width,
            bottom: top + height,
            width,
            height
        });
    }

    test('无包含块建立者时 fixed 以视口为原点', () => {
        document.body.innerHTML = '<div id="plain"><span id="target"></span></div>';
        installStyles(new Map());
        const target = document.getElementById('target');
        expect(fixedLayerOrigin(target)).toEqual({ x: 0, y: 0 });
        expect(viewportToLayer(target, 100, 120)).toEqual({ x: 100, y: 120 });
    });

    test('window-rounded 场景：#app-root（transform + inset 20）成为包含块', () => {
        document.body.innerHTML = '<div id="app-root"><div id="menu"></div></div>';
        const appRoot = document.getElementById('app-root');
        const menu = document.getElementById('menu');
        stubRect(appRoot, 20, 20, 800, 600);
        installStyles(new Map([[appRoot, makeStyle({ transform: 'translateZ(0)' })]]));
        expect(fixedLayerOrigin(menu)).toEqual({ x: 20, y: 20 });
        // 视口期望位置 (100, 120) 应写入包含块坐标 (80, 100)
        expect(viewportToLayer(menu, 100, 120)).toEqual({ x: 80, y: 100 });
    });

    test('原点取 padding box：祖先带边框时需加上边框宽度', () => {
        document.body.innerHTML = '<div id="frame"><div id="menu"></div></div>';
        const frame = document.getElementById('frame');
        const menu = document.getElementById('menu');
        stubRect(frame, 20, 20);
        installStyles(
            new Map([[frame, makeStyle({ transform: 'translateZ(0)', borderLeftWidth: '5px', borderTopWidth: '6px' })]])
        );
        expect(fixedLayerOrigin(menu)).toEqual({ x: 25, y: 26 });
    });

    test('中间存在带 transform 的祖先时取最近者', () => {
        document.body.innerHTML = '<div id="app-root"><div id="panel"><div id="menu"></div></div></div>';
        const appRoot = document.getElementById('app-root');
        const panel = document.getElementById('panel');
        const menu = document.getElementById('menu');
        stubRect(appRoot, 20, 20);
        stubRect(panel, 40, 40);
        installStyles(
            new Map([
                [appRoot, makeStyle({ transform: 'translateZ(0)' })],
                [panel, makeStyle({ transform: 'translateZ(0)' })]
            ])
        );
        expect(fixedLayerOrigin(menu)).toEqual({ x: 40, y: 40 });
    });

    test('filter / will-change / contain 同样建立包含块', () => {
        for (const overrides of [{ filter: 'blur(2px)' }, { willChange: 'transform' }, { contain: 'layout paint' }]) {
            document.body.innerHTML = '<div id="host"><div id="menu"></div></div>';
            const host = document.getElementById('host');
            const menu = document.getElementById('menu');
            stubRect(host, 12, 34);
            installStyles(new Map([[host, makeStyle(overrides)]]));
            expect(fixedLayerOrigin(menu)).toEqual({ x: 12, y: 34 });
        }
    });

    test('穿透 shadow 边界：宿主带 transform 时以宿主为原点', () => {
        document.body.innerHTML = '<div id="app-root"></div>';
        const appRoot = document.getElementById('app-root');
        stubRect(appRoot, 20, 20);
        const host = document.createElement('div');
        appRoot.appendChild(host);
        stubRect(host, 30, 50);
        const shadow = host.attachShadow({ mode: 'open' });
        const flyout = document.createElement('div');
        shadow.appendChild(flyout);
        installStyles(
            new Map([
                [appRoot, makeStyle({ transform: 'translateZ(0)' })],
                [host, makeStyle({ transform: 'translateZ(0)' })]
            ])
        );
        expect(fixedLayerOrigin(flyout)).toEqual({ x: 30, y: 50 });

        // 宿主无 transform 时不建立包含块，继续向外落到 #app-root
        installStyles(
            new Map([
                [appRoot, makeStyle({ transform: 'translateZ(0)' })],
                [host, makeStyle()]
            ])
        );
        expect(fixedLayerOrigin(flyout)).toEqual({ x: 20, y: 20 });
    });
});

describe('visibleViewportRect', () => {
    let document: any;
    let window: any;

    beforeAll(async () => {
        ({ window } = parseHTML('<!doctype html><html><body></body></html>'));
        document = window.document;
        Object.assign(globalThis, { window, document, Element: window.Element });
    });

    test('存在 #app-root 时返回其矩形（可视内容区）', () => {
        document.body.innerHTML = '<div id="app-root"></div>';
        const appRoot = document.getElementById('app-root');
        (appRoot as any).getBoundingClientRect = () => ({
            left: 20,
            top: 20,
            right: 820,
            bottom: 620,
            width: 800,
            height: 600
        });
        expect(visibleViewportRect()).toEqual({ left: 20, top: 20, right: 820, bottom: 620 });
    });

    test('最大化（margin 折叠为 0）时 #app-root 铺满窗口，矩形随之变化', () => {
        document.body.innerHTML = '<div id="app-root"></div>';
        const appRoot = document.getElementById('app-root');
        (appRoot as any).getBoundingClientRect = () => ({
            left: 0,
            top: 0,
            right: 1024,
            bottom: 768,
            width: 1024,
            height: 768
        });
        expect(visibleViewportRect()).toEqual({ left: 0, top: 0, right: 1024, bottom: 768 });
    });

    test('无 #app-root 或不可测量时退化为整个窗口视口', () => {
        document.body.innerHTML = '';
        window.innerWidth = 1024;
        window.innerHeight = 768;
        expect(visibleViewportRect()).toEqual({ left: 0, top: 0, right: 1024, bottom: 768 });

        const appRoot = document.createElement('div');
        document.body.appendChild(appRoot);
        (appRoot as any).getBoundingClientRect = () => ({
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            width: 0,
            height: 0
        });
        expect(visibleViewportRect()).toEqual({ left: 0, top: 0, right: 1024, bottom: 768 });
    });
});

/**
 * titlebar.css 拖拽层内缩规则的回归钉。
 *
 * 最大化后 titlebar 消失（拖拽区无效、窗口控制按钮飞出窗口）的根因：
 * `width: calc(100% - var(--od-window-margin) * 2)` 在最大化折叠 --od-window-margin
 * 为无单位 0 后，calc 里是「百分比 - 数字」，类型非法 → 整条 width 声明在计算值
 * 阶段失效 → fixed 拖拽层宽度退化为 0（内部按钮均为 absolute，无流式内容），
 * 按钮随之定位到 x=-120 的窗口外。普通状态 margin 为 20px（百分比 - 长度）合法，
 * 故仅在最大化/全屏复现。宽度必须以 left+right 内缩表达，禁止对
 * --od-window-margin 做 calc 混合运算。
 */
describe('titlebar.css drag overlay inset (regression)', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'src/renderer/styles/titlebar.css'), 'utf8');

    test('window-rounded 下拖拽层以 left+right 内缩，宽度不得对 margin 变量做 calc 混合运算', () => {
        const block = css.match(/html\.window-rounded \.drag-overlay\s*\{[^}]*\}/);
        expect(block).toBeTruthy();
        const body = block![0];
        expect(body).toContain('top: var(--od-window-margin);');
        expect(body).toContain('left: var(--od-window-margin);');
        expect(body).toContain('right: var(--od-window-margin);');
        expect(body).toMatch(/width:\s*auto;/);
        // calc 混合「百分比 - 数字」在 margin 折叠为 0 时非法，见上方说明
        expect(body).not.toMatch(/calc\([^)]*--od-window-margin/);
    });

    test('最大化/全屏折叠阴影边距，使拖拽层回到窗口边缘', () => {
        expect(css).toMatch(/\.window-maximized[\s\S]{0,120}?--od-window-margin:\s*0\s*;/);
        expect(css).toMatch(/\.window-fullscreen[\s\S]{0,120}?--od-window-margin:\s*0\s*;/);
    });
});
