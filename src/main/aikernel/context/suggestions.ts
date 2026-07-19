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

export interface ContextSuggestion {
    id: string;
    severity: 'info' | 'warn';
    title: string;
    detail: string;
}

function pushSuggestion(suggestions: ContextSuggestion[], suggestion: ContextSuggestion, seenIds: Set<string>): void {
    if (seenIds.has(suggestion.id)) {
        return;
    }
    seenIds.add(suggestion.id);
    suggestions.push(suggestion);
}

function getCategoryTokens(report: ContextDiagnosticsReport, name: string): number {
    return report.categories.find((category) => category.name === name)?.tokens ?? 0;
}

export function generateContextSuggestions(report: ContextDiagnosticsReport): ContextSuggestion[] {
    const suggestions: ContextSuggestion[] = [];
    const seenIds = new Set<string>();

    const usageRatio =
        report.usageRatio ?? (report.contextWindow > 0 ? report.totalEstimatedTokens / report.contextWindow : 0);
    const remainingTokens = Math.max(report.contextWindow - report.totalEstimatedTokens, 0);
    const messagesTokens = getCategoryTokens(report, 'Messages');
    const systemPromptTokens = getCategoryTokens(report, 'System prompt');
    const toolResultTokens = report.messageBreakdown.assistantToolResultTokens;
    const compactBoundaryTokens = report.messageBreakdown.compactBoundaryTokens;

    if (usageRatio >= 0.8 || remainingTokens <= Math.max(Math.floor(report.contextWindow * 0.1), 1_000)) {
        pushSuggestion(
            suggestions,
            {
                id: 'near-auto-compact-threshold',
                severity: 'warn',
                title: '接近自动压缩阈值',
                detail: '当前上下文已经接近自动压缩阈值，建议尽快整理最近消息。'
            },
            seenIds
        );
    }

    if (
        toolResultTokens >= Math.max(Math.floor(messagesTokens * 0.5), 1_000) ||
        (report.compaction.toolResultBudgetStats?.overBudgetGroupCount ?? 0) > 0
    ) {
        pushSuggestion(
            suggestions,
            {
                id: 'tool-results-overweight',
                severity: 'warn',
                title: '工具结果过大',
                detail: '工具结果占用了较多消息预算，优先缩短工具输出或使用摘要路径。'
            },
            seenIds
        );
    }

    if (systemPromptTokens >= Math.max(Math.floor(report.totalEstimatedTokens * 0.5), 2_000)) {
        pushSuggestion(
            suggestions,
            {
                id: 'system-prompt-overweight',
                severity: 'warn',
                title: '系统提示过大',
                detail: 'system prompt 占比偏高，建议检查是否嵌入了过多动态内容。'
            },
            seenIds
        );
    }

    if (
        report.activeContext.hasCompactBoundary &&
        compactBoundaryTokens >= Math.max(Math.floor(messagesTokens * 0.3), 800)
    ) {
        pushSuggestion(
            suggestions,
            {
                id: 'compact-summary-overweight',
                severity: 'warn',
                title: '压缩摘要过大',
                detail: 'compact summary 自身占比偏高，可能需要优化压缩摘要质量。'
            },
            seenIds
        );
    }

    return suggestions;
}
