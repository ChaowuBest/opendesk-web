import { compactContext } from '../compact.js';
import { ChatContext } from '../messages.js';
import { logger } from '../../utils/logger.js';
import { buildActiveContextView } from './context-view.js';
import { AutoCompactStates, getAutoCompactDecision, type AutoCompactState } from './auto-compact.js';
import { analyzeMicrocompactCandidates, applyLocalMicrocompactToChatContext } from './microcompact.js';
import { buildToolResultBudgetProjectionForChatContext } from './tool-results.js';
import type { PrepareContextOptions, PreparedContextResult } from './types.js';

type LightweightPreparationResult = Omit<
    PreparedContextResult,
    'shouldCompact' | 'compacted' | 'autoCompactDecision' | 'autoCompactState' | 'autoCompactStateChanged'
>;

function runLightweightPreparationLayers(
    chatContext: ChatContext,
    options: PrepareContextOptions = {}
): LightweightPreparationResult {
    let activeContext = buildActiveContextView(chatContext);
    let budgetApplied = false;
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
                skipToolNames: options.skipToolNames
            }
        );
        activeContext = projection.activeContext;
        budgetApplied = true;
        toolResultOverrides = projection.overrides;
        toolResultReplacementState = projection.replacementState;
        toolResultBudgetStats = projection.stats;
    }

    let microcompactAnalysis: PreparedContextResult['microcompactAnalysis'] = undefined;
    let microcompactAppliedCandidates: PreparedContextResult['microcompactAppliedCandidates'] = [];
    let microcompactStats: PreparedContextResult['microcompactStats'] = undefined;
    let microcompactApplied = false;
    let microcompactStateChanged = false;

    if (options.enableMicrocompact) {
        const analysis = analyzeMicrocompactCandidates(activeContext, {
            tailAssistantMessages: options.microcompactTailAssistantMessages,
            skipToolNames: options.microcompactSkipToolNames
        });

        if (options.taskId) {
            const microcompactResult = applyLocalMicrocompactToChatContext(chatContext, options.taskId, {
                analysis,
                skipResultIds: toolResultOverrides.keys()
            });
            activeContext = microcompactResult.activeContext;
            microcompactAnalysis = microcompactResult.analysis;
            microcompactAppliedCandidates = microcompactResult.appliedCandidates;
            microcompactStats = microcompactResult.stats;
            microcompactApplied = microcompactResult.appliedCandidates.length > 0;
            microcompactStateChanged = microcompactResult.stateChanged;
        } else {
            microcompactAnalysis = analysis;
            microcompactStats = analysis.stats;
        }
    }

    return {
        activeContext,
        budgetApplied,
        microcompactApplied,
        toolResultOverrides,
        toolResultReplacementState,
        toolResultBudgetStats,
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
 * - 再执行 Step 5 local microcompact
 * - 最后才判断是否需要旧的 full compact
 * - 如果 full compact 执行过，则重新跑一遍 Step 4/5，得到最终发给模型的上下文视图
 */
export async function prepareContextForModel(
    chatContext: ChatContext,
    model?: string,
    options: PrepareContextOptions = {}
): Promise<PreparedContextResult> {
    chatContext.deduplicateCompactBoundaries();

    let lightweightResult = runLightweightPreparationLayers(chatContext, options);
    const autoCompactDecision =
        options.autoCompactDecisionOverride ?? (await getAutoCompactDecision(chatContext, model));
    const autoCompactStateTarget = options.autoCompactState;
    let autoCompactState: AutoCompactState | undefined = autoCompactStateTarget
        ? AutoCompactStates.clone(autoCompactStateTarget)
        : undefined;
    let autoCompactStateChanged = false;
    const cooldownRemainingMs = autoCompactState ? AutoCompactStates.getCooldownRemainingMs(autoCompactState) : 0;
    const shouldRunCompact = autoCompactDecision.shouldCompact && cooldownRemainingMs <= 0;
    let compacted = false;

    if (autoCompactDecision.shouldCompact && cooldownRemainingMs > 0) {
        logger.info(
            `[Compact] auto-compact cooldown active: remaining=${cooldownRemainingMs}ms, ` +
                `failures=${autoCompactState?.consecutiveFailures ?? 0}, ` +
                `threshold=${autoCompactState?.failureThreshold ?? 0}, ` +
                `lastFailureReason=${autoCompactState?.lastFailureReason ?? 'unknown'}`
        );
    }

    const syncAutoCompactState = (nextState: AutoCompactState) => {
        autoCompactState = nextState;
        autoCompactStateChanged = true;
        if (autoCompactStateTarget) {
            Object.assign(autoCompactStateTarget, nextState);
        }
    };

    if (shouldRunCompact) {
        if (autoCompactState) {
            syncAutoCompactState(AutoCompactStates.recordAttempt(autoCompactState));
        }

        let compactApplied = true;
        try {
            options.beforeCompact?.();
            if (options.executeCompact) {
                const executeResult = await options.executeCompact();
                compactApplied = executeResult !== false;
            } else {
                compactApplied = await compactContext(chatContext, model, { trigger: 'auto' });
            }
        } catch (err) {
            if (autoCompactState) {
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

            if (autoCompactState) {
                syncAutoCompactState(AutoCompactStates.recordSuccess(autoCompactState));
            }

            const rerunOptions: PrepareContextOptions = {
                ...options,
                toolResultReplacementState: lightweightResult.toolResultReplacementState,
                autoCompactState: autoCompactStateTarget ?? autoCompactState
            };
            const rerunResult = runLightweightPreparationLayers(chatContext, rerunOptions);

            lightweightResult = {
                ...rerunResult,
                budgetApplied: lightweightResult.budgetApplied || rerunResult.budgetApplied,
                microcompactApplied: lightweightResult.microcompactApplied || rerunResult.microcompactApplied,
                microcompactAppliedCandidates: [
                    ...lightweightResult.microcompactAppliedCandidates,
                    ...rerunResult.microcompactAppliedCandidates
                ],
                toolResultStateChanged: lightweightResult.toolResultStateChanged || rerunResult.toolResultStateChanged,
                microcompactStateChanged:
                    lightweightResult.microcompactStateChanged || rerunResult.microcompactStateChanged
            };
        } else {
            logger.info('[Compact] auto compact returned no-op; keeping context unchanged');
        }
    }

    return {
        ...lightweightResult,
        shouldCompact: shouldRunCompact,
        compacted,
        autoCompactDecision,
        autoCompactState: autoCompactStateTarget ?? autoCompactState,
        autoCompactStateChanged
    };
}
