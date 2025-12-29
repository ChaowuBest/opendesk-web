const { Marked } = require('marked');
const { markedHighlight } = require('marked-highlight');
const markedKatex = require('marked-katex-extension');
const hljs = require('highlight.js');
const { logger } = require('../utils/logger');
const { BaseTool } = require('./tool');
const path = require('path');


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

const TOOL_CALL_SEPARATOR = `<div class="h-1 w-1 rounded-full bg-slate-300"></div>`;

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
 * @class ToolCall
 * @property {number} index
 * @property {string} id
 * @property {string} tool_name
 * @property {string} args_string
 * @property {'pending' | 'running' | 'success' | 'error'} status
 */
class ToolCall {
    constructor(index, id, tool_name, args_string) {
        this.index = index;
        this.id = id;
        this.tool_name = tool_name;
        this.tool_title = tool_name;
        this.args_string = args_string;
        this.status = 'pending';
    }

    toOpenAIMessagePart() {
        return {
            type: 'tool_call',
            id: this.id,
            index: this.index,
            tool_name: this.tool_name,
            args_string: this.args_string,
        };
    }

    render() {
        if (this.status === 'running') {
            return `
            <!-- 状态：进行中 (呼吸灯效果) -->
            <div class="flex items-center">
                <div class="h-2 w-2 rounded-full bg-blue-500 animate-pulse ring-4 ring-blue-100/50"></div>
                <span class="ml-2 font-semibold text-slate-800">${this.tool_title}</span>
            </div>
            `
        } else if (this.status === 'success') {
            return `
            <div class="flex items-center group cursor-help relative">
                <div class="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"></div>
                <span class="ml-2 font-medium text-slate-600">${this.tool_title}</span>
            </div>
            `
        } else if (this.status === 'error') {
            return `
            <div class="flex items-center cursor-pointer group relative animate-[shake_0.5s_ease-in-out]">
                <!-- 错误光晕效果 -->
                <div class="h-2.5 w-2.5 rounded-full bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.6)] flex items-center justify-center">
                    <!-- 小感叹号图标 -->
                    <svg class="h-1.5 w-1.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="5">
                        <path d="M12 8v4m0 4h.01" />
                    </svg>
                </div>

                <!-- 错误文字 -->
                <span class="ml-2 text-[13px] font-semibold text-rose-600">${this.tool_title} Failed</span>

                <!-- 悬浮弹窗 (Error Tooltip) -->
                <div class="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-all pointer-events-none">
                    <div class="bg-white border border-slate-200 shadow-xl rounded-xl p-3 w-48 text-xs text-slate-600">
                        <p class="font-bold text-slate-800 mb-1">Execution Error</p>
                        <p class="font-mono text-[10px] leading-relaxed text-rose-500 bg-rose-50 p-1.5 rounded">${this.result}</p>
                        <!-- 小箭头 -->
                        <div class="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-white border-b border-r border-slate-200 rotate-45"></div>
                    </div>
                </div>
            </div>
            `;
        } else {
            return `
            <div class="flex items-center opacity-40">
                <div class="h-2 w-2 rounded-full bg-slate-400"></div>
                <span class="ml-2 font-medium text-slate-500">${this.tool_title}</span>
            </div>
            `;
        }
    }

    static assign(tool_call_obj) {
        Object.setPrototypeOf(tool_call_obj, ToolCall.prototype);
        return tool_call_obj;
    }
}

class ToolCallMessagePart {
    /**
     * @param {ToolCall[]} toolcalls
     */
    constructor(toolcalls) {
        this.type = 'tool_call';
        this.toolcalls = toolcalls;
        this.rendered = undefined;
    }

    extend(tool_call_message_part) {
        for (let toolcall of tool_call_message_part.toolcalls) {
            if (toolcall.id) {
                this.toolcalls.push(toolcall);
            } else {
                let last_toolcall = this.toolcalls[this.toolcalls.length - 1];
                if (last_toolcall === undefined) {
                    throw new Error('last toolcall is undefined');
                }
                last_toolcall.args_string += toolcall.args_string;
            }
        }
    }

    /**
     * 用来生成OpenAI工具调用的Assistant消息中的tool_calls
     * @returns {object[]}
     */
    toOpenAIToolCalls() {
        return this.toolcalls.map(toolcall => {
            return {
                id: toolcall.id,
                type: 'function',
                function: {
                    name: toolcall.tool_name,
                    arguments: toolcall.args_string
                }
            }
        });
    }

    /**
     * 用来生成OpenAI工具调用的Response消息
     * @returns {object[]}
     */
    toOpenAIMessagePart() {
        return [
            ...this.toolcalls.map(toolcall => toolcall.toOpenAIMessagePart())
        ];
    }

    async render() {
        const toolcalls = this.toolcalls.map(toolcall => toolcall.render()).join(TOOL_CALL_SEPARATOR);
        this.rendered = `
        <div class="flex mt-3 mb-3 text-sm items-center space-x-4 bg-white/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit">
            <span class="ml-2 font-semibold text-slate-600">工具调用</span>
            ${TOOL_CALL_SEPARATOR}
            ${toolcalls}
        </div>
        `;
    }

    static assign(tool_call_message_part_obj) {
        Object.setPrototypeOf(tool_call_message_part_obj, ToolCallMessagePart.prototype);
        for (let toolcall of tool_call_message_part_obj.toolcalls) {
            ToolCall.assign(toolcall)
        }
        return tool_call_message_part_obj;
    }
}

class FileMessagePart {
    constructor(path, content) {
        this.type = 'file';
        this.path = path;
        this.content = content;
    }

    toOpenAIMessagePart() {
        return {
            type: 'text',
            text: `用户添加了文件附件: ${this.path}，其内容以文本形式提取如下，供你参考: <content>${this.content}</content>`
        }
    }

    async render() {
        this.rendered = `
        <div class="flex items-center group cursor-pointer w-fit min-w-[280px] max-w-sm
            bg-white/70 backdrop-blur-xl
            rounded-xl px-3.5 py-2.5
            border border-black/[0.08] shadow-sm
            hover:shadow-md hover:bg-white/90 hover:-translate-y-0.5
            transition-all duration-200 ease-out select-none">

            <!-- 文件图标容器 -->
            <div class="relative w-10 h-10 flex items-center justify-center
                        bg-white rounded-lg shadow-[0_2px_5px_rgba(0,0,0,0.08)]
                        mr-3 shrink-0">
                <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M14 2H6C4.89543 2 4 2.89543 4 4V20C4 21.1046 4.89543 22 6 22H18C19.1046 22 20 21.1046 20 20V8L14 2Z" fill="#E2E2E2"/>
                <path d="M14 2V8H20L14 2Z" fill="#B0B0B0"/>
                <rect x="8" y="13" width="8" height="1.5" rx="0.75" fill="white"/>
                <rect x="8" y="16" width="5" height="1.5" rx="0.75" fill="white"/>
                </svg>
            </div>

            <!-- 文件详细信息 -->
            <div class="flex flex-col min-w-0 flex-1 overflow-hidden">
                <span class="text-[13px] font-medium text-gray-900 truncate tracking-tight font-sans">
                ${path.basename(this.path)}
                </span>
                <span class="text-[11px] text-gray-500 font-normal leading-tight">
                    ${path.extname(this.path).toUpperCase().slice(1)} 文档
                </span>
            </div>

            <!-- 尾部操作图标 (通常是下拉或下载) -->
            <div class="ml-2 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7" />
                </svg>
            </div>
        </div>
        `;
    }

    static assign(file_message_part_obj) {
        Object.setPrototypeOf(file_message_part_obj, FileMessagePart.prototype);
        return file_message_part_obj;
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
 * @property {(TextMessagePart | ImageMessagePart | FileMessagePart)[]} content
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

    appendPart(part) {
        if (part.type === 'text') {
            this.appendText(part.text);
        } else if (part.type === 'file') {
            this.content.push(part);
        } else {
            throw new Error(`unsupported part type ${part.type}`);
        }
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
                } else if (part.type === 'file') {
                    FileMessagePart.assign(part);
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
                } else if (part.type === 'tool_call') {
                    ToolCallMessagePart.assign(part);
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
        } else if (part.type === 'tool_call') {
            this.appendToolCallPart(part);
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

    /**
     * Append a tool call part to the message
     * @param {ToolCallMessagePart} part
     */
    appendToolCallPart(part) {
        if (this.content.length === 0) {
            this.content.push(part);
        } else if (this.content[this.content.length - 1].type === 'tool_call') {
            this.content[this.content.length - 1].extend(part);
        } else {
            this.content.push(part);
        }
    }

    toOpenAIMessage() {
        var content = [];
        var toolcalls = [];
        for (let part of this.content) {
            switch (part.type) {
                case 'reasoning':
                    break;
                case 'tool_call':
                    toolcalls.push(...part.toOpenAIToolCalls());
                    break;
                case 'text':
                    let openai_part = part.toOpenAIMessagePart();
                    if (Array.isArray(openai_part)) {
                        content.push(...openai_part);
                    } else {
                        content.push(openai_part);
                    }
                    break;
                default:
                    throw new Error(`unsupported part type ${part.type}`);
            }
        }
        return { role: this.role, content: content, tool_calls: toolcalls }
    }

    getOpenAIToolMessages() {
        var messages = [];
        var tool_call_parts = this.content.filter(part => part.type === 'tool_call');
        for (let part of tool_call_parts) {
            /** @type {ToolCallMessagePart} */
            let tool_call_part = part;
            for (let toolcall of tool_call_part.toolcalls) {
                if (toolcall.status === 'error') {
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolcall.id,
                        content: `Toolcall failed: ${toolcall.result}`
                    });
                } else if (toolcall.status === 'success') {
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolcall.id,
                        content: toolcall.result
                    });
                } else {
                    throw new Error(`unfinished toolcall status ${toolcall.status}`);
                }
            }
        }
        return messages;
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
        if (openai_message.tool_calls) {
            var toolcalls = [];
            for (let tool_call of openai_message.tool_calls) {
                toolcalls.push(new ToolCall(
                    tool_call.index,
                    tool_call.id,
                    tool_call.function.name,
                    tool_call.function.arguments
                ));
            }
            message.content.push(new ToolCallMessagePart(toolcalls));
        }
        if (openai_message.content) {
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
        /** @type {'stop' | 'error' | 'tool_calls' | null} */
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
            logger.error('invalid openai response', choice);
            throw new Error('invalid openai response');
        }
    }
}

/**
 * @class ChatContext
 * @property {SystemMessage | undefined} system_prompt
 * @property {(UserMessage | AssistantMessage)[]} messages
 * @property {BaseTool[]} tools
 */
class ChatContext {

    constructor () {
        /** @type {SystemMessage | undefined} */
        this.system_prompt = undefined;
        /** @type {(UserMessage | AssistantMessage)[]} */
        this.messages = [];
        /** @type {Map<string, BaseTool>} */
        this.tools = new Map();
    }

    toJSON() {
        return {
            system_prompt: this.system_prompt,
            messages: this.messages
        }
    }

    /**
     *
     * @param {UserMessage | AssistantMessage} message
     */
    appendMessage(message) {
        this.messages.push(message);
    }

    lastMessage() {
        return this.messages[this.messages.length - 1];
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
    ChatContext,
    ToolCallMessagePart, FileMessagePart
};