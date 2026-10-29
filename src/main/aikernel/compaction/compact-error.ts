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

import type { Usage } from '../messages.js';
import { ModelRequestError } from '../../utils/model-request-error.js';

export interface TextCompletionResult {
    text: string;
    reasoningLength: number;
    finishReason?: string;
    choicesCount?: number;
    usage?: Usage;
    protocolError?: string;
}

export class CompactError extends Error {
    constructor(public readonly code: string) {
        super(code);
        this.name = 'CompactError';
    }
    get retryableEmpty(): boolean {
        return ['empty_choices', 'reasoning_only', 'empty_content'].includes(this.code);
    }
}

export class ContextPreparationBlockedError extends CompactError {
    constructor(
        code: string,
        public readonly inputTokens?: number,
        public readonly threshold?: number
    ) {
        super(code);
        this.name = 'ContextPreparationBlockedError';
    }
}

export function validateCompactSummary(result: TextCompletionResult): string {
    if (
        result.protocolError ||
        typeof result.text !== 'string' ||
        (result.finishReason != null && typeof result.finishReason !== 'string')
    )
        throw new CompactError('protocol_error');
    if (['length', 'max_tokens'].includes(result.finishReason ?? '')) throw new CompactError('output_truncated');
    if (['content_filter', 'refusal', 'tool_calls', 'tool_use'].includes(result.finishReason ?? ''))
        throw new CompactError('protocol_error');
    if (result.text.trim()) return result.text.trim();
    if (result.reasoningLength > 0) throw new CompactError('reasoning_only');
    throw new CompactError(result.choicesCount === 0 ? 'empty_choices' : 'empty_content');
}

export function isContextLimitError(error: unknown): boolean {
    if (error instanceof CompactError) return error.code === 'context_limit';
    const structured =
        error && typeof error === 'object' ? (error as { code?: unknown; error?: { code?: unknown } }) : undefined;
    const metadata = error instanceof ModelRequestError ? error.metadata : undefined;
    const message = [
        structured?.code,
        structured?.error?.code,
        metadata?.code,
        metadata?.detailsCode,
        metadata?.message,
        error instanceof Error ? error.message : String(error)
    ].join(' ');
    return (
        /context[_ -]?(?:length|window|limit).*?(?:exceed|maximum|limit|token)|maximum context length|prompt[_ -](?:is[_ -])?too[_ -]long|context_length_exceeded/i.test(
            message
        ) || /\bexceeds?\s+(?:the\s+)?available\s+context\s+size\b/i.test(message)
    );
}

/** Read only explicitly labelled capacity values, never the rejected request's token count. */
export function extractContextWindowFromError(error: unknown): number | undefined {
    if (!isContextLimitError(error)) return undefined;
    const structured =
        error && typeof error === 'object'
            ? (error as { message?: unknown; error?: { message?: unknown } })
            : undefined;
    const message = [
        error instanceof ModelRequestError ? error.metadata.message : undefined,
        structured?.error?.message,
        structured?.message
    ]
        .filter((value) => typeof value === 'string')
        .join(' ');
    const patterns = [
        /available\s+context\s+size\s*\(\s*([\d,]+)\s*tokens?\s*\)/i,
        /maximum context (?:length|window)(?:\s+(?:is|of))?\s*[:=]?\s*([\d,]+)\s*(?:tokens)?/i,
        /(?:max_model_len|maximum model length)\s*(?:is|of|[:=])\s*([\d,]+)/i,
        /prompt is too long:\s*[\d,]+\s*tokens?\s*>\s*([\d,]+)\s*(?:maximum|tokens?)/i
    ];
    for (const pattern of patterns) {
        const match = message.match(pattern);
        const value = match ? Number(match[1].replace(/,/g, '')) : 0;
        if (Number.isSafeInteger(value) && value > 0) return value;
    }
    return undefined;
}
