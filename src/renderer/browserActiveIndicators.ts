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
 * 侧边栏任务行「浏览器活跃」绿球图标的状态维护。
 *
 * 图标由 task-artifacts 派发的 browser-visibility-changed 事件驱动。但事件可能丢失
 * （task-view 被回收、页面重建、任务在浏览器 tab 打开时被停止后再没切走），
 * 结果任务早已结束、图标仍在闪烁。这里提供一道时间兜底：
 * 任务进入终态后超过保有期仍未收到新的活跃确认，就丢弃该状态。
 */

/** 任务结束后「浏览器活跃」图标的最长保有期。 */
export const BROWSER_ACTIVE_ICON_TTL_MS = 5 * 60 * 1000;

/** 兜底扫描间隔。 */
export const BROWSER_ACTIVE_ICON_PRUNE_INTERVAL_MS = 60 * 1000;

export interface BrowserActiveIconTask {
    task_id?: string;
    task_status?: string;
    finished_at?: string;
    updated_at?: string;
}

export interface BrowserActivePruneResult {
    /** 本次被丢弃的任务 id。 */
    removed: string[];
}

function parseTime(value?: string): number {
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 按时间兜底清理浏览器活跃记录。
 *
 * 计时起点取「最后活跃时间」与「任务结束时间」中较晚的一个：
 * - 运行中的任务只续期，不清理（后台浏览器自动化可能仍在使用面板里的 webview）；
 * - 已结束（或已从列表消失）的任务，结束满 ttl 后丢弃。
 *
 * 传入的 activeAt 会被原地更新（续期 / 删除）。
 */
export function pruneBrowserActiveTasks(
    activeAt: Map<string, number>,
    tasks: readonly BrowserActiveIconTask[],
    now: number,
    ttl: number = BROWSER_ACTIVE_ICON_TTL_MS
): BrowserActivePruneResult {
    if (activeAt.size === 0) return { removed: [] };

    const byId = new Map<string, BrowserActiveIconTask>();
    for (const task of tasks) {
        if (task && typeof task.task_id === 'string' && task.task_id) {
            byId.set(task.task_id, task);
        }
    }

    const removed: string[] = [];
    for (const taskId of [...activeAt.keys()]) {
        const task = byId.get(taskId);
        if (task && task.task_status === 'running') {
            activeAt.set(taskId, now);
            continue;
        }
        const finishedAt = Math.max(parseTime(task?.finished_at), parseTime(task?.updated_at));
        const since = Math.max(activeAt.get(taskId) ?? 0, finishedAt);
        if (now - since >= ttl) {
            activeAt.delete(taskId);
            removed.push(taskId);
        }
    }
    return { removed };
}
