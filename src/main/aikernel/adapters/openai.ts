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
import { RateLimitDetector, withRateLimitRetry } from '../../utils/rate-limit-retry.js';
import {
    buildContextProjection,
    buildToolDefinitions,
    getAssistantReplayInstruction,
    type AdapterMessageBuildOptions
} from './context.js';

export interface OpenAIAdapterRequestOptions {
    reasoningEffort?: ReasoningEffort;
    maxCompletionTokens?: number;
}

function normalizeMaxCompletionTokens(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
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

    private requestMaxCompletionTokens(
        requestOptions?: OpenAIAdapterRequestOptions,
        defaultValue?: number
    ): number | undefined {
        return normalizeMaxCompletionTokens(requestOptions?.maxCompletionTokens) ?? defaultValue;
    }

    static parseUsage(rawUsage: unknown): Usage | undefined {
        const usage = Usage.fromRaw(rawUsage);
        if (!usage) {
            return undefined;
        }
        return new Usage(
            usage.prompt_tokens,
            usage.completion_tokens,
            normalizedTotal(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens),
            {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens
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
                        ...message.toOpenAIMessagesFromRound(replayInstruction.roundRef, projection.toolResultOverrides)
                    );
                } else if (typeof replayInstruction?.startPartIndex === 'number') {
                    messages.push(
                        ...message.toOpenAIMessagesFromPartIndex(
                            replayInstruction.startPartIndex,
                            projection.toolResultOverrides
                        )
                    );
                } else {
                    messages.push(...message.toOpenAIMessages(projection.toolResultOverrides));
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

    async completeText(
        chatContext: ChatContext,
        supportsVision: boolean = true,
        options: AdapterMessageBuildOptions = {},
        requestOptions?: OpenAIAdapterRequestOptions
    ): Promise<string> {
        const messages = OpenAIAdapter.buildMessages(chatContext, supportsVision, options);
        const maxCompletionTokens = this.requestMaxCompletionTokens(requestOptions);
        const response = await withRateLimitRetry(() =>
            this.client.chat.completions.create({
                model: this.modelInstance.model_name,
                messages: messages as OpenAI.ChatCompletionMessageParam[],
                ...(maxCompletionTokens !== undefined
                    ? {
                          max_completion_tokens: maxCompletionTokens
                      }
                    : {}),
                ...this.requestReasonOptions(requestOptions)
            })
        );

        if (response.choices.length !== 1) {
            throw new Error('unsupported openai response type');
        }
        return response.choices[0].message.content ?? '';
    }

    async complete(
        chatContext: ChatContext,
        supportsVision: boolean = true,
        options: AdapterMessageBuildOptions = {},
        requestOptions?: OpenAIAdapterRequestOptions
    ): Promise<AssistantResponse> {
        const messages = OpenAIAdapter.buildMessages(chatContext, supportsVision, options);
        const toolOptions = OpenAIAdapter.buildToolOptions(chatContext);
        const maxCompletionTokens = this.requestMaxCompletionTokens(requestOptions, 16384);
        const response = await withRateLimitRetry(() =>
            this.client.chat.completions.create({
                model: this.modelInstance.model_name,
                messages: messages as OpenAI.ChatCompletionMessageParam[],
                max_completion_tokens: maxCompletionTokens,
                ...toolOptions,
                ...this.requestReasonOptions(requestOptions)
            })
        );
        return OpenAIAdapter.parseResponse(response);
    }

    async *streamComplete(
        chatContext: ChatContext,
        supportsVision: boolean = true,
        options: AdapterMessageBuildOptions = {},
        requestOptions?: OpenAIAdapterRequestOptions
    ): AsyncIterable<AssistantResponse> {
        const messages = OpenAIAdapter.buildMessages(chatContext, supportsVision, options);
        const toolOptions = OpenAIAdapter.buildToolOptions(chatContext);
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

        try {
            const stream = await withRateLimitRetry(() =>
                this.client.chat.completions.create({
                    model: this.modelInstance.model_name,
                    messages: messages as OpenAI.ChatCompletionMessageParam[],
                    max_completion_tokens: this.requestMaxCompletionTokens(requestOptions, 16384),
                    stream: true,
                    stream_options: { include_usage: true },
                    ...toolOptions,
                    ...this.requestReasonOptions(requestOptions)
                })
            );

            for await (const chunk of stream) {
                yield OpenAIAdapter.parseResponse(chunk);
            }
        } catch (err) {
            if (RateLimitDetector.isRateLimitError(err)) {
                logger.warn('Rate limit error during stream reading, will be caught by outer retry logic', String(err));
            }
            yield AssistantResponse.richError(
                'Stream Completion Failed',
                String(err),
                JSON.stringify(messages, undefined, 2)
            );
        }
    }

    async verify(): Promise<void> {
        const response = await withRateLimitRetry(() =>
            this.client.chat.completions.create({
                model: this.modelInstance.model_name,
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 8
            })
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
