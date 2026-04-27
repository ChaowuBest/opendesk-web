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
import { ChatContext, AssistantResponse, UserMessage, AssistantMessage, isCompactBoundaryMessage } from './messages';
import { Setting, ModelInstance, ReasoningEffort } from '../utils/setting.js';
import { buildActiveContextView } from './compaction/context-view.js';
import type { ActiveContextView, AssistantRoundRef } from './compaction/types.js';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { lookupKnownVisionSupport, fetchVisionSupportFromAPI } from '../utils/model-context.js';
import { withRateLimitRetry, RateLimitDetector } from '../utils/rate-limit-retry.js';
import type { BaseTool } from './tool';

/** Model 参数支持传入 ModelInstance 对象、模型别名字符串、或 undefined（使用默认模型） */
type ModelParam = ModelInstance | string | undefined;

/**
 * 根据 reasoningEffort 配置生成 API 请求参数。
 * - 'none' 时禁用 thinking
 * - 其他有效值时启用 thinking 并设置 reasoning_effort
 */
function mergeReasonOptions(reasoningEffort: ReasoningEffort | undefined): Record<string, any> {
    const reasonOptions: Record<string, any> = {};
    if (reasoningEffort === 'none') {
        reasonOptions.thinking = { type: 'disabled' };
    } else if (reasoningEffort && reasoningEffort !== '') {
        reasonOptions.thinking = { type: 'enabled' };
        reasonOptions.reasoning_effort = reasoningEffort;
    }
    return reasonOptions;
}

/**
 * LLM 验证器的返回结果。
 * 当验证成功时 validated_content 有值且 message 为 undefined；
 * 当验证失败时 validated_content 为 undefined 且 message 包含错误信息。
 */
class LLMValidatorResult {
    validated_content: unknown;
    message: string | undefined;

    constructor(validated_content: unknown, message: string | undefined) {
        this.validated_content = validated_content;
        this.message = message;
    }

    static success(validated_content: unknown): LLMValidatorResult {
        return new LLMValidatorResult(validated_content, undefined);
    }

    static error(message: string): LLMValidatorResult {
        return new LLMValidatorResult(undefined, message);
    }
}

/** 验证器函数签名：接收 LLM 的原始文本输出，返回验证结果 */
type ValidatorFn = (content: string) => LLMValidatorResult;

/** LLM 补全请求的通用可选参数 */
interface LLMRequestOptions {
    /** 控制模型推理深度，不传则使用模型默认值 */
    reasoningEffort?: ReasoningEffort;
}

interface LLMAskOptions {
    question: UserMessage;
    model: ModelParam;
    validator: ValidatorFn | undefined;
    requestOptions?: LLMRequestOptions;
}

interface LLMMessageBuildOptions {
    activeContext?: ActiveContextView;
    toolResultOverrides?: Map<string, string>;
    assistantReplayByMessageId?: Map<string, AssistantReplayInstruction>;
}

interface AssistantReplayInstruction {
    startPartIndex?: number;
    roundRef?: AssistantRoundRef;
}

/** Reranker API 返回的单条结果 */
interface RerankResultItem {
    index: number;
    relevance_score: number;
}

interface RerankApiResponse {
    results: RerankResultItem[];
}

class LLM {
    private static __visionCache = new Map<string, boolean>();

    /**
     * 检测模型是否支持视觉/图像输入。
     * 优先使用内置查找表，其次尝试 API 查询，结果缓存。
     * 如果无法确定，默认返回 true（乐观策略：大多数现代模型支持视觉）。
     */
    static async supportsVision(model: ModelParam = undefined): Promise<boolean> {
        const modelInstance = this.__getModelInstance(model);
        const cacheKey = `${modelInstance.base_url}::${modelInstance.model_name}`;

        if (this.__visionCache.has(cacheKey)) {
            return this.__visionCache.get(cacheKey)!;
        }

        const knownResult = lookupKnownVisionSupport(modelInstance.model_name);
        if (knownResult !== undefined) {
            this.__visionCache.set(cacheKey, knownResult);
            logger.info(`vision support for ${modelInstance.model_name}: ${knownResult} (from builtin table)`);
            return knownResult;
        }

        try {
            const apiResult = await fetchVisionSupportFromAPI(modelInstance);
            if (apiResult !== undefined) {
                this.__visionCache.set(cacheKey, apiResult);
                logger.info(`vision support for ${modelInstance.model_name}: ${apiResult} (from API)`);
                return apiResult;
            }
        } catch {
            /* API 查询失败 */
        }

        this.__visionCache.set(cacheKey, true);
        logger.info(`vision support for ${modelInstance.model_name}: true (default optimistic)`);
        return true;
    }

    /**
     * 将 ModelInstance 中的 base_url 域名加入 NO_PROXY 环境变量，
     * 使对该域名的请求绕过 HTTP 代理。仅在 no_proxy 标志为 true 时生效。
     */
    private static __ensureProxy(modelInstance: ModelInstance): void {
        if (!modelInstance.no_proxy) {
            return;
        }

        try {
            const url = new URL(modelInstance.base_url);
            const domain = url.hostname;
            if (process.env.NO_PROXY === undefined) {
                process.env.NO_PROXY = domain;
            } else if (!process.env.NO_PROXY.includes(domain)) {
                process.env.NO_PROXY += `,${domain}`;
            }
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            logger.warn(`Failed to extract domain from base_url: ${modelInstance.base_url}`, message);
        }

        logger.info('no_proxy', process.env.NO_PROXY);
    }

    static async embed(text: string): Promise<number[]> {
        const modelInstance = Setting.getInstance().getDefaultEmbeddingModelInstance();
        const client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url
        });
        const response = await client.embeddings.create({
            model: modelInstance.model_name,
            input: text
        });
        return response.data[0].embedding;
    }

    static async batchEmbed(texts: string[], batchSize: number = 64): Promise<number[][]> {
        const modelInstance = Setting.getInstance().getDefaultEmbeddingModelInstance();
        const client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url
        });
        const embeddings: number[][] = [];
        for (let i = 0; i < texts.length; i += batchSize) {
            logger.info(`progress ${i} / ${texts.length}`);
            const batch = texts.slice(i, i + batchSize);
            const response = await client.embeddings.create({
                model: modelInstance.model_name,
                input: batch
            });
            embeddings.push(...response.data.sort((a, b) => a.index - b.index).map((data) => data.embedding));
        }
        return embeddings;
    }

    /**
     * 使用 reranker 模型对候选项按与 query 的相关性重新排序，
     * 并过滤掉 relevance_score 低于阈值（0.01）的项。
     *
     * @param stringifier - 将候选项转为文本的函数，供 reranker 模型评估相关性
     */
    static async rerank<T>(
        query: string,
        items: T[],
        stringifier: (item: T) => string,
        model: ModelParam = undefined
    ): Promise<T[]> {
        if (model === undefined) {
            model = Setting.getInstance().getDefaultRerankerModelInstance();
        }
        const modelInstance = LLM.__getModelInstance(model);

        // Reranker 使用自定义 REST API 而非 OpenAI SDK
        const response = await fetch(modelInstance.base_url + '/rerank', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${modelInstance.api_key}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: modelInstance.model_name,
                query: query,
                documents: items.map((item) => stringifier(item))
            })
        });

        const rerankResult: RerankApiResponse = await response.json();
        const rerankedItems: T[] = [];
        for (const { index, relevance_score } of rerankResult.results) {
            console.info(`reranked item ${stringifier(items[index])} with relevance score ${relevance_score}`);
            if (relevance_score >= 0.01) {
                rerankedItems.push(items[index]);
            }
        }
        return rerankedItems;
    }

    /**
     * 将 ModelParam 统一解析为 ModelInstance：
     * - string → 通过别名查询配置
     * - ModelInstance → 直接使用
     * - undefined → 使用默认模型
     */
    private static __getModelInstance(model: ModelParam): ModelInstance {
        if (typeof model === 'string') {
            const instance = Setting.getInstance().getModelInstance(model);
            if (instance === null) {
                throw new Error(`model ${model} not found`);
            }
            return instance;
        } else if (model instanceof ModelInstance) {
            return model;
        } else {
            const modelInstance = Setting.getInstance().getDefaultModelInstance();
            if (modelInstance === null) {
                throw new Error('default model not found');
            }
            return modelInstance;
        }
    }

    /**
     * 内部通用问答方法。支持可选的验证器：如果验证失败，
     * 会将错误信息追加到对话中让 LLM 重试，最多重试 5 次。
     */
    private static async __ask(options: LLMAskOptions): Promise<string | object> {
        const modelInstance = LLM.__getModelInstance(options.model);
        const client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url
        });

        let finalResponse: string | object | undefined = undefined;
        let numRetries = 0;
        const messages: object[] = [options.question.toOpenAIMessage()];
        const reasoningEffort = options.requestOptions?.reasoningEffort ?? modelInstance.reasoning_effort;
        const reasonOptions = mergeReasonOptions(reasoningEffort);

        while (finalResponse === undefined && numRetries < 5) {
            const response = await withRateLimitRetry(() =>
                client.chat.completions.create({
                    model: modelInstance.model_name,
                    messages: messages as OpenAI.ChatCompletionMessageParam[],
                    ...reasonOptions
                })
            );

            if (response.choices.length !== 1) {
                throw new Error('unsupported openai response type');
            }

            let content = response.choices[0].message.content ?? '';
            content = LLM.__stripThinkTags(content);
            messages.push({ role: 'assistant', content });

            if (options.validator === undefined) {
                finalResponse = content;
            } else {
                const validationResult = options.validator(content);
                if (validationResult.validated_content !== undefined) {
                    finalResponse = validationResult.validated_content as string | object;
                } else {
                    // 验证失败，把错误信息作为新的 user 消息追加，触发 LLM 重试
                    messages.push(new UserMessage(validationResult.message).toOpenAIMessage());
                    numRetries++;
                }
            }
        }

        if (finalResponse === undefined) {
            throw new Error('failed to get a valid response after all retries');
        }

        return finalResponse;
    }

    /**
     * 剥离非流式返回中的 `<think>...</think>` 标签，只保留实际回答内容。
     * 同时处理 reasoning_content 与 content 混合的情况。
     */
    private static __stripThinkTags(content: string): string {
        return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }

    static async ask(
        question: UserMessage | string,
        model: ModelParam = undefined,
        requestOptions?: LLMRequestOptions
    ): Promise<string> {
        const options: LLMAskOptions = {
            question: question instanceof UserMessage ? question : new UserMessage(question),
            model: model,
            validator: undefined,
            requestOptions
        };
        const result = await LLM.__ask(options);
        return typeof result === 'string' ? result : JSON.stringify(result);
    }

    /**
     * 从 LLM 的回复中提取 JSON 对象。
     * 支持两种格式：裸 JSON 和 markdown ```json 代码块包裹的 JSON。
     * 如果提供了 schema，还会使用 zod 进行结构验证。
     */
    private static __objectValidator(content: string, schema?: z.ZodSchema): LLMValidatorResult {
        let jsonContent: string;
        if (content.includes('```json')) {
            jsonContent = content.split('```json', 2)[1].split('```', 2)[0];
        } else {
            jsonContent = content;
        }

        try {
            const obj: unknown = JSON.parse(jsonContent);
            if (schema !== undefined) {
                schema.parse(obj);
            }
            return LLMValidatorResult.success(obj);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(jsonContent, message);
            return LLMValidatorResult.error(`cannot parse the response as json object: ${message}`);
        }
    }

    static async askForObject(
        question: UserMessage,
        model: ModelParam = undefined,
        requestOptions?: LLMRequestOptions
    ): Promise<object> {
        const options: LLMAskOptions = {
            question,
            model,
            validator: (content) => LLM.__objectValidator(content),
            requestOptions
        };
        const result = await LLM.__ask(options);
        if (typeof result === 'object') {
            return result;
        }
        throw new Error('invalid object response');
    }

    static async askForObjectWithSchema(
        question: UserMessage,
        schema: z.ZodSchema,
        model: ModelParam = undefined,
        requestOptions?: LLMRequestOptions
    ): Promise<object> {
        const options: LLMAskOptions = {
            question,
            model,
            validator: (content) => LLM.__objectValidator(content, schema),
            requestOptions
        };
        const result = await LLM.__ask(options);
        if (typeof result === 'object') {
            return result;
        }
        throw new Error('invalid object response');
    }

    /**
     * 将 ChatContext 中的消息序列转换为 OpenAI API 所需的 messages 数组。
     *
     * - 模型可见消息统一由 compaction/context-view 决定。
     * - 若存在 compact boundary，则 active context 从该消息开始，
     *   并将 boundary 本身作为一条 UserMessage（含结构化总结）插入上下文。
     * - 对于 AssistantMessage，会调用其 toOpenAIMessages() 方法进行拆分，
     *   以保持 reasoning、tool_call、text 的正确顺序。
     * - 如显式提供 assistantReplayByMessageId，则可对单条 assistant 仅回放后半段 round / part。
     * @param supportsVision 当前模型是否支持视觉输入，false 时 UserMessage 中的图像部分会被过滤
     */
    static buildMessages(
        chatContext: ChatContext,
        supportsVision: boolean = true,
        options: LLMMessageBuildOptions = {}
    ): object[] {
        const messages: object[] = [];

        // system prompt 始终保留
        if (chatContext.system_prompt !== undefined) {
            messages.push(chatContext.system_prompt.toOpenAIMessage());
        }

        const activeContext = options.activeContext ?? buildActiveContextView(chatContext);
        const toolResultOverrides = options.toolResultOverrides;
        const assistantReplayByMessageId = new Map(options.assistantReplayByMessageId ?? []);
        if (
            activeContext.leadingPartialAssistant &&
            !assistantReplayByMessageId.has(activeContext.leadingPartialAssistant.message.message_id)
        ) {
            assistantReplayByMessageId.set(activeContext.leadingPartialAssistant.message.message_id, {
                roundRef: activeContext.leadingPartialAssistant.roundRef
            });
        }
        for (const message of activeContext.messages) {
            if (isCompactBoundaryMessage(message)) {
                messages.push(message.toOpenAIMessage());
            } else if (message instanceof AssistantMessage) {
                if (message.content.length === 0) {
                    continue;
                }
                const replayInstruction = assistantReplayByMessageId.get(message.message_id);
                if (replayInstruction?.roundRef) {
                    messages.push(
                        ...message.toOpenAIMessagesFromRound(replayInstruction.roundRef, toolResultOverrides)
                    );
                } else if (typeof replayInstruction?.startPartIndex === 'number') {
                    messages.push(
                        ...message.toOpenAIMessagesFromPartIndex(replayInstruction.startPartIndex, toolResultOverrides)
                    );
                } else {
                    messages.push(...message.toOpenAIMessages(toolResultOverrides));
                }
            } else if (message instanceof UserMessage) {
                messages.push(message.toOpenAIMessage(supportsVision));
            } else {
                messages.push((message as any).toOpenAIMessage());
            }
        }

        return messages;
    }

    /** 从 ChatContext 的 toolset 中构建 OpenAI API 的 tools 和 tool_choice 参数 */
    static buildToolOptions(chatContext: ChatContext): object {
        const tools = chatContext.getTools();
        if (tools.size > 0) {
            return {
                tool_choice: 'auto',
                tools: Array.from(tools.entries()).map(([toolId, tool]: [string, BaseTool<any>]) => ({
                    type: 'function',
                    function: {
                        name: toolId,
                        description: tool.description,
                        parameters: tool.params.toJSONSchema()
                    }
                }))
            };
        }
        return {};
    }

    static async complete(
        chatContext: ChatContext,
        model: ModelParam = undefined,
        options: LLMMessageBuildOptions = {},
        requestOptions?: LLMRequestOptions
    ): Promise<AssistantResponse> {
        const modelInstance = this.__getModelInstance(model);
        const client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url
        });
        const visionSupported = await this.supportsVision(model);
        const messages = this.buildMessages(chatContext, visionSupported, options);
        const toolOptions = this.buildToolOptions(chatContext);
        const reasoningEffort = requestOptions?.reasoningEffort ?? modelInstance.reasoning_effort;
        const reasonOptions = mergeReasonOptions(reasoningEffort);

        const response = await withRateLimitRetry(() =>
            client.chat.completions.create({
                model: modelInstance.model_name,
                messages: messages as OpenAI.ChatCompletionMessageParam[],
                max_completion_tokens: 16384,
                ...toolOptions,
                ...reasonOptions
            })
        );
        return AssistantResponse.parseOpenAIResponse(response);
    }

    static async *streamComplete(
        chatContext: ChatContext,
        model: ModelParam = undefined,
        options: LLMMessageBuildOptions = {},
        requestOptions?: LLMRequestOptions
    ): AsyncIterable<AssistantResponse> {
        const modelInstance = this.__getModelInstance(model);
        this.__ensureProxy(modelInstance);

        const client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url
        });
        const visionSupported = await this.supportsVision(model);
        const messages = this.buildMessages(chatContext, visionSupported, options);
        const toolOptions = this.buildToolOptions(chatContext);
        const reasoningEffort = requestOptions?.reasoningEffort ?? modelInstance.reasoning_effort;
        const reasonOptions = mergeReasonOptions(reasoningEffort);

        if (logger) {
            const hasImages = messages.some(
                (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url')
            );
            if (hasImages) {
                logger.info(
                    `streamComplete: sending ${messages.length} messages with inline images (visionSupported=${visionSupported})`
                );
            }
        }

        try {
            // 使用原始流式 API 而非 .stream() 方法
            // 某些模型提供商的流式响应不包含 role 字段，会导致 SDK 的 finalizeChatCompletion 报错
            // 使用 .create() with stream: true 可以绕过 SDK 的严格验证
            const stream = await withRateLimitRetry(() =>
                client.chat.completions.create({
                    model: modelInstance.model_name,
                    messages: messages as OpenAI.ChatCompletionMessageParam[],
                    max_completion_tokens: 16384,
                    stream: true,
                    stream_options: { include_usage: true },
                    ...toolOptions,
                    ...reasonOptions
                })
            );

            for await (const chunk of stream) {
                yield AssistantResponse.parseOpenAIResponse(chunk);
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
}

export { LLM, type LLMRequestOptions };
