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

import { ContextPreparationBlockedError } from './compact-error.js';
import { estimateTextTokens } from './token-estimation.js';
import { IMAGE_TOKEN_ESTIMATE } from './image-tokens.js';

export function estimateRequestPayloadTokens(payload: unknown): number {
    let imageTokens = 0;
    const text = JSON.stringify(payload, (_key, value) => {
        if (value && value.type === 'image_url' && value.image_url) {
            imageTokens += IMAGE_TOKEN_ESTIMATE;
            return { type: 'image' };
        }
        if (value && value.type === 'image' && value.source) {
            imageTokens += IMAGE_TOKEN_ESTIMATE;
            return { type: 'image' };
        }
        return value;
    });
    return estimateTextTokens(text) + imageTokens;
}

export interface CompactionBudget {
    contextWindow: number;
    triggerTokens: number;
    summaryOutputTokens: number;
    bufferTokens: number;
}

export function calculateCompactionBudget(contextWindow: number): CompactionBudget {
    if (!Number.isFinite(contextWindow) || contextWindow < 1) {
        throw new ContextPreparationBlockedError('invalid_budget');
    }
    return {
        contextWindow: Math.floor(contextWindow),
        triggerTokens: Math.floor(contextWindow * 0.8),
        summaryOutputTokens: Math.min(Math.floor(contextWindow * 0.15), 16384),
        bufferTokens: Math.min(Math.floor(contextWindow * 0.05), 10000)
    };
}

export function checkRequestBudget(input: {
    estimatedInputTokens: number;
    requestedOutputTokens: number;
    budget: CompactionBudget;
}) {
    const { estimatedInputTokens, requestedOutputTokens, budget } = input;
    if (
        !Number.isFinite(estimatedInputTokens) ||
        estimatedInputTokens < 0 ||
        !Number.isFinite(requestedOutputTokens) ||
        requestedOutputTokens < 1
    ) {
        throw new ContextPreparationBlockedError('invalid_budget');
    }
    const totalReservedTokens =
        Math.ceil(estimatedInputTokens) + Math.ceil(requestedOutputTokens) + budget.bufferTokens;
    return {
        allowed: totalReservedTokens <= budget.contextWindow,
        totalReservedTokens,
        overflowTokens: Math.max(0, totalReservedTokens - budget.contextWindow)
    };
}

/** The adapter calls this on the final payload, after request hooks and projection. */
export function assertRequestBudget(
    payload: unknown,
    output: number,
    window: number,
    usageEstimate = 0,
    requireBelowTrigger = false
): void {
    const budget = calculateCompactionBudget(window);
    const estimatedInputTokens = Math.max(estimateRequestPayloadTokens(payload), usageEstimate);
    if (requireBelowTrigger && estimatedInputTokens >= budget.triggerTokens) {
        throw new ContextPreparationBlockedError('no_progress', estimatedInputTokens, budget.triggerTokens);
    }
    if (!checkRequestBudget({ estimatedInputTokens, requestedOutputTokens: output, budget }).allowed) {
        throw new ContextPreparationBlockedError('context_limit', estimatedInputTokens, budget.triggerTokens);
    }
}

/** Provider request payload both adapters build for budget fitting: messages plus their own tool options. */
export interface RequestBudgetPayload {
    messages: object[];
    system?: string;
    tools?: object[];
    /** OpenAI sends the tool mode as a plain string, Anthropic wraps it in an object; both only emit 'auto'. */
    tool_choice?: 'auto' | { type: 'auto' };
}

/** Fit business output after hooks and projection; summary requests retain their fixed output budget. */
export function fitRequestOutputTokens(
    payload: RequestBudgetPayload,
    output: number,
    window: number,
    usageEstimate = 0,
    requireBelowTrigger = false
): number {
    const budget = calculateCompactionBudget(window);
    const estimatedInputTokens = Math.max(estimateRequestPayloadTokens(payload), usageEstimate);
    const { allowed } = checkRequestBudget({ estimatedInputTokens, requestedOutputTokens: output, budget });
    if (requireBelowTrigger && estimatedInputTokens >= budget.triggerTokens) {
        throw new ContextPreparationBlockedError('no_progress', estimatedInputTokens, budget.triggerTokens);
    }
    const remaining = budget.contextWindow - Math.ceil(estimatedInputTokens) - budget.bufferTokens;
    if (remaining < 1) {
        throw new ContextPreparationBlockedError('context_limit', estimatedInputTokens, budget.triggerTokens);
    }
    return allowed ? Math.floor(output) : remaining;
}
