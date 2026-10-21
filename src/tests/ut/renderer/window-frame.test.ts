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
/**
 * index.html 拖拽层双击最大化回归钉。
 *
 * Linux(X11) 上 -webkit-app-region: drag 仅发送 _NET_WM_MOVERESIZE 拖动请求，
 * 没有系统级双击最大化（Windows/macOS 由 Chromium 原生处理），行为随窗口管理器
 * 变化而不稳定。必须在 Linux 分支手动监听 dblclick 调用 maximizeMainWindow，
 * 并排除窗口控制按钮（no-drag 按钮双击会冒泡到拖拽层，若放行会误触发最大化）。
 */
describe('index.html drag overlay double-click (regression)', () => {
    const html = readFileSync(path.resolve(process.cwd(), 'src/renderer/index.html'), 'utf8');

    test('Linux 分支为拖拽层注册双击最大化，且排除窗口控制按钮', () => {
        const anchor = 'if (window.systemInfo && window.systemInfo.isLinux)';
        const start = html.indexOf(anchor);
        const end = html.indexOf('window.globalControlAPI =', start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const linuxBlock = html.slice(start, end);
        expect(linuxBlock).toContain("dragOverlay.addEventListener('dblclick'");
        expect(linuxBlock).toContain("closest('button')");
        expect(linuxBlock).toContain('settingAPI.maximizeMainWindow()');
        expect(linuxBlock).toContain('updateWindowShape');
        // Linux 拖拽层为 no-drag：pointer 拖动通知主进程手动会话，右键 preventDefault
        expect(linuxBlock).toContain("dragOverlay.addEventListener('pointerdown'");
        expect(linuxBlock).toContain('window.windowDragAPI.start(');
        expect(linuxBlock).toContain("dragOverlay.addEventListener('contextmenu'");
        // 移动超阈值才启动拖动（单击不触发窗口还原/跳位，双击最大化不受影响）
        expect(linuxBlock).toContain("dragOverlay.addEventListener('pointermove'");
        expect(linuxBlock).toContain('DRAG_THRESHOLD');
    });
}); /**
 * Linux 拖拽层 no-drag 覆盖的回归钉：
 *
 * -webkit-app-region: drag 在 Linux(X11)/GTK 下被当作自绘标题栏，右键触发
 * WM 系统窗口菜单（弹位错误、grab 输入导致点不动/关不掉）。主窗口拖拽层
 * 因此在 html.window-rounded（仅 Linux 注入）下切为 no-drag，拖动改走
 * windowDragAPI 手动会话。基础规则必须保持 drag，确保其他平台不受影响。
 */
describe('titlebar.css drag overlay no-drag override (regression)', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'src/renderer/styles/titlebar.css'), 'utf8');

    test('基础拖拽层仍为 drag（Windows/macOS 原生拖拽路径不变）', () => {
        expect(css).toMatch(/\.drag-overlay\s*\{[^}]*app-region:\s*drag/);
    });

    test('window-rounded（Linux 专属）下存在 no-drag 覆盖', () => {
        const blocks = css.match(/html\.window-rounded \.drag-overlay\s*\{[^}]*\}/g) ?? [];
        expect(blocks.some((block) => /-webkit-app-region:\s*no-drag\s*;/.test(block))).toBe(true);
    });
});

/**
 * window-rounded 下贴角窗口控制按钮圆角的回归钉：
 *
 * 窗口控制层（.drag-overlay）是 #app-root 的兄弟节点，不受其圆角 overflow 裁切；
 * 贴住内容区右上角的最右按钮（关闭）hover 背景若保持直角矩形，会画进内容圆角
 * 弧线之外、破坏窗口圆角形状。必须给贴角按钮补与窗口一致的右上圆角，半径引用
 * var(--od-window-radius)（最大化/全屏折叠为 0 时自动退化直角），且规则仅挂
 * html.window-rounded（仅 Linux 注入）前缀，其他平台不受影响。
 */
describe('titlebar.css corner control button radius (regression)', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'src/renderer/styles/titlebar.css'), 'utf8');

    test('window-rounded 下贴角按钮引用窗口圆角变量补右上圆角', () => {
        const block = css.match(/html\.window-rounded \.drag-overlay \.window-control-btn:last-child\s*\{[^}]*\}/);
        expect(block).toBeTruthy();
        expect(block![0]).toContain('border-top-right-radius: var(--od-window-radius);');
    });
});

/**
 * 触摸屏/手写笔拖动与 resize 的驱动来源回归钉。
 *
 * 触摸不会更新系统光标位置，主进程轮询 screen.getCursorScreenPoint() 取到的始终是
 * 陈旧坐标：拖动时窗口跳到错误位置后不再跟随手指，resize 位移恒为 0。renderer 必须
 * 按 event.pointerType 分流——鼠标仍走主进程光标轮询（指针拖出窗口也能跟随），
 * 触摸/手写笔改由 pointermove 上报窗口内坐标（driver='pointer'）驱动会话。
 */
describe('触摸屏拖动/resize 驱动分流 (regression)', () => {
    const html = readFileSync(path.resolve(process.cwd(), 'src/renderer/index.html'), 'utf8');
    const shadowResizeSource = readFileSync(
        path.resolve(process.cwd(), 'src/renderer/components/windowShadowResize.ts'),
        'utf8'
    );
    const preload = readFileSync(path.resolve(process.cwd(), 'src/renderer/preload.js'), 'utf8');
    const mainSource = readFileSync(path.resolve(process.cwd(), 'src/main/main.ts'), 'utf8');
    const css = readFileSync(path.resolve(process.cwd(), 'src/renderer/styles/titlebar.css'), 'utf8');

    test('index.html 拖拽层按 pointerType 选择驱动来源，pointer 驱动上报窗口内坐标并按帧合并', () => {
        const anchor = 'if (window.systemInfo && window.systemInfo.isLinux)';
        const start = html.indexOf(anchor);
        const end = html.indexOf('window.globalControlAPI =', start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const linuxBlock = html.slice(start, end);
        expect(linuxBlock).toContain("event.pointerType === 'mouse' ? 'cursor' : 'pointer'");
        expect(linuxBlock).toContain('dragPointerState.driver');
        // 上报窗口内坐标（触摸 screenX 在 X11 下不可靠），且按 rAF 合并避免逐条
        // IPC 压垮主进程
        expect(linuxBlock).toContain('pendingDragPoint = { x: event.clientX, y: event.clientY };');
        expect(linuxBlock).toContain('window.windowDragAPI.move(');
        expect(linuxBlock).toContain('requestAnimationFrame(flushDragPoint)');
        // 多指同按：只跟随发起拖动的那根手指
        expect(linuxBlock).toContain('event.pointerId !== dragPointerState.pointerId');
    });

    test('触摸双击顶部触发最大化（Chromium 不为触摸派发 dblclick）', () => {
        const anchor = 'if (window.systemInfo && window.systemInfo.isLinux)';
        const start = html.indexOf(anchor);
        const downStart = html.indexOf("dragOverlay.addEventListener('pointerdown'", start);
        const downEnd = html.indexOf("dragOverlay.addEventListener('pointermove'", downStart);
        expect(downStart).toBeGreaterThan(start);
        expect(downEnd).toBeGreaterThan(downStart);
        const pointerDown = html.slice(downStart, downEnd);
        expect(pointerDown).toContain('DOUBLE_TAP_MS');
        expect(pointerDown).toContain("event.pointerType !== 'mouse'");
        expect(pointerDown).toContain('maximizeMainWindow()');
    });

    test('resize 感应条按 pointerType 选择驱动来源，后续事件挂在 window 上', () => {
        expect(shadowResizeSource).toContain("event.pointerType === 'mouse' ? 'cursor' : 'pointer'");
        expect(shadowResizeSource).toContain('shadowResizeAPI?.start(direction, {');
        expect(shadowResizeSource).toContain('clientX: event.clientX');
        expect(shadowResizeSource).toContain('shadowResizeAPI?.move(');
        expect(shadowResizeSource).toContain('requestAnimationFrame(flushPendingPoint)');
        // resize 会重排感应条，capture 目标可能失效；window 级监听保证事件连续
        expect(shadowResizeSource).toContain("window.addEventListener('pointermove', onPointerMove)");
        expect(shadowResizeSource).toContain('event.pointerId !== activePointer.pointerId');
    });

    test('首次触摸后放宽 resize 感应条命中区，鼠标保持原宽度', () => {
        // renderer：非鼠标指针首次按下后挂类，挂上即注销监听
        expect(shadowResizeSource).toContain("document.addEventListener('pointerdown', onTouchPointerDown, true)");
        expect(shadowResizeSource).toContain("document.documentElement.classList.add('touch-resize-wide')");
        expect(shadowResizeSource).toContain("document.removeEventListener('pointerdown', onTouchPointerDown, true)");
        // CSS：命中厚度抽成 --od-resize-hit（默认正好铺满边距环），挂类后向内压进内容区
        expect(css).toMatch(/\.od-shadow-resize-handle\s*\{[^}]*--od-resize-hit:\s*var\(--od-window-margin, 0px\);/);
        expect(css).toMatch(
            /html\.touch-resize-wide \.od-shadow-resize-handle\s*\{[^}]*--od-resize-hit:\s*calc\(var\(--od-window-margin, 0px\) \+ 10px\);/
        );
        // 感应条尺寸与内缩一律走 --od-resize-hit，否则放宽不生效
        expect(css).toMatch(/data-direction='e'\]\s*\{\s*right:\s*0;[^}]*width:\s*var\(--od-resize-hit\);/);
        expect(css).toMatch(/data-direction='n'\]\s*\{\s*top:\s*0;[^}]*height:\s*var\(--od-resize-hit\);/);
    });

    test('preload 与 main 打通 pointer 坐标上报通道', () => {
        expect(preload).toContain("ipcRenderer.send('window:dragMove'");
        expect(preload).toContain("ipcRenderer.send('window:shadowResizeMove'");
        expect(mainSource).toContain("ipcMain.on('window:dragMove'");
        expect(mainSource).toContain("ipcMain.on('window:shadowResizeMove'");
    });

    test('拖拽层与 resize 感应条禁用默认触摸手势，避免 pointercancel 中断会话', () => {
        const blocks = css.match(/html\.window-rounded \.drag-overlay\s*\{[^}]*\}/g) ?? [];
        expect(blocks.some((block) => /touch-action:\s*none\s*;/.test(block))).toBe(true);
        expect(css).toMatch(/\.od-shadow-resize-handle\s*\{[^}]*touch-action:\s*none\s*;/);
    });
});

/**
 * 阴影边距在缩放偏好下的单位回归钉。
 *
 * main 侧按 DIP 扩展窗口矩形（LINUX_WINDOW_SHADOW_MARGIN = 20），而 CSS 长度是
 * CSS 像素：主窗口按 gui_config.scale_factor 设置 webContents.setZoomFactor 后
 * 1 CSS px ≠ 1 DIP，内容内缩 20 CSS px 只有 20*zoom DIP，窗口矩形四周会多出
 * 20*(1-zoom) 的透明边（阴影被裁、窗口边缘外出现看不见的可点击区）。
 * 因此 --od-window-margin 必须按 zoom factor 反算；zoom 初值需在首帧前同步拿到
 * （additionalArguments → preload → 早期脚本），运行时变更走 display:scaleFactorChanged。
 */
describe('阴影边距的 zoom 单位换算 (regression)', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'src/renderer/styles/titlebar.css'), 'utf8');
    const html = readFileSync(path.resolve(process.cwd(), 'src/renderer/index.html'), 'utf8');
    const preload = readFileSync(path.resolve(process.cwd(), 'src/renderer/preload.js'), 'utf8');
    const mainSource = readFileSync(path.resolve(process.cwd(), 'src/main/main.ts'), 'utf8');

    test('window-rounded 的阴影边距按 zoom factor 反算，不再写死 20px', () => {
        const block = css.match(/html\.window-rounded\s*\{[^}]*\}/);
        expect(block).toBeTruthy();
        expect(block![0]).toContain('--od-window-zoom: 1;');
        expect(block![0]).toMatch(/--od-window-margin:\s*calc\(20px\s*\/\s*var\(--od-window-zoom\)\);/);
    });

    test('最大化/全屏仍把边距直接折叠为 0（不走 calc）', () => {
        expect(css).toMatch(/--od-window-margin:\s*0\s*;/);
    });

    test('main 用 additionalArguments 把有效 zoom 同步传给 preload', () => {
        expect(mainSource).toMatch(/additionalArguments:\s*\[`--opendesk-zoom=\$\{/);
    });

    test('preload 暴露 initialZoomFactor 供首帧前同步读取', () => {
        expect(preload).toContain('--opendesk-zoom=');
        expect(preload).toContain('initialZoomFactor');
    });

    test('index.html 首帧前写入 --od-window-zoom，并跟随运行时缩放变更', () => {
        expect(html).toContain('window.systemInfo.initialZoomFactor');
        expect(html).toContain("setProperty('--od-window-zoom'");
        expect(html).toContain('onScaleFactorChanged');
    });
});
