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

export type MemoryTimeGroupId = 'recentWeek' | 'recentMonth' | 'older';

export interface MemoryListItem {
    scope: 'workspace' | 'global';
    uid: string;
    title: string;
    content: string;
    heat: number;
    createdAt: string;
    updatedAt: string;
}

export interface MemoryTimeGroup<T extends MemoryListItem> {
    id: MemoryTimeGroupId;
    memories: T[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export function groupMemoriesByUpdatedAt<T extends MemoryListItem>(
    memories: T[],
    now = new Date()
): MemoryTimeGroup<T>[] {
    const groups: Record<MemoryTimeGroupId, T[]> = {
        recentWeek: [],
        recentMonth: [],
        older: []
    };
    const nowMs = now.getTime();

    for (const memory of [...memories].sort(
        (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    )) {
        const updatedAtMs = Date.parse(memory.updatedAt);
        const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, nowMs - updatedAtMs) : Number.POSITIVE_INFINITY;
        if (ageMs <= WEEK_MS) {
            groups.recentWeek.push(memory);
        } else if (ageMs <= MONTH_MS) {
            groups.recentMonth.push(memory);
        } else {
            groups.older.push(memory);
        }
    }

    return (['recentWeek', 'recentMonth', 'older'] as MemoryTimeGroupId[])
        .filter((id) => groups[id].length > 0)
        .map((id) => ({ id, memories: groups[id] }));
}
