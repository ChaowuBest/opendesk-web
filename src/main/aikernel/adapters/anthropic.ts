/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import crypto from 'crypto';
import {
    AssistantMessage,
    AssistantResponse,
    ChatContext,
    TextMessagePart,
    ToolCall,
    ToolCallMessagePart,
    Usage,
    UserMessage,
    isCompactBoundaryMessage,
    tryExtractFirstJson,
    type AssistantMessagePart,
    type UserMessagePart
} from '../messages.js';
import { ModelInstance, ReasoningEffort } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { fetchModelUrl } from '../../utils/model-network.js';
import iconv from 'iconv-lite';
import { RateLimitDetector, withRateLimitRetry } from '../../utils/rate-limit-retry.js';
import {
    buildContextProjection,
    buildToolDefinitions,
    buildToolResultContent,
    resolveAssistantMessageParts,
    type AdapterContextProjection,
    type AdapterMessageBuildOptions
} from './context.js';

export interface AnthropicAdapterRequestOptions {
    reasoningEffort?: ReasoningEffort;
    maxCompletionTokens?: number;
    extraHeaders?: Record<string, string>;
    onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
    onUsage?: (
        usage: Usage,
        context: { requestType: 'completeText' | 'complete' | 'streamComplete'; model?: string; provider?: string }
    ) => void | Promise<void>;
    disableInternalRetry?: boolean;
}

export interface AnthropicRequestMessages {
    system?: string;
    messages: object[];
}

interface AnthropicStreamState {
    toolCalls: Map<number, { id: string; name: string }>;
    usage: Record<string, unknown>;
}

function normalizeMaxCompletionTokens(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    return Math.floor(value);
}

function joinAnthropicApiPath(baseUrl: string, pathSegment: string): string {
    const trimmed = baseUrl.replace(/\/+$/, '');
    const normalizedPath = pathSegment.replace(/^\/+/, '');
    return trimmed.endsWith('/v1') ? `${trimmed}/${normalizedPath}` : `${trimmed}/v1/${normalizedPath}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return undefined;
}

function readTokenCount(candidate: Record<string, unknown>, key: string): number | undefined {
    const value = candidate[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return undefined;
    }
    return Math.floor(value);
}

function normalizedTotal(promptTokens?: number, completionTokens?: number, totalTokens?: number): number | undefined {
    if (totalTokens !== undefined) {
        return totalTokens;
    }
    if (promptTokens === undefined || completionTokens === undefined) {
        return undefined;
    }
    return promptTokens + completionTokens;
}

function isValidToolCallArgs(argsString: string): boolean {
    if (!argsString || argsString.trim().length === 0) {
        return true;
    }
    try {
        JSON.parse(argsString);
        return true;
    } catch {
        return false;
    }
}

function buildRuntimeExtraHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    if (!extraHeaders) {
        return {};
    }
    return {
        ...Object.fromEntries(
            Object.entries(extraHeaders).map(([k, v]) => [k, iconv.encode(v, 'latin1').toString('latin1')])
        ),
        span_id: crypto.randomBytes(8).toString('hex')
    };
}

/**
 * Anthropic Messages API protocol adapter.
 */
export class AnthropicAdapter {
    private readonly modelInstance: ModelInstance;

    constructor(modelInstance: ModelInstance) {
        this.modelInstance = modelInstance;
    }

    private headers(extraHeaders?: Record<string, string>): Record<string, string> {
        const sanitizedCustom = this.modelInstance.custom_headers
            ? Object.fromEntries(
                  Object.entries(this.modelInstance.custom_headers).map(([k, v]) => [
                      k,
                      iconv.encode(v, 'latin1').toString('latin1')
                  ])
              )
            : {};
        const sanitizedExtra = extraHeaders
            ? Object.fromEntries(
                  Object.entries(extraHeaders).map(([k, v]) => [k, iconv.encode(v, 'latin1').toString('latin1')])
              )
            : {};
        return {
            'Content-Type': 'application/json',
            'x-api-key': this.modelInstance.api_key,
            Authorization: `Bearer ${this.modelInstance.api_key}`,
            'anthropic-version': '2023-06-01',
            ...sanitizedCustom,
            ...sanitizedExtra
        };
    }

    private requestHeaders(requestOptions?: AnthropicAdapterRequestOptions): Record<string, string> | undefined {
        const headers: Record<string, string> = buildRuntimeExtraHeaders(requestOptions?.extraHeaders);
        return Object.keys(headers).length > 0 ? headers : undefined;
    }

    private async httpError(response: Response): Promise<Error & { status?: number }> {
        let bodyText = '';
        try {
            bodyText = await response.text();
        } catch {
            /* ignore */
        }

        let message = bodyText;
        try {
            const body = JSON.parse(bodyText) as Record<string, unknown>;
            const error = asRecord(body.error);
            message =
                (typeof error?.message === 'string' ? error.message : undefined) ??
                (typeof body.message === 'string' ? body.message : undefined) ??
                bodyText;
        } catch {
            /* keep raw body text */
        }

        const error = new Error(
            `Anthropic API request failed (${response.status} ${response.statusText}): ${message}`
        ) as Error & { status?: number };
        error.status = response.status;
        return error;
    }

    private async createMessage(body: object, requestOptions?: AnthropicAdapterRequestOptions): Promise<any> {
        const response = await fetchModelUrl(
            this.modelInstance,
            joinAnthropicApiPath(this.modelInstance.base_url, 'messages'),
            {
                method: 'POST',
                headers: this.headers(this.requestHeaders(requestOptions)),
                body: JSON.stringify(body)
            }
        );
        if (!response.ok) {
            throw await this.httpError(response);
        }
        return await response.json();
    }

    private requestMaxCompletionTokens(
        requestOptions: AnthropicAdapterRequestOptions | undefined,
        defaultValue: number
    ): number {
        return normalizeMaxCompletionTokens(requestOptions?.maxCompletionTokens) ?? defaultValue;
    }

    private static textBlock(text: string): object[] {
        return text.length > 0 ? [{ type: 'text', text }] : [];
    }

    private static imageUrlToAnthropicBlock(url: string | undefined): object | undefined {
        if (!url) {
            return undefined;
        }

        const dataUriMatch = url.match(/^data:([^;,]+);base64,(.+)$/);
        if (dataUriMatch) {
            return {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: dataUriMatch[1],
                    data: dataUriMatch[2]
                }
            };
        }

        return {
            type: 'image',
            source: {
                type: 'url',
                url
            }
        };
    }

    private static userFileText(part: Extract<UserMessagePart, { type: 'file' }>): string {
        return `用户添加了文件附件: ${part.path}，其内容以文本形式提取如下，供你参考: <content>${part.content}</content>`;
    }

    private static userMessageToBlocks(message: UserMessage, supportsVision: boolean): object[] {
        const blocks: object[] = [];
        for (const part of message.content) {
            if (part.type === 'text') {
                blocks.push(...AnthropicAdapter.textBlock(part.text));
            } else if (part.type === 'file') {
                blocks.push(...AnthropicAdapter.textBlock(AnthropicAdapter.userFileText(part)));
            } else if (part.type === 'image_url' && supportsVision) {
                const imageBlock = AnthropicAdapter.imageUrlToAnthropicBlock(part.image_url.url);
                if (imageBlock) {
                    blocks.push(imageBlock);
                }
            }
        }
        return blocks;
    }

    private static parseToolInput(argsString: string): object {
        if (!argsString || argsString.trim().length === 0) {
            return {};
        }
        try {
            const parsed = JSON.parse(argsString);
            return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
        } catch {
            return { _raw_args: argsString };
        }
    }

    private static appendMessage(messages: object[], role: 'user' | 'assistant', content: object[]): void {
        if (content.length === 0) {
            return;
        }

        const previous = messages[messages.length - 1] as { role?: string; content?: object[] } | undefined;
        if (previous?.role === role && Array.isArray(previous.content)) {
            previous.content.push(...content);
            return;
        }

        messages.push({ role, content });
    }

    private static toolCallArgsString(toolCall: ToolCall): string {
        return toolCall.shouldUseLegacyCompressedArgsPlaceholder()
            ? toolCall.getLegacyCompressedArgsText()
            : toolCall.args_string || '';
    }

    private static collectValidToolCalls(part: ToolCallMessagePart): ToolCall[] {
        const validToolCalls: ToolCall[] = [];

        for (const toolCall of part.toolcalls) {
            const argsToCheck = toolCall.shouldUseLegacyCompressedArgsPlaceholder()
                ? '{"compressed":"placeholder"}'
                : toolCall.args_string || '';
            if (!isValidToolCallArgs(argsToCheck)) {
                const extracted = tryExtractFirstJson(toolCall.args_string);
                if (extracted) {
                    logger.info(
                        `Recovered partial JSON for tool call "${toolCall.tool_name}" (id=${toolCall.id}) in Anthropic context: ` +
                            `extracted valid prefix from malformed args_string`
                    );
                    toolCall.args_string = extracted;
                    validToolCalls.push(toolCall);
                } else {
                    logger.warn(
                        `Dropping tool call "${toolCall.tool_name}" (id=${toolCall.id}) from Anthropic context: ` +
                            `args_string is not valid JSON. Raw args: ${toolCall.args_string?.substring(0, 200)}`
                    );
                }
                continue;
            }
            validToolCalls.push(toolCall);
        }

        return validToolCalls;
    }

    private static assistantPartToText(part: AssistantMessagePart): string | undefined {
        if (part.type === 'text') {
            return part.text;
        }
        if (part.type === 'reasoning') {
            return `<think>${part.content}</think>`;
        }
        if (part.type === 'error') {
            return `[错误] ${part.title}: ${part.message}`;
        }
        return undefined;
    }

    private static appendAssistantParts(
        messages: object[],
        parts: ReadonlyArray<AssistantMessagePart>,
        projection: AdapterContextProjection
    ): void {
        let content: object[] = [];
        const flushAssistant = () => {
            AnthropicAdapter.appendMessage(messages, 'assistant', content);
            content = [];
        };

        for (const part of parts) {
            if (part.type === 'tool_call') {
                const validToolCalls = AnthropicAdapter.collectValidToolCalls(part);
                if (validToolCalls.length === 0) {
                    continue;
                }

                for (const toolCall of validToolCalls) {
                    content.push({
                        type: 'tool_use',
                        id: toolCall.id,
                        name: toolCall.tool_name,
                        input: AnthropicAdapter.parseToolInput(AnthropicAdapter.toolCallArgsString(toolCall))
                    });
                }
                flushAssistant();

                AnthropicAdapter.appendMessage(
                    messages,
                    'user',
                    validToolCalls.map((toolCall) => ({
                        type: 'tool_result',
                        tool_use_id: toolCall.id,
                        content: buildToolResultContent(toolCall, projection.toolResultOverrides)
                    }))
                );
                continue;
            }

            const text = AnthropicAdapter.assistantPartToText(part);
            if (text !== undefined) {
                content.push(...AnthropicAdapter.textBlock(text));
            }
        }

        flushAssistant();
    }

    private static compactBoundaryText(summary: string): string {
        return `[上下文压缩通知] 以下是对之前对话历史的结构化总结。此前的消息已被压缩并省略，请基于以下总结继续对话：\n\n${summary}`;
    }

    static buildMessages(
        chatContext: ChatContext,
        supportsVision: boolean = true,
        options: AdapterMessageBuildOptions = {}
    ): AnthropicRequestMessages {
        const projection = buildContextProjection(chatContext, options);
        const messages: object[] = [];

        for (const message of projection.messages) {
            if (isCompactBoundaryMessage(message)) {
                AnthropicAdapter.appendMessage(messages, 'user', [
                    { type: 'text', text: AnthropicAdapter.compactBoundaryText(message.summary) }
                ]);
                continue;
            }

            if (message instanceof UserMessage) {
                AnthropicAdapter.appendMessage(
                    messages,
                    'user',
                    AnthropicAdapter.userMessageToBlocks(message, supportsVision)
                );
                continue;
            }

            if (message instanceof AssistantMessage) {
                if (message.content.length === 0) {
                    continue;
                }
                AnthropicAdapter.appendAssistantParts(
                    messages,
                    resolveAssistantMessageParts(projection, message),
                    projection
                );
            }
        }

        const result: AnthropicRequestMessages = { messages };
        if (projection.systemPrompt?.content && projection.systemPrompt.content.length > 0) {
            result.system = projection.systemPrompt.content;
        }
        return result;
    }

    static buildToolOptions(chatContext: ChatContext): object {
        const tools = buildToolDefinitions(chatContext);
        if (tools.length === 0) {
            return {};
        }

        return {
            tool_choice: { type: 'auto' },
            tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: asRecord(tool.parameters) ?? { type: 'object', properties: {} }
            }))
        };
    }

    static parseUsage(rawUsage: unknown): Usage | undefined {
        const candidate = asRecord(rawUsage);
        if (!candidate) {
            return undefined;
        }

        const inputTokens = readTokenCount(candidate, 'input_tokens');
        const outputTokens = readTokenCount(candidate, 'output_tokens');
        const promptTokens = readTokenCount(candidate, 'prompt_tokens') ?? inputTokens;
        const completionTokens = readTokenCount(candidate, 'completion_tokens') ?? outputTokens;
        const totalTokens = normalizedTotal(promptTokens, completionTokens, readTokenCount(candidate, 'total_tokens'));
        const cacheCreationInputTokens = readTokenCount(candidate, 'cache_creation_input_tokens');
        const cacheReadInputTokens = readTokenCount(candidate, 'cache_read_input_tokens');

        const usage = new Usage(promptTokens, completionTokens, totalTokens, {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: cacheCreationInputTokens,
            cache_read_input_tokens: cacheReadInputTokens
        });

        if (
            usage.prompt_tokens === undefined &&
            usage.completion_tokens === undefined &&
            usage.total_tokens === undefined &&
            usage.input_tokens === undefined &&
            usage.output_tokens === undefined &&
            usage.cache_creation_input_tokens === undefined &&
            usage.cache_read_input_tokens === undefined
        ) {
            return undefined;
        }

        return usage;
    }

    private static stopReason(stopReason: unknown): 'stop' | 'error' | 'tool_calls' | null {
        if (stopReason === 'tool_use') {
            return 'tool_calls';
        }
        if (stopReason === 'error') {
            return 'error';
        }
        if (stopReason === undefined || stopReason === null) {
            return null;
        }
        return 'stop';
    }

    static parseMessageBody(body: any): AssistantResponse {
        const message = new AssistantMessage();
        const content = Array.isArray(body?.content) ? body.content : [];
        for (let i = 0; i < content.length; i++) {
            const block = content[i];
            if (block?.type === 'text' && typeof block.text === 'string') {
                message.content.push(new TextMessagePart(block.text));
            } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
                message.appendReasoningContent(block.thinking, 'reasoning_content');
            } else if (block?.type === 'tool_use') {
                const part = new ToolCallMessagePart();
                part.push(
                    new ToolCall(
                        i,
                        block.id ?? `toolu_${i}`,
                        block.name ?? 'unknown',
                        JSON.stringify(block.input ?? {})
                    )
                );
                message.appendToolCallPart(part);
            }
        }

        const response = new AssistantResponse(message, AnthropicAdapter.stopReason(body?.stop_reason));
        const usage = AnthropicAdapter.parseUsage(body?.usage);
        if (usage) {
            response.usage = usage;
        }
        return response;
    }

    static extractText(body: any): string {
        const content = Array.isArray(body?.content) ? body.content : [];
        return content
            .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
            .filter((text) => text.length > 0)
            .join('');
    }

    private static responseWithUsage(response: AssistantResponse, state: AnthropicStreamState): AssistantResponse {
        const usage = AnthropicAdapter.parseUsage(state.usage);
        if (usage) {
            response.usage = usage;
        }
        return response;
    }

    private static parseStreamEvent(rawEvent: string, state: AnthropicStreamState): AssistantResponse[] {
        const dataLines: string[] = [];
        for (const line of rawEvent.split(/\r?\n/)) {
            if (line.startsWith('data:')) {
                dataLines.push(line.slice('data:'.length).trimStart());
            }
        }
        if (dataLines.length === 0) {
            return [];
        }

        const dataText = dataLines.join('\n');
        if (dataText === '[DONE]') {
            return [];
        }

        let eventData: any;
        try {
            eventData = JSON.parse(dataText);
        } catch (error) {
            logger.warn('failed to parse Anthropic stream event', dataText, String(error));
            return [];
        }

        const responses: AssistantResponse[] = [];
        if (eventData.type === 'message_start') {
            Object.assign(state.usage, eventData.message?.usage ?? {});
            return [];
        }

        if (eventData.type === 'content_block_start') {
            const block = eventData.content_block;
            if (block?.type === 'tool_use') {
                const id = typeof block.id === 'string' ? block.id : `toolu_${eventData.index ?? 0}`;
                const name = typeof block.name === 'string' ? block.name : 'unknown';
                state.toolCalls.set(eventData.index ?? 0, { id, name });

                const message = new AssistantMessage();
                const part = new ToolCallMessagePart();
                const initialInput =
                    block.input !== undefined &&
                    block.input !== null &&
                    typeof block.input === 'object' &&
                    Object.keys(block.input).length > 0
                        ? JSON.stringify(block.input)
                        : '';
                part.push(new ToolCall(eventData.index ?? 0, id, name, initialInput));
                message.appendToolCallPart(part);
                responses.push(AnthropicAdapter.responseWithUsage(new AssistantResponse(message), state));
            }
            return responses;
        }

        if (eventData.type === 'content_block_delta') {
            const delta = eventData.delta;
            const message = new AssistantMessage();

            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                message.content.push(new TextMessagePart(delta.text));
            } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                message.appendReasoningContent(delta.thinking, 'reasoning_content');
            } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                const index = eventData.index ?? 0;
                const toolCall = state.toolCalls.get(index) ?? { id: `toolu_${index}`, name: 'unknown' };
                const part = new ToolCallMessagePart();
                part.push(new ToolCall(index, toolCall.id, toolCall.name, delta.partial_json));
                message.appendToolCallPart(part);
            }

            if (message.content.length > 0) {
                responses.push(AnthropicAdapter.responseWithUsage(new AssistantResponse(message), state));
            }
            return responses;
        }

        if (eventData.type === 'message_delta') {
            Object.assign(state.usage, eventData.usage ?? {});
            responses.push(
                AnthropicAdapter.responseWithUsage(
                    new AssistantResponse(
                        new AssistantMessage(),
                        AnthropicAdapter.stopReason(eventData.delta?.stop_reason)
                    ),
                    state
                )
            );
            return responses;
        }

        if (eventData.type === 'error') {
            const message = eventData.error?.message ?? JSON.stringify(eventData.error ?? eventData);
            responses.push(AssistantResponse.error(`Anthropic stream error: ${message}`));
        }

        return responses;
    }

    private async runRequest<T>(fn: () => Promise<T>, requestOptions?: AnthropicAdapterRequestOptions): Promise<T> {
        if (requestOptions?.disableInternalRetry) {
            return await fn();
        }
        return await withRateLimitRetry(fn, {
            onRetry: requestOptions?.onRetry
        });
    }

    private async notifyUsage(
        requestOptions: AnthropicAdapterRequestOptions | undefined,
        usage: Usage | undefined,
        requestType: 'completeText' | 'complete' | 'streamComplete'
    ): Promise<void> {
        if (!usage || !requestOptions?.onUsage) {
            return;
        }
        try {
            await requestOptions.onUsage(usage, {
                requestType,
                model: this.modelInstance.model_name,
                provider: this.modelInstance.getProviderName()
            });
        } catch (error) {
            logger.warn(`Anthropic usage callback failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    private async *streamMessages(
        body: object,
        requestOptions?: AnthropicAdapterRequestOptions
    ): AsyncIterable<AssistantResponse> {
        const response = await this.runRequest(async () => {
            const resp = await fetchModelUrl(
                this.modelInstance,
                joinAnthropicApiPath(this.modelInstance.base_url, 'messages'),
                {
                    method: 'POST',
                    headers: this.headers(this.requestHeaders(requestOptions)),
                    body: JSON.stringify(body)
                }
            );
            if (!resp.ok) {
                throw await this.httpError(resp);
            }
            return resp;
        }, requestOptions);

        if (!response.body) {
            throw new Error('Anthropic stream response body is empty');
        }

        const reader = response.body.getReader();
        try {
            const decoder = new TextDecoder();
            const state: AnthropicStreamState = { toolCalls: new Map(), usage: {} };
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split(/\r?\n\r?\n/);
                buffer = events.pop() ?? '';
                for (const event of events) {
                    for (const responseChunk of AnthropicAdapter.parseStreamEvent(event, state)) {
                        yield responseChunk;
                    }
                }
            }

            buffer += decoder.decode();
            if (buffer.trim().length > 0) {
                for (const responseChunk of AnthropicAdapter.parseStreamEvent(buffer, state)) {
                    yield responseChunk;
                }
            }
        } finally {
            reader.cancel().catch(() => {
                // reader.cancel() may reject if the stream is already closed;
                // this is expected and harmless when the generator is terminated early.
            });
        }
    }

    async completeText(
        chatContext: ChatContext,
        supportsVision: boolean = true,
        options: AdapterMessageBuildOptions = {},
        requestOptions?: AnthropicAdapterRequestOptions
    ): Promise<string> {
        const anthropicMessages = AnthropicAdapter.buildMessages(chatContext, supportsVision, options);
        const response = await this.runRequest(
            () =>
                this.createMessage(
                    {
                        model: this.modelInstance.model_name,
                        max_tokens: this.requestMaxCompletionTokens(requestOptions, 4096),
                        ...(anthropicMessages.system ? { system: anthropicMessages.system } : {}),
                        messages: anthropicMessages.messages
                    },
                    requestOptions
                ),
            requestOptions
        );
        await this.notifyUsage(requestOptions, AnthropicAdapter.parseUsage(response?.usage), 'completeText');
        return AnthropicAdapter.extractText(response);
    }

    async complete(
        chatContext: ChatContext,
        supportsVision: boolean = true,
        options: AdapterMessageBuildOptions = {},
        requestOptions?: AnthropicAdapterRequestOptions
    ): Promise<AssistantResponse> {
        const anthropicMessages = AnthropicAdapter.buildMessages(chatContext, supportsVision, options);
        const response = await this.runRequest(
            () =>
                this.createMessage(
                    {
                        model: this.modelInstance.model_name,
                        max_tokens: this.requestMaxCompletionTokens(requestOptions, 16384),
                        ...(anthropicMessages.system ? { system: anthropicMessages.system } : {}),
                        messages: anthropicMessages.messages,
                        ...AnthropicAdapter.buildToolOptions(chatContext)
                    },
                    requestOptions
                ),
            requestOptions
        );
        const parsed = AnthropicAdapter.parseMessageBody(response);
        await this.notifyUsage(requestOptions, parsed.usage, 'complete');
        return parsed;
    }

    async *streamComplete(
        chatContext: ChatContext,
        supportsVision: boolean = true,
        options: AdapterMessageBuildOptions = {},
        requestOptions?: AnthropicAdapterRequestOptions
    ): AsyncIterable<AssistantResponse> {
        const anthropicMessages = AnthropicAdapter.buildMessages(chatContext, supportsVision, options);
        try {
            let finalUsage: Usage | undefined;
            for await (const response of this.streamMessages(
                {
                    model: this.modelInstance.model_name,
                    max_tokens: this.requestMaxCompletionTokens(requestOptions, 16384),
                    stream: true,
                    ...(anthropicMessages.system ? { system: anthropicMessages.system } : {}),
                    messages: anthropicMessages.messages,
                    ...AnthropicAdapter.buildToolOptions(chatContext)
                },
                requestOptions
            )) {
                if (response.usage) {
                    finalUsage = response.usage;
                }
                yield response;
            }
            await this.notifyUsage(requestOptions, finalUsage, 'streamComplete');
        } catch (err) {
            if (RateLimitDetector.isRateLimitError(err)) {
                logger.warn('Rate limit error during Anthropic stream reading', String(err));
            }
            yield AssistantResponse.richError(
                'Stream Completion Failed',
                String(err),
                JSON.stringify(anthropicMessages, undefined, 2)
            );
        }
    }

    async verify(): Promise<void> {
        const response = await withRateLimitRetry(() =>
            this.createMessage({
                model: this.modelInstance.model_name,
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 8
            })
        );
        if (!Array.isArray(response?.content)) {
            throw new Error('模型返回结果异常');
        }
    }
}
