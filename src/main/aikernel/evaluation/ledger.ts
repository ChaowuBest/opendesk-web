/**
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { Usage, type UsageFields } from '../messages.js';
import type {
    BenchmarkUsageReport,
    BenchmarkUsageRequestRecord,
    BenchmarkUsageRequestType,
    BenchmarkUsageSummary,
    BenchmarkUsageTaskReport,
    BenchmarkUsageTaskSummary
} from './types.js';

interface BeginBenchmarkRequestInput {
    turn: number;
    requestType: BenchmarkUsageRequestType;
    model?: string;
    provider?: string;
    startMs?: number;
}

interface FinishBenchmarkRequestInput {
    usage?: unknown;
    endMs?: number;
}

interface BuildTaskSummaryInput {
    taskStatus: string;
    stopRequestedByUser: boolean;
    startedAt: Date;
    finishedAt: Date;
    totalElapsedMs?: number;
}

function normalizeUsageFields(rawUsage: unknown): UsageFields | undefined {
    const usage = Usage.fromRaw(rawUsage);
    if (!usage) {
        return undefined;
    }

    return {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens
    };
}

function cloneUsageFields(usage: UsageFields | undefined): UsageFields | undefined {
    if (!usage) {
        return undefined;
    }

    return {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens
    };
}

function resolveInputTokenCount(usage: UsageFields | undefined): number {
    return usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
}

function resolveOutputTokenCount(usage: UsageFields | undefined): number {
    return usage?.output_tokens ?? usage?.completion_tokens ?? 0;
}

function resolveTotalTokenCount(usage: UsageFields | undefined): number {
    if (usage?.total_tokens !== undefined) {
        return usage.total_tokens;
    }

    return resolveInputTokenCount(usage) + resolveOutputTokenCount(usage);
}

function sumResolvedUsageField(
    records: BenchmarkUsageRequestRecord[],
    resolver: (usage: UsageFields | undefined) => number
): number {
    return records.reduce((total, record) => total + resolver(record.usage), 0);
}

function normalizeRecord(taskId: string, rawRecord: unknown): BenchmarkUsageRequestRecord | undefined {
    if (rawRecord === undefined || rawRecord === null || typeof rawRecord !== 'object') {
        return undefined;
    }

    const candidate = rawRecord as Partial<BenchmarkUsageRequestRecord> & Record<string, unknown>;
    const requestIndex =
        typeof candidate.request_index === 'number' &&
        Number.isFinite(candidate.request_index) &&
        candidate.request_index > 0
            ? Math.floor(candidate.request_index)
            : undefined;
    const turn =
        typeof candidate.turn === 'number' && Number.isFinite(candidate.turn) && candidate.turn >= 0
            ? Math.floor(candidate.turn)
            : undefined;
    const startMs =
        typeof candidate.start_ms === 'number' && Number.isFinite(candidate.start_ms)
            ? Math.floor(candidate.start_ms)
            : undefined;
    const endMs =
        typeof candidate.end_ms === 'number' && Number.isFinite(candidate.end_ms)
            ? Math.floor(candidate.end_ms)
            : undefined;
    const durationMs =
        typeof candidate.duration_ms === 'number' && Number.isFinite(candidate.duration_ms)
            ? Math.floor(candidate.duration_ms)
            : undefined;

    if (requestIndex === undefined || turn === undefined || startMs === undefined) {
        return undefined;
    }

    const retryReasons = Array.isArray(candidate.retry_reasons)
        ? candidate.retry_reasons.filter((reason): reason is string => typeof reason === 'string' && reason.length > 0)
        : [];
    const usage = normalizeUsageFields(candidate.usage);
    const retryCount =
        typeof candidate.retry_count === 'number' && Number.isFinite(candidate.retry_count)
            ? Math.max(0, Math.floor(candidate.retry_count))
            : retryReasons.length;

    return {
        request_index: requestIndex,
        task_id: typeof candidate.task_id === 'string' && candidate.task_id.length > 0 ? candidate.task_id : taskId,
        turn,
        request_type:
            candidate.request_type === 'complete' || candidate.request_type === 'streamComplete'
                ? candidate.request_type
                : 'streamComplete',
        model: typeof candidate.model === 'string' && candidate.model.length > 0 ? candidate.model : undefined,
        provider:
            typeof candidate.provider === 'string' && candidate.provider.length > 0 ? candidate.provider : undefined,
        start_ms: startMs,
        end_ms: endMs ?? startMs,
        duration_ms: durationMs ?? Math.max((endMs ?? startMs) - startMs, 0),
        retry_count: retryCount,
        retry_reason:
            typeof candidate.retry_reason === 'string' && candidate.retry_reason.length > 0
                ? candidate.retry_reason
                : retryReasons[retryReasons.length - 1],
        retry_reasons: retryReasons,
        usage_present: candidate.usage_present === true || usage !== undefined,
        usage
    };
}

function sumUsageField(records: BenchmarkUsageRequestRecord[], field: keyof Required<UsageFields>): number {
    return records.reduce((total, record) => total + (record.usage?.[field] ?? 0), 0);
}

export class BenchmarkUsageLedger {
    readonly taskId: string;
    private requests: BenchmarkUsageRequestRecord[] = [];

    constructor(taskId: string, requests: BenchmarkUsageRequestRecord[] = []) {
        this.taskId = taskId;
        this.requests = requests.map((request) => ({
            ...request,
            usage: cloneUsageFields(request.usage),
            retry_reasons: [...request.retry_reasons]
        }));
    }

    static deserialize(raw: unknown, taskId: string): BenchmarkUsageLedger | undefined {
        if (raw === undefined || raw === null) {
            return undefined;
        }

        let candidateRequests: unknown[] | undefined;
        if (Array.isArray(raw)) {
            candidateRequests = raw;
        } else if (typeof raw === 'object') {
            const candidate = raw as Record<string, unknown>;
            if (Array.isArray(candidate.requests)) {
                candidateRequests = candidate.requests;
            } else if (Array.isArray(candidate.records)) {
                candidateRequests = candidate.records;
            }
        }

        if (!candidateRequests) {
            return undefined;
        }

        const requests = candidateRequests
            .map((entry) => normalizeRecord(taskId, entry))
            .filter((entry): entry is BenchmarkUsageRequestRecord => entry !== undefined);

        if (requests.length === 0) {
            return undefined;
        }

        return new BenchmarkUsageLedger(taskId, requests);
    }

    beginRequest(input: BeginBenchmarkRequestInput): number {
        const requestIndex = this.requests.length + 1;
        const startMs = input.startMs ?? Date.now();

        this.requests.push({
            request_index: requestIndex,
            task_id: this.taskId,
            turn: Math.max(0, Math.floor(input.turn)),
            request_type: input.requestType,
            model: input.model,
            provider: input.provider,
            start_ms: startMs,
            end_ms: startMs,
            duration_ms: 0,
            retry_count: 0,
            retry_reasons: [],
            usage_present: false
        });

        return requestIndex;
    }

    recordRetry(requestIndex: number, reason: unknown): void {
        const record = this.requests[requestIndex - 1];
        if (!record) {
            return;
        }

        record.retry_count++;
        const retryReason = reason instanceof Error ? reason.message : String(reason);
        if (retryReason.length > 0) {
            record.retry_reasons.push(retryReason);
            record.retry_reason = retryReason;
        }
    }

    finishRequest(requestIndex: number, input: FinishBenchmarkRequestInput = {}): void {
        const record = this.requests[requestIndex - 1];
        if (!record) {
            return;
        }

        const endMs = input.endMs ?? Date.now();
        record.end_ms = endMs;
        record.duration_ms = Math.max(endMs - record.start_ms, 0);

        const usage = normalizeUsageFields(input.usage);
        if (usage) {
            record.usage_present = true;
            record.usage = usage;
        }
    }

    get requestCount(): number {
        return this.requests.length;
    }

    get retryCount(): number {
        return this.requests.reduce((total, record) => total + record.retry_count, 0);
    }

    get turnCount(): number {
        return new Set(this.requests.map((record) => record.turn)).size;
    }

    get usagePresentCount(): number {
        return this.requests.filter((record) => record.usage_present).length;
    }

    get missingUsageCount(): number {
        return this.requestCount - this.usagePresentCount;
    }

    getRequests(): BenchmarkUsageRequestRecord[] {
        return this.requests.map((request) => ({
            ...request,
            usage: cloneUsageFields(request.usage),
            retry_reasons: [...request.retry_reasons]
        }));
    }

    getSummary(): BenchmarkUsageSummary {
        const requestCount = this.requestCount;
        const usagePresentCount = this.usagePresentCount;
        const missingUsageCount = this.missingUsageCount;
        const inputTokens = sumResolvedUsageField(this.requests, resolveInputTokenCount);
        const outputTokens = sumResolvedUsageField(this.requests, resolveOutputTokenCount);
        const totalTokens = sumResolvedUsageField(this.requests, resolveTotalTokenCount);
        const cacheCreationInputTokens = sumUsageField(this.requests, 'cache_creation_input_tokens');
        const cacheReadInputTokens = sumUsageField(this.requests, 'cache_read_input_tokens');
        return {
            request_count: requestCount,
            retry_count: this.retryCount,
            usage_present_count: usagePresentCount,
            missing_usage_count: missingUsageCount,
            usage_coverage: requestCount > 0 ? usagePresentCount / requestCount : 0,
            missing_usage_rate: requestCount > 0 ? missingUsageCount / requestCount : 0,
            prompt_tokens: sumUsageField(this.requests, 'prompt_tokens'),
            completion_tokens: sumUsageField(this.requests, 'completion_tokens'),
            total_tokens: totalTokens,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: cacheCreationInputTokens,
            cache_read_input_tokens: cacheReadInputTokens,
            cached_token_ratio: inputTokens > 0 ? cacheReadInputTokens / inputTokens : 0
        };
    }

    getTaskSummary(input: BuildTaskSummaryInput): BenchmarkUsageTaskSummary {
        const summary = this.getSummary();
        const wallClockMs = Math.max(input.finishedAt.getTime() - input.startedAt.getTime(), 0);
        const totalElapsedMs = input.totalElapsedMs && input.totalElapsedMs > 0 ? input.totalElapsedMs : wallClockMs;

        return {
            task_status: input.taskStatus,
            task_success: input.taskStatus === 'stopped' && !input.stopRequestedByUser,
            stop_requested_by_user: input.stopRequestedByUser,
            started_at: input.startedAt.toISOString(),
            finished_at: input.finishedAt.toISOString(),
            wall_clock_ms: wallClockMs,
            total_elapsed_ms: totalElapsedMs,
            request_count: summary.request_count,
            retry_count: summary.retry_count,
            turn_count: this.turnCount,
            prompt_tokens: summary.prompt_tokens,
            completion_tokens: summary.completion_tokens,
            total_tokens: summary.total_tokens,
            input_tokens: summary.input_tokens,
            output_tokens: summary.output_tokens,
            cache_creation_input_tokens: summary.cache_creation_input_tokens,
            cache_read_input_tokens: summary.cache_read_input_tokens,
            cached_token_ratio: summary.cached_token_ratio
        };
    }

    toJSON(): BenchmarkUsageReport {
        return {
            version: 1,
            task_id: this.taskId,
            generated_at: new Date().toISOString(),
            requests: this.requests.map((request) => ({
                ...request,
                usage: cloneUsageFields(request.usage),
                retry_reasons: [...request.retry_reasons]
            })),
            summary: this.getSummary()
        };
    }

    toStorageJSON(taskSummary?: BenchmarkUsageTaskSummary): BenchmarkUsageTaskReport {
        return {
            version: 1,
            task_id: this.taskId,
            generated_at: new Date().toISOString(),
            ...(taskSummary ? { task_summary: taskSummary } : {})
        };
    }
}
