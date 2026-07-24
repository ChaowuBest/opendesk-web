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

import { buildVisibleAssistantRounds } from '../compaction/assistant-rounds.js';
import {
    estimateSystemPromptTokens,
    estimateTextTokens,
    estimateToolResultObjectTokens
} from '../compaction/token-estimation.js';
import { AssistantMessage, CompactSeparatorMessage, UserMessage } from '../messages.js';
import type { ToolCall } from '../messages.js';
import type { BaseTool, BaseToolset } from '../tool.js';
import type { AssistantRound } from '../compaction/types.js';
import type {
    ContextAssistantRoundInfo,
    ContextCategory,
    ContextDiagnosticsInput,
    ContextDiagnosticsReport,
    ContextMessageBreakdown,
    ContextToolsetCategory
} from './types.js';

function estimateToolTokens(toolId: string, tool: BaseTool<any>): number {
    return (
        estimateTextTokens(toolId) +
        estimateTextTokens(tool.description) +
        estimateTextTokens(JSON.stringify(tool.params.toJSONSchema()))
    );
}

function estimateToolsetTokens(toolsetName: string, toolset: BaseToolset): ContextToolsetCategory {
    let tokens = 0;
    for (const [toolName, tool] of toolset.tools.entries()) {
        tokens += estimateToolTokens(`${toolsetName}-${toolName}`, tool);
    }

    return {
        name: toolsetName,
        tokens,
        toolCount: toolset.tools.size
    };
}

function resolveVisibleToolResultText(
    toolcall: ToolCall,
    toolResultOverrides?: ReadonlyMap<string, string>
): string | undefined {
    const resultId = toolcall.result_storage?.result_id;
    if (typeof resultId === 'string' && resultId.length > 0) {
        const overrideContent = toolResultOverrides?.get(resultId);
        if (typeof overrideContent === 'string' && overrideContent.length > 0) {
            return overrideContent;
        }
    }

    if (toolcall.hasLegacyCompressId()) {
        return toolcall.getLegacyCompressedResultText();
    }

    if (toolcall.status === 'error') {
        return `Toolcall failed: ${toolcall.result ?? ''}`;
    }

    if (toolcall.status === 'success') {
        return toolcall.result ?? '工具调用成功完成';
    }

    return undefined;
}

function countUserMessageTokens(
    message: UserMessage
): Pick<ContextMessageBreakdown, 'userTextTokens' | 'userFileTokens' | 'userImageTokens'> {
    let userTextTokens = 0;
    let userFileTokens = 0;
    let userImageTokens = 0;

    for (const part of message.content) {
        if (part.type === 'text') {
            userTextTokens += estimateTextTokens(part.text);
        } else if (part.type === 'file') {
            userFileTokens += estimateTextTokens(part.path);
        } else if (part.type === 'image_url') {
            userImageTokens += 256;
        }
    }

    return { userTextTokens, userFileTokens, userImageTokens };
}

function countAssistantRoundTokens(
    round: AssistantRound,
    toolResultOverrides?: ReadonlyMap<string, string>
): Pick<
    ContextMessageBreakdown,
    'assistantTextTokens' | 'assistantReasoningTokens' | 'assistantToolCallTokens' | 'assistantToolResultTokens'
> {
    let assistantTextTokens = 0;
    let assistantReasoningTokens = 0;
    let assistantToolCallTokens = 0;
    let assistantToolResultTokens = 0;

    for (const part of round.parts) {
        if (part.type === 'text') {
            assistantTextTokens += estimateTextTokens(part.text);
            continue;
        }

        if (part.type === 'reasoning') {
            assistantReasoningTokens += estimateTextTokens(part.content);
            continue;
        }

        if (part.type !== 'tool_call') {
            continue;
        }

        for (const toolcall of part.toolcalls) {
            assistantToolCallTokens += estimateTextTokens(toolcall.tool_name);
            assistantToolCallTokens += estimateTextTokens(toolcall.args_string);
            assistantToolCallTokens += estimateToolResultObjectTokens(toolcall);

            const visibleResultText = resolveVisibleToolResultText(toolcall, toolResultOverrides);
            if (visibleResultText !== undefined) {
                assistantToolResultTokens += estimateTextTokens(visibleResultText);
            }
        }
    }

    return {
        assistantTextTokens,
        assistantReasoningTokens,
        assistantToolCallTokens,
        assistantToolResultTokens
    };
}

function countMessageBreakdown(input: ContextDiagnosticsInput): {
    breakdown: ContextMessageBreakdown;
    projectedItemCount: number;
    assistantRounds: ContextAssistantRoundInfo[];
} {
    const activeContext = input.inspection.activeContext;
    const visibleAssistantRounds = buildVisibleAssistantRounds(activeContext);
    const breakdown: ContextMessageBreakdown = {
        userTextTokens: 0,
        userFileTokens: 0,
        userImageTokens: 0,
        assistantTextTokens: 0,
        assistantReasoningTokens: 0,
        assistantToolCallTokens: 0,
        assistantToolResultTokens: 0,
        compactBoundaryTokens: 0
    };

    let projectedItemCount = 0;
    const assistantRounds: ContextAssistantRoundInfo[] = [];

    for (const message of activeContext.messages) {
        if (message instanceof CompactSeparatorMessage) {
            breakdown.compactBoundaryTokens += estimateTextTokens(message.summary);
            projectedItemCount += 1;
            continue;
        }

        if (message instanceof UserMessage) {
            const userTokens = countUserMessageTokens(message);
            breakdown.userTextTokens += userTokens.userTextTokens;
            breakdown.userFileTokens += userTokens.userFileTokens;
            breakdown.userImageTokens += userTokens.userImageTokens;
            projectedItemCount += 1;
            continue;
        }

        if (message instanceof AssistantMessage) {
            const roundsForMessage = visibleAssistantRounds.filter((round) => round.message === message);
            projectedItemCount += roundsForMessage.length;
            for (const round of roundsForMessage) {
                const roundTokens = countAssistantRoundTokens(round.round, input.inspection.toolResultOverrides);
                assistantRounds.push({
                    messageIndex: round.messageIndex,
                    roundIndex: round.roundRef.roundIndex,
                    kind: round.round.kind,
                    startPartIndex: round.roundRef.startPartIndex,
                    endPartIndexExclusive: round.roundRef.endPartIndexExclusive,
                    toolCallCount: round.round.toolCallCount
                });
                breakdown.assistantTextTokens += roundTokens.assistantTextTokens;
                breakdown.assistantReasoningTokens += roundTokens.assistantReasoningTokens;
                breakdown.assistantToolCallTokens += roundTokens.assistantToolCallTokens;
                breakdown.assistantToolResultTokens += roundTokens.assistantToolResultTokens;
            }
        }
    }

    return { breakdown, projectedItemCount, assistantRounds };
}

function estimateToolsTokens(chatContext: ContextDiagnosticsInput['chatContext']): number {
    return Array.from(chatContext.toolsets.entries()).reduce(
        (total, [toolsetName, toolset]) => total + estimateToolsetTokens(toolsetName, toolset).tokens,
        0
    );
}

function buildToolsetCategories(chatContext: ContextDiagnosticsInput['chatContext']): ContextToolsetCategory[] {
    return Array.from(chatContext.toolsets.entries()).map(([toolsetName, toolset]) =>
        estimateToolsetTokens(toolsetName, toolset)
    );
}

export function analyzeContextDiagnostics(input: ContextDiagnosticsInput): ContextDiagnosticsReport {
    const { breakdown, projectedItemCount, assistantRounds } = countMessageBreakdown(input);
    const systemPromptTokens = estimateSystemPromptTokens(input.chatContext.system_prompt);
    const toolTokens = estimateToolsTokens(input.chatContext);
    const toolsetCategories = buildToolsetCategories(input.chatContext);
    const messagesTokens =
        breakdown.userTextTokens +
        breakdown.userFileTokens +
        breakdown.userImageTokens +
        breakdown.assistantTextTokens +
        breakdown.assistantReasoningTokens +
        breakdown.assistantToolCallTokens +
        breakdown.assistantToolResultTokens +
        breakdown.compactBoundaryTokens;

    const totalEstimatedTokens = input.inspection.contextTokenEstimate.estimatedContextTokens;
    const contextWindow = input.inspection.autoCompactDecision.contextWindow;
    const categories: ContextCategory[] = [
        { name: 'System prompt', tokens: systemPromptTokens },
        { name: 'Tools', tokens: toolTokens },
        { name: 'Messages', tokens: messagesTokens },
        { name: 'Free space', tokens: Math.max(contextWindow - totalEstimatedTokens, 0) }
    ];

    return {
        modelName: input.modelName,
        contextWindow,
        totalEstimatedTokens,
        usageRatio: input.inspection.autoCompactDecision.windowUsageRatio,
        contextTokenEstimate: {
            estimatedContextTokens: input.inspection.contextTokenEstimate.estimatedContextTokens,
            baseUsageTokens: input.inspection.contextTokenEstimate.baseUsageTokens,
            tailEstimatedTokens: input.inspection.contextTokenEstimate.tailEstimatedTokens,
            assistantInternalTailTokens: input.inspection.contextTokenEstimate.assistantInternalTailTokens,
            source: input.inspection.contextTokenEstimate.source,
            usageAnchorMessageId: input.inspection.contextTokenEstimate.usageAnchorMessageId,
            usageAnchorMessageIndex: input.inspection.contextTokenEstimate.usageAnchorMessageIndex
        },
        categories,
        toolsetCategories,
        messageBreakdown: breakdown,
        activeContext: {
            startIndex: input.inspection.activeContext.startIndex,
            hasCompactBoundary: input.inspection.activeContext.boundary !== undefined,
            leadingPartialAssistant: input.inspection.activeContext.leadingPartialAssistant !== undefined,
            projectedItemCount
        },
        assistantRounds,
        compaction: {
            autoCompactDecision: input.inspection.autoCompactDecision,
            microcompactDecision: input.inspection.microcompactDecision,
            toolResultBudgetStats: input.inspection.toolResultBudgetStats
        }
    };
}
