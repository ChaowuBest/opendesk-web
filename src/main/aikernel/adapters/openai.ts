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

import { assertRequestBudget, fitRequestOutputTokens } from '../compaction/request-budget.js';
import { type TextCompletionResult } from '../compaction/compact-error.js';
import crypto from 'crypto';
import { OpenAI } from 'openai';
import {
    AssistantMessage,
    AssistantResponse,
    ChatContext,
    UserMessage,
    Usage,
    isCompactBoundaryMessage
} from '../messages.js';
import { ModelInstance, ReasoningEffort } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { fetchModelUrl } from '../../utils/model-network.js';
import { extractErrorMessage } from './http-error.js';
import { lookupKnownMaxOutputTokens } from '../../utils/model-context.js';
import iconv from 'iconv-lite';
import { RateLimitDetector, withRateLimitRetry } from '../../utils/rate-limit-retry.js';
import { withHydratedToolImages } from '../task/image-externalization.js';
import {
    StreamIdleTimeoutError,
    resolveStreamIdleTimeoutMs,
    withStreamIdleTimeout
} from '../../utils/stream-timeout.js';
import {
    classifyModelRequestError,
    normalizeModelRequestError,
    parseModelErrorResponse
} from '../../utils/model-request-error.js';
import { t } from '../../../locale/index.js';
import {
    buildContextProjection,
    buildToolDefinitions,
    getAssistantReplayInstruction,
    type AdapterMessageBuildOptions
} from './context.js';

export interface OpenAIAdapterRequestOptions {
    contextBudget?: { window: number; inputEstimate?: number; requireBelowTrigger?: boolean };
    onBudgetValidated?: () => void;
    signal?: AbortSignal;
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

function normalizeMaxCompletionTokens(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    return Math.floor(value);
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

/**
 * 读取命中缓存的输入 tokens。
 * DeepSeek 原生接口返回 prompt_cache_hit_tokens，OpenAI 兼容接口返回 prompt_tokens_details.cached_tokens。
 */
function readCacheReadInputTokens(rawUsage: Record<string, unknown>): number | undefined {
    const details = asRecord(rawUsage['prompt_tokens_details']);
    return (
        readTokenCount(rawUsage, 'prompt_cache_hit_tokens') ??
        (details ? readTokenCount(details, 'cached_tokens') : undefined)
    );
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

function tryParseJson(value: string): unknown | undefined {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

function extractJsonStringField(value: string, fieldName: string): string | undefined {
    const match = new RegExp(`"${fieldName}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(value);
    if (!match) {
        return undefined;
    }

    const parsed = tryParseJson(`"${match[1]}"`);
    return typeof parsed === 'string' ? parsed : undefined;
}

function extractCompletionErrorMessage(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    if (typeof record.answer === 'string' && typeof record.status === 'string' && record.status !== 'SUCCESS') {
        return `${record.status}: ${record.answer}`;
    }

    if (record.error && typeof record.error === 'object') {
        const error = record.error as Record<string, unknown>;
        if (typeof error.message === 'string') {
            return error.message;
        }
    }

    return undefined;
}

function parseSseCompletionText(response: unknown): string | undefined {
    if (typeof response !== 'string' || !response.includes('data:')) {
        return undefined;
    }

    let content = '';
    let sawFrame = false;
    let sawContent = false;

    for (const line of response.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
            continue;
        }

        sawFrame = true;
        const payload = trimmed.slice('data:'.length).trim();
        if (!payload || payload === '[DONE]') {
            continue;
        }

        const parsed = tryParseJson(payload);
        if (parsed !== undefined) {
            const errorMessage = extractCompletionErrorMessage(parsed);
            if (errorMessage) {
                throw new Error(errorMessage);
            }

            const choice = Array.isArray((parsed as any).choices) ? (parsed as any).choices[0] : undefined;
            const messageContent = choice?.message?.content;
            if (typeof messageContent === 'string') {
                sawContent = true;
                content += messageContent;
                continue;
            }

            const deltaContent = choice?.delta?.content;
            if (typeof deltaContent === 'string') {
                sawContent = true;
                content += deltaContent;
            }
            continue;
        }

        const status = extractJsonStringField(payload, 'status');
        const answer = extractJsonStringField(payload, 'answer');
        if (status && status !== 'SUCCESS' && answer) {
            throw new Error(`${status}: ${answer}`);
        }

        const fallbackContent = extractJsonStringField(payload, 'content');
        if (fallbackContent !== undefined) {
            sawContent = true;
            content += fallbackContent;
        }
    }

    return sawFrame && sawContent ? content : undefined;
}

function buildRuntimeExtraHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    if (!extraHeaders) {
        return {};
    }
    return {
        ...Object.fromEntries(
            Object.entries(extraHeaders).map(([k, v]) => [k, iconv.encode(v, 'latin1').toString('latin1')])
        ),
        span_id: extraHeaders.span_id ?? crypto.randomBytes(8).toString('hex')
    };
}

/**
 * 把非 2xx 的错误 body 换成 `{ error: { message } }` 再交回 SDK。
 *
 * SDK 处理原本平铺的 `{ code, message }` 时会丢成 "403 status code (no body)"。
 */
async function normalizeErrorResponse(response: Response): Promise<Response> {
    const rawText = await response.text().catch(() => '');
    const message = extractErrorMessage(response.status, response.statusText, rawText);
    let errorBody: Record<string, unknown> = { message };
    try {
        const parsed = JSON.parse(rawText) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const record = parsed as Record<string, unknown>;
            const nested = record.error;
            errorBody =
                nested && typeof nested === 'object' && !Array.isArray(nested)
                    ? { ...(nested as Record<string, unknown>), message }
                    : { ...record, message };
        }
    } catch {
        // 非 JSON 错误仍包装为 OpenAI SDK 可识别的 error.message。
    }

    const headers = new Headers(response.headers);
    const requestError = parseModelErrorResponse({
        provider: 'openai',
        status: response.status,
        statusText: response.statusText,
        headers,
        rawText
    });
    if (classifyModelRequestError(requestError) === 'non_retryable') {
        headers.set('x-should-retry', 'false');
    }

    return new Response(JSON.stringify({ error: errorBody }), {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

/**
 * OpenAI-compatible chat/embedding protocol adapter.
 */
export class OpenAIAdapter {
    private readonly modelInstance: ModelInstance;
    private readonly client: OpenAI;

    constructor(modelInstance: ModelInstance) {
        this.modelInstance = modelInstance;
        this.client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url,
            defaultHeaders: modelInstance.custom_headers
                ? Object.fromEntries(
                      Object.entries(modelInstance.custom_headers).map(([k, v]) => [
                          k,
                          iconv.encode(v, 'latin1').toString('latin1')
                      ])
                  )
                : undefined,
            fetch: async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                const response = await fetchModelUrl(modelInstance, url, init);
                return response.ok ? response : await normalizeErrorResponse(response);
            }
        });
    }

    private requestReasonOptions(requestOptions?: OpenAIAdapterRequestOptions): Record<string, unknown> {
        const reasoningEffort = requestOptions?.reasoningEffort ?? this.modelInstance.reasoning_effort;
        const reasonOptions: Record<string, unknown> = {};
        if (reasoningEffort === 'none') {
            reasonOptions.thinking = { type: 'disabled' };
        } else if (reasoningEffort) {
            reasonOptions.thinking = { type: 'enabled' };
            reasonOptions.reasoning_effort = reasoningEffort;
        }
        return reasonOptions;
    }

    private requestMaxCompletionTokens(requestOptions?: OpenAIAdapterRequestOptions): number {
        return (
            normalizeMaxCompletionTokens(requestOptions?.maxCompletionTokens) ??
            this.modelInstance.max_output_tokens ??
            (lookupKnownMaxOutputTokens(this.modelInstance.model_name) || 16384)
        );
    }

    private requestHeaders(requestOptions?: OpenAIAdapterRequestOptions): Record<string, string> | undefined {
        const headers: Record<string, string> = buildRuntimeExtraHeaders(requestOptions?.extraHeaders);
        return Object.keys(headers).length > 0 ? headers : undefined;
    }

    private requestTransportOptions(
        requestOptions?: OpenAIAdapterRequestOptions
    ): { headers?: Record<string, string> } | undefined {
        const headers = this.requestHeaders(requestOptions);
        return headers ? { headers } : undefined;
    }

    private async runCompletionRequest<T>(
        fn: () => Promise<T>,
        requestOptions?: OpenAIAdapterRequestOptions
    ): Promise<T> {
        if (requestOptions?.disableInternalRetry) {
            return await fn();
        }
        return await withRateLimitRetry(fn, {
            onRetry: requestOptions?.onRetry
        });
    }

    private async notifyUsage(
        requestOptions: OpenAIAdapterRequestOptions | undefined,
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
            logger.warn(`OpenAI usage callback failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    static parseUsage(rawUsage: unknown): Usage | undefined {
        const usage = Usage.fromRaw(rawUsage);
        if (!usage) {
            return undefined;
        }

        const candidate = asRecord(rawUsage);
        const cacheReadInputTokens =
            (candidate ? readCacheReadInputTokens(candidate) : undefined) ?? usage.cache_read_input_tokens ?? 0;
        const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;

        // 统一语义：input_tokens 只统计未命中缓存的输入，命中与写入缓存分别通过 cache_* 字段表达。
        // 兼容接口通常不返回 input_tokens，此处在缺少该字段时从 prompt_tokens 中扣除缓存部分。
        const inputTokens =
            usage.input_tokens ??
            (usage.prompt_tokens !== undefined
                ? Math.max(0, usage.prompt_tokens - cacheReadInputTokens - cacheCreationInputTokens)
                : undefined);

        return new Usage(
            usage.prompt_tokens,
            usage.completion_tokens,
            normalizedTotal(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens),
            {
                input_tokens: inputTokens,
                output_tokens: usage.output_tokens,
                cache_creation_input_tokens: cacheCreationInputTokens,
                cache_read_input_tokens: cacheReadInputTokens
            }
        );
    }

    static buildMessages(
        chatContext: ChatContext,
        supportsVision: boolean = true,
        options: AdapterMessageBuildOptions = {}
    ): object[] {
        const projection = buildContextProjection(chatContext, options);
        const messages: object[] = [];

        if (projection.systemPrompt !== undefined) {
            messages.push(projection.systemPrompt.toOpenAIMessage());
        }

        for (const message of projection.messages) {
            if (isCompactBoundaryMessage(message)) {
                messages.push(message.toOpenAIMessage());
            } else if (message instanceof AssistantMessage) {
                if (message.content.length === 0) {
                    continue;
                }
                const replayInstruction = getAssistantReplayInstruction(projection, message);
                if (replayInstruction?.roundRef) {
                    messages.push(
                        ...message.toOpenAIMessagesFromRound(
                            replayInstruction.roundRef,
                            projection.toolResultOverrides,
                            supportsVision,
                            projection.hydratedToolImages
                        )
                    );
                } else if (typeof replayInstruction?.startPartIndex === 'number') {
                    messages.push(
                        ...message.toOpenAIMessagesFromPartIndex(
                            replayInstruction.startPartIndex,
                            projection.toolResultOverrides,
                            supportsVision,
                            projection.hydratedToolImages
                        )
                    );
                } else {
                    messages.push(
                        ...message.toOpenAIMessages(
                            projection.toolResultOverrides,
                            supportsVision,
                            projection.hydratedToolImages
                        )
                    );
                }
            } else if (message instanceof UserMessage) {
                messages.push(message.toOpenAIMessage(supportsVision));
            } else {
                messages.push((message as any).toOpenAIMessage());
            }
        }

        return messages;
    }

    static buildToolOptions(chatContext: ChatContext): object {
        const tools = buildToolDefinitions(chatContext);
        if (tools.length === 0) {
            return {};
        }
        return {
            tool_choice: 'auto',
            tools: tools.map((tool) => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters
                }
            }))
        };
    }

    static parseResponse(openaiResponse: any): AssistantResponse {
        const choices = openaiResponse['choices'];
        const choice = choices && choices.length > 0 ? choices[0] : undefined;
        let response: AssistantResponse;

        if (choice === undefined) {
            response = new AssistantResponse(new AssistantMessage(), null);
        } else if (choice.delta !== undefined) {
            const chunk = AssistantMessage.parseOpenAIMessage(choice.delta);
            response = new AssistantResponse(chunk, choice.finish_reason ?? null);
        } else if (choice.message !== undefined) {
            const message = AssistantMessage.parseOpenAIMessage(choice.message);
            response = new AssistantResponse(message, choice.finish_reason ?? null);
        } else {
            logger.error('invalid openai response', choice);
            throw new Error('invalid openai response');
        }

        const usage = OpenAIAdapter.parseUsage(openaiResponse['usage']);
        if (usage) {
            response.usage = usage;
        }
        return response;
    }

    async completeTextWithMetadata(
        chatContext: ChatContext,
        supportsVision = true,
        options: AdapterMessageBuildOptions = {},
        requestOptions?: OpenAIAdapterRequestOptions
    ): Promise<TextCompletionResult> {
        const messages = OpenAIAdapter.buildMessages(
            chatContext,
            supportsVision,
            await withHydratedToolImages(chatContext, supportsVision, options)
        );
        const output = this.requestMaxCompletionTokens(requestOptions);
        if (requestOptions?.contextBudget) assertRequestBudget(messages, output, requestOptions.contextBudget.window);
        const response: any = await this.client.chat.completions.create(
            {
                model: this.modelInstance.model_name,
                messages: messages as OpenAI.ChatCompletionMessageParam[],
                max_completion_tokens: output,
                ...this.requestReasonOptions(requestOptions)
            },
            { ...this.requestTransportOptions(requestOptions), maxRetries: 0, signal: requestOptions?.signal }
        );
        // Some compatible providers return SSE even for a non-streaming request.
        if (typeof response === 'string' && response.includes('data:')) {
            const merged: TextCompletionResult = { text: '', reasoningLength: 0 };
            try {
                for (const line of response.split(/\r?\n/)) {
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    if (!data || data === '[DONE]') continue;
                    const chunk = JSON.parse(data);
                    if (chunk.error) {
                        merged.protocolError = 'api_error';
                        break;
                    }
                    const choice = chunk.choices?.[0];
                    const part = choice?.delta ?? choice?.message;
                    if (part?.content != null && typeof part.content !== 'string') merged.protocolError = 'content';
                    else merged.text += part?.content ?? '';
                    merged.reasoningLength +=
                        typeof part?.reasoning_content === 'string' ? part.reasoning_content.length : 0;
                    merged.finishReason = choice?.finish_reason ?? merged.finishReason;
                    merged.usage = OpenAIAdapter.parseUsage(chunk.usage) ?? merged.usage;
                }
                if (!merged.finishReason) merged.protocolError = 'incomplete_stream';
            } catch {
                merged.protocolError = 'invalid_sse';
            }
            await this.notifyUsage(requestOptions, merged.usage, 'completeText');
            return merged;
        }
        const choice = response?.choices?.[0];
        const content = choice?.message?.content;
        const usage = OpenAIAdapter.parseUsage(response?.usage);
        await this.notifyUsage(requestOptions, usage, 'completeText');
        return {
            text: typeof content === 'string' ? content : '',
            reasoningLength:
                typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content.length : 0,
            finishReason: choice?.finish_reason,
            choicesCount: Array.isArray(response?.choices) ? response.choices.length : undefined,
            usage,
            protocolError:
                response?.error ||
                !Array.isArray(response?.choices) ||
                (response.choices.length > 0 && (!choice?.message || (content != null && typeof content !== 'string')))
                    ? 'invalid_response'
                    : undefined
        };
    }

    async completeText(
        chatContext: ChatContext,
        supportsVision: boolean = true,
        options: AdapterMessageBuildOptions = {},
        requestOptions?: OpenAIAdapterRequestOptions
    ): Promise<string> {
        const messages = OpenAIAdapter.buildMessages(
            chatContext,
            supportsVision,
            await withHydratedToolImages(chatContext, supportsVision, options)
        );
        const maxCompletionTokens = this.requestMaxCompletionTokens(requestOptions);
        const response = await this.runCompletionRequest(
            () =>
                this.client.chat.completions.create(
                    {
                        model: this.modelInstance.model_name,
                        messages: messages as OpenAI.ChatCompletionMessageParam[],
                        max_completion_tokens: maxCompletionTokens,
                        ...this.requestReasonOptions(requestOptions)
                    },
                    this.requestTransportOptions(requestOptions)
                ),
            requestOptions
        );

        const sseText = parseSseCompletionText(response);
        if (sseText !== undefined) {
            return sseText;
        }

        const completionErrorMessage = extractCompletionErrorMessage(response);
        if (completionErrorMessage) {
            throw new Error(completionErrorMessage);
        }

        if (!Array.isArray(response.choices)) {
            logger.error('unsupported openai response: ' + JSON.stringify(response, undefined, 2));
            throw new Error('unsupported openai response type');
        }

        if (response.choices.length === 0) {
            logger.warn(
                `openai returned empty choices for model ${this.modelInstance.model_name}, ` +
                    `attempting streaming fallback`
            );
            try {
                const streamedText = await this.collectStreamText(chatContext, supportsVision, options, requestOptions);
                if (streamedText) {
                    logger.info(`streaming fallback succeeded for model ${this.modelInstance.model_name}`);
                    return streamedText;
                }
            } catch (streamErr) {
                logger.warn(`streaming fallback also failed for model ${this.modelInstance.model_name}: ${streamErr}`);
            }
            logger.warn(
                `openai returned empty choices for model ${this.modelInstance.model_name}, ` +
                    `returning empty string as fallback`
            );
            return '';
        }

        if (response.choices.length > 1) {
            logger.warn(
                `openai returned ${response.choices.length} choices for non-streaming request, using first choice`
            );
        }

        await this.notifyUsage(requestOptions, OpenAIAdapter.parseUsage((response as any).usage), 'completeText');
        return response.choices[0].message.content ?? '';
    }

    /**
     * 通过流式请求收集完整文本，作为非流式请求返回空时的兜底方案。
     * 某些 provider（如 minimax）的非流式 API 存在 bug 会返回空 choices，
     * 但流式模式工作正常。
     */
    private async collectStreamText(
        chatContext: ChatContext,
        supportsVision: boolean,
        options: AdapterMessageBuildOptions,
        requestOptions?: OpenAIAdapterRequestOptions
    ): Promise<string> {
        let text = '';
        for await (const chunk of this.streamComplete(chatContext, supportsVision, options, requestOptions)) {
            for (const part of chunk.content.content) {
                if (part.type === 'text') {
                    text += part.text;
                } else if (part.type === 'error') {
                    throw new Error(part.message || part.title || 'streaming fallback failed');
                }
            }
        }
        return text;
    }

    async complete(
        chatContext: ChatContext,
        supportsVision: boolean = true,
        options: AdapterMessageBuildOptions = {},
        requestOptions?: OpenAIAdapterRequestOptions
    ): Promise<AssistantResponse> {
        const messages = OpenAIAdapter.buildMessages(
            chatContext,
            supportsVision,
            await withHydratedToolImages(chatContext, supportsVision, options)
        );
        const toolOptions = OpenAIAdapter.buildToolOptions(chatContext);
        const maxCompletionTokens = this.requestMaxCompletionTokens(requestOptions);
        const response = await this.runCompletionRequest(
            () =>
                this.client.chat.completions.create(
                    {
                        model: this.modelInstance.model_name,
                        messages: messages as OpenAI.ChatCompletionMessageParam[],
                        max_completion_tokens: maxCompletionTokens,
                        ...toolOptions,
                        ...this.requestReasonOptions(requestOptions)
                    },
                    this.requestTransportOptions(requestOptions)
                ),
            requestOptions
        );
        const parsed = OpenAIAdapter.parseResponse(response);
        await this.notifyUsage(requestOptions, parsed.usage, 'complete');
        return parsed;
    }

    async *streamComplete(
        chatContext: ChatContext,
        supportsVision: boolean = true,
        options: AdapterMessageBuildOptions = {},
        requestOptions?: OpenAIAdapterRequestOptions
    ): AsyncIterable<AssistantResponse> {
        const messages = OpenAIAdapter.buildMessages(
            chatContext,
            supportsVision,
            await withHydratedToolImages(chatContext, supportsVision, options)
        );
        const toolOptions = OpenAIAdapter.buildToolOptions(chatContext);
        let maxCompletionTokens = this.requestMaxCompletionTokens(requestOptions);
        if (requestOptions?.contextBudget)
            maxCompletionTokens = fitRequestOutputTokens(
                { messages, ...toolOptions },
                maxCompletionTokens,
                requestOptions.contextBudget.window,
                requestOptions.contextBudget.inputEstimate,
                requestOptions.contextBudget.requireBelowTrigger
            );
        if (logger) {
            const hasImages = messages.some(
                (message: any) =>
                    Array.isArray(message.content) && message.content.some((part: any) => part.type === 'image_url')
            );
            if (hasImages) {
                logger.info(
                    `streamComplete: sending ${messages.length} messages with inline images (visionSupported=${supportsVision})`
                );
            }
        }

        requestOptions?.onBudgetValidated?.();
        try {
            let finalUsage: Usage | undefined;
            const stream = await this.runCompletionRequest(
                () =>
                    this.client.chat.completions.create(
                        {
                            model: this.modelInstance.model_name,
                            messages: messages as OpenAI.ChatCompletionMessageParam[],
                            max_completion_tokens: maxCompletionTokens,
                            stream: true,
                            stream_options: { include_usage: true },
                            ...toolOptions,
                            ...this.requestReasonOptions(requestOptions)
                        },
                        this.requestTransportOptions(requestOptions)
                    ),
                requestOptions
            );

            // 首个分块前按模型整体超时等待（可能在思考），开始输出后中途静默超过空闲间隔就断开重试
            const totalTimeoutMs = this.modelInstance.getTimeoutMs();
            for await (const chunk of withStreamIdleTimeout(
                stream,
                resolveStreamIdleTimeoutMs(totalTimeoutMs),
                () => stream.controller?.abort(),
                { firstValueTimeoutMs: totalTimeoutMs }
            )) {
                const parsed = OpenAIAdapter.parseResponse(chunk);
                if (parsed.usage) {
                    finalUsage = parsed.usage;
                }
                yield parsed;
            }
            await this.notifyUsage(requestOptions, finalUsage, 'streamComplete');
        } catch (err) {
            if (RateLimitDetector.isRateLimitError(err)) {
                logger.warn('Rate limit error during stream reading, will be caught by outer retry logic', String(err));
            }
            const errorMessage =
                err instanceof StreamIdleTimeoutError
                    ? t('error.model.stream_idle_timeout', { timeoutMs: err.timeoutMs })
                    : String(err);
            const response = AssistantResponse.richError(
                'Stream Completion Failed',
                errorMessage,
                JSON.stringify(messages, undefined, 2)
            );
            const displayMessage =
                response.content.content.find((part) => part.type === 'error')?.message ?? errorMessage;
            response.request_error = normalizeModelRequestError(err, 'openai', displayMessage);
            yield response;
        }
    }

    async verify(extraHeaders?: Record<string, string>): Promise<void> {
        const response = await withRateLimitRetry(() =>
            this.client.chat.completions.create(
                {
                    model: this.modelInstance.model_name,
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_completion_tokens: 8
                },
                extraHeaders && Object.keys(extraHeaders).length > 0 ? { headers: extraHeaders } : undefined
            )
        );
        if (!response?.choices?.[0]) {
            throw new Error('模型返回结果异常');
        }
    }

    async embed(text: string): Promise<number[]> {
        const response = await this.client.embeddings.create({
            model: this.modelInstance.model_name,
            input: text
        });
        return response.data[0].embedding;
    }

    async batchEmbed(texts: string[], batchSize: number = 64): Promise<number[][]> {
        const embeddings: number[][] = [];
        for (let i = 0; i < texts.length; i += batchSize) {
            logger.info(`progress ${i} / ${texts.length}`);
            const batch = texts.slice(i, i + batchSize);
            const response = await this.client.embeddings.create({
                model: this.modelInstance.model_name,
                input: batch
            });
            if (!Array.isArray(response.data)) {
                const err = new Error('Invalid embedding response: expected data array') as Error & { status?: number };
                err.status = 502;
                throw err;
            }
            embeddings.push(...response.data.sort((a, b) => a.index - b.index).map((data) => data.embedding));
        }
        return embeddings;
    }
}
