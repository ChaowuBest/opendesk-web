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

import type { ChatMessage, ToolCallMessagePart } from '../main/aikernel/messages.js';

export const TOOL_CALL_DETAIL_RESULT_MAX_BYTES = 24 * 1024;
export const TOOL_CALL_DETAIL_RENDERED_MAX_BYTES = 8 * 1024;

type ToolCallDetailField = 'result' | 'rendered';

export interface ToolCallDetail {
    result?: string;
    rendered?: string;
    status: 'pending' | 'running' | 'success' | 'error';
    truncation?: Partial<Record<ToolCallDetailField, { originalBytes: number }>>;
}

interface ToolCallDetailTask {
    chat_context: {
        messages: ChatMessage[];
    };
}

function utf8Prefix(value: string, maxBytes: number): string {
    let low = 0;
    let high = value.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    const lastCodeUnit = value.charCodeAt(low - 1);
    const end = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? low - 1 : low;
    return value.slice(0, Math.max(0, end));
}

function utf8Suffix(value: string, maxBytes: number): string {
    let low = 0;
    let high = value.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (Buffer.byteLength(value.slice(middle), 'utf8') > maxBytes) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    const firstCodeUnit = value.charCodeAt(low);
    const start = firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff ? low + 1 : low;
    return value.slice(start);
}

function truncateUtf8Middle(value: string, maxBytes: number): string {
    const separator = '\n...\n';
    const contentBytes = Math.max(0, maxBytes - Buffer.byteLength(separator, 'utf8'));
    const prefixBytes = Math.ceil(contentBytes / 2);
    const suffixBytes = contentBytes - prefixBytes;
    return `${utf8Prefix(value, prefixBytes)}${separator}${utf8Suffix(value, suffixBytes)}`;
}

function boundTextField(
    value: unknown,
    maxBytes: number,
    mode: 'truncate' | 'omit'
): { value?: string; originalBytes?: number } {
    if (typeof value !== 'string') return {};
    const originalBytes = Buffer.byteLength(value, 'utf8');
    if (originalBytes <= maxBytes) return { value };
    return {
        value: mode === 'truncate' ? truncateUtf8Middle(value, maxBytes) : undefined,
        originalBytes
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

    const result = boundTextField(toolCall.result, TOOL_CALL_DETAIL_RESULT_MAX_BYTES, 'truncate');
    const presentation = toolCall.getPresentation();
    const rendered = boundTextField(
        presentation.detailMode === 'custom' ? toolCall.rendered : undefined,
        TOOL_CALL_DETAIL_RENDERED_MAX_BYTES,
        'omit'
    );
    const truncation: ToolCallDetail['truncation'] = {};
    if (result.originalBytes !== undefined) truncation.result = { originalBytes: result.originalBytes };
    if (rendered.originalBytes !== undefined) truncation.rendered = { originalBytes: rendered.originalBytes };

    return {
        ...(result.value !== undefined ? { result: result.value } : {}),
        ...(rendered.value !== undefined ? { rendered: rendered.value } : {}),
        status: toolCall.status,
        ...(Object.keys(truncation).length > 0 ? { truncation } : {})
    };
}
