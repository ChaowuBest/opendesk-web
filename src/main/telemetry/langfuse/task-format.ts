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
    UserMessage,
    isCompactBoundaryMessage,
    tryExtractFirstJson,
    type CompactSeparatorMessage,
    type ToolCall
} from '../../aikernel/messages.js';
import {
    buildContextProjection,
    buildToolResultContent,
    resolveAssistantMessageParts
} from '../../aikernel/adapters/context.js';
import type { ActiveContextView } from '../../aikernel/compaction/types.js';
import { logger } from '../../utils/logger.js';

type LangfuseMessageContentItem = Record<string, unknown>;

export interface LangfuseMessageInput {
    role: string;
    content: string | LangfuseMessageContentItem[];
    toolCallId?: string;
    toolName?: string;
}

export interface AssistantTextSnapshot {
    partTexts: Array<string | undefined>;
}

export interface LangfuseTaskTurnOutputOptions {
    startMessageIndex?: number;
    taskID?: string;
    sessionID?: string;
    workspace?: string;
    providerID?: string;
    modelID?: string;
    mode?: string;
    agent?: string;
    cost?: number;
    completedAt?: number;
}

export interface LangfuseTaskTurnUsageDetails {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
}

export interface LangfuseTaskTurnOutputResult {
    output: {
        info: {
            id: string;
            sessionID: string;
            role: 'assistant';
            time: {
                created: number;
                completed: number;
            };
            parentID: string;
            providerID: string;
            modelID: string;
            mode: string;
            agent: string;
            path: {
                cwd: string;
                root: string;
            };
            cost: number;
            tokens: {
                input: number;
                output: number;
                reasoning: number;
                cache: {
                    read: number;
                    write: number;
                };
            };
        };
        parts: LangfuseMessageContentItem[];
    };
    error?: string;
    usageDetails?: LangfuseTaskTurnUsageDetails;
}

function errorToMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function parseLangfuseToolArguments(argsString: string | undefined): unknown {
    const args = argsString && argsString.trim().length > 0 ? argsString : '{}';
    try {
        return JSON.parse(args);
    } catch {
        const extracted = tryExtractFirstJson(args);
        if (extracted) {
            try {
                return JSON.parse(extracted);
            } catch {
                return extracted;
            }
        }
        return args;
    }
}

function addLangfuseTextContent(content: LangfuseMessageContentItem[], text: string | undefined): void {
    if (!text) {
        return;
    }
    content.push({ type: 'text', text });
}

function getMessagePartType(part: unknown): string {
    if (typeof part !== 'object' || part === null || !('type' in part)) {
        return 'unknown';
    }
    const type = (part as { type?: unknown }).type;
    return typeof type === 'string' && type.length > 0 ? type : 'unknown';
}

function buildLangfuseUserContent(message: UserMessage): LangfuseMessageContentItem[] {
    return message.content.map((part) => {
        if (part.type === 'text') {
            return { type: 'text', text: part.text };
        }
        if (part.type === 'image_url') {
            return { type: 'image_url', imageUrl: part.image_url };
        }
        if (part.type === 'file') {
            return {
                type: 'file',
                path: part.path,
                content: part.content
            };
        }
        return { type: getMessagePartType(part), value: part };
    });
}

export function buildTurnInput(chatContext: ChatContext): LangfuseMessageInput | undefined {
    for (let index = chatContext.messages.length - 1; index >= 0; index--) {
        const message = chatContext.messages[index];
        if (message instanceof UserMessage) {
            return {
                role: 'user',
                content: buildLangfuseUserContent(message)
            };
        }
    }
    return undefined;
}

export function findTurnStartIndex(chatContext: ChatContext): number {
    for (let index = chatContext.messages.length - 1; index >= 0; index--) {
        if (chatContext.messages[index] instanceof UserMessage) {
            return index;
        }
    }
    return -1;
}

function usageToken(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function toolTitle(toolName: string, input: unknown): string {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        const values = input as Record<string, unknown>;
        for (const key of ['description', 'filePath', 'file_path', 'path', 'pattern', 'command', 'name', 'query']) {
            const value = values[key];
            if (typeof value === 'string' && value.trim().length > 0) {
                return value;
            }
        }
    }
    return toolName;
}

function serializeToolState(toolCall: ToolCall, input: unknown, completedAt: number): Record<string, unknown> {
    if (toolCall.status === 'pending') {
        return { status: 'pending', input, raw: toolCall.args_string ?? '' };
    }
    if (toolCall.status === 'running') {
        return {
            status: 'running',
            input,
            title: toolTitle(toolCall.tool_name, input),
            metadata: {},
            time: { start: completedAt }
        };
    }
    const output = toolCall.result_object ?? toolCall.result ?? '';
    if (toolCall.status === 'error') {
        return {
            status: 'error',
            input,
            error: output,
            metadata: {},
            time: { start: completedAt, end: completedAt }
        };
    }
    return {
        status: 'completed',
        input,
        output,
        title: toolTitle(toolCall.tool_name, input),
        metadata: {},
        time: { start: completedAt, end: completedAt }
    };
}

function serializeAssistantPart(
    part: AssistantMessage['content'][number],
    messageID: string,
    sessionID: string,
    partIndex: number,
    completedAt: number
): LangfuseMessageContentItem[] {
    const base = {
        id: `prt_${messageID}_${partIndex}`,
        sessionID,
        messageID
    };
    if (part.type === 'text') {
        return [{ ...base, type: 'text', text: part.text }];
    }
    if (part.type === 'reasoning') {
        return [
            {
                ...base,
                type: 'reasoning',
                text: part.content,
                time: { start: completedAt }
            }
        ];
    }
    if (part.type === 'error') {
        const errorText = [part.title, part.message].filter((value) => value.length > 0).join(': ');
        return [{ ...base, type: 'text', text: `Error: ${errorText}` }];
    }
    if (part.type === 'tool_call') {
        return part.toolcalls.map((toolCall, toolCallIndex) => {
            const input = toolCall.args_object ?? parseLangfuseToolArguments(toolCall.args_string);
            return {
                ...base,
                id: `prt_${messageID}_tool_${toolCall.id || `${partIndex}_${toolCallIndex}`}`,
                type: 'tool',
                callID: toolCall.id,
                tool: toolCall.tool_name,
                state: serializeToolState(toolCall, input, completedAt)
            };
        });
    }
    return [{ ...base, type: getMessagePartType(part), value: part }];
}

export function buildTurnOutput(
    chatContext: ChatContext,
    options: LangfuseTaskTurnOutputOptions = {}
): LangfuseTaskTurnOutputResult {
    const startMessageIndex = options.startMessageIndex ?? findTurnStartIndex(chatContext);
    const assistantMessages = chatContext.messages
        .slice(Math.max(startMessageIndex + 1, 0))
        .filter((message): message is AssistantMessage => message instanceof AssistantMessage);
    const completedAt = options.completedAt ?? Date.now();
    const sessionID = options.sessionID ?? options.taskID ?? '';
    const parts = assistantMessages.flatMap((message) =>
        message.content.flatMap((part, partIndex) =>
            serializeAssistantPart(part, message.message_id, sessionID, partIndex, completedAt)
        )
    );
    const finalAssistant = assistantMessages[assistantMessages.length - 1];
    const triggeringUser =
        startMessageIndex >= 0 && chatContext.messages[startMessageIndex] instanceof UserMessage
            ? (chatContext.messages[startMessageIndex] as UserMessage)
            : undefined;
    const errors = assistantMessages
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'error')
        .map((part) => `${part.title}: ${part.message}`);

    let hasUsage = false;
    const usageDetails: LangfuseTaskTurnUsageDetails = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
    };
    for (const message of assistantMessages) {
        const usage = message.usage;
        if (!usage) {
            continue;
        }
        const promptTokens = usageToken(usage.prompt_tokens) ?? usageToken(usage.input_tokens) ?? 0;
        const completionTokens = usageToken(usage.completion_tokens) ?? usageToken(usage.output_tokens) ?? 0;
        const totalTokens = usageToken(usage.total_tokens) ?? promptTokens + completionTokens;
        const cacheReadInputTokens = usageToken(usage.cache_read_input_tokens) ?? 0;
        const cacheCreationInputTokens = usageToken(usage.cache_creation_input_tokens) ?? 0;
        hasUsage = true;
        usageDetails.promptTokens += promptTokens;
        usageDetails.completionTokens += completionTokens;
        usageDetails.totalTokens += totalTokens;
        usageDetails.cacheReadInputTokens += cacheReadInputTokens;
        usageDetails.cacheCreationInputTokens += cacheCreationInputTokens;
    }

    const error = errors.join('\n').trim();
    return {
        output: {
            info: {
                id: finalAssistant?.message_id ?? '',
                sessionID,
                role: 'assistant',
                time: {
                    created: completedAt,
                    completed: completedAt
                },
                parentID: triggeringUser?.message_id ?? '',
                providerID: options.providerID ?? '',
                modelID: options.modelID ?? '',
                mode: options.mode ?? 'default',
                agent: options.agent ?? 'explore',
                path: {
                    cwd: options.workspace ?? '',
                    root: options.workspace ?? ''
                },
                cost: options.cost ?? 0,
                tokens: {
                    input: usageDetails.promptTokens,
                    output: usageDetails.completionTokens,
                    reasoning: 0,
                    cache: {
                        read: usageDetails.cacheReadInputTokens,
                        write: usageDetails.cacheCreationInputTokens
                    }
                }
            },
            parts
        },
        error: error || undefined,
        usageDetails: hasUsage ? usageDetails : undefined
    };
}

function buildLangfuseAssistantMessages(
    message: AssistantMessage,
    projection: ReturnType<typeof buildContextProjection>
): LangfuseMessageInput[] {
    const messages: LangfuseMessageInput[] = [];
    let content: LangfuseMessageContentItem[] = [];
    const flushAssistant = () => {
        if (content.length === 0) {
            return;
        }
        messages.push({ role: 'assistant', content });
        content = [];
    };

    for (const part of resolveAssistantMessageParts(projection, message)) {
        if (part.type === 'text') {
            addLangfuseTextContent(content, part.text);
            continue;
        }
        if (part.type === 'reasoning') {
            content.push({ type: 'reasoning', text: part.content, source: part.source });
            continue;
        }
        if (part.type === 'error') {
            addLangfuseTextContent(content, `[错误] ${part.title}: ${part.message}`);
            continue;
        }
        if (part.type === 'tool_call') {
            for (const toolCall of part.toolcalls) {
                content.push({
                    type: 'tool_call',
                    toolCallId: toolCall.id,
                    toolName: toolCall.tool_name,
                    arguments: parseLangfuseToolArguments(toolCall.args_string)
                });
            }
            flushAssistant();
            for (const toolCall of part.toolcalls) {
                messages.push({
                    role: 'tool',
                    toolCallId: toolCall.id,
                    toolName: toolCall.tool_name,
                    content: [
                        {
                            type: 'tool_result',
                            toolCallId: toolCall.id,
                            toolName: toolCall.tool_name,
                            text: buildToolResultContent(toolCall, projection.toolResultOverrides)
                        }
                    ]
                });
            }
        }
    }

    flushAssistant();
    return messages;
}

function buildLangfuseCompactBoundaryContent(message: CompactSeparatorMessage): LangfuseMessageContentItem[] {
    const openaiMessage = message.toOpenAIMessage() as { content?: unknown };
    if (Array.isArray(openaiMessage.content)) {
        return openaiMessage.content.map((item) =>
            typeof item === 'object' && item !== null
                ? (item as LangfuseMessageContentItem)
                : { type: 'text', text: String(item) }
        );
    }
    return [{ type: 'text', text: String(openaiMessage.content ?? '') }];
}

export function buildLlmInput(
    chatContext: ChatContext,
    options:
        | {
              toolResultOverrides?: Map<string, string>;
              activeContext?: ActiveContextView;
          }
        | undefined
): LangfuseMessageInput[] {
    try {
        const projection = buildContextProjection(chatContext, options);
        const messages: LangfuseMessageInput[] = [];
        if (projection.systemPrompt) {
            messages.push({ role: 'system', content: projection.systemPrompt.content });
        }

        for (const message of projection.messages) {
            if (message instanceof UserMessage) {
                messages.push({ role: 'user', content: buildLangfuseUserContent(message) });
                continue;
            }
            if (message instanceof AssistantMessage) {
                messages.push(...buildLangfuseAssistantMessages(message, projection));
                continue;
            }
            if (isCompactBoundaryMessage(message)) {
                messages.push({ role: 'user', content: buildLangfuseCompactBoundaryContent(message) });
            }
        }
        return messages;
    } catch (err) {
        logger.warn(`failed to build Langfuse LLM input: ${errorToMessage(err)}`);
        return [];
    }
}

export function snapshotAssistantText(message: AssistantMessage): AssistantTextSnapshot {
    return {
        partTexts: message.content.map((part) => (part.type === 'text' ? part.text : undefined))
    };
}

export function extractAssistantVisibleTextSince(message: AssistantMessage, snapshot: AssistantTextSnapshot): string {
    return message.content
        .map((part, index) => {
            if (part.type !== 'text') {
                return '';
            }
            const previous = snapshot.partTexts[index];
            if (previous === undefined) {
                return part.text;
            }
            if (part.text.startsWith(previous)) {
                return part.text.slice(previous.length);
            }
            return part.text === previous ? '' : part.text;
        })
        .join('')
        .trim();
}
