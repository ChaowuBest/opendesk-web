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

import type { ContextDiagnosticsReport } from './types.js';
import type { ContextSuggestion } from './suggestions.js';

function formatTokens(tokens: number): string {
    return Number.isFinite(tokens) ? tokens.toLocaleString('en-US') : '0';
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

function humanizeIdentifier(value: string): string {
    return value.replace(/_/g, ' ');
}

function formatYesNo(value: boolean): string {
    return value ? 'yes' : 'no';
}

export function formatContextDiagnosticsReport(
    report: ContextDiagnosticsReport,
    suggestions: ContextSuggestion[] = []
): string {
    const lines: string[] = [];
    const usageRatio =
        report.usageRatio ?? (report.contextWindow > 0 ? report.totalEstimatedTokens / report.contextWindow : 0);
    const autoCompactDecision = report.compaction.autoCompactDecision;
    const microcompactDecision = report.compaction.microcompactDecision;
    const toolResultBudgetStats = report.compaction.toolResultBudgetStats;

    lines.push(`Model: ${report.modelName ?? 'unknown'}`);
    lines.push(`Context window: ${formatTokens(report.contextWindow)} tokens`);
    lines.push(
        `Estimated usage: ${formatTokens(report.totalEstimatedTokens)} / ${formatTokens(
            report.contextWindow
        )} tokens (${formatPercent(usageRatio)})`
    );
    lines.push(
        `Context estimate: ${formatTokens(report.contextTokenEstimate.baseUsageTokens)} + ${formatTokens(
            report.contextTokenEstimate.tailEstimatedTokens
        )} + ${formatTokens(report.contextTokenEstimate.assistantInternalTailTokens)} (${report.contextTokenEstimate.source})`
    );
    lines.push('');
    lines.push('Context strategy');
    lines.push(`- compact boundary: ${formatYesNo(report.activeContext.hasCompactBoundary)}`);
    lines.push(`- start index: ${formatTokens(report.activeContext.startIndex)}`);
    lines.push(`- leading partial assistant: ${formatYesNo(report.activeContext.leadingPartialAssistant)}`);
    lines.push(`- projected items: ${formatTokens(report.activeContext.projectedItemCount)}`);
    lines.push(
        `- auto compact: ${autoCompactDecision.shouldCompact ? 'should compact' : 'no'} (${humanizeIdentifier(
            autoCompactDecision.reason
        )})`
    );
    lines.push(`- reserved summary output: ${formatTokens(autoCompactDecision.reservedSummaryOutput)} tokens`);
    lines.push(`- effective window: ${formatTokens(autoCompactDecision.effectiveWindow)} tokens`);
    lines.push(`- buffer: ${formatTokens(autoCompactDecision.buffer)} tokens`);
    lines.push(`- auto compact threshold: ${formatTokens(autoCompactDecision.autoCompactThreshold)} tokens`);
    lines.push(
        `- window usage ratio: ${autoCompactDecision.windowUsageRatio !== undefined ? formatPercent(autoCompactDecision.windowUsageRatio) : 'n/a'}`
    );
    lines.push(
        `- margin tokens: ${autoCompactDecision.marginTokens !== undefined ? formatTokens(autoCompactDecision.marginTokens) : 'n/a'}`
    );
    lines.push(`- microcompact: ${microcompactDecision ? microcompactDecision.mode : 'n/a'}`);
    if (microcompactDecision) {
        lines.push(`  - reason: ${humanizeIdentifier(microcompactDecision.reason)}`);
    }
    if (toolResultBudgetStats) {
        lines.push(
            `- tool result budget: enabled (groups: ${formatTokens(toolResultBudgetStats.groupCount)}, over budget groups: ${formatTokens(toolResultBudgetStats.overBudgetGroupCount)})`
        );
    } else {
        lines.push('- tool result budget: disabled');
    }
    lines.push('');
    lines.push('Categories');
    for (const category of report.categories) {
        lines.push(`- ${category.name}: ${formatTokens(category.tokens)} tokens`);
    }
    if (report.toolsetCategories.length > 0) {
        lines.push('');
        lines.push('Toolsets');
        for (const category of report.toolsetCategories) {
            lines.push(`- ${category.name}: ${formatTokens(category.tokens)} tokens (${category.toolCount} tools)`);
        }
    }
    if (report.assistantRounds.length > 0) {
        lines.push('');
        lines.push('Assistant rounds');
        for (const round of report.assistantRounds) {
            lines.push(
                `- message ${formatTokens(round.messageIndex)} round ${formatTokens(round.roundIndex)}: ${round.kind} (${formatTokens(round.startPartIndex)}-${formatTokens(round.endPartIndexExclusive)}, tools: ${formatTokens(round.toolCallCount)})`
            );
        }
    }
    lines.push('');
    lines.push('Message breakdown');
    lines.push(`- User text: ${formatTokens(report.messageBreakdown.userTextTokens)} tokens`);
    lines.push(`- User files: ${formatTokens(report.messageBreakdown.userFileTokens)} tokens`);
    lines.push(`- User images: ${formatTokens(report.messageBreakdown.userImageTokens)} tokens`);
    lines.push(`- Assistant text: ${formatTokens(report.messageBreakdown.assistantTextTokens)} tokens`);
    lines.push(`- Reasoning: ${formatTokens(report.messageBreakdown.assistantReasoningTokens)} tokens`);
    lines.push(`- Tool calls: ${formatTokens(report.messageBreakdown.assistantToolCallTokens)} tokens`);
    lines.push(`- Assistant tool results: ${formatTokens(report.messageBreakdown.assistantToolResultTokens)} tokens`);
    lines.push(`- Compact summary: ${formatTokens(report.messageBreakdown.compactBoundaryTokens)} tokens`);
    lines.push('');
    lines.push('Suggestions');
    if (suggestions.length === 0) {
        lines.push('- none');
    } else {
        suggestions.forEach((suggestion, index) => {
            lines.push(`${index + 1}. [${suggestion.severity}] ${suggestion.title}`);
            lines.push(`   ${suggestion.detail}`);
        });
    }

    return lines.join('\n');
}
