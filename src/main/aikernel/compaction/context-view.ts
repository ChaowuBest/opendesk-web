import {
    AssistantMessage,
    ChatContext,
    UserMessage,
    isCompactBoundaryMessage,
    isDisplayOnlyMessage
} from '../messages.js';
import { buildAssistantRounds } from './assistant-rounds.js';
import type {
    ActiveContextView,
    ActiveContextLeadingPartialAssistant,
    CompactBoundaryRef,
    ProjectedActiveContextView,
    ProjectedContextItem
} from './types.js';

/**
 * 根据最近一次 compact boundary 构建当前模型可见的活跃上下文视图。
 */
export function buildActiveContextView(chatContext: ChatContext): ActiveContextView {
    chatContext.deduplicateCompactBoundaries();
    const boundary = chatContext.findCompactBoundary();
    const startIndex = boundary ? boundary.index : 0;
    const leadingPartialAssistant = boundary ? resolveLeadingPartialAssistant(chatContext, boundary) : undefined;

    return {
        startIndex,
        messages: chatContext.messages.slice(startIndex),
        boundary,
        leadingPartialAssistant
    };
}

function resolveLeadingPartialAssistant(
    chatContext: ChatContext,
    boundary: CompactBoundaryRef
): ActiveContextLeadingPartialAssistant | undefined {
    const anchorMessageId = boundary.message.metadata.kept_anchor_message_id;
    const anchorMessageIndex = boundary.message.metadata.kept_anchor_message_index;
    const anchorRoundIndex = boundary.message.metadata.kept_anchor_round_index;
    const anchorStartPartIndex = boundary.message.metadata.kept_anchor_start_part_index;

    if (typeof anchorRoundIndex !== 'number' || typeof anchorStartPartIndex !== 'number' || anchorStartPartIndex <= 0) {
        return undefined;
    }

    const boundaryEndIndex = boundary.index + 1;
    let candidateMessageIndex = -1;

    if (
        typeof anchorMessageIndex === 'number' &&
        anchorMessageIndex >= boundaryEndIndex &&
        anchorMessageIndex < chatContext.messages.length
    ) {
        const candidate = chatContext.messages[anchorMessageIndex];
        if (
            candidate instanceof AssistantMessage &&
            (anchorMessageId === undefined || candidate.message_id === anchorMessageId)
        ) {
            candidateMessageIndex = anchorMessageIndex;
        }
    }

    if (candidateMessageIndex < 0 && typeof anchorMessageId === 'string') {
        for (let index = boundaryEndIndex; index < chatContext.messages.length; index++) {
            const candidate = chatContext.messages[index];
            if (candidate instanceof AssistantMessage && candidate.message_id === anchorMessageId) {
                candidateMessageIndex = index;
                break;
            }
        }
    }

    if (candidateMessageIndex < 0) {
        return undefined;
    }

    const candidateMessage = chatContext.messages[candidateMessageIndex];
    if (!(candidateMessage instanceof AssistantMessage)) {
        return undefined;
    }

    const rounds = buildAssistantRounds(candidateMessage);
    const matchedRound =
        rounds.find(
            (round) => round.ref.roundIndex === anchorRoundIndex && round.ref.startPartIndex === anchorStartPartIndex
        ) ??
        rounds.find((round) => round.ref.startPartIndex === anchorStartPartIndex) ??
        rounds.find((round) => round.ref.roundIndex === anchorRoundIndex);
    if (!matchedRound || matchedRound.ref.startPartIndex <= 0) {
        return undefined;
    }

    return {
        message: candidateMessage,
        messageIndex: candidateMessageIndex,
        roundRef: matchedRound.ref
    };
}

function buildProjectedContextItems(activeContext: ActiveContextView): ProjectedContextItem[] {
    const projectedItems: ProjectedContextItem[] = [];

    for (let localIndex = 0; localIndex < activeContext.messages.length; localIndex++) {
        const message = activeContext.messages[localIndex];
        const messageIndex = activeContext.startIndex + localIndex;

        if (isCompactBoundaryMessage(message)) {
            const boundary: CompactBoundaryRef =
                activeContext.boundary && activeContext.boundary.index === messageIndex
                    ? activeContext.boundary
                    : { index: messageIndex, message };
            projectedItems.push({
                kind: 'compact_boundary',
                messageIndex,
                messageId: message.metadata.boundary_id,
                boundary,
                message
            });
            continue;
        }

        if (message instanceof UserMessage) {
            if (isDisplayOnlyMessage(message)) {
                continue;
            }
            projectedItems.push({
                kind: 'user_message',
                messageIndex,
                messageId: message.message_id,
                message
            });
            continue;
        }

        if (message instanceof AssistantMessage) {
            const leadingPartialAssistant = activeContext.leadingPartialAssistant;
            const rounds = buildAssistantRounds(message).filter((round) => {
                if (
                    leadingPartialAssistant === undefined ||
                    leadingPartialAssistant.message !== message ||
                    leadingPartialAssistant.messageIndex !== messageIndex
                ) {
                    return true;
                }
                return round.ref.startPartIndex >= leadingPartialAssistant.roundRef.startPartIndex;
            });
            for (const round of rounds) {
                projectedItems.push({
                    kind: 'assistant_round',
                    messageIndex,
                    messageId: message.message_id,
                    message,
                    round,
                    roundRef: round.ref
                });
            }
        }
    }

    return projectedItems;
}

/**
 * 构建旁路诊断用的 projected active context view。
 * 保留现有 ActiveContextView 不变，仅额外暴露 assistant 内部 round 级投影。
 */
export function buildProjectedActiveContextView(chatContext: ChatContext): ProjectedActiveContextView {
    const activeContext = buildActiveContextView(chatContext);
    return {
        ...activeContext,
        projectedItems: buildProjectedContextItems(activeContext)
    };
}

export function countNonBoundaryMessages(chatContext: ChatContext): number {
    return chatContext.messages.filter((message) => !isCompactBoundaryMessage(message)).length;
}
