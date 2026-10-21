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

import { createHash } from 'node:crypto';
import type { ModelInstance } from '../../utils/setting.js';
import type { UsageFields } from '../messages.js';
import { CompactError, extractContextWindowFromError, isContextLimitError } from './compact-error.js';
import { normalizeUsage } from './token-estimation.js';

interface RuntimeContextBudget {
    lastSuccessfulTokens?: number;
    contextWindow?: number;
}

/** Deployment-specific evidence lives only for this process; it never changes model configuration. */
export class ModelContextBudgets {
    private static states = new Map<string, RuntimeContextBudget>();

    private static key(model: ModelInstance): string {
        const credentials = createHash('sha256')
            .update(
                JSON.stringify([
                    model.api_key,
                    Object.entries(model.custom_headers ?? {}).sort(([left], [right]) => left.localeCompare(right))
                ])
            )
            .digest('hex');
        return JSON.stringify([
            model.provider_type,
            model.provider_name,
            model.base_url.replace(/\/+$/, ''),
            model.model_name,
            credentials
        ]);
    }

    static getLearnedWindow(model: ModelInstance): number | undefined {
        return this.states.get(this.key(model))?.contextWindow;
    }

    static getLastSuccessfulTokens(model: ModelInstance): number | undefined {
        return this.states.get(this.key(model))?.lastSuccessfulTokens;
    }

    static recordSuccess(model: ModelInstance, usage?: UsageFields): void {
        const normalized = normalizeUsage(usage);
        if (
            !normalized ||
            (normalized.total_tokens === undefined &&
                normalized.prompt_tokens === undefined &&
                normalized.input_tokens === undefined)
        )
            return;
        // OpenAI may expose completion_tokens with split input fields; Anthropic's total can omit cache input.
        const inputTokens =
            normalized.input_tokens !== undefined
                ? normalized.input_tokens +
                  (normalized.cache_creation_input_tokens ?? 0) +
                  (normalized.cache_read_input_tokens ?? 0)
                : normalized.prompt_tokens;
        const tokens =
            inputTokens !== undefined
                ? inputTokens + (normalized.output_tokens ?? normalized.completion_tokens ?? 0)
                : normalized.total_tokens;
        if (
            inputTokens === undefined &&
            tokens !== undefined &&
            tokens <= (normalized.output_tokens ?? normalized.completion_tokens ?? 0)
        )
            return;
        if (tokens === undefined || !Number.isSafeInteger(tokens) || tokens < 1) return;
        const key = this.key(model);
        this.states.set(key, { ...this.states.get(key), lastSuccessfulTokens: tokens });
    }

    static learnFromOverflow(model: ModelInstance, error: unknown): number | undefined {
        // Local budget checks and unrelated transport failures provide no new capacity evidence.
        if (model.context_length || error instanceof CompactError || !isContextLimitError(error)) return undefined;
        const key = this.key(model);
        const state = this.states.get(key);
        const candidate = extractContextWindowFromError(error) ?? state?.lastSuccessfulTokens;
        if (candidate === undefined) return undefined;
        const contextWindow = state?.contextWindow ? Math.min(state.contextWindow, candidate) : candidate;
        this.states.set(key, { ...state, contextWindow });
        return contextWindow;
    }

    static clear(): void {
        this.states.clear();
    }
}
