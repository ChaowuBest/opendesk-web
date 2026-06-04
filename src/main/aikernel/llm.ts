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
    ChatContext,
    AssistantResponse,
    UserMessage,
    AssistantMessage,
    isCompactBoundaryMessage,
    ToolCall,
    ToolCallMessagePart,
    Usage
} from './messages';
import { Setting, ModelInstance, ReasoningEffort, type NormalizedProviderType } from '../utils/setting.js';
import { buildActiveContextView } from './compaction/context-view.js';
import type { ActiveContextView, AssistantRoundRef } from './compaction/types.js';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { lookupKnownVisionSupport, fetchVisionSupportFromAPI } from '../utils/model-context.js';
import { getPlatform } from '../../platforms/base.js';
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
    } else if (reasoningEffort) {
        reasonOptions.thinking = { type: 'enabled' };
        reasonOptions.reasoning_effort = reasoningEffort;
    }
    return reasonOptions;
}

function normalizeMaxCompletionTokens(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    return Math.floor(value);
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
    /** 限制本次补全的最大输出 token 数 */
    maxCompletionTokens?: number;
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

interface AnthropicRequestMessages {
    system?: string;
    messages: object[];
}

interface AnthropicStreamState {
    toolCalls: Map<number, { id: string; name: string }>;
    usage: Record<string, unknown>;
}

/** Reranker API 返回的单条结果 */
interface RerankResultItem {
    index: number;
    relevance_score: number;
}

interface RerankApiResponse {
    results: RerankResultItem[];
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

class LLM {
    private static __visionCache = new Map<string, boolean>();

    /**
     * 检测模型是否支持视觉/图像输入。
     * 优先使用内置查找表，其次尝试 API 查询，结果缓存。
     * 如果无法确定，默认返回 true（乐观策略：大多数现代模型支持视觉）。
     */
    static async supportsVision(model: ModelParam = undefined): Promise<boolean> {
        const modelInstance = this.__getModelInstance(model);
        const cacheKey = `${modelInstance.getProviderType()}::${modelInstance.base_url}::${modelInstance.model_name}`;

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

    private static __providerType(modelInstance: ModelInstance): NormalizedProviderType {
        return modelInstance.getProviderType();
    }

    private static __anthropicHeaders(modelInstance: ModelInstance): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'x-api-key': modelInstance.api_key,
            Authorization: `Bearer ${modelInstance.api_key}`,
            'anthropic-version': '2023-06-01',
            ...(modelInstance.custom_headers ?? {})
        };
    }

    private static async __anthropicHTTPError(response: Response): Promise<Error & { status?: number }> {
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

    private static async __createAnthropicMessage(modelInstance: ModelInstance, body: object): Promise<any> {
        const response = await getPlatform().fetch(joinAnthropicApiPath(modelInstance.base_url, 'messages'), {
            method: 'POST',
            headers: LLM.__anthropicHeaders(modelInstance),
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            throw await LLM.__anthropicHTTPError(response);
        }
        return await response.json();
    }

    private static __openAIContentToText(content: unknown): string {
        if (typeof content === 'string') {
            return content;
        }
        if (!Array.isArray(content)) {
            return '';
        }
        return content
            .map((part) => {
                const record = asRecord(part);
                if (!record) return '';
                if (record.type === 'text' && typeof record.text === 'string') {
                    return record.text;
                }
                return '';
            })
            .filter((text) => text.length > 0)
            .join('\n');
    }

    private static __openAIImageToAnthropicBlock(part: Record<string, unknown>): object | undefined {
        const imageUrl = asRecord(part.image_url);
        const url = typeof imageUrl?.url === 'string' ? imageUrl.url : undefined;
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

    private static __openAIContentToAnthropicBlocks(content: unknown, supportsVision: boolean): object[] {
        if (typeof content === 'string') {
            return content.length > 0 ? [{ type: 'text', text: content }] : [];
        }
        if (!Array.isArray(content)) {
            return [];
        }

        const blocks: object[] = [];
        for (const part of content) {
            const record = asRecord(part);
            if (!record) continue;
            if (record.type === 'text' && typeof record.text === 'string') {
                if (record.text.length > 0) {
                    blocks.push({ type: 'text', text: record.text });
                }
            } else if (record.type === 'image_url' && supportsVision) {
                const imageBlock = LLM.__openAIImageToAnthropicBlock(record);
                if (imageBlock) {
                    blocks.push(imageBlock);
                }
            }
        }
        return blocks;
    }

    private static __parseToolInput(argsString: string): object {
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

    private static __appendAnthropicMessage(messages: object[], role: 'user' | 'assistant', content: object[]): void {
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

    private static __toAnthropicMessages(
        openaiMessages: object[],
        supportsVision: boolean = true
    ): AnthropicRequestMessages {
        const systemParts: string[] = [];
        const messages: object[] = [];

        for (const rawMessage of openaiMessages) {
            const message = asRecord(rawMessage);
            if (!message) continue;

            const role = message.role;
            if (role === 'system' || role === 'developer') {
                const systemText = LLM.__openAIContentToText(message.content);
                if (systemText.length > 0) {
                    systemParts.push(systemText);
                }
                continue;
            }

            if (role === 'user') {
                LLM.__appendAnthropicMessage(
                    messages,
                    'user',
                    LLM.__openAIContentToAnthropicBlocks(message.content, supportsVision)
                );
                continue;
            }

            if (role === 'tool') {
                const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
                const toolContent = LLM.__openAIContentToText(message.content);
                LLM.__appendAnthropicMessage(messages, 'user', [
                    {
                        type: 'tool_result',
                        tool_use_id: toolCallId,
                        content: toolContent
                    }
                ]);
                continue;
            }

            if (role === 'assistant') {
                const content: object[] = [];
                if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim().length > 0) {
                    content.push({ type: 'text', text: `<think>${message.reasoning_content}</think>` });
                }
                content.push(...LLM.__openAIContentToAnthropicBlocks(message.content, false));

                const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
                for (let i = 0; i < toolCalls.length; i++) {
                    const toolCall = asRecord(toolCalls[i]);
                    const fn = asRecord(toolCall?.function);
                    const id = typeof toolCall?.id === 'string' && toolCall.id ? toolCall.id : `toolu_${i}`;
                    const name = typeof fn?.name === 'string' ? fn.name : 'unknown';
                    const argsString = typeof fn?.arguments === 'string' ? fn.arguments : '';
                    content.push({
                        type: 'tool_use',
                        id,
                        name,
                        input: LLM.__parseToolInput(argsString)
                    });
                }

                LLM.__appendAnthropicMessage(messages, 'assistant', content);
            }
        }

        const result: AnthropicRequestMessages = { messages };
        if (systemParts.length > 0) {
            result.system = systemParts.join('\n\n');
        }
        return result;
    }

    static buildAnthropicMessages(
        chatContext: ChatContext,
        supportsVision: boolean = true,
        options: LLMMessageBuildOptions = {}
    ): AnthropicRequestMessages {
        return LLM.__toAnthropicMessages(LLM.buildMessages(chatContext, supportsVision, options), supportsVision);
    }

    private static __anthropicToolOptions(openAIToolOptions: object): object {
        const record = asRecord(openAIToolOptions);
        const tools = Array.isArray(record?.tools) ? record.tools : [];
        if (tools.length === 0) {
            return {};
        }

        return {
            tool_choice: { type: 'auto' },
            tools: tools
                .map((tool) => {
                    const toolRecord = asRecord(tool);
                    const fn = asRecord(toolRecord?.function);
                    if (!fn || typeof fn.name !== 'string') {
                        return undefined;
                    }
                    return {
                        name: fn.name,
                        description: typeof fn.description === 'string' ? fn.description : '',
                        input_schema: asRecord(fn.parameters) ?? { type: 'object', properties: {} }
                    };
                })
                .filter((tool): tool is object => tool !== undefined)
        };
    }

    private static __anthropicStopReason(stopReason: unknown): 'stop' | 'error' | 'tool_calls' | null {
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

    private static __parseAnthropicMessageBody(body: any): AssistantResponse {
        const message = new AssistantMessage();
        const content = Array.isArray(body?.content) ? body.content : [];
        for (let i = 0; i < content.length; i++) {
            const block = content[i];
            if (block?.type === 'text' && typeof block.text === 'string') {
                message.appendText(block.text);
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

        const response = new AssistantResponse(message, LLM.__anthropicStopReason(body?.stop_reason));
        const usage = Usage.fromRaw(body?.usage);
        if (usage) {
            response.usage = usage;
        }
        return response;
    }

    private static __anthropicText(body: any): string {
        const content = Array.isArray(body?.content) ? body.content : [];
        return content
            .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
            .filter((text) => text.length > 0)
            .join('');
    }

    private static __responseWithUsage(response: AssistantResponse, state: AnthropicStreamState): AssistantResponse {
        const usage = Usage.fromRaw(state.usage);
        if (usage) {
            response.usage = usage;
        }
        return response;
    }

    private static __parseAnthropicStreamEvent(rawEvent: string, state: AnthropicStreamState): AssistantResponse[] {
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
                responses.push(LLM.__responseWithUsage(new AssistantResponse(message), state));
            }
            return responses;
        }

        if (eventData.type === 'content_block_delta') {
            const delta = eventData.delta;
            const message = new AssistantMessage();

            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                message.appendText(delta.text);
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
                responses.push(LLM.__responseWithUsage(new AssistantResponse(message), state));
            }
            return responses;
        }

        if (eventData.type === 'message_delta') {
            Object.assign(state.usage, eventData.usage ?? {});
            responses.push(
                LLM.__responseWithUsage(
                    new AssistantResponse(
                        new AssistantMessage(),
                        LLM.__anthropicStopReason(eventData.delta?.stop_reason)
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

    private static async *__streamAnthropicMessages(
        modelInstance: ModelInstance,
        body: object
    ): AsyncIterable<AssistantResponse> {
        const response = await withRateLimitRetry(async () => {
            const resp = await getPlatform().fetch(joinAnthropicApiPath(modelInstance.base_url, 'messages'), {
                method: 'POST',
                headers: LLM.__anthropicHeaders(modelInstance),
                body: JSON.stringify(body)
            });
            if (!resp.ok) {
                throw await LLM.__anthropicHTTPError(resp);
            }
            return resp;
        });

        if (!response.body) {
            throw new Error('Anthropic stream response body is empty');
        }

        const reader = response.body.getReader();
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
                for (const responseChunk of LLM.__parseAnthropicStreamEvent(event, state)) {
                    yield responseChunk;
                }
            }
        }

        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
            for (const responseChunk of LLM.__parseAnthropicStreamEvent(buffer, state)) {
                yield responseChunk;
            }
        }
    }

    static async embed(text: string): Promise<number[]> {
        const modelInstance = Setting.getInstance().getDefaultEmbeddingModelInstance();
        if (!modelInstance) {
            throw new Error('default embedding model not configured');
        }
        const client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url,
            defaultHeaders: modelInstance.custom_headers
        });
        const response = await client.embeddings.create({
            model: modelInstance.model_name,
            input: text
        });
        return response.data[0].embedding;
    }

    static async batchEmbed(texts: string[], batchSize: number = 64): Promise<number[][]> {
        const modelInstance = Setting.getInstance().getDefaultEmbeddingModelInstance();
        if (!modelInstance) {
            throw new Error('default embedding model not configured');
        }
        const client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url,
            defaultHeaders: modelInstance.custom_headers
        });
        const embeddings: number[][] = [];
        for (let i = 0; i < texts.length; i += batchSize) {
            logger.info(`progress ${i} / ${texts.length}`);
            const batch = texts.slice(i, i + batchSize);
            const response = await client.embeddings.create({
                model: modelInstance.model_name,
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
                throw new Error('default reranker model not configured');
            }
        }
        const modelInstance = LLM.__getModelInstance(model);

        // Reranker 使用自定义 REST API 而非 OpenAI SDK
        const headers: Record<string, string> = {
            Authorization: `Bearer ${modelInstance.api_key}`,
            'Content-Type': 'application/json'
        };
        // 合并自定义 headers
        if (modelInstance.custom_headers) {
            Object.assign(headers, modelInstance.custom_headers);
        }
        const response = await getPlatform().fetch(modelInstance.base_url + '/rerank', {
            method: 'POST',
            headers: headers,
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
                throw new Error('default model not configured');
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
        if (LLM.__providerType(modelInstance) === 'anthropic') {
            return await LLM.__askAnthropic(options, modelInstance);
        }

        const client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url,
            defaultHeaders: modelInstance.custom_headers
        });

        let finalResponse: string | object | undefined = undefined;
        let numRetries = 0;
        const messages: object[] = [options.question.toOpenAIMessage()];
        const reasoningEffort = options.requestOptions?.reasoningEffort ?? modelInstance.reasoning_effort;
        const reasonOptions = mergeReasonOptions(reasoningEffort);
        const maxCompletionTokens = normalizeMaxCompletionTokens(options.requestOptions?.maxCompletionTokens);

        while (finalResponse === undefined && numRetries < 5) {
            const response = await withRateLimitRetry(() =>
                client.chat.completions.create({
                    model: modelInstance.model_name,
                    messages: messages as OpenAI.ChatCompletionMessageParam[],
                    ...(maxCompletionTokens !== undefined
                        ? {
                              max_completion_tokens: maxCompletionTokens
                          }
                        : {}),
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

    private static async __askAnthropic(
        options: LLMAskOptions,
        modelInstance: ModelInstance
    ): Promise<string | object> {
        let finalResponse: string | object | undefined = undefined;
        let numRetries = 0;
        const messages: object[] = [options.question.toOpenAIMessage()];
        const maxCompletionTokens = normalizeMaxCompletionTokens(options.requestOptions?.maxCompletionTokens) ?? 4096;

        while (finalResponse === undefined && numRetries < 5) {
            const anthropicMessages = LLM.__toAnthropicMessages(messages);
            const response = await withRateLimitRetry(() =>
                LLM.__createAnthropicMessage(modelInstance, {
                    model: modelInstance.model_name,
                    max_tokens: maxCompletionTokens,
                    ...(anthropicMessages.system ? { system: anthropicMessages.system } : {}),
                    messages: anthropicMessages.messages
                })
            );

            let content = LLM.__anthropicText(response);
            content = LLM.__stripThinkTags(content);
            messages.push({ role: 'assistant', content });

            if (options.validator === undefined) {
                finalResponse = content;
            } else {
                const validationResult = options.validator(content);
                if (validationResult.validated_content !== undefined) {
                    finalResponse = validationResult.validated_content as string | object;
                } else {
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
        const visionSupported = await this.supportsVision(model);
        const messages = this.buildMessages(chatContext, visionSupported, options);
        const toolOptions = this.buildToolOptions(chatContext);
        const maxCompletionTokens = normalizeMaxCompletionTokens(requestOptions?.maxCompletionTokens) ?? 16384;

        if (LLM.__providerType(modelInstance) === 'anthropic') {
            const anthropicMessages = LLM.__toAnthropicMessages(messages, visionSupported);
            const response = await withRateLimitRetry(() =>
                LLM.__createAnthropicMessage(modelInstance, {
                    model: modelInstance.model_name,
                    max_tokens: maxCompletionTokens,
                    ...(anthropicMessages.system ? { system: anthropicMessages.system } : {}),
                    messages: anthropicMessages.messages,
                    ...LLM.__anthropicToolOptions(toolOptions)
                })
            );
            return LLM.__parseAnthropicMessageBody(response);
        }

        const client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url,
            defaultHeaders: modelInstance.custom_headers
        });
        const reasoningEffort = requestOptions?.reasoningEffort ?? modelInstance.reasoning_effort;
        const reasonOptions = mergeReasonOptions(reasoningEffort);

        const response = await withRateLimitRetry(() =>
            client.chat.completions.create({
                model: modelInstance.model_name,
                messages: messages as OpenAI.ChatCompletionMessageParam[],
                max_completion_tokens: maxCompletionTokens,
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

        const visionSupported = await this.supportsVision(model);
        const messages = this.buildMessages(chatContext, visionSupported, options);
        const toolOptions = this.buildToolOptions(chatContext);
        const maxCompletionTokens = normalizeMaxCompletionTokens(requestOptions?.maxCompletionTokens) ?? 16384;

        if (LLM.__providerType(modelInstance) === 'anthropic') {
            const anthropicMessages = LLM.__toAnthropicMessages(messages, visionSupported);
            try {
                yield* LLM.__streamAnthropicMessages(modelInstance, {
                    model: modelInstance.model_name,
                    max_tokens: maxCompletionTokens,
                    stream: true,
                    ...(anthropicMessages.system ? { system: anthropicMessages.system } : {}),
                    messages: anthropicMessages.messages,
                    ...LLM.__anthropicToolOptions(toolOptions)
                });
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
            return;
        }

        const client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url,
            defaultHeaders: modelInstance.custom_headers
        });
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
                    max_completion_tokens: maxCompletionTokens,
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

    /**
     * 验证 ModelInstance 是否可用：发送一条极短的 chat completion 请求，
     * 成功收到 choices 即视为验证通过。
     */
    static async verifyModel(modelInstance: ModelInstance): Promise<void> {
        this.__ensureProxy(modelInstance);
        if (LLM.__providerType(modelInstance) === 'anthropic') {
            const response = await withRateLimitRetry(() =>
                LLM.__createAnthropicMessage(modelInstance, {
                    model: modelInstance.model_name,
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 8
                })
            );
            if (!Array.isArray(response?.content)) {
                throw new Error('模型返回结果异常');
            }
            return;
        }

        const client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url,
            defaultHeaders: modelInstance.custom_headers
        });
        const response = await client.chat.completions.create({
            model: modelInstance.model_name,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 8
        });
        if (!response?.choices?.[0]) {
            throw new Error('模型返回结果异常');
        }
    }
}

export { LLM, type LLMRequestOptions };
