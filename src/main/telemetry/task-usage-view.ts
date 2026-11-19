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

import {
    getUsageDashboardSummary,
    getUsageRankings,
    type RankPeriod,
    type UsageTaskRankItem
} from './local-telemetry.js';

export interface TaskUsageViewTask {
    created_at: Date;
    task_name?: string | null;
    internal?: boolean;
}

export interface TaskUsageViewDependencies {
    listTasks(): readonly TaskUsageViewTask[];
    getTask(taskId: string): TaskUsageViewTask | null | undefined;
    isDeveloperMode(): boolean;
    isTaskVisible(task: TaskUsageViewTask, developerMode: boolean): boolean;
    now?(): Date;
    readDashboard?: typeof getUsageDashboardSummary;
    readRankings?: typeof getUsageRankings;
}

export interface TaskUsageViewOptions {
    rankPeriod?: RankPeriod;
}

function startOfLocalDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function createTaskUsageViewService(dependencies: TaskUsageViewDependencies) {
    const readDashboard = dependencies.readDashboard ?? getUsageDashboardSummary;
    const readRankings = dependencies.readRankings ?? getUsageRankings;

    const projectTaskRankings = (items: UsageTaskRankItem[]): UsageTaskRankItem[] => {
        const developerMode = dependencies.isDeveloperMode();
        const projected: UsageTaskRankItem[] = [];
        for (const item of items) {
            const task = dependencies.getTask(item.task_id);
            if (!task || !dependencies.isTaskVisible(task, developerMode)) {
                continue;
            }
            projected.push({ ...item, task_name: task.task_name || item.task_name });
            if (projected.length >= 10) {
                break;
            }
        }
        return projected;
    };

    return {
        async getDashboardSummary(options: TaskUsageViewOptions = {}) {
            const now = dependencies.now?.() ?? new Date();
            const summary = await readDashboard({ rankLimit: 30, now, rankPeriod: options.rankPeriod });
            const todayStart = startOfLocalDay(now);
            const tomorrowStart = new Date(todayStart.getTime());
            // Local calendar days may contain 23 or 25 hours across DST transitions.
            tomorrowStart.setDate(tomorrowStart.getDate() + 1);
            const weekStart = new Date(todayStart.getTime());
            weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
            const tasks = dependencies.listTasks();
            const countBetween = (start: Date, end: Date): number =>
                tasks.filter((task) => task.created_at >= start && task.created_at < end).length;

            return {
                ...summary,
                today: { ...summary.today, task_count: countBetween(todayStart, tomorrowStart) },
                week: { ...summary.week, task_count: countBetween(weekStart, tomorrowStart) },
                month_top_tasks: projectTaskRankings(summary.month_top_tasks)
            };
        },

        async getRankings(options: TaskUsageViewOptions = {}) {
            const rankings = await readRankings(options.rankPeriod ?? 'month', 30);
            return { ...rankings, tasks: projectTaskRankings(rankings.tasks) };
        }
    };
}
