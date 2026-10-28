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

import type { ToolCall } from './messages.js';

export const DEFAULT_TOOL_RESULT_SUMMARY_PREVIEW_CHARS = 300;

/** Request-local overrides take precedence; restored tasks can use persisted replacements directly. */
export function resolveToolResultReplacement(
    toolCall: Pick<ToolCall, 'result_storage'>,
    toolResultOverrides?: ReadonlyMap<string, string>
): string | undefined {
    const storage = toolCall.result_storage;
    const override = storage?.result_id ? toolResultOverrides?.get(storage.result_id) : undefined;
    if (typeof override === 'string' && override.length > 0) return override;
    const persisted = storage?.replacement_text;
    return typeof persisted === 'string' && persisted.length > 0 ? persisted : undefined;
}

/** Shared model-visible text for requests, summary input and token estimates. */
export function resolveVisibleToolResultContent(
    toolCall: ToolCall,
    toolResultOverrides?: ReadonlyMap<string, string>
): string | undefined {
    if (toolCall.hasLegacyCompressId()) return toolCall.getLegacyCompressedResultText();
    const replacement = resolveToolResultReplacement(toolCall, toolResultOverrides);
    if (replacement !== undefined) return replacement;
    if (toolCall.status === 'error') return `Toolcall failed: ${toolCall.result ?? ''}`;
    if (toolCall.status === 'success') return toolCall.result ?? '工具调用成功完成';
    return undefined;
}

/** Summary bodies are bounded separately from the artifact locator needed to recover the full result. */
export function buildToolResultSummaryPreview(
    toolCall: ToolCall,
    maxChars: number,
    toolResultOverrides?: ReadonlyMap<string, string>
): string | undefined {
    const visible = resolveVisibleToolResultContent(toolCall, toolResultOverrides);
    // Legacy content is a retrieval identifier rather than a result preview.
    if (visible === undefined || toolCall.hasLegacyCompressId()) return visible;

    // These locator lines are emitted by tool-results and microcompact; retain the final full path,
    // without allowing the preview body or text after the locator to bypass the summary limit.
    const reference = Array.from(visible.matchAll(/^(?:完整输出已保存至|完整输出可查看)[:：][ \t]*[^\r\n]+/gm)).at(-1);
    const body = reference ? visible.slice(0, reference.index).trimEnd() : visible;
    const preview = body.length > maxChars ? `${body.slice(0, maxChars)}...` : body;
    if (reference) return `${preview}\n${reference[0]}`;

    const artifactPath = toolCall.microcompact?.artifact_path_hint ?? toolCall.result_storage?.relative_path;
    // Artifact is part of the model summary protocol, not a user-interface label.
    if (artifactPath && !preview.includes(artifactPath)) return `${preview}\n[Artifact: ${artifactPath}]`;
    return preview;
}
