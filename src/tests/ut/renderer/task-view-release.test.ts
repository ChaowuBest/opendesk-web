import {
    shouldReleaseTaskView,
    selectTaskViewsToEvict,
    TASK_VIEW_BACKGROUND_RELEASE_MS,
    MAX_RESIDENT_TASK_VIEWS
} from '../../../renderer/utils/task-view-release';

const TIMEOUT_MS = TASK_VIEW_BACKGROUND_RELEASE_MS;

describe('shouldReleaseTaskView', () => {
    test('不可见超过超时阈值且任务非运行态 → 释放', () => {
        const hiddenAt = 1_000_000;
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: false }, hiddenAt + TIMEOUT_MS)).toBe(true);
    });

    test('不可见但不足超时阈值 → 不释放', () => {
        const hiddenAt = 1_000_000;
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: false }, hiddenAt + TIMEOUT_MS - 1)).toBe(
            false
        );
    });

    test('当前可见 → 不释放（不依赖 hiddenAt）', () => {
        expect(shouldReleaseTaskView({ isHidden: false, hiddenAt: 0, isRunning: false }, 10_000_000)).toBe(false);
    });

    test('任务仍在运行 → 不释放（后台工具可能正在使用视图内组件）', () => {
        const hiddenAt = 1_000_000;
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: true }, hiddenAt + TIMEOUT_MS * 10)).toBe(
            false
        );
    });

    test('未记录进入后台的时间 → 不释放（保守策略）', () => {
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt: 0, isRunning: false }, 10_000_000)).toBe(false);
    });

    test('消息队列非空 → 不释放（队列仅存于控件内存，未持久化）', () => {
        const hiddenAt = 1_000_000;
        const base = { isHidden: true, hiddenAt, isRunning: false };
        expect(shouldReleaseTaskView({ ...base, hasQueuedMessages: true }, hiddenAt + TIMEOUT_MS * 10)).toBe(false);
    });

    test('草稿/附件不阻塞释放（已由 task-draft-storage 持久化）', () => {
        const hiddenAt = 1_000_000;
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: false }, hiddenAt + TIMEOUT_MS)).toBe(true);
    });

    test('刚好达到超时阈值即释放', () => {
        const hiddenAt = 1_000_000;
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: false }, hiddenAt + TIMEOUT_MS)).toBe(true);
    });

    test('支持自定义超时阈值', () => {
        const hiddenAt = 1_000_000;
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: false }, hiddenAt + 1000, 1000)).toBe(true);
        expect(shouldReleaseTaskView({ isHidden: true, hiddenAt, isRunning: false }, hiddenAt + 999, 1000)).toBe(false);
    });
});

describe('selectTaskViewsToEvict', () => {
    const base = (
        taskId: string,
        lastAccessAt: number,
        overrides: Partial<Parameters<typeof selectTaskViewsToEvict>[0][number]> = {}
    ) => ({
        taskId,
        lastAccessAt,
        isActive: false,
        isRunning: false,
        hasQueuedMessages: false,
        ...overrides
    });

    test('驻留数量未超过上限 → 不淘汰任何视图', () => {
        const entries = [base('a', 100), base('b', 200), base('c', 300)];
        expect(selectTaskViewsToEvict(entries, 5)).toEqual([]);
    });

    test('驻留数量超过上限 → 按最近访问时间升序淘汰最久未访问者', () => {
        const entries = [
            base('a', 100),
            base('b', 200),
            base('c', 300),
            base('d', 400),
            base('e', 500),
            base('f', 600)
        ];
        expect(selectTaskViewsToEvict(entries, MAX_RESIDENT_TASK_VIEWS)).toEqual(['a']);
        expect(selectTaskViewsToEvict(entries, 4)).toEqual(['a', 'b']);
    });

    test('当前前台显示的视图不参与淘汰', () => {
        const entries = [
            base('active', 100, { isActive: true }),
            base('b', 200),
            base('c', 300),
            base('d', 400),
            base('e', 500),
            base('f', 600)
        ];
        expect(selectTaskViewsToEvict(entries, MAX_RESIDENT_TASK_VIEWS)).toEqual(['b']);
    });

    test('运行中的任务视图不参与淘汰', () => {
        const entries = [
            base('running', 100, { isRunning: true }),
            base('b', 200),
            base('c', 300),
            base('d', 400),
            base('e', 500),
            base('f', 600)
        ];
        expect(selectTaskViewsToEvict(entries, MAX_RESIDENT_TASK_VIEWS)).toEqual(['b']);
    });

    test('消息队列非空的视图不参与淘汰（避免静默丢弃待发送内容）', () => {
        const entries = [
            base('queued', 100, { hasQueuedMessages: true }),
            base('b', 200),
            base('c', 300),
            base('d', 400),
            base('e', 500),
            base('f', 600)
        ];
        expect(selectTaskViewsToEvict(entries, MAX_RESIDENT_TASK_VIEWS)).toEqual(['b']);
    });

    test('可淘汰候选不足时不强制凑满，只淘汰可淘汰的', () => {
        const entries = [
            base('active', 100, { isActive: true }),
            base('running', 200, { isRunning: true }),
            base('c', 300)
        ];
        // 超限 2 个但只有 c 可淘汰 → 只淘汰 c
        expect(selectTaskViewsToEvict(entries, 1)).toEqual(['c']);
    });

    test('未记录最近访问时间（视为 0，最旧）的视图优先被淘汰', () => {
        const entries = [
            base('never-opened', 0),
            base('b', 200),
            base('c', 300),
            base('d', 400),
            base('e', 500),
            base('f', 600)
        ];
        expect(selectTaskViewsToEvict(entries, MAX_RESIDENT_TASK_VIEWS)).toEqual(['never-opened']);
    });
});
