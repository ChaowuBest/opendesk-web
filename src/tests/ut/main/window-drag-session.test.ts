/**
 * Linux 主窗口顶部拖拽会话的驱动来源：
 *
 * 鼠标（cursor）由主进程轮询系统光标驱动；触摸屏/手写笔（pointer）不会更新系统
 * 光标位置，必须由 renderer 上报的窗口内坐标驱动——否则会话会把窗口跳到陈旧光标
 * 位置，之后位移恒为 0，表现为"按住顶部拖动无法正确调整窗口位置"。
 * 本文件用假窗口验证两条路径的 bounds 变化。
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
    private listeners = new Map<string, Array<() => void>>();

    constructor(bounds: Bounds) {
        this.bounds = { ...bounds };
        this.normalBounds = { ...bounds };
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
