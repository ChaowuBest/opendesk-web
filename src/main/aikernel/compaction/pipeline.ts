import { compactContext, shouldCompact } from '../compact.js';
import { ChatContext } from '../messages.js';
import { buildActiveContextView } from './context-view.js';
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

    return {
        activeContext: buildActiveContextView(chatContext),
        shouldCompact: shouldRunCompact,
        compacted
    };
}
