import { compactContext, shouldCompact } from '../compact.js';
import { ChatContext } from '../messages.js';
import { buildActiveContextView } from './context-view.js';
import { buildToolResultBudgetProjectionForChatContext } from './tool-results.js';
import type { PrepareContextOptions, PreparedContextResult } from './types.js';

/**
 * 统一的 query 前准备入口：
 * - 规范化 compact separator
 * - 判断是否需要自动压缩
 * - 在需要时执行压缩（可由调用方注入 UI 包装）
 * - 返回最新的活跃上下文视图
 */
export async function prepareContextForModel(
    chatContext: ChatContext,
    model?: string,
    options: PrepareContextOptions = {}
): Promise<PreparedContextResult> {
    chatContext.deduplicateCompactBoundaries();

    const shouldRunCompact = await shouldCompact(chatContext, model);
    let compacted = false;

    if (shouldRunCompact) {
        options.beforeCompact?.();
        if (options.executeCompact) {
            await options.executeCompact();
        } else {
            await compactContext(chatContext, model);
        }
        compacted = true;
    }

    if (options.enableToolResultBudget && options.taskId && options.toolResultReplacementState) {
        const projection = buildToolResultBudgetProjectionForChatContext(
            chatContext,
            options.taskId,
            options.toolResultReplacementState,
            {
                groupBudgetChars: options.toolResultBudgetChars,
                previewOptions: options.toolResultBudgetPreviewOptions,
                skipToolNames: options.skipToolNames
            }
        );
        const stats = projection.stats;
        return {
            activeContext: projection.activeContext,
            shouldCompact: shouldRunCompact,
            compacted,
            budgetApplied: true,
            toolResultOverrides: projection.overrides,
            toolResultReplacementState: projection.replacementState,
            toolResultBudgetStats: stats,
            toolResultStateChanged:
                stats.newlySeenCount > 0 || stats.newlySelectedCount > 0 || stats.stableIdsCreatedCount > 0
        };
    }

    return {
        activeContext: buildActiveContextView(chatContext),
        shouldCompact: shouldRunCompact,
        compacted,
        budgetApplied: false,
        toolResultOverrides: new Map<string, string>(),
        toolResultReplacementState: options.toolResultReplacementState,
        toolResultBudgetStats: undefined,
        toolResultStateChanged: false
    };
}
