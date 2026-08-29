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

import { getSafeWebUrl } from '../../common/web-link.js';

const WEB_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
const CJK_PUNCTUATION_PATTERN = /[\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/u;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?]+$/u;
const SKIPPED_TAGS = new Set(['A', 'BUTTON', 'CODE', 'INPUT', 'OPTION', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);

interface WebUrlMatch {
    index: number;
    raw: string;
    url: string;
}

function trimUnmatchedClosingCharacters(value: string): string {
    let trimmed = value;
    for (const [opening, closing] of [
        ['(', ')'],
        ['[', ']'],
        ['{', '}']
    ]) {
        while (trimmed.endsWith(closing)) {
            const openingCount = trimmed.split(opening).length - 1;
            const closingCount = trimmed.split(closing).length - 1;
            if (closingCount <= openingCount) break;
            trimmed = trimmed.slice(0, -1);
        }
    }
    return trimmed;
}

function normalizeCandidate(raw: string): string | undefined {
    const cjkPunctuationIndex = raw.search(CJK_PUNCTUATION_PATTERN);
    let candidate = cjkPunctuationIndex >= 0 ? raw.slice(0, cjkPunctuationIndex) : raw;
    candidate = candidate.replace(TRAILING_PUNCTUATION_PATTERN, '');
    candidate = trimUnmatchedClosingCharacters(candidate);
    return getSafeWebUrl(candidate);
}

function findWebUrls(text: string): WebUrlMatch[] {
    const matches: WebUrlMatch[] = [];
    WEB_URL_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(WEB_URL_PATTERN)) {
        const raw = match[0];
        const url = normalizeCandidate(raw);
        if (!url || match.index === undefined) continue;
        matches.push({ index: match.index, raw, url });
    }
    return matches;
}

function collectEligibleTextNodes(root: Node, textNodes: Text[]): void {
    if (root.nodeType === 3) {
        textNodes.push(root as Text);
        return;
    }
    if (root.nodeType === 1 && SKIPPED_TAGS.has((root as Element).tagName)) return;
    for (const child of Array.from(root.childNodes)) {
        collectEligibleTextNodes(child, textNodes);
    }
}

function linkifyTextNode(textNode: Text): void {
    const text = textNode.data;
    const matches = findWebUrls(text);
    if (matches.length === 0 || !textNode.parentNode) return;

    const document = textNode.ownerDocument;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
        if (match.index > cursor) fragment.append(document.createTextNode(text.slice(cursor, match.index)));

        const link = document.createElement('a');
        link.className = 'od-web-output-link';
        link.href = match.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = match.url;
        fragment.append(link);

        const matchedUrlEnd = match.index + match.url.length;
        const rawEnd = match.index + match.raw.length;
        if (matchedUrlEnd < rawEnd) {
            fragment.append(document.createTextNode(text.slice(matchedUrlEnd, rawEnd)));
        }
        cursor = rawEnd;
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    textNode.parentNode.replaceChild(fragment, textNode);
}

/** Converts plain HTTP(S) URLs in rendered output into safe external links. */
export function enhanceWebLinks(root: Node): void {
    const textNodes: Text[] = [];
    collectEligibleTextNodes(root, textNodes);
    for (const textNode of textNodes) linkifyTextNode(textNode);
}
