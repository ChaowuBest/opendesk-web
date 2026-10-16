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
    getGoalSupplementDisplayText,
    shouldRenderGoalUserMessage,
    type GoalUserMessageDisplayLike
} from '../../../common/goal/user-message-display.js';

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
        const compact = text.replace(/\s+/gu, ' ').trim();
        // Overlap covers the maximum query length, including a hit spanning two chunks.
        for (let start = 0; start < compact.length; start += 3800) {
            docs.push({ key: key + ':' + start, messageId, priority, text: compact.slice(start, start + 4000) });
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
