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

import { ChatContext, ToolCall } from './messages.js';
import { logger } from '../utils/logger.js';
import { HookRegistry } from './hooks.js';
import type { TaskState } from './states/tasks.js';
import { countNonBoundaryMessages } from './compaction/context-view.js';
import { getAutoCompactDecision } from './compaction/auto-compact.js';
import { describeCompactPlanVariant, logCompactInfo } from './compaction/compact-trace.js';
import { compactFullContext, type FullCompactRunOptions } from './compaction/full-compact.js';
import {
    buildToolResultReplacementText,
    getToolResultArtifactPath,
    isToolResultCompressionExcluded,
    persistToolResultForToolCall,
    truncateToolResultForPreview
} from './compaction/tool-results.js';

/**
 * 上下文压缩主入口：使用 tail-preserving full compact。
 *
 * @returns 是否实际执行了压缩操作
 */
export interface CompactContextRunOptions extends FullCompactRunOptions {
    taskId?: string;
}

export async function compactContext(
    chatContext: ChatContext,
    model?: string,
    options: CompactContextRunOptions = {}
): Promise<boolean> {
    chatContext.deduplicateCompactBoundaries();
    const enableAssistantRoundBoundary = options.enableAssistantRoundBoundary !== false;
    const totalMessages = countNonBoundaryMessages(chatContext);
    const trigger = options.trigger ?? 'manual';
    logCompactInfo(options.taskId, {
        source: 'compact',
        event: 'assistant_round_boundary_default',
        message: `[Compact Step9] assistant round boundary default=${enableAssistantRoundBoundary}, trigger=${trigger}`,
        data: {
            enableAssistantRoundBoundary,
            trigger
        }
    });
    logCompactInfo(options.taskId, {
        source: 'compact',
        event: 'full_compact_started',
        message: `[Compact] starting tail-preserving full compact, totalMessages=${totalMessages}, trigger=${trigger}`,
        data: {
            totalMessages,
            trigger
        }
    });

    const runResult = await compactFullContext(chatContext, model, {
        ...options,
        trigger,
        enableAssistantRoundBoundary
    });

    if (!runResult.compacted || !runResult.plan) {
        logCompactInfo(options.taskId, {
            source: 'compact',
            event: 'full_compact_noop',
            message: '[Compact] full compact skipped because the context does not satisfy compact conditions'
        });
        return false;
    }

    const compactVariant = describeCompactPlanVariant(runResult.plan);
    logCompactInfo(options.taskId, {
        source: 'compact',
        event: 'full_compact_completed',
        message:
            `[Compact] tail-preserving full compact completed, ` +
            `variant=${compactVariant.compactVariant}, ` +
            `summaryLength=${runResult.summary?.length ?? 0}, ` +
            `summarized=${runResult.plan.messagesToSummarize.length}, ` +
            `kept=${runResult.plan.messagesToKeep.length}`,
        data: {
            summaryLength: runResult.summary?.length ?? 0,
            summarizedMessages: runResult.plan.messagesToSummarize.length,
            keptMessages: runResult.plan.messagesToKeep.length,
            ...compactVariant
        }
    });
    logCompactInfo(options.taskId, {
        source: 'compact',
        event: 'keep_anchor_selected',
        message:
            `[Compact Step9] applied compact variant=${compactVariant.compactVariant}, ` +
            `recentUserPreserved=${compactVariant.recentUserPreserved}, ` +
            `keepAnchorKind=${compactVariant.keepAnchorKind}` +
            (compactVariant.keepAnchorKind === 'assistant_round'
                ? `, messageId=${compactVariant.keepAnchorMessageId}, ` +
                  `roundIndex=${compactVariant.kept_anchor_round_index}, ` +
                  `startPartIndex=${compactVariant.kept_anchor_start_part_index}`
                : ''),
        data: {
            ...compactVariant
        }
    });
    return true;
}

/**
 * 判断当前上下文是否需要压缩。
 */
export async function shouldCompact(chatContext: ChatContext, model?: string, taskId?: string): Promise<boolean> {
    const decision = await getAutoCompactDecision(chatContext, model);
    if (decision.shouldCompact) {
        logCompactInfo(taskId, {
            source: 'compact',
            event: 'auto_compact_threshold_reached',
            message:
                `[Compact] auto compact triggered: estimated_context_tokens=${decision.estimatedContextTokens}, ` +
                `threshold=${Math.floor(decision.autoCompactThreshold)} (` +
                `contextWindow=${decision.contextWindow}, ` +
                `reservedSummaryOutput=${decision.reservedSummaryOutput}, ` +
                `buffer=${decision.buffer}, ` +
                `baseUsageTokens=${decision.baseUsageTokens}, ` +
                `tailEstimatedTokens=${decision.tailEstimatedTokens}, ` +
                `assistantInternalTailTokens=${decision.assistantInternalTailTokens})`,
            data: {
                estimatedContextTokens: decision.estimatedContextTokens,
                autoCompactThreshold: Math.floor(decision.autoCompactThreshold),
                contextWindow: decision.contextWindow,
                reservedSummaryOutput: decision.reservedSummaryOutput,
                buffer: decision.buffer,
                baseUsageTokens: decision.baseUsageTokens,
                tailEstimatedTokens: decision.tailEstimatedTokens,
                assistantInternalTailTokens: decision.assistantInternalTailTokens,
                tokenEstimateSource: decision.tokenEstimateSource
            }
        });
    }
    return decision.shouldCompact;
}

// ─── 全局 afterToolCall：超长工具结果落盘并替换为摘要 ─────────────────────────────

function afterToolCallLargeResultToArtifact(task: TaskState, tool_call: ToolCall): void {
    if (isToolResultCompressionExcluded(tool_call.tool_name)) {
        return;
    }
    const result = tool_call.result;
    if (result === undefined || typeof result !== 'string') {
        return;
    }

    const preview = truncateToolResultForPreview(result);
    if (!preview) {
        return;
    }

    const previousResultStorage = tool_call.result_storage ? { ...tool_call.result_storage } : undefined;
    try {
        const resultId = tool_call.ensureResultStorage().result_id;
        const fullPath = getToolResultArtifactPath(task.task_id, resultId, true);
        const replacementText = buildToolResultReplacementText(preview.previewText, fullPath);
        const persisted = persistToolResultForToolCall(task.task_id, tool_call, result, replacementText);
        tool_call.result = persisted.metadata.replacement_text ?? replacementText;

        const sizeKB = (result.length / 1024).toFixed(1);
        const lineCount = result.split('\n').length;
        logCompactInfo(task.task_id, {
            source: 'compact',
            event: 'tool_result_persisted_to_artifact',
            message:
                `[Compact] large tool result persisted (${sizeKB} KB, ${lineCount} lines): ${persisted.fullPath} ` +
                `(tool=${tool_call.tool_name}, result_id=${persisted.metadata.result_id})`,
            data: {
                toolName: tool_call.tool_name,
                resultId: persisted.metadata.result_id,
                artifactPath: persisted.fullPath,
                sizeKB,
                lineCount
            }
        });
    } catch (err) {
        if (previousResultStorage) {
            tool_call.setResultStorage(previousResultStorage);
        } else {
            tool_call.clearResultStorage();
        }
        logger.error(`[Compact] 写入 artifact 失败: ${(err as Error)?.message ?? err}`);
        return;
    }
}

HookRegistry.afterToolCall(afterToolCallLargeResultToArtifact);
