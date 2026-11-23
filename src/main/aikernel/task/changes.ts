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

import * as diff from 'diff';
import path from 'path';
import fs from 'fs';
import { cleanPathInput } from '../../../utils/path.js';
import { normalizeLineEndings } from '../../../utils/string.js';
import { Setting } from '../../utils/setting.js';
import { AssistantMessage, ToolCall, ToolCallMessagePart } from '../messages.js';
import type { TaskState } from '../states/tasks.js';

// ═══════════════════ Interfaces ═══════════════════

export interface DiffLine {
    type: 'context' | 'added' | 'removed';
    oldNum?: number;
    newNum?: number;
    content: string;
}

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
}

export interface FileChangeEntry {
    toolName: string;
    hunks: DiffHunk[];
    addedLines: number;
    removedLines: number;
}

export interface FileChanges {
    filePath: string;
    totalAdded: number;
    totalRemoved: number;
    changes: FileChangeEntry[];
}

export interface TaskChangesResult {
    files: FileChanges[];
    totalFiles: number;
    totalAdded: number;
    totalRemoved: number;
}

export interface FileChangeOperation {
    toolName: string;
    args: Record<string, unknown>;
    fallbackEntry: FileChangeEntry;
}

export interface FileChangeGroup {
    displayPath: string;
    absolutePath: string;
    operations: FileChangeOperation[];
}

// ═══════════════════ Public API ═══════════════════

/**
 * 分析任务中所有文件修改工具调用，生成文件变更汇总。
 * 之前是 TaskState.getTaskChanges()。
 * 传入 messages 时只统计这部分消息（例如某一轮对话），反向回放仍以磁盘上的当前内容为起点。
 */
export function getTaskChangesFromTask(
    task: TaskState,
    messages: readonly TaskState['chat_context']['messages'][number][] = task.chat_context.messages
): TaskChangesResult {
    // 文件修改工具名（短名称，不含 toolset 前缀）
    const FILE_MODIFY_TOOLS = new Set(['writeFile', 'editFile', 'searchReplace']);
    const fileMap = new Map<string, FileChangeGroup>();

    for (const message of messages) {
        if (message.role !== 'assistant') continue;
        const assistantMsg = message as AssistantMessage;
        const content = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
        for (const part of content) {
            if (!part || part.type !== 'tool_call') continue;
            const tcPart = part as ToolCallMessagePart;
            const toolcalls = Array.isArray(tcPart.toolcalls) ? tcPart.toolcalls : [];
            for (const tc of toolcalls) {
                if (!tc || typeof tc.tool_name !== 'string') continue;
                // tc.tool_name 可能是完整限定名（如 "filemgr-writeFile"）或短名（"writeFile"）
                const shortName = tc.tool_name.includes('-')
                    ? tc.tool_name.slice(tc.tool_name.lastIndexOf('-') + 1)
                    : tc.tool_name;
                if (!FILE_MODIFY_TOOLS.has(shortName)) continue;
                if (tc.status !== 'success') continue;

                // 解析 args：优先使用 args_object，回退到解析 args_string
                const rawArgs = resolveToolCallArgs(tc);
                if (!rawArgs) continue;

                // 统一在 LF 口径下做回放/反向回放：editFile 在 CRLF 文件上写回时会把结果还原成
                // CRLF，而工具调用参数永远是 LF；只归一化文件内容而不归一化参数，反向回放仍然匹配
                // 不到，会退化成片段 diff（行号从 1 开始，不是文件真实行号）。
                const args = normalizeOperationArgs(rawArgs);

                const entry = computeFileChangeEntry(shortName, args);
                if (!entry) continue;

                // Determine file path from args
                const filePath = (args as any).path || (args as any).filePath || '';
                if (!filePath) continue;

                const normalizedPath = normalizeChangeFilePath(String(filePath), task);
                if (!fileMap.has(normalizedPath.absolutePath)) {
                    fileMap.set(normalizedPath.absolutePath, {
                        displayPath: normalizedPath.displayPath,
                        absolutePath: normalizedPath.absolutePath,
                        operations: []
                    });
                }
                fileMap.get(normalizedPath.absolutePath)!.operations.push({
                    toolName: shortName,
                    args,
                    fallbackEntry: entry
                });
            }
        }
    }

    const files: FileChanges[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const group of fileMap.values()) {
        if (group.operations.length === 0) continue;

        const cumulative = computeCumulativeFileChange(group);
        if (cumulative === null) {
            continue;
        }

        const changes = cumulative !== undefined ? [cumulative] : [mergeFallbackEntriesAsCumulative(group.operations)];
        if (changes.length === 0) continue;

        let fileAdded = 0;
        let fileRemoved = 0;
        for (const change of changes) {
            fileAdded += change.addedLines;
            fileRemoved += change.removedLines;
        }
        files.push({
            filePath: group.displayPath,
            totalAdded: fileAdded,
            totalRemoved: fileRemoved,
            changes
        });
        totalAdded += fileAdded;
        totalRemoved += fileRemoved;
    }

    // Sort files by path for stable output
    files.sort((a, b) => a.filePath.localeCompare(b.filePath));

    return {
        files,
        totalFiles: files.length,
        totalAdded,
        totalRemoved
    };
}

// ═══════════════════ Internal Helpers ═══════════════════

/**
 * 解析工具调用参数：优先使用 args_object（内存中已解析），
 * 回退到解析 args_string（从磁盘加载的原始 JSON）。
 * 对压缩过的任务同样适用——compact 不会清除 args_string。
 */
function resolveToolCallArgs(tc: ToolCall): Record<string, unknown> | undefined {
    // 优先使用已解析的 args_object
    if (
        tc.args_object &&
        typeof tc.args_object === 'object' &&
        !Array.isArray(tc.args_object) &&
        Object.keys(tc.args_object).length > 0
    ) {
        return tc.args_object as Record<string, unknown>;
    }

    // 回退：从 args_string 解析
    if (typeof tc.args_string === 'string' && tc.args_string.trim().length > 0) {
        try {
            const parsed = JSON.parse(tc.args_string);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // JSON 解析失败，可能是不完整的流式输出残留
        }
    }

    return undefined;
}

function normalizeChangeFilePath(filePath: string, task: TaskState): { displayPath: string; absolutePath: string } {
    const cleanedPath = cleanPathInput(filePath);
    const displayPath = cleanedPath.replace(/\\/g, '/');
    const workspace = task.getWorkspace() || Setting.getInstance().getEffectiveWorkspace();
    const isAbsolute = path.isAbsolute(cleanedPath) || path.win32.isAbsolute(cleanedPath);
    const absolutePath = (isAbsolute ? cleanedPath : path.resolve(workspace || process.cwd(), cleanedPath)).replace(
        /\\/g,
        '/'
    );
    return { displayPath, absolutePath };
}

function computeCumulativeFileChange(group: FileChangeGroup): FileChangeEntry | null | undefined {
    const rawContent = readChangeFileContent(group.absolutePath) ?? replayOperationsForward(group);
    if (rawContent === undefined) {
        return undefined;
    }
    // 磁盘内容统一归一化成 LF 后再回放：参数侧已在 normalizeOperationArgs 中归一化，
    // 两侧口径一致才能反解出原始内容。归一化不改变行数，diff 行号与原文件一致。
    const finalContent = normalizeLineEndings(rawContent);

    let originalContent = finalContent;
    for (let i = group.operations.length - 1; i >= 0; i--) {
        const previousContent = reverseFileChangeOperation(originalContent, group.operations[i]);
        if (previousContent === undefined) {
            return undefined;
        }
        originalContent = previousContent;
    }

    if (originalContent === finalContent) {
        return null;
    }

    return buildDiffEntry('cumulative', originalContent, finalContent);
}

/** 换行符敏感的参数键：这几项都会与磁盘内容做字面量比对。 */
const EOL_SENSITIVE_ARG_KEYS = ['content', 'oldString', 'newString'];

/**
 * 归一化工具调用参数中的换行符，返回浅拷贝（不得改动已持久化的 args_object）。
 * 回放与反向回放都依赖 "内容与参数同为 LF 口径" 这一前提，集中在这里归一化一次，
 * 下游的 fallback 片段也不会带 \r 进 HTML。
 */
function normalizeOperationArgs(args: Record<string, unknown>): Record<string, unknown> {
    const normalized: Record<string, unknown> = { ...args };
    for (const key of EOL_SENSITIVE_ARG_KEYS) {
        const value = args[key];
        if (typeof value === 'string') {
            normalized[key] = normalizeLineEndings(value);
        }
    }
    return normalized;
}

function readChangeFileContent(filePath: string): string | undefined {
    try {
        if (!fs.existsSync(filePath)) {
            return undefined;
        }
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return undefined;
    }
}

function replayOperationsForward(group: FileChangeGroup): string | undefined {
    let content: string | undefined;
    for (const operation of group.operations) {
        if (operation.toolName === 'writeFile') {
            const next = (operation.args as any).content;
            if (typeof next !== 'string') {
                return undefined;
            }
            const mode = (operation.args as any).mode || 'overwrite';
            content = mode === 'append' ? (content ?? '') + next : next;
            continue;
        }

        const oldString = (operation.args as any).oldString;
        const newString = (operation.args as any).newString;
        if (typeof oldString !== 'string' || typeof newString !== 'string') {
            return undefined;
        }
        if (oldString === '') {
            content = newString;
            continue;
        }
        if (content === undefined) {
            return undefined;
        }
        const count = getReplacementLimit(operation);
        const replaced = replaceOccurrences(content, oldString, newString, count);
        if (replaced.count === 0) {
            return undefined;
        }
        content = replaced.content;
    }
    return content;
}

function reverseFileChangeOperation(content: string, operation: FileChangeOperation): string | undefined {
    if (operation.toolName === 'writeFile') {
        const writtenContent = (operation.args as any).content;
        if (typeof writtenContent !== 'string') {
            return undefined;
        }
        const mode = (operation.args as any).mode || 'overwrite';
        if (mode === 'append') {
            if (content.endsWith(writtenContent)) {
                return content.slice(0, content.length - writtenContent.length);
            }
            const idx = content.lastIndexOf(writtenContent);
            if (idx >= 0) {
                return content.slice(0, idx) + content.slice(idx + writtenContent.length);
            }
            return undefined;
        }
        return '';
    }

    const oldString = (operation.args as any).oldString;
    const newString = (operation.args as any).newString;
    if (typeof oldString !== 'string' || typeof newString !== 'string') {
        return undefined;
    }
    if (oldString === '') {
        if (content === newString) {
            return '';
        }
        const replaced = replaceOccurrences(content, newString, '', 1);
        return replaced.count > 0 ? replaced.content : undefined;
    }
    if (newString === '') {
        return undefined;
    }

    const count = getReplacementLimit(operation);
    const replaced = replaceOccurrences(content, newString, oldString, count);
    if (replaced.count === 0) {
        return undefined;
    }
    return replaced.content;
}

function getReplacementLimit(operation: FileChangeOperation): number {
    const raw = (operation.args as any).expectedReplacements;
    if (operation.toolName === 'editFile' && typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        return Math.floor(raw);
    }
    return 1;
}

function replaceOccurrences(
    input: string,
    search: string,
    replacement: string,
    limit: number
): { content: string; count: number } {
    if (search === '' || limit <= 0) {
        return { content: input, count: 0 };
    }

    let count = 0;
    let cursor = 0;
    let result = '';
    while (count < limit) {
        const idx = input.indexOf(search, cursor);
        if (idx === -1) {
            break;
        }
        result += input.slice(cursor, idx) + replacement;
        cursor = idx + search.length;
        count++;
    }
    if (count === 0) {
        return { content: input, count: 0 };
    }
    result += input.slice(cursor);
    return { content: result, count };
}

function buildDiffEntry(toolName: string, oldContent: string, newContent: string): FileChangeEntry {
    const patch = diff.structuredPatch('', '', oldContent, newContent, '', '', {
        context: 3
    });
    const hunks: DiffHunk[] = [];
    let addedCount = 0;
    let removedCount = 0;

    for (const hunk of patch.hunks) {
        let oldNum = hunk.oldStart;
        let newNum = hunk.newStart;
        const lines: DiffLine[] = [];
        for (const rawLine of hunk.lines) {
            if (rawLine.startsWith('\\')) {
                continue;
            }
            const op = rawLine[0];
            const content = rawLine.slice(1);
            if (op === '+') {
                lines.push({ type: 'added', newNum, content });
                newNum++;
                addedCount++;
            } else if (op === '-') {
                lines.push({ type: 'removed', oldNum, content });
                oldNum++;
                removedCount++;
            } else {
                lines.push({ type: 'context', oldNum, newNum, content });
                oldNum++;
                newNum++;
            }
        }

        hunks.push({
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            lines
        });
    }

    return {
        toolName,
        hunks,
        addedLines: addedCount,
        removedLines: removedCount
    };
}

function mergeFallbackEntriesAsCumulative(operations: FileChangeOperation[]): FileChangeEntry {
    return {
        toolName: 'cumulative',
        hunks: operations.flatMap((operation) => operation.fallbackEntry.hunks),
        addedLines: operations.reduce((sum, operation) => sum + operation.fallbackEntry.addedLines, 0),
        removedLines: operations.reduce((sum, operation) => sum + operation.fallbackEntry.removedLines, 0)
    };
}

function computeFileChangeEntry(toolName: string, args: Record<string, unknown>): FileChangeEntry | null {
    try {
        if (toolName === 'writeFile') {
            const content = (args as any).content;
            const mode = (args as any).mode || 'overwrite';
            if (typeof content !== 'string' || content.length === 0) return null;
            const lines = content.split('\n');
            const hunks: DiffHunk[] = [
                {
                    oldStart: 0,
                    oldLines: 0,
                    newStart: 1,
                    newLines: lines.length,
                    lines: lines.map((line: string, i: number) => ({
                        type: 'added' as const,
                        newNum: i + 1,
                        content: line
                    }))
                }
            ];
            return {
                toolName: mode === 'append' ? 'writeFile (追加)' : 'writeFile (写入)',
                hunks,
                addedLines: lines.length,
                removedLines: 0
            };
        }

        if (toolName === 'editFile' || toolName === 'searchReplace') {
            const oldString = (args as any).oldString;
            const newString = (args as any).newString;
            if (typeof oldString !== 'string' || typeof newString !== 'string') return null;
            if (oldString === '') return null;

            // Compute diff between oldString and newString
            return buildDiffEntry(toolName, oldString, newString);
        }

        return null;
    } catch {
        return null;
    }
}
