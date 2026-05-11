import { formatContextDiagnosticsReport } from '../../../../main/aikernel/context/format';
import { openContextDataPage, openContextVisualPage } from '../../../../main/tui/components/context';
import type { ContextDiagnosticsReport } from '../../../../main/aikernel/context/types';
import { jest } from '@jest/globals';

function buildReport(): ContextDiagnosticsReport {
    return {
        modelName: 'glm-5.1',
        contextWindow: 200_000,
        totalEstimatedTokens: 76_900,
        usageRatio: 0.3845,
        contextTokenEstimate: {
            estimatedContextTokens: 76_900,
            baseUsageTokens: 68_000,
            tailEstimatedTokens: 5_000,
            assistantInternalTailTokens: 3_900,
            source: 'usage_plus_tail_estimate'
        } as any,
        categories: [
            { name: 'System prompt', tokens: 684 },
            { name: 'Tools', tokens: 800 },
            { name: 'Messages', tokens: 75_416 },
            { name: 'Free space', tokens: 123_100 }
        ],
        toolsetCategories: [{ name: 'demo', tokens: 800, toolCount: 2 }],
        messageBreakdown: {
            userTextTokens: 0,
            userFileTokens: 0,
            userImageTokens: 0,
            assistantTextTokens: 0,
            assistantReasoningTokens: 0,
            assistantToolCallTokens: 0,
            assistantToolResultTokens: 0,
            compactBoundaryTokens: 0
        },
        activeContext: {
            startIndex: 0,
            hasCompactBoundary: false,
            leadingPartialAssistant: false,
            projectedItemCount: 0
        },
        assistantRounds: [],
        compaction: {
            autoCompactDecision: {
                shouldCompact: false,
                reason: 'below_threshold',
                estimatedContextTokens: 76_900,
                baseUsageTokens: 68_000,
                tailEstimatedTokens: 5_000,
                assistantInternalTailTokens: 3_900,
                contextWindow: 200_000,
                reservedSummaryOutput: 100,
                effectiveWindow: 199_900,
                buffer: 0,
                autoCompactThreshold: 180_000,
                windowUsageRatio: 0.3845,
                marginTokens: 123_100
            } as any,
            microcompactDecision: undefined,
            toolResultBudgetStats: undefined
        }
    };
}

describe('context visual page', () => {
    test('renders a circle grid with a legend instead of the old card stack', () => {
        const showTextPage = jest.fn();
        const tui = {
            tui: { terminal: { columns: 120 } },
            showTextPage
        } as any;

        openContextVisualPage(tui, buildReport(), [
            {
                id: 'read-results',
                severity: 'info',
                title: 'Read results using 37.7k tokens',
                detail: 'Use offset and limit parameters to read only the sections you need.'
            },
            {
                id: 'tool-results-heavy',
                severity: 'warn',
                title: 'Tool results are too large',
                detail: 'Use summary paths when the full payload is not needed.'
            }
        ]);

        expect(showTextPage).toHaveBeenCalledTimes(1);
        const [title, body] = showTextPage.mock.calls[0];
        expect(title).toBe('Context Usage');
        const plain = body.replace(/\x1B\[[0-9;]*m/g, '');
        const gridRows = plain.split('\n').filter((line) => (line.match(/[○◉]/g) ?? []).length >= 10);
        expect(gridRows).toHaveLength(10);
        expect(plain).toContain('Model: glm-5.1');
        expect(plain).toContain('76.9k/200k tokens (38.5%)');
        expect(body).toContain('Estimated usage by category');
        expect(body).toContain('Suggestions');
        expect(plain).toContain('System prompt');
        expect(plain).toContain('Tools');
        expect(plain).toContain('Messages');
        expect(plain).toContain('Free space');
        expect(plain).toContain('Read results using 37.7k tokens');
        expect(plain).toContain('+1 more');
        expect(plain).not.toContain('Context Strategy');
        expect(plain).not.toContain('Context Estimate');
        expect(plain).not.toContain('Auto Compact');
        expect(plain).not.toContain('Toolsets');
        expect(plain).not.toContain('Assistant Rounds');
        expect(plain.split('\n').length).toBeLessThanOrEqual(12);
    });

    test('keeps the raw data page on the detailed formatter path', () => {
        const showTextPage = jest.fn();
        const tui = {
            showTextPage
        } as any;
        const report = buildReport();
        const suggestions = [
            {
                id: 'read-results',
                severity: 'info' as const,
                title: 'Read results using 37.7k tokens',
                detail: 'Use offset and limit parameters to read only the sections you need.'
            }
        ];

        openContextDataPage(tui, report, suggestions);

        expect(showTextPage).toHaveBeenCalledWith(
            'Context Diagnostics',
            formatContextDiagnosticsReport(report, suggestions)
        );
    });
});
