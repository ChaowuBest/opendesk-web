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

export interface TaskSearchHit {
    taskId: string;
    title: string;
    workspace: string;
    messageId?: string;
    snippet: string;
    priority: number;
}
export interface TaskSearchResponse {
    items: TaskSearchHit[];
    hasMore: boolean;
    indexing: boolean;
    revision: number;
    failedTasks: number;
}
export const TASK_SEARCH_MAX_QUERY = 200;
export const TASK_SEARCH_PAGE_SIZE = 20;
export const TASK_SEARCH_MAX_RESULTS = 200;
export function normalizeSearchText(text: string): string {
    return text.replace(/\s+/gu, ' ').trim().toLowerCase();
}
