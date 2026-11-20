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
    ChatContext,
    ToolCall,
    UserMessage,
    type AssistantMessagePart,
    type ChatMessage
} from '../messages.js';
import { buildActiveContextView } from '../compaction/context-view.js';
import type { ActiveContextView, AssistantRoundRef } from '../compaction/types.js';
import { resolveToolResultReplacement, resolveVisibleToolResultContent } from '../tool-result-content.js';
import type { ToolResultImage } from '../task/image-externalization.js';

export interface AdapterMessageBuildOptions {
    activeContext?: ActiveContextView;
    toolResultOverrides?: Map<string, string>;
    assistantReplayByMessageId?: Map<string, AssistantReplayInstruction>;
    requestTailText?: string;
    /**
     * 已外置工具结果图片的按需回灌（toolCallId → 完整图片）。
     * 由请求构建入口在 buildMessages 前通过 hydrateExternalizedToolImages 生成，
     * 仅存活于单次请求构建期间；适配器优先使用，缺失时回退到内联缩略图。
     */
    hydratedToolImages?: ReadonlyMap<string, ToolResultImage[]>;
}

export interface AssistantReplayInstruction {
    startPartIndex?: number;
    roundRef?: AssistantRoundRef;
}

export interface AdapterContextProjection {
    systemPrompt?: ChatContext['system_prompt'];
    messages: ChatMessage[];
    toolResultOverrides?: Map<string, string>;
    assistantReplayByMessageId: Map<string, AssistantReplayInstruction>;
    hydratedToolImages?: ReadonlyMap<string, ToolResultImage[]>;
}

export interface AdapterToolDefinition {
    name: string;
    description: string;
    parameters: object;
}

/**
 * Materialize the model-visible request projection as an isolated ChatContext.
 *
 * The returned context is intentionally detached from the task context. It
 * keeps the adapter-only replay/override rules out of the model request.
 */
export function buildRequestChatContext(
    chatContext: ChatContext,
    options: AdapterMessageBuildOptions = {}
): ChatContext {
    const projection = buildContextProjection(chatContext, options);
    const serialized = JSON.parse(
        JSON.stringify({
            system_prompt: projection.systemPrompt,
            messages: projection.messages
        })
    ) as {
        system_prompt?: unknown;
        messages: Array<Record<string, any>>;
    };

    for (const message of serialized.messages) {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;

        const replayInstruction = projection.assistantReplayByMessageId.get(message.message_id);
        const roundRef = replayInstruction?.roundRef;
        if (roundRef && roundRef.assistantMessageId !== message.message_id) {
            throw new Error(
                `assistant replay roundRef message mismatch: expected ${message.message_id}, got ${roundRef.assistantMessageId}`
            );
        }
        const startPartIndex = roundRef?.startPartIndex ?? replayInstruction?.startPartIndex;
        if (startPartIndex !== undefined) {
            if (!Number.isInteger(startPartIndex) || startPartIndex < 0) {
                throw new Error(`invalid assistant replay startPartIndex: ${startPartIndex}`);
            }
            message.content = message.content.slice(startPartIndex);
        }

        for (const part of message.content) {
            if (part?.type !== 'tool_call' || !Array.isArray(part.toolcalls)) continue;
            for (const toolCall of part.toolcalls) {
                const override = resolveToolResultReplacement(toolCall, options.toolResultOverrides);
                if (override !== undefined) {
                    toolCall.result = override;
                    toolCall.result_storage.replacement_text = override;
                }
            }
        }
    }

    const requestContext = ChatContext.assign(serialized);
    requestContext.attachToolsets(...chatContext.toolsets.values());
    return requestContext;
}

export function buildContextProjection(
    chatContext: ChatContext,
    options: AdapterMessageBuildOptions = {}
): AdapterContextProjection {
    const activeContext = options.activeContext ?? buildActiveContextView(chatContext);
    const messages = [...activeContext.messages];
    const assistantReplayByMessageId = new Map(options.assistantReplayByMessageId ?? []);

    if (
        activeContext.leadingPartialAssistant &&
        !assistantReplayByMessageId.has(activeContext.leadingPartialAssistant.message.message_id)
    ) {
        assistantReplayByMessageId.set(activeContext.leadingPartialAssistant.message.message_id, {
            roundRef: activeContext.leadingPartialAssistant.roundRef
        });
    }

    if (typeof options.requestTailText === 'string' && options.requestTailText.trim().length > 0) {
        messages.push(new UserMessage(options.requestTailText));
    }

    return {
        systemPrompt: chatContext.system_prompt,
        messages,
        toolResultOverrides: options.toolResultOverrides,
        assistantReplayByMessageId,
        hydratedToolImages: options.hydratedToolImages
    };
}

export function getAssistantReplayInstruction(
    projection: AdapterContextProjection,
    message: AssistantMessage
): AssistantReplayInstruction | undefined {
    return projection.assistantReplayByMessageId.get(message.message_id);
}

export function resolveAssistantMessageParts(
    projection: AdapterContextProjection,
    message: AssistantMessage
): ReadonlyArray<AssistantMessagePart> {
    const replayInstruction = getAssistantReplayInstruction(projection, message);
    const roundRef = replayInstruction?.roundRef;
    if (roundRef) {
        if (roundRef.assistantMessageId !== message.message_id) {
            throw new Error(
                `assistant replay roundRef message mismatch: expected ${message.message_id}, got ${roundRef.assistantMessageId}`
            );
        }
        return message.content.slice(roundRef.startPartIndex);
    }

    const startPartIndex = replayInstruction?.startPartIndex;
    if (startPartIndex === undefined) {
        return message.content;
    }
    if (!Number.isInteger(startPartIndex) || startPartIndex < 0) {
        throw new Error(`invalid assistant replay startPartIndex: ${startPartIndex}`);
    }
    return message.content.slice(startPartIndex);
}

export function buildToolDefinitions(chatContext: ChatContext): AdapterToolDefinition[] {
    return Array.from(chatContext.getTools().entries()).map(([toolId, tool]) => ({
        name: toolId,
        description: tool.description,
        parameters: tool.getJsonSchema()
    }));
}

export function buildToolResultContent(toolcall: ToolCall, toolResultOverrides?: Map<string, string>): string {
    return resolveVisibleToolResultContent(toolcall, toolResultOverrides) ?? 'Toolcall failed: unfinished tool call';
}
