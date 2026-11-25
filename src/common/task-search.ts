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

export interface TaskSearchHit {
    taskId: string;
    title: string;
    workspace: string;
    messageId?: string;
    snippet: string;
    priority: number;
}
export interface TaskSearchResponse {
    items: TaskSearchHit[];
    hasMore: boolean;
    indexing: boolean;
    failedTasks: number;
}
export const TASK_SEARCH_MAX_QUERY = 200;
export const TASK_SEARCH_PAGE_SIZE = 20;
export const TASK_SEARCH_MAX_RESULTS = 200;
export const TASK_SEARCH_MAX_WILDCARD_GAP = 80;

export function compactSearchText(text: string, preserveLines = false): string {
    return preserveLines
        ? text.replace(/\s+/gu, (space) => (/[\r\n\u2028\u2029]/u.test(space) ? '\n' : ' ')).trim()
        : text.replace(/\s+/gu, ' ').trim();
}

export function normalizeSearchText(text: string, preserveLines = false): string {
    return compactSearchText(text, preserveLines).toLowerCase();
}

function escapeRegex(text: string): string {
    return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function findPart(part: string | RegExp, text: string, from: number): [start: number, end: number] | undefined {
    if (typeof part === 'string') {
        const start = text.indexOf(part, from);
        return start < 0 ? undefined : [start, start + part.length];
    }
    part.lastIndex = from;
    const match = part.exec(text);
    return match ? [match.index, part.lastIndex] : undefined;
}

export function compileTaskSearch(rawQuery: string) {
    const query = normalizeSearchText(rawQuery).slice(0, TASK_SEARCH_MAX_QUERY);
    const parts: (string | RegExp)[] = [];
    let textPart = '';
    let regexPart = '';
    let anchor = '';
    let hasWildcard = false;
    let fixedLength = 0;
    const finishPart = () => {
        if (regexPart) parts.push(new RegExp(regexPart + escapeRegex(textPart), 'gu'));
        else if (textPart) parts.push(textPart);
        textPart = '';
        regexPart = '';
    };

    // Only * and ? consume an escape, so ordinary backslashes in paths are literal.
    for (const token of query.match(/\\[*?]|[*?]|[^\\*?]+|\\/gu) ?? []) {
        if (token !== '*' && token !== '?') {
            const text = token === '\\*' || token === '\\?' ? token[1] : token;
            textPart += text;
            fixedLength += Array.from(text).length;
            continue;
        }
        hasWildcard = true;
        if (textPart.length > anchor.length) anchor = textPart;
        if (token === '*') {
            finishPart();
        } else {
            regexPart += escapeRegex(textPart) + '.';
            textPart = '';
            fixedLength++;
        }
    }
    if (textPart.length > anchor.length) anchor = textPart;
    const literal = hasWildcard ? undefined : textPart;
    finishPart();

    const find = (text: string, from = 0): [start: number, end: number] | undefined => {
        if (!parts.length) return;
        if (parts.length === 1) return findPart(parts[0], text, from);
        let best: [number, number] | undefined;
        let bestLength = fixedLength + TASK_SEARCH_MAX_WILDCARD_GAP + 1;
        let offset = 0;
        for (const line of text.split('\n')) {
            let first = findPart(parts[0], line, Math.max(0, from - offset));
            while (first) {
                const [start, firstEnd] = first;
                // At most two UTF-16 units per character. Search only inside the longest span that can win.
                const candidate = line.slice(start, start + 2 * (bestLength - 1));
                let end = firstEnd - start;
                // The earliest end of each fixed-length part gives the shortest span for this start.
                for (let i = 1; i < parts.length && end; i++) {
                    end = findPart(parts[i], candidate, end)?.[1] ?? 0;
                }
                if (end) {
                    const length = Array.from(candidate.slice(0, end)).length;
                    if (length < bestLength) {
                        bestLength = length;
                        best = [offset + start, offset + start + end];
                        if (length === fixedLength) return best;
                    }
                }
                const step = line.codePointAt(start)! > 0xffff ? 2 : 1;
                first = findPart(parts[0], line, start + step);
            }
            offset += line.length + 1;
        }
        return best;
    };
    return { query: parts.length ? query : '', literal, anchor, find };
}
