import {
    AssistantMessage,
    type AssistantMessagePart,
    type ChatMessage,
    ToolCall,
    type UsageFields,
    UserMessage,
    isCompactBoundaryMessage
} from '../messages.js';
import type { ActiveContextView } from './types.js';

export type NormalizedUsage = UsageFields;

export interface RoughTokenEstimationOptions {
    toolResultOverrides?: ReadonlyMap<string, string>;
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
    activeContext?: Pick<ActiveContextView, 'messages'>;
    messages?: ReadonlyArray<ChatMessage>;
}

function isUserMessage(message: ChatMessage): message is UserMessage {
    return message instanceof UserMessage || message.role === 'user';
}

function isAssistantMessage(message: ChatMessage): message is AssistantMessage {
    return message instanceof AssistantMessage || message.role === 'assistant';
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return undefined;
    }
    return Math.floor(value);
}

function resolveToolResultOverride(
    toolCall: ToolCall,
    toolResultOverrides?: ReadonlyMap<string, string>
): string | undefined {
    const resultId = toolCall.result_storage?.result_id;
    if (!resultId) {
        return undefined;
    }
    const overrideContent = toolResultOverrides?.get(resultId);
    if (typeof overrideContent === 'string' && overrideContent.length > 0) {
        return overrideContent;
    }
    return undefined;
}

function resolveVisibleToolResultContent(
    toolCall: ToolCall,
    toolResultOverrides?: ReadonlyMap<string, string>
): string | undefined {
    if (toolCall.compress_id) {
        return `工具返回结果已被压缩，数据ID为 ${toolCall.compress_id}`;
    }

    const overrideContent = resolveToolResultOverride(toolCall, toolResultOverrides);
    if (overrideContent !== undefined) {
        return overrideContent;
    }

    if (toolCall.status === 'error') {
        return `Toolcall failed: ${toolCall.result ?? ''}`;
    }

    if (toolCall.status === 'success') {
        return toolCall.result ?? '工具调用成功完成';
    }

    return undefined;
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

export function estimateTextTokens(text: string | undefined): number {
    if (!text) {
        return 0;
    }
    return Math.ceil(text.length / 4);
}

export function estimateRoughTokensFromToolCall(toolCall: ToolCall, options: RoughTokenEstimationOptions = {}): number {
    return (
        estimateTextTokens(toolCall.tool_name) +
        estimateTextTokens(toolCall.args_string) +
        estimateTextTokens(resolveVisibleToolResultContent(toolCall, options.toolResultOverrides)) +
        estimateTextTokens(JSON.stringify(toolCall.result_object ?? ''))
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
                return total + estimateTextTokens(part.path) + estimateTextTokens(part.content);
            }
            if (part.type === 'image_url') {
                return total + 256;
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
    return message.content.reduce((total, part) => {
        if (part.type !== 'tool_call') {
            return total;
        }

        return (
            total +
            part.toolcalls.reduce((sum, toolCall) => {
                return sum + estimateTextTokens(resolveVisibleToolResultContent(toolCall, toolResultOverrides));
            }, 0)
        );
    }, 0);
}

export function estimateVisibleContextTokens(input: VisibleContextTokenEstimationInput): VisibleContextTokenEstimate {
    const messages = getMessagesForEstimation(input);
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!isAssistantMessage(message)) {
            continue;
        }

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

    const roughEstimatedTokens = messages.reduce(
        (total, message) => total + estimateRoughTokensFromChatMessage(message, input),
        0
    );
    return {
        estimatedContextTokens: roughEstimatedTokens,
        baseUsageTokens: 0,
        tailEstimatedTokens: roughEstimatedTokens,
        assistantInternalTailTokens: 0,
        source: 'rough_estimate_only'
    };
}
