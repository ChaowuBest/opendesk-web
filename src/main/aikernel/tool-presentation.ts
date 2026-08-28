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

import type { LocalizedToolPresentationText, ToolCallPresentation, ToolPresentationText } from './types/tools.js';

export type { LocalizedToolPresentationText, ToolCallPresentation, ToolPresentationText } from './types/tools.js';

export const TOOL_PRESENTATION_NAME_MAX_CHARS = 160;
export const TOOL_PRESENTATION_SUMMARY_MAX_CHARS = 512;
export const TOOL_PRESENTATION_RESOURCE_MAX_CHARS = 2048;

export interface ToolCallPresentationSource {
    tool_name: string;
    args_string?: string;
    args_object?: unknown;
}

export interface ResolvedToolCallPresentation extends Omit<
    ToolCallPresentation,
    'displayName' | 'summary' | 'activity'
> {
    displayName: string;
    summary?: string;
    activity?: string;
}

export type ToolPresentationTranslator = (key: string, params?: Record<string, string | number>) => string;

function truncateString(value: unknown, maxChars: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    if (!normalized) return undefined;
    return Array.from(normalized).slice(0, maxChars).join('');
}

function sanitizeText(value: unknown, maxChars: number): ToolPresentationText | undefined {
    const plainText = truncateString(value, maxChars);
    if (plainText) return plainText;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Partial<LocalizedToolPresentationText>;
    const key = truncateString(candidate.key, TOOL_PRESENTATION_NAME_MAX_CHARS);
    if (!key) return undefined;
    const params = Object.fromEntries(
        Object.entries(candidate.params || {})
            .slice(0, 12)
            .flatMap(([paramKey, paramValue]) => {
                const safeKey = truncateString(paramKey, 64);
                const safeValue =
                    typeof paramValue === 'number' && Number.isFinite(paramValue)
                        ? paramValue
                        : truncateString(paramValue, maxChars);
                return safeKey && safeValue !== undefined ? [[safeKey, safeValue]] : [];
            })
    );
    return { key, ...(Object.keys(params).length > 0 ? { params } : {}) };
}

function resolveText(
    value: ToolPresentationText | undefined,
    translate: ToolPresentationTranslator
): string | undefined {
    if (typeof value === 'string') return value;
    return value ? translate(value.key, value.params) : undefined;
}

export function resolveToolCallPresentation(
    value: ToolCallPresentation,
    translate: ToolPresentationTranslator
): ResolvedToolCallPresentation {
    return {
        ...value,
        displayName: resolveText(value.displayName, translate) || '',
        summary: resolveText(value.summary, translate),
        activity: resolveText(value.activity, translate)
    };
}

export function sanitizeToolCallPresentation(
    value: ToolCallPresentation | undefined,
    fallbackName: string
): ToolCallPresentation {
    const displayName = sanitizeText(value?.displayName, TOOL_PRESENTATION_NAME_MAX_CHARS) ||
        truncateString(fallbackName, TOOL_PRESENTATION_NAME_MAX_CHARS) || { key: 'renderer.taskview.output.tool' };
    const summary = sanitizeText(value?.summary, TOOL_PRESENTATION_SUMMARY_MAX_CHARS);
    const activity = sanitizeText(value?.activity, TOOL_PRESENTATION_SUMMARY_MAX_CHARS);
    const resourceValue = truncateString(value?.resource?.value, TOOL_PRESENTATION_RESOURCE_MAX_CHARS);
    const resourceType = value?.resource?.type;
    const resource =
        resourceValue && (resourceType === 'preview' || resourceType === 'changes' || resourceType === 'url')
            ? { type: resourceType, value: resourceValue }
            : undefined;
    const resultFormat = value?.resultFormat === 'markdown' ? 'markdown' : undefined;
    const detailMode =
        value?.detailMode === 'resource' && resource
            ? 'resource'
            : value?.detailMode === 'custom'
              ? 'custom'
              : undefined;
    return {
        displayName,
        ...(summary ? { summary } : {}),
        ...(activity ? { activity } : {}),
        ...(resource ? { resource } : {}),
        ...(detailMode ? { detailMode } : {}),
        ...(resultFormat ? { resultFormat } : {})
    };
}

export function getToolCallPresentationArgs(toolCall: ToolCallPresentationSource): Record<string, unknown> {
    if (toolCall.args_object && typeof toolCall.args_object === 'object' && !Array.isArray(toolCall.args_object)) {
        const args = toolCall.args_object as Record<string, unknown>;
        if (Object.keys(args).length > 0) return args;
    }
    try {
        const parsed = JSON.parse(toolCall.args_string || '');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

export function getDefaultToolCallPresentation(toolCall: ToolCallPresentationSource): ToolCallPresentation {
    return sanitizeToolCallPresentation({ displayName: toolCall.tool_name }, toolCall.tool_name);
}
