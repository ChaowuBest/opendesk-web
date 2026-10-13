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

import { OpenAIAdapter } from '../adapters/openai.js';
import { estimateRequestPayloadTokens } from './request-budget.js';
import { ContextPreparationBlockedError } from './compact-error.js';
import { compactContext } from '../compact.js';
import { ChatContext } from '../messages.js';
import { logger } from '../../utils/logger.js';
import { describeCompactPlanVariant, logCompactInfo } from './compact-trace.js';
import { buildActiveContextView } from './context-view.js';
import {
    AutoCompactStates,
    estimateAutoCompactContextTokens,
    getAutoCompactDecision,
    type AutoCompactState
} from './auto-compact.js';
import { MicrocompactStates } from './microcompact-state.js';
import {
    analyzeMicrocompactCandidates,
    applyLocalMicrocompactToChatContext,
    buildRequestTimeMicrocompactOverrides,
    createMicrocompactDecision
} from './microcompact.js';
import { trySessionMemoryCompaction } from './session-memory-compact.js';
import { buildToolResultBudgetProjectionForChatContext } from './tool-results.js';
import type { PrepareContextOptions, PreparedContextResult } from './types.js';

type LightweightPreparationResult = Omit<
    PreparedContextResult,
    | 'shouldCompact'
    | 'compacted'
    | 'sessionMemoryCompacted'
    | 'sessionMemoryCompactResult'
    | 'sessionMemoryState'
    | 'sessionMemoryStateChanged'
    | 'autoCompactDecision'
    | 'autoCompactState'
    | 'autoCompactStateChanged'
    | 'contextTokenEstimate'
>;

function isAssistantRoundBoundaryEnabled(options: PrepareContextOptions): boolean {
    return options.enableAssistantRoundBoundary !== false;
}

function didMicrocompactStateChange(
    previous: PreparedContextResult['microcompactState'],
    next: PreparedContextResult['microcompactState']
): boolean {
    if (previous === undefined || next === undefined) {
        return previous !== next;
    }

    return (
        JSON.stringify(MicrocompactStates.serialize(previous)) !== JSON.stringify(MicrocompactStates.serialize(next))
    );
}

function selectPrimaryMicrocompactLayerResult(
    previous: LightweightPreparationResult,
    next: LightweightPreparationResult
): Pick<
    LightweightPreparationResult,
    'microcompactAnalysis' | 'microcompactStats' | 'microcompactDecision' | 'microcompactMode'
> {
    const previousMode = previous.microcompactDecision?.mode ?? previous.microcompactMode ?? 'noop';
    const nextMode = next.microcompactDecision?.mode ?? next.microcompactMode ?? 'noop';

    if (previousMode !== 'noop' && nextMode === 'noop') {
        return {
            microcompactAnalysis: previous.microcompactAnalysis,
            microcompactStats: previous.microcompactStats,
            microcompactDecision: previous.microcompactDecision,
            microcompactMode: previous.microcompactMode
        };
    }

    return {
        microcompactAnalysis: next.microcompactAnalysis,
        microcompactStats: next.microcompactStats,
        microcompactDecision: next.microcompactDecision,
        microcompactMode: next.microcompactMode
    };
}

function logMicrocompactTraceSummary(
    taskId: string | undefined,
    result: Pick<
        LightweightPreparationResult,
        'microcompactAnalysis' | 'microcompactStats' | 'microcompactDecision' | 'microcompactMode'
    >
): void {
    const analysis = result.microcompactAnalysis;
    const stats = result.microcompactStats;
    const decision = result.microcompactDecision;
    const mode = decision?.mode ?? result.microcompactMode ?? 'noop';

    if (!analysis || !stats || !decision) {
        return;
    }

    const skippedSummary = Object.entries(stats.skippedByReason)
        .sort(([leftReason], [rightReason]) => leftReason.localeCompare(rightReason))
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ');

    logCompactInfo(taskId, {
        source: 'pipeline',
        event: 'microcompact_analysis',
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

    logCompactInfo(taskId, {
        source: 'pipeline',
        event: 'microcompact_decision',
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

    const actualCharsSaved = Math.max(stats.totalCharsBefore - stats.totalCharsAfter, 0);
    const executionEvent =
        mode === 'request_override'
            ? 'microcompact_request_override'
            : mode === 'local_clear'
              ? 'microcompact_local_clear'
              : 'microcompact_noop';
    logCompactInfo(taskId, {
        source: 'pipeline',
        event: executionEvent,
        message:
            `[Compact Step5C] microcompact execution: mode=${mode}, ` +
            `reason=${decision.reason}, applied=${stats.appliedCount}, ` +
            `skippedByOverride=${stats.skippedByOverrideCount}, ` +
            `unshrinkable=${stats.unshrinkableCount}, ` +
            `charsBefore=${stats.totalCharsBefore}, charsAfter=${stats.totalCharsAfter}, ` +
            `charsSaved=${actualCharsSaved}`,
        data: {
            mode,
            reason: decision.reason,
            appliedCount: stats.appliedCount,
            skippedByOverrideCount: stats.skippedByOverrideCount,
            unshrinkableCount: stats.unshrinkableCount,
            totalCharsBefore: stats.totalCharsBefore,
            totalCharsAfter: stats.totalCharsAfter,
            totalCharsSaved: actualCharsSaved
        }
    });
}

function runLightweightPreparationLayers(
    chatContext: ChatContext,
    options: PrepareContextOptions = {}
): LightweightPreparationResult {
    let activeContext = buildActiveContextView(chatContext);
    let budgetApplied = false;
    let budgetToolResultOverrides = new Map<string, string>();
    let toolResultOverrides: PreparedContextResult['toolResultOverrides'] = new Map<string, string>();
    let toolResultReplacementState: PreparedContextResult['toolResultReplacementState'] =
        options.toolResultReplacementState;
    let toolResultBudgetStats: PreparedContextResult['toolResultBudgetStats'] = undefined;

    if (options.enableToolResultBudget && options.taskId && toolResultReplacementState) {
        const projection = buildToolResultBudgetProjectionForChatContext(
            chatContext,
            options.taskId,
            toolResultReplacementState,
            {
                groupBudgetChars: options.toolResultBudgetChars,
                previewOptions: options.toolResultBudgetPreviewOptions,
                skipToolNames: options.skipToolNames,
                persistArtifacts: options.readonlyOnly !== true
            }
        );
        activeContext = projection.activeContext;
        budgetApplied = true;
        budgetToolResultOverrides = projection.overrides;
        toolResultOverrides = new Map(budgetToolResultOverrides);
        toolResultReplacementState = projection.replacementState;
        toolResultBudgetStats = projection.stats;
    }

    let microcompactAnalysis: PreparedContextResult['microcompactAnalysis'] = undefined;
    let microcompactAppliedCandidates: PreparedContextResult['microcompactAppliedCandidates'] = [];
    let microcompactStats: PreparedContextResult['microcompactStats'] = undefined;
    let microcompactDecision: PreparedContextResult['microcompactDecision'] = undefined;
    let microcompactMode: PreparedContextResult['microcompactMode'] = undefined;
    let microcompactState: PreparedContextResult['microcompactState'] = options.microcompactState
        ? MicrocompactStates.clone(options.microcompactState)
        : undefined;
    let microcompactApplied = false;
    let microcompactStateChanged = false;
    const microcompactRequestKind = options.microcompactRequestKind ?? 'task_turn';
    const microcompactTaskRole = options.microcompactTaskRole ?? 'main';
    const canApplyLocalMicrocompact = microcompactRequestKind === 'task_turn' && microcompactTaskRole === 'main';

    if (options.enableMicrocompact) {
        const analysis = analyzeMicrocompactCandidates(activeContext, {
            tailAssistantMessages: options.microcompactTailAssistantMessages,
            skipToolNames: options.microcompactSkipToolNames
        });
        microcompactAnalysis = analysis;
        microcompactStats = analysis.stats;
        microcompactDecision = createMicrocompactDecision(analysis, {
            enabled: true,
            requestKind: microcompactRequestKind,
            taskRole: microcompactTaskRole,
            taskId: options.taskId,
            modeOverride: options.microcompactModeOverride,
            state: microcompactState,
            idleGapThresholdMinutes: options.microcompactIdleGapMinutes,
            keepRecentResults: options.microcompactKeepRecentResults
        });
        microcompactMode = microcompactDecision.mode;

        if (microcompactState && microcompactDecision.mode !== 'noop') {
            const nextMicrocompactState = MicrocompactStates.recordDecision(microcompactState, microcompactDecision);
            microcompactStateChanged = didMicrocompactStateChange(microcompactState, nextMicrocompactState);
            microcompactState = nextMicrocompactState;
        }

        if (microcompactDecision.mode === 'local_clear' && options.taskId && canApplyLocalMicrocompact) {
            const microcompactResult = applyLocalMicrocompactToChatContext(chatContext, options.taskId, {
                analysis,
                skipResultIds: budgetToolResultOverrides.keys(),
                selectedResultIds: microcompactDecision.selectedResultIds
            });
            activeContext = microcompactResult.activeContext;
            microcompactAnalysis = microcompactResult.analysis;
            microcompactAppliedCandidates = microcompactResult.appliedCandidates;
            microcompactStats = microcompactResult.stats;
            microcompactApplied = microcompactResult.appliedCandidates.length > 0;
            if (microcompactState && microcompactResult.appliedCandidates.length > 0) {
                const nextMicrocompactState = MicrocompactStates.recordLocalClear(
                    microcompactState,
                    microcompactResult.appliedCandidates.map((candidate) => candidate.resultId)
                );
                microcompactStateChanged =
                    microcompactStateChanged || didMicrocompactStateChange(microcompactState, nextMicrocompactState);
                microcompactState = nextMicrocompactState;
            } else {
                microcompactStateChanged = microcompactStateChanged || microcompactResult.stateChanged;
            }
        } else if (microcompactDecision.mode === 'request_override' && options.taskId) {
            const microcompactResult = buildRequestTimeMicrocompactOverrides(options.taskId, {
                analysis,
                skipResultIds: budgetToolResultOverrides.keys(),
                selectedResultIds: microcompactDecision.selectedResultIds
            });
            microcompactAppliedCandidates = microcompactResult.appliedCandidates;
            microcompactStats = microcompactResult.stats;
            microcompactApplied = microcompactResult.appliedCandidates.length > 0;
            microcompactStateChanged = microcompactStateChanged || microcompactResult.stateChanged;

            toolResultOverrides = new Map(budgetToolResultOverrides);
            for (const [resultId, replacement] of microcompactResult.overrides) {
                if (!toolResultOverrides.has(resultId)) {
                    toolResultOverrides.set(resultId, replacement);
                }
            }
        }
    }

    return {
        activeContext,
        budgetApplied,
        microcompactApplied,
        microcompactMode,
        microcompactDecision,
        toolResultOverrides,
        toolResultReplacementState,
        toolResultBudgetStats,
        microcompactState,
        microcompactAnalysis,
        microcompactAppliedCandidates,
        microcompactStats,
        toolResultStateChanged:
            (toolResultBudgetStats?.newlySeenCount ?? 0) > 0 ||
            (toolResultBudgetStats?.newlySelectedCount ?? 0) > 0 ||
            (toolResultBudgetStats?.stableIdsCreatedCount ?? 0) > 0,
        microcompactStateChanged
    };
}

/**
 * 统一的 query 前准备入口：
 * - 规范化 compact boundary
 * - 先执行 Step 4 tool result budget
 * - 再执行 Step 5 microcompact policy / execution
 * - 最后才判断是否需要旧的 full compact
 * - 如果 full compact 执行过，则重新跑一遍 Step 4/5，得到最终发给模型的上下文视图
 */
export async function prepareContextForModel(
    chatContext: ChatContext,
    model?: string,
    options: PrepareContextOptions = {}
): Promise<PreparedContextResult> {
    chatContext.deduplicateCompactBoundaries();
    const assistantRoundBoundaryEnabled = isAssistantRoundBoundaryEnabled(options);

    let lightweightResult = runLightweightPreparationLayers(chatContext, options);
    let contextTokenEstimate = estimateAutoCompactContextTokens({
        activeContext: lightweightResult.activeContext,
        toolResultOverrides: lightweightResult.toolResultOverrides,
        systemPrompt: chatContext.system_prompt,
        model
    });
    const autoCompactDecision =
        options.autoCompactDecisionOverride ??
        (await getAutoCompactDecision(
            {
                activeContext: lightweightResult.activeContext,
                toolResultOverrides: lightweightResult.toolResultOverrides,
                systemPrompt: chatContext.system_prompt
            },
            model
        ));
    const autoCompactStateTarget = options.autoCompactState;
    let autoCompactState: AutoCompactState | undefined = autoCompactStateTarget
        ? AutoCompactStates.clone(autoCompactStateTarget)
        : undefined;
    let autoCompactStateChanged = false;
    const cooldownRemainingMs = autoCompactState ? AutoCompactStates.getCooldownRemainingMs(autoCompactState) : 0;
    const shouldRunCompact = autoCompactDecision.shouldCompact || options.forceCompact === true;
    if (shouldRunCompact && cooldownRemainingMs > 0 && !options.readonlyOnly)
        throw new ContextPreparationBlockedError('circuit_open');
    let compacted = false;
    let sessionMemoryCompacted = false;
    let sessionMemoryCompactResult: PreparedContextResult['sessionMemoryCompactResult'] = undefined;
    const sessionMemoryState = options.sessionMemoryState;
    const sessionMemoryStateChanged = false;

    if (autoCompactDecision.shouldCompact && cooldownRemainingMs > 0) {
        logCompactInfo(options.taskId, {
            source: 'pipeline',
            event: 'auto_compact_cooldown_active',
            message:
                `[Compact] auto-compact cooldown active: remaining=${cooldownRemainingMs}ms, ` +
                `failures=${autoCompactState?.consecutiveFailures ?? 0}, ` +
                `threshold=${autoCompactState?.failureThreshold ?? 0}, ` +
                `lastFailureReason=${autoCompactState?.lastFailureReason ?? 'unknown'}`,
            data: {
                cooldownRemainingMs,
                consecutiveFailures: autoCompactState?.consecutiveFailures ?? 0,
                failureThreshold: autoCompactState?.failureThreshold ?? 0,
                lastFailureReason: autoCompactState?.lastFailureReason ?? 'unknown'
            }
        });
    }

    const syncAutoCompactState = (nextState: AutoCompactState) => {
        autoCompactState = nextState;
        autoCompactStateChanged = true;
        if (autoCompactStateTarget) {
            Object.assign(autoCompactStateTarget, nextState);
        }
    };

    if (shouldRunCompact) {
        const defaultCompactionPath = options.enableSessionMemoryCompact
            ? 'session_memory_then_full_compact'
            : 'full_compact_only';
        logCompactInfo(options.taskId, {
            source: 'pipeline',
            event: 'compaction_path_defaults',
            message:
                `[Compact Step9] default compaction path=${defaultCompactionPath}, ` +
                `assistantRoundBoundary=${assistantRoundBoundaryEnabled}`,
            data: {
                defaultCompactionPath,
                enableAssistantRoundBoundary: assistantRoundBoundaryEnabled,
                enableSessionMemoryCompact: options.enableSessionMemoryCompact === true
            }
        });

        if (autoCompactState && !options.compactStateManaged) {
            syncAutoCompactState(AutoCompactStates.recordAttempt(autoCompactState));
        }

        let compactApplied = true;
        try {
            options.beforeCompact?.();
            if (options.executeCompact) {
                const executeResult = await options.executeCompact();
                compactApplied = executeResult !== false;
            } else {
                compactApplied = false;

                if (options.enableSessionMemoryCompact) {
                    try {
                        const sessionMemoryResult = await trySessionMemoryCompaction(
                            chatContext,
                            options.taskId,
                            sessionMemoryState,
                            autoCompactDecision,
                            {
                                ...options.sessionMemoryCompactOptions,
                                enableAssistantRoundBoundary:
                                    options.sessionMemoryCompactOptions?.enableAssistantRoundBoundary ??
                                    assistantRoundBoundaryEnabled
                            }
                        );
                        sessionMemoryCompactResult = sessionMemoryResult;
                        if (sessionMemoryResult.compacted) {
                            const compactVariant = describeCompactPlanVariant(sessionMemoryResult.plan);
                            compactApplied = true;
                            sessionMemoryCompacted = true;
                            logCompactInfo(options.taskId, {
                                source: 'pipeline',
                                event: 'session_memory_compact_applied',
                                message:
                                    `[Compact Step9] session memory compact applied: ` +
                                    `variant=${compactVariant.compactVariant}, ` +
                                    `kept=${sessionMemoryResult.plan?.messagesToKeep.length ?? 0}, ` +
                                    `postTokens=${sessionMemoryResult.postCompactTokens ?? 'unknown'}, ` +
                                    `threshold=${sessionMemoryResult.autoCompactThreshold ?? 'unknown'}`,
                                data: {
                                    keptMessages: sessionMemoryResult.plan?.messagesToKeep.length ?? 0,
                                    postCompactTokens: sessionMemoryResult.postCompactTokens ?? 'unknown',
                                    autoCompactThreshold: sessionMemoryResult.autoCompactThreshold ?? 'unknown',
                                    ...compactVariant
                                }
                            });
                        } else {
                            logCompactInfo(options.taskId, {
                                source: 'pipeline',
                                event: 'session_memory_compact_noop',
                                message:
                                    `[Compact Step8E] session memory compact no-op: ` +
                                    `${sessionMemoryResult.noopReason ?? 'unknown'}`,
                                data: {
                                    noopReason: sessionMemoryResult.noopReason ?? 'unknown'
                                }
                            });
                        }
                    } catch (sessionMemoryError) {
                        logger.warn(
                            `[Compact Step8E] session memory compact failed, falling back to full compact: ` +
                                `${sessionMemoryError instanceof Error ? sessionMemoryError.message : sessionMemoryError}`
                        );
                    }
                }

                if (!compactApplied) {
                    compactApplied = await compactContext(chatContext, model, {
                        trigger: 'auto',
                        taskId: options.taskId,
                        enableAssistantRoundBoundary: assistantRoundBoundaryEnabled,
                        requestOptions: options.requestOptions
                    });
                }
            }
        } catch (err) {
            if (autoCompactState && !options.compactStateManaged) {
                syncAutoCompactState(
                    AutoCompactStates.recordFailure(
                        autoCompactState,
                        new Date(),
                        err instanceof Error ? err.message : String(err)
                    )
                );
            }
            throw err;
        }

        if (compactApplied) {
            compacted = true;

            if (autoCompactState && !options.compactStateManaged) {
                syncAutoCompactState(AutoCompactStates.recordSuccess(autoCompactState));
            }

            const rerunOptions: PrepareContextOptions = {
                ...options,
                microcompactState: lightweightResult.microcompactState,
                toolResultReplacementState: lightweightResult.toolResultReplacementState,
                autoCompactState: autoCompactStateTarget ?? autoCompactState
            };
            const rerunResult = runLightweightPreparationLayers(chatContext, rerunOptions);
            const primaryMicrocompact = selectPrimaryMicrocompactLayerResult(lightweightResult, rerunResult);

            lightweightResult = {
                ...rerunResult,
                budgetApplied: lightweightResult.budgetApplied || rerunResult.budgetApplied,
                microcompactApplied: lightweightResult.microcompactApplied || rerunResult.microcompactApplied,
                microcompactAnalysis: primaryMicrocompact.microcompactAnalysis,
                microcompactStats: primaryMicrocompact.microcompactStats,
                microcompactDecision: primaryMicrocompact.microcompactDecision,
                microcompactMode: primaryMicrocompact.microcompactMode,
                microcompactAppliedCandidates: [
                    ...lightweightResult.microcompactAppliedCandidates,
                    ...rerunResult.microcompactAppliedCandidates
                ],
                toolResultStateChanged: lightweightResult.toolResultStateChanged || rerunResult.toolResultStateChanged,
                microcompactStateChanged:
                    lightweightResult.microcompactStateChanged || rerunResult.microcompactStateChanged
            };
        } else {
            logCompactInfo(options.taskId, {
                source: 'pipeline',
                event: 'auto_compact_noop',
                message: '[Compact] auto compact returned no-op; keeping context unchanged'
            });
        }
    }

    if (compacted) {
        const estimatedContextTokens = estimateRequestPayloadTokens({
            messages: OpenAIAdapter.buildMessages(chatContext, true, lightweightResult),
            ...OpenAIAdapter.buildToolOptions(chatContext)
        });
        contextTokenEstimate = {
            estimatedContextTokens,
            baseUsageTokens: 0,
            tailEstimatedTokens: estimatedContextTokens,
            assistantInternalTailTokens: 0,
            source: 'rough_estimate_only'
        };
    }
    logMicrocompactTraceSummary(options.taskId, lightweightResult);

    return {
        ...lightweightResult,
        contextTokenEstimate,
        shouldCompact: shouldRunCompact,
        compacted,
        sessionMemoryCompacted,
        sessionMemoryCompactResult,
        sessionMemoryState,
        sessionMemoryStateChanged,
        autoCompactDecision,
        autoCompactState: autoCompactStateTarget ?? autoCompactState,
        autoCompactStateChanged
    };
}
