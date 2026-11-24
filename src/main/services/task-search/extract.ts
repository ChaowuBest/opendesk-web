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

import { compactSearchText, TASK_SEARCH_MAX_QUERY, TASK_SEARCH_MAX_WILDCARD_GAP } from '../../../common/task-search.js';
import {
    getGoalSupplementDisplayText,
    shouldRenderGoalUserMessage,
    type GoalUserMessageDisplayLike
} from '../../../common/goal/user-message-display.js';

const CHUNK_LENGTH = 4000;
// Wildcards can match characters that occupy two UTF-16 units each.
const CHUNK_OVERLAP = 2 * (TASK_SEARCH_MAX_QUERY + TASK_SEARCH_MAX_WILDCARD_GAP);

export interface SearchDocument {
    key: string;
    messageId: string;
    text: string;
    priority: number;
}
interface Message extends GoalUserMessageDisplayLike {
    role?: string;
    message_id?: string;
    internal?: boolean;
    content?: { type?: string; text?: string }[];
}
export interface SearchTask {
    task_id: string;
    task_name?: string;
    workspace?: string;
    internal?: boolean;
    name_pending?: boolean;
    updated_at?: string;
    created_at?: string;
    finished_at?: string;
    chat_context?: { messages?: Message[] };
}
export function isSearchableTask(task: SearchTask): boolean {
    return task.internal !== true && Boolean(task.task_name?.trim() || task.name_pending);
}
export function extractSearchDocuments(task: SearchTask): SearchDocument[] {
    if (!isSearchableTask(task)) return [];
    const docs: SearchDocument[] = [];
    const add = (key: string, text: string, messageId: string, priority: number) => {
        const compact = compactSearchText(text, true);
        for (let start = 0; start < compact.length; start += CHUNK_LENGTH - CHUNK_OVERLAP) {
            docs.push({
                key: key + ':' + start,
                messageId,
                priority,
                text: compact.slice(start, start + CHUNK_LENGTH)
            });
        }
    };
    add('title', task.task_name || '', '', 2);
    add('workspace', task.workspace || '', '', 1);
    for (const message of task.chat_context?.messages || []) {
        if (!message.message_id || (message.role !== 'user' && message.role !== 'assistant')) continue;
        if (message.role === 'user' && !shouldRenderGoalUserMessage(message)) continue;
        if (message.role === 'assistant' && message.internal === true) continue;
        const supplement = message.role === 'user' ? getGoalSupplementDisplayText(message) : undefined;
        const text =
            supplement ??
            (message.content || [])
                .filter((part) => part.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text)
                .join('\n');
        add('message:' + message.message_id, text, message.message_id, 0);
    }
    return docs;
}
