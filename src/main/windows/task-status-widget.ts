/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 任务状态浮窗的纯逻辑（不依赖 Electron），便于单元测试。
 *
 * 语义：
 * - 「活跃任务」= task_status 为 waiting/running 且非 internal 的任务。
 * - 浮窗一旦显示，会保留本次「打开周期」内出现过的任务快照；活跃任务结束后
 *   不会从快照中剔除，而是标记为 completed，直到浮窗随主窗口恢复而关闭。
 */

/** 视为「活跃」的任务状态：等待中或进行中。与 TaskState.waitUntilFinished 的口径一致。 */
export const ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set(['waiting', 'running']);

/** 悬浮窗显示模式。undefined 表示关闭。 */
export type FloatingWindowMode = 'pill' | 'card' | undefined;

/** 主窗口可见性状态。 */
export interface WindowVisibilityState {
    /** 是否已最小化/隐藏到托盘。 */
    hidden: boolean;
    /** 是否处于前台（拥有焦点）。 */
    focused: boolean;
}

/** 任务列表条目（与 serializeTaskSimplified 输出对齐的最小字段集）。 */
export interface TaskStatusListEntry {
    task_id?: string;
    task_name?: string | null;
    task_status?: string;
    parent_id?: string | null;
    internal?: boolean;
    started_at?: string;
    finished_at?: string;
    usage_summary?: TaskUsageSummaryLike;
}

/** 任务 Token 用量摘要（与 serializeTaskSimplified.usage_summary 对齐的最小字段集）。 */
export interface TaskUsageSummaryLike {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
}

/** 待办条目最小字段（仅需 status 用于计算进度）。 */
export interface TodoLike {
    status?: string;
}

/** 完成进度（completed / total / percent），待办与子任务共用。 */
export interface TaskTodoProgress {
    completed: number;
    total: number;
    percent: number;
}

export interface TaskStatusWidgetTask {
    task_id: string;
    task_name: string;
    task_status: 'running' | 'waiting' | 'completed';
    started_at?: string;
    finished_at?: string;
    /** 任务当前是否在等待用户输入（需要用户操作）。 */
    waiting_for_input?: boolean;
    /** 任务级待办（TodoWrite）完成进度。 */
    todo_progress?: TaskTodoProgress;
    /** 子任务完成进度（以任务列表中的 parent_id 关联统计）。 */
    subtask_progress?: TaskTodoProgress;
    /** 任务 Token 用量（总 / 输入 / 输出）。 */
    usage: TaskUsageWidget;
}

export interface TaskUsageWidget {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
}

export interface TaskStatusWidgetSummary {
    count: number;
    /** 任务列表中的任务总数（用于「显示 X / Y 个任务」页脚）。 */
    total: number;
    tasks: TaskStatusWidgetTask[];
    /** 当前悬浮窗显示模式（pill / card / undefined 关闭）。 */
    mode: FloatingWindowMode;
}

export function isInternalTask(task: { internal?: boolean } | null | undefined): boolean {
    return !!task && task.internal === true;
}

/**
 * 判断任务是否「活跃且可展示」。
 *
 * 除 status 与 internal 外，额外要求任务已有非空名称，与侧边栏
 * isSidebarTaskVisible 的口径对齐：无名称的历史任务（例如从未启动的
 * waiting 任务）不会出现在 GUI 中，也不应出现在悬浮窗里。name_pending
 * 任务暂无名称，同样不展示（避免回退显示 task_id）。
 */
export function isActiveTask(task: TaskStatusListEntry | null | undefined): boolean {
    if (!task || isInternalTask(task)) {
        return false;
    }
    if (typeof task.task_name !== 'string' || task.task_name.trim().length === 0) {
        return false;
    }
    return typeof task.task_status === 'string' && ACTIVE_TASK_STATUSES.has(task.task_status);
}

/**
 * 根据显示模式与主窗口可见性计算「触发是否激活」。
 * - undefined（关闭）: 永不激活。
 * - pill（单行胶囊）: 主窗口不在前台（最小化/隐藏或失焦）时激活。
 * - card（完整卡片）: 主窗口不在前台时激活。
 */
export function computeTriggerActive(mode: FloatingWindowMode, state: WindowVisibilityState): boolean {
    if (!mode) {
        return false;
    }
    return state.hidden || !state.focused;
}

function toWidgetTask(
    task: TaskStatusListEntry,
    status: TaskStatusWidgetTask['task_status'],
    taskList: readonly TaskStatusListEntry[]
): TaskStatusWidgetTask {
    const taskId = typeof task.task_id === 'string' ? task.task_id : '';
    const usage = task.usage_summary;
    return {
        task_id: taskId,
        task_name: typeof task.task_name === 'string' && task.task_name.length > 0 ? task.task_name : taskId,
        task_status: status,
        started_at: task.started_at,
        finished_at: task.finished_at,
        subtask_progress: taskId ? computeSubtaskProgress(taskId, taskList) : undefined,
        usage: {
            total_tokens: typeof usage?.total_tokens === 'number' ? usage.total_tokens : 0,
            input_tokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
            output_tokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0
        }
    };
}

/**
 * 更新快照：
 * 1. 当前活跃任务排在最前，并实时刷新其状态/时间；
 * 2. 之前已显示、现在已结束（仍存在于列表）的任务保留并标记为 completed；
 * 3. 已从列表移除的任务从快照中剔除。
 */
export function updateTaskSnapshot(
    snapshot: readonly TaskStatusWidgetTask[],
    taskList: readonly TaskStatusListEntry[] | null | undefined
): TaskStatusWidgetTask[] {
    const next: TaskStatusWidgetTask[] = [];
    const seen = new Set<string>();

    const list = taskList ?? [];
    for (const task of list) {
        if (typeof task.task_id !== 'string' || !isActiveTask(task)) {
            continue;
        }
        next.push(toWidgetTask(task, task.task_status as TaskStatusWidgetTask['task_status'], list));
        seen.add(task.task_id);
    }

    const currentById = new Map(list.map((task) => [task.task_id, task]));
    for (const entry of snapshot) {
        if (seen.has(entry.task_id)) {
            continue;
        }
        const current = currentById.get(entry.task_id);
        if (!current) {
            // 任务已被移除，不再显示。
            continue;
        }
        next.push(toWidgetTask(current, 'completed', list));
        seen.add(entry.task_id);
    }

    return next;
}

/**
 * 计算任务子任务的完成进度。子任务以其 parent_id 关联到当前任务，
 * 「已结束」= 状态为 running/waiting 之外的终态（completed / stopped / failed 等）。
 */
export function computeSubtaskProgress(
    taskId: string,
    taskList: readonly TaskStatusListEntry[] | null | undefined
): TaskTodoProgress {
    const subtasks = (taskList ?? []).filter((task) => task.parent_id === taskId);
    const total = subtasks.length;
    const completed = subtasks.filter(
        (task) => typeof task.task_status === 'string' && !ACTIVE_TASK_STATUSES.has(task.task_status)
    ).length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { completed, total, percent };
}

/**
 * 计算任务级待办的完成进度（与「任务计划」面板口径一致：completed / total）。
 */
export function computeTodoProgress(todos: readonly TodoLike[] | null | undefined): TaskTodoProgress {
    const list = todos ?? [];
    const total = list.length;
    const completed = list.filter((todo) => todo?.status === 'completed').length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { completed, total, percent };
}

export function buildTaskStatusSummary(
    tasks: readonly TaskStatusWidgetTask[],
    waitingTaskIds?: ReadonlySet<string>,
    total?: number,
    getTodosForTask?: (taskId: string) => readonly TodoLike[] | null | undefined,
    mode?: FloatingWindowMode
): TaskStatusWidgetSummary {
    const enriched = tasks.map((task) => {
        const next: TaskStatusWidgetTask = {
            ...task,
            ...(waitingTaskIds ? { waiting_for_input: waitingTaskIds.has(task.task_id) } : {})
        };
        if (getTodosForTask && task.task_id) {
            next.todo_progress = computeTodoProgress(getTodosForTask(task.task_id));
        }
        return next;
    });
    return { count: enriched.length, total: total ?? enriched.length, tasks: enriched, mode };
}
