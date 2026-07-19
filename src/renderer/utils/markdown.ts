/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { Marked, Renderer, type Tokens } from 'marked';
import { escapeHtml } from '../../common/utils/escape.js';

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
