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
import { logger, getDebugMode } from '../utils/logger.js';
import { BaseTool, BaseToolset } from './tool.js';
import { escapeHtml } from '../../common/utils/escape.js';
import { levenshteinDistance } from '../../utils/string.js';
import {
    getDefaultToolCallPresentation,
    sanitizeToolCallPresentation,
    type ToolCallPresentation
} from './tool-presentation.js';
import markedKatex from 'marked-katex-extension';
import hljs from 'highlight.js';
import path from 'path';
import fs from 'fs';
import { fileLinkExtension } from '../utils/marked-file-link.js';
import { cjkAutolinkFix } from '../../common/markdown/cjk-autolink-fix.js';
import type {
    BaseAssistantMessage,
    ChatContextSnapshot,
    BaseChatToolCall,
    CompactBoundaryMetadata,
    CompactBoundaryStrategy,
    CompactBoundaryTrigger,
    BaseCompactSeparatorMessage,
    CompactSummarizedRange,
    BaseErrorMessagePart,
    BaseFileMessagePart,
    BaseImageMessagePart,
    BaseReasoningMessagePart,
    RuntimeMetadata,
    BaseSystemMessage,
    BaseTextMessagePart,
    BaseToolCallMessagePart,
    ToolCallMicrocompactMetadata,
    ToolResultStorageMetadata,
    BaseUsage,
    BaseUserMessage
} from './types/messages.js';

export type {
    ChatContextSnapshot,
    CompactBoundaryMetadata,
    CompactBoundaryStrategy,
    CompactBoundaryTrigger,
    CompactSummarizedRange,
    RuntimeMetadata,
    ToolCallMicrocompactMetadata,
    ToolResultStorageMetadata,
    BaseUsage as UsageFields
};

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

/**
 * 尝试从 args_string 中提取第一个完整的 JSON 对象。
 *
 * 处理模型输出的 args_string 为 "{ ... 正确JSON } { ... 未完成的JSON" 这种情况：
 * 通过追踪大括号嵌套层级（正确处理字符串内的转义），找到第一个完整的顶层 {} 对象。
 *
 * @returns 提取出的有效 JSON 字符串，或 null（无法提取时）
 */
export function tryExtractFirstJson(args_string: string): string | null {
    const trimmed = args_string.trim();
    if (!trimmed.startsWith('{')) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];

        if (escape) {
            escape = false;
            continue;
        }

        if (ch === '\\' && inString) {
            escape = true;
            continue;
        }

        if (ch === '"') {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                const candidate = trimmed.slice(0, i + 1);
                try {
                    JSON.parse(candidate);
                    return candidate;
                } catch {
                    return null;
                }
            }
        }
    }

    return null;
}

export const marked = new Marked();

marked.use(
    markedKatex({
        throwOnError: false,
        displayMode: true,
        nonStandard: true
    })
);

const DANGEROUS_HTML_RE = /<\s*\/?\s*(style|script|link|meta|iframe|object|embed|applet|form|base)\b[^>]*>/gi;

const LANG_DISPLAY_NAMES: Record<string, string> = {
    js: 'JavaScript',
    javascript: 'JavaScript',
    ts: 'TypeScript',
    typescript: 'TypeScript',
    py: 'Python',
    python: 'Python',
    rb: 'Ruby',
    ruby: 'Ruby',
    java: 'Java',
    cpp: 'C++',
    c: 'C',
    cs: 'C#',
    csharp: 'C#',
    go: 'Go',
    rust: 'Rust',
    rs: 'Rust',
    swift: 'Swift',
    kt: 'Kotlin',
    kotlin: 'Kotlin',
    php: 'PHP',
    sql: 'SQL',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    less: 'LESS',
    json: 'JSON',
    yaml: 'YAML',
    yml: 'YAML',
    xml: 'XML',
    toml: 'TOML',
    sh: 'Shell',
    bash: 'Bash',
    zsh: 'Zsh',
    powershell: 'PowerShell',
    ps1: 'PowerShell',
    md: 'Markdown',
    markdown: 'Markdown',
    tex: 'LaTeX',
    latex: 'LaTeX',
    dockerfile: 'Dockerfile',
    makefile: 'Makefile',
    cmake: 'CMake',
    r: 'R',
    lua: 'Lua',
    perl: 'Perl',
    scala: 'Scala',
    elixir: 'Elixir',
    dart: 'Dart',
    vue: 'Vue',
    svelte: 'Svelte',
    jsx: 'JSX',
    tsx: 'TSX',
    graphql: 'GraphQL',
    proto: 'Protobuf',
    ini: 'INI',
    plaintext: 'Text',
    svg: 'SVG',
    htm: 'HTML'
};

/** Languages whose code blocks support live preview in the renderer */
const PREVIEWABLE_LANGS = new Set(['html', 'htm', 'svg']);

function isFencedCodeComplete(raw: string): boolean {
    const opening = /^(?: {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/.exec(raw);
    if (!opening) return true;

    const fence = opening[1];
    const bodyLines = raw.slice(opening[0].length).split(/\r?\n/);
    if (bodyLines.at(-1) === '') bodyLines.pop();
    const lastLine = bodyLines.at(-1) ?? '';
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*$`);
    return closing.test(lastLine);
}

marked.use({
    renderer: {
        code({ text, lang, raw }: { text: string; lang?: string; raw: string; escaped?: boolean }): string {
            // mermaid 代码块不在此处做语法高亮，而是输出占位容器，
            // 交由 renderer 进程（previewer.ts 的 renderMermaidBlocks）异步渲染为 SVG。
            if (lang !== undefined && lang.toLowerCase() === 'mermaid') {
                const encoded = Buffer.from(text).toString('base64');
                const complete = isFencedCodeComplete(raw);
                return `<div class="mermaid-block" data-mermaid-code="${encoded}" data-mermaid-complete="${complete}"></div>`;
            }
            // 围栏/缩进代码块一律保持代码块渲染，不做文件路径解析
            // （胶囊只来自显式的 [...]() 链接，见 marked-file-link.ts）。
            const langClass = lang ? `hljs language-${lang}` : 'hljs';
            const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
            const highlighted = hljs.highlight(text, { language }).value;
            const displayLang = lang
                ? LANG_DISPLAY_NAMES[lang.toLowerCase()] || lang.charAt(0).toUpperCase() + lang.slice(1)
                : '';
            const headerHtml = `<div class="code-block-header"><span class="code-block-lang">${displayLang}</span></div>`;
            const lines = highlighted.split('\n');
            if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
            const rows = lines
                .map(
                    (line, i) =>
                        `<tr><td class="code-ln font-mono">${i + 1}</td><td class="code-line font-mono">${line || ' '}</td></tr>`
                )
                .join('');
            const langLower = lang?.toLowerCase() || '';
            const previewAttrs = PREVIEWABLE_LANGS.has(langLower)
                ? ` data-previewable="true" data-preview-lang="${langLower}" data-raw-code="${Buffer.from(text).toString('base64')}"`
                : '';
            return `<div class="code-block-wrapper"${previewAttrs}>${headerHtml}<div class="code-block-body ${langClass}"><table class="code-table"><tbody>${rows}</tbody></table></div></div>`;
        }
    },
    hooks: {
        postprocess(html: string): string {
            return html.replace(DANGEROUS_HTML_RE, (match) => {
                return match.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            });
        }
    }
});

marked.use(fileLinkExtension);
marked.use(cjkAutolinkFix);

/**
 * This is NOT an OpenAI message part, but a message part for our own message system.
 */
export class ReasoningMessagePart implements BaseReasoningMessagePart {
    type: 'reasoning' = 'reasoning';
    content: string;
    /** 来源：'reasoning_content' 表示来自 API 的 reasoning_content 字段，'think_tag' 表示从 <think> 标签解析 */
    source: 'reasoning_content' | 'think_tag';
    /** cached render result of the reasoning */
    rendered?: string;
    /** 思考耗时（秒），在思考结束时计算并持久化 */
    elapsedSeconds?: number;
    private _frozen!: boolean;
    /** 思考开始时间戳（非枚举，不持久化），仅用于实时计算 elapsedSeconds */
    private _startedAt?: number;

    constructor(content: string, source: 'reasoning_content' | 'think_tag') {
        this.content = content;
        this.source = source;
        Object.defineProperty(this, '_frozen', { value: false, writable: true, enumerable: false });
        Object.defineProperty(this, '_startedAt', { value: Date.now(), writable: true, enumerable: false });
    }

    /** 计算并固化思考耗时，仅在 _startedAt 存在且 elapsedSeconds 未设置时生效 */
    finalizeTiming(): void {
        if (this._startedAt !== undefined && this.elapsedSeconds === undefined) {
            this.elapsedSeconds = Math.max(0, Math.floor((Date.now() - this._startedAt) / 1000));
        }
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
            contentLength: this.content.length,
            elapsedSeconds: this.elapsedSeconds
        };
    }

    static assign(reasoning_message_part_obj: object): ReasoningMessagePart {
        Object.setPrototypeOf(reasoning_message_part_obj, ReasoningMessagePart.prototype);
        const part = reasoning_message_part_obj as ReasoningMessagePart;
        Object.defineProperty(part, '_frozen', { value: false, writable: true, enumerable: false });
        Object.defineProperty(part, '_startedAt', { value: undefined, writable: true, enumerable: false });
        return part;
    }
}

/** 当压缩后的工具参数长度超过此阈值时，参数本身也会被替换为压缩占位 */
const LARGE_ARGS_THRESHOLD = 500;

export const TOOL_RESULT_STORAGE_VERSION = 1;
export const TOOL_CALL_MICROCOMPACT_VERSION = 1;
export class ToolCall implements BaseChatToolCall {
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
     * TODO(step10-compress_id): 后续移除 compress_id 协议时同步删掉所有读取点。
     * Step 7 后 full compact 主路径使用 boundary summary + kept tail，不再新增依赖此字段。
     * 保留它是为了兼容旧任务和旧工具结果占位。
     */
    compress_id?: string;
    /** 大工具结果落盘后的稳定引用信息 */
    result_storage?: ToolResultStorageMetadata;
    /** 本地 microcompact 后的持久化元数据 */
    microcompact?: ToolCallMicrocompactMetadata;
    metadata?: RuntimeMetadata;
    presentation?: ToolCallPresentation;
    elapsedSeconds?: number;
    private _startedAt?: number;

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
        Object.defineProperty(this, '_startedAt', { value: undefined, writable: true, enumerable: false });
    }

    startTiming(now: number = Date.now()): void {
        if (this._startedAt === undefined && this.elapsedSeconds === undefined) {
            this._startedAt = now;
        }
    }

    finalizeTiming(now: number = Date.now()): void {
        if (this._startedAt === undefined || this.elapsedSeconds !== undefined) return;
        this.elapsedSeconds = Math.round((Math.max(0, now - this._startedAt) / 1000) * 10) / 10;
        this._startedAt = undefined;
    }

    getResultImages(): Array<{ image_url: string; media_type?: string; source?: string }> {
        if (this.status !== 'success' || !this.result_object || typeof this.result_object !== 'object') {
            return [];
        }
        const resultObject = this.result_object as {
            type?: unknown;
            images?: unknown;
        };
        if (resultObject.type !== 'image' || !Array.isArray(resultObject.images)) {
            return [];
        }
        return resultObject.images.flatMap((image) => {
            if (!image || typeof image !== 'object') {
                return [];
            }
            const record = image as Record<string, unknown>;
            if (
                typeof record.image_url !== 'string' ||
                (!record.image_url.startsWith('data:image/') && !/^https?:\/\//i.test(record.image_url))
            ) {
                return [];
            }
            return [
                {
                    image_url: record.image_url,
                    ...(typeof record.media_type === 'string' ? { media_type: record.media_type } : {}),
                    ...(typeof record.source === 'string' ? { source: record.source } : {})
                }
            ];
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
        const { tool: _tool, ...rest } = this as ToolCall & { tool?: BaseTool<any> };
        return {
            ...rest,
            presentation: this.getPresentation()
        };
    }

    /** 仅返回渲染摘要；执行结果和经工具显式声明的自定义详情由 IPC 按需读取。 */
    toRenderJSON(): object {
        const presentation = this.getPresentation();
        return {
            index: this.index,
            id: this.id,
            tool_name: this.tool_name,
            status: this.status,
            detail_available: Boolean(this.result || (this.rendered && presentation.detailMode === 'custom')),
            presentation,
            elapsedSeconds: this.elapsedSeconds
        };
    }

    getPresentation(): ToolCallPresentation {
        try {
            if (this.tool && typeof this.tool.getToolCallPresentation === 'function') {
                this.presentation = sanitizeToolCallPresentation(
                    this.tool.getToolCallPresentation(this),
                    this.tool_name
                );
                return this.presentation;
            }
        } catch (error) {
            logger.error(`Error creating tool presentation for ${this.tool_name}: ${error}`);
        }
        this.presentation = this.presentation
            ? sanitizeToolCallPresentation(this.presentation, this.tool_name)
            : getDefaultToolCallPresentation(this);
        return this.presentation;
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

    /** @deprecated Legacy compress_id protocol. */
    hasLegacyCompressId(): boolean {
        return typeof this.compress_id === 'string' && this.compress_id.length > 0;
    }

    /** @deprecated Legacy compress_id protocol. */
    shouldUseLegacyCompressedArgsPlaceholder(): boolean {
        return this.hasLegacyCompressId() && this.args_string.length > LARGE_ARGS_THRESHOLD;
    }

    /** @deprecated Legacy compress_id protocol. */
    getLegacyCompressedResultText(): string {
        return `工具返回结果已被压缩，数据ID为 ${this.compress_id}`;
    }

    /** @deprecated Legacy compress_id protocol. */
    getLegacyCompressedArgsText(): string {
        return `{"compressed":"工具参数已被压缩，数据ID为 ${this.compress_id}"}`;
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

        /* 默认统一渲染错误；少数工具可选择保留自身身份信息并负责展示错误内容。 */
        if (this.status === 'error' && this.tool?.renderToolCallOnError !== true) {
            return this.renderError();
        }

        /* 如果工具自定义了渲染函数，则使用工具的渲染函数（需确认为 BaseTool 实例，反序列化后可能为纯对象） */
        if (this.tool !== undefined && typeof (this.tool as any).renderToolCall === 'function') {
            const rendered = await this.tool.renderToolCall(this);
            if (rendered !== undefined) {
                return rendered;
            }
        }

        if (this.status === 'error') {
            return this.renderError();
        }

        const statusIcon =
            this.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : '';

        const displayName = this.tool_name;

        return `<div class="od-inline-toolcall-container">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-wrench shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(displayName)}</span>
                ${statusIcon}
            </div>
        </div>`;
    }

    /** 统一的工具错误内联展开渲染，所有工具报错都走这个入口 */
    private renderError(): string {
        const errId = `tc-err-${this.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const errText = (this.result || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<div class="od-inline-toolcall-container">
            <div class="flex flex-col min-w-0">
                <input type="checkbox" id="${errId}" class="peer hidden">
                <div class="flex items-center gap-1.5">
                    <i class="fas fa-wrench shrink-0 text-slate-400 text-xs"></i>
                    <span class="shrink-0 text-slate-500 text-xs">${this.tool_name}</span>
                    <span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                    <label for="${errId}" class="text-xs text-rose-500 cursor-pointer select-none hover:text-rose-600 transition-colors">失败</label>
                </div>
                <div class="grid grid-rows-[0fr] peer-checked:grid-rows-[1fr] transition-[grid-template-rows] duration-300 ease-out">
                    <div class="overflow-hidden">
                        <div class="text-xs text-rose-600 bg-rose-50 px-3 py-2 rounded break-all mt-0.5">
                            ${errText}
                        </div>
                    </div>
                </div>
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
        Object.defineProperty(tc, '_startedAt', { value: undefined, writable: true, enumerable: false });
        tc.result_storage = ToolCall.normalizeResultStorage(tc.result_storage);
        tc.microcompact = ToolCall.normalizeMicrocompact(tc.microcompact);
        tc.presentation = tc.presentation ? sanitizeToolCallPresentation(tc.presentation, tc.tool_name) : undefined;
        return tc;
    }
}

export class ToolCallMessagePart implements BaseToolCallMessagePart {
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
        const hasValidIndex = typeof toolcall.index === 'number' && Number.isInteger(toolcall.index);
        let target = hasValidId ? this.toolcalls.find((tc) => tc.id === toolcall.id) : undefined;
        if (target === undefined && hasValidIndex) {
            for (let i = this.toolcalls.length - 1; i >= 0; i--) {
                const candidate = this.toolcalls[i];
                if (candidate.index !== toolcall.index) {
                    continue;
                }

                const candidateHasValidId = typeof candidate.id === 'string' && candidate.id.trim().length > 0;
                if (!hasValidId || !candidateHasValidId) {
                    target = candidate;
                    break;
                }
            }
        }
        if (target === undefined) {
            this.toolcalls.push(toolcall);
        } else {
            // Handle the case where args_string might be the string "null" instead of proper JSON.
            const args_to_append = toolcall.args_string === 'null' ? '' : (toolcall.args_string ?? '');
            target.args_string = (target.args_string ?? '') + args_to_append;
            // Fill an id that was missing from an earlier chunk. Different valid ids always
            // represent different calls, even when a provider reuses the same index.
            if (hasValidId) {
                target.id = toolcall.id;
            }
            if (toolcall.tool_name && toolcall.tool_name !== 'unknown') {
                target.tool_name = toolcall.tool_name;
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
                    const extracted = tryExtractFirstJson(toolcall.args_string);
                    if (extracted) {
                        logger.info(
                            `Recovered partial JSON for tool call "${toolcall.tool_name}" (id=${toolcall.id}): ` +
                                `extracted valid prefix from malformed args_string`
                        );
                        toolcall.args_string = extracted;
                        return true;
                    }
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
                    arguments: toolcall.args_string || '{}'
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
            ...(this.toolcalls.length === 0 ? { rendered: this.rendered } : {}),
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

export class FileMessagePart implements BaseFileMessagePart {
    type: 'file' = 'file';
    path: string;
    rendered?: string;
    /** 文件大小（字节） */
    size?: number;
    /** 最后修改时间（ISO 字符串或时间戳） */
    modifiedTime?: string | number;

    constructor(path: string, size?: number, modifiedTime?: string | number) {
        this.path = path;
        this.size = size;
        this.modifiedTime = modifiedTime;
    }

    toModelText(): string {
        return `用户添加了文件附件: ${this.path}，你可以使用 extractText 工具提取其文本内容。`;
    }

    toOpenAIMessagePart(): object {
        return {
            type: 'text',
            text: this.toModelText()
        };
    }

    /** 获取文件扩展名（大写，无前缀点） */
    private _getExtension(): string {
        const ext = path.extname(this.path).toUpperCase().slice(1);
        return ext || 'FILE';
    }

    /** 根据扩展名返回图标 emoji */
    private _getFileIcon(): string {
        const ext = this._getExtension().toLowerCase();
        const iconMap: Record<string, string> = {
            pdf: '',
            doc: '📝',
            docx: '📝',
            txt: '',
            md: '📄',
            xls: '📊',
            xlsx: '📊',
            csv: '',
            ppt: '📽️',
            pptx: '📽️',
            jpg: '🖼️',
            jpeg: '🖼️',
            png: '🖼️',
            gif: '️',
            svg: '🖼️',
            webp: '🖼️',
            zip: '📦',
            rar: '📦',
            '7z': '📦',
            tar: '📦',
            gz: '📦',
            js: '📜',
            ts: '',
            jsx: '📜',
            tsx: '📜',
            py: '🐍',
            java: '☕',
            go: '🔷',
            rs: '',
            html: '🌐',
            css: '🎨',
            json: '📋',
            xml: '',
            yaml: '📋',
            yml: '📋',
            mp3: '🎵',
            wav: '',
            flac: '🎵',
            mp4: '🎬',
            avi: '🎬',
            mov: '🎬',
            mkv: '🎬'
        };
        return iconMap[ext] || '📄';
    }

    /** 格式化文件大小 */
    private _formatSize(): string {
        if (this.size === undefined || this.size === null) return '';
        const bytes = this.size;
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }

    /** 格式化修改时间 */
    private _formatModifiedTime(): string {
        if (!this.modifiedTime) return '';
        let date: Date;
        if (typeof this.modifiedTime === 'number') {
            date = new Date(this.modifiedTime);
        } else {
            date = new Date(this.modifiedTime);
        }
        if (Number.isNaN(date.getTime())) return '';
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const day = date.getDate();
        const month = months[date.getMonth()];
        const year = date.getFullYear();
        return `${month} ${String(day).padStart(2, '0')}, ${year}`;
    }

    async render(): Promise<string> {
        if (this.rendered !== undefined) {
            return this.rendered;
        }

        this.rendered = this._buildRenderSync();
        return this.rendered;
    }

    toRenderJSON(): object {
        // 确保 rendered 始终有值，避免 render() 未被调用时前端显示空白
        if (this.rendered === undefined) {
            // render() 是纯同步操作（虽然声明为 async），可以安全同步调用
            this.rendered = this._buildRenderSync();
        }
        return {
            type: this.type,
            path: this.path,
            rendered: this.rendered
        };
    }

    /**
     * 同步构建渲染 HTML（与 render() 逻辑一致，但不依赖 async）。
     * 用于在 render() 尚未被调用时提供 fallback。
     */
    private _buildRenderSync(): string {
        const fileName = path.basename(this.path);
        const ext = this._getExtension();
        const fileIcon = this._getFileIcon();
        const sizeStr = this._formatSize();
        const modifiedStr = this._formatModifiedTime();

        const metaParts: string[] = [];
        if (sizeStr) metaParts.push(sizeStr);
        if (modifiedStr) metaParts.push(`modified ${modifiedStr}`);
        const metaInfo = metaParts.join(', ');

        // 左键点击行为与普通文本消息中的 file-pill 保持一致：带 data-open-preview，
        // 由渲染端 _handlePreviewOpenClick 统一在右侧预览。data-file-path 供右键/三点菜单使用。
        return `
        <div class="od-file-card" data-file-path="${escapeHtml(this.path)}" data-open-preview="${escapeHtml(this.path)}">
            <div class="od-file-card-icon">${fileIcon}</div>
            <div class="od-file-card-info">
                <span class="od-file-card-name">${fileName}</span>
                ${metaInfo ? `<span class="od-file-card-meta">${metaInfo}</span>` : `<span class="od-file-card-meta">${ext} 文档</span>`}
            </div>
            <button class="od-file-card-menu" aria-label="文件操作" data-open-preview="${escapeHtml(this.path)}">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="8" cy="3" r="1.5"/>
                    <circle cx="8" cy="8" r="1.5"/>
                    <circle cx="8" cy="13" r="1.5"/>
                </svg>
            </button>
        </div>
        `;
    }

    static assign(file_message_part_obj: object): FileMessagePart {
        Object.setPrototypeOf(file_message_part_obj, FileMessagePart.prototype);
        return file_message_part_obj as FileMessagePart;
    }
}

export class TextMessagePart implements BaseTextMessagePart {
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
            text: this.text,
            rendered: this.rendered
        };
    }
}

export class ErrorMessagePart implements BaseErrorMessagePart {
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
        <div class="od-error-msg flex flex-col mt-1.5 mb-1.5 text-xs bg-rose-50/80 border border-rose-200 py-2 px-3 rounded-xl shadow-sm w-fit min-w-[240px] max-w-2xl">
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

export class ImageMessagePart implements BaseImageMessagePart {
    type: 'image_url' = 'image_url';
    image_url: { url: string };
    rendered?: string;
    /**
     * 当设置此字段时，图片已保存到本地文件，发送给模型的是文本引用
     * （包含文件路径和工具使用引导）而非图片 data URI。
     * UI 渲染仍然使用 image_url 中的 data URI 显示图片预览。
     */
    file_path?: string;

    constructor(image_url: string, file_path?: string) {
        this.image_url = { url: image_url };
        this.file_path = file_path;
    }

    toModelText(): string {
        return `用户添加了图片附件: ${this.file_path}, 你可以使用 readImage 工具或 askImage 工具分析该图片内容`;
    }

    toOpenAIMessagePart(): object {
        if (this.file_path) {
            return { type: 'text', text: this.toModelText() };
        }
        return { type: this.type, image_url: this.image_url };
    }

    async render(): Promise<string> {
        if (this.rendered !== undefined) {
            return this.rendered;
        }
        this.rendered = `<img src="${this.image_url.url}" alt="image" class="od-user-image-thumb" style="max-width:240px;max-height:180px;border-radius:8px;object-fit:contain;cursor:pointer;display:block;" />`;
        return this.rendered;
    }

    toRenderJSON(): object {
        return {
            type: this.type,
            rendered: this.rendered,
            ...(this.file_path ? { file_path: this.file_path } : {})
        };
    }

    static assign(image_message_part_obj: object): ImageMessagePart {
        Object.setPrototypeOf(image_message_part_obj, ImageMessagePart.prototype);
        return image_message_part_obj as ImageMessagePart;
    }
}

const IMAGE_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.jfif',
    '.gif',
    '.webp',
    '.bmp',
    '.svg',
    '.avif',
    '.tif',
    '.tiff',
    '.ico',
    '.heic',
    '.heif'
]);

/**
 * 从文本中提取可能的文件路径并过滤出合法存在的图片文件。
 * 支持 Windows 绝对路径 (C:\xxx.png)、Unix 绝对路径 (/c/Projects/test.png)、
 * 相对路径 (./abc.jpg) 等形式。
 * 返回去重后的绝对路径列表。
 */
export function extractImagePaths(text: string): string[] {
    const foundPaths = new Set<string>();

    const tryAdd = (rawPath: string) => {
        if (!IMAGE_EXTENSIONS.has(path.extname(rawPath).toLowerCase())) return;
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
    const bareFilenamePattern = /(?<![<"'\\/]\w)([A-Za-z0-9_-][A-Za-z0-9_\-. ]*\.\w{2,5})(?!["\w])/gi;
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
        '.jfif': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml',
        '.avif': 'image/avif',
        '.tif': 'image/tiff',
        '.tiff': 'image/tiff',
        '.ico': 'image/x-icon',
        '.heic': 'image/heic',
        '.heif': 'image/heif'
    };
    const data = fs.readFileSync(imagePath);
    const mime = mimeMap[ext] || detectImageMimeFromBuffer(data) || 'image/png';
    return `data:${mime};base64,${data.toString('base64')}`;
}

/**
 * @class Usage
 */
export class Usage implements BaseUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;

    constructor(
        prompt_tokens?: number,
        completion_tokens?: number,
        total_tokens?: number,
        extra: Omit<BaseUsage, 'prompt_tokens' | 'completion_tokens' | 'total_tokens'> = {}
    ) {
        this.prompt_tokens = Usage.normalizeOptionalTokenCount(prompt_tokens);
        this.completion_tokens = Usage.normalizeOptionalTokenCount(completion_tokens);
        this.total_tokens = Usage.normalizeOptionalTokenCount(total_tokens);
        this.input_tokens = Usage.normalizeOptionalTokenCount(extra.input_tokens);
        this.output_tokens = Usage.normalizeOptionalTokenCount(extra.output_tokens);
        this.cache_creation_input_tokens = Usage.normalizeOptionalTokenCount(extra.cache_creation_input_tokens);
        this.cache_read_input_tokens = Usage.normalizeOptionalTokenCount(extra.cache_read_input_tokens);
    }

    private static normalizeOptionalTokenCount(value: unknown): number | undefined {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            return undefined;
        }
        return Math.floor(value);
    }

    private static hasKnownUsageField(candidate: Record<string, unknown>): boolean {
        return [
            'prompt_tokens',
            'completion_tokens',
            'total_tokens',
            'input_tokens',
            'output_tokens',
            'cache_creation_input_tokens',
            'cache_read_input_tokens'
        ].some((key) => candidate[key] !== undefined);
    }

    static fromRaw(raw_usage: unknown): Usage | undefined {
        if (raw_usage === undefined || raw_usage === null || typeof raw_usage !== 'object') {
            return undefined;
        }

        const candidate = raw_usage as Record<string, unknown>;
        if (!Usage.hasKnownUsageField(candidate)) {
            return undefined;
        }

        const usage = new Usage(
            candidate.prompt_tokens as number,
            candidate.completion_tokens as number,
            candidate.total_tokens as number,
            {
                input_tokens: candidate.input_tokens as number,
                output_tokens: candidate.output_tokens as number,
                cache_creation_input_tokens: candidate.cache_creation_input_tokens as number,
                cache_read_input_tokens: candidate.cache_read_input_tokens as number
            }
        );

        if (
            usage.prompt_tokens === undefined &&
            usage.completion_tokens === undefined &&
            usage.total_tokens === undefined &&
            usage.input_tokens === undefined &&
            usage.output_tokens === undefined &&
            usage.cache_creation_input_tokens === undefined &&
            usage.cache_read_input_tokens === undefined
        ) {
            return undefined;
        }

        return usage;
    }

    static assign(raw_usage: unknown): Usage | undefined {
        return Usage.fromRaw(raw_usage);
    }
}

/**
 * @class SystemMessage
 */
export class SystemMessage implements BaseSystemMessage {
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

export class UserMessage implements BaseUserMessage {
    role: 'user' = 'user';
    message_id: string = crypto.randomUUID();
    content: Array<UserMessagePart> = [];
    timestamp: number = Date.now();
    /**
     * 标记此消息为内部消息（如钩子系统自动生成的 reject 消息）。
     * internal = true 时，TUI 默认仅在 debug 模式下显示；
     * 带 rawText 的可展示 goal 内部消息会作为用户可见消息展示。
     * 持久化 JSON 和导出 HTML 中始终保留。
     */
    internal?: boolean;
    /** 用户的原始输入文本（在 /skill 替换等处理之前） */
    rawText?: string;
    metadata?: RuntimeMetadata;

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
        if (!user_message.timestamp) {
            user_message.timestamp = Date.now();
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
            timestamp: this.timestamp,
            rawText: this.rawText,
            metadata: this.metadata,
            content: this.content.map((part) => part.toRenderJSON())
        };
    }

    toOpenAIMessage(supportsVision: boolean = true): object {
        // 当模型不支持视觉时，过滤掉真正的图片 data URI 部分。
        // 带有 file_path 的 image_url 部分是文本引用（路径+工具引导），应保留。
        const parts = supportsVision
            ? this.content
            : this.content.filter((part) => !(part.type === 'image_url' && !(part as ImageMessagePart).file_path));

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

export class AssistantMessage implements BaseAssistantMessage {
    role: 'assistant' = 'assistant';
    message_id: string = crypto.randomUUID();
    content: Array<AssistantMessagePart> = [];
    usage?: Usage;
    metadata?: RuntimeMetadata;
    timestamp?: number;
    elapsedSeconds?: number;
    private _insideThinkTag: boolean = false;
    private _allowThinkTagParsing: boolean = true;
    private _allowImplicitThinkClose: boolean = true;
    private _thinkRoundStartPartIndex: number = 0;
    private _turnStartedAt?: number;

    constructor(content: Array<AssistantMessagePart> = [], options?: { allowThinkTagParsing?: boolean }) {
        this.content = content;
        Object.defineProperty(this, '_insideThinkTag', {
            value: false,
            writable: true,
            enumerable: false
        });
        Object.defineProperty(this, '_allowThinkTagParsing', {
            value: options?.allowThinkTagParsing ?? content.length === 0,
            writable: true,
            enumerable: false
        });
        Object.defineProperty(this, '_allowImplicitThinkClose', {
            value: content.length === 0,
            writable: true,
            enumerable: false
        });
        Object.defineProperty(this, '_thinkRoundStartPartIndex', {
            value: content.length,
            writable: true,
            enumerable: false
        });
        Object.defineProperty(this, '_turnStartedAt', {
            value: Date.now(),
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
        Object.defineProperty(assistant_message, '_allowThinkTagParsing', {
            value: false,
            writable: true,
            enumerable: false
        });
        Object.defineProperty(assistant_message, '_allowImplicitThinkClose', {
            value: false,
            writable: true,
            enumerable: false
        });
        Object.defineProperty(assistant_message, '_thinkRoundStartPartIndex', {
            value: assistant_message.content?.length ?? 0,
            writable: true,
            enumerable: false
        });
        Object.defineProperty(assistant_message, '_turnStartedAt', {
            value: undefined,
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
        assistant_message.usage = Usage.fromRaw(assistant_message.usage);
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
            metadata: this.metadata,
            timestamp: this.timestamp,
            elapsedSeconds: this.elapsedSeconds,
            content: this.content.map((part) => part.toRenderJSON())
        };
    }

    finalizeTurnTiming(completedAt: number = Date.now()): void {
        if (this.elapsedSeconds !== undefined || this._turnStartedAt === undefined) return;
        this.elapsedSeconds = Math.max(0, Math.round((completedAt - this._turnStartedAt) / 100) / 10);
        this._turnStartedAt = undefined;
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

    /**
     * 固化最后一个 reasoning part 的思考耗时（如果有且尚未固化）。
     * 在追加非 reasoning 内容、或创建新的不同 source 的 reasoning part 之前调用。
     */
    private _finalizeLastReasoning(): void {
        const last = this.content[this.content.length - 1];
        if (last && last.type === 'reasoning') {
            (last as ReasoningMessagePart).finalizeTiming();
        }
    }

    /** 固化所有未固化的 reasoning part 的思考耗时，在流式输出结束后调用 */
    finalizeReasoningTiming(): void {
        for (const part of this.content) {
            if (part.type === 'reasoning') {
                (part as ReasoningMessagePart).finalizeTiming();
            }
        }
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
            this._finalizeLastReasoning();
            this.content.push(part);
        }
        return this;
    }

    appendError(title: string, message: string): AssistantMessage {
        this.content.push(new ErrorMessagePart(title, message));
        return this;
    }

    clearContent(): void {
        this.content = [];
        this.usage = undefined;
        this._insideThinkTag = false;
        this._allowThinkTagParsing = true;
        this._allowImplicitThinkClose = true;
        this._thinkRoundStartPartIndex = 0;
    }

    beginCompletionRound(allowThinkTagParsing: boolean): void {
        this._insideThinkTag = false;
        this._allowThinkTagParsing = allowThinkTagParsing;
        this._allowImplicitThinkClose = allowThinkTagParsing;
        this._thinkRoundStartPartIndex = this.content.length;
    }

    /**
     * 回滚当前 completion round 中新增的所有 parts，恢复到 beginCompletionRound 时的状态。
     * 用于 LLM 请求失败重试：跨 round 已执行的 tool_call（含结果）与已完成的文本均保留，
     * 仅清除本次未完成/失败的流式输出。
     */
    rollbackToRoundStart(): void {
        if (this.content.length > this._thinkRoundStartPartIndex) {
            this.content.length = this._thinkRoundStartPartIndex;
        }
        this._insideThinkTag = false;
        this._allowThinkTagParsing = this.content.length === 0;
        this._allowImplicitThinkClose = this.content.length === 0;
    }

    appendReasoningContent(
        content: string,
        source: 'reasoning_content' | 'think_tag' = 'reasoning_content'
    ): AssistantMessage {
        this._allowThinkTagParsing = false;
        this._allowImplicitThinkClose = false;
        const last_index = this.content.length - 1;
        const last_part = this.content[last_index];
        // 仅合并当前 completion round 内的 reasoning，避免跨 round 追加到旧 part 上，
        // 否则失败重试回滚时无法清除本轮新增的思考内容。
        if (
            last_part &&
            last_part.type === 'reasoning' &&
            last_part.source === source &&
            last_index >= this._thinkRoundStartPartIndex
        ) {
            last_part.content += content;
            last_part.invalidateRender();
        } else {
            this._finalizeLastReasoning();
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
        if (!this._insideThinkTag) {
            this._finalizeLastReasoning();
        }
        if (this._insideThinkTag) {
            this._appendToReasoningRaw(text);
            this._checkAndSplitReasoningClose();
        } else {
            this._appendRawText(text);
            this._checkAndSplitTextThinkTags();
        }
        return this;
    }

    isImplicitThinkCandidatePart(index: number): boolean {
        const part = this.content[index];
        return (
            this._allowThinkTagParsing &&
            this._allowImplicitThinkClose &&
            index === this._thinkRoundStartPartIndex &&
            this.content.length === this._thinkRoundStartPartIndex + 1 &&
            part?.type === 'text'
        );
    }

    private _appendRawText(text: string): void {
        const last_index = this.content.length - 1;
        const last_part = this.content[last_index];
        // 仅当最后一个 text part 属于当前 completion round 时才追加，避免跨 round 合并。
        // 否则 LLM 请求失败回滚到 round 起点时，无法移除追加到旧 part 上的本轮文本。
        if (last_part && last_part.type === 'text' && last_index >= this._thinkRoundStartPartIndex) {
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
     * Check if the last TextMessagePart contains think tags and split it into
     * TextMessagePart / ReasoningMessagePart boundaries.
     */
    private _checkAndSplitTextThinkTags(): void {
        if (!this._allowThinkTagParsing) return;

        const last_part = this.content[this.content.length - 1];
        if (!last_part || last_part.type !== 'text') return;

        const rawOpenIdx = last_part.text.indexOf('<think>');
        const openIdx =
            rawOpenIdx !== -1 && last_part.text.substring(0, rawOpenIdx).trim().length === 0 ? rawOpenIdx : -1;
        const closeIdx = AssistantMessage._findStructuralThinkTag(last_part.text, '</think>');

        if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx) && this._canUseImplicitThinkClose(last_part)) {
            this._splitImplicitThinkClose(last_part, closeIdx);
            return;
        }

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
        this._allowImplicitThinkClose = false;

        if (afterOpen.length > 0) {
            this.content.push(new ReasoningMessagePart(afterOpen, 'think_tag'));
            this._checkAndSplitReasoningClose();
        }
    }

    private _canUseImplicitThinkClose(lastPart: TextMessagePart): boolean {
        if (!this._allowImplicitThinkClose) return false;

        return this.content.length === this._thinkRoundStartPartIndex + 1;
    }

    private static _isLiteralThinkTag(text: string, tagStart: number, tag: string): boolean {
        return (
            AssistantMessage._isWrappedByQuotes(text, tagStart, tag) ||
            AssistantMessage._isInsideQuotedSpan(text, tagStart, tag) ||
            AssistantMessage._isInsideInlineCodeSpan(text, tagStart, tag) ||
            AssistantMessage._isInsideMarkdownCodeFence(text, tagStart)
        );
    }

    private static _findStructuralThinkTag(text: string, tag: string): number {
        let index = text.indexOf(tag);
        while (index !== -1) {
            if (!AssistantMessage._isLiteralThinkTag(text, index, tag)) {
                return index;
            }
            index = text.indexOf(tag, index + tag.length);
        }
        return -1;
    }

    private static _isWrappedByQuotes(text: string, tagStart: number, tag: string): boolean {
        const quotePairs = new Map<string, string>([
            ['"', '"'],
            ["'", "'"],
            ['“', '”'],
            ['‘', '’'],
            ['「', '」'],
            ['『', '』'],
            ['《', '》'],
            ['〈', '〉'],
            ['«', '»'],
            ['‹', '›']
        ]);
        const beforeIdx = AssistantMessage._previousNonWhitespaceIndex(text, tagStart - 1);
        const afterIdx = AssistantMessage._nextNonWhitespaceIndex(text, tagStart + tag.length);
        if (beforeIdx === -1 || afterIdx === -1) return false;
        return quotePairs.get(text[beforeIdx]) === text[afterIdx];
    }

    private static _isInsideQuotedSpan(text: string, tagStart: number, tag: string): boolean {
        const quotePairs = new Map<string, string>([
            ['"', '"'],
            ["'", "'"],
            ['“', '”'],
            ['‘', '’'],
            ['「', '」'],
            ['『', '』'],
            ['《', '》'],
            ['〈', '〉'],
            ['«', '»'],
            ['‹', '›']
        ]);
        const lineStart = text.lastIndexOf('\n', tagStart - 1) + 1;
        const lineEndCandidate = text.indexOf('\n', tagStart + tag.length);
        const lineEnd = lineEndCandidate === -1 ? text.length : lineEndCandidate;
        let quoteClose: string | undefined;

        for (let i = lineStart; i < tagStart; i++) {
            const ch = text[i];
            if (quoteClose) {
                if (ch === quoteClose && AssistantMessage._isQuoteDelimiter(text, i)) {
                    quoteClose = undefined;
                }
                continue;
            }

            const close = quotePairs.get(ch);
            if (close && AssistantMessage._isQuoteDelimiter(text, i)) {
                quoteClose = close;
            }
        }

        if (!quoteClose) return false;
        for (let i = tagStart + tag.length; i < lineEnd; i++) {
            if (text[i] === quoteClose && AssistantMessage._isQuoteDelimiter(text, i)) {
                return true;
            }
        }
        return false;
    }

    private static _isInsideInlineCodeSpan(text: string, tagStart: number, tag: string): boolean {
        const lineStart = text.lastIndexOf('\n', tagStart - 1) + 1;
        const lineEndCandidate = text.indexOf('\n', tagStart + tag.length);
        const lineEnd = lineEndCandidate === -1 ? text.length : lineEndCandidate;
        const before = text.substring(lineStart, tagStart);
        const after = text.substring(tagStart + tag.length, lineEnd);
        return AssistantMessage._countUnescapedBackticks(before) % 2 === 1 && after.includes('`');
    }

    private static _isInsideMarkdownCodeFence(text: string, tagStart: number): boolean {
        const before = text.substring(0, tagStart);
        const lines = before.split('\n');
        let fenceChar: '`' | '~' | undefined;

        for (const line of lines) {
            const match = /^(\s*)(`{3,}|~{3,})/.exec(line);
            if (!match) continue;
            const marker = match[2];
            const markerChar = marker[0] as '`' | '~';
            if (!fenceChar) {
                fenceChar = markerChar;
            } else if (fenceChar === markerChar) {
                fenceChar = undefined;
            }
        }

        return fenceChar !== undefined;
    }

    private static _previousNonWhitespaceIndex(text: string, start: number): number {
        for (let i = start; i >= 0; i--) {
            if (!/\s/.test(text[i])) return i;
        }
        return -1;
    }

    private static _nextNonWhitespaceIndex(text: string, start: number): number {
        for (let i = start; i < text.length; i++) {
            if (!/\s/.test(text[i])) return i;
        }
        return -1;
    }

    private static _countUnescapedBackticks(text: string): number {
        let count = 0;
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '`' && text[i - 1] !== '\\') {
                count++;
            }
        }
        return count;
    }

    private static _isQuoteDelimiter(text: string, index: number): boolean {
        const ch = text[index];
        if (ch !== '"' && ch !== "'") return true;
        const prev = text[index - 1] ?? '';
        const next = text[index + 1] ?? '';
        return !/[A-Za-z0-9_]/.test(prev) || !/[A-Za-z0-9_]/.test(next);
    }

    private _splitImplicitThinkClose(lastPart: TextMessagePart, closeIdx: number): void {
        const beforeClose = lastPart.text.substring(0, closeIdx);
        const afterClose = lastPart.text.substring(closeIdx + '</think>'.length);

        this.content.pop();
        this._insideThinkTag = false;
        this._allowThinkTagParsing = false;
        this._allowImplicitThinkClose = false;

        if (beforeClose.trim().length > 0) {
            this.content.push(new ReasoningMessagePart(beforeClose, 'think_tag'));
        }
        this._finalizeLastReasoning();

        if (afterClose.trim().length > 0) {
            this.content.push(new TextMessagePart(afterClose));
            this._checkAndSplitTextThinkTags();
        }
    }

    /**
     * Check if the last ReasoningMessagePart contains `</think>` and split it into
     * a ReasoningMessagePart (before) and TextMessagePart (after).
     */
    private _checkAndSplitReasoningClose(): void {
        const last_part = this.content[this.content.length - 1];
        if (!last_part || last_part.type !== 'reasoning') return;
        const content = (last_part as ReasoningMessagePart).content;
        if (!content) return;

        const closeIdx = AssistantMessage._findStructuralThinkTag(content, '</think>');
        if (closeIdx === -1) return;

        const reasoningText = content.substring(0, closeIdx);
        const afterClose = content.substring(closeIdx + '</think>'.length);

        last_part.content = reasoningText;
        last_part.invalidateRender();
        this._insideThinkTag = false;
        this._allowThinkTagParsing = false;
        this._finalizeLastReasoning();

        if (afterClose.trim().length > 0) {
            this.content.push(new TextMessagePart(afterClose));
            this._checkAndSplitTextThinkTags();
        }
    }

    /**
     * Append a tool call part to the message
     */
    appendToolCallPart(part: ToolCallMessagePart): AssistantMessage {
        this._finalizeLastReasoning();
        // 某些提供商会在 tool_calls 附带空白 content。允许跨过纯空白 text 合并参数续传，
        // 但非空 text、reasoning 或 error 都是新的轮次边界，不能并入更早的 tool_call。
        let last_tool_call_part: ToolCallMessagePart | undefined = undefined;
        let last_tool_call_part_index = -1;
        for (let i = this.content.length - 1; i >= 0; i--) {
            const candidate = this.content[i];
            if (candidate?.type === 'text') {
                if (candidate.text.trim().length > 0) {
                    break;
                }
                continue;
            }
            if (candidate && candidate.type !== 'tool_call') {
                break;
            }
            if (candidate && candidate.type === 'tool_call') {
                last_tool_call_part = candidate;
                last_tool_call_part_index = i;
                break;
            }
        }
        if (last_tool_call_part) {
            // 仅合并当前 completion round 内新增的 tool_call part（索引 >= _thinkRoundStartPartIndex）。
            // 上一轮收口的 tool_call part 中的调用可能已执行（status 非 pending，带副作用），
            // 若跨 round 合并进同一 part，LLM 请求失败回滚时会连同已执行的调用一并丢失。
            if (last_tool_call_part_index >= this._thinkRoundStartPartIndex) {
                last_tool_call_part.extend(part);
            } else if (part.toolcalls.length > 0) {
                // 跨 round 边界：push 新 part 而非并入旧 part；同时跳过空 toolcall 占位 chunk，
                // 并关闭 think 标签解析，与下方无旧 part 时的分支保持一致。
                this.content.push(part);
                this._allowThinkTagParsing = false;
                this._allowImplicitThinkClose = false;
            }
        } else if (part.toolcalls.length > 0) {
            /* 如果API返回的chunk中有空的toolcall列表占位，我们需要跳过它们, 否则消息将会被割裂成许多碎片 */
            this.content.push(part);
            this._allowThinkTagParsing = false;
            this._allowImplicitThinkClose = false;
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
        if (toolcall.hasLegacyCompressId()) {
            return toolcall.getLegacyCompressedResultText();
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

    private buildOpenAIMessagesFromParts(
        parts: ReadonlyArray<AssistantMessagePart>,
        toolResultOverrides?: Map<string, string>,
        supportsVision: boolean = true
    ): object[] {
        const messages: object[] = [];

        let currentReasoning = '';
        let currentText = '';

        const processCurrentMessage = (additionalFields?: Record<string, any>) => {
            currentReasoning = currentReasoning.trim();
            currentText = currentText.trim();
            if (currentText.length === 0 && currentReasoning.length === 0 && additionalFields === undefined) {
                return;
            }
            const message: any = { role: 'assistant', ...additionalFields };
            if (currentReasoning.length > 0) {
                message.reasoning_content = currentReasoning;
            }
            message.content = currentText.length > 0 ? currentText : additionalFields ? null : '';
            currentReasoning = '';
            currentText = '';
            messages.push(message);
        };

        for (const part of parts) {
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
                    const validToolcalls: ToolCall[] = [];
                    for (const tc of part.toolcalls) {
                        const argsToCheck = tc.shouldUseLegacyCompressedArgsPlaceholder()
                            ? `{"compressed":"placeholder"}`
                            : tc.args_string || '';
                        if (!isValidToolCallArgs(argsToCheck)) {
                            const extracted = tryExtractFirstJson(tc.args_string);
                            if (extracted) {
                                logger.info(
                                    `Recovered partial JSON for tool call "${tc.tool_name}" (id=${tc.id}) in OpenAI context: ` +
                                        `extracted valid prefix from malformed args_string`
                                );
                                tc.args_string = extracted;
                                validToolcalls.push(tc);
                            } else {
                                logger.warn(
                                    `Dropping tool call "${tc.tool_name}" (id=${tc.id}) from OpenAI context: ` +
                                        `args_string is not valid JSON. Raw args: ${tc.args_string?.substring(0, 200)}`
                                );
                            }
                            continue;
                        }
                        validToolcalls.push(tc);
                    }

                    if (validToolcalls.length === 0) {
                        /* 如果当前没有有效的 toolcall，则直接处理下一个 message part 即可,
                         * 连 processCurrentMessage 都不需要调用 */
                        break;
                    }

                    const toolCallObjects = validToolcalls.map((tc) => {
                        const shouldCompressArgs = tc.shouldUseLegacyCompressedArgsPlaceholder();
                        return {
                            id: tc.id,
                            type: 'function',
                            function: {
                                name: tc.tool_name,
                                arguments: shouldCompressArgs
                                    ? tc.getLegacyCompressedArgsText()
                                    : tc.args_string || '{}'
                            }
                        };
                    });

                    processCurrentMessage({ tool_calls: toolCallObjects });
                    for (const toolcall of validToolcalls) {
                        const toolCallMsg: any = { role: 'tool', tool_call_id: toolcall.id };
                        toolCallMsg.content = AssistantMessage.buildOpenAIToolResultContent(
                            toolcall,
                            toolResultOverrides
                        );
                        messages.push(toolCallMsg);
                    }
                    if (supportsVision) {
                        const imageContent = validToolcalls.flatMap((toolcall) =>
                            toolcall.getResultImages().flatMap((image) => [
                                {
                                    type: 'text',
                                    text: `Image returned by ${toolcall.tool_name} (${toolcall.id}).`
                                },
                                {
                                    type: 'image_url',
                                    image_url: { url: image.image_url }
                                }
                            ])
                        );
                        if (imageContent.length > 0) {
                            // Chat Completions does not consistently accept image parts on role=tool.
                            // Keep all tool responses contiguous, then attach their images in one
                            // user message so OpenAI-compatible vision models receive real image input.
                            messages.push({ role: 'user', content: imageContent });
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

    toOpenAIMessages(toolResultOverrides?: Map<string, string>, supportsVision: boolean = true): object[] {
        return this.buildOpenAIMessagesFromParts(this.content, toolResultOverrides, supportsVision);
    }

    toOpenAIMessagesFromPartIndex(
        startPartIndex: number,
        toolResultOverrides?: Map<string, string>,
        supportsVision: boolean = true
    ): object[] {
        if (!Number.isInteger(startPartIndex) || startPartIndex < 0) {
            throw new Error(`invalid assistant replay startPartIndex: ${startPartIndex}`);
        }
        if (startPartIndex >= this.content.length) {
            return [];
        }
        return this.buildOpenAIMessagesFromParts(
            this.content.slice(startPartIndex),
            toolResultOverrides,
            supportsVision
        );
    }

    toOpenAIMessagesFromRound(
        roundRef: { assistantMessageId: string; startPartIndex: number },
        toolResultOverrides?: Map<string, string>,
        supportsVision: boolean = true
    ): object[] {
        if (roundRef.assistantMessageId !== this.message_id) {
            throw new Error(
                `assistant replay roundRef message mismatch: expected ${this.message_id}, got ${roundRef.assistantMessageId}`
            );
        }
        return this.toOpenAIMessagesFromPartIndex(roundRef.startPartIndex, toolResultOverrides, supportsVision);
    }

    getOpenAIToolMessages(toolResultOverrides?: Map<string, string>): object[] {
        const messages: object[] = [];
        const tool_call_parts = this.content.filter((part) => part.type === 'tool_call');
        for (const part of tool_call_parts) {
            for (const toolcall of part.toolcalls) {
                if (!isValidToolCallArgs(toolcall.args_string)) {
                    const extracted = tryExtractFirstJson(toolcall.args_string);
                    if (extracted) {
                        toolcall.args_string = extracted;
                    } else {
                        logger.warn(
                            `Skipping tool response for "${toolcall.tool_name}" (id=${toolcall.id}): ` +
                                `original tool call had invalid JSON args`
                        );
                        continue;
                    }
                }
                const overrideContent = AssistantMessage.resolveToolCallOverrideContent(toolcall, toolResultOverrides);
                if (
                    !toolcall.hasLegacyCompressId() &&
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

        // 兼容不同 API 提供商的思考内容字段：优先 reasoning_content，其次 reasoning
        const reasoning_content = openai_message['reasoning_content'] ?? openai_message['reasoning'];
        if (reasoning_content) {
            message.content.push(new ReasoningMessagePart(reasoning_content, 'reasoning_content'));
        }

        const content = openai_message['content'];
        if (content) {
            // 不在临时消息上调用 appendText（它会在临时消息内解析 <think> 标签并消费状态，
            // 但 _insideThinkTag 状态不会传递到主消息）。
            // 直接创建 TextMessagePart，让 mergeChunk -> appendPart -> appendText
            // 在主消息上完成 <think> 标签的解析，确保状态一致性。
            message.content.push(new TextMessagePart(content));
        }
        const tool_calls = openai_message['tool_calls'];
        if (tool_calls) {
            const part = new ToolCallMessagePart();
            for (const tool_call of tool_calls) {
                const args = tool_call['function']['arguments'];
                // Some providers return the literal string "null" instead of JSON null
                const args_string = args === 'null' ? '' : (args ?? '');
                const tc = new ToolCall(
                    tool_call['index'],
                    tool_call['id'],
                    tool_call['function']['name'],
                    args_string
                );
                part.push(tc);
            }
            message.content.push(part);
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
            response.usage = Usage.fromRaw(usage);
        }
        return response;
    }
}

/**
 * 上下文压缩分隔消息。
 * 消息历史中最多出现一次，其前面的消息在构建 OpenAI 上下文时会被跳过，
 * 由 summary 字段中的结构化快照替代。
 */
export const COMPACT_SUMMARY_VERSION = 1;

export class CompactSeparatorMessage implements BaseCompactSeparatorMessage {
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

        if (metadata?.strategy === 'tail_preserving_full_compact' || metadata?.strategy === 'session_memory_compact') {
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

        if (typeof metadata?.kept_anchor_message_id === 'string' && metadata.kept_anchor_message_id.trim().length > 0) {
            normalized.kept_anchor_message_id = metadata.kept_anchor_message_id;
        }

        if (
            typeof metadata?.kept_anchor_message_index === 'number' &&
            Number.isInteger(metadata.kept_anchor_message_index) &&
            metadata.kept_anchor_message_index >= 0
        ) {
            normalized.kept_anchor_message_index = metadata.kept_anchor_message_index;
        }

        if (
            typeof metadata?.kept_anchor_round_index === 'number' &&
            Number.isInteger(metadata.kept_anchor_round_index) &&
            metadata.kept_anchor_round_index >= 0
        ) {
            normalized.kept_anchor_round_index = metadata.kept_anchor_round_index;
        }

        if (
            typeof metadata?.kept_anchor_start_part_index === 'number' &&
            Number.isInteger(metadata.kept_anchor_start_part_index) &&
            metadata.kept_anchor_start_part_index >= 0
        ) {
            normalized.kept_anchor_start_part_index = metadata.kept_anchor_start_part_index;
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
                      summarized_messages: obj.summarized_messages,
                      kept_anchor_message_id: obj.kept_anchor_message_id,
                      kept_anchor_message_index: obj.kept_anchor_message_index,
                      kept_anchor_round_index: obj.kept_anchor_round_index,
                      kept_anchor_start_part_index: obj.kept_anchor_start_part_index
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
    private messageAppendListeners: ((message: ChatMessage) => void)[] = [];

    /**
     * Attach multiple toolsets to the chat context
     */
    attachToolsets(...toolsets: BaseToolset[]) {
        for (const toolset of toolsets) {
            this.toolsets.set(toolset.name, toolset);
        }
    }

    getTool(name: string): BaseTool<any> | undefined {
        if (!name) {
            return undefined;
        }

        const tools = this.getTools();

        // 1. 精确匹配
        const exactMatch = tools.get(name);
        if (exactMatch) return exactMatch;

        // 2. 自动纠错：模型输出等号替代横线（如 filemgr=readFile → filemgr-readFile）
        if (name.includes('=')) {
            const corrected = name.replace(/=/g, '-');
            const correctedMatch = tools.get(corrected);
            if (correctedMatch) {
                logger.warn(`工具名称自动纠错(等号→横线): "${name}" -> "${corrected}"`);
                return correctedMatch;
            }
        }

        // 3. 自动纠错：模型漏掉包名，只输出了工具名（如 readFile → filemgr-readFile）
        if (!name.includes('-') && !name.includes('=')) {
            let candidate: BaseTool<any> | undefined;
            let candidateFullName: string = '';
            for (const [key, tool] of tools) {
                if (tool.name === name) {
                    if (candidate) {
                        // 多个工具同名，不唯一，放弃纠错
                        logger.warn(`工具名称 "${name}" 匹配到多个工具 (${candidateFullName}, ${key})，无法自动纠错`);
                        return undefined;
                    }
                    candidate = tool;
                    candidateFullName = key;
                }
            }
            if (candidate) {
                logger.warn(`工具名称自动纠错(补全包名): "${name}" -> "${candidateFullName}"`);
                return candidate;
            }
        }

        // 4. 自动纠错：模型输出的完整名与某个工具仅相差 1 个字母（如 filemtr-readFile → filemgr-ReadFile）
        //    先归一化等号，再按大小写不敏感比较编辑距离，避免把大小写差异也计入误差。
        const normalizedName = name.replace(/=/g, '-');
        const loweredName = normalizedName.toLowerCase();
        let fuzzyCandidate: BaseTool<any> | undefined;
        let fuzzyCandidateFullName = '';
        for (const [key, tool] of tools) {
            // 长度差超过 1，编辑距离必然大于 1，跳过以节省计算
            if (Math.abs(key.length - loweredName.length) > 1) {
                continue;
            }
            const dist = levenshteinDistance(loweredName, key.toLowerCase());
            if (dist <= 1) {
                if (fuzzyCandidate) {
                    // 多个工具都满足误差，不唯一，放弃纠错
                    logger.warn(
                        `工具名称 "${name}" 与多个工具误差在 1 个字母以内 (${fuzzyCandidateFullName}, ${key})，无法自动纠错`
                    );
                    return undefined;
                }
                fuzzyCandidate = tool;
                fuzzyCandidateFullName = key;
            }
        }
        if (fuzzyCandidate) {
            logger.warn(`工具名称自动纠错(近拼写容错): "${name}" -> "${fuzzyCandidateFullName}"`);
            return fuzzyCandidate;
        }

        return undefined;
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

    toJSON(): ChatContextSnapshot {
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
        for (const listener of this.messageAppendListeners) {
            try {
                listener(message);
            } catch (err) {
                logger.warn(`chat context append listener failed: ${err}`);
            }
        }
    }

    onMessageAppend(listener: (message: ChatMessage) => void): () => void {
        this.messageAppendListeners.push(listener);
        return () => {
            this.messageAppendListeners = this.messageAppendListeners.filter((item) => item !== listener);
        };
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

    /** 移除所有 compact boundary */
    clearCompactBoundaries(): void {
        this.messages = this.messages.filter((message) => !isCompactBoundaryMessage(message));
    }

    /** 移除已有的 compact boundary 并在指定位置插入新的 boundary */
    replaceCompactBoundary(boundary: CompactSeparatorMessage, position: number): void {
        this.clearCompactBoundaries();
        this.messages.splice(position, 0, boundary);
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
