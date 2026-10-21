/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { calculateCompactionBudget } from './request-budget.js';
import { ChatContext } from '../messages.js';
import { Setting, type ModelInstance } from '../../utils/setting.js';
import {
    fetchContextSizeFromAPI,
    lookupKnownContextSize,
    lookupKnownMaxOutputTokens
} from '../../utils/model-context.js';
import { buildActiveContextView } from './context-view.js';
import { ModelContextBudgets } from './model-context-budget.js';
import {
    estimateVisibleContextTokens,
    type TokenEstimateSource,
    type VisibleContextTokenEstimate,
    type VisibleContextTokenEstimationInput
} from './token-estimation.js';

export type AutoCompactDecisionReason =
    'missing_context_tokens' | 'unknown_context_window' | 'below_threshold' | 'at_or_above_threshold';

export interface AutoCompactDecisionInput {
    contextWindow: number;
    estimatedContextTokens?: number;
    /** @deprecated Compatibility alias for tests still using the old name. */
    promptTokens?: number;
    baseUsageTokens?: number;
    tailEstimatedTokens?: number;
    assistantInternalTailTokens?: number;
    tokenEstimateSource?: TokenEstimateSource;
    reservedSummaryOutput?: number;
    buffer?: number;
}

export interface AutoCompactDecision {
    shouldCompact: boolean;
    reason: AutoCompactDecisionReason;
    estimatedContextTokens?: number;
    baseUsageTokens: number;
    tailEstimatedTokens: number;
    assistantInternalTailTokens: number;
    tokenEstimateSource?: TokenEstimateSource;
    contextWindow: number;
    reservedSummaryOutput: number;
    effectiveWindow: number;
    buffer: number;
    autoCompactThreshold: number;
    windowUsageRatio?: number;
    marginTokens?: number;
}

export interface AutoCompactDecisionOptions {
    reservedSummaryOutput?: number;
    buffer?: number;
}

export const DEFAULT_AUTO_COMPACT_RESERVED_SUMMARY_OUTPUT = 16_384;
export const DEFAULT_AUTO_COMPACT_BUFFER = 10_000;
export const MAX_RESERVED_SUMMARY_OUTPUT = 16_384;
export const DEFAULT_AUTO_COMPACT_FAILURE_THRESHOLD = 3;
export const DEFAULT_AUTO_COMPACT_COOLDOWN_MS = 10 * 60 * 1000;

export type CompactStatus = 'healthy' | 'compacting' | 'degraded' | 'circuit_open' | 'half_open';

export interface AutoCompactState {
    status?: CompactStatus;
    consecutiveFailures: number;
    lastAttemptAt?: string;
    lastFailureAt?: string;
    lastSuccessAt?: string;
    cooldownUntil?: string;
    failureThreshold: number;
    cooldownMs: number;
    lastFailureReason?: string;
}

export interface SerializedAutoCompactState {
    status?: CompactStatus;
    consecutive_failures: number;
    last_attempt_at?: string;
    last_failure_at?: string;
    last_success_at?: string;
    cooldown_until?: string;
    failure_threshold: number;
    cooldown_ms: number;
    last_failure_reason?: string;
}

function normalizeNonNegativeNumber(value: unknown, fallback = 0): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(value, 0);
}

function normalizeOptionalNonNegativeNumber(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
    }
    return Math.max(value, 0);
}

function normalizeNonNegativeInteger(value: unknown, fallback = 0): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(Math.floor(value), 0);
}

function normalizeOptionalTimestamp(value: unknown): string | undefined {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
    }

    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return undefined;
    }

    return parsed.toISOString();
}

function createDefaultAutoCompactState(): AutoCompactState {
    return {
        status: 'healthy',
        consecutiveFailures: 0,
        failureThreshold: DEFAULT_AUTO_COMPACT_FAILURE_THRESHOLD,
        cooldownMs: DEFAULT_AUTO_COMPACT_COOLDOWN_MS
    };
}

function normalizeAutoCompactState(raw: unknown): AutoCompactState {
    const defaults = createDefaultAutoCompactState();
    if (!raw || typeof raw !== 'object') {
        return { ...defaults };
    }

    const candidate = raw as {
        status?: CompactStatus;
        consecutive_failures?: unknown;
        consecutiveFailures?: unknown;
        last_attempt_at?: unknown;
        lastAttemptAt?: unknown;
        last_failure_at?: unknown;
        lastFailureAt?: unknown;
        last_success_at?: unknown;
        lastSuccessAt?: unknown;
        cooldown_until?: unknown;
        cooldownUntil?: unknown;
        failure_threshold?: unknown;
        failureThreshold?: unknown;
        cooldown_ms?: unknown;
        cooldownMs?: unknown;
        last_failure_reason?: unknown;
        lastFailureReason?: unknown;
    };

    const failureThreshold = Math.max(
        normalizeNonNegativeInteger(
            candidate.failure_threshold ?? candidate.failureThreshold,
            defaults.failureThreshold
        ),
        1
    );

    const failures = normalizeNonNegativeInteger(candidate.consecutive_failures ?? candidate.consecutiveFailures);
    return {
        status:
            candidate.status ?? (failures >= failureThreshold ? 'circuit_open' : failures > 0 ? 'degraded' : 'healthy'),
        consecutiveFailures: normalizeNonNegativeInteger(
            candidate.consecutive_failures ?? candidate.consecutiveFailures,
            defaults.consecutiveFailures
        ),
        lastAttemptAt: normalizeOptionalTimestamp(candidate.last_attempt_at ?? candidate.lastAttemptAt),
        lastFailureAt: normalizeOptionalTimestamp(candidate.last_failure_at ?? candidate.lastFailureAt),
        lastSuccessAt: normalizeOptionalTimestamp(candidate.last_success_at ?? candidate.lastSuccessAt),
        cooldownUntil: normalizeOptionalTimestamp(candidate.cooldown_until ?? candidate.cooldownUntil),
        failureThreshold,
        cooldownMs: normalizeNonNegativeInteger(candidate.cooldown_ms ?? candidate.cooldownMs, defaults.cooldownMs),
        lastFailureReason:
            typeof candidate.last_failure_reason === 'string' && candidate.last_failure_reason.trim().length > 0
                ? candidate.last_failure_reason.trim()
                : typeof candidate.lastFailureReason === 'string' && candidate.lastFailureReason.trim().length > 0
                  ? candidate.lastFailureReason.trim()
                  : undefined
    };
}

function isChatContext(value: unknown): value is ChatContext {
    return value instanceof ChatContext;
}

function normalizeTokenEstimateSource(value: unknown): TokenEstimateSource | undefined {
    return value === 'usage_plus_tail_estimate' || value === 'rough_estimate_only' ? value : undefined;
}

function buildTokenEstimateInput(
    input: ChatContext | VisibleContextTokenEstimationInput
): VisibleContextTokenEstimationInput {
    if (isChatContext(input)) {
        return {
            activeContext: buildActiveContextView(input),
            systemPrompt: input.system_prompt
        };
    }
    return input;
}

export async function resolveMaxOutputTokens(model?: string): Promise<number> {
    try {
        let modelInstance: ModelInstance | null;
        if (typeof model === 'string') {
            modelInstance = Setting.getInstance().getModelInstance(model, 'chat');
            if (!modelInstance) {
                return lookupKnownMaxOutputTokens(model);
            }
        } else {
            modelInstance = Setting.getInstance().getDefaultModelInstance();
            if (!modelInstance) {
                return 0;
            }
        }

        // 用户配置优先
        if (modelInstance.max_output_tokens && modelInstance.max_output_tokens > 0) {
            return modelInstance.max_output_tokens;
        }

        const knownMaxOutput = lookupKnownMaxOutputTokens(modelInstance.model_name);
        if (knownMaxOutput > 0) {
            return knownMaxOutput;
        }

        if (typeof model === 'string') {
            const fallbackKnownMaxOutput = lookupKnownMaxOutputTokens(model);
            if (fallbackKnownMaxOutput > 0) {
                return fallbackKnownMaxOutput;
            }
        }

        // Match the adapters' default for models with no configured/known output budget.
        return 16384;
    } catch {
        return 0;
    }
}

export function limitSummaryOutputToModel(model: string | undefined, requested: number): number {
    const settings = Setting.getInstance();
    const instance = model ? settings.getModelInstance(model, 'chat') : settings.getDefaultModelInstance();
    const supported = instance?.max_output_tokens ?? lookupKnownMaxOutputTokens(instance?.model_name ?? model ?? '');
    return supported > 0 ? Math.min(requested, supported) : requested;
}

export async function resolveReservedSummaryOutput(model?: string, override?: number): Promise<number> {
    if (override !== undefined) {
        return normalizeNonNegativeNumber(override, DEFAULT_AUTO_COMPACT_RESERVED_SUMMARY_OUTPUT);
    }

    const window = await resolveContextWindow(model);
    return limitSummaryOutputToModel(
        model,
        window > 0
            ? calculateCompactionBudget(window).summaryOutputTokens
            : DEFAULT_AUTO_COMPACT_RESERVED_SUMMARY_OUTPUT
    );
}

export async function resolveContextWindow(model?: string): Promise<number> {
    try {
        let modelInstance: ModelInstance | null;
        if (typeof model === 'string') {
            modelInstance = Setting.getInstance().getModelInstance(model, 'chat');
            if (!modelInstance) {
                return lookupKnownContextSize(model);
            }
        } else {
            modelInstance = Setting.getInstance().getDefaultModelInstance();
            if (!modelInstance) {
                return 0;
            }
        }

        if (modelInstance.context_length && modelInstance.context_length > 0) {
            return modelInstance.context_length;
        }

        const learnedWindow = ModelContextBudgets.getLearnedWindow(modelInstance);
        if (learnedWindow !== undefined) return learnedWindow;

        const knownSize = lookupKnownContextSize(modelInstance.model_name);
        if (knownSize > 0) {
            return knownSize;
        }

        if (typeof model === 'string') {
            const fallbackKnownSize = lookupKnownContextSize(model);
            if (fallbackKnownSize > 0) {
                return fallbackKnownSize;
            }
        }

        return await fetchContextSizeFromAPI(modelInstance);
    } catch {
        return 0;
    }
}

/**
 * 纯策略层：仅根据输入数字计算是否需要自动压缩，不读取上下文或模型配置。
 */
export function createAutoCompactDecision(input: AutoCompactDecisionInput): AutoCompactDecision {
    const contextWindow = normalizeNonNegativeNumber(input.contextWindow, 0);
    const reservedSummaryOutput = normalizeNonNegativeNumber(
        input.reservedSummaryOutput,
        Math.min(Math.floor(contextWindow * 0.15), MAX_RESERVED_SUMMARY_OUTPUT)
    );
    const effectiveWindow = Math.max(contextWindow - reservedSummaryOutput, 0);
    const buffer = normalizeNonNegativeNumber(
        input.buffer ?? Math.min(Math.floor(contextWindow * 0.05), DEFAULT_AUTO_COMPACT_BUFFER),
        0
    );
    const autoCompactThreshold = Math.floor(contextWindow * 0.8);
    const estimatedContextTokens = normalizeOptionalNonNegativeNumber(
        input.estimatedContextTokens ?? input.promptTokens
    );
    const baseUsageTokens = normalizeNonNegativeNumber(input.baseUsageTokens, 0);
    const tailEstimatedTokens = normalizeNonNegativeNumber(input.tailEstimatedTokens, 0);
    const assistantInternalTailTokens = normalizeNonNegativeNumber(input.assistantInternalTailTokens, 0);
    const tokenEstimateSource = normalizeTokenEstimateSource(input.tokenEstimateSource);

    if (estimatedContextTokens === undefined) {
        return {
            shouldCompact: false,
            reason: 'missing_context_tokens',
            baseUsageTokens,
            tailEstimatedTokens,
            assistantInternalTailTokens,
            tokenEstimateSource,
            contextWindow,
            reservedSummaryOutput,
            effectiveWindow,
            buffer,
            autoCompactThreshold
        };
    }

    if (contextWindow <= 0) {
        return {
            shouldCompact: false,
            reason: 'unknown_context_window',
            estimatedContextTokens,
            baseUsageTokens,
            tailEstimatedTokens,
            assistantInternalTailTokens,
            tokenEstimateSource,
            contextWindow,
            reservedSummaryOutput,
            effectiveWindow,
            buffer,
            autoCompactThreshold,
            windowUsageRatio: undefined,
            marginTokens: undefined
        };
    }

    const shouldCompact = estimatedContextTokens >= autoCompactThreshold;
    return {
        shouldCompact,
        reason: shouldCompact ? 'at_or_above_threshold' : 'below_threshold',
        estimatedContextTokens,
        baseUsageTokens,
        tailEstimatedTokens,
        assistantInternalTailTokens,
        tokenEstimateSource,
        contextWindow,
        reservedSummaryOutput,
        effectiveWindow,
        buffer,
        autoCompactThreshold,
        windowUsageRatio: contextWindow > 0 ? estimatedContextTokens / contextWindow : undefined,
        marginTokens: autoCompactThreshold - estimatedContextTokens
    };
}

/**
 * 根据当前上下文和模型解析自动压缩决策。
 */
export async function getAutoCompactDecision(
    contextInput: ChatContext | VisibleContextTokenEstimationInput,
    model?: string,
    options: AutoCompactDecisionOptions = {}
): Promise<AutoCompactDecision> {
    const tokenEstimate = estimateVisibleContextTokens({ ...buildTokenEstimateInput(contextInput), model });
    const contextWindow = await resolveContextWindow(model);

    return createAutoCompactDecision({
        contextWindow,
        estimatedContextTokens: tokenEstimate.estimatedContextTokens,
        baseUsageTokens: tokenEstimate.baseUsageTokens,
        tailEstimatedTokens: tokenEstimate.tailEstimatedTokens,
        assistantInternalTailTokens: tokenEstimate.assistantInternalTailTokens,
        tokenEstimateSource: tokenEstimate.source,
        reservedSummaryOutput: options.reservedSummaryOutput,
        buffer: options.buffer
    });
}

export function estimateAutoCompactContextTokens(
    input: ChatContext | VisibleContextTokenEstimationInput,
    model?: string
): VisibleContextTokenEstimate {
    return estimateVisibleContextTokens({ ...buildTokenEstimateInput(input), ...(model ? { model } : {}) });
}

export class AutoCompactStates {
    static create(): AutoCompactState {
        return createDefaultAutoCompactState();
    }

    static clone(state: AutoCompactState): AutoCompactState {
        return normalizeAutoCompactState(state);
    }

    static deserialize(raw: unknown): AutoCompactState {
        const state = normalizeAutoCompactState(raw);
        if (state.status === 'compacting') {
            state.status = state.consecutiveFailures >= state.failureThreshold ? 'circuit_open' : 'degraded';
        }
        return state;
    }

    static serialize(state: AutoCompactState): SerializedAutoCompactState {
        const normalized = normalizeAutoCompactState(state);
        return {
            status: normalized.status,
            consecutive_failures: normalized.consecutiveFailures,
            last_attempt_at: normalized.lastAttemptAt,
            last_failure_at: normalized.lastFailureAt,
            last_success_at: normalized.lastSuccessAt,
            cooldown_until: normalized.cooldownUntil,
            failure_threshold: normalized.failureThreshold,
            cooldown_ms: normalized.cooldownMs,
            last_failure_reason: normalized.lastFailureReason
        };
    }

    static recordAttempt(state: AutoCompactState, at: Date = new Date()): AutoCompactState {
        const normalized = normalizeAutoCompactState(state);
        const timestamp = at.toISOString();
        return {
            ...normalized,
            status: normalized.status === 'half_open' ? 'half_open' : 'compacting',
            lastAttemptAt: timestamp
        };
    }

    static recordFailure(state: AutoCompactState, at: Date = new Date(), reason?: string): AutoCompactState {
        const normalized = normalizeAutoCompactState(state);
        const timestamp = at.toISOString();
        const nextFailures = normalized.consecutiveFailures + 1;
        const hasReachedThreshold = nextFailures >= normalized.failureThreshold;

        return {
            ...normalized,
            status: hasReachedThreshold ? 'circuit_open' : 'degraded',
            consecutiveFailures: nextFailures,
            lastAttemptAt: timestamp,
            lastFailureAt: timestamp,
            cooldownUntil: hasReachedThreshold
                ? new Date(at.getTime() + normalized.cooldownMs).toISOString()
                : undefined,
            lastFailureReason: typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : undefined
        };
    }

    static recordSuccess(state: AutoCompactState, at: Date = new Date()): AutoCompactState {
        const normalized = normalizeAutoCompactState(state);
        return {
            ...normalized,
            status: 'healthy',
            consecutiveFailures: 0,
            lastAttemptAt: at.toISOString(),
            lastSuccessAt: at.toISOString(),
            cooldownUntil: undefined,
            lastFailureReason: undefined
        };
    }

    static beginRecovery(state: AutoCompactState): AutoCompactState {
        const normalized = this.clone(state);
        return { ...normalized, status: normalized.status === 'circuit_open' ? 'half_open' : normalized.status };
    }

    static canAttempt(state: AutoCompactState, at: Date = new Date()): boolean {
        const normalized = this.clone(state);
        if (normalized.status !== 'circuit_open') return true;
        if (!normalized.cooldownUntil) return false;
        return new Date(normalized.cooldownUntil).getTime() <= at.getTime();
    }

    static isCoolingDown(state: AutoCompactState, at: Date = new Date()): boolean {
        return !this.canAttempt(state, at);
    }

    static getCooldownRemainingMs(state: AutoCompactState, at: Date = new Date()): number {
        const normalized = this.clone(state);
        if (this.canAttempt(normalized, at)) return 0;
        if (!normalized.cooldownUntil) return Number.POSITIVE_INFINITY;
        return Math.max(0, new Date(normalized.cooldownUntil).getTime() - at.getTime());
    }

    static hasReachedFailureThreshold(state: AutoCompactState): boolean {
        const normalized = normalizeAutoCompactState(state);
        return normalized.consecutiveFailures >= normalized.failureThreshold;
    }
}
