/**
 * Linux 主窗口内容边缘 resize 会话的驱动来源：
 *
 * 鼠标（cursor）由主进程轮询系统光标驱动；触摸屏/手写笔（pointer）不会更新系统
 * 光标位置，轮询取到的位移恒为 0，表现为"无法通过触摸调整窗口大小"。pointer
 * 会话改由 renderer 上报的窗口内坐标驱动，本文件用假窗口验证两条路径。
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

const { startShadowResizeSession, updateShadowResizeSession, endShadowResizeSession } =
    await import('../../../main/windows/shadow-resize.js');

class FakeWindow {
    bounds: Bounds;
    destroyed = false;
    maximized = false;
    fullScreen = false;
    setBoundsCalls: Bounds[] = [];
    private listeners = new Map<string, Array<() => void>>();

    constructor(bounds: Bounds) {
        this.bounds = { ...bounds };
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
}

const START: Bounds = { x: 100, y: 80, width: 1200, height: 800 };
const MIN_W = 890;
const MIN_H = 440;

beforeEach(() => {
    jest.useFakeTimers();
    getCursorScreenPoint.mockReset();
});

afterEach(() => {
    endShadowResizeSession();
    jest.useRealTimers();
});

describe('pointer 驱动（触摸屏/手写笔）', () => {
    it('start 不读系统光标、不改动窗口，轮询也不会改动窗口', () => {
        getCursorScreenPoint.mockReturnValue({ x: 5000, y: 5000 });
        const win = new FakeWindow(START);

        startShadowResizeSession(win as never, 'e', MIN_W, MIN_H, 'pointer', { x: 1200, y: 400 });
        jest.advanceTimersByTime(100);

        expect(getCursorScreenPoint).not.toHaveBeenCalled();
        expect(win.setBoundsCalls).toEqual([]);
        expect(win.bounds).toEqual(START);
    });

    it('east：按 client 位移加宽，手指停住后不继续增长', () => {
        const win = new FakeWindow(START);
        startShadowResizeSession(win as never, 'e', MIN_W, MIN_H, 'pointer', { x: 1200, y: 400 });

        updateShadowResizeSession({ x: 1240, y: 400 });
        expect(win.bounds).toEqual({ x: 100, y: 80, width: 1240, height: 800 });

        // east 不移动 origin，手指停住时 client 不变 → 位移仍为 40
        jest.advanceTimersByTime(16);
        updateShadowResizeSession({ x: 1240, y: 400 });
        expect(win.bounds).toEqual({ x: 100, y: 80, width: 1240, height: 800 });
    });

    it('west：窗口左移使 client 回落，位移稳定不翻倍', () => {
        const win = new FakeWindow(START);
        startShadowResizeSession(win as never, 'w', MIN_W, MIN_H, 'pointer', { x: 0, y: 400 });

        updateShadowResizeSession({ x: -60, y: 400 });
        expect(win.bounds).toEqual({ x: 40, y: 80, width: 1260, height: 800 });

        // 窗口已左移到 x=40，手指停在屏幕 x=40 → 窗口内坐标回到 0
        jest.advanceTimersByTime(16);
        updateShadowResizeSession({ x: 0, y: 400 });
        expect(win.bounds).toEqual({ x: 40, y: 80, width: 1260, height: 800 });
    });

    it('同一帧内的多次 update 只应用最后一个坐标（按帧合并）', () => {
        const win = new FakeWindow(START);
        startShadowResizeSession(win as never, 'e', MIN_W, MIN_H, 'pointer', { x: 1200, y: 400 });

        updateShadowResizeSession({ x: 1240, y: 400 });
        const first = win.bounds;
        updateShadowResizeSession({ x: 1300, y: 400 });
        expect(win.bounds).toEqual(first);

        jest.advanceTimersByTime(16);
        expect(win.bounds).toEqual({ x: 100, y: 80, width: 1300, height: 800 });
    });

    it('收缩超过最小尺寸时钳制', () => {
        const win = new FakeWindow(START);
        startShadowResizeSession(win as never, 'w', MIN_W, MIN_H, 'pointer', { x: 0, y: 400 });

        updateShadowResizeSession({ x: 600, y: 400 });

        expect(win.bounds).toEqual({ x: 410, y: 80, width: MIN_W, height: 800 });
    });

    it('end 之后 update 不再生效', () => {
        const win = new FakeWindow(START);
        startShadowResizeSession(win as never, 'e', MIN_W, MIN_H, 'pointer', { x: 1200, y: 400 });
        updateShadowResizeSession({ x: 1240, y: 400 });
        const resized = win.bounds;

        endShadowResizeSession();
        updateShadowResizeSession({ x: 2000, y: 400 });
        jest.advanceTimersByTime(100);

        expect(win.bounds).toEqual(resized);
    });

    it('最大化窗口不启动会话', () => {
        const win = new FakeWindow(START);
        win.maximized = true;

        startShadowResizeSession(win as never, 'e', MIN_W, MIN_H, 'pointer', { x: 1200, y: 400 });
        updateShadowResizeSession({ x: 1400, y: 400 });

        expect(win.bounds).toEqual(START);
    });
});

describe('cursor 驱动（鼠标，回归）', () => {
    it('轮询按光标位移 resize', () => {
        getCursorScreenPoint.mockReturnValue({ x: 1300, y: 480 });
        const win = new FakeWindow(START);

        startShadowResizeSession(win as never, 'e', MIN_W, MIN_H);
        getCursorScreenPoint.mockReturnValue({ x: 1340, y: 480 });
        jest.advanceTimersByTime(16);

        expect(win.bounds).toEqual({ x: 100, y: 80, width: 1240, height: 800 });
    });

    it('update 对光标会话无效（仍由轮询驱动）', () => {
        getCursorScreenPoint.mockReturnValue({ x: 1300, y: 480 });
        const win = new FakeWindow(START);
        startShadowResizeSession(win as never, 'e', MIN_W, MIN_H);

        updateShadowResizeSession({ x: 999, y: 400 });
        jest.advanceTimersByTime(16);

        expect(win.bounds).toEqual(START);
    });
});
