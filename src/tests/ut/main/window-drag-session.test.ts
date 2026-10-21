/**
 * Linux 主窗口顶部拖拽会话的驱动来源：
 *
 * 鼠标（cursor）由主进程轮询系统光标驱动；触摸屏/手写笔（pointer）不会更新系统
 * 光标位置，必须由 renderer 上报的窗口内坐标驱动——否则会话会把窗口跳到陈旧光标
 * 位置，之后位移恒为 0，表现为"按住顶部拖动无法正确调整窗口位置"。
 * 本文件用假窗口验证两条路径的 bounds 变化。
 *
 * renderer 上报的窗口内坐标是 CSS 像素（受 webContents zoom factor 影响，即
 * gui_config.scale_factor 缩放偏好），bounds 与系统光标是 DIP，会话入口需换算。
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

const getCursorScreenPoint = jest.fn<() => { x: number; y: number }>();

jest.unstable_mockModule('electron', () => ({
    BrowserWindow: class {},
    screen: { getCursorScreenPoint }
}));

const { startWindowDragSession, updateWindowDragSession, endWindowDragSession } =
    await import('../../../main/windows/window-drag.js');

class FakeWindow {
    bounds: Bounds;
    normalBounds: Bounds;
    destroyed = false;
    maximized = false;
    fullScreen = false;
    setBoundsCalls: Bounds[] = [];
    readonly webContents: { getZoomFactor(): number };
    private listeners = new Map<string, Array<() => void>>();

    constructor(bounds: Bounds, zoomFactor = 1) {
        this.bounds = { ...bounds };
        this.normalBounds = { ...bounds };
        this.webContents = { getZoomFactor: () => zoomFactor };
    }

    isDestroyed(): boolean {
        return this.destroyed;
    }
    isMaximized(): boolean {
        return this.maximized;
    }
    isFullScreen(): boolean {
        return this.fullScreen;
    }
    getBounds(): Bounds {
        return { ...this.bounds };
    }
    getNormalBounds(): Bounds {
        return { ...this.normalBounds };
    }
    unmaximize(): void {
        this.maximized = false;
        this.bounds = { ...this.normalBounds };
    }
    setBounds(bounds: Bounds): void {
        this.setBoundsCalls.push({ ...bounds });
        this.bounds = { ...bounds };
    }
    on(event: string, cb: () => void): void {
        const list = this.listeners.get(event) ?? [];
        list.push(cb);
        this.listeners.set(event, list);
    }
    once(event: string, cb: () => void): void {
        this.on(event, cb);
    }
    removeListener(event: string, cb: () => void): void {
        this.listeners.set(
            event,
            (this.listeners.get(event) ?? []).filter((fn) => fn !== cb)
        );
    }
    emit(event: string): void {
        for (const cb of this.listeners.get(event) ?? []) {
            cb();
        }
    }
}

const START: Bounds = { x: 100, y: 80, width: 1200, height: 800 };

beforeEach(() => {
    jest.useFakeTimers();
    getCursorScreenPoint.mockReset();
});

afterEach(() => {
    endWindowDragSession();
    jest.useRealTimers();
});

describe('pointer 驱动（触摸屏/手写笔）', () => {
    it('start 不读系统光标、不预定位，轮询也不会改动窗口', () => {
        // 陈旧光标远在别处：若 pointer 会话仍去读/轮询光标，bounds 必然被污染
        getCursorScreenPoint.mockReturnValue({ x: 5000, y: 5000 });
        const win = new FakeWindow(START);

        startWindowDragSession(win as never, { x: 300, y: 16 }, 'pointer');
        jest.advanceTimersByTime(100);

        expect(getCursorScreenPoint).not.toHaveBeenCalled();
        expect(win.setBoundsCalls).toEqual([]);
        expect(win.bounds).toEqual(START);
    });

    it('update 把按下点贴回指针下，手指停住后不再移动', () => {
        const win = new FakeWindow(START);
        startWindowDragSession(win as never, { x: 300, y: 16 }, 'pointer');

        // 手指在窗口内右移 50 → 窗口右移 50（按下点仍在手指下）
        updateWindowDragSession({ x: 350, y: 16 });
        expect(win.bounds).toEqual({ x: 150, y: 80, width: 1200, height: 800 });

        // 手指停在屏幕 x=450：窗口已移到 150，窗口内坐标回落到 300 → 不再移动
        jest.advanceTimersByTime(16);
        updateWindowDragSession({ x: 300, y: 16 });
        expect(win.bounds).toEqual({ x: 150, y: 80, width: 1200, height: 800 });

        // 继续向右下拖动：位移以会话起点为基准，不逐帧累加
        jest.advanceTimersByTime(16);
        updateWindowDragSession({ x: 320, y: 26 });
        expect(win.bounds).toEqual({ x: 170, y: 90, width: 1200, height: 800 });
    });

    it('同一帧内的多次 update 只应用最后一个坐标（按帧合并）', () => {
        const win = new FakeWindow(START);
        startWindowDragSession(win as never, { x: 300, y: 16 }, 'pointer');

        updateWindowDragSession({ x: 350, y: 16 });
        const first = win.bounds;
        // 同帧内再来两条：只记录，不立即应用
        updateWindowDragSession({ x: 360, y: 16 });
        updateWindowDragSession({ x: 380, y: 16 });
        expect(win.bounds).toEqual(first);

        // 帧边界应用最后一个坐标：窗口已移 50，指针在窗口内位移 80
        // → 屏幕总位移 130
        jest.advanceTimersByTime(16);
        expect(win.bounds).toEqual({ x: 230, y: 80, width: 1200, height: 800 });
    });

    it('最大化窗口：先还原 normal bounds，首个 update 把按下点落到手指下', () => {
        const win = new FakeWindow(START);
        win.maximized = true;
        win.normalBounds = { x: 200, y: 100, width: 1000, height: 700 };

        startWindowDragSession(win as never, { x: 400, y: 16 }, 'pointer');
        jest.advanceTimersByTime(60);
        expect(win.bounds).toEqual({ x: 200, y: 100, width: 1000, height: 700 });

        // 手指停在屏幕 x=800（窗口内 600）→ 还原后的窗口移到按下点正下方
        updateWindowDragSession({ x: 600, y: 16 });
        expect(win.bounds).toEqual({ x: 400, y: 100, width: 1000, height: 700 });
    });

    it('end 之后 update 不再生效', () => {
        const win = new FakeWindow(START);
        startWindowDragSession(win as never, { x: 300, y: 16 }, 'pointer');
        updateWindowDragSession({ x: 350, y: 16 });
        const moved = win.bounds;

        endWindowDragSession();
        updateWindowDragSession({ x: 900, y: 900 });
        jest.advanceTimersByTime(100);

        expect(win.bounds).toEqual(moved);
    });

    it('缺少按下点时退回光标轮询路径', () => {
        getCursorScreenPoint.mockReturnValue({ x: 420, y: 100 });
        const win = new FakeWindow(START);

        startWindowDragSession(win as never, undefined, 'pointer');
        getCursorScreenPoint.mockReturnValue({ x: 460, y: 100 });
        jest.advanceTimersByTime(16);

        expect(getCursorScreenPoint).toHaveBeenCalled();
        expect(win.bounds).toEqual({ x: 140, y: 80, width: 1200, height: 800 });
    });
});

describe('cursor 驱动（鼠标，回归）', () => {
    it('start 按光标预定位，轮询按光标位移整体平移', () => {
        getCursorScreenPoint.mockReturnValue({ x: 420, y: 100 });
        const win = new FakeWindow(START);

        startWindowDragSession(win as never, { x: 300, y: 16 });
        expect(win.setBoundsCalls[0]).toEqual({ x: 120, y: 84, width: 1200, height: 800 });

        getCursorScreenPoint.mockReturnValue({ x: 460, y: 100 });
        jest.advanceTimersByTime(16);
        expect(win.bounds).toEqual({ x: 160, y: 84, width: 1200, height: 800 });
    });

    it('update 对光标会话无效（仍由轮询驱动）', () => {
        getCursorScreenPoint.mockReturnValue({ x: 420, y: 100 });
        const win = new FakeWindow(START);
        startWindowDragSession(win as never, { x: 300, y: 16 });
        const placed = win.bounds;

        updateWindowDragSession({ x: 999, y: 999 });

        expect(win.bounds).toEqual(placed);
    });

    it('blur 结束会话，轮询停止', () => {
        getCursorScreenPoint.mockReturnValue({ x: 420, y: 100 });
        const win = new FakeWindow(START);
        startWindowDragSession(win as never, { x: 300, y: 16 });
        const placed = win.bounds;

        win.emit('blur');
        getCursorScreenPoint.mockReturnValue({ x: 800, y: 300 });
        jest.advanceTimersByTime(100);

        expect(win.bounds).toEqual(placed);
    });
});

/**
 * 缩放偏好（gui_config.scale_factor → webContents.setZoomFactor）下的坐标换算。
 *
 * renderer 的 event.clientX/Y 是 CSS 像素，主进程的 bounds 与
 * screen.getCursorScreenPoint() 是 DIP。按下点不换算时，窗口位置按
 * client*(1-zoom) 偏左（zoom<1），表现为"指针落到顶部拖拽层稍微一动整窗向左跳"，
 * 且按下点越靠右跳得越多；pointer 驱动的位移同样按 zoom 比例失真（不跟手）。
 */
describe('页面 zoom factor ≠ 1（缩放偏好）', () => {
    // 0.5 可被二进制精确表示，断言不受浮点噪声影响
    const ZOOM = 0.5;

    it('cursor：按下点换算后窗口不跳位，轮询位移仍按 DIP 计', () => {
        // 窗口 x=100，按下点 client 300 CSS = 窗口内 150 DIP → 光标在 250
        getCursorScreenPoint.mockReturnValue({ x: 250, y: 88 });
        const win = new FakeWindow(START, ZOOM);

        startWindowDragSession(win as never, { x: 300, y: 16 });
        expect(win.setBoundsCalls[0]).toEqual(START);

        getCursorScreenPoint.mockReturnValue({ x: 270, y: 88 });
        jest.advanceTimersByTime(16);
        expect(win.bounds).toEqual({ x: 120, y: 80, width: 1200, height: 800 });
    });

    it('cursor：最大化还原后按下点落在光标下（不额外跳位）', () => {
        const win = new FakeWindow(START, ZOOM);
        win.maximized = true;
        win.normalBounds = { x: 200, y: 100, width: 1000, height: 700 };
        // 按下点 client 400 CSS = 200 DIP，光标 400 → 还原后的窗口 x 仍是 200
        getCursorScreenPoint.mockReturnValue({ x: 400, y: 108 });

        startWindowDragSession(win as never, { x: 400, y: 16 });
        jest.advanceTimersByTime(60);
        expect(win.bounds).toEqual({ x: 200, y: 100, width: 1000, height: 700 });
    });

    it('pointer：窗口内坐标位移按 zoom 折算成 DIP 位移', () => {
        const win = new FakeWindow(START, ZOOM);
        startWindowDragSession(win as never, { x: 300, y: 16 }, 'pointer');

        // 手指在窗口内右移 50 CSS = 25 DIP → 窗口右移 25（与手指屏幕位移一致）
        updateWindowDragSession({ x: 350, y: 16 });
        expect(win.bounds).toEqual({ x: 125, y: 80, width: 1200, height: 800 });
    });

    it('cursor：真实配置 scale_factor=0.8 时按下点不再把窗口拽向左', () => {
        // 窗口 x=100，按下点 client 500 CSS = 400 DIP → 光标在 500；
        // 未换算时新位置 = 500 - 500 = 0，整窗向左跳 100
        getCursorScreenPoint.mockReturnValue({ x: 500, y: 92.8 });
        const win = new FakeWindow(START, 0.8);

        startWindowDragSession(win as never, { x: 500, y: 16 });

        expect(win.bounds.x).toBeCloseTo(100, 6);
        expect(win.bounds.y).toBeCloseTo(80, 6);
    });
});
