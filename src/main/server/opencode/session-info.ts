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

interface TaskLifecycleDates {
    created_at?: unknown;
    started_at?: unknown;
    finished_at?: unknown;
    updated_at?: unknown;
}

function toTimestamp(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    const timestamp = value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * OpenCode sorts sessions by time.updated, so both values must be derived from
 * persisted task lifecycle fields. A wall-clock fallback would make an
 * untouched historical task look newly updated every time sessions are listed.
 */
export function getOpenCodeSessionTime(task: TaskLifecycleDates): { created: number; updated: number } {
    const created =
        toTimestamp(task.created_at) ??
        toTimestamp(task.started_at) ??
        toTimestamp(task.updated_at) ??
        toTimestamp(task.finished_at) ??
        0;
    const updated =
        toTimestamp(task.updated_at) ?? toTimestamp(task.started_at) ?? toTimestamp(task.finished_at) ?? created;
    return { created, updated };
}
