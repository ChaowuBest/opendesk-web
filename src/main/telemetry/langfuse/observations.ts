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

import crypto from 'crypto';
import { TraceFlags, type SpanContext } from '@opentelemetry/api';
import {
    startObservation,
    type LangfuseGeneration,
    type LangfuseSpan,
    type LangfuseTool,
    type ObservationLevel
} from '@langfuse/tracing';
import { logger } from '../../utils/logger.js';
import type { ToolCall } from '../../aikernel/messages.js';
import { flushLangfuseTelemetry, getActiveLangfuseConfig } from './init.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface ActiveTaskTurnTrace {
    traceId: string;
    originalTraceId?: string;
    turnId: string;
    turnObservationId: string;
    turnObservation: LangfuseSpan;
    turnInput: JsonValue;
    turnMetadata: Record<string, unknown>;
    currentStreamTextObservation?: LangfuseSpan;
    currentDoStreamObservation?: LangfuseSpan;
    lastDoStreamObservation?: LangfuseSpan;
    lastGenerationObservation?: LangfuseGeneration;
    taskId: string;
    workspace?: string;
    recordGenerations: boolean;
    environment?: string;
    maxPayloadChars: number;
}

export interface StartLangfuseTaskTurnInput {
    taskId: string;
    turnId: string;
    workspace?: string;
    traceId?: string;
    input?: unknown;
    model?: unknown;
    recordGenerations?: boolean;
    metadata?: Record<string, unknown>;
}

export interface FinishLangfuseTaskTurnInput {
    output?: unknown;
    statusMessage?: string;
    level?: ObservationLevel;
    metadata?: Record<string, unknown>;
}

export interface LangfuseTaskTurnHandle {
    taskId: string;
    turnId: string;
    traceId: string;
    observationId: string;
}

interface GenerationObservationInput {
    input?: unknown;
    output?: unknown;
    usage?: unknown;
    model?: unknown;
    metadata?: Record<string, unknown>;
}

interface LlmRequestObservationInput extends GenerationObservationInput {
    level?: ObservationLevel;
    statusMessage?: string;
}

interface LlmRequestObservationHandle {
    taskId: string;
    turnId: string;
    traceId: string;
    streamTextObservationId: string;
    doStreamObservationId: string;
    context: ActiveTaskTurnTrace;
    streamTextObservation: LangfuseSpan;
    doStreamObservation: LangfuseSpan;
    finished: boolean;
}

const activeTaskTurns = new Map<string, ActiveTaskTurnTrace>();

function scheduleFlush(): void {
    void flushLangfuseTelemetry();
}

function newObservationId(): string {
    return crypto.randomBytes(8).toString('hex');
}

function limitString(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
        return value;
    }
    return `${value.slice(0, maxChars)}\n\n[truncated by OpenDesk Langfuse telemetry]`;
}

function toJsonSafe(value: unknown, maxChars: number, seen = new WeakSet<object>()): JsonValue {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string') {
        return limitString(value, maxChars);
    }
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
        return null;
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) {
            return '[Circular]';
        }
        seen.add(value);
        const result = value.map((item) => toJsonSafe(item, maxChars, seen));
        seen.delete(value);
        return result;
    }

    if (typeof value === 'object') {
        if (seen.has(value)) {
            return '[Circular]';
        }
        seen.add(value);
        const result: { [key: string]: JsonValue } = {};
        for (const [key, item] of Object.entries(value)) {
            result[key] = toJsonSafe(item, maxChars, seen);
        }
        seen.delete(value);
        return result;
    }

    return limitString(String(value), maxChars);
}

function metadataObject(value: unknown, maxChars: number): Record<string, unknown> {
    const safe = toJsonSafe(value, maxChars);
    if (!safe || typeof safe !== 'object' || Array.isArray(safe)) {
        return {};
    }
    return safe;
}

function parseJsonMaybe(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function numberOrUndefined(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(Math.floor(value), 0);
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return Math.max(Math.floor(parsed), 0);
        }
    }
    return undefined;
}

function normalizeUsageDetails(usage: unknown):
    | {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
      }
    | undefined {
    if (!usage || typeof usage !== 'object') {
        return undefined;
    }
    const source = usage as Record<string, unknown>;
    const promptTokens = numberOrUndefined(
        source.promptTokens ?? source.prompt_tokens ?? source.input ?? source.input_tokens
    );
    const completionTokens = numberOrUndefined(
        source.completionTokens ?? source.completion_tokens ?? source.output ?? source.output_tokens
    );
    const totalTokens =
        numberOrUndefined(source.totalTokens ?? source.total_tokens ?? source.total) ??
        (promptTokens !== undefined || completionTokens !== undefined
            ? (promptTokens ?? 0) + (completionTokens ?? 0)
            : undefined);
    const cacheReadInputTokens = numberOrUndefined(
        source.cacheReadInputTokens ?? source.cache_read_input_tokens ?? source.cacheRead
    );
    const cacheCreationInputTokens = numberOrUndefined(
        source.cacheCreationInputTokens ?? source.cache_creation_input_tokens ?? source.cacheWrite
    );

    if (
        promptTokens === undefined &&
        completionTokens === undefined &&
        totalTokens === undefined &&
        cacheReadInputTokens === undefined &&
        cacheCreationInputTokens === undefined
    ) {
        return undefined;
    }
    return {
        promptTokens,
        completionTokens,
        totalTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens
    };
}

function withUsageMetadata(metadata: unknown, usage: unknown, maxChars: number): Record<string, unknown> | undefined {
    const result = metadataObject(metadata, maxChars);
    const usageDetails = normalizeUsageDetails(usage);
    if (usageDetails) {
        result.usageDetails = usageDetails;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function modelName(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function errorToMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function normalizeOtelTraceId(traceId: string | undefined): { traceId?: string; originalTraceId?: string } {
    const originalTraceId = traceId?.trim();
    if (!originalTraceId) {
        return {};
    }
    const lower = originalTraceId.toLowerCase();
    if (/^[0-9a-f]{32}$/.test(lower) && !/^0+$/.test(lower)) {
        return { traceId: lower, originalTraceId };
    }
    return {
        traceId: crypto.createHash('sha256').update(originalTraceId).digest('hex').slice(0, 32),
        originalTraceId
    };
}

function parentSpanContextFromTraceId(traceId: string | undefined): SpanContext | undefined {
    if (!traceId) {
        return undefined;
    }
    return {
        traceId,
        spanId: newObservationId(),
        traceFlags: TraceFlags.SAMPLED
    };
}

function mergeMetadata(
    maxPayloadChars: number,
    base: Record<string, unknown>,
    extra?: Record<string, unknown>
): Record<string, unknown> {
    return metadataObject({ ...base, ...extra }, maxPayloadChars);
}

export function startTaskTurn(input: StartLangfuseTaskTurnInput): LangfuseTaskTurnHandle | undefined {
    try {
        const config = getActiveLangfuseConfig();
        if (!config?.enabled) {
            return undefined;
        }

        const previousTurn = activeTaskTurns.get(input.taskId);
        if (previousTurn) {
            finishTaskTurn(
                {
                    taskId: previousTurn.taskId,
                    turnId: previousTurn.turnId,
                    traceId: previousTurn.traceId,
                    observationId: previousTurn.turnObservationId
                },
                {
                    level: 'WARNING',
                    statusMessage: 'Superseded by a newer task turn'
                }
            );
        }

        const normalizedTrace = normalizeOtelTraceId(input.traceId);
        const metadata = mergeMetadata(
            config.maxPayloadChars,
            {
                component: 'aikernel.task',
                taskId: input.taskId,
                turnId: input.turnId,
                workspace: input.workspace,
                model: input.model,
                originalTraceId: normalizedTrace.originalTraceId
            },
            input.metadata
        );
        const turnInput = toJsonSafe(input.input, config.maxPayloadChars);
        const turnObservation = startObservation(
            'task.turn',
            {
                input: turnInput,
                metadata,
                environment: config.environment
            },
            {
                parentSpanContext: parentSpanContextFromTraceId(normalizedTrace.traceId)
            }
        );
        turnObservation.setTraceIO({ input: turnInput });

        const context: ActiveTaskTurnTrace = {
            traceId: turnObservation.traceId,
            originalTraceId: normalizedTrace.originalTraceId,
            turnId: input.turnId,
            turnObservationId: turnObservation.id,
            turnObservation,
            turnInput,
            turnMetadata: metadata,
            taskId: input.taskId,
            workspace: input.workspace,
            recordGenerations: input.recordGenerations !== false,
            environment: config.environment,
            maxPayloadChars: config.maxPayloadChars
        };
        activeTaskTurns.set(input.taskId, context);
        return {
            taskId: input.taskId,
            turnId: input.turnId,
            traceId: context.traceId,
            observationId: context.turnObservationId
        };
    } catch (err) {
        logger.warn(`Langfuse task turn start failed: ${errorToMessage(err)}`);
        return undefined;
    }
}

export function finishTaskTurn(
    handle: LangfuseTaskTurnHandle | undefined,
    input: FinishLangfuseTaskTurnInput = {}
): void {
    if (!handle) {
        return;
    }
    const context = activeTaskTurns.get(handle.taskId);
    if (!context || context.turnId !== handle.turnId) {
        return;
    }
    activeTaskTurns.delete(handle.taskId);

    try {
        const output = toJsonSafe(input.output, context.maxPayloadChars);
        const metadata = input.metadata
            ? mergeMetadata(context.maxPayloadChars, context.turnMetadata, input.metadata)
            : context.turnMetadata;
        context.turnObservation.update({
            output,
            level: input.level ?? 'DEFAULT',
            statusMessage: input.statusMessage,
            metadata
        });
        context.turnObservation.setTraceIO({ input: context.turnInput, output });
        context.turnObservation.end();
        scheduleFlush();
    } catch (err) {
        logger.warn(`Langfuse task turn finish failed: ${errorToMessage(err)}`);
    }
}

export function failTaskTurn(handle: LangfuseTaskTurnHandle | undefined, error: unknown): void {
    const message = errorToMessage(error);
    finishTaskTurn(handle, {
        output: message,
        level: 'ERROR',
        statusMessage: message
    });
}

export function startLlmRequest(
    taskId: string,
    input: LlmRequestObservationInput = {}
): LlmRequestObservationHandle | undefined {
    try {
        const context = activeTaskTurns.get(taskId);
        if (!context) {
            return undefined;
        }

        const metadata = mergeMetadata(
            context.maxPayloadChars,
            {
                component: 'aikernel.task.completion',
                taskId,
                turnId: context.turnId,
                model: input.model,
                originalTraceId: context.originalTraceId
            },
            input.metadata
        );
        const streamTextObservation = context.turnObservation.startObservation('session.llm.ai.streamText', {
            input: toJsonSafe(input.input, context.maxPayloadChars),
            metadata,
            environment: context.environment
        });
        const doStreamObservation = streamTextObservation.startObservation('session.llm.ai.streamText.doStream', {
            input: toJsonSafe(input.input, context.maxPayloadChars),
            metadata,
            environment: context.environment
        });

        context.currentStreamTextObservation = streamTextObservation;
        context.currentDoStreamObservation = doStreamObservation;
        context.lastDoStreamObservation = doStreamObservation;

        return {
            taskId,
            turnId: context.turnId,
            traceId: context.traceId,
            streamTextObservationId: streamTextObservation.id,
            doStreamObservationId: doStreamObservation.id,
            context,
            streamTextObservation,
            doStreamObservation,
            finished: false
        };
    } catch (err) {
        logger.warn(`Langfuse LLM observation start failed: ${errorToMessage(err)}`);
        return undefined;
    }
}

export function finishLlmRequest(
    handle: LlmRequestObservationHandle | undefined,
    input: LlmRequestObservationInput = {}
): void {
    if (!handle || handle.finished) {
        return;
    }
    handle.finished = true;
    const { context, streamTextObservation, doStreamObservation } = handle;

    try {
        const output = toJsonSafe(input.output, context.maxPayloadChars);
        const metadata = withUsageMetadata(input.metadata, input.usage, context.maxPayloadChars);
        const level = input.level ?? 'DEFAULT';
        doStreamObservation.update({
            output,
            level,
            statusMessage: input.statusMessage,
            metadata
        });
        doStreamObservation.end();
        streamTextObservation.update({
            output,
            level,
            statusMessage: input.statusMessage,
            metadata
        });
        streamTextObservation.end();
    } catch (err) {
        logger.warn(`Langfuse LLM observation finish failed: ${errorToMessage(err)}`);
    } finally {
        if (context.currentStreamTextObservation === streamTextObservation) {
            delete context.currentStreamTextObservation;
        }
        if (context.currentDoStreamObservation === doStreamObservation) {
            delete context.currentDoStreamObservation;
        }
    }
}

export function recordGeneration(
    handle: LlmRequestObservationHandle | undefined,
    input: GenerationObservationInput
): void {
    if (!handle || !handle.context.recordGenerations) {
        return;
    }
    const { context } = handle;

    try {
        const parentObservation = handle.doStreamObservation;
        const generation = parentObservation.startObservation(
            'LLM.__call',
            {
                input: toJsonSafe(input.input, context.maxPayloadChars),
                output: toJsonSafe(input.output, context.maxPayloadChars),
                model: modelName(input.model),
                usageDetails: normalizeUsageDetails(input.usage),
                metadata: metadataObject(input.metadata, context.maxPayloadChars),
                environment: context.environment
            },
            { asType: 'generation' }
        );
        generation.end();
        context.lastGenerationObservation = generation;
    } catch (err) {
        logger.warn(`Langfuse generation observation failed: ${errorToMessage(err)}`);
    }
}

export function recordTool(task: { task_id?: string; turn_id?: string }, toolCall: ToolCall): void {
    const taskId = task.task_id;
    if (!taskId) {
        return;
    }

    const context = activeTaskTurns.get(taskId);
    if (!context || (task.turn_id !== undefined && task.turn_id !== context.turnId)) {
        return;
    }

    try {
        const rawToolName = toolCall.tool_name || 'tool';
        const isSkill = rawToolName === 'skill-manager-LoadSkill' || rawToolName === 'skill';
        const observationName = isSkill ? 'skill' : rawToolName;
        const args = toolCall.args_object ?? parseJsonMaybe(toolCall.args_string);
        const resultObject = (toolCall as ToolCall & { result_object?: unknown }).result_object;
        const parentObservation =
            context.lastDoStreamObservation ?? context.lastGenerationObservation ?? context.turnObservation;
        const toolObservation: LangfuseTool = parentObservation.startObservation(
            observationName,
            {
                input: toJsonSafe(args, context.maxPayloadChars),
                output: toJsonSafe(toolCall.result ?? resultObject ?? '', context.maxPayloadChars),
                level: toolCall.status === 'error' ? 'ERROR' : 'DEFAULT',
                statusMessage: toolCall.status === 'error' ? String(toolCall.result ?? '') : undefined,
                metadata: metadataObject(
                    {
                        originalToolName: rawToolName,
                        toolCallId: toolCall.id,
                        status: toolCall.status
                    },
                    context.maxPayloadChars
                ),
                environment: context.environment
            },
            { asType: 'tool' }
        );
        toolObservation.end();
    } catch (err) {
        logger.warn(`Langfuse tool observation failed: ${errorToMessage(err)}`);
    }
}
