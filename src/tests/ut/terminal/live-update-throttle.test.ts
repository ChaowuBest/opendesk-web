import { describe, expect, test } from '@jest/globals';
import {
    TERMINAL_LIVE_UPDATE_HEAVY_CHARS,
    TERMINAL_LIVE_UPDATE_HEAVY_INTERVAL_MS,
    TERMINAL_LIVE_UPDATE_INTERVAL_MS,
    TERMINAL_LIVE_UPDATE_TRUNCATED_INTERVAL_MS,
    TerminalLiveUpdateThrottle
} from '../../../main/applications/terminal/live-update-throttle.js';

/**
 * 终端 live 输出推送节流。
 *
 * 回归背景：BoundedOutputBuffer 截断（>256KiB）后，输出快照变成
 * head + 截断标记 + tail；tail 每滑动一次就破坏前缀关系，
 * `computeTerminalOutputDelta` 只能返回 reset + 全量文本。
 * 实测 20 秒持续构建日志：100 次 tick 中 83 次 reset，平均每 tick 重传 215KiB。
 * 每 200ms 全量重传 + 渲染进程整体重写输出区会让 GUI 持续卡顿，
 * 因此截断态必须降频。
 */
describe('TerminalLiveUpdateThrottle', () => {
    test('未截断时按原节奏（200ms）放行', () => {
        const throttle = new TerminalLiveUpdateThrottle();
        const start = 1_000_000;
        const pushed: number[] = [];

        for (let i = 0; i < 5; i++) {
            const now = start + i * TERMINAL_LIVE_UPDATE_INTERVAL_MS;
            if (throttle.shouldPush(now, false)) pushed.push(now);
        }

        expect(pushed).toHaveLength(5);
    });

    test('截断后降频到 1s 一次，避免每 tick 全量重传', () => {
        const throttle = new TerminalLiveUpdateThrottle();
        const start = 1_000_000;
        const pushed: number[] = [];

        // 模拟 10 个 200ms tick（2 秒）全部处于截断态
        for (let i = 0; i < 10; i++) {
            const now = start + i * TERMINAL_LIVE_UPDATE_INTERVAL_MS;
            if (throttle.shouldPush(now, true)) pushed.push(now - start);
        }

        expect(pushed).toEqual([0, TERMINAL_LIVE_UPDATE_TRUNCATED_INTERVAL_MS]);
    });

    test('从截断恢复到增量后立即恢复快节奏', () => {
        const throttle = new TerminalLiveUpdateThrottle();
        const start = 1_000_000;

        expect(throttle.shouldPush(start, true)).toBe(true);
        expect(throttle.shouldPush(start + TERMINAL_LIVE_UPDATE_INTERVAL_MS, true)).toBe(false);
        // 未截断（例如命令重跑、缓冲被替换）不应被截断态的节流窗口拖住
        expect(throttle.shouldPush(start + 2 * TERMINAL_LIVE_UPDATE_INTERVAL_MS, false)).toBe(true);
        expect(throttle.shouldPush(start + 3 * TERMINAL_LIVE_UPDATE_INTERVAL_MS, false)).toBe(true);
    });

    test('reset 语义仍保留：节流只影响推送频率，不改变 delta 计算', () => {
        // 该断言用于固定「节流放在推送层而不是 delta 层」的设计边界
        const throttle = new TerminalLiveUpdateThrottle();
        expect(throttle.shouldPush(0, true)).toBe(true);
        // 900ms 时仍在 1s 窗口内（含 16ms 定时器抖动容差）
        expect(throttle.shouldPush(900, true)).toBe(false);
        expect(throttle.shouldPush(1000, true)).toBe(true);
    });

    test('大快照（≥64KiB）降频：每 tick 全量渲染与 IPC 的开销与快照长度成正比', () => {
        const throttle = new TerminalLiveUpdateThrottle();
        const start = 1_000_000;
        const pushed: number[] = [];

        for (let i = 0; i < 10; i++) {
            const now = start + i * TERMINAL_LIVE_UPDATE_INTERVAL_MS;
            if (throttle.shouldPush(now, false, TERMINAL_LIVE_UPDATE_HEAVY_CHARS)) pushed.push(now - start);
        }

        // 阈值是 200ms tick 的整数倍，落点可预测：每 2 个 tick 放行一次
        const step = TERMINAL_LIVE_UPDATE_HEAVY_INTERVAL_MS;
        expect(pushed).toEqual([0, step, 2 * step, 3 * step, 4 * step]);
    });

    test('小快照不受大快照门槛影响（门槛下方仍按 5Hz）', () => {
        const throttle = new TerminalLiveUpdateThrottle();
        const start = 1_000_000;

        expect(throttle.shouldPush(start, false, TERMINAL_LIVE_UPDATE_HEAVY_CHARS - 1)).toBe(true);
        expect(throttle.shouldPush(start + TERMINAL_LIVE_UPDATE_INTERVAL_MS, false, 0)).toBe(true);
    });

    test('截断优先于大快照：截断态一律按 1s 放行', () => {
        const throttle = new TerminalLiveUpdateThrottle();
        const start = 1_000_000;

        expect(throttle.shouldPush(start, true, TERMINAL_LIVE_UPDATE_HEAVY_CHARS * 4)).toBe(true);
        expect(
            throttle.shouldPush(
                start + TERMINAL_LIVE_UPDATE_HEAVY_INTERVAL_MS,
                true,
                TERMINAL_LIVE_UPDATE_HEAVY_CHARS * 4
            )
        ).toBe(false);
        expect(
            throttle.shouldPush(
                start + TERMINAL_LIVE_UPDATE_TRUNCATED_INTERVAL_MS,
                true,
                TERMINAL_LIVE_UPDATE_HEAVY_CHARS * 4
            )
        ).toBe(true);
    });
});
