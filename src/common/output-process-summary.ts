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

export const OUTPUT_TOOL_NAME_MAX_CHARS = 12;
export const OUTPUT_PROCESS_SUMMARY_MAX_CHARS = 64;
const OUTPUT_PROCESS_SUMMARY_MAX_TOOL_NAMES = 2;

export type OutputSummaryTranslator = (key: string, params?: Record<string, string | number>) => string;

export interface ResolvedOutputToolPresentation {
    displayName: string;
    summary?: string;
    activity?: string;
}

export interface OutputProcessSummaryOptions {
    toolDisplayNames: string[];
    toolCount: number;
    hasReasoning: boolean;
    translate: OutputSummaryTranslator;
    elapsed?: string;
    fallback?: string;
}

function truncateCharacters(value: string, maxLength: number): string {
    const characters = Array.from(value);
    if (characters.length <= maxLength) return value;
    return `${characters
        .slice(0, maxLength - 1)
        .join('')
        .trim()}…`;
}

export function compactOutputToolName(value: string): string {
    const phrase = String(value || '')
        .replace(/\s+/g, ' ')
        .split(/[，,。！？!?；;]/, 1)[0]
        .trim();
    return truncateCharacters(phrase, OUTPUT_TOOL_NAME_MAX_CHARS);
}

function uniqueCompactToolNames(displayNames: string[]): string[] {
    return Array.from(new Set(displayNames.map(compactOutputToolName).filter(Boolean)));
}

function formatTools(names: string[], toolCount: number, translate: OutputSummaryTranslator): string {
    if (names.length === 0 || toolCount <= 0) return '';
    const tools = names
        .slice(0, OUTPUT_PROCESS_SUMMARY_MAX_TOOL_NAMES)
        .join(translate('output.processSummary.listSeparator'));
    return translate(toolCount === 1 ? 'output.processSummary.usedTools.one' : 'output.processSummary.usedTools.many', {
        tools,
        count: toolCount
    });
}

function combineSummary(
    reasoning: string,
    tools: string,
    translate: OutputSummaryTranslator,
    fallback: string
): string {
    if (reasoning && tools) {
        return translate('output.processSummary.combined', { reasoning, tools });
    }
    return reasoning || tools || fallback;
}

export function formatOutputProcessSummary(options: OutputProcessSummaryOptions): string {
    const names = uniqueCompactToolNames(options.toolDisplayNames);
    const reasoning = options.hasReasoning ? options.translate('output.processSummary.reasoning') : '';
    let tools = formatTools(names, options.toolCount, options.translate);
    let summary = combineSummary(reasoning, tools, options.translate, options.fallback || '');

    if (Array.from(summary).length > OUTPUT_PROCESS_SUMMARY_MAX_CHARS && names.length > 1) {
        tools = formatTools(names.slice(0, 1), options.toolCount, options.translate);
        summary = combineSummary(reasoning, tools, options.translate, options.fallback || '');
    }

    summary = truncateCharacters(summary, OUTPUT_PROCESS_SUMMARY_MAX_CHARS);
    if (!options.elapsed) return summary;
    return summary
        ? options.translate('output.processSummary.withElapsed', { summary, elapsed: options.elapsed })
        : options.elapsed;
}

export function formatOutputToolActivity(
    presentation: ResolvedOutputToolPresentation | undefined,
    translate: OutputSummaryTranslator
): string {
    if (!presentation) return translate('output.running.waiting');
    if (presentation.activity) return presentation.activity;
    return translate('output.running.tool', {
        tool: presentation.summary || presentation.displayName
    });
}
