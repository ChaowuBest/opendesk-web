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

import {
    AssistantMessage,
    type AssistantMessagePart,
    type ChatMessage,
    ToolCall,
    type UsageFields,
    UserMessage,
    isAssistantMessage,
    isCompactBoundaryMessage,
    isUserMessage,
    type SystemMessage
} from '../messages.js';
import type { ActiveContextView } from './types.js';
import { IMAGE_TOKEN_ESTIMATE } from './image-tokens.js';
import { estimateTextTokens } from '../../../utils/token-estimation.js';
import { resolveVisibleToolResultContent } from '../tool-result-content.js';

export type NormalizedUsage = UsageFields;

export interface RoughTokenEstimationOptions {
    toolResultOverrides?: ReadonlyMap<string, string>;
    systemPrompt?: SystemMessage | string;
}

export type TokenEstimateSource = 'usage_plus_tail_estimate' | 'rough_estimate_only';

export interface VisibleContextTokenEstimate {
    estimatedContextTokens: number;
    baseUsageTokens: number;
    tailEstimatedTokens: number;
    assistantInternalTailTokens: number;
    source: TokenEstimateSource;
    usageAnchorMessageId?: string;
    usageAnchorMessageIndex?: number;
}

export interface VisibleContextTokenEstimationInput extends RoughTokenEstimationOptions {
    /** Used only to reject usage checkpoints recorded for another model. */
    model?: string;
    activeContext?: Pick<ActiveContextView, 'messages'> &
        Partial<Pick<ActiveContextView, 'boundary' | 'leadingPartialAssistant'>>;
    messages?: ReadonlyArray<ChatMessage>;
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return undefined;
    }
    return Math.floor(value);
}

function getMessagesForEstimation(input: VisibleContextTokenEstimationInput): ReadonlyArray<ChatMessage> {
    if (input.messages !== undefined) {
        return input.messages;
    }
    if (input.activeContext !== undefined) {
        return input.activeContext.messages;
    }
    return [];
}

/** System prompt 按原始整段内容统计，不拆分内部 section。 */
export function estimateSystemPromptTokens(systemPrompt?: SystemMessage | string): number {
    if (systemPrompt === undefined) {
        return 0;
    }

    return estimateTextTokens(typeof systemPrompt === 'string' ? systemPrompt : systemPrompt.content);
}

export function normalizeUsage(rawUsage: unknown): NormalizedUsage | undefined {
    if (rawUsage === undefined || rawUsage === null || typeof rawUsage !== 'object') {
        return undefined;
    }

    const candidate = rawUsage as Record<string, unknown>;
    const normalized: NormalizedUsage = {
        prompt_tokens: normalizeOptionalNonNegativeInteger(candidate.prompt_tokens),
        completion_tokens: normalizeOptionalNonNegativeInteger(candidate.completion_tokens),
        total_tokens: normalizeOptionalNonNegativeInteger(candidate.total_tokens),
        input_tokens: normalizeOptionalNonNegativeInteger(candidate.input_tokens),
        output_tokens: normalizeOptionalNonNegativeInteger(candidate.output_tokens),
        cache_creation_input_tokens: normalizeOptionalNonNegativeInteger(candidate.cache_creation_input_tokens),
        cache_read_input_tokens: normalizeOptionalNonNegativeInteger(candidate.cache_read_input_tokens)
    };

    if (Object.values(normalized).every((value) => value === undefined)) {
        return undefined;
    }

    return normalized;
}

export function getContextTokensFromUsage(usage?: UsageFields | null): number | undefined {
    const normalized = normalizeUsage(usage);
    if (normalized === undefined) {
        return undefined;
    }

    const hasExpandedUsage =
        normalized.input_tokens !== undefined ||
        normalized.output_tokens !== undefined ||
        normalized.cache_creation_input_tokens !== undefined ||
        normalized.cache_read_input_tokens !== undefined;

    if (hasExpandedUsage) {
        return (
            (normalized.input_tokens ?? 0) +
            (normalized.cache_creation_input_tokens ?? 0) +
            (normalized.cache_read_input_tokens ?? 0) +
            (normalized.output_tokens ?? 0)
        );
    }

    if (normalized.total_tokens !== undefined) {
        return normalized.total_tokens;
    }

    if (normalized.prompt_tokens !== undefined || normalized.completion_tokens !== undefined) {
        return (normalized.prompt_tokens ?? 0) + (normalized.completion_tokens ?? 0);
    }

    return undefined;
}

export function estimateToolResultObjectTokens(toolCall: ToolCall): number {
    const images = toolCall.getResultImages();
    if (images.length === 0) {
        return estimateTextTokens(JSON.stringify(toolCall.result_object ?? ''));
    }

    const metadataOnly = images.map((image) => ({
        media_type: image.media_type,
        source: image.source
    }));
    // Data URLs are transported as image inputs, not tokenized as ordinary base64 text.
    // Retain metadata cost as well as the fixed budget for every image.
    return estimateTextTokens(JSON.stringify(metadataOnly)) + images.length * IMAGE_TOKEN_ESTIMATE;
}

export function estimateRoughTokensFromToolCall(toolCall: ToolCall, options: RoughTokenEstimationOptions = {}): number {
    return (
        estimateTextTokens(toolCall.tool_name) +
        estimateTextTokens(toolCall.args_string) +
        estimateTextTokens(resolveVisibleToolResultContent(toolCall, options.toolResultOverrides)) +
        estimateToolResultObjectTokens(toolCall)
    );
}

export function estimateRoughTokensFromAssistantParts(
    parts: ReadonlyArray<AssistantMessagePart>,
    options: RoughTokenEstimationOptions = {}
): number {
    return parts.reduce((total, part) => {
        if (part.type === 'text') {
            return total + estimateTextTokens(part.text);
        }
        if (part.type === 'reasoning') {
            return total + estimateTextTokens(part.content);
        }
        if (part.type === 'error') {
            return total + estimateTextTokens(part.title) + estimateTextTokens(part.message);
        }
        if (part.type === 'tool_call') {
            return (
                total +
                part.toolcalls.reduce((sum, toolCall) => sum + estimateRoughTokensFromToolCall(toolCall, options), 0)
            );
        }
        return total;
    }, 0);
}

export function estimateRoughTokensFromChatMessage(
    message: ChatMessage,
    options: RoughTokenEstimationOptions = {}
): number {
    if (isCompactBoundaryMessage(message)) {
        return estimateTextTokens(message.summary);
    }

    if (isUserMessage(message)) {
        return message.content.reduce((total, part) => {
            if (part.type === 'text') {
                return total + estimateTextTokens(part.text);
            }
            if (part.type === 'file') {
                return total + estimateTextTokens(part.path);
            }
            if (part.type === 'image_url') {
                return total + (part.file_path ? estimateTextTokens(part.toModelText()) : IMAGE_TOKEN_ESTIMATE);
            }
            return total;
        }, 0);
    }

    if (isAssistantMessage(message)) {
        return estimateRoughTokensFromAssistantParts(message.content, options);
    }

    return 0;
}

export function estimateAssistantPostUsageVisibleTokens(
    message: AssistantMessage,
    toolResultOverrides?: ReadonlyMap<string, string>
): number {
    const checkpoint = message.usageCheckpoints?.at(-1);
    const parts = checkpoint
        ? message.content.slice(checkpoint.startPartIndex, checkpoint.endPartIndex)
        : message.content;
    const laterTokens = checkpoint
        ? estimateRoughTokensFromAssistantParts(message.content.slice(checkpoint.endPartIndex), {
              toolResultOverrides
          })
        : 0;
    return parts.reduce((total, part) => {
        if (part.type !== 'tool_call') {
            return total;
        }

        return (
            total +
            part.toolcalls.reduce((sum, toolCall) => {
                return (
                    sum +
                    estimateTextTokens(resolveVisibleToolResultContent(toolCall, toolResultOverrides)) +
                    (toolCall.getResultImages().length > 0 ? estimateToolResultObjectTokens(toolCall) : 0)
                );
            }, 0)
        );
    }, laterTokens);
}

export function estimateVisibleContextTokens(input: VisibleContextTokenEstimationInput): VisibleContextTokenEstimate {
    const messages = getMessagesForEstimation(input);
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!isAssistantMessage(message)) {
            continue;
        }

        const boundaryTime = input.activeContext?.boundary?.message.metadata.created_at;
        const checkpoint = message.usageCheckpoints?.at(-1);
        const usageTimestamp = message.metadata?.execution?.finishAt;
        if (checkpoint) {
            if (
                checkpoint.boundaryId !== input.activeContext?.boundary?.message.metadata.boundary_id ||
                (input.model && checkpoint.model && checkpoint.model !== input.model)
            )
                continue;
        } else if (boundaryTime && (usageTimestamp === undefined || usageTimestamp <= Date.parse(boundaryTime)))
            continue;
        const baseUsageTokens = getContextTokensFromUsage(message.usage);
        if (baseUsageTokens === undefined) {
            continue;
        }

        const assistantInternalTailTokens = estimateAssistantPostUsageVisibleTokens(message, input.toolResultOverrides);
        const tailEstimatedTokens = messages
            .slice(index + 1)
            .reduce((total, tailMessage) => total + estimateRoughTokensFromChatMessage(tailMessage, input), 0);

        return {
            estimatedContextTokens: baseUsageTokens + assistantInternalTailTokens + tailEstimatedTokens,
            baseUsageTokens,
            tailEstimatedTokens,
            assistantInternalTailTokens,
            source: 'usage_plus_tail_estimate',
            usageAnchorMessageId: message.message_id,
            usageAnchorMessageIndex: index
        };
    }

    const roughEstimatedTokens =
        messages.reduce((total, message) => {
            const leading = input.activeContext?.leadingPartialAssistant;
            return (
                total +
                (leading?.message === message
                    ? estimateRoughTokensFromAssistantParts(
                          leading.message.content.slice(leading.roundRef.startPartIndex),
                          input
                      )
                    : estimateRoughTokensFromChatMessage(message, input))
            );
        }, 0) + estimateSystemPromptTokens(input.systemPrompt);
    return {
        estimatedContextTokens: roughEstimatedTokens,
        baseUsageTokens: 0,
        tailEstimatedTokens: roughEstimatedTokens,
        assistantInternalTailTokens: 0,
        source: 'rough_estimate_only'
    };
}
