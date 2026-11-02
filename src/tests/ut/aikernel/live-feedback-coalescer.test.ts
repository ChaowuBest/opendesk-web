import { describe, expect, test } from '@jest/globals';
import { LiveFeedbackCoalescer } from '../../../main/aikernel/task/live-feedback-coalescer.js';

/**
 * 终端 live 输出推送的背压合并器。
 *
 * 回归背景：终端 tick 每 200ms 触发一次 `ToolResult.updateResult`，其回调链是
 * fire-and-forget（ToolResult.safeInvokeCallback 不 await），于是
 * `await sendSubscriptionFeedback()` 会并发堆积：单次 tick 超过 200ms
 * （超长输出下的渲染 + IPC）时，排队任务只会越来越多，界面越来越卡直到「卡死」。
 *
 * 合并语义：同一时刻最多一个推送在跑；期间到来的更新只保留「最新一次」，
 * 当前推送结束后补发一次，保证最终状态一定送达且不丢最后一次更新。
 */
describe('LiveFeedbackCoalescer', () => {
    test('并发 push 不会并发执行，且最后一次更新仍会送达', async () => {
        let running = 0;
        let maxRunning = 0;
        const snapshots: number[] = [];
        let version = 0;
        const releases: Array<() => void> = [];

        const coalescer = new LiveFeedbackCoalescer(async () => {
            running++;
            maxRunning = Math.max(maxRunning, running);
            const captured = version;
            await new Promise<void>((resolve) => {
                releases.push(resolve);
            });
            snapshots.push(captured);
            running--;
        });

        version = 1;
        coalescer.push();
        version = 2;
        coalescer.push();
        version = 3;
        coalescer.push();

        // 第一次推送尚未完成时，后续 push 只登记「待补发」而不并发执行
        expect(maxRunning).toBe(1);
        expect(releases).toHaveLength(1);
        expect(snapshots).toHaveLength(0);

        releases.shift()!();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        // 补发一次，携带最新值
        expect(releases).toHaveLength(1);
        releases.shift()!();
        await coalescer.idle();

        expect(maxRunning).toBe(1);
        expect(snapshots).toEqual([1, 3]);
    });

    test('空闲时每次 push 都各自执行', async () => {
        let calls = 0;
        const coalescer = new LiveFeedbackCoalescer(async () => {
            calls++;
        });

        coalescer.push();
        await coalescer.idle();
        coalescer.push();
        await coalescer.idle();

        expect(calls).toBe(2);
    });

    test('推送抛错不会打断后续推送', async () => {
        const errors: unknown[] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => errors.push(args[0]);
        let calls = 0;
        const coalescer = new LiveFeedbackCoalescer(async () => {
            calls++;
            if (calls === 1) throw new Error('render exploded');
        });

        try {
            coalescer.push();
            await coalescer.idle();
            coalescer.push();
            await coalescer.idle();
        } finally {
            console.warn = originalWarn;
        }

        expect(calls).toBe(2);
        expect(errors.length).toBeGreaterThan(0);
    });
});
