const { Marked } = require('marked');
const { markedHighlight } = require('marked-highlight');
const markedKatex = require('marked-katex-extension');
const hljs = require('highlight.js');


const marked = new Marked(
    markedHighlight({
      emptyLangClass: 'hljs',
      langPrefix: 'hljs language-',
      highlight(code, lang, info) {
        const language = hljs.getLanguage(lang) ? lang : 'plaintext';
        return hljs.highlight(code, { language }).value;
      }
    })
  );

marked.use(markedKatex({
    throwOnError: false,
    displayMode: true,
    nonStandard: true
}));

/**
 * This is NOT an OpenAI message part, but a message part for our own message system.
 * @class ReasoningMessagePart
 * @property {'reasoning'} type
 * @property {string} content
 */
class ReasoningMessagePart {
    /**
     * Reasoning message part
     * @param {string} content
     */
    constructor (content) {
        this.type = 'reasoning';
        this.content = content;
        /** @type {string | undefined} cached render result of the reasoning */
        this.rendered = undefined;
    }

    async render() {
        this.rendered = this.content;
    }

    static assign(reasoning_message_part_obj) {
        Object.setPrototypeOf(reasoning_message_part_obj, ReasoningMessagePart.prototype);
        return reasoning_message_part_obj;
    }
}

/**
 * @class TextMessagePart
 * @property {'text'} type
 * @property {string} text
 */
class TextMessagePart {
    /**
     * Plain text message part
     * @param {string} text
     */
    constructor (text) {
        this.type = 'text';
        this.text = text;
        /** @type {string | undefined} cached render result of the text */
        this.rendered = undefined;
    }

    toOpenAIMessagePart() {
        return { type: 'text', text: this.text }
    }

    static assign(text_message_part_obj) {
        Object.setPrototypeOf(text_message_part_obj, TextMessagePart.prototype);
        return text_message_part_obj;
    }

    async render() {
        this.rendered = await marked.parse(this.text)
    }
}

/**
 * @class ImageMessagePart
 */
class ImageMessagePart {
    /**
     * Image message part
     * @param {string} image_url
     */
    constructor (image_url) {
        /** @type {'image_url'} */
        this.type = 'image_url';
        /** @type {{ url: string }} */
        this.image_url = { url: image_url };
        /** @type {string | undefined} cached render result of the image */
        this.rendered = undefined;
    }

    toOpenAIMessagePart() {
        return { type: this.type, image_url: this.image_url };
    }

    async render() {
        this.rendered = `<img src="${this.image_url.url}" alt="image" />`;
    }

    static assign(image_message_part_obj) {
        Object.setPrototypeOf(image_message_part_obj, ImageMessagePart.prototype);
        return image_message_part_obj;
    }
}

/**
 * @class SystemMessage
 * @property {'system'} role
 * @property {string} content
 */
class SystemMessage {
    constructor (content) {
        this.role = 'system';
        this.content = content;
    }

    static assign(system_message_obj) {
        Object.setPrototypeOf(system_message_obj, SystemMessage.prototype);
        return system_message_obj;
    }
}

/**
 * @class UserMessage
 * @property {(TextMessagePart | ImageMessagePart)[]} content
 */
class UserMessage {
    /**
     *
     * @param {string | undefined} content
     */
    constructor (content = undefined) {
        this.role = 'user';
        this.content = [];
        if (typeof content === 'string') {
            this.content.push(new TextMessagePart(content));
        }
    }

    /**
     * Append a text part to the message
     * @param {string} text
     * @returns {UserMessage}
     */
    appendText(text) {
        if (this.content.length > 0 && this.content[this.content.length - 1].type === 'text') {
            this.content[this.content.length - 1].text += text;
        } else {
            this.content.push(new TextMessagePart(text));
        }
        return this;
    }

    /**
     * Append an image URL to the message
     * @param {string} image_url
     * @returns {UserMessage}
     */
    appendImageURL(image_url) {
        this.content.push(new ImageMessagePart(image_url));
        return this;
    }

    static assign(user_message_obj) {
        Object.setPrototypeOf(user_message_obj, UserMessage.prototype);
        if (user_message_obj.content !== undefined) {
            for (let part of user_message_obj.content) {
                if (part.type === 'text') {
                    TextMessagePart.assign(part);
                } else {
                    throw new Error(`unsupported part type ${part.constructor.name}`);
                }
            }
        }
        return user_message_obj;
    }

    async render() {
        for (let part of this.content) {
            await part.render();
        }
    }

    toOpenAIMessage() {
        return {
            role: this.role,
            content: this.content.map(part => part.toOpenAIMessagePart())
        }
    }
}

class AssistantMessage {

    /**
     *
     * @param {(TextMessagePart | ReasoningMessagePart)[] | undefined} content
     */
    constructor (content) {
        this.role = 'assistant';
        this.message_id = crypto.randomUUID();

        /** @type {(TextMessagePart | ReasoningMessagePart)[]} */
        this.content = content === undefined ? [] : content;
    }

    /**
     * Assign the prototype of the given object to the AssistantMessage prototype
     * @param {object} assistant_message_obj
     * @returns {AssistantMessage}
     */
    static assign(assistant_message_obj) {
        Object.setPrototypeOf(assistant_message_obj, AssistantMessage.prototype);
        if (assistant_message_obj.content !== undefined) {
            for (let part of assistant_message_obj.content) {
                if (part.type === 'text') {
                    TextMessagePart.assign(part);
                } else if (part.type === 'reasoning') {
                    ReasoningMessagePart.assign(part);
                }
            }
        }
        return assistant_message_obj;
    }

    async render() {
        for (let part of this.content) {
            await part.render();
        }
    }

    /**
     * Merges the give message to this message and returns itself
     * @param {AssistantMessage} chunk
     * @returns {AssistantMessage}
     */
    mergeChunk(chunk) {
        for (var part of chunk.content) {
            this.appendPart(part);
        }
        return this;
    }

    appendPart(part) {
        if (part.type === 'text') {
            this.appendText(part.text);
        } else if (part.type === 'reasoning') {
            this.appendReasoningContent(part.content);
        } else {
            throw new Error(`unsupported part type ${part.type}`);
        }
    }

    appendReasoningContent(content) {
        if (this.content.length === 0) {
            this.content.push(new ReasoningMessagePart(content));
        } else if (this.content[this.content.length - 1].type === 'reasoning') {
            this.content[this.content.length - 1].content += content;
        } else {
            this.content.push(new ReasoningMessagePart(content));
        }
    }

    /**
     * Append a text part to the message
     * @param {string} text
     */
    appendText(text) {
        if (this.content.length === 0) {
            this.content.push(new TextMessagePart(text));
        } else if (this.content[this.content.length - 1].type === 'text') {
            this.content[this.content.length - 1].text += text;
        } else {
            this.content.push(new TextMessagePart(text));
        }
    }

    toOpenAIMessage() {
        var content = [];
        for (let part of this.content) {
            if (part.type !== 'reasoning') {
                content.push(part.toOpenAIMessagePart());
            }
        }
        return { role: this.role, content: content }
    }

    /**
     * Parse an assistant message chunk from a standard OpenAI message
     * @returns {AssistantMessage}
     */
    static parseOpenAIMessage(openai_message) {
        var message = new AssistantMessage();
        if (openai_message.reasoning_content) {
            message.content.push(new ReasoningMessagePart(openai_message.reasoning_content));
        }

        if (openai_message.content !== undefined && openai_message.content !== null) {
            message.content.push(new TextMessagePart(openai_message.content));
        }
        return message;
    }
}


class AssistantResponse {
    /**
     * @param {AssistantMessage} content
     */
    constructor (content) {
        /** @type {AssistantMessage} */
        this.content = content;
        /** @type {'stop' | 'error' | null} */
        this.finish_reason = null;
    }

    static error(reason) {
        var response = new AssistantResponse(new AssistantMessage());
        response.finish_reason = 'error';
        response.content.appendText(reason);
        return response
    }

    static parseOpenAIResponse(openai_response) {
        const choice = openai_response.choices[0];
        /** @type {'stop' | 'error' | null} */
        let finish_reason = choice.finish_reason;
        if (finish_reason === undefined) {
            finish_reason = null;
        }

        if (choice.delta !== undefined) {
            // parsing chunk in a stream response
            const chunk = AssistantMessage.parseOpenAIMessage(choice.delta);
            return new AssistantResponse(chunk, finish_reason);
        } else if (choice.message !== undefined) {
            const message = AssistantMessage.parseOpenAIMessage(choice.message);
            return new AssistantResponse(message, finish_reason);
        } else {
            console.info(choice);
            throw new Error('invalid openai response');
        }
    }
}

/**
 * @class ChatContext
 * @property {SystemMessage | undefined} system_prompt
 */
class ChatContext {
    constructor () {
        this.system_prompt = undefined;
        /**
         * @type {(UserMessage | AssistantMessage)[]}
         */
        this.messages = [];
    }

    /**
     *
     * @param {UserMessage | AssistantMessage} message
     */
    appendMessage(message) {
        this.messages.push(message);
    }

    /**
     * Assign the prototype of the given object to the ChatContext prototype
     * @param {object} chat_context_obj
     * @returns {ChatContext}
     */
    static assign(chat_context_obj) {
        if (chat_context_obj.system_prompt !== undefined) {
            SystemMessage.assign(chat_context_obj.system_prompt);
        }
        if (chat_context_obj.messages !== undefined) {
            for (let message of chat_context_obj.messages) {
                if (message.role === 'user') {
                    UserMessage.assign(message);
                } else if (message.role === 'assistant') {
                    AssistantMessage.assign(message);
                }
            }
        }
        Object.setPrototypeOf(chat_context_obj, ChatContext.prototype);
        return chat_context_obj;
    }
}

module.exports = {
    SystemMessage, UserMessage, AssistantMessage,
    AssistantResponse,
    ChatContext
};