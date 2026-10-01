import { shouldReleaseTaskView, TASK_VIEW_BACKGROUND_RELEASE_MS } from '../../../renderer/utils/task-view-release';

const FIVE_MINUTES = TASK_VIEW_BACKGROUND_RELEASE_MS;

describe('shouldReleaseTaskView', () => {
    test('不可见超过 5 分钟且任务非运行态 → 释放', () => {
        const hiddenAt = 1_000_000;
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: false }, hiddenAt + FIVE_MINUTES)).toBe(
            true
        );
    });

    test('不可见但不足 5 分钟 → 不释放', () => {
        const hiddenAt = 1_000_000;
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: false }, hiddenAt + FIVE_MINUTES - 1)).toBe(
            false
        );
    });

    test('当前可见 → 不释放（不依赖 hiddenAt）', () => {
        expect(shouldReleaseTaskView({ isHidden: false, hiddenAt: 0, isRunning: false }, 10_000_000)).toBe(false);
    });

    test('任务仍在运行 → 不释放（后台工具可能正在使用视图内组件）', () => {
        const hiddenAt = 1_000_000;
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: true }, hiddenAt + FIVE_MINUTES * 10)).toBe(
            false
        );
    });

    test('未记录进入后台的时间 → 不释放（保守策略）', () => {
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt: 0, isRunning: false }, 10_000_000)).toBe(false);
    });

    test('消息队列非空 → 不释放（队列仅存于控件内存，未持久化）', () => {
        const hiddenAt = 1_000_000;
        const base = { isHidden: true, hiddenAt, isRunning: false };
        expect(shouldReleaseTaskView({ ...base, hasQueuedMessages: true }, hiddenAt + FIVE_MINUTES * 10)).toBe(false);
    });

    test('草稿/附件不阻塞释放（已由 task-draft-storage 持久化）', () => {
        const hiddenAt = 1_000_000;
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: false }, hiddenAt + FIVE_MINUTES)).toBe(
            true
        );
    });

    test('刚好达到超时阈值即释放', () => {
        const hiddenAt = 1_000_000;
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: false }, hiddenAt + FIVE_MINUTES)).toBe(
            true
        );
    });

    test('支持自定义超时阈值', () => {
        const hiddenAt = 1_000_000;
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: false }, hiddenAt + 1000, 1000)).toBe(true);
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: false }, hiddenAt + 999, 1000)).toBe(false);
    });
});
