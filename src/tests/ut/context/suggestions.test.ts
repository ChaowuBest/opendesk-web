import { createAutoCompactDecision } from '../../../main/aikernel/compaction/auto-compact';
import { generateContextSuggestions, type ContextSuggestion } from '../../../main/aikernel/context/suggestions';
import type { ContextDiagnosticsReport } from '../../../main/aikernel/context/types';

function buildReport(
    overrides: Partial<ContextDiagnosticsReport> = {},
    compactionOverrides: Partial<ContextDiagnosticsReport['compaction']> = {}
): ContextDiagnosticsReport {
    const autoCompactDecision = createAutoCompactDecision({
        contextWindow: 10_000,
        estimatedContextTokens: 2_000,
        reservedSummaryOutput: 100,
        buffer: 0
    });

    const base: ContextDiagnosticsReport = {
        modelName: 'demo-model',
        contextWindow: 10_000,
        totalEstimatedTokens: 2_000,
        usageRatio: autoCompactDecision.windowUsageRatio,
        categories: [
            { name: 'System prompt', tokens: 300 },
            { name: 'Tools', tokens: 100 },
            { name: 'Messages', tokens: 1_600 },
            { name: 'Free space', tokens: 8_000 }
        ],
        messageBreakdown: {
            userTextTokens: 400,
            userFileTokens: 0,
            userImageTokens: 0,
            assistantTextTokens: 400,
            assistantReasoningTokens: 200,
            assistantToolCallTokens: 200,
            assistantToolResultTokens: 400,
            compactBoundaryTokens: 0
        },
        activeContext: {
            startIndex: 0,
            hasCompactBoundary: false,
            leadingPartialAssistant: false,
            projectedItemCount: 2
        },
        compaction: {
            autoCompactDecision,
            microcompactDecision: undefined,
            toolResultBudgetStats: undefined
        }
    };

    return {
        ...base,
        ...overrides,
        categories: overrides.categories ?? base.categories,
        messageBreakdown: overrides.messageBreakdown ?? base.messageBreakdown,
        activeContext: overrides.activeContext ?? base.activeContext,
        compaction: {
            ...base.compaction,
            ...overrides.compaction,
            ...compactionOverrides
        }
    };
}

function expectSingleSuggestion(
    report: ContextDiagnosticsReport,
    suggestion: Pick<ContextSuggestion, 'id' | 'severity' | 'title'>
) {
    const suggestions = generateContextSuggestions(report);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject(suggestion);
}

describe('context suggestions', () => {
    test('returns no suggestions for a healthy context', () => {
        const suggestions = generateContextSuggestions(buildReport());
        expect(suggestions).toEqual([]);
    });

    test('warns when usage is near the auto compact threshold', () => {
        const report = buildReport({
            totalEstimatedTokens: 8_500,
            usageRatio: 0.85,
            categories: [
                { name: 'System prompt', tokens: 300 },
                { name: 'Tools', tokens: 100 },
                { name: 'Messages', tokens: 8_100 },
                { name: 'Free space', tokens: 1_500 }
            ],
            activeContext: {
                startIndex: 0,
                hasCompactBoundary: false,
                leadingPartialAssistant: false,
                projectedItemCount: 2
            },
            compaction: {
                autoCompactDecision: createAutoCompactDecision({
                    contextWindow: 10_000,
                    estimatedContextTokens: 8_500,
                    reservedSummaryOutput: 100,
                    buffer: 0
                }),
                microcompactDecision: undefined,
                toolResultBudgetStats: undefined
            }
        });

        expectSingleSuggestion(report, {
            id: 'near-auto-compact-threshold',
            severity: 'warn',
            title: '接近自动压缩阈值'
        });
    });

    test('warns when tool results dominate the message budget', () => {
        const report = buildReport({
            totalEstimatedTokens: 3_000,
            usageRatio: 0.3,
            categories: [
                { name: 'System prompt', tokens: 300 },
                { name: 'Tools', tokens: 100 },
                { name: 'Messages', tokens: 2_700 },
                { name: 'Free space', tokens: 7_000 }
            ],
            messageBreakdown: {
                userTextTokens: 200,
                userFileTokens: 0,
                userImageTokens: 0,
                assistantTextTokens: 200,
                assistantReasoningTokens: 100,
                assistantToolCallTokens: 200,
                assistantToolResultTokens: 2_000,
                compactBoundaryTokens: 0
            },
            compaction: {
                autoCompactDecision: createAutoCompactDecision({
                    contextWindow: 10_000,
                    estimatedContextTokens: 3_000,
                    reservedSummaryOutput: 100,
                    buffer: 0
                })
            }
        });
        report.compaction.toolResultBudgetStats = {
            overBudgetGroupCount: 1
        } as any;

        expectSingleSuggestion(report, {
            id: 'tool-results-overweight',
            severity: 'warn',
            title: '工具结果过大'
        });
    });

    test('warns when the system prompt is too large', () => {
        const report = buildReport({
            contextWindow: 20_000,
            totalEstimatedTokens: 9_000,
            usageRatio: 0.45,
            categories: [
                { name: 'System prompt', tokens: 7_200 },
                { name: 'Tools', tokens: 100 },
                { name: 'Messages', tokens: 1_700 },
                { name: 'Free space', tokens: 11_000 }
            ],
            compaction: {
                autoCompactDecision: createAutoCompactDecision({
                    contextWindow: 20_000,
                    estimatedContextTokens: 9_000,
                    reservedSummaryOutput: 100,
                    buffer: 0
                }),
                microcompactDecision: undefined,
                toolResultBudgetStats: undefined
            }
        });

        expectSingleSuggestion(report, {
            id: 'system-prompt-overweight',
            severity: 'warn',
            title: '系统提示过大'
        });
    });

    test('warns when the compact summary is too large', () => {
        const report = buildReport({
            totalEstimatedTokens: 4_000,
            usageRatio: 0.4,
            categories: [
                { name: 'System prompt', tokens: 300 },
                { name: 'Tools', tokens: 100 },
                { name: 'Messages', tokens: 3_700 },
                { name: 'Free space', tokens: 6_000 }
            ],
            messageBreakdown: {
                userTextTokens: 1_000,
                userFileTokens: 0,
                userImageTokens: 0,
                assistantTextTokens: 500,
                assistantReasoningTokens: 200,
                assistantToolCallTokens: 300,
                assistantToolResultTokens: 200,
                compactBoundaryTokens: 1_500
            },
            activeContext: {
                startIndex: 1,
                hasCompactBoundary: true,
                leadingPartialAssistant: false,
                projectedItemCount: 3
            }
        });

        expectSingleSuggestion(report, {
            id: 'compact-summary-overweight',
            severity: 'warn',
            title: '压缩摘要过大'
        });
    });

    test('keeps the suggestion order stable when multiple signals overlap', () => {
        const report = buildReport({
            totalEstimatedTokens: 9_200,
            usageRatio: 0.92,
            categories: [
                { name: 'System prompt', tokens: 7_400 },
                { name: 'Tools', tokens: 100 },
                { name: 'Messages', tokens: 1_700 },
                { name: 'Free space', tokens: 800 }
            ],
            messageBreakdown: {
                userTextTokens: 100,
                userFileTokens: 0,
                userImageTokens: 0,
                assistantTextTokens: 100,
                assistantReasoningTokens: 50,
                assistantToolCallTokens: 50,
                assistantToolResultTokens: 1_500,
                compactBoundaryTokens: 1_200
            },
            activeContext: {
                startIndex: 1,
                hasCompactBoundary: true,
                leadingPartialAssistant: false,
                projectedItemCount: 4
            },
            compaction: {
                autoCompactDecision: createAutoCompactDecision({
                    contextWindow: 10_000,
                    estimatedContextTokens: 9_200,
                    reservedSummaryOutput: 100,
                    buffer: 0
                })
            }
        });
        report.compaction.toolResultBudgetStats = {
            overBudgetGroupCount: 1
        } as any;

        expect(generateContextSuggestions(report).map((suggestion) => suggestion.id)).toEqual([
            'near-auto-compact-threshold',
            'tool-results-overweight',
            'system-prompt-overweight',
            'compact-summary-overweight'
        ]);
    });
});
