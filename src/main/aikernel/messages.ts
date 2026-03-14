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

import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { logger, getDebugMode } from '../utils/logger.js';
import { BaseTool, BaseToolset } from './tool.js';

import markedKatex from 'marked-katex-extension';
import hljs from 'highlight.js';
import path from 'path';


export const marked = new Marked(
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
 */
export class ReasoningMessagePart {
    type: 'reasoning' = 'reasoning';
    content: string;
    /** cached render result of the reasoning */
    rendered?: string;

    constructor (content: string) {
        this.content = content;
    }

    async render() {
        this.rendered = this.content;
    }

    /**
     * Assign the prototype of the given object to the ReasoningMessagePart prototype,
     * mainly used for deserialization.
     *
     * @param reasoning_message_part_obj - The object to assign the prototype to
     * @returns The assigned reasoning message part
     */
    static assign(reasoning_message_part_obj: object): ReasoningMessagePart {
        Object.setPrototypeOf(reasoning_message_part_obj, ReasoningMessagePart.prototype);
        return reasoning_message_part_obj as ReasoningMessagePart;
    }
}

/** 当压缩后的工具参数长度超过此阈值时，参数本身也会被替换为压缩占位 */
const LARGE_ARGS_THRESHOLD = 500;

export class ToolCall {

    index: number;
    id: string
    tool_name: string;
    args_string: string;
    args_object: any = {};
    status: 'pending' | 'running' | 'success' | 'error' = 'pending';
    result?: string;
    result_object?: object;
    rendered?: string;
    tool?: BaseTool<any>;
    /** undefined = 未压缩；非空 UUID = 已被上下文压缩 */
    compress_id?: string;

    constructor(index: number, id: string, tool_name: string, args_string: string) {
        this.index = index;
        this.id = id;
        this.tool_name = tool_name;
        this.args_string = args_string;

        Object.defineProperty(this, 'tool', { value: undefined, writable: true, enumerable: false });
    }

    toOpenAIMessagePart(): object {
        return {
            type: 'tool_call',
            id: this.id,
            index: this.index,
            tool_name: this.tool_name,
            args_string: this.args_string || "",
        };
    }

    setTool(tool: BaseTool<any>) {
        this.tool = tool;
    }

    async freezeRenderResult() {
        this.rendered = await this.render();
    }

    /**
     * 渲染工具调用
     */
    async render(): Promise<string> {
        if (this.rendered !== undefined) {
            /* 如果已经确认冻结了渲染结果，则直接返回 */
            return this.rendered;
        }

        /* 如果工具自定义了渲染函数，则使用工具的渲染函数 */
        if (this.tool !== undefined) {
            let rendered = await this.tool.renderToolCall(this);
            if (rendered !== undefined) {
                return rendered;
            }
        }

        if (this.status === 'running') {
            return `
            <div class="flex mt-3 mb-3 text-sm items-center space-x-4 bg-white/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit">
                <span class="ml-2 font-semibold text-slate-600">工具调用</span>
                <div class="h-1 w-1 rounded-full bg-slate-300"></div>
                <!-- 状态：进行中 (呼吸灯效果) -->
                <div class="flex items-center">
                    <div class="h-2 w-2 rounded-full bg-blue-500 animate-pulse ring-4 ring-blue-100/50"></div>
                    <span class="ml-2 font-semibold text-slate-800">${this.tool_name}</span>
                </div>
            </div>
            `
        } else if (this.status === 'success') {
            return `
            <div class="flex mt-3 mb-3 text-sm items-center space-x-4 bg-white/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit">
                <span class="ml-2 font-semibold text-slate-600">工具调用</span>
                <div class="h-1 w-1 rounded-full bg-slate-300"></div>
                <div class="flex items-center group cursor-help relative">
                    <div class="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"></div>
                    <span class="ml-2 font-medium text-slate-600">${this.tool_name}</span>
                </div>
            </div>
            `
        } else if (this.status === 'error') {
            return `
            <div class="flex mt-3 mb-3 text-sm items-center space-x-4 bg-white/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit">
                <span class="ml-2 font-semibold text-slate-600">工具调用</span>
                <div class="h-1 w-1 rounded-full bg-slate-300"></div>
                <div class="flex items-center cursor-pointer group relative animate-[shake_0.5s_ease-in-out]">
                    <!-- 错误光晕效果 -->
                    <div class="h-2.5 w-2.5 rounded-full bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.6)] flex items-center justify-center">
                        <!-- 小感叹号图标 -->
                        <svg class="h-1.5 w-1.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="5">
                            <path d="M12 8v4m0 4h.01" />
                        </svg>
                    </div>

                    <!-- 错误文字 -->
                    <span class="ml-2 text-[13px] font-semibold text-rose-600">${this.tool_name} Failed</span>

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
            </div>
            `;
        } else {
            return `
            <div class="flex mt-3 mb-3 text-sm items-center space-x-4 bg-white/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit">
                <span class="ml-2 font-semibold text-slate-600">工具调用</span>
                <div class="flex items-center opacity-40">
                    <div class="h-2 w-2 rounded-full bg-slate-400"></div>
                    <span class="ml-2 font-medium text-slate-500">${this.tool_name}</span>
                </div>
            </div>
            `;
        }
    }

    static assign(tool_call_obj: object): ToolCall {
        Object.setPrototypeOf(tool_call_obj, ToolCall.prototype);
        const tc = tool_call_obj as ToolCall;
        if ('tool' in tc) {
            delete (tc as any).tool;
        }
        Object.defineProperty(tc, 'tool', { value: undefined, writable: true, enumerable: false });
        return tc;
    }
}

export class ToolCallMessagePart {
    type: 'tool_call' = 'tool_call';
    toolcalls: ToolCall[] = [];
    rendered?: string;

    /**
     * 初始化一个ToolCallMessagePart
     * 需要注意，我们特意设计成不允许在构造函数中传递toolcalls，这是因为如果模型直接输出
     * 了多个ToolCall（但实际上是同一个TC的多个流式组件的话，直接初始化会造成它们无法自动合并
     */
    constructor() { }

    push(toolcall: ToolCall) {
        const hasValidId = typeof toolcall.id === 'string' && toolcall.id.trim().length > 0;
        if (hasValidId) {
            this.toolcalls.push(toolcall);
        } else {
            const target = this.toolcalls.find(tc => tc.index === toolcall.index);
            if (target === undefined) {
                this.toolcalls.push(toolcall);
            } else {
                target.args_string += toolcall.args_string ?? '';
                if (toolcall.tool_name && toolcall.tool_name !== 'unknown') {
                    target.tool_name = toolcall.tool_name;
                }
            }
        }
    }

    extend(tool_call_message_part: ToolCallMessagePart) {
        for (let toolcall of tool_call_message_part.toolcalls) {
            this.push(toolcall)
        }
    }

    /**
     * 用来生成OpenAI工具调用的Assistant消息中的tool_calls
     */
    toOpenAIToolCalls(): object[] {
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
     */
    toOpenAIMessagePart(): object[] {
        return [
            ...this.toolcalls.map(toolcall => toolcall.toOpenAIMessagePart())
        ];
    }

    async render(): Promise<string> {
        this.rendered = '';
        for (const toolcall of this.toolcalls) {
            this.rendered += await toolcall.render();
        }
        return this.rendered;
    }

    static assign(tool_call_message_part_obj: any) {
        Object.setPrototypeOf(tool_call_message_part_obj, ToolCallMessagePart.prototype);
        for (let toolcall of tool_call_message_part_obj.toolcalls) {
            ToolCall.assign(toolcall)
        }
        return tool_call_message_part_obj;
    }
}

export class FileMessagePart {
    type: 'file' = 'file';
    path: string;
    content: string;
    rendered?: string;

    constructor(path: string, content: string) {
        this.path = path;
        this.content = content;
    }

    toOpenAIMessagePart(): object {
        return {
            type: 'text',
            text: `用户添加了文件附件: ${this.path}，其内容以文本形式提取如下，供你参考: <content>${this.content}</content>`
        }
    }

    async render(): Promise<string> {
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
        return this.rendered;
    }

    static assign(file_message_part_obj: object): FileMessagePart {
        Object.setPrototypeOf(file_message_part_obj, FileMessagePart.prototype);
        return file_message_part_obj as FileMessagePart;
    }
}

export class TextMessagePart {
    type: 'text' = 'text';
    text: string;
    rendered?: string;

    constructor (text: string) {
        this.text = text;
    }

    toOpenAIMessagePart(): object {
        return { type: 'text', text: this.text }
    }

    static assign(text_message_part_obj: object): TextMessagePart {
        Object.setPrototypeOf(text_message_part_obj, TextMessagePart.prototype);
        return text_message_part_obj as TextMessagePart;
    }

    async render(): Promise<string> {
        this.rendered = await marked.parse(this.text)
        return this.rendered;
    }
}

export class ImageMessagePart {
    type: 'image_url' = 'image_url';
    image_url: { url: string };
    rendered?: string;

    constructor (image_url: string) {
        this.image_url = { url: image_url };
    }

    toOpenAIMessagePart(): object {
        return { type: this.type, image_url: this.image_url };
    }

    async render(): Promise<string> {
        this.rendered = `<img src="${this.image_url.url}" alt="image" />`;
        return this.rendered;
    }

    static assign(image_message_part_obj: object): ImageMessagePart {
        Object.setPrototypeOf(image_message_part_obj, ImageMessagePart.prototype);
        return image_message_part_obj as ImageMessagePart;
    }
}


/**
 * @class Usage
 */
export class Usage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;

    constructor(prompt_tokens: number, completion_tokens: number, total_tokens: number) {
        this.prompt_tokens = prompt_tokens;
        this.completion_tokens = completion_tokens;
        this.total_tokens = total_tokens;
    }
}

/**
 * @class SystemMessage
 */
export class SystemMessage {
    role: 'system' = 'system';
    content: string;

    constructor(content: string) {
        this.content = content;
    }

    static assign(system_message_obj: object): SystemMessage {
        Object.setPrototypeOf(system_message_obj, SystemMessage.prototype);
        return system_message_obj as SystemMessage;
    }

    toOpenAIMessage(): object {
        return {
            role: this.role,
            content: this.content
        }
    }
}

export class UserMessage {
    role: 'user' = 'user';
    content: Array<TextMessagePart | ImageMessagePart | FileMessagePart> = [];

    constructor (content?: string) {
        if (content) {
            this.content.push(new TextMessagePart(content));
        }
    }

    /**
     * Append a text part to the message
     * @param {string} text
     * @returns {UserMessage}
     */
    appendText(text: string): UserMessage {
        const last_part = this.content[this.content.length - 1];
        if (last_part && last_part.type === 'text') {
            last_part.text += text;
        } else {
            this.content.push(new TextMessagePart(text));
        }
        return this;
    }

    appendPart(part: TextMessagePart | ImageMessagePart | FileMessagePart): UserMessage {
        if (part.type === 'text') {
            this.appendText(part.text);
        } else if (part.type === 'file') {
            this.content.push(part);
        } else {
            throw new Error(`unsupported part type ${part.type}`);
        }
        return this;
    }

    /**
     * Append an image URL to the message
     * @param {string} image_url
     * @returns {UserMessage}
     */
    appendImageURL(image_url: string): UserMessage {
        this.content.push(new ImageMessagePart(image_url));
        return this;
    }

    static assign(raw_obj: object): UserMessage {
        Object.setPrototypeOf(raw_obj, UserMessage.prototype);
        let user_message = raw_obj as UserMessage;
        if (user_message.content !== undefined) {
            for (let part of user_message.content) {
                if (part.type === 'text') {
                    TextMessagePart.assign(part);
                } else if (part.type === 'file') {
                    FileMessagePart.assign(part);
                } else {
                    throw new Error(`unsupported part type ${part.constructor.name}`);
                }
            }
        }
        return user_message;
    }

    async render(): Promise<void> {
        for (let part of this.content) {
            await part.render();
        }
    }

    toOpenAIMessage(): object {
        return {
            role: this.role,
            content: this.content.map(part => part.toOpenAIMessagePart())
        }
    }
}

export type AssistantMessagePart = TextMessagePart | ReasoningMessagePart | ToolCallMessagePart;

export class AssistantMessage {
    role: 'assistant' = 'assistant';
    message_id: string = crypto.randomUUID();
    content: Array<AssistantMessagePart> = [];
    usage?: Usage;

    constructor (content: Array<AssistantMessagePart> = []) {
        this.content = content;
    }

    /**
     * Assign the prototype of the given object to the AssistantMessage prototype
     */
    static assign(raw_obj: object): AssistantMessage {
        Object.setPrototypeOf(raw_obj, AssistantMessage.prototype);
        let assistant_message = raw_obj as AssistantMessage;
        if (assistant_message.content !== undefined) {
            for (let part of assistant_message.content) {
                if (part.type === 'text') {
                    TextMessagePart.assign(part);
                } else if (part.type === 'reasoning') {
                    ReasoningMessagePart.assign(part);
                } else if (part.type === 'tool_call') {
                    ToolCallMessagePart.assign(part);
                }
            }
        }
        return assistant_message;
    }

    async render(): Promise<void> {
        for (let part of this.content) {
            await part.render();
        }
    }

    /**
     * Merges the give message to this message and returns itself
     */
    mergeChunk(chunk: AssistantMessage): AssistantMessage {
        for (var part of chunk.content) {
            this.appendPart(part);
        }
        return this;
    }

    appendPart(part: TextMessagePart | ReasoningMessagePart | ToolCallMessagePart): AssistantMessage {
        if (part.type === 'text') {
            this.appendText(part.text);
        } else if (part.type === 'reasoning') {
            this.appendReasoningContent(part.content);
        } else if (part.type === 'tool_call') {
            this.appendToolCallPart(part);
        }
        return this;
    }

    appendReasoningContent(content: string): AssistantMessage {
        const last_part = this.content[this.content.length - 1];
        if (last_part && last_part.type === 'reasoning') {
            last_part.content += content;
        } else {
            this.content.push(new ReasoningMessagePart(content));
        }
        return this;
    }

    /**
     * Append a text part to the message
     * @param {string} text
     */
    appendText(text: string): AssistantMessage {
        const last_part = this.content[this.content.length - 1];
        if (last_part && last_part.type === 'text') {
            last_part.text += text;
        } else {
            this.content.push(new TextMessagePart(text));
        }
        return this;
    }

    /**
     * Append a tool call part to the message
     */
    appendToolCallPart(part: ToolCallMessagePart): AssistantMessage {
        const last_part = this.content[this.content.length - 1];
        if (last_part && last_part.type === 'tool_call') {
            last_part.extend(part);
        } else {
            this.content.push(part);
        }
        return this;
    }

    /**
     * 将 AssistantMessage 拆分为多个 OpenAI 消息，以保持 reasoning、tool_call、text 的正确顺序。
     *
     * 消息拆分规则：
     * - reasoning 累积后，遇到 tool_call 或消息结束才输出
     * - tool_call 独立输出为 assistant 消息，后跟 tool 响应消息
     * - text 累积后，在消息结束时输出
     * - 如果 reasoning 和 text 都有，合并到同一个 assistant 消息中
     *
     * @returns OpenAI 消息数组
     */
    toOpenAIMessages(): object[] {
        const messages: object[] = [];

        // 拆分 AssistantMessage：处理交错出现的 reasoning、tool_call、text
        let currentReasoning = '';
        let currentText = '';

        const processCurrentMessage = () => {
            currentReasoning = currentReasoning.trim();
            currentText = currentText.trim();
            if (currentText.length === 0 && currentReasoning.length === 0) {
                return;
            }
            var message: any = { 'role': 'assistant' };
            if (currentReasoning.length > 0) {
                message.reasoning_content = currentReasoning;
            }
            if (currentText.length > 0) {
                message.content = [{ type: 'text', text: currentText }]
            } else {
                // 确保 content 字段始终存在，即使为空字符串
                message.content = "";
            }
            currentReasoning = '';
            currentText = '';
            messages.push(message);
        }

        for (const part of this.content) {
            switch (part.type) {
                case 'reasoning': {
                    currentReasoning += part.content;
                    break;
                }
                case 'tool_call': {
                    processCurrentMessage();
                    const toolCallObjects = part.toolcalls.map(tc => {
                        const shouldCompressArgs = tc.compress_id
                            && tc.args_string
                            && tc.args_string.length > LARGE_ARGS_THRESHOLD;
                        return {
                            id: tc.id,
                            type: 'function',
                            function: {
                                name: tc.tool_name,
                                arguments: shouldCompressArgs
                                    ? `{"compressed":"工具参数已被压缩，数据ID为 ${tc.compress_id}"}`
                                    : (tc.args_string || "")
                            }
                        };
                    });
                    if (toolCallObjects.length > 0) {
                        messages.push({ role: 'assistant', tool_calls: toolCallObjects });
                        for (const toolcall of part.toolcalls) {
                            let toolCallMsg: any = { 'role': 'tool', tool_call_id: toolcall.id };
                            if (toolcall.compress_id) {
                                toolCallMsg.content = `工具返回结果已被压缩，数据ID为 ${toolcall.compress_id}`;
                            } else if (toolcall.status === 'error') {
                                toolCallMsg.content = `Toolcall failed: ${toolcall.result}`;
                            } else if (toolcall.status === 'success') {
                                toolCallMsg.content = toolcall.result ?? '工具调用成功完成';
                            } else {
                                toolCallMsg.content = `Toolcall failed: unfinished tool call`;
                            }
                            messages.push(toolCallMsg);
                        }
                    }
                    break;
                }
                case 'text': {
                    currentText += part.text;
                    break;
                }
            }
        }

        processCurrentMessage();
        return messages;
    }

    getOpenAIToolMessages(): object[] {
        var messages: object[] = [];
        var tool_call_parts = this.content.filter(part => part.type === 'tool_call');
        for (let part of tool_call_parts) {
            for (let toolcall of part.toolcalls) {
                if (toolcall.compress_id) {
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolcall.id,
                        content: `工具返回结果已被压缩，数据ID为 ${toolcall.compress_id}`
                    });
                } else if (toolcall.status === 'error') {
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolcall.id,
                        content: `Toolcall failed: ${toolcall.result ?? ''}`
                    });
                } else if (toolcall.status === 'success') {
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolcall.id,
                        content: toolcall.result ?? '工具调用成功完成'
                    });
                } else {
                    throw new Error(`unfinished toolcall status ${toolcall.status}`);
                }
            }
        }
        return messages;
    }

    static parseOpenAIMessage(openai_message: any): AssistantMessage {
        var message = new AssistantMessage();

        const reasoning_content = openai_message['reasoning_content'];
        if (reasoning_content) {
            message.content.push(new ReasoningMessagePart(reasoning_content));
        }

        const tool_calls = openai_message['tool_calls'];
        if (tool_calls) {
            let part = new ToolCallMessagePart()
            for (let tool_call of tool_calls) {
                let tc = new ToolCall(
                    tool_call['index'],
                    tool_call['id'],
                    tool_call['function']['name'],
                    tool_call['function']['arguments'] ?? ''
                );
                part.push(tc);
            }
            message.content.push(part);
        }
        const content = openai_message['content'];
        if (content) {
            message.content.push(new TextMessagePart(content));
        }
        return message;
    }
}

export class AssistantResponse {
    content: AssistantMessage;
    finish_reason: 'stop' | 'error' | 'tool_calls' | null;
    usage?: Usage;

    constructor (content: AssistantMessage, finish_reason: 'stop' | 'error' | 'tool_calls' | null = null) {
        this.content = content;
        this.finish_reason = finish_reason;
    }

    static richError(title: string, reason: string, ...attachments: string[]) {
        var response = new AssistantResponse(new AssistantMessage(), 'error');
        var content = `🔴 ${title}\n`;
        content += `---\n`
        content += `${reason}\n`
        if (getDebugMode()) {
            // 仅在调试模式下才打印复杂的附件信息
            for (const attachment of attachments) {
                content += "```\n";
                content += attachment + "\n";
                content += "```\n";
            }
        }
        response.content.appendText(content);
        return response;
    }

    static error(reason: string): AssistantResponse {
        var response = new AssistantResponse(new AssistantMessage(), 'error');
        response.content.appendText(reason);
        return response;
    }

    static parseOpenAIResponse(openai_response: any): AssistantResponse {
        const choices = openai_response['choices'];
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

        const usage = openai_response['usage'];
        if (usage) {
            response.usage = new Usage(
                usage['prompt_tokens'],
                usage['completion_tokens'],
                usage['total_tokens']
            );
        }
        return response;
    }
}

/**
 * 上下文压缩分隔消息。
 * 消息历史中最多出现一次，其前面的消息在构建 OpenAI 上下文时会被跳过，
 * 由 summary 字段中的结构化快照替代。
 */
export class CompactSeparatorMessage {
    role: 'compact_separator' = 'compact_separator';
    summary: string;

    constructor(summary: string) {
        this.summary = summary;
    }

    static assign(obj: object): CompactSeparatorMessage {
        Object.setPrototypeOf(obj, CompactSeparatorMessage.prototype);
        return obj as CompactSeparatorMessage;
    }

    toOpenAIMessage(): object {
        return {
            role: 'user',
            content: [{
                type: 'text',
                text: `[上下文压缩通知] 以下是对之前对话历史的结构化总结。此前的消息已被压缩并省略，请基于以下总结继续对话：\n\n${this.summary}`
            }]
        };
    }

    async render(): Promise<void> { /* 渲染在 TUI/GUI 层处理 */ }
}

export type ChatMessage = UserMessage | AssistantMessage | CompactSeparatorMessage;

/**
 * Chat context for a chat session
 */
export class ChatContext {
    system_prompt?: SystemMessage;
    messages: ChatMessage[] = [];
    toolsets: Map<string, BaseToolset> = new Map();

    /**
     * Attach multiple toolsets to the chat context
     */
    attachToolsets(...toolsets: BaseToolset[]) {
        for (let toolset of toolsets) {
            this.toolsets.set(toolset.name, toolset);
        }
    }

    getTool(name: string): BaseTool<any> | undefined {
        let tools = this.getTools()
        return tools.get(name);
    }

    getTools(): Map<string, BaseTool<any>> {
        let tools: Map<string, BaseTool<any>> = new Map();
        for (let toolset of this.toolsets.values()) {
            for (let tool of toolset.tools.values()) {
                tools.set(`${toolset.name}-${tool.name}`, tool);
            }
        }
        return tools;
    }

    toJSON(): object {
        return {
            system_prompt: this.system_prompt,
            messages: this.messages
        }
    }

    appendMessage(message: ChatMessage): void {
        this.messages.push(message);
    }

    lastMessage(): ChatMessage | undefined {
        return this.messages[this.messages.length - 1];
    }

    /** 查找最后一条 CompactSeparatorMessage 的位置（从末尾搜索，确保多条时取最新的） */
    findCompactSeparator(): { index: number; message: CompactSeparatorMessage } | undefined {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if ((this.messages[i] as any).role === 'compact_separator') {
                return { index: i, message: this.messages[i] as CompactSeparatorMessage };
            }
        }
        return undefined;
    }

    /** 移除已有的分隔符并在指定位置插入新的 CompactSeparatorMessage */
    insertCompactSeparator(separator: CompactSeparatorMessage, position: number): void {
        this.messages = this.messages.filter(m => (m as any).role !== 'compact_separator');
        this.messages.splice(position, 0, separator);
    }

    /** 确保最多只有一条 CompactSeparatorMessage，保留最后一条 */
    deduplicateSeparators(): void {
        let lastIdx = -1;
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if ((this.messages[i] as any).role === 'compact_separator') {
                if (lastIdx === -1) {
                    lastIdx = i;
                } else {
                    this.messages.splice(i, 1);
                }
            }
        }
    }

    /**
     * Assign the prototype of the given object to the ChatContext prototype
     */
    static assign(chat_context_obj: any): ChatContext {
        let ctx = new ChatContext();
        const system_prompt = chat_context_obj['system_prompt'];
        if (system_prompt !== undefined) {
            ctx.system_prompt = SystemMessage.assign(system_prompt);
        }

        const messages = chat_context_obj['messages'];
        if (messages !== undefined) {
            for (let message of messages) {
                if (message.role === 'user') {
                    ctx.messages.push(UserMessage.assign(message));
                } else if (message.role === 'assistant') {
                    ctx.messages.push(AssistantMessage.assign(message));
                } else if (message.role === 'compact_separator') {
                    ctx.messages.push(CompactSeparatorMessage.assign(message));
                }
            }
        }
        ctx.deduplicateSeparators();
        // we cannot load any toolset from the saved chat context
        return ctx;
    }
}
