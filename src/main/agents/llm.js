const { OpenAI } = require('openai');
const { ChatContext, AssistantResponse, UserMessage } = require('./messages');
const { Setting, ModelInstance } = require('../utils/setting');
const { z } = require('zod');
const { logger } = require('../utils/logger');


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
        var messages = [question];

        while (final_response === undefined && num_retries < 5) {
            let response = await client.chat.completions.create({
                model: modelInstance.model_name,
                messages: messages
            })

            if (response.choices.length !== 1) {
                throw new Error('unsupported openai response type');
            }
            messages.push(response.choices[0]);
            let content = response.choices[0].message.content;
            if (options.validator === undefined) {
                final_response = content;
            } else {
                let validation_result = options.validator(content);
                if (validation_result.validated_content !== undefined) {
                    final_response = validation_result.validated_content;
                } else {
                    messages.push(new UserMessage(validation_result.message));
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

    /**
     *
     * @param {ChatContext} chat_context
     * @param {ModelInstance | string | undefined} model
     * @returns {Promise<AssistantResponse>}
     */
    static async complete(chat_context, model = undefined) {
        var model_instance = this._getModelInstance(model);
        var client = new OpenAI({
            apiKey: model_instance.api_key,
            baseURL: model_instance.base_url
        });
        const response = await client.chat.completions.create({
            model: model_instance.model_name,
            messages: chat_context.messages.map(message => message.toOpenAIMessage()),
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
        this.__ensureProxy(model_instance);

        var client = new OpenAI({
            apiKey: model_instance.api_key,
            baseURL: model_instance.base_url
        });
        var messages = []
        if (chat_context.system_prompt !== undefined) {
            messages.push(chat_context.system_prompt.toOpenAIMessage())
        }
        for (let message of chat_context.messages) {
            messages.push(message.toOpenAIMessage())
        }

        const stream = await client.chat.completions.create({
            model: model_instance.model_name,
            messages: messages,
            stream: true
        }).catch(err => {
            logger.error(err)
        })

        if (stream === undefined) {
            yield AssistantResponse.error('error: completion failed');
            return;
        }
        for await (const chunk of stream) {
            yield await AssistantResponse.parseOpenAIResponse(chunk);
        }
    }
}

module.exports = { LLM };