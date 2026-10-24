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
import { escapeHtml } from '../../common/utils/escape.js';
import { cjkAutolinkFix } from '../../common/markdown/cjk-autolink-fix.js';
import { doubleTildeStrikethrough } from '../../common/markdown/double-tilde-strikethrough.js';

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
