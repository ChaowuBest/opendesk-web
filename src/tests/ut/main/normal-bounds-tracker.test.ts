import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { attachNormalBoundsTracker } from '../../../main/utils/normal-bounds-tracker.js';

/**
 * bug 复现（Linux 假最大化）：
 * Linux 主窗口是 frameless + transparent，最大化后 Chromium 的 restored bounds
 * 缓存缺失/被污染，getNormalBounds() 可能直接返回最大化尺寸。退出时把这份坏值
 * 当 normal bounds 持久化，下次启动用 setBounds 还原 → 窗口看似最大化但
 * isMaximized() === false（假最大化），双击标题栏要来回切多次才恢复正常。
 *
 * NormalBoundsTracker 通过监听 resize/moved 等事件自行缓存非最大化状态下的
 * bounds，退出保存时用它替代 getNormalBounds()，保证持久化的是真实 normal bounds。
 */

interface TestWindow {
    on(event: string, cb: () => void): void;
    removeListener(event: string, cb: () => void): void;
    isDestroyed(): boolean;
    isMaximized(): boolean;
    isFullScreen(): boolean;
    isMinimized(): boolean;
    getBounds(): { x: number; y: number; width: number; height: number };
    getNormalBounds(): { x: number; y: number; width: number; height: number };
}

const NORMAL = { x: 100, y: 80, width: 1200, height: 800 };
const MAXIMIZED = { x: 0, y: 0, width: 1920, height: 1040 };

function makeWindow(): TestWindow & {
    __emit(event: string): void;
    __applyBounds(b: { x: number; y: number; width: number; height: number }): void;
    __setMaximized(v: boolean): void;
    __setMinimized(v: boolean): void;
    /** 模拟 Electron 侧 getNormalBounds 的坏值来源（独立于实际 bounds） */
    __setNormalBoundsReply(b: { x: number; y: number; width: number; height: number }): void;
} {
    const listeners = new Map<string, Set<() => void>>();
    let bounds = { ...NORMAL };
    let maximized = false;
    let minimized = false;
    let normalBoundsReply = { ...NORMAL };
    return {
        on(event, cb) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(cb);
        },
        removeListener(event, cb) {
            listeners.get(event)?.delete(cb);
        },
        isDestroyed: () => false,
        isMaximized: () => maximized,
        isFullScreen: () => false,
        isMinimized: () => minimized,
        getBounds: () => ({ ...bounds }),
        getNormalBounds: () => ({ ...normalBoundsReply }),
        __emit(event) {
            listeners.get(event)?.forEach((cb) => cb());
        },
        __applyBounds(b) {
            bounds = { ...b };
        },
        __setMaximized(v) {
            maximized = v;
        },
        __setMinimized(v) {
            minimized = v;
        },
        __setNormalBoundsReply(b) {
            normalBoundsReply = { ...b };
        }
    };
}

describe('attachNormalBoundsTracker', () => {
    let trackerStop: (() => void) | null = null;

    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        trackerStop?.();
        trackerStop = null;
        jest.useRealTimers();
    });

    function attach(win: ReturnType<typeof makeWindow>) {
        const tracker = attachNormalBoundsTracker(win, { settleMs: 60 });
        trackerStop = tracker.stop;
        return tracker;
    }

    test('非最大化状态下的 resize/move 持续刷新缓存', () => {
        const win = makeWindow();
        const tracker = attach(win);

        win.__applyBounds({ x: 200, y: 100, width: 900, height: 600 });
        win.__emit('resize');
        expect(tracker.getNormalBounds()).toEqual({ x: 200, y: 100, width: 900, height: 600 });

        win.__applyBounds({ x: 300, y: 100, width: 900, height: 600 });
        win.__emit('move');
        expect(tracker.getNormalBounds()).toEqual({ x: 300, y: 100, width: 900, height: 600 });
    });

    test('最大化期间的 resize 不污染缓存（X11 时序：状态先翻转、bounds 后刷新）', () => {
        const win = makeWindow();
        const tracker = attach(win);

        // 模拟 maximize：状态先变 true，随后 bounds 变为最大化尺寸并触发 resize
        win.__setMaximized(true);
        win.__applyBounds(MAXIMIZED);
        win.__emit('resize');

        // 缓存仍是最大化前的 normal bounds
        expect(tracker.getNormalBounds()).toEqual(NORMAL);
    });

    test('unmaximize 后 settle 窗口内的 resize（bounds 未刷新）不污染缓存，settle 后重新采样', () => {
        const win = makeWindow();
        const tracker = attach(win);

        // 模拟 unmaximize：状态先变 false，此时 bounds 仍是最大化尺寸
        win.__setMaximized(true);
        win.__applyBounds(MAXIMIZED);
        win.__setMaximized(false);
        // WM 恢复完成前触发的 resize：bounds 还是最大化尺寸，绝不能写进缓存
        win.__emit('unmaximize');
        win.__emit('resize');
        expect(tracker.getNormalBounds()).toEqual(NORMAL);

        // settle（60ms）后 WM 已把 bounds 刷新为 normal，settle 回调重新采样
        const restored = { x: 120, y: 90, width: 1100, height: 760 };
        win.__applyBounds(restored);
        jest.advanceTimersByTime(60);
        expect(tracker.getNormalBounds()).toEqual(restored);
    });

    test('最大化状态下直接退出：返回缓存的 normal bounds 而非坏掉的 getNormalBounds()', () => {
        const win = makeWindow();
        const tracker = attach(win);

        win.__setMaximized(true);
        win.__applyBounds(MAXIMIZED);
        win.__emit('resize');
        // 模拟 Linux 透明窗口 getNormalBounds 返回最大化尺寸的坏值
        win.__setNormalBoundsReply(MAXIMIZED);

        expect(tracker.getNormalBounds()).toEqual(NORMAL);
    });

    test('挂载时已处于最大化（无历史采样）：回退 getNormalBounds()', () => {
        const win = makeWindow();
        win.__setMaximized(true);
        win.__setNormalBoundsReply(NORMAL);
        const tracker = attach(win);

        expect(tracker.getNormalBounds()).toEqual(NORMAL);
    });

    test('最小化期间的 resize 不写入缓存（Windows 最小化坐标为 -32000 幽灵值）', () => {
        const win = makeWindow();
        const tracker = attach(win);

        win.__setMinimized(true);
        win.__applyBounds({ x: -32000, y: -32000, width: 1200, height: 800 });
        win.__emit('resize');

        expect(tracker.getNormalBounds()).toEqual(NORMAL);
    });

    test('stop 后移除全部监听，不再跟踪', () => {
        const win = makeWindow();
        const tracker = attach(win);
        tracker.stop();
        trackerStop = null;

        win.__applyBounds({ x: 0, y: 0, width: 500, height: 400 });
        win.__emit('resize');

        // 已停止跟踪：仍返回 attach 时刻的初始 bounds
        expect(tracker.getNormalBounds()).toEqual(NORMAL);
    });
});
