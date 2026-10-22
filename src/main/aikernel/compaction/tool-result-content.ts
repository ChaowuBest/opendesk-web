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

import type { ToolCall } from '../messages.js';

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
