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

import type { TaskLiveUsageSnapshot } from '../aikernel/task/types.js';
export type { TaskLiveUsageSnapshot } from '../aikernel/task/types.js';

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
    prompt_tokens?: number;
    completion_tokens?: number;
    /** 已提交的请求数（usage_summary 每次叠加 +1），用于判断在途消息的请求是否已入账。 */
    request_count?: number;
    /** 最近一次请求提交的时间（ISO 字符串），用于辅助判断在途消息的请求是否已入账。 */
    updated_at?: string;
}

/**
 * 任务当前「在途/最后一条 assistant 消息」的实时 usage（TaskLiveUsageSnapshot，
 * 定义见 aikernel/task/types.ts，由 TaskState.getUsageSnapshot() 提供）。
 */

/** 某任务最近一次 usage 合并的跟踪状态（跨轮次保持在主进程侧）。 */
export interface TaskUsageTrackedState {
    /** 最近一次参与合并的 message_id。 */
    message_id?: string;
    /**
     * 当前 live 值首次出现时 usage_summary.request_count 的值。
     * 用于判断产生当前 live 值的请求轮次是否已提交进 usage_summary。
     */
    request_count_at_message_start: number;
    /** 上次合并时的 live 归一化值，用于检测同一消息上开启了新的请求轮次。 */
    last_live_total?: { total: number; input: number; output: number };
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

/**
 * 用户通过浮窗关闭菜单设置的「抑制」状态：
 * - dismissed：关闭一次，本次触发周期内不再显示（主窗口回到前台后自动恢复）。
 * - sessionDisabled：选择「下次启动恢复」，本次会话内不再显示（随应用退出重置）。
 */
export interface WidgetSuppressionState {
    dismissed?: boolean;
    sessionDisabled?: boolean;
}

/**
 * 综合触发条件与用户抑制状态，判断浮窗当前是否应当展示。
 * 优先级：session 级抑制 > 本次触发周期抑制 > 常规触发条件。
 */
export function isWidgetTriggerEffective(
    mode: FloatingWindowMode,
    state: WindowVisibilityState,
    suppression: WidgetSuppressionState = {}
): boolean {
    if (suppression.sessionDisabled || suppression.dismissed) {
        return false;
    }
    return computeTriggerActive(mode, state);
}

function toWidgetTask(
    task: TaskStatusListEntry,
    status: TaskStatusWidgetTask['task_status'],
    taskList: readonly TaskStatusListEntry[]
): TaskStatusWidgetTask {
    const taskId = typeof task.task_id === 'string' ? task.task_id : '';
    return {
        task_id: taskId,
        task_name: typeof task.task_name === 'string' && task.task_name.length > 0 ? task.task_name : taskId,
        task_status: status,
        started_at: task.started_at,
        finished_at: task.finished_at,
        subtask_progress: taskId ? computeSubtaskProgress(taskId, taskList) : undefined,
        usage: normalizeTaskUsageWidget(task.usage_summary)
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

function readTokenCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function readRequestCount(summary: TaskUsageSummaryLike | undefined): number {
    return readTokenCount(summary?.request_count) ?? 0;
}

function readSummaryUpdatedAt(summary: TaskUsageSummaryLike | undefined): number {
    return typeof summary?.updated_at === 'string' ? new Date(summary.updated_at).getTime() : NaN;
}

/** 将 usage 规整为浮窗展示值：input/output 优先使用 input_tokens/output_tokens，缺失时回退 prompt/completion（与主界面口径一致）。 */
export function normalizeTaskUsageWidget(value: TaskUsageSummaryLike | undefined): TaskUsageWidget {
    const input = readTokenCount(value?.input_tokens) ?? readTokenCount(value?.prompt_tokens) ?? 0;
    const output = readTokenCount(value?.output_tokens) ?? readTokenCount(value?.completion_tokens) ?? 0;
    const total = readTokenCount(value?.total_tokens) ?? input + output;
    return { total_tokens: total, input_tokens: input, output_tokens: output };
}

function addTaskUsageWidget(left: TaskUsageWidget, right: TaskUsageWidget): TaskUsageWidget {
    return {
        total_tokens: left.total_tokens + right.total_tokens,
        input_tokens: left.input_tokens + right.input_tokens,
        output_tokens: left.output_tokens + right.output_tokens
    };
}

function isSummaryCommitAfterMessage(summary: TaskUsageSummaryLike | undefined, live: TaskLiveUsageSnapshot): boolean {
    const updatedAt = readSummaryUpdatedAt(summary);
    const messageTime = typeof live.message_timestamp === 'number' ? live.message_timestamp : NaN;
    if (!Number.isFinite(updatedAt) || !Number.isFinite(messageTime)) {
        return false;
    }
    return updatedAt >= messageTime;
}

/**
 * 将任务级累计 usage（usage_summary，仅随请求完成叠加，与个人中心的任务统计口径一致）
 * 与当前在途/最后一条 assistant 消息的实时 usage 合并为浮窗展示值。
 *
 * 需要叠加实时 usage 的根本原因：流式过程中 usage_summary 不会变化（provider 通常在
 * 请求结束时才返回 usage），若不叠加，浮窗会停留在上次请求完成时的旧值。
 *
 * 多轮（同一 AssistantMessage 在工具调用循环中复用、usage 被逐轮覆盖）场景下要保持
 * 「累积值」语义，关键是用 live 值是否变化来识别新轮次：
 * - live 值发生变化 → 新请求轮次（在途，尚未提交）：展示 累计 + live；
 * - live 值未变化 → 上一轮的结果（流式中间 provider 不携带 usage 时 live 停留旧值）：
 *   若 request_count 已推进说明该轮已提交进 usage_summary，仅展示累计值，避免重复计数；
 * - 全新消息：若 usage_summary.updated_at 不早于消息创建时间，说明该消息的请求可能已在
 *   浮窗看到该消息之前提交（如快速请求在推送间隙完成），同样仅展示累计值。
 */
export function mergeTaskLiveUsage(
    summary: TaskUsageSummaryLike | undefined,
    live: TaskLiveUsageSnapshot | undefined,
    tracked: TaskUsageTrackedState | undefined
): { usage: TaskUsageWidget; tracked: TaskUsageTrackedState } {
    const base = normalizeTaskUsageWidget(summary);
    const currentRequestCount = readRequestCount(summary);

    if (!live) {
        return {
            usage: base,
            tracked: {
                message_id: tracked?.message_id,
                request_count_at_message_start: currentRequestCount,
                last_live_total: undefined
            }
        };
    }

    const liveWidget = normalizeTaskUsageWidget(live.usage);
    const liveTotal = {
        total: liveWidget.total_tokens,
        input: liveWidget.input_tokens,
        output: liveWidget.output_tokens
    };

    const sameMessage = tracked?.message_id === live.message_id;
    const sameValues =
        sameMessage &&
        tracked?.last_live_total !== undefined &&
        tracked.last_live_total.total === liveTotal.total &&
        tracked.last_live_total.input === liveTotal.input &&
        tracked.last_live_total.output === liveTotal.output;

    if (sameValues) {
        // 同一消息且 live 值未变化：live 是上一轮的结果（可能已提交进 usage_summary）。
        const committed = currentRequestCount > tracked.request_count_at_message_start;
        if (committed) {
            return {
                usage: base,
                tracked: {
                    message_id: live.message_id,
                    request_count_at_message_start: currentRequestCount,
                    last_live_total: tracked.last_live_total
                }
            };
        }
        return {
            usage: addTaskUsageWidget(base, liveWidget),
            tracked: {
                message_id: live.message_id,
                request_count_at_message_start: tracked.request_count_at_message_start,
                last_live_total: tracked.last_live_total
            }
        };
    }

    // 新消息或同一消息上的新请求轮次（live 值变化）：以当前 request_count 为锚，视为在途请求。
    const newTracked: TaskUsageTrackedState = {
        message_id: live.message_id,
        request_count_at_message_start: currentRequestCount,
        last_live_total: liveTotal
    };
    // 仅对「全新消息」应用时间戳启发式：若 usage_summary 的更新时刻不早于消息创建时间，
    // 说明该消息的请求可能在浮窗看到该消息之前已提交，避免重复计数。
    if (!sameMessage && isSummaryCommitAfterMessage(summary, live)) {
        return { usage: base, tracked: newTracked };
    }
    return { usage: addTaskUsageWidget(base, liveWidget), tracked: newTracked };
}
