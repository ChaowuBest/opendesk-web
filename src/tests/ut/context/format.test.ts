import { createAutoCompactDecision } from '../../../main/aikernel/compaction/auto-compact';
import { formatContextDiagnosticsReport } from '../../../main/aikernel/context/format';
import type { ContextSuggestion } from '../../../main/aikernel/context/suggestions';
import type { ContextDiagnosticsReport } from '../../../main/aikernel/context/types';

function buildReport(overrides: Partial<ContextDiagnosticsReport> = {}): ContextDiagnosticsReport {
    const autoCompactDecision = createAutoCompactDecision({
        contextWindow: 10_000,
        estimatedContextTokens: 8_500,
        reservedSummaryOutput: 100,
        buffer: 0
    });

    const base: ContextDiagnosticsReport = {
        modelName: 'demo-model',
        contextWindow: 10_000,
        totalEstimatedTokens: 8_500,
        usageRatio: autoCompactDecision.windowUsageRatio,
        contextTokenEstimate: {
            estimatedContextTokens: 8_500,
            baseUsageTokens: 7_600,
            tailEstimatedTokens: 500,
            assistantInternalTailTokens: 400,
            source: 'usage_plus_tail_estimate',
            usageAnchorMessageId: 'msg-1',
            usageAnchorMessageIndex: 2
        } as any,
        categories: [
            { name: 'System prompt', tokens: 1_200 },
            { name: 'Tools', tokens: 800 },
            { name: 'Messages', tokens: 6_500 },
            { name: 'Free space', tokens: 1_500 }
        ],
        toolsetCategories: [{ name: 'demo', tokens: 800, toolCount: 2 }],
        messageBreakdown: {
            userTextTokens: 1_000,
            userFileTokens: 200,
            userImageTokens: 0,
            assistantTextTokens: 2_000,
            assistantReasoningTokens: 500,
            assistantToolCallTokens: 1_000,
            assistantToolResultTokens: 1_500,
            compactBoundaryTokens: 300
        },
        activeContext: {
            startIndex: 2,
            hasCompactBoundary: true,
            leadingPartialAssistant: false,
            projectedItemCount: 6
        },
        assistantRounds: [
            {
                messageIndex: 1,
                roundIndex: 0,
                kind: 'tool_call_batch',
                startPartIndex: 0,
                endPartIndexExclusive: 2,
                toolCallCount: 1
            }
        ],
        compaction: {
            autoCompactDecision,
            microcompactDecision: {
                mode: 'local_clear',
                reason: 'cold_path_local_clear',
                selectedResultIds: ['result-old'],
                keptRecentResultIds: ['result-new'],
                estimatedCharsBefore: 9_000,
                estimatedCharsAfter: 2_100,
                estimatedCharsSaved: 6_900
            },
            toolResultBudgetStats: {
                groupCount: 2,
                candidateCount: 3,
                skippedCount: 0,
                freshCount: 1,
                frozenCount: 1,
                mustReapplyCount: 1,
                unstableResultIdCount: 0,
                totalSizeChars: 9_000,
                totalProjectedChars: 2_100,
                skippedByReason: {},
                overrideCount: 2,
                reappliedCount: 1,
                newlySelectedCount: 1,
                newlySeenCount: 3,
                stableIdsCreatedCount: 0,
                persistedCount: 1,
                overBudgetGroupCount: 1,
                unshrinkableFreshCount: 0,
                totalProjectedCharsAfterSelection: 2_100
            } as any
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
            ...overrides.compaction
        }
    };
}

describe('context diagnostics formatter', () => {
    test('renders the expected summary sections', () => {
        const report = buildReport();
        const suggestions: ContextSuggestion[] = [
            {
                id: 'near-auto-compact-threshold',
                severity: 'warn',
                title: 'Near auto compact threshold',
                detail: 'The current context is approaching the auto compact threshold.'
            },
            {
                id: 'tool-results-overweight',
                severity: 'warn',
                title: 'Tool results are too large',
                detail: 'Tool results are consuming too much of the message budget.'
            }
        ];

        const text = formatContextDiagnosticsReport(report, suggestions);

        expect(text).toContain('Model: demo-model');
        expect(text).toContain('Context window: 10,000 tokens');
        expect(text).toContain('Estimated usage: 8,500 / 10,000 tokens (85.0%)');
        expect(text).toContain('Context estimate: 7,600 + 500 + 400 (usage_plus_tail_estimate)');
        expect(text).toContain('Context strategy');
        expect(text).toContain('- compact boundary: yes');
        expect(text).toContain('- auto compact: should compact (at or above threshold)');
        expect(text).toContain('- reserved summary output: 100 tokens');
        expect(text).toContain('- effective window: 9,900 tokens');
        expect(text).toContain('- buffer: 0 tokens');
        expect(text).toContain('- auto compact threshold: 8,000 tokens');
        expect(text).toContain('- window usage ratio: 85.0%');
        expect(text).toContain('- margin tokens: -500');
        expect(text).toContain('- microcompact: local_clear');
        expect(text).toContain('- tool result budget: enabled (groups: 2, over budget groups: 1)');
        expect(text).toContain('Categories');
        expect(text).toContain('- System prompt: 1,200 tokens');
        expect(text).toContain('Toolsets');
        expect(text).toContain('- demo: 800 tokens (2 tools)');
        expect(text).toContain('Assistant rounds');
        expect(text).toContain('- message 1 round 0: tool_call_batch (0-2, tools: 1)');
        expect(text).toContain('- Free space: 1,500 tokens');
        expect(text).toContain('Message breakdown');
        expect(text).toContain('- User text: 1,000 tokens');
        expect(text).toContain('- Assistant tool results: 1,500 tokens');
        expect(text).toContain('- Compact summary: 300 tokens');
        expect(text).toContain('Suggestions');
        expect(text).toContain('1. [warn] Near auto compact threshold');
        expect(text).toContain('2. [warn] Tool results are too large');
    });

    test('renders an empty suggestion state', () => {
        const text = formatContextDiagnosticsReport(buildReport(), []);

        expect(text).toContain('Suggestions');
        expect(text).toContain('- none');
    });
});
