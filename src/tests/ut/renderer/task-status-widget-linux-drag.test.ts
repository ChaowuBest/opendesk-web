import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

// 胶囊悬浮窗整体是 -webkit-app-region: drag 区域。在 Linux（X11）上，窗口管理器在该区域
// 被按下时会进入交互式移动循环，循环期间任何位置变更都会被复位到「按下时的抓取点」，
// 展开卡片因此停在胶囊左上角并向外伸出屏幕，只能等循环结束后再纠正（会露出错位帧）。
// 展开本身由窗口 focus 触发、不依赖 drag，因此 Linux 上把胶囊排除在窗口拖拽区之外即可
// 根治：展开一次落位，不再有中间错位帧。
// 回归：Linux 判定与 no-drag 规则必须成对存在，缺任一侧都会让问题复现。

const widgetSource = readFileSync(
    new URL('../../../renderer/components/task-status-widget.js', import.meta.url),
    'utf8'
);
const preloadSource = readFileSync(new URL('../../../renderer/preload.js', import.meta.url), 'utf8');
const windowSource = readFileSync(
    new URL('../../../main/windows/task-status-widget-window.ts', import.meta.url),
    'utf8'
);

describe('task status widget linux pill drag region', () => {
    test('preload 向浮窗暴露 platform，供渲染层区分平台', () => {
        const api = preloadSource.slice(preloadSource.indexOf("safeExposeInMainWorld('taskStatusWidgetAPI'"));
        expect(api).toContain('platform: process.platform');
    });

    test('Linux 上给宿主元素加 os-linux 标记', () => {
        expect(widgetSource).toContain("window.taskStatusWidgetAPI?.platform === 'linux'");
        expect(widgetSource).toContain("this.classList.add('os-linux')");
    });

    test('os-linux 下胶囊与两个标题栏都不再是窗口拖拽区', () => {
        const rule = widgetSource.slice(widgetSource.indexOf(':host(.os-linux) .collapsed-view'));
        const block = rule.slice(0, rule.indexOf('{'));
        expect(block).toContain('.lst-head');
        expect(block).toContain('.dt-head');
        expect(rule).toContain('-webkit-app-region: no-drag;');
        // 缺 touch-action 时浏览器会把触摸拖动判成滑动手势并派发 pointercancel，拖一点就断
        expect(rule).toContain('touch-action: none;');
    });

    test('非 Linux 平台胶囊仍保持可拖拽', () => {
        const base = widgetSource.slice(widgetSource.indexOf('.collapsed-view {'));
        expect(base.slice(0, base.indexOf('}'))).toContain('-webkit-app-region: drag;');
    });
});

describe('task status widget manual drag', () => {
    test('preload 暴露拖拽三段式 API，并带上按下点与驱动来源', () => {
        const api = preloadSource.slice(preloadSource.indexOf("safeExposeInMainWorld('taskStatusWidgetAPI'"));
        expect(api).toContain("ipcRenderer.send('taskStatusWidget:dragStart', { x: grabX, y: grabY }, driver)");
        expect(api).toContain("ipcRenderer.send('taskStatusWidget:dragMove', { x, y })");
        expect(api).toContain("ipcRenderer.send('taskStatusWidget:dragEnd')");
    });

    test('主进程复用主窗口的 window-drag 会话，而不是另写一套位移换算', () => {
        expect(windowSource).toContain("from './window-drag.js'");
        const drag = windowSource.slice(windowSource.indexOf('function beginManualDrag'));
        const body = drag.slice(0, drag.indexOf('function positionWidget'));
        expect(body).toContain('startWindowDragSession(widgetWindow, grabPoint, dragDriver)');
        expect(body).toContain('updateWindowDragSession({ x: p.x, y: p.y })');
        expect(body).toContain('endWindowDragSession()');
        // 拖拽是用户主动移动，此前的程序化落点判定必须作废，否则兜底重设会抢位置。
        expect(body).toContain('lastProgrammaticBounds = null');
        // Linux 上 moved 不触发，拖拽后的位置只能在这里记入会话位置。
        expect(body).toContain('sessionPosition = { x: bounds.x, y: bounds.y };');
    });

    test('非 Linux 平台不注册浮窗拖拽 IPC，与主窗口 registerWindowDragHandlers 对齐', () => {
        const first = windowSource.indexOf("ipcMain.on('taskStatusWidget:dragStart'");
        const last = windowSource.indexOf("ipcMain.on('taskStatusWidget:dragEnd'");
        expect(first).toBeGreaterThan(-1);
        // gate 必须真的包住注册块（紧贴在三段式注册之前），而不是只写在注释里。
        expect(windowSource.slice(first - 120, first)).toContain("if (process.platform === 'linux') {");
        expect(windowSource.slice(first, last)).toContain("ipcMain.on('taskStatusWidget:dragMove'");
    });

    test('驱动来源按 pointerType 分流，触摸上报窗口内坐标并按帧合并', () => {
        // 触摸屏不更新系统光标、X11 下 screenX 也不可靠，只能上报 clientX/Y
        expect(widgetSource).toContain("driver: event.pointerType === 'mouse' ? 'cursor' : 'pointer'");
        expect(widgetSource).toContain('pendingPoint = { x: event.clientX, y: event.clientY };');
        expect(widgetSource).toContain('rafId = requestAnimationFrame(flushPoint)');
        expect(widgetSource).toContain('el.setPointerCapture(event.pointerId)');
        expect(widgetSource).toContain("el.addEventListener('pointercancel'");
    });

    test('胶囊与两个标题栏都挂上手动拖拽', () => {
        expect(widgetSource).toContain('attachManualDrag(view, () => this._expand())');
        expect(widgetSource).toContain('attachManualDrag(head)');
        expect(widgetSource).toContain('attachManualDrag(this._detailHead)');
    });

    test('Linux 上展开改由点击驱动，窗口 focus 不再自动展开', () => {
        const focus = widgetSource.slice(widgetSource.indexOf('_onWindowFocus = () => {'));
        expect(focus.slice(0, focus.indexOf('};'))).toContain('if (this._linuxDrag)');
    });
});
