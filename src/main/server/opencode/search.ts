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

/**
 * opencode GET /find 与 GET /find/file 的实现。
 * 结果形状与 opencode 一致（ripgrep JSON 的 match 结构、相对路径、目录以 / 结尾），
 * 遍历复用 filemgr 的 walkFiles 与 .gitignore 规则，与 OpenDesk 自己的 grep/glob 工具看到的文件集合相同。
 */

import fs from 'fs';
import path from 'path';
import type { FindFilesResponse, FindTextResponse } from '@opencode-ai/sdk/v2/types';
import { collectGitignorePatterns, hasNestedUnboundedQuantifier, walkFiles } from '../../applications/filemgr/tools.js';

/** 与 opencode 一致：/find 最多返回 10 条匹配，/find/file 默认 10 条 */
export const FIND_TEXT_LIMIT = 10;
export const FIND_FILE_DEFAULT_LIMIT = 10;
export const FIND_FILE_MAX_LIMIT = 200;

const FIND_TIME_BUDGET_MS = 3000;
const FIND_MAX_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const LINE_TEXT_MAX_CHARS = 2000;
const MAX_SUBMATCHES = 100;

export class InvalidSearchPatternError extends Error {}

type TextMatch = FindTextResponse[number];

/** 在工作空间内按正则搜索文本，语义对齐 opencode 的 ripgrep 调用（含隐藏文件、遵循 .gitignore、区分大小写） */
export async function findText(directory: string, pattern: string, limit = FIND_TEXT_LIMIT): Promise<FindTextResponse> {
    const regex = compileSearchPattern(pattern);
    const startedAt = Date.now();
    const matches: TextMatch[] = [];
    const ignorePatterns = await collectGitignorePatterns(directory);
    for await (const filePath of walkFiles(directory, {
        filePattern: '**/*',
        dot: true,
        ignorePatterns,
        timeBudgetMs: FIND_TIME_BUDGET_MS,
        startedAt
    })) {
        const content = await readSearchableText(filePath);
        if (content === undefined) continue;
        const relativePath = toRelativePath(directory, filePath);
        let lineStart = 0;
        let lineNumber = 0;
        while (lineStart < content.length && matches.length < limit) {
            const newline = content.indexOf('\n', lineStart);
            const lineEnd = newline === -1 ? content.length : newline + 1;
            const line = content.slice(lineStart, lineEnd);
            lineNumber++;
            const submatches = collectSubmatches(regex, line.replace(/\r?\n$/, ''));
            if (submatches.length > 0) {
                matches.push({
                    path: { text: relativePath },
                    lines: { text: truncateLine(line) },
                    line_number: lineNumber,
                    absolute_offset: Buffer.byteLength(content.slice(0, lineStart)),
                    submatches
                });
            }
            lineStart = lineEnd;
        }
        if (matches.length >= limit || Date.now() - startedAt > FIND_TIME_BUDGET_MS) break;
    }
    return matches satisfies FindTextResponse;
}

function compileSearchPattern(pattern: string): RegExp {
    if (!pattern) throw new InvalidSearchPatternError('pattern is required');
    if (hasNestedUnboundedQuantifier(pattern)) {
        throw new InvalidSearchPatternError('pattern contains nested unbounded quantifiers');
    }
    try {
        return new RegExp(pattern, 'gu');
    } catch {
        try {
            return new RegExp(pattern, 'g');
        } catch (error) {
            throw new InvalidSearchPatternError(error instanceof Error ? error.message : String(error));
        }
    }
}

/** 跳过过大与二进制文件，其余按 UTF-8 读取（与 ripgrep 默认行为一致） */
async function readSearchableText(filePath: string): Promise<string | undefined> {
    try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size > FIND_MAX_FILE_BYTES) return undefined;
        const buffer = await fs.promises.readFile(filePath);
        if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
        return buffer.toString('utf8');
    } catch {
        return undefined;
    }
}

/** 子匹配的 start/end 与 ripgrep 一样是行内字节偏移 */
function collectSubmatches(regex: RegExp, line: string): TextMatch['submatches'] {
    const submatches: TextMatch['submatches'] = [];
    regex.lastIndex = 0;
    for (let match = regex.exec(line); match && submatches.length < MAX_SUBMATCHES; match = regex.exec(line)) {
        if (match[0].length === 0) {
            regex.lastIndex++;
            continue;
        }
        const start = Buffer.byteLength(line.slice(0, match.index));
        submatches.push({ match: { text: match[0] }, start, end: start + Buffer.byteLength(match[0]) });
    }
    return submatches;
}

function truncateLine(line: string): string {
    if (line.length <= LINE_TEXT_MAX_CHARS) return line;
    return line.slice(0, LINE_TEXT_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, '') + '...';
}

export interface FindFilesOptions {
    query: string;
    type?: 'file' | 'directory';
    limit?: number;
}

/** 在工作空间文件（及其所在目录）中做模糊匹配；目录以 / 结尾，空查询返回空列表（同 opencode） */
export async function findFiles(directory: string, options: FindFilesOptions): Promise<FindFilesResponse> {
    const terms = options.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const limit = Math.min(Math.max(options.limit ?? FIND_FILE_DEFAULT_LIMIT, 1), FIND_FILE_MAX_LIMIT);

    const files: string[] = [];
    const directories = new Set<string>();
    for await (const filePath of walkFiles(directory, {
        filePattern: '**/*',
        dot: true,
        ignorePatterns: await collectGitignorePatterns(directory),
        timeBudgetMs: FIND_TIME_BUDGET_MS,
        startedAt: Date.now()
    })) {
        const relativePath = toRelativePath(directory, filePath);
        files.push(relativePath);
        const segments = relativePath.split('/');
        for (let index = 1; index < segments.length; index++) {
            directories.add(segments.slice(0, index).join('/') + '/');
        }
    }

    const candidates =
        options.type === 'file' ? files : options.type === 'directory' ? [...directories] : [...files, ...directories];
    const ranked: { target: string; score: number }[] = [];
    for (const target of candidates) {
        const score = fuzzyScore(terms, target);
        if (score !== undefined) ranked.push({ target, score });
    }
    ranked.sort((a, b) => b.score - a.score || a.target.length - b.target.length || a.target.localeCompare(b.target));
    return ranked.slice(0, limit).map((item) => item.target) satisfies FindFilesResponse;
}

/**
 * 每个查询词都必须按顺序出现在路径中（忽略大小写）。连续命中、命中路径段开头、
 * 命中文件名部分得分更高，用于把最贴近的结果排在前面。
 */
export function fuzzyScore(terms: readonly string[], target: string): number | undefined {
    const lower = target.toLowerCase();
    const basenameStart = lower.replace(/\/$/, '').lastIndexOf('/') + 1;
    let total = 0;
    for (const term of terms) {
        let score = 0;
        let position = -1;
        let previous = -2;
        for (const char of term) {
            position = lower.indexOf(char, position + 1);
            if (position === -1) return undefined;
            score += 1;
            if (position === previous + 1) score += 5;
            if (position === 0 || '/-_. '.includes(lower[position - 1])) score += 3;
            if (position >= basenameStart) score += 2;
            previous = position;
        }
        total += score;
    }
    return total;
}

function toRelativePath(directory: string, filePath: string): string {
    return path.relative(directory, filePath).split(path.sep).join('/');
}
