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
import { ChatContext, AssistantResponse, UserMessage, AssistantMessage } from './messages';
import { Setting, ModelInstance } from '../utils/setting.js';
import { z } from 'zod';
import { logger } from '../utils/logger.js';


class LLMAskOptions {
    /**
     * @param {UserMessage} contents
     * @param {ModelInstance | string | undefined} model
     * @param {(content: string) => LLMValidatorResult} validator
     */
    constructor(question, model, validator) {
        /** @type {UserMessage} */
        this.question = question;
        /** @type {ModelInstance | string | undefined} */
        this.model = model;
        /** @type {(content: string) => LLMValidatorResult} */
        this.validator = validator;
    }
}

class LLMValidatorResult {
    /**
     * @param {any} validated_content
     * @param {string} message
     */
    constructor(validated_content, message) {
        /** @type {any} */
        this.validated_content = validated_content;
        /** @type {string} */
        this.message = message;
    }

    static success(validated_content) {
        return new LLMValidatorResult(validated_content, undefined);
    }

    static error(message) {
        return new LLMValidatorResult(undefined, message);
    }
}

class LLM {

    /**
     * Ensure the proxy is set for the model instance
     * @param {ModelInstance} mode_instance
     * @returns {void}
     */
    static __ensureProxy(mode_instance) {
        if (!mode_instance.no_proxy) {
            return;
        }

        // 从mode_instance.base_url中获取域名并放在process.env.no_proxy里面
        try {
            const url = new URL(mode_instance.base_url);
            const domain = url.hostname;
            if (process.env.NO_PROXY === undefined) {
                process.env.NO_PROXY = domain;
            } else if (!process.env.NO_PROXY.includes(domain)) {
                process.env.NO_PROXY += `,${domain}`;
            }
        } catch (e) {
            logger.warn(`Failed to extract domain from base_url: ${mode_instance.base_url}`, e.message);
        }

        logger.info('no_proxy', process.env.NO_PROXY);
    }

    /**
     * Embed the text
     * @param {string} text
     * @returns {Promise<number[]>}
     */
    static async embed(text) {
        let modelInstance = Setting.getInstance().getDefaultEmbeddingModelInstance();
        var client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url
        });
        const response = await client.embeddings.create({
            model: modelInstance.model_name,
            input: text
        })
        return response.data[0].embedding;
    }

    /**
     * Batch embed the texts
     * @param {string[]} texts
     * @param {number} batch_size
     * @returns {Promise<number[][]>}
     */
    static async batchEmbed(texts, batch_size = 64) {
        let model_instance = Setting.getInstance().getDefaultEmbeddingModelInstance();
        var client = new OpenAI({
            apiKey: model_instance.api_key,
            baseURL: model_instance.base_url
        });
        let embeddings = [];
        for (let i = 0; i < texts.length; i += batch_size) {
            logger.info(`progress ${i} / ${texts.length}`);
            let batch = texts.slice(i, i + batch_size);
            const response = await client.embeddings.create({
                model: model_instance.model_name,
                input: batch
            })
            embeddings.push(...response.data.map(data => data.embedding));
        }
        return embeddings;
    }

    /**
    /**
     * Rerank the items using the reranker model
     *
     * @template T
     * @param {string} query
     * @param {T[]} items
     * @param {(item: T) => string} stringifier
     * @param {ModelInstance | string | undefined} model
     * @returns {Promise<T[]>}
     */
    static async rerank(query, items, stringifier, model = undefined) {
        if (model === undefined) {
            model = Setting.getInstance().getDefaultRerankerModelInstance();
        }
        let modelInstance = LLM.__getModelInstance(model);
        const response = await fetch(modelInstance.base_url + '/rerank', {
            method: 'POST',
            headers: {Authorization: `Bearer ${modelInstance.api_key}`, 'Content-Type': 'application/json'},
            body: JSON.stringify({
                model: modelInstance.model_name,
                query: query,
                documents: items.map(item => stringifier(item))
            }),
        });

        const rerankResult = await response.json();
        const rerankedItems = [];
        for (const { index, relevance_score } of rerankResult.results) {
            console.info(`reranked item ${stringifier(items[index])} with relevance score ${relevance_score}`);
            if (relevance_score >= 0.01) {
                rerankedItems.push(items[index]);
            }
        }
        return rerankedItems;
    }

    /**
     * Get the model instance from the model
     * @param {ModelInstance | string | undefined} model
     * @returns {ModelInstance}
     */
    static __getModelInstance(model) {
        if (typeof model === 'string') {
            return Setting.getInstance().getModelInstance(model);
        } else if (model instanceof ModelInstance) {
            return model;
        } else {
            let model_instance = Setting.getInstance().getDefaultModelInstance();
            if (model_instance === null) {
                throw new Error('default model not found');
            }
            return model_instance;
        }
    }

    /**
     * Ask the LLM with the given options, internally used by the public APIs
     * @param {LLMAskOptions} options
     * @returns {Promise<string | object>}
     */
    static async __ask(options) {
        let modelInstance = LLM.__getModelInstance(options.model);
        var client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url
        });

        var final_response = undefined;
        var num_retries = 0;
        var question = options.question;
        var messages = [question.toOpenAIMessage()];

        while (final_response === undefined && num_retries < 5) {
            let response = await client.chat.completions.create({
                model: modelInstance.model_name,
                messages: messages
            })

            if (response.choices.length !== 1) {
                throw new Error('unsupported openai response type');
            }
            messages.push({ role: 'assistant', content: response.choices[0].message.content });
            let content = response.choices[0].message.content;
            if (options.validator === undefined) {
                final_response = content;
            } else {
                let validation_result = options.validator(content);
                if (validation_result.validated_content !== undefined) {
                    final_response = validation_result.validated_content;
                } else {
                    messages.push(new UserMessage(validation_result.message).toOpenAIMessage());
                    num_retries++;
                }
            }
        }

        if (final_response === undefined) {
            throw new Error('failed to get a valid response after all retries');
        }

        return final_response;
    }

    /**
     * Ask the LLM with the given question and model, internally used by the public APIs
     * @param {UserMessage} question
     * @param {ModelInstance | string | undefined} model
     * @returns {Promise<string>}
     */
    static async ask(question, model = undefined) {
        let options = new LLMAskOptions(question, model, undefined);
        let result = await LLM.__ask(options);
        if (typeof result === 'string') {
            return result;
        } else {
            return JSON.stringify(result);
        }
    }

    /**
     * Validate the content as an object, or whether it follows the schema
     * @param {string} content
     * @param {z.ZodSchema | undefined} schema
     * @returns {LLMValidatorResult}
     */
    static __objectValidator(content, schema = undefined) {
        let json_content = '';
        if (content.includes('```json')) {
            json_content = content.split('```json', 2)[1].split('```', 2)[0];
        } else {
            json_content = content;
        }

        try {
            let obj = JSON.parse(json_content);
            if (schema !== undefined) {
                schema.parse(obj);
            }
            return LLMValidatorResult.success(obj);
        } catch (error) {
            logger.warn(json_content, error.message);
            return LLMValidatorResult.error(`cannot parse the response as json object: ${error.message}`);
        }
    }

    /**
     * Ask the LLM for an object
     * @param {UserMessage} question
     * @param {ModelInstance | string | undefined} model
     * @returns {Promise<object>}
     */
    static async askForObject(question, model = undefined) {
        let options = new LLMAskOptions(question, model, content => LLM.__objectValidator(content));
        let result = await LLM.__ask(options);
        if (typeof result === 'object') {
            return result;
        } else {
            throw new Error('invalid object response');
        }
    }

    /**
     * Ask the LLM for an object with a schema
     * @param {UserMessage} question
     * @param {z.ZodSchema} schema
     * @param {ModelInstance | string | undefined} model
     * @returns {Promise<object>}
     */
    static async askForObjectWithSchema(question, schema, model = undefined) {
        let options = new LLMAskOptions(question, model, content => LLM.__objectValidator(content, schema));
        let result = await LLM.__ask(options);
        if (typeof result === 'object') {
            return result;
        } else {
            throw new Error('invalid object response');
        }
    }

    static buildMessages(chat_context) {
        var messages = []
        if (chat_context.system_prompt !== undefined) {
            messages.push(chat_context.system_prompt.toOpenAIMessage())
        }
        for (let message of chat_context.messages) {
            if (message instanceof AssistantMessage && message.content.length === 0) {
                continue;
            }
            messages.push(message.toOpenAIMessage())
            if (message instanceof AssistantMessage) {
                messages.push(...message.getOpenAIToolMessages());
            }
        }
        return messages;
    }

    static buildToolOptions(chat_context) {
        let tool_options = {}
        let tools = chat_context.getTools();
        if (tools.size > 0) {
            tool_options = {
                tool_choice: 'auto',
                tools: Array.from(tools.entries()).map(([tool_id, tool]) => {
                    return {
                        type: 'function',
                        function: {
                            name: tool_id,
                            description: tool.description,
                            parameters: tool.params.toJSONSchema(),
                        },
                    }
                }),
            }
        }
        return tool_options;
    }

    /**
     *
     * @param {ChatContext} chat_context
     * @param {ModelInstance | string | undefined} model
     * @returns {Promise<AssistantResponse>}
     */
    static async complete(chat_context, model = undefined) {
        var model_instance = this.__getModelInstance(model);
        var client = new OpenAI({
            apiKey: model_instance.api_key,
            baseURL: model_instance.base_url
        });
        var messages = this.buildMessages(chat_context);
        var tool_options = this.buildToolOptions(chat_context);

        const response = await client.chat.completions.create({
            model: model_instance.model_name,
            messages: messages,
            max_completion_tokens: 16384,
            ...tool_options
        })
        return AssistantResponse.parseOpenAIResponse(response);
    }

    /**
     *
     * @param {ChatContext} chat_context
     * @param {ModelInstance | string | undefined} model
     * @returns {AsyncIterable<AssistantResponse>}
     */
    static async* streamComplete(chat_context, model = undefined) {
        var model_instance = this.__getModelInstance(model);
        var error_message = '';
        this.__ensureProxy(model_instance);

        var client = new OpenAI({
            apiKey: model_instance.api_key,
            baseURL: model_instance.base_url
        });
        var messages = this.buildMessages(chat_context);
        var tool_options = this.buildToolOptions(chat_context);

        const stream = client.chat.completions.stream({
            model: model_instance.model_name,
            messages: messages,
            max_completion_tokens: 16384,
            stream: true,
            stream_options: { include_usage: true },
            ...tool_options
        })

        for await (const chunk of stream) {
            yield AssistantResponse.parseOpenAIResponse(chunk);
        }
    }
}

export { LLM };