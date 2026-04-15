import { ChatContext, isCompactBoundaryMessage } from '../messages.js';
import type { ActiveContextView } from './types.js';

/**
 * 根据最近一次 compact boundary 构建当前模型可见的活跃上下文视图。
 */
export function buildActiveContextView(chatContext: ChatContext): ActiveContextView {
    chatContext.deduplicateCompactBoundaries();
    const boundary = chatContext.findCompactBoundary();
    const startIndex = boundary ? boundary.index : 0;

    return {
        startIndex,
        messages: chatContext.messages.slice(startIndex),
        boundary
    };
}

export function countNonBoundaryMessages(chatContext: ChatContext): number {
    return chatContext.messages.filter((message) => !isCompactBoundaryMessage(message)).length;
}

export function countNonSeparatorMessages(chatContext: ChatContext): number {
    return countNonBoundaryMessages(chatContext);
}
