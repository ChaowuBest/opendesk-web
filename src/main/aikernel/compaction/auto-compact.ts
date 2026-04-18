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

import { AssistantMessage, ChatContext } from '../messages.js';
import { Setting, type ModelInstance } from '../../utils/setting.js';
import { fetchContextSizeFromAPI, lookupKnownContextSize } from '../../utils/model-context.js';

export type AutoCompactDecisionReason =
    | 'missing_prompt_tokens'
    | 'unknown_context_window'
    | 'below_threshold'
    | 'at_or_above_threshold';

export interface AutoCompactDecisionInput {
    contextWindow: number;
    promptTokens?: number;
    reservedSummaryOutput?: number;
    buffer?: number;
}

export interface AutoCompactDecision {
    shouldCompact: boolean;
    reason: AutoCompactDecisionReason;
    promptTokens?: number;
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

export const DEFAULT_AUTO_COMPACT_FAILURE_THRESHOLD = 3;
export const DEFAULT_AUTO_COMPACT_COOLDOWN_MS = 10 * 60 * 1000;

export interface AutoCompactState {
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

    return {
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

function toDateOrUndefined(value: unknown): Date | undefined {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    }
    return undefined;
}

function buildCooldownUntil(now: Date, cooldownMs: number): string {
    return new Date(now.getTime() + Math.max(Math.floor(cooldownMs), 0)).toISOString();
}

function getLastPromptTokens(chatContext: ChatContext): number | undefined {
    for (let i = chatContext.messages.length - 1; i >= 0; i--) {
        const message = chatContext.messages[i];
        if (message instanceof AssistantMessage && message.usage) {
            return normalizeOptionalNonNegativeNumber(message.usage.prompt_tokens);
        }
    }
    return undefined;
}

async function resolveContextWindow(model?: string): Promise<number> {
    try {
        let modelInstance: ModelInstance | null;
        if (typeof model === 'string') {
            modelInstance = Setting.getInstance().getModelInstance(model);
            if (!modelInstance) {
                return 0;
            }
        } else {
            modelInstance = Setting.getInstance().getDefaultModelInstance();
            if (!modelInstance) {
                return 0;
            }
        }

        const knownSize = lookupKnownContextSize(modelInstance.model_name);
        if (knownSize > 0) {
            return knownSize;
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
    const reservedSummaryOutput = normalizeNonNegativeNumber(input.reservedSummaryOutput, 0);
    const effectiveWindow = Math.max(contextWindow - reservedSummaryOutput, 0);
    const buffer = normalizeNonNegativeNumber(input.buffer ?? effectiveWindow * 0.2, 0);
    const autoCompactThreshold = Math.max(effectiveWindow - buffer, 0);
    const promptTokens = normalizeOptionalNonNegativeNumber(input.promptTokens);

    if (promptTokens === undefined) {
        return {
            shouldCompact: false,
            reason: 'missing_prompt_tokens',
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
            promptTokens,
            contextWindow,
            reservedSummaryOutput,
            effectiveWindow,
            buffer,
            autoCompactThreshold,
            windowUsageRatio: undefined,
            marginTokens: undefined
        };
    }

    const shouldCompact = promptTokens >= autoCompactThreshold;
    return {
        shouldCompact,
        reason: shouldCompact ? 'at_or_above_threshold' : 'below_threshold',
        promptTokens,
        contextWindow,
        reservedSummaryOutput,
        effectiveWindow,
        buffer,
        autoCompactThreshold,
        windowUsageRatio: contextWindow > 0 ? promptTokens / contextWindow : undefined,
        marginTokens: autoCompactThreshold - promptTokens
    };
}

/**
 * 根据当前上下文和模型解析自动压缩决策。
 */
export async function getAutoCompactDecision(
    chatContext: ChatContext,
    model?: string,
    options: AutoCompactDecisionOptions = {}
): Promise<AutoCompactDecision> {
    const promptTokens = getLastPromptTokens(chatContext);
    const contextWindow = await resolveContextWindow(model);

    return createAutoCompactDecision({
        contextWindow,
        promptTokens,
        reservedSummaryOutput: options.reservedSummaryOutput,
        buffer: options.buffer
    });
}

export class AutoCompactStates {
    static create(): AutoCompactState {
        return createDefaultAutoCompactState();
    }

    static clone(state: AutoCompactState): AutoCompactState {
        return normalizeAutoCompactState(state);
    }

    static deserialize(raw: unknown): AutoCompactState {
        return normalizeAutoCompactState(raw);
    }

    static serialize(state: AutoCompactState): SerializedAutoCompactState {
        const normalized = normalizeAutoCompactState(state);
        return {
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
            consecutiveFailures: nextFailures,
            lastAttemptAt: timestamp,
            lastFailureAt: timestamp,
            cooldownUntil: hasReachedThreshold ? buildCooldownUntil(at, normalized.cooldownMs) : undefined,
            lastFailureReason: typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : undefined
        };
    }

    static recordSuccess(state: AutoCompactState, at: Date = new Date()): AutoCompactState {
        const normalized = normalizeAutoCompactState(state);
        return {
            ...normalized,
            consecutiveFailures: 0,
            lastAttemptAt: at.toISOString(),
            lastSuccessAt: at.toISOString(),
            cooldownUntil: undefined,
            lastFailureReason: undefined
        };
    }

    static isCoolingDown(state: AutoCompactState, at: Date = new Date()): boolean {
        return this.getCooldownRemainingMs(state, at) > 0;
    }

    static getCooldownRemainingMs(state: AutoCompactState, at: Date = new Date()): number {
        const normalized = normalizeAutoCompactState(state);
        const cooldownUntil = toDateOrUndefined(normalized.cooldownUntil);
        if (!cooldownUntil) {
            return 0;
        }

        const remaining = cooldownUntil.getTime() - at.getTime();
        return remaining > 0 ? remaining : 0;
    }

    static hasReachedFailureThreshold(state: AutoCompactState): boolean {
        const normalized = normalizeAutoCompactState(state);
        return normalized.consecutiveFailures >= normalized.failureThreshold;
    }
}
