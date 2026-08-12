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

import { prepareContextForModel } from '../compaction/pipeline.js';
import { estimateTextTokens } from '../compaction/token-estimation.js';
import {
    describeActiveContextVariant,
    describeCompactPlanVariant,
    logCompactInfo
} from '../compaction/compact-trace.js';
import { LLM, type LLMRequestOptions } from '../llm.js';
import { Setting } from '../../utils/setting.js';
import {
    lookupKnownContextSize,
    lookupKnownMaxOutputTokens,
    fetchContextSizeFromAPI
} from '../../utils/model-context.js';
import { logger } from '../../utils/logger.js';
import {
    getEvidenceCardPreviewOptions,
    getEvidenceCardSettings,
    recordEvidenceCardLLMUsage
} from '../../utils/evidencecard.js';
import {
    AssistantMessage,
    AssistantMessagePart,
    ToolCall,
    AssistantResponse,
    type RuntimeMetadata
} from '../messages.js';
import type { ActiveContextView } from '../compaction/types.js';
import {
    collectToolCalls,
    chunkIntroducesNewToolCall,
    finalizeToolCallArgs,
    removeToolCallsFrom,
    resolveStreamingToolCallsForTask
} from '../task/tool-resolver.js';
import type { TaskState } from '../states/tasks.js';
import {
    getLLMRetryDelayMs,
    errorToMessage,
    type TaskUpdateRetryChunk,
    type TaskModelRequestOptions
} from './types.js';
import { AgentExecutionInstrumentationRegistry } from '../../telemetry/agent-execution.js';

function getAssistantResponseError(response: AssistantResponse): Error | undefined {
    if (response.finish_reason !== 'error') {
        return undefined;
    }

    const errorPart = response.content.content.find((part) => part.type === 'error');
    if (errorPart?.type === 'error') {
        return new Error(errorPart.message || errorPart.title || 'LLM request failed');
    }
    return new Error('LLM request failed');
}

/**
 * 当前任务是否正处在 LLM 自动重试的等待窗口内。
 */
export function isLLMRetryDelayPendingForTask(task: TaskState): boolean {
    return task._retryDelayPending && task.task_status === 'running';
}

/**
 * 跳过 LLM 重试的等待时间，立即发起下一次重试。
 * 从 GUI "立即重试" 按钮或 TUI /retry 命令触发。
 */
export function skipRetryDelayForTask(task: TaskState): boolean {
    if (task._retryNowResolver) {
        logger.info(`task ${task.task_id}: user requested immediate retry`);
        task._retryNowResolver();
        task._retryNowResolver = null;
        return true;
    }
    return false;
}

export function findRebasedPartIndex(
    beforeTypes: Array<AssistantMessagePart['type']>,
    afterParts: AssistantMessagePart[]
): number {
    const length = Math.min(beforeTypes.length, afterParts.length);
    for (let i = 0; i < length; i++) {
        if (beforeTypes[i] !== afterParts[i].type) {
            return i;
        }
    }
    return -1;
}

export async function sendRetryFeedbackForTask(
    task: TaskState,
    update: Omit<TaskUpdateRetryChunk, 'type' | 'task_id' | 'task_status'>
) {
    task.retainAvailableTaskUpdateSubscribers('retry feedback');
    if (task.subscribers.length === 0) return;

    const chunkUpdate: TaskUpdateRetryChunk = {
        type: 'retry',
        task_id: task.task_id,
        task_status: task.task_status,
        ...update
    };

    task.publishTaskUpdate(chunkUpdate, 'retry feedback');
}

export async function waitForLLMRetryDelayForTask(
    task: TaskState,
    attempt: number,
    delayMs: number,
    error: unknown,
    expectedGeneration: number = task.getTurnGeneration()
): Promise<boolean> {
    const nextRetryAt = Date.now() + delayMs;
    const errorMessage = errorToMessage(error);
    task._retryDelayPending = true;
    const emitScheduled = () =>
        sendRetryFeedbackForTask(task, {
            attempt,
            delay_ms: delayMs,
            next_retry_at: nextRetryAt,
            error_message: errorMessage,
            status: 'scheduled'
        });

    let cancelWait = () => {};
    const waitPromise = new Promise<boolean>((resolve) => {
        let settled = false;
        let interval: ReturnType<typeof setInterval> = undefined as any;
        let timeout: ReturnType<typeof setTimeout> = undefined as any;
        const retryNowResolver = () => settle(true);
        const cleanup = () => {
            clearInterval(interval);
            clearTimeout(timeout);
            if (task._retryNowResolver === retryNowResolver) {
                task._retryDelayPending = false;
                task._retryNowResolver = null;
            }
        };
        const settle = (value: boolean) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };
        cancelWait = () => settle(false);
        task._retryNowResolver = retryNowResolver;
        const tick = () => {
            if (task._retryNowResolver !== retryNowResolver) {
                settle(false);
                return;
            }
            if (
                task.task_status === 'stopped' ||
                task.getTurnGeneration() !== expectedGeneration ||
                !task._retryDelayPending
            ) {
                void clearLLMRetryFeedbackForTask(task, attempt, delayMs, nextRetryAt, errorMessage).finally(() =>
                    settle(false)
                );
                return;
            }
            void emitScheduled();
        };
        interval = setInterval(tick, 1000);
        timeout = setTimeout(
            () =>
                settle(
                    task.task_status !== 'stopped' &&
                        task.getTurnGeneration() === expectedGeneration &&
                        task._retryNowResolver === retryNowResolver
                ),
            delayMs
        );
    });

    await emitScheduled();
    if (task.getTurnGeneration() !== expectedGeneration) {
        cancelWait();
    }
    return await waitPromise;
}

export async function clearLLMRetryFeedbackForTask(
    task: TaskState,
    attempt: number,
    delayMs: number,
    nextRetryAt: number,
    errorMessage: string
): Promise<void> {
    await sendRetryFeedbackForTask(task, {
        attempt,
        delay_ms: delayMs,
        next_retry_at: nextRetryAt,
        error_message: errorMessage,
        status: 'cleared'
    });
}

/**
 * @returns true 表示流被 tool call 解析/创建钩子主动中断
 */
export async function processTaskCompletion(
    task: TaskState,
    modelRequestOptions?: TaskModelRequestOptions
): Promise<boolean> {
    const assistant_message = task.chat_context.lastMessage();
    if (assistant_message === undefined || !(assistant_message instanceof AssistantMessage)) {
        return false;
    }

    // 捕获当前 turn 代数，用于在流式过程中检测是否被新 turn 取代。
    // submitUserMessage 会递增 _turnGeneration 并将 task_status 改回 'running'，
    // 仅靠 task_status 检查无法阻止旧 turn 的 processCompletion 继续处理 LLM 响应。
    const myGeneration = task.getTurnGeneration();
    const isCurrentTurn = () => task.getTurnGeneration() === myGeneration;

    const model = task.ensureValidModelOrFallback();
    let streamOptions:
        | {
              toolResultOverrides?: Map<string, string>;
              activeContext?: ActiveContextView;
          }
        | undefined = undefined;
    let dynamicMaxCompletionTokens: number | undefined = undefined;
    let requestTailText: string | undefined = undefined;
    let preparedContextTokens = 0;
    const evidenceCardEnabled = task.refreshEvidenceCardFeatureState();
    const evidenceCardSettings = getEvidenceCardSettings(evidenceCardEnabled);
    try {
        const preparation = await prepareContextForModel(task.chat_context, model, {
            beforeCompact: () => {
                logCompactInfo(task.task_id, {
                    source: 'tasks',
                    event: 'auto_compacting_context',
                    message: `Auto-compacting context for task ${task.task_id}`
                });
            },
            enableToolResultBudget: true,
            enableMicrocompact: false,
            enableSessionMemoryCompact: true,
            taskId: task.task_id,
            toolResultReplacementState: task.tool_result_replacement_state,
            autoCompactState: task.auto_compact_state,
            microcompactState: task.microcompact_state,
            microcompactRequestKind: 'task_turn',
            microcompactTaskRole: task.getMicrocompactTaskRole(),
            sessionMemoryState: task.session_memory_state,
            ...(evidenceCardEnabled
                ? {
                      toolResultBudgetChars: evidenceCardSettings.toolResultBudgetChars,
                      toolResultBudgetPreviewOptions: getEvidenceCardPreviewOptions(evidenceCardSettings)
                  }
                : {}),
            requestOptions: modelRequestOptions
        });
        if (!isCurrentTurn()) return false;

        if (preparation.toolResultReplacementState) {
            task.tool_result_replacement_state = preparation.toolResultReplacementState;
        }

        if (preparation.autoCompactState) {
            task.setAutoCompactState(preparation.autoCompactState);
        }

        if (preparation.microcompactState) {
            task.setMicrocompactState(preparation.microcompactState);
        }

        if (preparation.sessionMemoryState) {
            task.setSessionMemoryState(preparation.sessionMemoryState);
        }

        if (preparation.compacted) {
            task.clearFileReadStateAfterContextCompaction(
                preparation.sessionMemoryCompacted ? 'session_memory_compact' : 'full_compact'
            );
        }

        if (preparation.sessionMemoryCompactResult) {
            const compactVariant = preparation.sessionMemoryCompactResult.plan
                ? describeCompactPlanVariant(preparation.sessionMemoryCompactResult.plan)
                : undefined;
            logCompactInfo(task.task_id, {
                source: 'tasks',
                event: 'session_memory_compact_result',
                message:
                    `[Compact Step9] session memory compact result: compacted=${preparation.sessionMemoryCompacted}, ` +
                    (compactVariant ? `variant=${compactVariant.compactVariant}, ` : '') +
                    `reason=${preparation.sessionMemoryCompactResult.noopReason ?? 'applied'}, ` +
                    `postTokens=${preparation.sessionMemoryCompactResult.postCompactTokens ?? 'unknown'}`,
                data: {
                    compacted: preparation.sessionMemoryCompacted,
                    reason: preparation.sessionMemoryCompactResult.noopReason ?? 'applied',
                    postTokens: preparation.sessionMemoryCompactResult.postCompactTokens ?? 'unknown',
                    ...(compactVariant ?? {})
                }
            });
        }

        const activeContextVariant = describeActiveContextVariant(preparation.activeContext);
        logCompactInfo(task.task_id, {
            source: 'tasks',
            event: 'active_context_compact_variant',
            message:
                `[Compact Step9] active context compact variant=${activeContextVariant.compactVariant}, ` +
                `recentUserPreserved=${activeContextVariant.recentUserPreserved}, ` +
                `startsInsideAssistant=${activeContextVariant.startsInsideAssistant}` +
                (activeContextVariant.startsInsideAssistant
                    ? `, messageId=${activeContextVariant.keepAnchorMessageId}, ` +
                      `roundIndex=${activeContextVariant.kept_anchor_round_index}, ` +
                      `startPartIndex=${activeContextVariant.kept_anchor_start_part_index}`
                    : ''),
            data: {
                ...activeContextVariant
            }
        });

        if (preparation.budgetApplied && preparation.toolResultBudgetStats) {
            const stats = preparation.toolResultBudgetStats;
            logCompactInfo(task.task_id, {
                source: 'tasks',
                event: 'tool_result_budget',
                message:
                    `[Compact Step4] query-time tool result budget: groups=${stats.groupCount}, ` +
                    `overrides=${stats.overrideCount}, reapplied=${stats.reappliedCount}, ` +
                    `newlySelected=${stats.newlySelectedCount}, newlySeen=${stats.newlySeenCount}, ` +
                    `overBudgetGroups=${stats.overBudgetGroupCount}`,
                data: {
                    groupCount: stats.groupCount,
                    overrideCount: stats.overrideCount,
                    reappliedCount: stats.reappliedCount,
                    newlySelectedCount: stats.newlySelectedCount,
                    newlySeenCount: stats.newlySeenCount,
                    overBudgetGroupCount: stats.overBudgetGroupCount
                }
            });
        }

        if (preparation.microcompactStats) {
            const stats = preparation.microcompactStats;
            const skippedSummary = Object.entries(stats.skippedByReason)
                .sort(([leftReason], [rightReason]) => leftReason.localeCompare(rightReason))
                .map(([reason, count]) => `${reason}=${count}`)
                .join(', ');
            logCompactInfo(task.task_id, {
                source: 'tasks',
                event: 'microcompact_analysis_detail',
                message:
                    `[Compact Step5A] microcompact analysis: scanned=${stats.scannedToolCallCount}, ` +
                    `candidates=${stats.candidateCount}, skipped=${stats.skippedCount}, ` +
                    `tailProtected=${stats.tailProtectedCount}, totalCandidateChars=${stats.totalCandidateChars}, ` +
                    `tailAssistantMessages=${stats.tailAssistantMessages}` +
                    (skippedSummary.length > 0 ? `, skippedByReason={${skippedSummary}}` : ''),
                data: {
                    scannedToolCallCount: stats.scannedToolCallCount,
                    candidateCount: stats.candidateCount,
                    skippedCount: stats.skippedCount,
                    tailProtectedCount: stats.tailProtectedCount,
                    totalCandidateChars: stats.totalCandidateChars,
                    tailAssistantMessages: stats.tailAssistantMessages,
                    skippedByReason: stats.skippedByReason
                }
            });

            const topCandidates = [...(preparation.microcompactAnalysis?.candidates ?? [])]
                .sort((left, right) => right.sizeChars - left.sizeChars)
                .slice(0, 3);
            for (const candidate of topCandidates) {
                logCompactInfo(task.task_id, {
                    source: 'tasks',
                    event: 'microcompact_candidate_detail',
                    message:
                        `[Compact Step5A] candidate tool=${candidate.toolName}, chars=${candidate.sizeChars}, ` +
                        `lines=${candidate.sizeLines}, chatIndex=${candidate.chatContextMessageIndex}, ` +
                        `part=${candidate.toolCallPartIndex}, call=${candidate.toolCallIndex}, ` +
                        `resultId=${candidate.resultId}, hasStorage=${candidate.hasResultStorage}`,
                    data: {
                        toolName: candidate.toolName,
                        sizeChars: candidate.sizeChars,
                        sizeLines: candidate.sizeLines,
                        chatContextMessageIndex: candidate.chatContextMessageIndex,
                        toolCallPartIndex: candidate.toolCallPartIndex,
                        toolCallIndex: candidate.toolCallIndex,
                        resultId: candidate.resultId,
                        hasResultStorage: candidate.hasResultStorage
                    }
                });
            }
            if (preparation.microcompactDecision) {
                const decision = preparation.microcompactDecision;
                logCompactInfo(task.task_id, {
                    source: 'tasks',
                    event: 'microcompact_decision_detail',
                    message:
                        `[Compact Step5B] microcompact decision: mode=${decision.mode}, ` +
                        `reason=${decision.reason}, selected=${decision.selectedResultIds.length}, ` +
                        `keptRecent=${decision.keptRecentResultIds.length}, ` +
                        `idleGapMinutes=${decision.idleGapMinutes ?? 'n/a'}, ` +
                        `estimatedCharsBefore=${decision.estimatedCharsBefore}, ` +
                        `estimatedCharsAfter=${decision.estimatedCharsAfter}, ` +
                        `estimatedCharsSaved=${decision.estimatedCharsSaved}`,
                    data: {
                        mode: decision.mode,
                        reason: decision.reason,
                        selectedCount: decision.selectedResultIds.length,
                        selectedResultIds: decision.selectedResultIds,
                        keptRecentCount: decision.keptRecentResultIds.length,
                        keptRecentResultIds: decision.keptRecentResultIds,
                        idleGapMinutes: decision.idleGapMinutes,
                        estimatedCharsBefore: decision.estimatedCharsBefore,
                        estimatedCharsAfter: decision.estimatedCharsAfter,
                        estimatedCharsSaved: decision.estimatedCharsSaved
                    }
                });
            }
            logCompactInfo(task.task_id, {
                source: 'tasks',
                event: 'microcompact_execution_detail',
                message:
                    `[Compact Step5C] microcompact execution: mode=${preparation.microcompactDecision?.mode ?? 'noop'}, ` +
                    `applied=${stats.appliedCount}, ` +
                    `skippedByOverride=${stats.skippedByOverrideCount}, ` +
                    `unshrinkable=${stats.unshrinkableCount}, ` +
                    `charsBefore=${stats.totalCharsBefore}, charsAfter=${stats.totalCharsAfter}`,
                data: {
                    mode: preparation.microcompactDecision?.mode ?? 'noop',
                    appliedCount: stats.appliedCount,
                    skippedByOverrideCount: stats.skippedByOverrideCount,
                    unshrinkableCount: stats.unshrinkableCount,
                    totalCharsBefore: stats.totalCharsBefore,
                    totalCharsAfter: stats.totalCharsAfter
                }
            });

            for (const candidate of preparation.microcompactAppliedCandidates.slice(0, 3)) {
                logCompactInfo(task.task_id, {
                    source: 'tasks',
                    event: 'microcompact_applied_candidate_detail',
                    message:
                        `[Compact Step5C] applied tool=${candidate.toolName}, chars=${candidate.sizeChars}, ` +
                        `lines=${candidate.sizeLines}, chatIndex=${candidate.chatContextMessageIndex}, ` +
                        `part=${candidate.toolCallPartIndex}, call=${candidate.toolCallIndex}, ` +
                        `resultId=${candidate.resultId}`,
                    data: {
                        toolName: candidate.toolName,
                        sizeChars: candidate.sizeChars,
                        sizeLines: candidate.sizeLines,
                        chatContextMessageIndex: candidate.chatContextMessageIndex,
                        toolCallPartIndex: candidate.toolCallPartIndex,
                        toolCallIndex: candidate.toolCallIndex,
                        resultId: candidate.resultId
                    }
                });
            }
        }

        if (
            preparation.compacted ||
            preparation.toolResultStateChanged ||
            preparation.microcompactStateChanged ||
            preparation.autoCompactStateChanged ||
            preparation.sessionMemoryStateChanged
        ) {
            task.persistLater();
        }

        streamOptions = {
            activeContext: preparation.activeContext,
            toolResultOverrides: preparation.toolResultOverrides
        };
        preparedContextTokens = preparation.contextTokenEstimate?.estimatedContextTokens ?? 0;
    } catch (err: unknown) {
        logger.warn(`Prepare context before completion failed: ${err instanceof Error ? err.message : err}`);
    }

    if (!isCurrentTurn()) return false;

    // TailCards 由 onTailcardGenerate 钩子生成。上下文准备成功时回调可读取压缩后的
    // ActiveContextView；准备失败时保留旧行为，直接使用原始 chat context 回退，
    // 不在回退点重新构建或修改 active view。
    requestTailText = await task.hooks.buildTailcards(task, {
        activeContext: streamOptions?.activeContext,
        chatContext: task.chat_context,
        model,
        requestType: 'streamComplete'
    });

    if (!isCurrentTurn()) return false;

    const estimatedContextTokens = preparedContextTokens + estimateTextTokens(requestTailText);
    if (estimatedContextTokens > 0) {
        try {
            let contextWindow = 0;
            const modelInstance = model
                ? Setting.getInstance().getModelInstance(model, 'chat')
                : Setting.getInstance().getDefaultModelInstance();
            if (modelInstance?.context_length && modelInstance.context_length > 0) {
                contextWindow = modelInstance.context_length;
            } else {
                const modelName = modelInstance?.model_name ?? model ?? '';
                contextWindow = lookupKnownContextSize(modelName);
                if (contextWindow <= 0 && modelInstance) {
                    contextWindow = await fetchContextSizeFromAPI(modelInstance);
                }
            }
            if (contextWindow > 0) {
                const remaining = contextWindow - estimatedContextTokens;
                if (remaining > 0) {
                    const modelName = modelInstance?.model_name ?? model ?? '';
                    const configuredMaxOutput =
                        modelInstance?.max_output_tokens && modelInstance.max_output_tokens > 0
                            ? modelInstance.max_output_tokens
                            : lookupKnownMaxOutputTokens(modelName) || 16384;
                    dynamicMaxCompletionTokens = Math.min(remaining, configuredMaxOutput);
                }
            }
        } catch {
            // 解析失败时保持默认值
        }
    }

    task.profiler?.beginLLM(task._currentTurn);
    const benchmarkRequest = task.ensureBenchmarkUsageLedger().beginRequest({
        turn: task._currentTurn,
        requestType: 'streamComplete',
        ...task.resolveBenchmarkUsageModelInfo()
    });

    // Track the last sent text part index to avoid duplicate sends
    let lastSentTextPartIndex = -1;
    const toolCallsBeforeCompletion = new Set(collectToolCalls(assistant_message));
    const getCurrentRequestToolCalls = (): ToolCall[] =>
        collectToolCalls(assistant_message).filter((toolCall) => !toolCallsBeforeCompletion.has(toolCall));
    // 追踪本次 LLM 请求已 merge 的工具调用数量，用于检测新工具调用到达
    let prevMergedToolCallCount = 0;
    let abortedByToolcallHook = false;
    const requestOptions: LLMRequestOptions = {
        reasoningEffort: task.reasoningEffort,
        maxCompletionTokens: dynamicMaxCompletionTokens,
        ...modelRequestOptions,
        onRetry: (_attempt: number, _delayMs: number, err: unknown) => {
            task.ensureBenchmarkUsageLedger().recordRetry(benchmarkRequest, err);
        },
        disableInternalRetry: true
    };
    const llmMessageOptions = {
        ...(streamOptions ?? {}),
        ...(requestTailText ? { requestTailText } : {})
    };
    let retryAttempt = 0;
    let lastRetryState:
        | {
              attempt: number;
              delayMs: number;
              nextRetryAt: number;
              errorMessage: string;
          }
        | undefined;

    try {
        while (task.task_status !== 'stopped' && task.getTurnGeneration() === myGeneration) {
            try {
                const requestModel = task.ensureValidModelOrFallback();
                const effectiveModel = requestModel || Setting.getInstance().getData().default_model || '';
                const modelInstance = Setting.getInstance().getModelInstance(effectiveModel, 'chat');
                const autoParseThinkTags = modelInstance?.auto_parse_think_tags ?? false;
                logger.info(
                    `task ${task.task_id}: beginCompletionRound ` +
                        `requestModel=${requestModel}, ` +
                        `effectiveModel=${effectiveModel}, ` +
                        `modelInstanceFound=${modelInstance !== null}, ` +
                        `autoParseThinkTags=${autoParseThinkTags}`
                );
                assistant_message.beginCompletionRound(autoParseThinkTags);
                await AgentExecutionInstrumentationRegistry.aroundModelRequest(
                    {
                        taskId: task.task_id,
                        chatContext: task.chat_context,
                        messageOptions: llmMessageOptions,
                        assistantMessage: assistant_message,
                        model: requestModel,
                        metadata: {
                            requestType: 'streamComplete'
                        },
                        getUsage: () => assistant_message.usage
                    },
                    async (instrumentationHeaders) => {
                        const tracedRequestOptions = instrumentationHeaders
                            ? {
                                  ...requestOptions,
                                  extraHeaders: {
                                      ...requestOptions.extraHeaders,
                                      ...instrumentationHeaders
                                  }
                              }
                            : requestOptions;
                        for await (const chunk_resp of LLM.streamComplete(
                            task.chat_context,
                            requestModel,
                            llmMessageOptions,
                            tracedRequestOptions
                        )) {
                            const responseError = getAssistantResponseError(chunk_resp);
                            if (responseError) {
                                throw responseError;
                            }

                            // 检查是否已停止或被新 turn 取代
                            if (task.task_status === 'stopped' || task.getTurnGeneration() !== myGeneration) {
                                logger.info(
                                    `task ${task.task_id} completion interrupted by ${task.task_status === 'stopped' ? 'stop request' : 'new turn'}`
                                );
                                break;
                            }

                            // 在 merge 之前，检查本 chunk 是否带来了新的工具调用 ID。
                            // 如果是，说明前一个工具调用的 args_string 已完整，通过 afterParseToolcall 钩子校验。
                            const chunkHasNewToolCall = chunkIntroducesNewToolCall(
                                chunk_resp.content,
                                assistant_message
                            );
                            if (chunkHasNewToolCall && prevMergedToolCallCount > 0) {
                                const existingCalls = collectToolCalls(assistant_message);
                                const lastExisting = existingCalls[existingCalls.length - 1];
                                if (lastExisting) {
                                    finalizeToolCallArgs(lastExisting);
                                    const feedback = await task.hooks.checkAfterParseToolcall(task, lastExisting);
                                    if (!isCurrentTurn()) return false;
                                    if (feedback.operation === 'reject') {
                                        removeToolCallsFrom(assistant_message, existingCalls.length - 1);
                                        if (chunk_resp.usage) {
                                            assistant_message.usage = chunk_resp.usage;
                                        }
                                        logger.warn(
                                            `task ${task.task_id}: afterParseToolcall rejected ` +
                                                `"${lastExisting.tool_name}" (id=${lastExisting.id}): ${feedback.message}`
                                        );
                                        abortedByToolcallHook = true;
                                        await task.sendSubscriptionFeedback();
                                        break;
                                    }
                                }
                            }

                            // beforeToolcallCreated 钩子：在 merge 前检查是否应拒绝新的工具调用
                            {
                                const requestToolCalls = getCurrentRequestToolCalls();
                                const feedback = await task.hooks.checkBeforeToolcallCreated(
                                    task,
                                    assistant_message,
                                    chunkHasNewToolCall,
                                    requestToolCalls
                                );
                                if (!isCurrentTurn()) return false;
                                if (feedback.operation === 'reject') {
                                    logger.warn(
                                        `task ${task.task_id}: beforeToolcallCreated rejected: ${feedback.message}`
                                    );
                                    if (chunk_resp.usage) {
                                        assistant_message.usage = chunk_resp.usage;
                                    }
                                    abortedByToolcallHook = true;
                                    await task.sendSubscriptionFeedback();
                                    break;
                                }
                            }

                            const prevPartCount = assistant_message.content.length;
                            const prevPartTypes = assistant_message.content.map((part) => part.type);
                            assistant_message.mergeChunk(chunk_resp.content);
                            if (chunk_resp.usage) {
                                assistant_message.usage = chunk_resp.usage;
                            }
                            task.applyRuntimeMetadataToAssistant(assistant_message);

                            resolveStreamingToolCallsForTask(task, assistant_message);

                            prevMergedToolCallCount = getCurrentRequestToolCalls().length;

                            // When content length increases, a new part was created - the previous part is now complete
                            if (assistant_message.content.length > prevPartCount) {
                                const prevPartIndex = prevPartCount - 1;
                                const prevPart = assistant_message.content[prevPartIndex];

                                // Check if the previous part is a text part that hasn't been sent yet
                                if (prevPart?.type === 'text' && lastSentTextPartIndex < prevPartIndex) {
                                    task.onTextPartComplete?.(prevPart.text);
                                    lastSentTextPartIndex = prevPartIndex;
                                }
                            }

                            if (task.subscribers.length == 0) {
                                // no subscribers, skip
                                continue;
                            }

                            const rebasedPartIndex = findRebasedPartIndex(prevPartTypes, assistant_message.content);
                            if (rebasedPartIndex !== -1) {
                                await task.sendAssistantMessageReplace(assistant_message);
                            } else if (assistant_message.content.length > prevPartCount) {
                                // content 数组增长了（如 <think> 标签拆分产生新 part），
                                // 需要同时更新被修改的旧 part 和新增的 part
                                for (
                                    let i = Math.max(0, prevPartCount - 1);
                                    i < assistant_message.content.length;
                                    i++
                                ) {
                                    await task.sendSubscriptionFeedback(i);
                                }
                            } else {
                                await task.sendSubscriptionFeedback();
                            }
                        }
                    }
                );

                if (!isCurrentTurn()) return false;

                if (lastRetryState) {
                    await clearLLMRetryFeedbackForTask(
                        task,
                        lastRetryState.attempt,
                        lastRetryState.delayMs,
                        lastRetryState.nextRetryAt,
                        lastRetryState.errorMessage
                    );
                }
                if (!isCurrentTurn()) return false;
                break;
            } catch (err: unknown) {
                if (task.task_status === 'stopped' || task.getTurnGeneration() !== myGeneration) {
                    break;
                }

                const autoRetry = Setting.getInstance().getData().task_config?.auto_retry !== false;
                if (!autoRetry) {
                    if (lastRetryState) {
                        await clearLLMRetryFeedbackForTask(
                            task,
                            lastRetryState.attempt,
                            lastRetryState.delayMs,
                            lastRetryState.nextRetryAt,
                            lastRetryState.errorMessage
                        );
                    }
                    if (!isCurrentTurn()) return false;
                    assistant_message.appendError('Stream Completion Failed', errorToMessage(err));
                    await task.sendSubscriptionFeedback();
                    break;
                }

                retryAttempt++;
                const delayMs = getLLMRetryDelayMs(retryAttempt);
                const nextRetryAt = Date.now() + delayMs;
                const errorMessage = errorToMessage(err);
                lastRetryState = {
                    attempt: retryAttempt,
                    delayMs,
                    nextRetryAt,
                    errorMessage
                };

                task.ensureBenchmarkUsageLedger().recordRetry(benchmarkRequest, err);

                if (assistant_message.content.length > 0) {
                    // 仅回退最后一个未完成的 part，保留已完成的 parts
                    assistant_message.rollbackLastPart();
                    // 重新计算 lastSentTextPartIndex：找到最后一个 text part 的索引
                    lastSentTextPartIndex = -1;
                    for (let i = assistant_message.content.length - 1; i >= 0; i--) {
                        if (assistant_message.content[i].type === 'text') {
                            lastSentTextPartIndex = i;
                            break;
                        }
                    }
                    prevMergedToolCallCount = getCurrentRequestToolCalls().length;
                    await task.sendAssistantMessageReplace(assistant_message);
                    if (!isCurrentTurn()) return false;
                }

                logger.warn(
                    `LLM request failed for task ${task.task_id}; retry ${retryAttempt} in ${delayMs / 1000}s: ` +
                        errorMessage
                );

                const shouldRetry = await waitForLLMRetryDelayForTask(task, retryAttempt, delayMs, err, myGeneration);
                if (!shouldRetry) {
                    break;
                }

                await sendRetryFeedbackForTask(task, {
                    attempt: retryAttempt,
                    delay_ms: delayMs,
                    next_retry_at: Date.now(),
                    error_message: errorMessage,
                    status: 'retrying'
                });
                if (!isCurrentTurn()) return false;
            }
        }

        if (!isCurrentTurn()) return false;

        // 流结束后，如果之前没有被 tool call 钩子主动中断，则再校验最后一个工具调用
        if (!abortedByToolcallHook) {
            const finalToolCalls = collectToolCalls(assistant_message);
            if (finalToolCalls.length > 0) {
                const lastTc = finalToolCalls[finalToolCalls.length - 1];
                finalizeToolCallArgs(lastTc);
                const feedback = await task.hooks.checkAfterParseToolcall(task, lastTc);
                if (!isCurrentTurn()) return false;
                if (feedback.operation === 'reject') {
                    removeToolCallsFrom(assistant_message, finalToolCalls.length - 1);
                    logger.warn(
                        `task ${task.task_id}: afterParseToolcall rejected last tool call ` +
                            `"${lastTc.tool_name}" (id=${lastTc.id}) after stream: ${feedback.message}`
                    );
                    abortedByToolcallHook = true;
                    await task.sendSubscriptionFeedback();
                    if (!isCurrentTurn()) return false;
                }
            }
        }

        // After streaming ends, finalize all reasoning timing
        assistant_message.finalizeReasoningTiming();
        assistant_message.timestamp = Date.now();

        // After streaming ends, send any remaining text part if it hasn't been sent
        const lastPart = assistant_message.content[assistant_message.content.length - 1];
        if (lastPart?.type === 'text' && lastSentTextPartIndex < assistant_message.content.length - 1) {
            task.onTextPartComplete?.(lastPart.text);
        }
    } catch (err) {
        logger.error(`task ${task.task_id}: processTaskTurn crashed: ${(err as Error)?.message || String(err)}`);
        // 确保任务状态被标记为已停止
        if (task.task_status !== 'stopped') {
            task.task_status = 'stopped';
            task.finished_at = new Date();
        }
    } finally {
        task.ensureBenchmarkUsageLedger().finishRequest(benchmarkRequest, {
            usage: assistant_message.usage
        });
        if (isCurrentTurn()) {
            task.profiler?.endLLM({
                prompt_tokens: assistant_message.usage?.prompt_tokens,
                completion_tokens: assistant_message.usage?.completion_tokens,
                total_tokens: assistant_message.usage?.total_tokens,
                input_tokens: assistant_message.usage?.input_tokens,
                output_tokens: assistant_message.usage?.output_tokens,
                cache_creation_input_tokens: assistant_message.usage?.cache_creation_input_tokens,
                cache_read_input_tokens: assistant_message.usage?.cache_read_input_tokens
            });
            recordEvidenceCardLLMUsage(task, assistant_message.usage, 'streamComplete');
        }
        // 确保无论流式成功还是异常，持久化前所有 reasoning part 的耗时都已固化
        assistant_message.finalizeReasoningTiming();
        if (!assistant_message.timestamp) {
            assistant_message.timestamp = Date.now();
        }
    }

    task.persistLater();
    return abortedByToolcallHook;
}
