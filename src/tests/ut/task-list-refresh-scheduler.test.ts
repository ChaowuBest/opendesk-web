import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';
import {
    TaskListRefreshScheduler,
    RAF_FALLBACK_TIMEOUT_MS,
    FALLBACK_WARN_LOG_INTERVAL_MS
} from '../../renderer/components/taskListRefreshScheduler.js';

type RafCallback = (time: number) => void;

describe('TaskListRefreshScheduler', () => {
    let refresh: ReturnType<typeof jest.fn>;
    let log: ReturnType<typeof jest.fn>;
    let isWindowVisible: ReturnType<typeof jest.fn>;
    let rafCallbacks: Map<number, RafCallback>;
    let nextRafId: number;

    const scheduleWith = () => new TaskListRefreshScheduler({ refresh, log, isWindowVisible });

    // 模拟浏览器执行一帧：执行并清空当前所有 RAF 回调（已被 cancel 的不会执行）
    const runRafFrame = () => {
        const pending = [...rafCallbacks.entries()];
        rafCallbacks.clear();
        for (const [, cb] of pending) {
            cb(0);
        }
    };

    beforeEach(() => {
        jest.useFakeTimers();
        refresh = jest.fn();
        log = jest.fn();
        isWindowVisible = jest.fn(() => true);
        rafCallbacks = new Map();
        nextRafId = 1;
        (globalThis as any).requestAnimationFrame = jest.fn((cb: RafCallback) => {
            const id = nextRafId++;
            rafCallbacks.set(id, cb);
            return id;
        });
        (globalThis as any).cancelAnimationFrame = jest.fn((id: number) => {
            rafCallbacks.delete(id);
        });
    });

    afterEach(() => {
        jest.useRealTimers();
        delete (globalThis as any).requestAnimationFrame;
        delete (globalThis as any).cancelAnimationFrame;
    });

    test('refreshes via RAF and releases the scheduling slot afterwards', () => {
        const scheduler = scheduleWith();

        scheduler.schedule();
        expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
        expect(refresh).not.toHaveBeenCalled();

        runRafFrame();
        expect(refresh).toHaveBeenCalledTimes(1);

        // RAF 执行后占用解除，后续更新能再次调度
        scheduler.schedule();
        expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    });

    test('coalesces updates while RAF pending and logs the count on flush', () => {
        const scheduler = scheduleWith();

        scheduler.schedule();
        scheduler.schedule();
        scheduler.schedule();

        runRafFrame();
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('debug', expect.stringContaining('2 update(s) coalesced while RAF pending'));
    });

    test('forces refresh via setTimeout fallback when RAF callback is dropped', () => {
        const scheduler = scheduleWith();

        // 复现原 bug 场景：RAF 回调被丢弃（页面节流/冻结），不执行 runRafFrame
        scheduler.schedule();
        jest.advanceTimersByTime(RAF_FALLBACK_TIMEOUT_MS);

        expect(refresh).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('RAF callback did not fire within 400ms'));

        // 关键回归点：兜底解除了调度占用，此后更新恢复正常刷新（原 bug 下会被永久跳过）
        scheduler.schedule();
        expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
        runRafFrame();
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    test('fallback flushes and clears coalesced count so it is not logged twice', () => {
        const scheduler = scheduleWith();

        scheduler.schedule();
        scheduler.schedule();

        jest.advanceTimersByTime(RAF_FALLBACK_TIMEOUT_MS);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('debug', expect.stringContaining('1 update(s) coalesced while RAF pending'));

        // 兜底已消费计数，下一次 RAF 正常刷新时不得重复打印
        scheduler.schedule();
        runRafFrame();
        const coalescedLogs = log.mock.calls.filter((args) => String(args[1]).includes('coalesced while RAF pending'));
        expect(coalescedLogs).toHaveLength(1);
    });

    test('fallback does not render while window is hidden, marks pending refresh instead', () => {
        const scheduler = scheduleWith();

        scheduler.schedule();
        isWindowVisible.mockReturnValue(false);
        jest.advanceTimersByTime(RAF_FALLBACK_TIMEOUT_MS);

        // 省电设计：窗口隐藏时不渲染
        expect(refresh).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalledWith('warn', expect.anything());
        // 数据已变更，标记待刷新供窗口恢复时消费
        expect(scheduler.consumePendingRefreshWhileHidden()).toBe(true);
        expect(scheduler.consumePendingRefreshWhileHidden()).toBe(false);
    });

    test('skips scheduling while window is hidden and marks pending refresh', () => {
        const scheduler = scheduleWith();
        isWindowVisible.mockReturnValue(false);

        scheduler.schedule();

        expect(requestAnimationFrame).not.toHaveBeenCalled();
        expect(scheduler.consumePendingRefreshWhileHidden()).toBe(true);
    });

    test('canceled RAF callback does not cause a second refresh after fallback', () => {
        const scheduler = scheduleWith();

        scheduler.schedule();
        jest.advanceTimersByTime(RAF_FALLBACK_TIMEOUT_MS);
        // 兜底已 cancel RAF，即使浏览器再跑一帧也不应重复刷新
        runRafFrame();

        expect(refresh).toHaveBeenCalledTimes(1);
        expect(cancelAnimationFrame).toHaveBeenCalledWith(expect.any(Number));
    });

    test('clears the fallback timer once RAF fires, so reused RAF ids cannot trigger a stale fallback', () => {
        const scheduler = scheduleWith();

        scheduler.schedule();
        expect(jest.getTimerCount()).toBe(1);

        // RAF 正常触发后兜底定时器必须被清理（否则遗留 no-op 定时器）
        runRafFrame();
        expect(jest.getTimerCount()).toBe(0);

        // 浏览器复用数值 RAF id：新一轮调度拿到与上一轮相同的 id
        nextRafId = 1;
        scheduler.schedule();
        expect(jest.getTimerCount()).toBe(1);

        // 旧实现的兜底会凭 id 相等误判归属并强制刷新；修复后只有本轮
        // 自己的兜底定时器存活并在超时后触发一次刷新
        jest.advanceTimersByTime(RAF_FALLBACK_TIMEOUT_MS);
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    test('markPendingRefreshWhileHidden is consumed exactly once', () => {
        const scheduler = scheduleWith();

        scheduler.markPendingRefreshWhileHidden();
        expect(scheduler.consumePendingRefreshWhileHidden()).toBe(true);
        expect(scheduler.consumePendingRefreshWhileHidden()).toBe(false);
    });

    test('throttles repeated fallback warn logs but keeps forcing refresh', () => {
        const scheduler = scheduleWith();

        // 第一次兜底：记录 warn
        scheduler.schedule();
        jest.advanceTimersByTime(RAF_FALLBACK_TIMEOUT_MS);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('warn', expect.anything());

        // 节流窗口内再次兜底：仍强制刷新，但不重复记 warn
        scheduler.schedule();
        jest.advanceTimersByTime(RAF_FALLBACK_TIMEOUT_MS);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(log.mock.calls.filter((args) => args[0] === 'warn')).toHaveLength(1);

        // 超过节流窗口后恢复记录
        jest.advanceTimersByTime(FALLBACK_WARN_LOG_INTERVAL_MS);
        scheduler.schedule();
        jest.advanceTimersByTime(RAF_FALLBACK_TIMEOUT_MS);
        expect(refresh).toHaveBeenCalledTimes(3);
        expect(log.mock.calls.filter((args) => args[0] === 'warn')).toHaveLength(2);
    });
});
