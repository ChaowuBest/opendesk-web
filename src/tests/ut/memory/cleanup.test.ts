import { jest } from '@jest/globals';
import { MEMORY_CLEANUP_INTERVAL_MS, startMemoryCleanupScheduler } from '../../../main/aikernel/memory/cleanup';

describe('记忆定时清理', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('启动时立即清理，之后每两小时清理一次，停止后不再运行', async () => {
        jest.useFakeTimers();
        const cleanup = jest.fn<() => Promise<{ removed: number }>>().mockResolvedValue({ removed: 0 });

        const stop = startMemoryCleanupScheduler(cleanup);
        await Promise.resolve();
        expect(cleanup).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(MEMORY_CLEANUP_INTERVAL_MS);
        expect(cleanup).toHaveBeenCalledTimes(2);

        stop();
        await jest.advanceTimersByTimeAsync(MEMORY_CLEANUP_INTERVAL_MS);
        expect(cleanup).toHaveBeenCalledTimes(2);
    });

    test('上一次清理未结束时不会并发启动下一次', async () => {
        jest.useFakeTimers();
        let finishCleanup: (() => void) | undefined;
        const cleanup = jest.fn(
            () =>
                new Promise<{ removed: number }>((resolve) => {
                    finishCleanup = () => resolve({ removed: 0 });
                })
        );

        const stop = startMemoryCleanupScheduler(cleanup);
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(MEMORY_CLEANUP_INTERVAL_MS);
        expect(cleanup).toHaveBeenCalledTimes(1);

        finishCleanup?.();
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(MEMORY_CLEANUP_INTERVAL_MS);
        expect(cleanup).toHaveBeenCalledTimes(2);
        stop();
    });
});
