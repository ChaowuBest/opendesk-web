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

import type { ChatMessage, ToolCallMessagePart } from '../messages.js';

export interface ToolCallDetail {
    args_string: string;
    result?: string;
    rendered?: string;
    status: 'pending' | 'running' | 'success' | 'error';
    elapsedSeconds?: number;
}

interface ToolCallDetailTask {
    chat_context: {
        messages: ChatMessage[];
    };
}

export function findToolCallDetail(
    task: ToolCallDetailTask,
    messageId: string,
    partIndex: number,
    toolIndex: number,
    toolCallId?: string
): ToolCallDetail | undefined {
    const message = task.chat_context.messages.find((candidate) => candidate.message_id === messageId);
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return undefined;

    const part = message.content[partIndex] as ToolCallMessagePart | undefined;
    if (!part || part.type !== 'tool_call' || !Array.isArray(part.toolcalls)) return undefined;

    const toolCall = part.toolcalls[toolIndex];
    if (!toolCall || (toolCallId && toolCall.id !== toolCallId)) return undefined;
    return {
        args_string: typeof toolCall.args_string === 'string' ? toolCall.args_string : '',
        result: toolCall.result,
        rendered: toolCall.rendered,
        status: toolCall.status,
        elapsedSeconds: toolCall.elapsedSeconds
    };
}
