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

export interface AdapterMessageBuildOptions {
    activeContext?: ActiveContextView;
    toolResultOverrides?: Map<string, string>;
    assistantReplayByMessageId?: Map<string, AssistantReplayInstruction>;
    requestTailText?: string;
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
}

export interface AdapterToolDefinition {
    name: string;
    description: string;
    parameters: object;
}

/**
 * Materialize the model-visible request projection as an isolated ChatContext.
 *
 * The returned context is intentionally detached from the task context. It is
 * suitable for request-scoped hooks such as chat.messages.transform and keeps
 * the adapter-only replay/override rules out of the plugin contract.
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
                const resultId = toolCall?.result_storage?.result_id;
                const override = typeof resultId === 'string' ? options.toolResultOverrides?.get(resultId) : undefined;
                if (typeof override === 'string' && override.length > 0) {
                    toolCall.result = override;
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
        assistantReplayByMessageId
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
        parameters: tool.params.toJSONSchema()
    }));
}

export function buildToolResultContent(toolcall: ToolCall, toolResultOverrides?: Map<string, string>): string {
    if (toolcall.hasLegacyCompressId()) {
        return toolcall.getLegacyCompressedResultText();
    }

    const resultId = toolcall.result_storage?.result_id;
    if (resultId) {
        const overrideContent = toolResultOverrides?.get(resultId);
        if (typeof overrideContent === 'string' && overrideContent.length > 0) {
            return overrideContent;
        }
    }

    if (toolcall.status === 'error') {
        return `Toolcall failed: ${toolcall.result ?? ''}`;
    }

    if (toolcall.status === 'success') {
        return toolcall.result ?? '工具调用成功完成';
    }

    return 'Toolcall failed: unfinished tool call';
}
