const { OpenAI } = require('openai');
const { ChatContext, AssistantResponse } = require('./messages');
const { Setting } = require('../utils/setting');


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

    static async complete(chatContext, modelInstance = undefined) {

    }

    /**
     *
     * @param {ChatContext} chat_context
     * @param {string | undefined} model_alias
     * @returns {AsyncIterable<AssistantResponse>}
     */
    static async* streamComplete(chat_context, model_alias = undefined) {
        /** @type {ModelInstance | null} */
        var model_instance = null;
        if (model_alias === undefined) {
            model_instance = Setting.getInstance().getDefaultModelInstance();
        } else {
            model_instance = Setting.getInstance().getModelInstance(model_alias);
        }

        if (model_instance === null) {
            throw new Error(`model ${model_alias} not found`);
        }

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
            // yield AssistantResponse.error(`error: ${err}`)
        })

        for await (const chunk of stream) {
            yield await AssistantResponse.parseOpenAIResponse(chunk);
        }
    }
}

module.exports = { LLM };