import {
    buildTaskStatusSummary,
    computeSubtaskProgress,
    computeTodoProgress,
    computeTriggerActive,
    computeWidgetTransitionBounds,
    isActiveTask,
    isInternalTask,
    isWidgetTriggerEffective,
    mergeTaskLiveUsage,
    normalizeTaskUsageWidget,
    pruneStaleWaitingTaskIds,
    updateTaskSnapshot,
    type TaskLiveUsageSnapshot,
    type TaskStatusListEntry,
    type TaskStatusWidgetTask,
    type TaskUsageTrackedState
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

    describe('isWidgetTriggerEffective', () => {
        test('无抑制状态时与常规触发条件一致', () => {
            expect(isWidgetTriggerEffective('card', { hidden: true, focused: true })).toBe(true);
            expect(isWidgetTriggerEffective('card', { hidden: false, focused: false })).toBe(true);
            expect(isWidgetTriggerEffective('card', { hidden: false, focused: true })).toBe(false);
            expect(isWidgetTriggerEffective(undefined, { hidden: true, focused: false })).toBe(false);
        });

        test('dismissed（关闭一次）：本次触发周期内不再显示', () => {
            expect(isWidgetTriggerEffective('card', { hidden: true, focused: true }, { dismissed: true })).toBe(false);
            expect(isWidgetTriggerEffective('card', { hidden: false, focused: true }, { dismissed: true })).toBe(false);
        });

        test('sessionDisabled（下次启动恢复）：本次会话内不再显示', () => {
            expect(isWidgetTriggerEffective('card', { hidden: true, focused: true }, { sessionDisabled: true })).toBe(
                false
            );
            expect(isWidgetTriggerEffective('card', { hidden: false, focused: false }, { sessionDisabled: true })).toBe(
                false
            );
        });

        test('sessionDisabled 优先级高于 dismissed', () => {
            expect(
                isWidgetTriggerEffective(
                    'card',
                    { hidden: true, focused: true },
                    { dismissed: true, sessionDisabled: true }
                )
            ).toBe(false);
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

        test('快照仅含主任务，子任务不单独展示（仅参与上级进度统计）', () => {
            const list = [
                task({ task_id: 'a', task_name: 'Alpha', task_status: 'running' }),
                task({ task_id: 's1', parent_id: 'a', task_name: 'Sub-1', task_status: 'running' }),
                task({ task_id: 's2', parent_id: 'a', task_name: 'Sub-2', task_status: 'waiting' })
            ];
            const snapshot = updateTaskSnapshot([], list);

            expect(snapshot.map((t) => t.task_id)).toEqual(['a']);
            expect(snapshot[0].subtask_progress).toEqual({ completed: 0, total: 2, percent: 0 });
        });

        test('父任务已从列表移除的子任务按根任务展示（与侧边栏层级口径一致）', () => {
            const list = [task({ task_id: 's1', parent_id: 'gone', task_name: 'Orphan', task_status: 'running' })];
            const snapshot = updateTaskSnapshot([], list);

            expect(snapshot.map((t) => t.task_id)).toEqual(['s1']);
        });

        test('快照中已存在的非根任务不再保留（避免历史子任务滞留）', () => {
            const initial: TaskStatusWidgetTask[] = [
                snapshotEntry({ task_id: 's1', task_name: 'Sub', task_status: 'running' })
            ];
            const list = [
                task({ task_id: 'a', task_name: 'Alpha', task_status: 'running' }),
                task({ task_id: 's1', parent_id: 'a', task_name: 'Sub', task_status: 'stopped' })
            ];
            const snapshot = updateTaskSnapshot(initial, list);

            expect(snapshot.map((t) => t.task_id)).toEqual(['a']);
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

        test('已完成任务即使残留 waiting 标记也不显示 waiting_for_input', () => {
            const tasks: TaskStatusWidgetTask[] = [
                widgetTask({ task_id: 'a', task_name: 'Alpha', task_status: 'completed' }),
                widgetTask({ task_id: 'b', task_name: 'Beta', task_status: 'waiting' })
            ];
            const summary = buildTaskStatusSummary(tasks, new Set(['a', 'b']));

            // 任务已结束：不再展示「需要操作」，即使 waitingTaskIds 中仍有残留。
            expect(summary.tasks[0].waiting_for_input).toBe(false);
            expect(summary.tasks[1].waiting_for_input).toBe(true);
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

    describe('pruneStaleWaitingTaskIds', () => {
        test('已结束或已移除的任务从 waiting 集合中剔除', () => {
            const list = [
                task({ task_id: 'a', task_name: 'Alpha', task_status: 'running' }),
                task({ task_id: 'b', task_name: 'Beta', task_status: 'waiting' }),
                task({ task_id: 'c', task_name: 'Gamma', task_status: 'stopped' })
            ];
            // d 已从任务列表移除；c 已停止；a/b 仍活跃
            const kept = pruneStaleWaitingTaskIds(new Set(['a', 'b', 'c', 'd']), list);

            expect(kept.sort()).toEqual(['a', 'b']);
        });

        test('空任务列表全部剔除', () => {
            expect(pruneStaleWaitingTaskIds(new Set(['a', 'b']), [])).toEqual([]);
            expect(pruneStaleWaitingTaskIds(new Set(['a', 'b']), null)).toEqual([]);
            expect(pruneStaleWaitingTaskIds(new Set(), [])).toEqual([]);
        });

        test('只有活跃任务（有名称且非 internal）才保留', () => {
            const list = [
                task({ task_id: 'a', task_name: 'Alpha', task_status: 'running' }),
                task({ task_id: 'noName', task_name: '', task_status: 'running' }),
                task({ task_id: 'internal', task_name: 'Hidden', task_status: 'running', internal: true })
            ];
            const kept = pruneStaleWaitingTaskIds(new Set(['a', 'noName', 'internal']), list);

            expect(kept).toEqual(['a']);
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

    describe('normalizeTaskUsageWidget', () => {
        test('input/output 优先，缺失时回退 prompt/completion', () => {
            expect(normalizeTaskUsageWidget({ total_tokens: 8, input_tokens: 5, output_tokens: 3 })).toEqual({
                total_tokens: 8,
                input_tokens: 5,
                output_tokens: 3
            });
            expect(normalizeTaskUsageWidget({ prompt_tokens: 5, completion_tokens: 3 })).toEqual({
                total_tokens: 8,
                input_tokens: 5,
                output_tokens: 3
            });
            expect(normalizeTaskUsageWidget(undefined)).toEqual({ total_tokens: 0, input_tokens: 0, output_tokens: 0 });
        });
    });

    describe('mergeTaskLiveUsage', () => {
        // 消息创建时刻（毫秒时间戳）与 usage_summary.updated_at（ISO）保持一致的时间轴。
        const MSG_TIME = 1767225605000; // 2026-01-01T00:00:05.000Z
        const BEFORE_MSG = new Date(MSG_TIME - 60_000).toISOString();
        const AFTER_MSG = new Date(MSG_TIME + 60_000).toISOString();

        const live = (overrides: Partial<TaskLiveUsageSnapshot> = {}): TaskLiveUsageSnapshot => ({
            message_id: 'm1',
            message_timestamp: MSG_TIME,
            usage: { total_tokens: 15, input_tokens: 10, output_tokens: 5 },
            ...overrides
        });

        const trackedWith = (overrides: Partial<TaskUsageTrackedState> = {}): TaskUsageTrackedState => ({
            message_id: 'm1',
            request_count_at_message_start: 0,
            last_live_total: { total: 15, input: 10, output: 5 },
            ...overrides
        });

        test('无在途消息：仅展示累计值', () => {
            const summary = {
                total_tokens: 100,
                input_tokens: 60,
                output_tokens: 40,
                request_count: 2,
                updated_at: AFTER_MSG
            };
            const { usage, tracked } = mergeTaskLiveUsage(summary, undefined, undefined);

            expect(usage).toEqual({ total_tokens: 100, input_tokens: 60, output_tokens: 40 });
            expect(tracked.request_count_at_message_start).toBe(2);
            expect(tracked.last_live_total).toBeUndefined();
        });

        test('同一消息、值未变化、请求未提交（最终 chunk 送达、提交前瞬间）：累计 + 实时', () => {
            const summary = {
                total_tokens: 0,
                input_tokens: 0,
                output_tokens: 0,
                request_count: 0,
                updated_at: BEFORE_MSG
            };
            // live 值与 tracked.last_live_total 完全一致（{15,10,5}），且 request_count 未推进。
            const current = live();
            const { usage, tracked } = mergeTaskLiveUsage(summary, current, trackedWith());

            expect(usage).toEqual({ total_tokens: 15, input_tokens: 10, output_tokens: 5 });
            expect(tracked.request_count_at_message_start).toBe(0);
        });

        test('同一消息、值未变化、请求已提交（request_count 推进）：仅累计值，避免重复计数', () => {
            const summary = {
                total_tokens: 150,
                input_tokens: 100,
                output_tokens: 50,
                request_count: 1,
                updated_at: AFTER_MSG
            };
            const current = live({ usage: { total_tokens: 150, input_tokens: 100, output_tokens: 50 } });
            const { usage, tracked } = mergeTaskLiveUsage(
                summary,
                current,
                trackedWith({ last_live_total: { total: 150, input: 100, output: 50 } })
            );

            expect(usage).toEqual({ total_tokens: 150, input_tokens: 100, output_tokens: 50 });
            expect(tracked.request_count_at_message_start).toBe(1);
        });

        test('同一消息、live 值变化（新请求轮次）：累计 + 实时', () => {
            const summary = {
                total_tokens: 150,
                input_tokens: 100,
                output_tokens: 50,
                request_count: 1,
                updated_at: AFTER_MSG
            };
            const current = live({ usage: { total_tokens: 600, input_tokens: 200, output_tokens: 400 } });
            const { usage, tracked } = mergeTaskLiveUsage(summary, current, trackedWith());

            expect(usage).toEqual({ total_tokens: 750, input_tokens: 300, output_tokens: 450 });
            expect(tracked).toEqual({
                message_id: 'm1',
                request_count_at_message_start: 1,
                last_live_total: { total: 600, input: 200, output: 400 }
            });
        });

        test('新消息且请求未提交：累计 + 实时', () => {
            const summary = {
                total_tokens: 150,
                input_tokens: 100,
                output_tokens: 50,
                request_count: 1,
                updated_at: BEFORE_MSG
            };
            const current = live({
                message_id: 'm2',
                usage: { total_tokens: 40, input_tokens: 30, output_tokens: 10 }
            });
            const { usage, tracked } = mergeTaskLiveUsage(summary, current, trackedWith({ message_id: 'm1' }));

            expect(usage).toEqual({ total_tokens: 190, input_tokens: 130, output_tokens: 60 });
            expect(tracked).toEqual({
                message_id: 'm2',
                request_count_at_message_start: 1,
                last_live_total: { total: 40, input: 30, output: 10 }
            });
        });

        test('新消息但请求已在浮窗看到前提交（updated_at 不早于消息创建）：仅累计值，避免重复计数', () => {
            const summary = {
                total_tokens: 150,
                input_tokens: 100,
                output_tokens: 50,
                request_count: 2,
                updated_at: AFTER_MSG
            };
            const current = live({
                message_id: 'm2',
                usage: { total_tokens: 40, input_tokens: 30, output_tokens: 10 }
            });
            const { usage } = mergeTaskLiveUsage(summary, current, trackedWith({ message_id: 'm1' }));

            expect(usage).toEqual({ total_tokens: 150, input_tokens: 100, output_tokens: 50 });
        });

        test('实时 usage 缺失 input/output 时回退 prompt/completion', () => {
            const summary = {
                total_tokens: 500,
                input_tokens: 200,
                output_tokens: 300,
                request_count: 1,
                updated_at: BEFORE_MSG
            };
            const current = live({
                message_id: 'm2',
                usage: { total_tokens: 15, prompt_tokens: 10, completion_tokens: 5 }
            });
            const { usage } = mergeTaskLiveUsage(summary, current, undefined);

            expect(usage).toEqual({ total_tokens: 515, input_tokens: 210, output_tokens: 305 });
        });

        test('Anthropic 风格流式增长：live 值逐步变化，展示 累计 + 实时增长', () => {
            const summary = {
                total_tokens: 0,
                input_tokens: 0,
                output_tokens: 0,
                request_count: 0,
                updated_at: BEFORE_MSG
            };
            let tracked: TaskUsageTrackedState | undefined;
            let lastUsage;
            for (const output of [10, 100, 500]) {
                const current = live({
                    usage: { total_tokens: 50 + output, input_tokens: 50, output_tokens: output }
                });
                const merged = mergeTaskLiveUsage(summary, current, tracked);
                tracked = merged.tracked;
                lastUsage = merged.usage;
            }

            expect(lastUsage).toEqual({ total_tokens: 550, input_tokens: 50, output_tokens: 500 });
            expect(tracked).toEqual({
                message_id: 'm1',
                request_count_at_message_start: 0,
                last_live_total: { total: 550, input: 50, output: 500 }
            });
        });

        test('OpenAI 风格完整多轮场景：全程展示累积值，提交后不重复计数', () => {
            const messageTime = MSG_TIME;
            let summary = {
                total_tokens: 0,
                input_tokens: 0,
                output_tokens: 0,
                request_count: 0,
                updated_at: BEFORE_MSG
            };
            let tracked: TaskUsageTrackedState | undefined;

            // round1 最终 chunk（携带 usage）：累计 + 实时 = round1
            let current = live({
                message_id: 'm1',
                message_timestamp: messageTime,
                usage: { total_tokens: 120, input_tokens: 100, output_tokens: 20 }
            });
            let merged = mergeTaskLiveUsage(summary, current, tracked);
            tracked = merged.tracked;
            expect(merged.usage).toEqual({ total_tokens: 120, input_tokens: 100, output_tokens: 20 });

            // round1 提交进 usage_summary
            summary = {
                total_tokens: 120,
                input_tokens: 100,
                output_tokens: 20,
                request_count: 1,
                updated_at: AFTER_MSG
            };

            // round2 流式中间（OpenAI 不携带 usage，live 停留 round1 结果）：仅累计，不重复
            current = live({
                message_id: 'm1',
                message_timestamp: messageTime,
                usage: { total_tokens: 120, input_tokens: 100, output_tokens: 20 }
            });
            merged = mergeTaskLiveUsage(summary, current, tracked);
            tracked = merged.tracked;
            expect(merged.usage).toEqual({ total_tokens: 120, input_tokens: 100, output_tokens: 20 });

            // round2 最终 chunk（usage 变为 round2）：累计 + 实时
            current = live({
                message_id: 'm1',
                message_timestamp: messageTime,
                usage: { total_tokens: 600, input_tokens: 200, output_tokens: 400 }
            });
            merged = mergeTaskLiveUsage(summary, current, tracked);
            tracked = merged.tracked;
            expect(merged.usage).toEqual({ total_tokens: 720, input_tokens: 300, output_tokens: 420 });

            // round2 提交：仅累计
            summary = {
                total_tokens: 720,
                input_tokens: 300,
                output_tokens: 420,
                request_count: 2,
                updated_at: AFTER_MSG
            };
            current = live({
                message_id: 'm1',
                message_timestamp: messageTime,
                usage: { total_tokens: 600, input_tokens: 200, output_tokens: 400 }
            });
            merged = mergeTaskLiveUsage(summary, current, tracked);
            expect(merged.usage).toEqual({ total_tokens: 720, input_tokens: 300, output_tokens: 420 });
        });
    });

    describe('computeWidgetTransitionBounds', () => {
        // 屏幕工作区：原点 (0, 0)，尺寸 1920x1040（底部任务栏占 40px 的典型 Windows 布局）。
        const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
        const expanded = { width: 340, height: 215 };
        const collapsed = { width: 240, height: 44 };
        const margin = 28;
        type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

        /** 计算某个尺寸的窗口贴在指定角（留 margin）时的位置。 */
        const cornerPos = (corner: Corner, size: { width: number; height: number }) => ({
            x: corner.endsWith('left') ? workArea.x + margin : workArea.x + workArea.width - margin - size.width,
            y: corner.startsWith('top') ? workArea.y + margin : workArea.y + workArea.height - margin - size.height,
            width: size.width,
            height: size.height
        });
        /** 胶囊（已贴角）展开为目标角上的完整浮窗。 */
        const expandAt = (corner: Corner) =>
            computeWidgetTransitionBounds({
                position: corner,
                currentBounds: cornerPos(corner, collapsed),
                toCollapsed: false,
                collapsedSize: collapsed,
                expandedSize: expanded,
                workArea
            });
        /** 完整浮窗（已贴角）收起为目标角上的胶囊。 */
        const collapseAt = (corner: Corner) =>
            computeWidgetTransitionBounds({
                position: corner,
                currentBounds: cornerPos(corner, expanded),
                toCollapsed: true,
                collapsedSize: collapsed,
                expandedSize: expanded,
                workArea
            });

        test('右下角锚定：胶囊展开时左上角向左上移动，右下角保持贴角', () => {
            const b = expandAt('bottom-right');
            expect(b).toEqual(cornerPos('bottom-right', expanded));
        });

        test('右下角锚定：展开态收起时右下角向右下收拢，回到贴角位置', () => {
            const b = collapseAt('bottom-right');
            expect(b).toEqual(cornerPos('bottom-right', collapsed));
        });

        test('左下角锚定：水平贴左、垂直贴底展开', () => {
            const b = expandAt('bottom-left');
            expect(b).toEqual(cornerPos('bottom-left', expanded));
        });

        test('右上角锚定：水平贴右、垂直贴顶展开', () => {
            const b = expandAt('top-right');
            expect(b).toEqual(cornerPos('top-right', expanded));
        });

        test('左上角锚定：贴左上展开，收起回到贴左上', () => {
            expect(expandAt('top-left')).toEqual(cornerPos('top-left', expanded));
            expect(collapseAt('top-left')).toEqual(cornerPos('top-left', collapsed));
        });

        test('四个角展开→收起闭环：收起位置与贴角胶囊初始位置一致', () => {
            for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
                const expandedBounds = expandAt(corner);
                const collapsedAgain = computeWidgetTransitionBounds({
                    position: corner,
                    currentBounds: expandedBounds,
                    toCollapsed: true,
                    collapsedSize: collapsed,
                    expandedSize: expanded,
                    workArea
                });
                expect(collapsedAgain).toEqual(cornerPos(corner, collapsed));
            }
        });

        test('右侧越界钳制：胶囊贴近屏幕右缘时，展开仍完整落在工作区内', () => {
            // 模拟 issue #335 场景：胶囊被拖到右缘（x + width = 1920），展开若保持
            // 左上角不动会向右溢出屏幕 100px；钳制后必须完整可见。
            const b = computeWidgetTransitionBounds({
                position: 'bottom-right',
                currentBounds: { x: 1920 - collapsed.width, y: 500, width: collapsed.width, height: collapsed.height },
                toCollapsed: false,
                collapsedSize: collapsed,
                expandedSize: expanded,
                workArea
            });
            expect(b.x).toBe(1920 - expanded.width);
            expect(b.y).toBe(500 + collapsed.height - expanded.height);
            expect(b.x + b.width).toBeLessThanOrEqual(1920);
        });

        test('底部越界钳制：胶囊位于工作区底缘时，展开完整落在工作区内', () => {
            const b = computeWidgetTransitionBounds({
                position: 'bottom-right',
                currentBounds: {
                    x: 1000,
                    y: 1040 - collapsed.height,
                    width: collapsed.width,
                    height: collapsed.height
                },
                toCollapsed: false,
                collapsedSize: collapsed,
                expandedSize: expanded,
                workArea
            });
            expect(b.y).toBe(1040 - expanded.height);
            expect(b.y + b.height).toBeLessThanOrEqual(1040);
        });

        test('左侧越界钳制：右下角锚定的胶囊被拖到屏幕左缘，展开不越出左边界', () => {
            const b = computeWidgetTransitionBounds({
                position: 'bottom-right',
                currentBounds: { x: 10, y: 500, width: collapsed.width, height: collapsed.height },
                toCollapsed: false,
                collapsedSize: collapsed,
                expandedSize: expanded,
                workArea
            });
            expect(b.x).toBe(0);
            expect(b.x).toBeGreaterThanOrEqual(workArea.x);
        });

        test('顶部越界钳制：右下角锚定的胶囊贴近屏幕顶缘，展开不越出上边界', () => {
            const b = computeWidgetTransitionBounds({
                position: 'bottom-right',
                currentBounds: { x: 500, y: 5, width: collapsed.width, height: collapsed.height },
                toCollapsed: false,
                collapsedSize: collapsed,
                expandedSize: expanded,
                workArea
            });
            expect(b.y).toBe(0);
        });

        test('未拖拽的贴角胶囊：展开位置与初始展开角位置一致（issue #335 回归）', () => {
            const b = expandAt('bottom-right');
            expect(b.x).toBe(1920 - margin - expanded.width);
            expect(b.y).toBe(1040 - margin - expanded.height);
        });

        test('越界与钳制同时生效时结果不超出工作区', () => {
            const b = computeWidgetTransitionBounds({
                position: 'bottom-right',
                currentBounds: { x: -50, y: 2000, width: collapsed.width, height: collapsed.height },
                toCollapsed: false,
                collapsedSize: collapsed,
                expandedSize: expanded,
                workArea
            });
            expect(b.x).toBeGreaterThanOrEqual(workArea.x);
            expect(b.y + b.height).toBeLessThanOrEqual(workArea.y + workArea.height);
        });
    });
});
