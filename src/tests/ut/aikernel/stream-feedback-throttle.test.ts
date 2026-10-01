import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { StreamFeedbackThrottle } from '../../../main/aikernel/task/stream-feedback-throttle';

describe('StreamFeedbackThrottle', () => {
    test('放行同一 key 的首次快照', () => {
        const now = 1000;
        const throttle = new StreamFeedbackThrottle(250, 64 * 1024, () => now);
        expect(throttle.shouldSend('msg:0', 10)).toBe(true);
    });

    test('最小间隔内的后续快照被拦截，间隔届满后放行', () => {
        let now = 1000;
        const throttle = new StreamFeedbackThrottle(250, 64 * 1024, () => now);
        expect(throttle.shouldSend('msg:0', 100)).toBe(true);
        now = 1100;
        expect(throttle.shouldSend('msg:0', 200)).toBe(false);
        now = 1200;
        expect(throttle.shouldSend('msg:0', 300)).toBe(false);
        now = 1251;
        expect(throttle.shouldSend('msg:0', 400)).toBe(true);
    });

    test('文本增量超过阈值时立即放行（长输出保持进度可见）', () => {
        let now = 1000;
        const throttle = new StreamFeedbackThrottle(250, 64 * 1024, () => now);
        expect(throttle.shouldSend('msg:0', 0)).toBe(true);
        now = 1100;
        expect(throttle.shouldSend('msg:0', 64 * 1024 - 1)).toBe(false);
        now = 1150;
        expect(throttle.shouldSend('msg:0', 64 * 1024)).toBe(true);
    });

    test('不同 key 互不影响限频', () => {
        let now = 1000;
        const throttle = new StreamFeedbackThrottle(250, 64 * 1024, () => now);
        expect(throttle.shouldSend('msg:0', 10)).toBe(true);
        expect(throttle.shouldSend('msg:1', 10)).toBe(true);
        now = 1100;
        expect(throttle.shouldSend('msg:0', 20)).toBe(false);
        expect(throttle.shouldSend('msg:1', 20)).toBe(false);
        expect(throttle.shouldSend('msg:2', 20)).toBe(true);
    });

    test('被拦截的快照不推进基准，放行时携带全量长度补齐进度', () => {
        let now = 1000;
        const throttle = new StreamFeedbackThrottle(250, 64 * 1024, () => now);
        expect(throttle.shouldSend('msg:0', 100)).toBe(true);
        now = 1200;
        expect(throttle.shouldSend('msg:0', 200)).toBe(false);
        now = 1251;
        // 放行时的 textLength 是当前全量长度，而非被拦截快照的长度
        expect(throttle.shouldSend('msg:0', 500)).toBe(true);
    });

    test('条目数超过上限时裁剪最久未发送的 key，避免无限增长', () => {
        let now = 1000;
        const throttle = new StreamFeedbackThrottle(250, 64 * 1024, () => now);
        for (let i = 0; i < 600; i++) {
            throttle.shouldSend(`msg:${i}:0`, 1);
            now += 1;
        }
        // 触发裁剪后再访问最早淘汰的 key：应重新放行（而非保留旧记录）
        expect(throttle.shouldSend('msg:0:0', 1)).toBe(true);
    });

    describe('默认参数契约', () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        test('默认最小间隔为 120ms（与渲染侧 ~20Hz 缓冲节奏接近，流式推进无可感步进）', () => {
            jest.useFakeTimers();
            jest.setSystemTime(1000);
            const throttle = new StreamFeedbackThrottle();
            expect(throttle.shouldSend('msg:0', 10)).toBe(true);
            jest.setSystemTime(1119);
            expect(throttle.shouldSend('msg:0', 20)).toBe(false);
            jest.setSystemTime(1120);
            expect(throttle.shouldSend('msg:0', 30)).toBe(true);
        });

        test('默认 64KB 增量强制放行（大文本保持进度可见）', () => {
            jest.useFakeTimers();
            jest.setSystemTime(1000);
            const throttle = new StreamFeedbackThrottle();
            expect(throttle.shouldSend('msg:0', 0)).toBe(true);
            jest.setSystemTime(1050);
            expect(throttle.shouldSend('msg:0', 64 * 1024 - 1)).toBe(false);
            jest.setSystemTime(1100);
            expect(throttle.shouldSend('msg:0', 64 * 1024)).toBe(true);
        });
    });
});
