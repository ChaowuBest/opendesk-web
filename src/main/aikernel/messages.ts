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
import fs from 'fs';

/**
 * 检查工具调用的 args_string 是否为合法 JSON。
 * 空字符串视为合法（部分模型对无参数工具返回空串）。
 */
function isValidToolCallArgs(args_string: string): boolean {
    if (!args_string || args_string.trim().length === 0) return true;
    try {
        JSON.parse(args_string);
        return true;
    } catch {
        return false;
    }
}

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

marked.use(
    markedKatex({
        throwOnError: false,
        displayMode: true,
        nonStandard: true
    })
);

/**
 * This is NOT an OpenAI message part, but a message part for our own message system.
 */
export class ReasoningMessagePart {
    type: 'reasoning' = 'reasoning';
    content: string;
    /** 来源：'reasoning_content' 表示来自 API 的 reasoning_content 字段，'think_tag' 表示从 <think> 标签解析 */
    source: 'reasoning_content' | 'think_tag';
    /** cached render result of the reasoning */
    rendered?: string;
    private _frozen!: boolean;

    constructor(content: string, source: 'reasoning_content' | 'think_tag') {
        this.content = content;
        this.source = source;
        Object.defineProperty(this, '_frozen', { value: false, writable: true, enumerable: false });
    }

    /** 流式追加内容时调用，清除已缓存的渲染结果 */
    invalidateRender(): void {
        if (!this._frozen) {
            this.rendered = undefined;
        }
    }

    /** 冻结渲染缓存 */
    freezeRender(): void {
        this._frozen = true;
    }

    async render() {
        if (this.rendered !== undefined) {
            return this.rendered;
        }
        this.rendered = this.content;
    }

    /**
     * Assign the prototype of the given object to the ReasoningMessagePart prototype,
     * mainly used for deserialization.
     *
     * @param reasoning_message_part_obj - The object to assign the prototype to
     * @returns The assigned reasoning message part
     */
    toRenderJSON(): object {
        return {
            type: this.type,
            rendered: this.rendered,
            contentLength: this.content.length
        };
    }

    static assign(reasoning_message_part_obj: object): ReasoningMessagePart {
        Object.setPrototypeOf(reasoning_message_part_obj, ReasoningMessagePart.prototype);
        const part = reasoning_message_part_obj as ReasoningMessagePart;
        Object.defineProperty(part, '_frozen', { value: false, writable: true, enumerable: false });
        return part;
    }
}

/** 当压缩后的工具参数长度超过此阈值时，参数本身也会被替换为压缩占位 */
const LARGE_ARGS_THRESHOLD = 500;

export const TOOL_RESULT_STORAGE_VERSION = 1;
export const TOOL_CALL_MICROCOMPACT_VERSION = 1;

export interface ToolResultStorageMetadata {
    result_id: string;
    storage_version: number;
    relative_path?: string;
    original_chars?: number;
    original_lines?: number;
    persisted_at?: string;
    replacement_text?: string;
}

export interface ToolCallMicrocompactMetadata {
    version: number;
    strategy: 'local_clear';
    cleared_at: string;
    original_chars?: number;
    original_lines?: number;
    replacement_text?: string;
    artifact_path_hint?: string;
}

export class ToolCall {
    index: number;
    id: string;
    tool_name: string;
    args_string: string;
    args_object: any = {};
    status: 'pending' | 'running' | 'success' | 'error' = 'pending';
    result?: string;
    result_object?: object;
    rendered?: string;
    tool?: BaseTool<any>;
    /**
     * @deprecated Legacy L1 compact marker.
     * Step 7 后 full compact 主路径使用 boundary summary + kept tail，不再新增依赖此字段。
     * 保留它是为了兼容旧任务和旧工具结果占位。
     */
    compress_id?: string;
    /** 大工具结果落盘后的稳定引用信息 */
    result_storage?: ToolResultStorageMetadata;
    /** 本地 microcompact 后的持久化元数据 */
    microcompact?: ToolCallMicrocompactMetadata;

    constructor(index: number, id: string, tool_name: string, args_string: string) {
        this.index = index;
        this.id = id;
        this.tool_name = tool_name;
        this.args_string = args_string;

        Object.defineProperty(this, 'tool', {
            value: undefined,
            writable: true,
            enumerable: false,
            configurable: true
        });
    }

    toOpenAIMessagePart(): object {
        return {
            type: 'tool_call',
            id: this.id,
            index: this.index,
            tool_name: this.tool_name,
            args_string: this.args_string || ''
        };
    }

    /** 序列化时显式排除 tool，避免运行时引用被持久化后反序列化为纯对象导致渲染/执行异常 */
    toJSON(): object {
        const { tool, ...rest } = this as ToolCall & { tool?: BaseTool<any> };
        return rest;
    }

    /** 仅包含前端渲染所需的字段，排除 args_string / result 等大字段 */
    toRenderJSON(): object {
        return {
            index: this.index,
            id: this.id,
            tool_name: this.tool_name,
            status: this.status,
            rendered: this.rendered
        };
    }

    static normalizeResultStorage(
        metadata?: Partial<ToolResultStorageMetadata> | null
    ): ToolResultStorageMetadata | undefined {
        if (metadata === undefined || metadata === null || typeof metadata !== 'object') {
            return undefined;
        }

        const resultId =
            typeof metadata.result_id === 'string' && metadata.result_id.trim().length > 0
                ? metadata.result_id
                : undefined;
        if (resultId === undefined) {
            return undefined;
        }

        const normalized: ToolResultStorageMetadata = {
            result_id: resultId,
            storage_version:
                typeof metadata.storage_version === 'number' &&
                Number.isInteger(metadata.storage_version) &&
                metadata.storage_version > 0
                    ? metadata.storage_version
                    : TOOL_RESULT_STORAGE_VERSION
        };

        if (typeof metadata.relative_path === 'string' && metadata.relative_path.trim().length > 0) {
            normalized.relative_path = metadata.relative_path;
        }

        if (
            typeof metadata.original_chars === 'number' &&
            Number.isInteger(metadata.original_chars) &&
            metadata.original_chars >= 0
        ) {
            normalized.original_chars = metadata.original_chars;
        }

        if (
            typeof metadata.original_lines === 'number' &&
            Number.isInteger(metadata.original_lines) &&
            metadata.original_lines >= 0
        ) {
            normalized.original_lines = metadata.original_lines;
        }

        if (typeof metadata.persisted_at === 'string' && metadata.persisted_at.trim().length > 0) {
            normalized.persisted_at = metadata.persisted_at;
        }

        if (typeof metadata.replacement_text === 'string' && metadata.replacement_text.length > 0) {
            normalized.replacement_text = metadata.replacement_text;
        }

        return normalized;
    }

    static normalizeMicrocompact(
        metadata?: Partial<ToolCallMicrocompactMetadata> | null
    ): ToolCallMicrocompactMetadata | undefined {
        if (metadata === undefined || metadata === null || typeof metadata !== 'object') {
            return undefined;
        }

        const strategy = metadata.strategy === 'local_clear' ? metadata.strategy : 'local_clear';
        const normalized: ToolCallMicrocompactMetadata = {
            version:
                typeof metadata.version === 'number' && Number.isInteger(metadata.version) && metadata.version > 0
                    ? metadata.version
                    : TOOL_CALL_MICROCOMPACT_VERSION,
            strategy,
            cleared_at:
                typeof metadata.cleared_at === 'string' && metadata.cleared_at.trim().length > 0
                    ? metadata.cleared_at
                    : new Date().toISOString()
        };

        if (
            typeof metadata.original_chars === 'number' &&
            Number.isInteger(metadata.original_chars) &&
            metadata.original_chars >= 0
        ) {
            normalized.original_chars = metadata.original_chars;
        }

        if (
            typeof metadata.original_lines === 'number' &&
            Number.isInteger(metadata.original_lines) &&
            metadata.original_lines >= 0
        ) {
            normalized.original_lines = metadata.original_lines;
        }

        if (typeof metadata.replacement_text === 'string' && metadata.replacement_text.length > 0) {
            normalized.replacement_text = metadata.replacement_text;
        }

        if (typeof metadata.artifact_path_hint === 'string' && metadata.artifact_path_hint.trim().length > 0) {
            normalized.artifact_path_hint = metadata.artifact_path_hint;
        }

        return normalized;
    }

    ensureResultStorage(metadata: Partial<ToolResultStorageMetadata> = {}): ToolResultStorageMetadata {
        const normalized = ToolCall.normalizeResultStorage({
            ...this.result_storage,
            ...metadata,
            result_id:
                typeof metadata.result_id === 'string' && metadata.result_id.trim().length > 0
                    ? metadata.result_id
                    : (this.result_storage?.result_id ?? crypto.randomUUID())
        });

        if (normalized === undefined) {
            throw new Error('failed to normalize tool result storage metadata');
        }

        this.result_storage = normalized;
        return normalized;
    }

    setResultStorage(metadata?: Partial<ToolResultStorageMetadata> | null): ToolResultStorageMetadata | undefined {
        const normalized = ToolCall.normalizeResultStorage(metadata);
        this.result_storage = normalized;
        return normalized;
    }

    clearResultStorage(): void {
        this.result_storage = undefined;
    }

    setMicrocompact(metadata?: Partial<ToolCallMicrocompactMetadata> | null): ToolCallMicrocompactMetadata | undefined {
        const normalized = ToolCall.normalizeMicrocompact(metadata);
        this.microcompact = normalized;
        return normalized;
    }

    clearMicrocompact(): void {
        this.microcompact = undefined;
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

        /* 如果工具自定义了渲染函数，则使用工具的渲染函数（需确认为 BaseTool 实例，反序列化后可能为纯对象） */
        if (this.tool !== undefined && typeof (this.tool as any).renderToolCall === 'function') {
            const rendered = await this.tool.renderToolCall(this);
            if (rendered !== undefined) {
                return rendered;
            }
        }

        const statusIcon =
            this.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : this.status === 'error'
                  ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
                  : '';

        const displayName = this.tool_name;

        if (this.status === 'error') {
            return `<div class="my-2">
                <div class="flex items-center gap-1.5 min-w-0 group relative">
                    <i class="fas fa-wrench shrink-0 text-slate-400 text-xs"></i>
                    <span class="shrink-0 text-slate-500 text-xs">${displayName}</span>
                    ${statusIcon}
                    <span class="text-xs text-rose-500">失败</span>
                    <div class="absolute bottom-full mb-2 left-0 opacity-0 group-hover:opacity-100 transition-all pointer-events-none z-10">
                        <div class="bg-white border border-slate-200 shadow-xl rounded-lg p-2 max-w-xs text-[11px] text-slate-600">
                            <p class="font-mono text-[10px] leading-relaxed text-rose-500 bg-rose-50 p-1 rounded break-all">${this.result || ''}</p>
                        </div>
                    </div>
                </div>
            </div>`;
        }

        return `<div class="my-2">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-wrench shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">${displayName}</span>
                ${statusIcon}
            </div>
        </div>`;
    }

    static assign(tool_call_obj: object): ToolCall {
        Object.setPrototypeOf(tool_call_obj, ToolCall.prototype);
        const tc = tool_call_obj as ToolCall;
        if ('tool' in tc) {
            delete (tc as any).tool;
        }
        Object.defineProperty(tc, 'tool', {
            value: undefined,
            writable: true,
            enumerable: false,
            configurable: true
        });
        tc.result_storage = ToolCall.normalizeResultStorage(tc.result_storage);
        tc.microcompact = ToolCall.normalizeMicrocompact(tc.microcompact);
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
    constructor() {}

    push(toolcall: ToolCall) {
        const hasValidId = typeof toolcall.id === 'string' && toolcall.id.trim().length > 0;
        if (hasValidId) {
            this.toolcalls.push(toolcall);
        } else {
            const target = this.toolcalls.find((tc) => tc.index === toolcall.index);
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
        for (const toolcall of tool_call_message_part.toolcalls) {
            this.push(toolcall);
        }
    }

    /**
     * 用来生成OpenAI工具调用的Assistant消息中的tool_calls
     */
    toOpenAIToolCalls(): object[] {
        return this.toolcalls
            .filter((toolcall) => {
                if (!isValidToolCallArgs(toolcall.args_string)) {
                    logger.warn(
                        `Dropping tool call "${toolcall.tool_name}" (id=${toolcall.id}) from OpenAI tool_calls: ` +
                            `args_string is not valid JSON. Raw args: ${toolcall.args_string?.substring(0, 200)}`
                    );
                    return false;
                }
                return true;
            })
            .map((toolcall) => ({
                id: toolcall.id,
                type: 'function',
                function: {
                    name: toolcall.tool_name,
                    arguments: toolcall.args_string
                }
            }));
    }

    /**
     * 用来生成OpenAI工具调用的Response消息
     */
    toOpenAIMessagePart(): object[] {
        return [...this.toolcalls.map((toolcall) => toolcall.toOpenAIMessagePart())];
    }

    async render(): Promise<string> {
        this.rendered = '';
        for (const toolcall of this.toolcalls) {
            this.rendered += await toolcall.render();
        }
        return this.rendered;
    }

    toRenderJSON(): object {
        return {
            type: this.type,
            rendered: this.rendered,
            toolcalls: this.toolcalls.map((tc) => tc.toRenderJSON())
        };
    }

    static assign(tool_call_message_part_obj: any) {
        Object.setPrototypeOf(tool_call_message_part_obj, ToolCallMessagePart.prototype);
        for (const toolcall of tool_call_message_part_obj.toolcalls) {
            ToolCall.assign(toolcall);
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
        };
    }

    async render(): Promise<string> {
        if (this.rendered !== undefined) {
            return this.rendered;
        }
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

    toRenderJSON(): object {
        return {
            type: this.type,
            path: this.path,
            rendered: this.rendered
        };
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
    /** 标记 rendered 是否已冻结（流式结束后冻结，避免重复渲染） */
    private _frozen!: boolean;

    constructor(text: string) {
        this.text = text;
        Object.defineProperty(this, '_frozen', { value: false, writable: true, enumerable: false });
    }

    toOpenAIMessagePart(): object {
        return { type: 'text', text: this.text };
    }

    static assign(text_message_part_obj: object): TextMessagePart {
        Object.setPrototypeOf(text_message_part_obj, TextMessagePart.prototype);
        const part = text_message_part_obj as TextMessagePart;
        Object.defineProperty(part, '_frozen', { value: false, writable: true, enumerable: false });
        return part;
    }

    /** 流式追加文本时调用，清除已缓存的渲染结果以便下次 render() 重新生成 */
    invalidateRender(): void {
        if (!this._frozen) {
            this.rendered = undefined;
        }
    }

    /** 冻结渲染缓存，流式结束后调用以启用永久缓存 */
    freezeRender(): void {
        this._frozen = true;
    }

    async render(): Promise<string> {
        if (this.rendered !== undefined) {
            return this.rendered;
        }
        this.rendered = await marked.parse(this.text);
        return this.rendered;
    }

    toRenderJSON(): object {
        return {
            type: this.type,
            rendered: this.rendered
        };
    }
}

export class ErrorMessagePart {
    type: 'error' = 'error';
    title: string;
    message: string;
    rendered?: string;

    constructor(title: string, message: string) {
        this.title = title;
        this.message = message;
    }

    toOpenAIMessagePart(): object {
        return { type: 'text', text: `[错误] ${this.title}: ${this.message}` };
    }

    async render(): Promise<string> {
        if (this.rendered !== undefined) {
            return this.rendered;
        }
        this.rendered = `
        <div class="flex flex-col mt-1.5 mb-1.5 text-xs bg-rose-50/80 border border-rose-200 py-2 px-3 rounded-xl shadow-sm w-fit min-w-[240px] max-w-2xl">
            <div class="flex items-center gap-1.5 mb-1">
                <span class="text-xs">🔴</span>
                <span class="font-semibold text-rose-600">${this.title}</span>
            </div>
            <div class="text-[11px] text-slate-600 whitespace-pre-wrap">${this.message}</div>
        </div>`;
        return this.rendered;
    }

    toRenderJSON(): object {
        return {
            type: this.type,
            rendered: this.rendered
        };
    }

    static assign(obj: object): ErrorMessagePart {
        Object.setPrototypeOf(obj, ErrorMessagePart.prototype);
        return obj as ErrorMessagePart;
    }
}

export class ImageMessagePart {
    type: 'image_url' = 'image_url';
    image_url: { url: string };
    rendered?: string;

    constructor(image_url: string) {
        this.image_url = { url: image_url };
    }

    toOpenAIMessagePart(): object {
        return { type: this.type, image_url: this.image_url };
    }

    async render(): Promise<string> {
        if (this.rendered !== undefined) {
            return this.rendered;
        }
        this.rendered = `<img src="${this.image_url.url}" alt="image" />`;
        return this.rendered;
    }

    toRenderJSON(): object {
        return {
            type: this.type,
            rendered: this.rendered
        };
    }

    static assign(image_message_part_obj: object): ImageMessagePart {
        Object.setPrototypeOf(image_message_part_obj, ImageMessagePart.prototype);
        return image_message_part_obj as ImageMessagePart;
    }
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/**
 * 从文本中提取可能的文件路径并过滤出合法存在的图片文件。
 * 支持 Windows 绝对路径 (C:\xxx.png)、Unix 绝对路径 (/c/Projects/test.png)、
 * 相对路径 (./abc.jpg) 等形式。
 * 返回去重后的绝对路径列表。
 */
export function extractImagePaths(text: string): string[] {
    const imageExtRegex = /\.(png|jpe?g|gif|webp|bmp)$/i;
    const foundPaths = new Set<string>();

    const tryAdd = (rawPath: string) => {
        if (!imageExtRegex.test(rawPath)) return;
        try {
            const resolved = path.resolve(rawPath);
            if (fs.existsSync(resolved)) {
                foundPaths.add(resolved);
            }
        } catch {
            /* 无效路径，跳过 */
        }
    };

    // Phase 1: extract paths wrapped in quotes (e.g. "C:\xxx.png" or 'C:\xxx.png')
    const quotedPattern = /["']([^"']+\.\w{2,5})["']/g;
    let qm: RegExpExecArray | null;
    while ((qm = quotedPattern.exec(text)) !== null) {
        tryAdd(qm[1].trim());
    }

    // Phase 2: unquoted path patterns
    const patterns = [
        /(?<![<"'\w])([A-Za-z]:[\\/][^\s<>"'|*?]+\.\w{2,5})(?!["\w])/g,
        /(?<![<"'\w])(\/(?:[^\s<>"'|*?]+)\/[^\s<>"'|*?]+\.\w{2,5})(?!["\w])/g,
        /(?<![<"'\w])(\.\.?[\\/][^\s<>"'|*?]+\.\w{2,5})(?!["\w])/g,
        /(?<![<"'\w])(~[\\/][^\s<>"'|*?]+\.\w{2,5})(?!["\w])/g,
        /(?<![<"'\\/]\w)(\w[^\s<>"'|*?]*[\\/][^\s<>"'|*?]+\.\w{2,5})(?!["\w])/g
    ];
    for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            tryAdd(match[1].trim());
        }
    }

    // Phase 3: bare filenames (e.g. "test.png")
    const bareFilenamePattern = /(?<![<"'\\/]\w)([A-Za-z0-9_-][A-Za-z0-9_\-. ]*\.(png|jpe?g|gif|webp|bmp))(?!["\w])/gi;
    let match: RegExpExecArray | null;
    while ((match = bareFilenamePattern.exec(text)) !== null) {
        tryAdd(match[1].trim());
    }

    return Array.from(foundPaths);
}

function detectImageMimeFromBuffer(buf: Buffer): string | null {
    if (!buf || buf.length < 4) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (
        buf[0] === 0x52 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x46 &&
        buf.length > 11 &&
        buf[8] === 0x57 &&
        buf[9] === 0x45 &&
        buf[10] === 0x42 &&
        buf[11] === 0x50
    )
        return 'image/webp';
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
    return null;
}

/**
 * 将图片文件转换为 data URI（base64 编码）。
 */
export function imageToDataUri(imagePath: string): string {
    const ext = path.extname(imagePath).toLowerCase();
    const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp'
    };
    const data = fs.readFileSync(imagePath);
    const mime = mimeMap[ext] || detectImageMimeFromBuffer(data) || 'image/png';
    return `data:${mime};base64,${data.toString('base64')}`;
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
        };
    }
}

export type UserMessagePart = TextMessagePart | ImageMessagePart | FileMessagePart;

export class UserMessage {
    role: 'user' = 'user';
    message_id: string = crypto.randomUUID();
    content: Array<UserMessagePart> = [];
    /**
     * 标记此消息为内部消息（如钩子系统自动生成的 reject 消息）。
     * internal = true 时，仅在 debug 模式下在 TUI 中显示；
     * 持久化 JSON 和导出 HTML 中始终保留。
     */
    internal?: boolean;

    constructor(content?: string) {
        if (content) {
            this.content.push(new TextMessagePart(content));
        }
    }

    getPlainText(): string {
        return this.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
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
            last_part.invalidateRender();
        } else {
            this.content.push(new TextMessagePart(text));
        }
        return this;
    }

    appendPart(part: UserMessagePart): UserMessage {
        if (part.type === 'text') {
            this.appendText(part.text);
        } else if (part.type === 'file') {
            this.content.push(part);
        } else if (part.type === 'image_url') {
            this.content.push(part);
        } else {
            throw new Error(`unsupported part type ${(part as any).type}`);
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
        const user_message = raw_obj as UserMessage;
        if (!user_message.message_id) {
            user_message.message_id = crypto.randomUUID();
        }
        if (user_message.content !== undefined) {
            for (const part of user_message.content) {
                if (part.type === 'text') {
                    TextMessagePart.assign(part);
                } else if (part.type === 'file') {
                    FileMessagePart.assign(part);
                } else if (part.type === 'image_url') {
                    ImageMessagePart.assign(part);
                } else {
                    throw new Error(`unsupported part type ${(part as any).type}`);
                }
            }
        }
        return user_message;
    }

    async render(): Promise<void> {
        for (const part of this.content) {
            await part.render();
        }
    }

    toRenderJSON(): object {
        return {
            role: this.role,
            message_id: this.message_id,
            internal: this.internal,
            content: this.content.map((part) => part.toRenderJSON())
        };
    }

    toOpenAIMessage(supportsVision: boolean = true): object {
        const parts = supportsVision ? this.content : this.content.filter((part) => part.type !== 'image_url');

        if (parts.length === 1 && parts[0].type === 'text') {
            return {
                role: this.role,
                content: parts[0].text
            };
        }
        return {
            role: this.role,
            content: parts.map((part) => part.toOpenAIMessagePart())
        };
    }
}

export type AssistantMessagePart = TextMessagePart | ReasoningMessagePart | ToolCallMessagePart | ErrorMessagePart;

export class AssistantMessage {
    role: 'assistant' = 'assistant';
    message_id: string = crypto.randomUUID();
    content: Array<AssistantMessagePart> = [];
    usage?: Usage;
    private _insideThinkTag: boolean = false;

    constructor(content: Array<AssistantMessagePart> = []) {
        this.content = content;
        Object.defineProperty(this, '_insideThinkTag', {
            value: false,
            writable: true,
            enumerable: false
        });
    }

    /**
     * Assign the prototype of the given object to the AssistantMessage prototype
     */
    static assign(raw_obj: object): AssistantMessage {
        Object.setPrototypeOf(raw_obj, AssistantMessage.prototype);
        const assistant_message = raw_obj as AssistantMessage;
        Object.defineProperty(assistant_message, '_insideThinkTag', {
            value: false,
            writable: true,
            enumerable: false
        });
        if (assistant_message.content !== undefined) {
            for (const part of assistant_message.content) {
                if (part.type === 'text') {
                    TextMessagePart.assign(part);
                } else if (part.type === 'reasoning') {
                    ReasoningMessagePart.assign(part);
                } else if (part.type === 'tool_call') {
                    ToolCallMessagePart.assign(part);
                } else if (part.type === 'error') {
                    ErrorMessagePart.assign(part);
                }
            }
        }
        return assistant_message;
    }

    async render(): Promise<void> {
        for (const part of this.content) {
            await part.render();
        }
    }

    toRenderJSON(): object {
        return {
            role: this.role,
            message_id: this.message_id,
            usage: this.usage,
            content: this.content.map((part) => part.toRenderJSON())
        };
    }

    /**
     * Merges the give message to this message and returns itself
     */
    mergeChunk(chunk: AssistantMessage): AssistantMessage {
        for (const part of chunk.content) {
            this.appendPart(part);
        }
        return this;
    }

    appendPart(
        part: TextMessagePart | ReasoningMessagePart | ToolCallMessagePart | ErrorMessagePart
    ): AssistantMessage {
        if (part.type === 'text') {
            this.appendText(part.text);
        } else if (part.type === 'reasoning') {
            this.appendReasoningContent(part.content, part.source);
        } else if (part.type === 'tool_call') {
            this.appendToolCallPart(part);
        } else if (part.type === 'error') {
            this.content.push(part);
        }
        return this;
    }

    appendError(title: string, message: string): AssistantMessage {
        this.content.push(new ErrorMessagePart(title, message));
        return this;
    }

    appendReasoningContent(
        content: string,
        source: 'reasoning_content' | 'think_tag' = 'reasoning_content'
    ): AssistantMessage {
        const last_part = this.content[this.content.length - 1];
        if (last_part && last_part.type === 'reasoning' && last_part.source === source) {
            last_part.content += content;
            last_part.invalidateRender();
        } else {
            this.content.push(new ReasoningMessagePart(content, source));
        }
        return this;
    }

    /**
     * Append a text part to the message.
     * Detects `<think>...</think>` tags in the text content and automatically
     * splits them into ReasoningMessagePart, handling streaming scenarios where
     * tags may be split across multiple chunks.
     */
    appendText(text: string): AssistantMessage {
        if (this._insideThinkTag) {
            this._appendToReasoningRaw(text);
            this._checkAndSplitReasoningClose();
        } else {
            this._appendRawText(text);
            this._checkAndSplitTextOpen();
        }
        return this;
    }

    private _appendRawText(text: string): void {
        const last_part = this.content[this.content.length - 1];
        if (last_part && last_part.type === 'text') {
            last_part.text += text;
            last_part.invalidateRender();
        } else {
            this.content.push(new TextMessagePart(text));
        }
    }

    private _appendToReasoningRaw(text: string): void {
        const last_part = this.content[this.content.length - 1];
        if (last_part && last_part.type === 'reasoning') {
            last_part.content += text;
            last_part.invalidateRender();
        } else {
            this.content.push(new ReasoningMessagePart(text, 'think_tag'));
        }
    }

    /**
     * Check if the last TextMessagePart contains `<think>` and split it into
     * a TextMessagePart (before) and ReasoningMessagePart (after).
     */
    private _checkAndSplitTextOpen(): void {
        const last_part = this.content[this.content.length - 1];
        if (!last_part || last_part.type !== 'text') return;

        const openIdx = last_part.text.indexOf('<think>');
        if (openIdx === -1) return;

        const beforeThink = last_part.text.substring(0, openIdx);
        const afterOpen = last_part.text.substring(openIdx + '<think>'.length);

        if (beforeThink.trim().length > 0) {
            last_part.text = beforeThink;
            last_part.invalidateRender();
        } else {
            this.content.pop();
        }

        this._insideThinkTag = true;

        if (afterOpen.length > 0) {
            this.content.push(new ReasoningMessagePart(afterOpen, 'think_tag'));
            this._checkAndSplitReasoningClose();
        }
    }

    /**
     * Check if the last ReasoningMessagePart contains `</think>` and split it into
     * a ReasoningMessagePart (before) and TextMessagePart (after).
     */
    private _checkAndSplitReasoningClose(): void {
        const last_part = this.content[this.content.length - 1];
        if (!last_part || last_part.type !== 'reasoning') return;

        const closeIdx = last_part.content.indexOf('</think>');
        if (closeIdx === -1) return;

        const reasoningText = last_part.content.substring(0, closeIdx);
        const afterClose = last_part.content.substring(closeIdx + '</think>'.length);

        last_part.content = reasoningText;
        last_part.invalidateRender();
        this._insideThinkTag = false;

        if (afterClose.trim().length > 0) {
            this.content.push(new TextMessagePart(afterClose));
            this._checkAndSplitTextOpen();
        }
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
    private static resolveToolCallOverrideContent(
        toolcall: ToolCall,
        toolResultOverrides?: Map<string, string>
    ): string | undefined {
        const resultId = toolcall.result_storage?.result_id;
        if (!resultId) {
            return undefined;
        }
        const overrideContent = toolResultOverrides?.get(resultId);
        if (typeof overrideContent === 'string' && overrideContent.length > 0) {
            return overrideContent;
        }
        return undefined;
    }

    private static buildOpenAIToolResultContent(toolcall: ToolCall, toolResultOverrides?: Map<string, string>): string {
        if (toolcall.compress_id) {
            return `工具返回结果已被压缩，数据ID为 ${toolcall.compress_id}`;
        }

        const overrideContent = AssistantMessage.resolveToolCallOverrideContent(toolcall, toolResultOverrides);
        if (overrideContent !== undefined) {
            return overrideContent;
        }

        if (toolcall.status === 'error') {
            return `Toolcall failed: ${toolcall.result ?? ''}`;
        }

        if (toolcall.status === 'success') {
            return toolcall.result ?? '工具调用成功完成';
        }

        return 'Toolcall failed: unfinished tool call';
    }

    toOpenAIMessages(toolResultOverrides?: Map<string, string>): object[] {
        const messages: object[] = [];

        let currentReasoning = '';
        let currentText = '';

        const processCurrentMessage = () => {
            currentReasoning = currentReasoning.trim();
            currentText = currentText.trim();
            if (currentText.length === 0 && currentReasoning.length === 0) {
                return;
            }
            const message: any = { role: 'assistant' };
            if (currentReasoning.length > 0) {
                message.reasoning_content = currentReasoning;
            }
            if (currentText.length > 0) {
                message.content = [{ type: 'text', text: currentText }];
            } else {
                // 确保 content 字段始终存在，即使为空字符串
                message.content = '';
            }
            currentReasoning = '';
            currentText = '';
            messages.push(message);
        };

        for (const part of this.content) {
            switch (part.type) {
                case 'reasoning': {
                    if (part.source === 'think_tag') {
                        currentText += `<think>${part.content}</think>`;
                    } else {
                        currentReasoning += part.content;
                    }
                    break;
                }
                case 'tool_call': {
                    processCurrentMessage();
                    const validToolcalls: ToolCall[] = [];
                    for (const tc of part.toolcalls) {
                        const argsToCheck =
                            tc.compress_id && tc.args_string && tc.args_string.length > LARGE_ARGS_THRESHOLD
                                ? `{"compressed":"placeholder"}`
                                : tc.args_string || '';
                        if (!isValidToolCallArgs(argsToCheck)) {
                            logger.warn(
                                `Dropping tool call "${tc.tool_name}" (id=${tc.id}) from OpenAI context: ` +
                                    `args_string is not valid JSON. Raw args: ${tc.args_string?.substring(0, 200)}`
                            );
                            continue;
                        }
                        validToolcalls.push(tc);
                    }
                    if (validToolcalls.length > 0) {
                        const toolCallObjects = validToolcalls.map((tc) => {
                            const shouldCompressArgs =
                                tc.compress_id && tc.args_string && tc.args_string.length > LARGE_ARGS_THRESHOLD;
                            return {
                                id: tc.id,
                                type: 'function',
                                function: {
                                    name: tc.tool_name,
                                    arguments: shouldCompressArgs
                                        ? `{"compressed":"工具参数已被压缩，数据ID为 ${tc.compress_id}"}`
                                        : tc.args_string || ''
                                }
                            };
                        });
                        messages.push({ role: 'assistant', tool_calls: toolCallObjects });
                        for (const toolcall of validToolcalls) {
                            const toolCallMsg: any = { role: 'tool', tool_call_id: toolcall.id };
                            toolCallMsg.content = AssistantMessage.buildOpenAIToolResultContent(
                                toolcall,
                                toolResultOverrides
                            );
                            messages.push(toolCallMsg);
                        }
                    }
                    break;
                }
                case 'text': {
                    currentText += part.text;
                    break;
                }
                case 'error': {
                    const errPart = part as ErrorMessagePart;
                    currentText += `[错误] ${errPart.title}: ${errPart.message}`;
                    break;
                }
            }
        }

        processCurrentMessage();
        return messages;
    }

    getOpenAIToolMessages(toolResultOverrides?: Map<string, string>): object[] {
        const messages: object[] = [];
        const tool_call_parts = this.content.filter((part) => part.type === 'tool_call');
        for (const part of tool_call_parts) {
            for (const toolcall of part.toolcalls) {
                if (!isValidToolCallArgs(toolcall.args_string)) {
                    logger.warn(
                        `Skipping tool response for "${toolcall.tool_name}" (id=${toolcall.id}): ` +
                            `original tool call had invalid JSON args`
                    );
                    continue;
                }
                const overrideContent = AssistantMessage.resolveToolCallOverrideContent(toolcall, toolResultOverrides);
                if (
                    !toolcall.compress_id &&
                    overrideContent === undefined &&
                    toolcall.status !== 'success' &&
                    toolcall.status !== 'error'
                ) {
                    throw new Error(`unfinished toolcall status ${toolcall.status}`);
                }
                messages.push({
                    role: 'tool',
                    tool_call_id: toolcall.id,
                    content: AssistantMessage.buildOpenAIToolResultContent(toolcall, toolResultOverrides)
                });
            }
        }
        return messages;
    }

    static parseOpenAIMessage(openai_message: any): AssistantMessage {
        const message = new AssistantMessage();

        const reasoning_content = openai_message['reasoning_content'];
        if (reasoning_content) {
            message.content.push(new ReasoningMessagePart(reasoning_content, 'reasoning_content'));
        }

        const tool_calls = openai_message['tool_calls'];
        if (tool_calls) {
            const part = new ToolCallMessagePart();
            for (const tool_call of tool_calls) {
                const tc = new ToolCall(
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
            // 不在临时消息上调用 appendText（它会在临时消息内解析 <think> 标签并消费状态，
            // 但 _insideThinkTag 状态不会传递到主消息）。
            // 直接创建 TextMessagePart，让 mergeChunk -> appendPart -> appendText
            // 在主消息上完成 <think> 标签的解析，确保状态一致性。
            message.content.push(new TextMessagePart(content));
        }
        return message;
    }
}

export class AssistantResponse {
    content: AssistantMessage;
    finish_reason: 'stop' | 'error' | 'tool_calls' | null;
    usage?: Usage;

    constructor(content: AssistantMessage, finish_reason: 'stop' | 'error' | 'tool_calls' | null = null) {
        this.content = content;
        this.finish_reason = finish_reason;
    }

    static richError(title: string, reason: string, ...attachments: string[]) {
        const response = new AssistantResponse(new AssistantMessage(), 'error');
        let message = reason;
        if (getDebugMode()) {
            for (const attachment of attachments) {
                message += '\n```\n' + attachment + '\n```\n';
            }
        }
        response.content.appendError(title, message);
        return response;
    }

    static error(reason: string): AssistantResponse {
        const response = new AssistantResponse(new AssistantMessage(), 'error');
        response.content.appendError('Error', reason);
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
            response.usage = new Usage(usage['prompt_tokens'], usage['completion_tokens'], usage['total_tokens']);
        }
        return response;
    }
}

/**
 * 上下文压缩分隔消息。
 * 消息历史中最多出现一次，其前面的消息在构建 OpenAI 上下文时会被跳过，
 * 由 summary 字段中的结构化快照替代。
 */
export interface CompactSummarizedRange {
    start_index: number;
    end_index_exclusive: number;
    message_count: number;
    user_messages: number;
    assistant_messages: number;
    tool_calls: number;
}

export type CompactBoundaryTrigger = 'manual' | 'auto';
export type CompactBoundaryStrategy = 'tail_preserving_full_compact';

export interface CompactBoundaryMetadata {
    boundary_id: string;
    summary_version: number;
    created_at: string;
    summarized_range?: CompactSummarizedRange;
    previous_boundary_id?: string;
    trigger?: CompactBoundaryTrigger;
    strategy?: CompactBoundaryStrategy;
    kept_range?: CompactSummarizedRange;
    kept_messages?: number;
    summarized_messages?: number;
}

export const COMPACT_SUMMARY_VERSION = 1;

export class CompactSeparatorMessage {
    role: 'compact_separator' = 'compact_separator';
    summary: string;
    metadata: CompactBoundaryMetadata;

    constructor(summary: string, metadata: Partial<CompactBoundaryMetadata> = {}) {
        this.summary = summary;
        this.metadata = CompactSeparatorMessage.normalizeMetadata(metadata);
    }

    private static normalizeMetadata(metadata?: Partial<CompactBoundaryMetadata>): CompactBoundaryMetadata {
        const normalized: CompactBoundaryMetadata = {
            boundary_id:
                typeof metadata?.boundary_id === 'string' && metadata.boundary_id.trim().length > 0
                    ? metadata.boundary_id
                    : crypto.randomUUID(),
            summary_version:
                typeof metadata?.summary_version === 'number' && Number.isInteger(metadata.summary_version)
                    ? metadata.summary_version
                    : COMPACT_SUMMARY_VERSION,
            created_at:
                typeof metadata?.created_at === 'string' && metadata.created_at.trim().length > 0
                    ? metadata.created_at
                    : new Date().toISOString()
        };

        const summarizedRange = CompactSeparatorMessage.normalizeSummarizedRange(metadata?.summarized_range);
        if (summarizedRange !== undefined) {
            normalized.summarized_range = summarizedRange;
        }

        const keptRange = CompactSeparatorMessage.normalizeSummarizedRange(metadata?.kept_range);
        if (keptRange !== undefined) {
            normalized.kept_range = keptRange;
        }

        if (typeof metadata?.previous_boundary_id === 'string' && metadata.previous_boundary_id.trim().length > 0) {
            normalized.previous_boundary_id = metadata.previous_boundary_id;
        }

        if (metadata?.trigger === 'manual' || metadata?.trigger === 'auto') {
            normalized.trigger = metadata.trigger;
        }

        if (metadata?.strategy === 'tail_preserving_full_compact') {
            normalized.strategy = metadata.strategy;
        }

        if (
            typeof metadata?.kept_messages === 'number' &&
            Number.isInteger(metadata.kept_messages) &&
            metadata.kept_messages >= 0
        ) {
            normalized.kept_messages = metadata.kept_messages;
        }

        if (
            typeof metadata?.summarized_messages === 'number' &&
            Number.isInteger(metadata.summarized_messages) &&
            metadata.summarized_messages >= 0
        ) {
            normalized.summarized_messages = metadata.summarized_messages;
        }

        return normalized;
    }

    private static normalizeSummarizedRange(
        range?: Partial<CompactSummarizedRange>
    ): CompactSummarizedRange | undefined {
        if (range === undefined || range === null || typeof range !== 'object') {
            return undefined;
        }

        const fields = [
            'start_index',
            'end_index_exclusive',
            'message_count',
            'user_messages',
            'assistant_messages',
            'tool_calls'
        ] as const;

        for (const field of fields) {
            const value = range[field];
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
                return undefined;
            }
        }

        return {
            start_index: range.start_index!,
            end_index_exclusive: range.end_index_exclusive!,
            message_count: range.message_count!,
            user_messages: range.user_messages!,
            assistant_messages: range.assistant_messages!,
            tool_calls: range.tool_calls!
        };
    }

    static assign(obj: any): CompactSeparatorMessage {
        Object.setPrototypeOf(obj, CompactSeparatorMessage.prototype);
        const legacyMetadata =
            obj.metadata && typeof obj.metadata === 'object'
                ? obj.metadata
                : {
                      boundary_id: obj.boundary_id,
                      summary_version: obj.summary_version,
                      created_at: obj.created_at,
                      summarized_range: obj.summarized_range,
                      previous_boundary_id: obj.previous_boundary_id,
                      trigger: obj.trigger,
                      strategy: obj.strategy,
                      kept_range: obj.kept_range,
                      kept_messages: obj.kept_messages,
                      summarized_messages: obj.summarized_messages
                  };
        obj.metadata = CompactSeparatorMessage.normalizeMetadata(legacyMetadata);
        return obj as CompactSeparatorMessage;
    }

    toOpenAIMessage(): object {
        return {
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: `[上下文压缩通知] 以下是对之前对话历史的结构化总结。此前的消息已被压缩并省略，请基于以下总结继续对话：\n\n${this.summary}`
                }
            ]
        };
    }

    async render(): Promise<void> {
        /* 渲染在 TUI/GUI 层处理 */
    }

    toRenderJSON(): object {
        return {
            role: this.role
        };
    }
}

export function isCompactBoundaryMessage(message: unknown): message is CompactSeparatorMessage {
    return (
        typeof message === 'object' && message !== null && (message as { role?: string }).role === 'compact_separator'
    );
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
        for (const toolset of toolsets) {
            this.toolsets.set(toolset.name, toolset);
        }
    }

    getTool(name: string): BaseTool<any> | undefined {
        const tools = this.getTools();
        return tools.get(name);
    }

    getTools(): Map<string, BaseTool<any>> {
        const tools: Map<string, BaseTool<any>> = new Map();
        for (const toolset of this.toolsets.values()) {
            for (const tool of toolset.tools.values()) {
                tools.set(`${toolset.name}-${tool.name}`, tool);
            }
        }
        return tools;
    }

    toJSON(): object {
        return {
            system_prompt: this.system_prompt,
            messages: this.messages
        };
    }

    toRenderJSON(): object {
        return {
            messages: this.messages.map((m) => m.toRenderJSON())
        };
    }

    appendMessage(message: ChatMessage): void {
        this.messages.push(message);
    }

    lastUserMessage(): UserMessage | undefined {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i].role === 'user') {
                return this.messages[i] as UserMessage;
            }
        }
        return undefined;
    }

    lastMessage(): ChatMessage | undefined {
        return this.messages[this.messages.length - 1];
    }

    /** 查找最后一条 compact boundary 的位置（从末尾搜索，确保多条时取最新的） */
    findCompactBoundary(): { index: number; message: CompactSeparatorMessage } | undefined {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (isCompactBoundaryMessage(this.messages[i])) {
                return { index: i, message: this.messages[i] as CompactSeparatorMessage };
            }
        }
        return undefined;
    }

    /** 兼容旧命名：查找最后一条 CompactSeparatorMessage 的位置 */
    findCompactSeparator(): { index: number; message: CompactSeparatorMessage } | undefined {
        return this.findCompactBoundary();
    }

    /** 移除所有 compact boundary */
    clearCompactBoundaries(): void {
        this.messages = this.messages.filter((message) => !isCompactBoundaryMessage(message));
    }

    /** 移除已有的 compact boundary 并在指定位置插入新的 boundary */
    replaceCompactBoundary(boundary: CompactSeparatorMessage, position: number): void {
        this.clearCompactBoundaries();
        this.messages.splice(position, 0, boundary);
    }

    /** 兼容旧命名：移除已有的分隔符并在指定位置插入新的 CompactSeparatorMessage */
    insertCompactSeparator(separator: CompactSeparatorMessage, position: number): void {
        this.replaceCompactBoundary(separator, position);
    }

    /** 确保最多只有一条 compact boundary，保留最后一条 */
    deduplicateCompactBoundaries(): void {
        let lastIdx = -1;
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (isCompactBoundaryMessage(this.messages[i])) {
                if (lastIdx === -1) {
                    lastIdx = i;
                } else {
                    this.messages.splice(i, 1);
                }
            }
        }
    }

    /** 兼容旧命名：确保最多只有一条 CompactSeparatorMessage，保留最后一条 */
    deduplicateSeparators(): void {
        this.deduplicateCompactBoundaries();
    }

    /**
     * Assign the prototype of the given object to the ChatContext prototype
     */
    static assign(chat_context_obj: any): ChatContext {
        const ctx = new ChatContext();
        const system_prompt = chat_context_obj['system_prompt'];
        if (system_prompt !== undefined) {
            ctx.system_prompt = SystemMessage.assign(system_prompt);
        }

        const messages = chat_context_obj['messages'];
        if (messages !== undefined) {
            for (const message of messages) {
                if (message.role === 'user') {
                    ctx.messages.push(UserMessage.assign(message));
                } else if (message.role === 'assistant') {
                    ctx.messages.push(AssistantMessage.assign(message));
                } else if (isCompactBoundaryMessage(message)) {
                    ctx.messages.push(CompactSeparatorMessage.assign(message));
                }
            }
        }
        ctx.deduplicateCompactBoundaries();
        // we cannot load any toolset from the saved chat context
        return ctx;
    }
}
