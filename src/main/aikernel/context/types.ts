import type { ChatContext } from '../messages.js';
import type { PrepareContextOptions, PreparedContextResult } from '../compaction/types.js';

export interface ContextInspectOptions extends PrepareContextOptions {
    readonlyOnly?: boolean;
}

export type ContextInspectResult = PreparedContextResult;

export interface ContextInspectInput {
    chatContext: ChatContext;
    model?: string;
    options?: ContextInspectOptions;
}

export interface ContextCategory {
    name: string;
    tokens: number;
}

export interface ContextToolsetCategory {
    name: string;
    tokens: number;
    toolCount: number;
}

export interface ContextAssistantRoundInfo {
    messageIndex: number;
    roundIndex: number;
    kind: string;
    startPartIndex: number;
    endPartIndexExclusive: number;
    toolCallCount: number;
}

export interface ContextMessageBreakdown {
    userTextTokens: number;
    userFileTokens: number;
    userImageTokens: number;
    assistantTextTokens: number;
    assistantReasoningTokens: number;
    assistantToolCallTokens: number;
    assistantToolResultTokens: number;
    compactBoundaryTokens: number;
}

export interface ContextDiagnosticsInput {
    chatContext: ChatContext;
    inspection: ContextInspectResult;
    modelName?: string;
}

export interface ContextDiagnosticsReport {
    modelName?: string;
    contextWindow: number;
    totalEstimatedTokens: number;
    usageRatio?: number;
    contextTokenEstimate: ContextInspectResult['contextTokenEstimate'];
    categories: ContextCategory[];
    toolsetCategories: ContextToolsetCategory[];
    messageBreakdown: ContextMessageBreakdown;
    activeContext: {
        startIndex: number;
        hasCompactBoundary: boolean;
        leadingPartialAssistant: boolean;
        projectedItemCount: number;
    };
    assistantRounds: ContextAssistantRoundInfo[];
    compaction: {
        autoCompactDecision: ContextInspectResult['autoCompactDecision'];
        microcompactDecision?: ContextInspectResult['microcompactDecision'];
        toolResultBudgetStats?: ContextInspectResult['toolResultBudgetStats'];
    };
}
