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

import { Marked, Renderer, type Tokens } from 'marked';
import markedKatex from 'marked-katex-extension';
import { renderCodeBlockHtml } from '../../common/markdown/code-block-render.js';
import { escapeHtml } from '../../common/utils/escape.js';
import { cjkAutolinkFix } from '../../common/markdown/cjk-autolink-fix.js';
import { doubleTildeStrikethrough } from '../../common/markdown/double-tilde-strikethrough.js';

/** 前端预览和搜索共用的 DOM 标识，避免两处各写一份 class 名后发生偏差。 */
export const MARKDOWN_DOM = {
    codeBlock: 'code-block-wrapper',
    codeHeader: 'code-block-header',
    codeBody: 'code-block-body',
    codeLine: 'code-line',
    preview: 'code-preview-container',
    previewHost: 'code-preview-shadow-host',
    previewToggle: 'code-preview-toggle-input',
    mermaid: 'mermaid-block',
    mermaidHeader: 'mermaid-block-header',
    mermaidSource: 'mermaid-source',
    mermaidFallback: 'mermaid-fallback',
    mermaidPreview: 'mermaid-rendered'
} as const;

export const PREVIEWABLE_CODE_LANGUAGES: ReadonlySet<string> = new Set(['html', 'htm', 'svg']);
// 预览准备完成或切换显示模式后，通知搜索重新读取显示文字。
export const PREVIEW_CONTENT_CHANGED = 'opendesk-preview-content-changed';
// 只允许搜索遍历此标记的惰性模板；普通 template 不作为显示内容读取。
export const SEARCH_PREVIEW_TEMPLATE = 'data-preview-search-projection';

/** 检查 Markdown 代码围栏是否闭合，防止流式输出未完成时反复尝试渲染 Mermaid。 */
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

const renderer = new Renderer();

renderer.html = (token) => {
    const raw = typeof token === 'string' ? token : (token?.raw ?? token?.text ?? '');
    return escapeHtml(raw);
};

renderer.link = function ({ href, title, tokens }: Tokens.Link): string {
    const label = this.parser.parseInline(tokens);
    const safeHref = safeMarkdownUrl(href, false);
    if (!safeHref) return label;
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer"${titleAttribute}>${label}</a>`;
};

renderer.image = function ({ href, title, text }: Tokens.Image): string {
    const safeHref = safeMarkdownUrl(href, true);
    if (!safeHref) return escapeHtml(text);
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}" loading="lazy"${titleAttribute}>`;
};

// 前端兜底渲染保持与已保存消息一致的代码块结构，供流式显示和历史搜索准备预览。
renderer.code = ({ text, lang, raw }: Tokens.Code): string => {
    if (lang?.toLowerCase() === 'mermaid') {
        // 保存 UTF-8 源码的 Base64，后续由预览模块解码成图形；浏览器端不依赖 Node Buffer。
        const bytes = new TextEncoder().encode(text);
        const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
        const complete = isFencedCodeComplete(raw);
        return `<div class="${MARKDOWN_DOM.mermaid}" data-mermaid-code="${encoded}" data-mermaid-complete="${complete}"></div>`;
    }
    return renderCodeBlockHtml(escapeHtml(text), {
        lang,
        withHeader: true,
        preview: { langs: PREVIEWABLE_CODE_LANGUAGES, rawCode: text }
    });
};

const safeMarked = new Marked({ renderer, gfm: true, breaks: true });
safeMarked.use(cjkAutolinkFix);
safeMarked.use(doubleTildeStrikethrough);
// 流式期间的兜底渲染也要能出公式（issue #332）：配置与主进程 messages.ts 一致
safeMarked.use(
    markedKatex({
        throwOnError: false,
        displayMode: true,
        nonStandard: true
    })
);

function safeMarkdownUrl(value: string, image: boolean): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!image && trimmed.startsWith('#')) return trimmed;
    try {
        const url = new URL(trimmed);
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
        if (!image && url.protocol === 'mailto:') return url.href;
    } catch {
        return null;
    }
    return null;
}

export function renderSafeMarkdown(markdown: string): string {
    return safeMarked.parse(markdown, { async: false }) as string;
}
