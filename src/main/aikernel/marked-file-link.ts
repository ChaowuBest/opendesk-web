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

import path from 'path';
import { escapeHtml } from '../../common/utils/escape.js';
import type { MarkedExtension, Tokens } from 'marked';

// ── Workspace context ──────────────────────────────────────────────

let _renderWorkspace: string | null = null;

export function setRenderWorkspace(ws: string | null): void {
    _renderWorkspace = ws;
}

export function getRenderWorkspace(): string | null {
    return _renderWorkspace;
}

// ── File path resolution ───────────────────────────────────────────

// URL scheme 至少 2 个字符（ws:、https:），单字母盘符（C:）不属于 scheme。
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

/**
 * 将候选路径解析为绝对路径（相对路径基于当前渲染 workspace）。
 * 仅做纯字符串处理，不做文件存在性检查 —— 渲染路径必须零 IO，
 * "看似路径实则不存在"的误报由前端点击时验证并提示。
 */
export function resolveFilePath(rawPath: string): string | null {
    if (!rawPath || URL_SCHEME_RE.test(rawPath) || rawPath.startsWith('#')) {
        return null;
    }

    // 含省略号（…）的是缩写展示路径（如 `…\agent.ts`、`src/…/utils.ts`）：
    // 模型在正文中常用它指代过长路径，永远无法真实打开，不能渲染为 pill。
    if (rawPath.includes('…')) {
        return null;
    }

    if (path.isAbsolute(rawPath)) {
        return rawPath;
    }
    if (_renderWorkspace) {
        return path.resolve(_renderWorkspace, rawPath);
    }
    return path.resolve(rawPath);
}

// ── Regex for file path detection ──────────────────────────────────

// Characters that should not appear inside a file path token
const EXCLUDED = '\\s`|"\'<>()\\[\\]{};:,!?\\\\';

// Match a potential file path at the start of src:
// - Must contain at least one '/'
// - Must end with a file extension (.ext)
// - Negative lookahead to skip URL schemes (https://, ftp://, etc.)
const FILE_PATH_RE = new RegExp(`^(?![a-z][a-z0-9+.-]*://)[^${EXCLUDED}]+/[^${EXCLUDED}]*\\.[A-Za-z0-9]+`, 'i');

// Search pattern for start() – finds the first potential file path anywhere in src
const FILE_PATH_SEARCH_RE = new RegExp(`[^${EXCLUDED}]+/[^${EXCLUDED}]*\\.[A-Za-z0-9]`);

// 首词呈"多段点分"样式（如 example.com）的 token 视为域名残留
// （浏览器自动化结果中大量 URL 去协议后形似路径），不渲染为 pill。
const DOMAIN_LIKE_RE = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+$/i;

function isDomainLikePath(candidate: string): boolean {
    if (path.isAbsolute(candidate)) return false;
    const wordBeforeFirstSlash = candidate.split('/')[0].split(' ').pop() ?? '';
    return DOMAIN_LIKE_RE.test(wordBeforeFirstSlash);
}

// ── Pill HTML ──────────────────────────────────────────────────────

const SKILL_SCHEME = 'opendesk-skill:';

const SKILL_ICON_SVG =
    '<svg class="od-skill-pill-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0-1.3-1.3L12 3Z"/><path d="M5 3v4M19 17v4M3 5h4M17 19h4"/></svg>';

function buildSkillPillHTML(bundleName: string, skillName: string, label: string): string {
    return `<button type="button" class="od-skill-pill" data-skill-bundle="${escapeHtml(bundleName)}" data-skill-name="${escapeHtml(skillName)}">${SKILL_ICON_SVG}<span class="od-skill-pill-name">${escapeHtml(label)}</span></button>`;
}

const FILE_ICON_SVG =
    '<svg class="od-file-pill-icon" width="13" height="13" viewBox="0 0 16 16" fill="none">' +
    '<path d="M4 1.5h5.5L13 5v9a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<path d="M9 1.5V5h4" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
    '</svg>';

const TYPE_MAP: Record<string, string> = {
    // 代码类
    ts: 'code',
    tsx: 'code',
    js: 'code',
    jsx: 'code',
    mjs: 'code',
    cjs: 'code',
    css: 'code',
    scss: 'code',
    sass: 'code',
    less: 'code',
    go: 'code',
    rs: 'code',
    py: 'code',
    rb: 'code',
    java: 'code',
    kt: 'code',
    swift: 'code',
    c: 'code',
    h: 'code',
    cpp: 'code',
    hpp: 'code',
    cs: 'code',
    php: 'code',
    vue: 'code',
    svelte: 'code',
    sh: 'code',
    bash: 'code',
    // 文档类
    doc: 'doc',
    docx: 'doc',
    ppt: 'doc',
    pptx: 'doc',
    xls: 'doc',
    xlsx: 'doc',
    pdf: 'doc',
    key: 'doc',
    numbers: 'doc',
    pages: 'doc',
    // 文本/数据类
    md: 'text',
    markdown: 'text',
    txt: 'text',
    rtf: 'text',
    json: 'text',
    jsonc: 'text',
    xml: 'text',
    yaml: 'text',
    yml: 'text',
    toml: 'text',
    csv: 'text',
    ini: 'text',
    conf: 'text',
    log: 'text'
};

function getFileType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase().slice(1);
    return TYPE_MAP[ext] ?? 'default';
}

function buildPillHTML(
    filePath: string,
    label: string,
    line: number | null = null,
    lineEnd: number | null = null
): string {
    const lineAttr = line != null && line > 0 ? ` data-preview-line="${line}"` : '';
    let lineSpan = '';
    if (line != null && line > 0) {
        // 区间必须递增：锚点解析已校验，但 label 补全出的结束行（如 [f.ts:12-5](p#L12)）可能不合法，回退为单行
        const rangeText = lineEnd != null && lineEnd > line ? `-${lineEnd}` : '';
        lineSpan = `<span class="od-file-pill-line">:${line}${rangeText}</span>`;
    }
    return (
        `<a class="od-file-pill" data-type="${getFileType(filePath)}" data-open-preview="${escapeHtml(filePath)}"${lineAttr} title="${escapeHtml(filePath)}">` +
        `${FILE_ICON_SVG}<span class="od-file-pill-name">${escapeHtml(label)}</span>${lineSpan}</a>`
    );
}

// ── File path + line reference parsing ───────────────────────────────

// 匹配文件路径末尾的行号引用，如 "/path/to/file.ts:134" 或 "/path/to/file.ts:12:8"
// 使用非贪婪匹配，避免 "file.ts:12:8" 中贪婪 (.+) 把 ":12" 误并入文件路径
const FILE_LINE_REF_RE = /^(.+?):(\d+)(?::(\d+))?$/;

/**
 * 解析可能携带行号（及可选列号）的文件引用。
 * 若末尾为 ":<line>" 或 ":<line>:<column>" 则剥离，否则原样返回。
 */
export function parseFileReference(rawPath: string): { filePath: string; line: number | null } {
    const match = FILE_LINE_REF_RE.exec(rawPath);
    if (match) {
        const line = parseInt(match[2], 10);
        if (line > 0) {
            return { filePath: match[1], line };
        }
    }
    return { filePath: rawPath, line: null };
}

// 匹配 href 末尾的 "#L<line>" 或 "#L<start>-<end>" 行锚点（结束行可带第二个 L，
// 兼容 GitHub 风格 #L12-L20）。仅用于 Markdown 链接 href；纯文本与 codespan
// 路径仍沿用 ":行号" 后缀约定。
const LINE_ANCHOR_RE = /#L(\d+)(?:-L?(\d+))?$/;

/**
 * 解析 Markdown 链接 href 末尾的 "#L" 行锚点。
 * 无锚点、锚点非行号或行号非法时返回 null，由调用方回退到 parseFileReference。
 */
export function parseLineAnchor(rawHref: string): { filePath: string; line: number; lineEnd: number | null } | null {
    const match = LINE_ANCHOR_RE.exec(rawHref);
    if (!match) {
        return null;
    }
    const line = parseInt(match[1], 10);
    if (line <= 0) {
        return null;
    }
    let lineEnd = match[2] ? parseInt(match[2], 10) : null;
    if (lineEnd != null && lineEnd <= line) {
        lineEnd = null;
    }
    return { filePath: rawHref.slice(0, match.index), line, lineEnd };
}

/**
 * 纯文本判定：文本是否"形似单个文件路径"。
 * 用于整段文本场景（codespan、围栏代码块）的初筛：剥离行号后必须以
 * 扩展名结尾、不含换行；含空格但无分隔符的词组（如 `npm install`）不算。
 */
function looksLikeFilePath(text: string): boolean {
    if (/[\r\n]/.test(text)) return false;
    const { filePath } = parseFileReference(text.trim());
    if (!/\.[A-Za-z0-9]+$/.test(filePath)) return false;
    if (filePath.includes(' ') && !filePath.includes('/') && !filePath.includes('\\')) {
        return false;
    }
    return true;
}

/**
 * 将整段文本尝试解析为单个文件引用并渲染成文件 pill。
 * 仅当 trim 后形似文件路径（可带行号）时返回 pill HTML，否则返回 null。
 * 供围栏代码块等 block 场景复用：整块内容就是一个文件地址时转成可点击的 pill。
 */
export function renderFilePillFromText(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed || !looksLikeFilePath(trimmed)) return null;
    const { filePath, line } = parseFileReference(trimmed);
    const absPath = resolveFilePath(filePath);
    if (!absPath) return null;
    return buildPillHTML(absPath, path.basename(absPath), line);
}

// ── Marked extension ───────────────────────────────────────────────

/**
 * Marked extension that:
 * 1. Auto-detects file-path-like text and converts it to clickable pills
 * 2. Renders markdown links pointing to path-like hrefs as pills
 * 3. Renders inline code spans (backticks) whose content is path-like as pills
 *
 * 渲染阶段只做纯文本初筛，不校验文件存在性（渲染必须零 IO）。
 * 误报（文本形似路径但文件不存在）由前端点击时校验并以模态提示。
 * Requires `setRenderWorkspace()` to be called before parsing for relative path resolution.
 */
export const fileLinkExtension: MarkedExtension = {
    extensions: [
        {
            name: 'fileLink',
            level: 'inline',
            start(src: string): number | undefined {
                const match = src.match(FILE_PATH_SEARCH_RE);
                if (!match) return undefined;
                // 域名样式 token（如 example.com/a/b.html）不作为 pill 起点
                if (isDomainLikePath(match[0])) {
                    return match.index! + match[0].length;
                }
                return match.index;
            },
            tokenizer(src: string) {
                const match = FILE_PATH_RE.exec(src);
                if (!match) return undefined;

                const raw = match[0];
                if (isDomainLikePath(raw)) return undefined;

                // 文件路径后紧跟行号引用（如 file.ts:134）时一并纳入 token，
                // 避免行号作为普通文本残留导致跳转信息丢失。
                let text = raw;
                let line: number | null = null;
                const rest = src.slice(raw.length);
                const lineMatch = /^:(\d+)/.exec(rest);
                if (lineMatch) {
                    const parsed = parseInt(lineMatch[1], 10);
                    if (parsed > 0) {
                        text = raw + lineMatch[0];
                        line = parsed;
                    }
                }

                const absPath = resolveFilePath(raw);
                if (!absPath) return undefined;
                return {
                    type: 'fileLink',
                    raw: text,
                    text,
                    filePath: absPath,
                    line,
                    tokens: []
                };
            },
            renderer(token) {
                const { filePath, line } = token as { filePath: string; line: number | null };
                return buildPillHTML(filePath, path.basename(filePath), line);
            }
        }
    ],
    renderer: {
        link(
            this: { parser: { parseInline: (tokens: unknown[]) => string } },
            { href, tokens }: Tokens.Link
        ): string | false {
            if (href.startsWith(SKILL_SCHEME)) {
                const reference = href.slice(SKILL_SCHEME.length).split('/');
                if (reference.length === 2 && reference[0] && reference[1]) {
                    return buildSkillPillHTML(
                        reference[0],
                        reference[1],
                        this.parser.parseInline(tokens) || reference[1]
                    );
                }
            }
            // Markdown link hrefs may be URL-encoded (e.g. %20 for space)
            let decodedHref = href;
            try {
                decodedHref = decodeURIComponent(href);
            } catch {
                // ignore malformed URI – use raw href
            }
            // "#L行号" 行锚点优先；无锚点时回退到旧版 ":行号" 后缀
            const anchor = parseLineAnchor(decodedHref);
            const { filePath, line } = anchor ?? parseFileReference(decodedHref);
            let lineEnd = anchor ? anchor.lineEnd : null;
            const absPath = resolveFilePath(filePath);
            if (absPath) {
                let label = this.parser.parseInline(tokens);
                if (line != null) {
                    // 链接文字常写成 "file.ts:12-20" 形式：锚点未带结束行时用文字
                    // 中的区间补全（如 [file.ts:1-11](path#L1)），再剥掉与行号 badge
                    // 重复的后缀
                    if (anchor && lineEnd == null) {
                        const labelRange = new RegExp(`:${line}-(\\d+)$`).exec(label);
                        if (labelRange) {
                            lineEnd = parseInt(labelRange[1], 10);
                        }
                    }
                    label = label.replace(new RegExp(`:${line}(?:-\\d+)?$`), '');
                }
                return buildPillHTML(absPath, label || path.basename(absPath), line, lineEnd);
            }
            return false;
        },
        codespan({ text }: Tokens.Codespan): string | false {
            if (!looksLikeFilePath(text)) return false;
            const { filePath, line } = parseFileReference(text);
            const absPath = resolveFilePath(filePath);
            if (absPath) {
                return buildPillHTML(absPath, path.basename(absPath), line);
            }
            return false;
        }
    }
};
