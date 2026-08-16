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
    ChatContext,
    AssistantResponse,
    UserMessage,
    AssistantMessage,
    ToolCallMessagePart,
    Usage,
    tryExtractFirstJson
} from './messages';
import { Setting, ModelInstance, ReasoningEffort, type ModelType } from '../utils/setting.js';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import {
    lookupKnownVisionSupport,
    fetchVisionSupportFromAPI,
    resolveModelReasoningEfforts
} from '../utils/model-context.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import type { AdapterMessageBuildOptions } from './adapters/context.js';
import { t } from '../../locale/index.js';
import { fetchModelUrl } from '../utils/model-network.js';
import { TelemetryOperation, TelemetryOperationRegistry } from '../telemetry/operation.js';
import iconv from 'iconv-lite';

/** Model 参数支持传入 ModelInstance 对象、模型别名字符串、或 undefined（使用默认模型） */
type ModelParam = ModelInstance | string | undefined;

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
    /** 限制本次补全的最大输出 token 数 */
    maxCompletionTokens?: number;
    /** 本次模型请求额外携带的运行时 HTTP headers，不落盘 */
    extraHeaders?: Record<string, string>;
    /** 重试回调，供任务级 usage 统计使用 */
    onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
    /** 请求结束后上报 usage，供任务级 token 统计使用 */
    onUsage?: (
        usage: Usage,
        context: { requestType: 'completeText' | 'complete' | 'streamComplete'; model?: string; provider?: string }
    ) => void | Promise<void>;
    /** 禁用适配器内置限流重试，由调用方统一处理重试状态展示 */
    disableInternalRetry?: boolean;
}

interface LLMAskOptions {
    question: UserMessage;
    model: ModelParam;
    validator: ValidatorFn | undefined;
    requestOptions?: LLMRequestOptions;
}

type LLMMessageBuildOptions = AdapterMessageBuildOptions;

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
    private static __adapterCache = new Map<string, OpenAIAdapter | AnthropicAdapter>();

    /**
     * Clear the adapter cache. Should be called when model provider settings change
     * (e.g. API key, base URL) to avoid leaking stale HTTP connection pools.
     */
    static clearAdapterCache(): void {
        this.__adapterCache.clear();
    }

    /**
     * 检测模型是否支持视觉/图像输入。
     * 若用户手动配置了 vision（true/false），直接以该配置为准；
     * 否则优先使用内置查找表，其次尝试 API 查询，结果缓存。
     * 如果无法确定，默认返回 false（悲观策略：无法确认视觉能力的模型
     * 不挂载/不执行图片读取工具，避免非多模态模型误读图片导致会话中断）。
     */
    static async supportsVision(model: ModelParam = undefined): Promise<boolean> {
        const modelInstance = this.__getModelInstance(model);

        // 用户手动配置的 vision 优先级最高，不参与自动识别缓存
        if (typeof modelInstance.vision === 'boolean') {
            return modelInstance.vision;
        }

        const cacheKey = [
            modelInstance.getProviderType(),
            modelInstance.base_url,
            modelInstance.model_name,
            modelInstance.no_proxy ? 'no_proxy' : 'proxy',
            modelInstance.no_ssl ? 'no_ssl' : 'ssl'
        ].join('::');

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

        this.__visionCache.set(cacheKey, false);
        logger.info(`vision support for ${modelInstance.model_name}: false (default pessimistic)`);
        return false;
    }

    /**
     * 获取指定模型支持的最低推理档位（即“尽可能少思考”）。
     *
     * 任务命名、终止性检查、技能归因等轻量场景原先硬编码
     * `reasoningEffort: 'none'` 强制关闭思考，但像 glm-5.3 这类不支持
     * 关闭思考的模型会直接报错。此接口返回该模型实际支持的最低档位
     * （如 glm-5.3 返回 'low'）；未匹配到 model-context 时回退 'none'。
     *
     * @param model 模型别名、ModelInstance 或 undefined（使用默认模型）
     */
    static getMinimalReasoningEffort(model: ModelParam = undefined): ReasoningEffort {
        return LLM.__resolveReasoningEffortBound(model, 'min');
    }

    /**
     * 获取指定模型支持的最高推理档位（即“最大限度思考”）。
     * 未匹配到 model-context 时回退 'max'。
     *
     * @param model 模型别名、ModelInstance 或 undefined（使用默认模型）
     */
    static getMaximalReasoningEffort(model: ModelParam = undefined): ReasoningEffort {
        return LLM.__resolveReasoningEffortBound(model, 'max');
    }

    /**
     * 解析模型在 model-context 中配置的推理档位边界。
     * 档位列表按系统顺序（none < low < medium < high < max）排列，
     * 因此首元素即最低档位、末元素即最高档位。
     * 模型未配置或别名无效等异常场景回退到系统默认边界（none / max）。
     */
    private static __resolveReasoningEffortBound(model: ModelParam, bound: 'min' | 'max'): ReasoningEffort {
        try {
            const modelInstance = LLM.__getModelInstance(model, 'chat');
            const levels = resolveModelReasoningEfforts({ model_name: modelInstance.model_name }).filter(
                (value): value is ReasoningEffort => value !== ''
            );
            if (bound === 'min') {
                return levels[0] ?? 'none';
            }
            return levels[levels.length - 1] ?? 'max';
        } catch {
            return bound === 'min' ? 'none' : 'max';
        }
    }

    /**
     * 发送消息前的兜底校验：遍历 ChatContext 中所有 assistant 消息的 tool_call 部分，
     * 确保每个 ToolCall.args_string 都是合法 JSON。
     *
     * 此函数直接操作 ChatContext（领域模型），与适配器层使用的具体消息格式
     * （OpenAI object[] / Anthropic messages）解耦，适配器在 buildMessages 时
     * 会自动获得修正后的 args_string。
     *
     * - 空字符串替换为 '{}'
     * - 非法 JSON 优先尝试 tryExtractFirstJson 修复，失败则替换为 '{}'
     */
    private static sanitizeOutboundMessage(chatContext: ChatContext): void {
        for (const message of chatContext.messages) {
            if (!(message instanceof AssistantMessage)) continue;
            for (const part of message.content) {
                if (part.type !== 'tool_call') continue;
                const toolParts = part as ToolCallMessagePart;
                for (const tc of toolParts.toolcalls) {
                    if (tc.shouldUseLegacyCompressedArgsPlaceholder()) continue;
                    const args = tc.args_string || '';
                    if (args.trim().length === 0) {
                        tc.args_string = '{}';
                        logger.warn(
                            `sanitizeOutboundMessage: replaced empty arguments with '{}' for tool "${tc.tool_name}" (id=${tc.id})`
                        );
                        continue;
                    }
                    try {
                        JSON.parse(args);
                    } catch {
                        const extracted = tryExtractFirstJson(args);
                        if (extracted) {
                            tc.args_string = extracted;
                            logger.warn(
                                `sanitizeOutboundMessage: repaired malformed arguments for tool "${tc.tool_name}" (id=${tc.id}) via tryExtractFirstJson`
                            );
                        } else {
                            tc.args_string = '{}';
                            logger.warn(
                                `sanitizeOutboundMessage: replaced unrecoverable arguments with '{}' for tool "${tc.tool_name}" (id=${tc.id}). ` +
                                    `Raw: ${args.substring(0, 200)}`
                            );
                        }
                    }
                }
            }
        }
    }

    private static __getAdapter(modelInstance: ModelInstance): OpenAIAdapter | AnthropicAdapter {
        const headersKey = modelInstance.custom_headers ? JSON.stringify(modelInstance.custom_headers) : '';
        const cacheKey = [
            modelInstance.getProviderType(),
            modelInstance.base_url,
            modelInstance.api_key,
            modelInstance.model_name,
            modelInstance.no_proxy ? 'no_proxy' : 'proxy',
            modelInstance.no_ssl ? 'no_ssl' : 'ssl',
            headersKey
        ].join('::');
        const cached = this.__adapterCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        let adapter: OpenAIAdapter | AnthropicAdapter;
        if (modelInstance.getProviderType() === 'anthropic') {
            adapter = new AnthropicAdapter(modelInstance);
        } else {
            adapter = new OpenAIAdapter(modelInstance);
        }
        this.__adapterCache.set(cacheKey, adapter);
        return adapter;
    }

    // Use the platform fetch path so worker callers route through the main
    // process; OpenAI SDK's node fetch hangs in the HMPC HAP worker thread.
    private static __embedHeaders(modelInstance: ModelInstance): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${modelInstance.api_key}`
        };
        if (modelInstance.custom_headers) {
            const sanitized: Record<string, string> = {};
            for (const [k, v] of Object.entries(modelInstance.custom_headers)) {
                sanitized[k] = iconv.encode(v, 'latin1').toString('latin1');
            }
            Object.assign(headers, sanitized);
        }
        return headers;
    }

    private static __embedUrl(modelInstance: ModelInstance): string {
        return (modelInstance.base_url || '').replace(/\/+$/, '') + '/embeddings';
    }

    private static async __embedRequest(
        modelInstance: ModelInstance,
        input: string | string[],
        dimensions?: number
    ): Promise<any> {
        const resp = await fetchModelUrl(modelInstance, LLM.__embedUrl(modelInstance), {
            method: 'POST',
            headers: LLM.__embedHeaders(modelInstance),
            body: JSON.stringify({
                model: modelInstance.model_name,
                input,
                ...(dimensions !== undefined ? { dimensions } : {})
            })
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            const err = new Error(`embedding API error ${resp.status}: ${body}`) as Error & {
                status?: number;
            };
            err.status = resp.status;
            throw err;
        }
        const data = await resp.json();
        if (!data || !Array.isArray(data.data)) {
            const err = new Error(t('error.model.invalid_embedding_response', { shape: 'data array' })) as Error & {
                status?: number;
            };
            err.status = 502;
            throw err;
        }
        return data;
    }

    static async embed(text: string, dimensions?: number): Promise<number[]> {
        const modelInstance = Setting.getInstance().getDefaultEmbeddingModelInstance();
        if (!modelInstance) {
            throw new Error(t('error.model.default_embedding_missing_or_type_mismatch'));
        }

        const operation = new TelemetryOperation('llm.embed', {
            'llm.model': modelInstance.model_name,
            'llm.provider': modelInstance.getProviderName(),
            'llm.request_type': 'embed'
        });
        return TelemetryOperationRegistry.aroundOperation(operation, async () => {
            const data = await LLM.__embedRequest(modelInstance, text, dimensions);
            operation.setAttribute('llm.usage.embedding_dimensions', data.data[0].embedding?.length ?? 0);
            return data.data[0].embedding;
        });
    }

    static async batchEmbed(texts: string[], batchSize: number = 64, dimensions?: number): Promise<number[][]> {
        const modelInstance = Setting.getInstance().getDefaultEmbeddingModelInstance();
        if (!modelInstance) {
            throw new Error(t('error.model.default_embedding_missing_or_type_mismatch'));
        }

        return TelemetryOperationRegistry.aroundOperation(
            new TelemetryOperation('llm.batchEmbed', {
                'llm.model': modelInstance.model_name,
                'llm.provider': modelInstance.getProviderName(),
                'llm.request_type': 'batchEmbed',
                'llm.embed.text_count': texts.length,
                'llm.embed.batch_size': batchSize
            }),
            async () => {
                const embeddings: number[][] = [];
                for (let i = 0; i < texts.length; i += batchSize) {
                    logger.info(`progress ${i} / ${texts.length}`);
                    const batch = texts.slice(i, i + batchSize);
                    const data = await LLM.__embedRequest(modelInstance, batch, dimensions);
                    embeddings.push(
                        ...data.data
                            .slice()
                            .sort((a: any, b: any) => a.index - b.index)
                            .map((d: any) => d.embedding)
                    );
                }
                return embeddings;
            }
        );
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
            if (!model) {
                throw new Error(t('error.model.default_reranker_missing'));
            }
        }
        const modelInstance = LLM.__getModelInstance(model, undefined);

        const operation = new TelemetryOperation('llm.rerank', {
            'llm.model': modelInstance.model_name,
            'llm.provider': modelInstance.getProviderName(),
            'llm.request_type': 'rerank',
            'llm.rerank.document_count': items.length
        });
        return TelemetryOperationRegistry.aroundOperation(operation, async () => {
            // Reranker 使用自定义 REST API 而非 OpenAI SDK
            const headers: Record<string, string> = {
                Authorization: `Bearer ${modelInstance.api_key}`,
                'Content-Type': 'application/json'
            };
            // 合并自定义 headers，sanitize 非 ASCII 字符防止 ByteString 编码错误
            if (modelInstance.custom_headers) {
                const sanitized: Record<string, string> = {};
                for (const [k, v] of Object.entries(modelInstance.custom_headers)) {
                    sanitized[k] = iconv.encode(v, 'latin1').toString('latin1');
                }
                Object.assign(headers, sanitized);
            }
            const response = await fetchModelUrl(
                modelInstance,
                modelInstance.base_url.replace(/\/+$/, '') + '/rerank',
                {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({
                        model: modelInstance.model_name,
                        query: query,
                        documents: items.map((item) => stringifier(item))
                    })
                }
            );

            const rerankResult: RerankApiResponse = await response.json();
            const rerankedItems: T[] = [];
            for (const { index, relevance_score } of rerankResult.results) {
                console.info(`reranked item ${stringifier(items[index])} with relevance score ${relevance_score}`);
                if (relevance_score >= 0.01) {
                    rerankedItems.push(items[index]);
                }
            }
            operation.setAttribute('llm.rerank.result_count', rerankedItems.length);
            return rerankedItems;
        });
    }

    /**
     * 将 ModelParam 统一解析为 ModelInstance：
     * - string → 通过别名查询配置
     * - ModelInstance → 直接使用
     * - undefined → 使用默认模型
     */
    private static __getModelInstance(model: ModelParam, expectedType: ModelType | undefined = 'chat'): ModelInstance {
        if (typeof model === 'string') {
            const instance = Setting.getInstance().getModelInstance(model, expectedType);
            if (instance === null) {
                throw new Error(
                    expectedType
                        ? t('error.model.alias.not_found_or_type_mismatch', {
                              alias: model,
                              type: t(`error.model.type.${expectedType}`)
                          })
                        : t('error.model.alias.not_found', { alias: model })
                );
            }
            return instance;
        } else if (model instanceof ModelInstance) {
            if (expectedType !== undefined && model.getModelType() !== expectedType) {
                throw new Error(
                    t('error.model.name.type_mismatch', {
                        name: model.model_name,
                        type: t(`error.model.type.${expectedType}`)
                    })
                );
            }
            return model;
        } else {
            const modelInstance = Setting.getInstance().getDefaultModelInstance();
            if (modelInstance === null) {
                throw new Error(t('error.model.default_chat_missing_or_type_mismatch'));
            }
            return modelInstance;
        }
    }

    /**
     * 内部通用问答方法。支持可选的验证器：如果验证失败，
     * 会将错误信息追加到对话中让 LLM 重试，最多重试 5 次。
     */
    private static async __ask(options: LLMAskOptions): Promise<string | object> {
        const modelInstance = LLM.__getModelInstance(options.model, 'chat');
        const adapter = LLM.__getAdapter(modelInstance);
        const visionSupported = await LLM.supportsVision(options.model);

        const operation = new TelemetryOperation('llm.ask', {
            'llm.model': modelInstance.model_name,
            'llm.provider': modelInstance.getProviderName(),
            'llm.request_type': 'completeText'
        });
        return TelemetryOperationRegistry.aroundOperation(operation, async () => {
            let finalResponse: string | object | undefined = undefined;
            let numRetries = 0;
            const chatContext = new ChatContext();
            chatContext.appendMessage(options.question);

            const wrappedRequestOptions = LLM.__wrapOnUsage(options.requestOptions, operation);

            while (finalResponse === undefined && numRetries < 5) {
                let content = await adapter.completeText(chatContext, visionSupported, {}, wrappedRequestOptions);
                content = LLM.__stripThinkTags(content, modelInstance);

                const assistantMessage = new AssistantMessage([], {
                    allowThinkTagParsing: modelInstance.auto_parse_think_tags
                });
                assistantMessage.appendText(content);
                chatContext.appendMessage(assistantMessage);

                if (options.validator === undefined) {
                    finalResponse = content;
                } else {
                    const validationResult = options.validator(content);
                    if (validationResult.validated_content !== undefined) {
                        finalResponse = validationResult.validated_content as string | object;
                    } else {
                        // 验证失败，把错误信息作为新的 user 消息追加，触发 LLM 重试
                        chatContext.appendMessage(new UserMessage(validationResult.message));
                        numRetries++;
                    }
                }
            }

            if (finalResponse === undefined) {
                throw new Error('failed to get a valid response after all retries');
            }

            operation.setAttribute('llm.retry_count', numRetries);
            return finalResponse;
        });
    }

    /**
     * 剥离非流式返回中的 `<think>...</think>` 标签，只保留实际回答内容。
     * 同时处理 reasoning_content 与 content 混合的情况。
     * 仅当模型设置了 auto_parse_think_tags 时才启用。
     */
    private static __stripThinkTags(content: string, modelInstance: ModelInstance | null): string {
        if (!modelInstance?.auto_parse_think_tags) {
            return content;
        }
        const message = new AssistantMessage([], { allowThinkTagParsing: true });
        message.appendText(content);
        return message.content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('')
            .trim();
    }

    /**
     * 包装 onUsage 回调，在原有回调基础上将 token 用量写入遥测操作属性。
     */
    private static __wrapOnUsage(
        requestOptions: LLMRequestOptions | undefined,
        operation: TelemetryOperation
    ): LLMRequestOptions | undefined {
        if (!requestOptions) {
            return undefined;
        }
        const originalOnUsage = requestOptions.onUsage;
        return {
            ...requestOptions,
            onUsage: async (usage: Usage, ctx) => {
                operation.setAttribute('llm.usage.prompt_tokens', usage.prompt_tokens ?? usage.input_tokens ?? 0);
                operation.setAttribute(
                    'llm.usage.completion_tokens',
                    usage.completion_tokens ?? usage.output_tokens ?? 0
                );
                operation.setAttribute('llm.usage.total_tokens', usage.total_tokens ?? 0);
                if (usage.cache_creation_input_tokens !== undefined) {
                    operation.setAttribute('llm.usage.cache_creation_input_tokens', usage.cache_creation_input_tokens);
                }
                if (usage.cache_read_input_tokens !== undefined) {
                    operation.setAttribute('llm.usage.cache_read_input_tokens', usage.cache_read_input_tokens);
                }
                if (originalOnUsage) {
                    await originalOnUsage(usage, ctx);
                }
            }
        };
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

    static async complete(
        chatContext: ChatContext,
        model: ModelParam = undefined,
        options: LLMMessageBuildOptions = {},
        requestOptions?: LLMRequestOptions
    ): Promise<AssistantResponse> {
        const modelInstance = this.__getModelInstance(model, 'chat');
        const visionSupported = await this.supportsVision(model);
        this.sanitizeOutboundMessage(chatContext);

        const operation = new TelemetryOperation('llm.complete', {
            'llm.model': modelInstance.model_name,
            'llm.provider': modelInstance.getProviderName(),
            'llm.request_type': 'complete'
        });
        return TelemetryOperationRegistry.aroundOperation(operation, async () => {
            const wrappedOptions = LLM.__wrapOnUsage(requestOptions, operation);
            return await this.__getAdapter(modelInstance).complete(
                chatContext,
                visionSupported,
                options,
                wrappedOptions
            );
        });
    }

    static async *streamComplete(
        chatContext: ChatContext,
        model: ModelParam = undefined,
        options: LLMMessageBuildOptions = {},
        requestOptions?: LLMRequestOptions
    ): AsyncIterable<AssistantResponse> {
        const modelInstance = this.__getModelInstance(model, 'chat');
        const visionSupported = await this.supportsVision(model);
        this.sanitizeOutboundMessage(chatContext);

        const operation = new TelemetryOperation('llm.streamComplete', {
            'llm.model': modelInstance.model_name,
            'llm.provider': modelInstance.getProviderName(),
            'llm.request_type': 'streamComplete'
        });
        const wrappedOptions = LLM.__wrapOnUsage(requestOptions, operation);
        const streamGen = this.__getAdapter(modelInstance).streamComplete(
            chatContext,
            visionSupported,
            options,
            wrappedOptions
        );
        for await (const response of TelemetryOperationRegistry.traceStream(operation, streamGen)) {
            yield response;
        }
    }

    /**
     * 验证 ModelInstance 是否可用：发送一条极短的 chat completion 请求，
     * 成功收到 choices 即视为验证通过。
     */
    static async verifyModel(modelInstance: ModelInstance): Promise<void> {
        if (modelInstance.getModelType() !== 'chat') {
            throw new Error(t('error.model.not_chat'));
        }
        await TelemetryOperationRegistry.aroundOperation(new TelemetryOperation('llm.verify'), async () => {
            await this.__getAdapter(modelInstance).verify();
        });
    }

    /**
     * 验证 embedding 模型是否可用：发送一条极短的 embeddings 请求，
     * 成功收到向量数组即视为验证通过。
     */
    static async verifyEmbeddingModel(modelInstance: ModelInstance): Promise<void> {
        if (modelInstance.getModelType() !== 'embedding') {
            throw new Error(t('error.model.not_embedding'));
        }
        await TelemetryOperationRegistry.aroundOperation(new TelemetryOperation('llm.verify'), async () => {
            const data = await this.__embedRequest(modelInstance, '__opendesk_embedding_verify__');
            const embedding = data?.data?.[0]?.embedding;
            if (!Array.isArray(embedding) || embedding.length === 0) {
                throw new Error(t('error.model.invalid_embedding_response', { shape: 'non-empty embedding array' }));
            }
        });
    }
}

export { LLM, type LLMRequestOptions };
