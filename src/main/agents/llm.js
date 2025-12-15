const { OpenAI } = require('openai');
const { ChatContext, AssistantResponse } = require('./messages');
const { Setting, ModelInstance } = require('../utils/setting');


class LLM {

    static async embed(text) {
        let modelInstance = Setting.getInstance().getDefaultModelInstance();
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

    static async ask(question) {
        let modelInstance = Setting.getInstance().getDefaultModelInstance();
        var client = new OpenAI({
            apiKey: modelInstance.api_key,
            baseURL: modelInstance.base_url
        });
        const response = await client.chat.completions.create({
            model: modelInstance.model_name,
            messages: [{ role: "user", content: question }],
        })
        return response.choices[0].message.content;
    }

    /**
     * Get the model instance from the model
     * @param {ModelInstance | string | undefined} model
     * @returns {ModelInstance}
     */
    static _getModelInstance(model) {
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
        var model_instance = this._getModelInstance(model);
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
            console.error(err)
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