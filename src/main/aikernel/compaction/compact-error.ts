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
    return /context[_ -]?(?:length|window|limit).*?(?:exceed|maximum|limit|token)|maximum context length|prompt[_ -](?:is[_ -])?too[_ -]long|context_length_exceeded/i.test(
        message
    );
}
