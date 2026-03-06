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


export type MemoryScope = 'global' | 'workspace';

export type MemoryCategory =
    | 'user_preference'
    | 'important_fact'
    | 'key_decision'
    | 'useful_context'
    | string;

export const MEMORY_CATEGORY_LABELS: Record<string, string> = {
    'user_preference': '用户偏好',
    'important_fact': '重要事实',
    'key_decision': '关键决策',
    'useful_context': '有用上下文',
};

export interface MemoryMeta {
    uid: string;
    name: string;
    created_at: string;
    updated_at: string;
    keywords: string[];
    summary: string;
    category: MemoryCategory;
    source_task_id?: string;
}

export interface MemoryIndex {
    version: number;
    memories: MemoryMeta[];
}

export function createEmptyIndex(): MemoryIndex {
    return { version: 1, memories: [] };
}
