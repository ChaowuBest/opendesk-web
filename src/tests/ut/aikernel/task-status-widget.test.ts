import {
    buildTaskStatusSummary,
    computeSubtaskProgress,
    computeTodoProgress,
    computeTriggerActive,
    isActiveTask,
    isInternalTask,
    updateTaskSnapshot,
    type TaskStatusListEntry,
    type TaskStatusWidgetTask
} from '../../../main/windows/task-status-widget.js';

function task(overrides: Partial<TaskStatusListEntry> = {}): TaskStatusListEntry {
    return {
        task_id: 't1',
        task_name: 'Task',
        task_status: 'running',
        ...overrides
    };
}

function widgetTask(overrides: Partial<TaskStatusWidgetTask> = {}): TaskStatusWidgetTask {
    return {
        task_id: 't1',
        task_name: 'Task',
        task_status: 'running',
        usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
        ...overrides
    };
}

describe('task-status-widget 纯逻辑', () => {
    describe('isInternalTask / isActiveTask', () => {
        test('waiting / running 且非 internal 判定为活跃', () => {
            expect(isActiveTask(task({ task_status: 'waiting' }))).toBe(true);
            expect(isActiveTask(task({ task_status: 'running' }))).toBe(true);
        });

        test('internal 任务不视为活跃', () => {
            expect(isInternalTask(task({ internal: true }))).toBe(true);
            expect(isActiveTask(task({ internal: true, task_status: 'running' }))).toBe(false);
        });

        test('无名称任务（GUI 中不可见）不视为活跃', () => {
            expect(isActiveTask(task({ task_name: null, task_status: 'running' }))).toBe(false);
            expect(isActiveTask(task({ task_name: '', task_status: 'waiting' }))).toBe(false);
            expect(isActiveTask(task({ task_name: '   ', task_status: 'running' }))).toBe(false);
        });

        test('stopped / 空值判定为非活跃', () => {
            expect(isActiveTask(task({ task_status: 'stopped' }))).toBe(false);
            expect(isActiveTask(null)).toBe(false);
            expect(isActiveTask(undefined)).toBe(false);
            expect(isActiveTask({})).toBe(false);
        });
    });

    describe('computeTriggerActive', () => {
        test('undefined（关闭）永不激活', () => {
            expect(computeTriggerActive(undefined, { hidden: true, focused: false })).toBe(false);
            expect(computeTriggerActive(undefined, { hidden: false, focused: true })).toBe(false);
        });

        test('pill 在主窗口不在前台时激活', () => {
            expect(computeTriggerActive('pill', { hidden: true, focused: false })).toBe(true);
            expect(computeTriggerActive('pill', { hidden: true, focused: true })).toBe(true);
            expect(computeTriggerActive('pill', { hidden: false, focused: false })).toBe(true);
            expect(computeTriggerActive('pill', { hidden: false, focused: true })).toBe(false);
        });

        test('card 在主窗口不在前台时激活', () => {
            expect(computeTriggerActive('card', { hidden: true, focused: true })).toBe(true);
            expect(computeTriggerActive('card', { hidden: false, focused: false })).toBe(true);
            expect(computeTriggerActive('card', { hidden: false, focused: true })).toBe(false);
        });
    });

    describe('updateTaskSnapshot', () => {
        const snapshotEntry = (overrides: Partial<TaskStatusWidgetTask> = {}): TaskStatusWidgetTask => ({
            task_id: 'a',
            task_name: 'Alpha',
            task_status: 'running',
            usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
            ...overrides
        });

        test('首次快照仅包含活跃任务，排除 internal', () => {
            const list = [
                task({ task_id: 'a', task_name: 'Alpha', task_status: 'running' }),
                task({ task_id: 'b', task_name: 'Beta', task_status: 'waiting' }),
                task({ task_id: 'c', task_name: 'Done', task_status: 'stopped' }),
                task({ task_id: 'd', task_name: 'Hidden', task_status: 'running', internal: true })
            ];
            const snapshot = updateTaskSnapshot([], list);

            expect(snapshot.map((t) => t.task_id)).toEqual(['a', 'b']);
        });

        test('活跃任务结束后保留并标记为 completed，且不因全部完成而清空', () => {
            const initial: TaskStatusWidgetTask[] = [
                snapshotEntry({ task_id: 'a', task_name: 'Alpha', task_status: 'running' })
            ];
            const list = [task({ task_id: 'a', task_name: 'Alpha', task_status: 'stopped' })];
            const snapshot = updateTaskSnapshot(initial, list);

            expect(snapshot).toHaveLength(1);
            expect(snapshot[0].task_id).toBe('a');
            expect(snapshot[0].task_status).toBe('completed');
        });

        test('新活跃任务并入快照，活跃任务排在前面', () => {
            const initial: TaskStatusWidgetTask[] = [
                snapshotEntry({ task_id: 'a', task_name: 'Alpha', task_status: 'completed' })
            ];
            const list = [
                task({ task_id: 'a', task_name: 'Alpha', task_status: 'stopped' }),
                task({ task_id: 'b', task_name: 'Beta', task_status: 'running' })
            ];
            const snapshot = updateTaskSnapshot(initial, list);

            expect(snapshot.map((t) => t.task_id)).toEqual(['b', 'a']);
            expect(snapshot[0].task_status).toBe('running');
            expect(snapshot[1].task_status).toBe('completed');
        });

        test('任务被移除后从快照剔除', () => {
            const initial: TaskStatusWidgetTask[] = [
                snapshotEntry({ task_id: 'a', task_name: 'Alpha', task_status: 'completed' })
            ];
            const snapshot = updateTaskSnapshot(initial, []);

            expect(snapshot).toHaveLength(0);
        });

        test('任务名缺失时从快照排除（与 GUI 不可见口径一致）', () => {
            const list = [task({ task_id: 'a', task_name: null, task_status: 'running' })];
            const snapshot = updateTaskSnapshot([], list);

            expect(snapshot).toHaveLength(0);
        });
    });

    describe('buildTaskStatusSummary', () => {
        test('统计数量并保留任务顺序', () => {
            const tasks: TaskStatusWidgetTask[] = [
                widgetTask({ task_id: 'a', task_name: 'Alpha', task_status: 'running' }),
                widgetTask({ task_id: 'b', task_name: 'Beta', task_status: 'completed' })
            ];
            const summary = buildTaskStatusSummary(tasks);

            expect(summary.count).toBe(2);
            expect(summary.tasks.map((t) => t.task_id)).toEqual(['a', 'b']);
        });

        test('空快照返回空摘要', () => {
            expect(buildTaskStatusSummary([])).toEqual({ count: 0, total: 0, tasks: [], mode: undefined });
        });

        test('根据 waitingTaskIds 注入 waiting_for_input 标记', () => {
            const tasks: TaskStatusWidgetTask[] = [
                widgetTask({ task_id: 'a', task_name: 'Alpha', task_status: 'running' }),
                widgetTask({ task_id: 'b', task_name: 'Beta', task_status: 'running' })
            ];
            const summary = buildTaskStatusSummary(tasks, new Set(['a']));

            expect(summary.tasks[0].waiting_for_input).toBe(true);
            expect(summary.tasks[1].waiting_for_input).toBe(false);
        });

        test('携带 total，并根据 getTodosForTask 注入待办进度', () => {
            const tasks: TaskStatusWidgetTask[] = [
                widgetTask({ task_id: 'a', task_name: 'Alpha', task_status: 'running' })
            ];
            const summary = buildTaskStatusSummary(tasks, undefined, 5, (taskId) =>
                taskId === 'a' ? [{ status: 'completed' }, { status: 'in_progress' }] : []
            );

            expect(summary.total).toBe(5);
            expect(summary.tasks[0].todo_progress).toEqual({ completed: 1, total: 2, percent: 50 });
        });

        test('未提供 getTodosForTask 时不注入待办进度', () => {
            const tasks: TaskStatusWidgetTask[] = [
                widgetTask({ task_id: 'a', task_name: 'Alpha', task_status: 'running' })
            ];
            const summary = buildTaskStatusSummary(tasks, undefined, 1);

            expect(summary.tasks[0].todo_progress).toBeUndefined();
        });
    });

    describe('computeTodoProgress', () => {
        test('无待办返回 0%', () => {
            expect(computeTodoProgress([])).toEqual({ completed: 0, total: 0, percent: 0 });
            expect(computeTodoProgress(null)).toEqual({ completed: 0, total: 0, percent: 0 });
            expect(computeTodoProgress(undefined)).toEqual({ completed: 0, total: 0, percent: 0 });
        });

        test('按 completed / total 计算百分比（四舍五入）', () => {
            const todos = [
                { status: 'completed' },
                { status: 'in_progress' },
                { status: 'pending' },
                { status: 'completed' }
            ];
            expect(computeTodoProgress(todos)).toEqual({ completed: 2, total: 4, percent: 50 });
        });

        test('忽略空条目', () => {
            expect(computeTodoProgress([{ status: 'completed' }, null, {}])).toEqual({
                completed: 1,
                total: 3,
                percent: 33
            });
        });
    });

    describe('computeSubtaskProgress', () => {
        test('无子任务返回 0%', () => {
            expect(computeSubtaskProgress('a', [])).toEqual({ completed: 0, total: 0, percent: 0 });
            expect(computeSubtaskProgress('a', null)).toEqual({ completed: 0, total: 0, percent: 0 });
        });

        test('按 parent_id 关联统计，终态视为已结束', () => {
            const list = [
                task({ task_id: 's1', parent_id: 'a', task_status: 'completed' }),
                task({ task_id: 's2', parent_id: 'a', task_status: 'running' }),
                task({ task_id: 's3', parent_id: 'a', task_status: 'stopped' }),
                task({ task_id: 's4', parent_id: 'b', task_status: 'completed' })
            ];
            expect(computeSubtaskProgress('a', list)).toEqual({ completed: 2, total: 3, percent: 67 });
        });

        test('子任务附带 usage 与进度被写入快照条目', () => {
            const list = [
                task({
                    task_id: 'a',
                    task_name: 'Alpha',
                    task_status: 'running',
                    usage_summary: { total_tokens: 120, input_tokens: 80, output_tokens: 40 }
                }),
                task({ task_id: 's1', parent_id: 'a', task_name: 'Sub', task_status: 'completed' })
            ];
            const snapshot = updateTaskSnapshot([], list);

            expect(snapshot[0].usage).toEqual({ total_tokens: 120, input_tokens: 80, output_tokens: 40 });
            expect(snapshot[0].subtask_progress).toEqual({ completed: 1, total: 1, percent: 100 });
        });
    });
});
