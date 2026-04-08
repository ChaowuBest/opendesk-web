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

import { BaseTool, BaseToolset } from '../../aikernel/tool';
import { ToolCall } from '../../aikernel/messages';
import { escapeHtml } from '../../utils/escape';
import { Card } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import { z } from 'zod';
import { detectEncoding, decodeBuffer, encodingDisplayName, HEAD_BYTES } from '../terminal/encoding.js';
import type { PermissionRequest } from '../../aikernel/security/permission';
import type { TaskState } from '../../aikernel/states/tasks';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as diff from 'diff';
import fileType from 'file-type';
import chalk from 'chalk';
import fastGlob from 'fast-glob';

const MAX_DIFF_LINES = 50;
const RENDER_CONTENT_MAX_CHARS = 4000;
const RENDER_CONTENT_MAX_LINES = 80;
const DIFF_CONTEXT_LINES = 3;

// ==================== 路径处理 ====================

/**
 * 修复被 JSON 转义序列污染的 Windows 路径。
 * AI 模型在 JSON 中输出 Windows 路径时，\t \n \b \f \r 会被 JSON.parse 解释为
 * 控制字符（tab、换行、退格、换页、回车），导致路径损坏。
 * 此函数将这些控制字符还原为对应的反斜杠字母组合，然后统一使用正斜杠。
 */
function sanitizePath(inputPath: string): string {
    if (!inputPath || typeof inputPath !== 'string') return inputPath;

    let p = inputPath
        .replace(/\x08/g, '\\b')
        .replace(/\x09/g, '\\t')
        .replace(/\x0A/g, '\\n')
        .replace(/\x0C/g, '\\f')
        .replace(/\x0D/g, '\\r');

    // 展开 ~ 为用户主目录
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
        p = os.homedir() + p.slice(1);
    }

    // 统一使用正斜杠（Node.js 在 Windows 上也接受正斜杠）
    p = p.replace(/\\/g, '/');

    // 清理连续多个斜杠（保留 UNC 路径 // 和协议前缀 ://）
    p = p.replace(/(?<!:)\/{2,}/g, '/');

    return p;
}

/**
 * 将路径转换为统一使用正斜杠的形式（用于输出显示）
 */
function toForwardSlash(p: string): string {
    return p.replace(/\\/g, '/');
}

// ==================== 共用辅助函数 ====================

/**
 * 渲染类似 git diff 格式的输出
 */
function renderDiffOutput(oldContent: string, newContent: string, width: number): string[] {
    const diffResult = diff.diffLines(oldContent, newContent);

    let addedCount = 0;
    let removedCount = 0;
    for (const part of diffResult) {
        if (part.added) {
            addedCount += part.count || 0;
        } else if (part.removed) {
            removedCount += part.count || 0;
        }
    }

    if (addedCount + removedCount > MAX_DIFF_LINES) {
        return [chalk.dim(`  修改超过 ${MAX_DIFF_LINES} 行，不显示 diff`)];
    }

    const body: string[] = [];
    let oldLineNum = 1;
    let newLineNum = 1;

    interface DiffBlock {
        oldStart: number;
        oldEnd: number;
        newStart: number;
        newEnd: number;
        lines: Array<{
            type: 'context' | 'removed' | 'added';
            oldNum?: number;
            newNum?: number;
            content: string;
        }>;
    }

    const blocks: DiffBlock[] = [];
    let currentBlock: DiffBlock | null = null;

    for (const part of diffResult) {
        const lines = part.value.split('\n');
        if (lines[lines.length - 1] === '') {
            lines.pop();
        }

        if (part.added) {
            if (!currentBlock) {
                currentBlock = {
                    oldStart: oldLineNum,
                    oldEnd: oldLineNum,
                    newStart: newLineNum,
                    newEnd: newLineNum + lines.length - 1,
                    lines: []
                };
            }
            for (const line of lines) {
                currentBlock.lines.push({ type: 'added', newNum: newLineNum, content: line });
                currentBlock.newEnd = newLineNum;
                newLineNum++;
            }
        } else if (part.removed) {
            if (!currentBlock) {
                currentBlock = {
                    oldStart: oldLineNum,
                    oldEnd: oldLineNum + lines.length - 1,
                    newStart: newLineNum,
                    newEnd: newLineNum,
                    lines: []
                };
            }
            for (const line of lines) {
                currentBlock.lines.push({ type: 'removed', oldNum: oldLineNum, content: line });
                currentBlock.oldEnd = oldLineNum;
                oldLineNum++;
            }
        } else {
            if (currentBlock) {
                let contextCount = 0;
                for (const line of lines) {
                    if (contextCount < DIFF_CONTEXT_LINES) {
                        currentBlock.lines.push({
                            type: 'context',
                            oldNum: oldLineNum,
                            newNum: newLineNum,
                            content: line
                        });
                        contextCount++;
                    }
                    oldLineNum++;
                    newLineNum++;
                }
                blocks.push(currentBlock);
                currentBlock = null;
            } else {
                const contextLines = lines.slice(-DIFF_CONTEXT_LINES);
                oldLineNum += lines.length - contextLines.length;
                newLineNum += lines.length - contextLines.length;

                if (contextLines.length > 0) {
                    currentBlock = {
                        oldStart: oldLineNum,
                        oldEnd: oldLineNum + contextLines.length - 1,
                        newStart: newLineNum,
                        newEnd: newLineNum + contextLines.length - 1,
                        lines: []
                    };
                    for (const line of contextLines) {
                        currentBlock.lines.push({
                            type: 'context',
                            oldNum: oldLineNum,
                            newNum: newLineNum,
                            content: line
                        });
                        oldLineNum++;
                        newLineNum++;
                    }
                } else {
                    oldLineNum += lines.length;
                    newLineNum += lines.length;
                }
            }
        }
    }

    if (currentBlock) {
        blocks.push(currentBlock);
    }

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (i > 0) {
            body.push(chalk.dim('  ...'));
        }

        const oldRange =
            block.oldStart === block.oldEnd
                ? `${block.oldStart}`
                : `${block.oldStart},${block.oldEnd - block.oldStart + 1}`;
        const newRange =
            block.newStart === block.newEnd
                ? `${block.newStart}`
                : `${block.newStart},${block.newEnd - block.newStart + 1}`;
        body.push(chalk.cyan(`@@ -${oldRange} +${newRange} @@`));

        for (const line of block.lines) {
            const maxLineNum = Math.max(block.oldEnd, block.newEnd);
            const lineNumWidth = String(maxLineNum).length + 1;

            if (line.type === 'removed') {
                const lineNum = String(line.oldNum || '').padEnd(lineNumWidth);
                const content = `- ${line.content}`;
                const fullLine = lineNum + ' ' + content;
                const paddedLine = fullLine.padEnd(width - 4);
                body.push(chalk.bgRgb(255, 230, 230)(chalk.rgb(180, 60, 60)(paddedLine)));
            } else if (line.type === 'added') {
                const lineNum = String(line.newNum || '').padEnd(lineNumWidth);
                const content = `+ ${line.content}`;
                const fullLine = lineNum + ' ' + content;
                const paddedLine = fullLine.padEnd(width - 4);
                body.push(chalk.bgRgb(230, 255, 230)(chalk.rgb(40, 140, 40)(paddedLine)));
            } else {
                const oldNumStr = String(line.oldNum || '').padEnd(lineNumWidth);
                const newNumStr = String(line.newNum || '').padEnd(lineNumWidth);
                const truncatedContent = truncText(line.content, width - 10 - lineNumWidth * 2);
                body.push(chalk.dim(oldNumStr) + chalk.dim(newNumStr) + chalk.dim(`   ${truncatedContent}`));
            }
        }
    }

    return body;
}

/**
 * 归一化换行符：将 \r\n 和 \r 统一为 \n
 */
function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n|\r/g, '\n');
}

/**
 * 检测文件内容的主要换行符风格
 * 返回 '\r\n' (CRLF) 或 '\n' (LF)
 */
function detectLineEnding(content: string): '\r\n' | '\n' {
    const crlfCount = (content.match(/\r\n/g) || []).length;
    const lfCount = (content.match(/(?<!\r)\n/g) || []).length;
    return crlfCount > lfCount ? '\r\n' : '\n';
}

// ==================== Electron 渲染辅助 ====================

function openFileButton(filePath: string): string {
    const escaped = escapeHtml(filePath);
    return `<button onclick="window.fsAPI.openPath('${escaped.replace(/'/g, "\\'")}')" class="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-slate-200 transition-colors" title="打开文件"><svg class="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>`;
}

function statusDot(status: string): string {
    if (status === 'running') {
        return '<div class="h-2 w-2 rounded-full bg-blue-500 animate-pulse ring-4 ring-blue-100/50"></div>';
    } else if (status === 'success') {
        return '<div class="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"></div>';
    } else if (status === 'error') {
        return '<div class="h-2.5 w-2.5 rounded-full bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.6)]"></div>';
    }
    return '<div class="h-2 w-2 rounded-full bg-slate-400"></div>';
}

function renderToolCard(opts: {
    icon: string;
    title: string;
    status: string;
    headerExtra?: string;
    body: string;
}): string {
    return `
    <div class="rounded-xl border border-slate-200 bg-white/90 shadow-sm overflow-hidden my-2">
        <div class="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
            <span class="text-lg">${opts.icon}</span>
            <span class="font-medium text-slate-700">${escapeHtml(opts.title)}</span>
            ${statusDot(opts.status)}
            ${opts.headerExtra || ''}
        </div>
        <div class="px-4 py-3 text-slate-700">
            ${opts.body}
        </div>
    </div>`;
}

function truncateContent(content: string): { text: string; truncated: boolean } {
    const lines = content.split('\n');
    if (content.length <= RENDER_CONTENT_MAX_CHARS && lines.length <= RENDER_CONTENT_MAX_LINES) {
        return { text: content, truncated: false };
    }
    let result = '';
    let lineCount = 0;
    for (const line of lines) {
        if (result.length + line.length + 1 > RENDER_CONTENT_MAX_CHARS || lineCount >= RENDER_CONTENT_MAX_LINES) {
            break;
        }
        if (lineCount > 0) result += '\n';
        result += line;
        lineCount++;
    }
    return { text: result, truncated: true };
}

/**
 * 获取系统临时目录
 */
export function getTempDirectory(): string {
    // @ts-ignore 主线 nodeJS 当前还没支持openharmony，所以这里需要手动处理
    if (process.platform === 'openharmony') {
        const tmpdir = path.join(os.tmpdir(), '.tmp');
        if (!fs.existsSync(tmpdir)) {
            fs.mkdirSync(tmpdir, { recursive: true });
        }
        return tmpdir;
    }
    return os.tmpdir();
}

// ==================== ReadFiles 工具 ====================

const READ_FILES_MAX_BYTES = 80 * 1024;
const READ_FILES_MAX_CONCURRENCY = 5;

const readFilesSchema = z.object({
    files: z
        .array(
            z.object({
                path: z.string().describe('文件路径'),
                offsetKB: z.number().int().min(0).default(0).describe('起始位置（单位 KB，从 0 开始），默认 0')
            })
        )
        .describe('要读取的文件列表，每项可指定 path 与起始位置 offsetKB（KB）')
});

function isBinaryMedia(mime: string): boolean {
    return (
        mime.startsWith('image/') ||
        mime.startsWith('video/') ||
        mime.startsWith('audio/') ||
        mime === 'application/octet-stream'
    );
}

function hasBinaryContent(buffer: Buffer): boolean {
    const checkLen = Math.min(buffer.length, 8192);
    for (let i = 0; i < checkLen; i++) {
        if (buffer[i] === 0) return true;
    }
    return false;
}

interface ReadFileMetadata {
    size: number;
    modified: string;
    totalChars?: number;
    encoding?: string;
    mime?: string;
    ext?: string;
}

interface ReadFileResult {
    path: string;
    requestedOffsetKB: number;
    error?: string;
    metadata?: ReadFileMetadata;
    content?: string;
    nonText?: boolean;
    truncated?: boolean;
    nextOffsetKB?: number;
}

async function readSingleFile(filePath: string, offsetKB: number): Promise<ReadFileResult> {
    if (offsetKB < 0) {
        return { path: filePath, requestedOffsetKB: offsetKB, error: 'offsetKB 不能为负数' };
    }

    try {
        const stat = await fs.promises.stat(filePath);
        const size = stat.size;
        const modified = stat.mtime.toISOString();

        let type: Awaited<ReturnType<typeof fileType.fromFile>> = undefined;
        try {
            type = await fileType.fromFile(filePath);
        } catch {
            // 解析不了当文本
        }

        if (type?.mime && isBinaryMedia(type.mime)) {
            return {
                path: filePath,
                requestedOffsetKB: offsetKB,
                metadata: { size, modified, mime: type.mime, ext: type.ext },
                content: undefined,
                nonText: true
            };
        }

        if (size === 0) {
            return {
                path: filePath,
                requestedOffsetKB: offsetKB,
                metadata: { size, modified, totalChars: 0, encoding: 'UTF-8' },
                content: '',
                truncated: false
            };
        }

        const headLen = Math.min(size, HEAD_BYTES);
        const headBuf = Buffer.alloc(headLen);
        const fd = await fs.promises.open(filePath, 'r');
        try {
            await fd.read(headBuf, 0, headLen, 0);
        } finally {
            await fd.close();
        }

        if (!type && hasBinaryContent(headBuf)) {
            return {
                path: filePath,
                requestedOffsetKB: offsetKB,
                metadata: { size, modified },
                content: undefined,
                nonText: true
            };
        }

        const { encoding, bomOffset } = detectEncoding(headBuf);
        const encodingLabel = encodingDisplayName(encoding);

        const byteOffset = offsetKB * 1024;
        const readPosition = bomOffset + byteOffset;
        const readLen = Math.max(0, Math.min(READ_FILES_MAX_BYTES, size - readPosition));

        if (readLen === 0) {
            return {
                path: filePath,
                requestedOffsetKB: offsetKB,
                metadata: { size, modified, encoding: encodingLabel },
                content: '',
                truncated: false
            };
        }

        let block: Buffer;
        if (readPosition < headLen && readPosition + readLen <= headLen) {
            block = headBuf.subarray(readPosition, readPosition + readLen);
        } else {
            block = Buffer.alloc(readLen);
            const fd2 = await fs.promises.open(filePath, 'r');
            try {
                await fd2.read(block, 0, readLen, readPosition);
            } finally {
                await fd2.close();
            }
        }

        const content = decodeBuffer(block, encoding, 0);
        const truncated = readLen === READ_FILES_MAX_BYTES && readPosition + readLen < size;
        const nextOffsetKB = Math.ceil((byteOffset + readLen) / 1024);

        return {
            path: filePath,
            requestedOffsetKB: offsetKB,
            metadata: { size, modified, encoding: encodingLabel },
            content,
            truncated: truncated ? true : undefined,
            nextOffsetKB: truncated ? nextOffsetKB : undefined
        };
    } catch (err) {
        let message: string;
        if (err instanceof Error) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'ENOENT') {
                message = `文件不存在: ${filePath}`;
            } else if (nodeErr.code === 'EACCES') {
                message = `权限不足，无法读取文件: ${filePath}`;
            } else if (nodeErr.code === 'EISDIR') {
                message = `路径是目录，不是文件: ${filePath}`;
            } else if (nodeErr.code === 'EMFILE') {
                message = `打开文件过多，请稍后重试`;
            } else {
                message = err.message;
            }
        } else {
            message = String(err);
        }
        return { path: filePath, requestedOffsetKB: offsetKB, error: message };
    }
}

function formatReadFileResult(result: ReadFileResult): string {
    const parts: string[] = [`--- ${result.path} ---`];

    if (result.error) {
        parts.push(`错误: ${result.error}`);
        return parts.join('\n');
    }

    if (result.requestedOffsetKB > 0) {
        parts.push(`[从位置 ${result.requestedOffsetKB} KB 开始]`);
    }

    if (result.nonText) {
        parts.push(
            `此文件不是纯文本（检测为 ${result.metadata?.mime ?? '二进制'}），ReadFilesTool 无法打开非文本文件；以上仅为元数据。`
        );
    } else {
        if (result.content != null && result.content.length > 0) {
            parts.push(result.content);
        }
        if (result.truncated && result.nextOffsetKB !== undefined) {
            const sizeStr = result.metadata?.size !== undefined ? `，文件总大小 ${result.metadata.size} 字节` : '';
            parts.push(`[ 后续被截断，你可指定 offsetKB = ${result.nextOffsetKB} 继续读${sizeStr} ]`);
        }
    }

    return parts.join('\n');
}

export class ReadFilesTool extends BaseTool<typeof readFilesSchema> {
    constructor() {
        super(
            'readFiles',
            '并行读取多个文件的原始文本内容，可用来读取文本、代码、配置文件等文本格式数据。支持同时读取多个文件，支持 offsetKB（KB）分页；非文本文件仅返回元数据',
            readFilesSchema
        );

        this.setExecutor(this.executeCommand);
    }

    getDeclaredPermissions(args: z.output<typeof readFilesSchema>): PermissionRequest[] {
        if (!args.files || !Array.isArray(args.files)) return [];
        return args.files.map((f: any) => ({
            resourceType: 'file' as const,
            action: 'read' as const,
            resourcePath: sanitizePath(typeof f === 'string' ? f : f.path || '')
        }));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const files = toolcall.args_object?.['files'] as Array<{ path: string; offsetKB?: number }> | undefined;
        const fileItems =
            files && Array.isArray(files)
                ? files
                      .slice(0, 12)
                      .map((f) => {
                          const pRaw = typeof f === 'object' && f && 'path' in f ? f.path : f;
                          const p = typeof pRaw === 'string' ? pRaw : String(pRaw ?? '');
                          const off =
                              typeof f === 'object' && f && 'offsetKB' in f ? (f as { offsetKB?: number }).offsetKB : 0;
                          const label =
                              (off ?? 0) > 0
                                  ? `${escapeHtml(p)} <span class="text-amber-600">(从 ${off} KB 开始)</span>`
                                  : escapeHtml(p);
                          return `<li class="mt-0.5 flex items-center gap-1">${openFileButton(p)} <span>${label}</span></li>`;
                      })
                      .join('')
                : '';
        const listHtml =
            fileItems.length > 0
                ? `<ul class="list-none text-slate-600 text-sm mt-1 space-y-0.5">${fileItems}</ul>`
                : '<p class="text-slate-500 text-sm mt-1">未指定文件</p>';

        let resultHtml = '';
        if (toolcall.status === 'success' && toolcall.result) {
            const { text, truncated } = truncateContent(toolcall.result);
            const truncNote = truncated
                ? '<p class="mt-1 text-xs text-amber-600">… 内容已截断，完整内容请点击文件打开查看</p>'
                : '';
            resultHtml = `<div class="mt-3 rounded-lg border border-slate-200 bg-slate-50/80 p-3 text-sm overflow-x-auto"><pre class="whitespace-pre-wrap break-words font-mono text-slate-800">${escapeHtml(text)}</pre>${truncNote}</div>`;
        } else if (toolcall.status === 'running') {
            resultHtml = '<p class="mt-2 text-slate-400 text-sm animate-pulse">读取中…</p>';
        } else if (toolcall.status === 'error' && toolcall.result) {
            resultHtml = `<p class="mt-2 text-rose-600 text-sm">${escapeHtml(toolcall.result)}</p>`;
        }

        return renderToolCard({
            icon: '📖',
            title: '读取文件',
            status: toolcall.status,
            headerExtra: `<span class="text-slate-400 text-sm">${files?.length ?? 0} 个文件</span>`,
            body: `${listHtml}${resultHtml}`
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const files = toolcall.args_object?.['files'] as Array<{ path: string; offsetKB?: number }> | undefined;
        const body: string[] = [];

        if (files && Array.isArray(files)) {
            body.push(chalk.yellow(`${files.length} 个文件`));
            for (const f of files.slice(0, 5)) {
                const pRaw = typeof f === 'object' && f && 'path' in f ? f.path : f;
                const p = typeof pRaw === 'string' ? pRaw : String(pRaw ?? '');
                const off = typeof f === 'object' && f && 'offsetKB' in f ? (f as { offsetKB?: number }).offsetKB : 0;
                const suffix = (off ?? 0) > 0 ? chalk.dim(` (从 ${off} KB 开始)`) : '';
                body.push(chalk.dim('  • ') + truncText(p, width - 16) + suffix);
            }
            if (files.length > 5) {
                body.push(chalk.dim(`  … 共 ${files.length} 个文件`));
            }
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 读取中…'));
        } else if (toolcall.status === 'error' && toolcall.result != null) {
            const errStr = typeof toolcall.result === 'string' ? toolcall.result : String(toolcall.result);
            body.push(chalk.red(`  ✗ ${truncText(errStr, width - 16)}`));
        } else if (toolcall.status === 'success' && toolcall.result != null) {
            const resultStr = typeof toolcall.result === 'string' ? toolcall.result : String(toolcall.result);
            const errorLines = resultStr.match(/^错误: .+$/gm);
            if (errorLines) {
                for (const line of errorLines.slice(0, 5)) {
                    body.push(chalk.red(`  ✗ ${truncText(line, width - 16)}`));
                }
                if (errorLines.length > 5) {
                    body.push(chalk.red(`  … 共 ${errorLines.length} 个错误`));
                }
            }
            const truncatedMatch = resultStr.match(/\[ 后续被截断[^]]*offsetKB = (\d+)[^]]* ]/);
            if (truncatedMatch) {
                body.push(chalk.dim(`  已截断，可指定 offsetKB = ${truncatedMatch[1]} 继续读`));
            } else if (!errorLines) {
                body.push(chalk.dim('  见下方结果'));
            }
        }

        return new Card({
            icon: '📖',
            title: '读取文件',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async executeCommand(args: z.output<typeof readFilesSchema>): Promise<string> {
        if (!args.files || !Array.isArray(args.files) || args.files.length === 0) {
            return '请提供要读取的文件列表（files 数组，每项含 path 与可选的 offsetKB）';
        }

        const results: ReadFileResult[] = [];
        for (let i = 0; i < args.files.length; i += READ_FILES_MAX_CONCURRENCY) {
            const batch = args.files.slice(i, i + READ_FILES_MAX_CONCURRENCY);
            const batchResults = await Promise.all(
                batch.map((f: any) => {
                    const rawPath =
                        typeof f === 'string' ? f : typeof f.path === 'string' ? f.path : String(f.path ?? '');
                    const p = sanitizePath(rawPath);
                    const offsetKB = Number(f.offsetKB ?? 0);
                    return readSingleFile(p, offsetKB);
                })
            );
            results.push(...batchResults);
        }

        const output: string[] = [];
        for (const result of results) {
            output.push(formatReadFileResult(result));
        }
        return output.join('\n\n');
    }
}

// ==================== WriteFile 工具 ====================

const writeFileSchema = z.object({
    path: z.string().describe('要写入的文件路径'),
    mode: z
        .enum(['append', 'overwrite'])
        .default('overwrite')
        .describe('写入模式(append - 在原有内容基础上追加, overwrite - 覆盖原有内容)，默认为覆盖原有内容'),
    content: z.string().describe('要写入的文件内容')
});

const WRITE_FILE_TAIL_LINES = 5;

interface WriteFileRenderCache {
    contentHash: string;
    contentLen: number;
    lineCount: number;
    tailLines: string[];
    oldContent?: string;
}

const _writeFileCache = new WeakMap<ToolCall, WriteFileRenderCache>();

function computeContentHash(content: string): string {
    if (typeof content !== 'string') content = String(content);
    const len = content.length;
    if (len === 0) return '0:';

    const sampleInterval = len > 10000 ? 100 : len > 1000 ? 20 : 5;

    let hash = `${len}:`;
    for (let i = 0; i < Math.min(50, len); i++) {
        hash += content.charCodeAt(i);
    }
    for (let i = Math.max(50, len - 50); i < len; i++) {
        hash += content.charCodeAt(i);
    }
    for (let i = 50; i < len - 50; i += sampleInterval) {
        hash += content.charCodeAt(i);
    }
    return hash;
}

function getWriteFileInfo(toolcall: ToolCall, content: string): WriteFileRenderCache {
    if (typeof content !== 'string') content = String(content);
    const prev = _writeFileCache.get(toolcall);
    const contentHash = computeContentHash(content);

    if (prev && prev.contentHash === contentHash) return prev;

    let lineCount: number;
    if (prev && content.length > prev.contentLen) {
        const prevContentMatch = content.substring(0, prev.contentLen).length === prev.contentLen;
        if (prevContentMatch) {
            lineCount = prev.lineCount;
            for (let i = prev.contentLen; i < content.length; i++) {
                if (content.charCodeAt(i) === 10) lineCount++;
            }
        } else {
            lineCount = 1;
            for (let i = 0; i < content.length; i++) {
                if (content.charCodeAt(i) === 10) lineCount++;
            }
        }
    } else {
        lineCount = 1;
        for (let i = 0; i < content.length; i++) {
            if (content.charCodeAt(i) === 10) lineCount++;
        }
    }

    let end = content.length;
    if (end > 0 && content.charCodeAt(end - 1) === 10) end--;
    const tailLines: string[] = [];
    while (tailLines.length < WRITE_FILE_TAIL_LINES && end > 0) {
        const nlPos = content.lastIndexOf('\n', end - 1);
        if (nlPos === -1) {
            tailLines.unshift(content.substring(0, end));
            break;
        }
        tailLines.unshift(content.substring(nlPos + 1, end));
        end = nlPos;
    }

    const info: WriteFileRenderCache = {
        contentHash,
        contentLen: content.length,
        lineCount,
        tailLines
    };
    _writeFileCache.set(toolcall, info);
    return info;
}

export class WriteFileTool extends BaseTool<typeof writeFileSchema> {
    constructor() {
        super('writeFile', '将文件内容写入给定的文件路径中，支持覆盖模式与追加模式, 默认为覆盖模式', writeFileSchema);

        this.setExecutor(this.executeCommand);
    }

    getDeclaredPermissions(args: z.output<typeof writeFileSchema>): PermissionRequest[] {
        return [{ resourceType: 'file', action: 'write', resourcePath: sanitizePath(args.path) }];
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const filePath = toolcall.args_object?.['path'] as string | undefined;
        const content = toolcall.args_object?.['content'] as string | undefined;
        const mode = toolcall.args_object?.['mode'] as string | undefined;
        const title = '写入文件' + (mode === 'append' ? ' (追加)' : '');

        let bodyHtml = '';
        if (filePath) {
            bodyHtml += `<div class="flex items-center gap-1 text-sm text-slate-600">${openFileButton(filePath)} <span class="font-mono">${escapeHtml(filePath)}</span></div>`;
        }

        if (toolcall.status === 'running') {
            if (content && content.length > 0) {
                const info = getWriteFileInfo(toolcall, content);
                bodyHtml += `<p class="mt-1 text-sm text-slate-400 animate-pulse">✍ 正在写入… ${info.lineCount} 行, ${info.contentLen.toLocaleString()} 字符</p>`;
            } else {
                bodyHtml += '<p class="mt-1 text-sm text-slate-400 animate-pulse">⏳ 等待内容…</p>';
            }
        } else if (toolcall.status === 'success') {
            if (content && content.length > 0) {
                const info = getWriteFileInfo(toolcall, content);
                bodyHtml += `<p class="mt-1 text-sm text-slate-500">✅ ${info.lineCount} 行, ${info.contentLen.toLocaleString()} 字符</p>`;
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            bodyHtml += `<p class="mt-1 text-sm text-rose-600">${escapeHtml(toolcall.result)}</p>`;
        }

        return renderToolCard({ icon: '✏️', title, status: toolcall.status, body: bodyHtml });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const filePath = toolcall.args_object?.['path'];
        const content = toolcall.args_object?.['content'];
        const body: string[] = [];

        if (filePath) {
            body.push(chalk.yellow(truncText(String(filePath), width - 8)));
        }

        if (content && typeof content === 'string' && content.length > 0) {
            const info = getWriteFileInfo(toolcall, content);

            if (toolcall.status === 'success') {
                body.push(chalk.dim(`  ${info.lineCount} 行, ${info.contentLen.toLocaleString()} 字符`));
            } else {
                body.push(chalk.dim(`  ✍ 正在写入… ${info.lineCount} 行`));
                body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
                for (const line of info.tailLines) {
                    body.push('  ' + chalk.cyan(truncText(line, width - 10)));
                }
            }
        } else {
            const prev = _writeFileCache.get(toolcall);
            if (prev && prev.contentLen > 0 && toolcall.status === 'running') {
                body.push(chalk.dim(`  ✍ 正在写入… ${prev.lineCount} 行`));
                body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
                for (const line of prev.tailLines) {
                    body.push('  ' + chalk.cyan(truncText(line, width - 10)));
                }
            } else if (toolcall.status === 'running') {
                body.push(chalk.dim('  ⏳ 等待内容…'));
            }
        }

        const mode = toolcall.args_object?.['mode'];
        const title = '写入文件' + (mode === 'append' ? ' (追加)' : '');
        return new Card({
            icon: '✏️',
            title: title,
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async executeCommand(args: z.output<typeof writeFileSchema>): Promise<string> {
        const filePath = sanitizePath(args.path);
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            if (args.mode === 'append') {
                await fs.promises.appendFile(filePath, args.content, 'utf8');
                return '文件内容追加成功';
            } else {
                await fs.promises.writeFile(filePath, args.content, 'utf8');
                return '文件内容写入成功';
            }
        } catch (err: any) {
            const tempDir = getTempDirectory();
            const ext = path.extname(filePath) || '.txt';
            const baseName = path.basename(filePath, ext);
            const tempFileName = `opendesk_${baseName}_${Date.now()}${ext}`;
            const tempFilePath = path.join(tempDir, tempFileName);

            try {
                await fs.promises.writeFile(tempFilePath, args.content, 'utf8');
                return `错误: 无法写入目标文件 ${filePath} (${err.message})。文件内容已临时保存至 ${tempFilePath}，请勿再次输出完整内容`;
            } catch {
                return `错误: 无法写入目标文件 ${filePath} (${err.message})，且临时文件写入也失败`;
            }
        }
    }
}

// ==================== EditFile 工具 ====================

const editFileSchema = z.object({
    filePath: z.string().describe('要修改或创建的文件路径，可以使用工作区相对路径或绝对路径'),
    oldString: z
        .string()
        .describe(
            '要替换的原始文本（必须与文件内容完全匹配，包括所有空白和缩进）。对于单次替换，建议在目标文本前后各包含至少3行上下文。使用空字符串可创建新文件'
        ),
    newString: z.string().describe('替换后的新文本。当创建新文件时（oldString 为空），此参数将成为文件内容'),
    expectedReplacements: z
        .number()
        .min(1)
        .optional()
        .describe('预期的替换次数，默认为 1。当需要替换同一文本的多个出现时使用')
});

export class EditFileTool extends BaseTool<typeof editFileSchema> {
    constructor() {
        super(
            'editFile',
            '在现有文件中进行文本替换操作，支持字面字符串替换，可处理多次出现的替换。也可用于创建新文件（当 oldString 为空时）。这是对文件进行精确、针对性修改的首选工具',
            editFileSchema
        );

        this.setExecutor(this.executeCommand);
    }

    getDeclaredPermissions(args: z.output<typeof editFileSchema>): PermissionRequest[] {
        const p = sanitizePath(args.filePath);
        if (args.oldString === '') {
            return [{ resourceType: 'file', action: 'write', resourcePath: p }];
        }
        return [
            { resourceType: 'file', action: 'read', resourcePath: p },
            { resourceType: 'file', action: 'write', resourcePath: p }
        ];
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const filePath = toolcall.args_object?.['filePath'] as string | undefined;
        const oldString = toolcall.args_object?.['oldString'] as string | undefined;
        const newString = toolcall.args_object?.['newString'] as string | undefined;
        const isNewFile = oldString === '' || oldString === undefined;
        const title = isNewFile ? '创建文件' : '编辑文件';
        const icon = isNewFile ? '📄' : '✂️';

        let bodyHtml = '';
        if (filePath) {
            bodyHtml += `<div class="flex items-center gap-1 text-sm text-slate-600">${openFileButton(filePath)} <span class="font-mono">${escapeHtml(filePath)}</span></div>`;
        }

        if (toolcall.status === 'running') {
            bodyHtml += '<p class="mt-1 text-sm text-slate-400 animate-pulse">⏳ 编辑中…</p>';
        } else if (toolcall.status === 'success') {
            if (isNewFile) {
                const charCount = newString?.length ?? 0;
                bodyHtml += `<p class="mt-1 text-sm text-slate-500">✅ 新文件已创建 (${charCount.toLocaleString()} 字符)</p>`;
            } else {
                const expectedReplacements = toolcall.args_object?.['expectedReplacements'] || 1;
                const removedLines = oldString ? oldString.split('\n').length : 0;
                const addedLines = newString !== undefined ? newString.split('\n').length : 0;
                bodyHtml += `<p class="mt-1 text-sm text-slate-500">✅ 已完成 ${expectedReplacements} 处替换 (<span class="text-rose-500">-${removedLines}</span> / <span class="text-emerald-600">+${addedLines}</span> 行)</p>`;
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            bodyHtml += `<p class="mt-1 text-sm text-rose-600">${escapeHtml(toolcall.result)}</p>`;
        }

        return renderToolCard({ icon, title, status: toolcall.status, body: bodyHtml });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const filePath = toolcall.args_object?.['filePath'];
        const oldString = toolcall.args_object?.['oldString'] as string | undefined;
        const newString = toolcall.args_object?.['newString'] as string | undefined;
        const body: string[] = [];

        if (filePath) {
            body.push(chalk.yellow(truncText(String(filePath), width - 8)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 编辑中…'));
        } else if (toolcall.status === 'success') {
            if (oldString === '' || oldString === undefined) {
                body.push(chalk.dim('  ✅ 新文件已创建'));
            } else {
                const expectedReplacements = toolcall.args_object?.['expectedReplacements'] || 1;
                body.push(chalk.dim(`  ✅ 已完成 ${expectedReplacements} 处替换`));

                if (oldString && newString !== undefined) {
                    const diffLines = renderDiffOutput(oldString, newString, width);
                    if (diffLines.length > 0) {
                        body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
                        body.push(...diffLines);
                    }
                }
            }
        }

        const isNewFile = oldString === '' || oldString === undefined;
        const title = isNewFile ? '创建文件' : '编辑文件';
        return new Card({
            icon: isNewFile ? '📄' : '✂️',
            title: title,
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async executeCommand(args: z.output<typeof editFileSchema>): Promise<string> {
        const filePath = sanitizePath(args.filePath);
        const { oldString, newString, expectedReplacements = 1 } = args;

        if (oldString === '') {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            await fs.promises.writeFile(filePath, newString, 'utf8');
            return `文件已创建: ${filePath}`;
        }

        let content: string;
        try {
            content = await fs.promises.readFile(filePath, 'utf8');
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                return `错误: 文件不存在 - ${filePath}`;
            }
            throw err;
        }

        // 1. 先尝试原始精确匹配
        let searchContent = content;
        let searchOld = oldString;
        let searchNew = newString;
        let needRestoreCRLF = false;

        if (!content.includes(oldString)) {
            // 2. 换行符归一化后重试（核心修复：解决 \r\n vs \n 不匹配问题）
            const originalLineEnding = detectLineEnding(content);
            const normalizedContent = normalizeLineEndings(content);
            const normalizedOld = normalizeLineEndings(oldString);

            if (normalizedContent.includes(normalizedOld)) {
                searchContent = normalizedContent;
                searchOld = normalizedOld;
                searchNew = normalizeLineEndings(newString);
                needRestoreCRLF = originalLineEnding === '\r\n';
            } else {
                // 3. 尝试去除行尾空白后匹配，给出更有用的诊断信息
                const trimmedContent = normalizedContent
                    .split('\n')
                    .map((l) => l.trimEnd())
                    .join('\n');
                const trimmedOld = normalizedOld
                    .split('\n')
                    .map((l) => l.trimEnd())
                    .join('\n');

                if (trimmedContent.includes(trimmedOld)) {
                    return `错误: 未找到完全匹配的文本。去除行尾空白后可以匹配到，请检查 oldString 中是否有多余的行尾空格或制表符`;
                }

                // 4. 尝试找到最接近的匹配并给出提示
                const oldLines = normalizedOld.split('\n');
                const firstLine = oldLines[0].trim();
                if (firstLine.length > 10) {
                    const lineIdx = normalizedContent.split('\n').findIndex((l) => l.trim() === firstLine);
                    if (lineIdx >= 0) {
                        return `错误: 未找到要替换的文本。提示：在文件第 ${lineIdx + 1} 行找到了与 oldString 第一行相似的内容，但后续行不完全匹配。请使用 readFiles 工具重新读取文件以获取最新内容`;
                    }
                }

                return `错误: 未找到要替换的文本。请确保 oldString 与文件内容完全匹配（包括空白和缩进）。建议先用 readFiles 工具读取文件内容`;
            }
        }

        // 先计算总匹配数
        let totalOccurrences = 0;
        let scanIndex = 0;
        while (true) {
            const idx = searchContent.indexOf(searchOld, scanIndex);
            if (idx === -1) break;
            totalOccurrences++;
            scanIndex = idx + searchOld.length;
        }

        if (totalOccurrences < expectedReplacements) {
            return `错误: 文件中只找到 ${totalOccurrences} 处匹配，但预期替换 ${expectedReplacements} 处。请检查 oldString 是否正确`;
        }

        // 只替换前 expectedReplacements 次
        let count = 0;
        let lastIndex = 0;
        let result = '';

        while (count < expectedReplacements) {
            const index = searchContent.indexOf(searchOld, lastIndex);
            if (index === -1) break;

            result += searchContent.slice(lastIndex, index) + searchNew;
            lastIndex = index + searchOld.length;
            count++;
        }
        result += searchContent.slice(lastIndex);

        // 恢复原始换行符风格
        if (needRestoreCRLF) {
            result = result.replace(/\n/g, '\r\n');
        }

        await fs.promises.writeFile(filePath, result, 'utf8');
        return `成功替换 ${count} 处`;
    }
}

// ==================== SearchReplace 工具 ====================

const searchReplaceSchema = z.object({
    filePath: z.string().describe('要执行搜索替换操作的文件路径'),
    oldString: z.string().describe('要在文件中搜索的字符串'),
    newString: z.string().describe('替换 oldString 的新字符串')
});

export class SearchReplaceTool extends BaseTool<typeof searchReplaceSchema> {
    constructor() {
        super(
            'searchReplace',
            '在指定文件中执行单次搜索和替换操作。这是对文件进行简单文本替换的便捷工具',
            searchReplaceSchema
        );

        this.setExecutor(this.executeCommand);
    }

    getDeclaredPermissions(args: z.output<typeof searchReplaceSchema>): PermissionRequest[] {
        const p = sanitizePath(args.filePath);
        return [
            { resourceType: 'file', action: 'read', resourcePath: p },
            { resourceType: 'file', action: 'write', resourcePath: p }
        ];
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const filePath = toolcall.args_object?.['filePath'] as string | undefined;
        const oldString = toolcall.args_object?.['oldString'] as string | undefined;

        let bodyHtml = '';
        if (filePath) {
            bodyHtml += `<div class="flex items-center gap-1 text-sm text-slate-600">${openFileButton(filePath)} <span class="font-mono">${escapeHtml(filePath)}</span></div>`;
        }
        if (oldString) {
            const preview = oldString.length > 60 ? oldString.slice(0, 60) + '…' : oldString;
            bodyHtml += `<p class="mt-1 text-xs text-slate-400">搜索: <code class="bg-slate-100 px-1 py-0.5 rounded">${escapeHtml(preview)}</code></p>`;
        }

        if (toolcall.status === 'running') {
            bodyHtml += '<p class="mt-1 text-sm text-slate-400 animate-pulse">⏳ 执行中…</p>';
        } else if (toolcall.status === 'success') {
            bodyHtml += '<p class="mt-1 text-sm text-slate-500">✅ 替换完成</p>';
        } else if (toolcall.status === 'error' && toolcall.result) {
            bodyHtml += `<p class="mt-1 text-sm text-rose-600">${escapeHtml(toolcall.result)}</p>`;
        }

        return renderToolCard({
            icon: '🔍',
            title: '搜索替换',
            status: toolcall.status,
            body: bodyHtml
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const filePath = toolcall.args_object?.['filePath'];
        const oldString = toolcall.args_object?.['oldString'] as string | undefined;
        const newString = toolcall.args_object?.['newString'] as string | undefined;
        const body: string[] = [];

        if (filePath) {
            body.push(chalk.yellow(truncText(String(filePath), width - 8)));
        }

        if (oldString) {
            const preview = oldString.length > 30 ? oldString.slice(0, 30) + '…' : oldString;
            body.push(chalk.dim(`  搜索: "${preview}"`));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 执行中…'));
        } else if (toolcall.status === 'success') {
            body.push(chalk.dim('  ✅ 替换完成'));

            if (oldString && newString !== undefined) {
                const diffLines = renderDiffOutput(oldString, newString, width);
                if (diffLines.length > 0) {
                    body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
                    body.push(...diffLines);
                }
            }
        }

        return new Card({
            icon: '🔍',
            title: '搜索替换',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async executeCommand(args: z.output<typeof searchReplaceSchema>): Promise<string> {
        const filePath = sanitizePath(args.filePath);
        const { oldString, newString } = args;

        let content: string;
        try {
            content = await fs.promises.readFile(filePath, 'utf8');
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                return `错误: 文件不存在 - ${filePath}`;
            }
            throw err;
        }

        // 精确匹配优先
        let searchContent = content;
        let searchOld = oldString;
        let searchNew = newString;
        let needRestoreCRLF = false;

        if (!content.includes(oldString)) {
            // 换行符归一化后重试
            const originalLineEnding = detectLineEnding(content);
            const normalizedContent = normalizeLineEndings(content);
            const normalizedOld = normalizeLineEndings(oldString);

            if (normalizedContent.includes(normalizedOld)) {
                searchContent = normalizedContent;
                searchOld = normalizedOld;
                searchNew = normalizeLineEndings(newString);
                needRestoreCRLF = originalLineEnding === '\r\n';
            } else {
                return `错误: 未找到搜索的文本。请确保 oldString 与文件内容完全匹配`;
            }
        }

        const index = searchContent.indexOf(searchOld);
        let result = searchContent.slice(0, index) + searchNew + searchContent.slice(index + searchOld.length);

        if (needRestoreCRLF) {
            result = result.replace(/\n/g, '\r\n');
        }

        await fs.promises.writeFile(filePath, result, 'utf8');
        return `成功替换 1 处`;
    }
}

// ==================== ApplyPatch 工具 ====================

const applyPatchSchema = z.object({
    patch: z.string().describe('要应用的补丁内容。可以包含多个文件操作（添加、删除、更新）')
});

function parsePatch(patch: string): Array<{
    type: 'create' | 'delete' | 'update';
    path: string;
    content?: string;
    hunks?: Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: string[];
    }>;
}> {
    const operations: Array<{
        type: 'create' | 'delete' | 'update';
        path: string;
        content?: string;
        hunks?: Array<{
            oldStart: number;
            oldLines: number;
            newStart: number;
            newLines: number;
            lines: string[];
        }>;
    }> = [];

    const lines = patch.split('\n');
    let i = 0;

    while (i < lines.length) {
        if (lines[i].startsWith('--- ')) {
            const oldPath = lines[i].slice(4).trim();
            i++;

            if (i < lines.length && lines[i].startsWith('+++ ')) {
                const newPath = lines[i].slice(4).trim();
                i++;

                const hunks: Array<{
                    oldStart: number;
                    oldLines: number;
                    newStart: number;
                    newLines: number;
                    lines: string[];
                }> = [];

                while (i < lines.length && lines[i].startsWith('@@')) {
                    const match = lines[i].match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
                    if (match) {
                        const hunk = {
                            oldStart: parseInt(match[1]),
                            oldLines: match[2] ? parseInt(match[2]) : 1,
                            newStart: match[3] ? parseInt(match[3]) : 1,
                            newLines: match[4] ? parseInt(match[4]) : 1,
                            lines: [] as string[]
                        };
                        i++;

                        while (
                            i < lines.length &&
                            !lines[i].startsWith('@@') &&
                            !lines[i].startsWith('diff') &&
                            !lines[i].startsWith('---')
                        ) {
                            hunk.lines.push(lines[i]);
                            i++;
                        }

                        hunks.push(hunk);
                    } else {
                        i++;
                    }
                }

                let type: 'create' | 'delete' | 'update' = 'update';
                if (oldPath === '/dev/null' || oldPath === 'a/dev/null') {
                    type = 'create';
                } else if (newPath === '/dev/null' || newPath === 'b/dev/null') {
                    type = 'delete';
                }

                let actualPath = newPath.replace(/^[ab]\//, '');
                if (type === 'delete') {
                    actualPath = oldPath.replace(/^[ab]\//, '');
                }

                operations.push({ type, path: actualPath, hunks });
            }
        } else if (lines[i].startsWith('diff ')) {
            i++;
        } else {
            i++;
        }
    }

    return operations;
}

function applyHunk(
    content: string,
    hunk: {
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: string[];
    }
): string {
    const contentLines = content.split('\n');
    const result: string[] = [];
    let contentIndex = 0;

    while (contentIndex < hunk.oldStart - 1 && contentIndex < contentLines.length) {
        result.push(contentLines[contentIndex]);
        contentIndex++;
    }

    for (const line of hunk.lines) {
        if (line.startsWith(' ')) {
            const expected = line.slice(1);
            const actual = contentLines[contentIndex];
            if (actual === undefined || actual !== expected) {
                const lineNum = contentIndex + 1;
                throw new Error(
                    `上下文行不匹配（第 ${lineNum} 行）:\n` +
                        `  期望: ${JSON.stringify(expected)}\n` +
                        `  实际: ${JSON.stringify(actual ?? '<文件已结束>')}`
                );
            }
            result.push(actual);
            contentIndex++;
        } else if (line.startsWith('-')) {
            const expected = line.slice(1);
            const actual = contentLines[contentIndex];
            if (actual === undefined || actual !== expected) {
                const lineNum = contentIndex + 1;
                throw new Error(
                    `删除行不匹配（第 ${lineNum} 行）:\n` +
                        `  期望删除: ${JSON.stringify(expected)}\n` +
                        `  实际内容: ${JSON.stringify(actual ?? '<文件已结束>')}`
                );
            }
            contentIndex++;
        } else if (line.startsWith('+')) {
            result.push(line.slice(1));
        }
    }

    contentIndex = hunk.oldStart - 1 + hunk.oldLines;

    while (contentIndex < contentLines.length) {
        result.push(contentLines[contentIndex]);
        contentIndex++;
    }

    return result.join('\n');
}

export class ApplyPatchTool extends BaseTool<typeof applyPatchSchema> {
    constructor() {
        super(
            'applyPatch',
            '将 patch 补丁内容应用到代码库。支持 unified diff 格式，可以包含多个文件操作（添加、删除、更新）',
            applyPatchSchema
        );

        this.setExecutor(this.executeCommand);
    }

    getDeclaredPermissions(args: z.output<typeof applyPatchSchema>): PermissionRequest[] {
        const ops = parsePatch(args.patch);
        const permissions: PermissionRequest[] = [];
        const seen = new Set<string>();
        for (const op of ops) {
            const p = sanitizePath(op.path);
            if (op.type === 'update' || op.type === 'delete') {
                const readKey = `read:${p}`;
                if (!seen.has(readKey)) {
                    permissions.push({ resourceType: 'file', action: 'read', resourcePath: p });
                    seen.add(readKey);
                }
            }
            const writeKey = `write:${p}`;
            if (!seen.has(writeKey)) {
                permissions.push({ resourceType: 'file', action: 'write', resourcePath: p });
                seen.add(writeKey);
            }
        }
        return permissions;
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const patch = toolcall.args_object?.['patch'] as string | undefined;
        let bodyHtml = '';

        if (patch) {
            const fileCount = (patch.match(/^--- /gm) || []).length;
            const addedLines = (patch.match(/^\+[^+]/gm) || []).length;
            const removedLines = (patch.match(/^-[^-]/gm) || []).length;

            const fileMatches = patch.match(/^\+\+\+ .+$/gm) || [];
            const fileList = fileMatches
                .slice(0, 10)
                .map((l) => {
                    const fp = l
                        .slice(4)
                        .trim()
                        .replace(/^[ab]\//, '');
                    return `<li class="mt-0.5 flex items-center gap-1">${openFileButton(fp)} <span class="font-mono text-sm">${escapeHtml(fp)}</span></li>`;
                })
                .join('');
            if (fileList) {
                bodyHtml += `<ul class="list-none text-slate-600 mt-1 space-y-0.5">${fileList}</ul>`;
            }
            bodyHtml += `<p class="mt-1 text-xs text-slate-400">${fileCount} 个文件, <span class="text-rose-500">-${removedLines}</span> / <span class="text-emerald-600">+${addedLines}</span> 行</p>`;
        }

        if (toolcall.status === 'running') {
            bodyHtml += '<p class="mt-1 text-sm text-slate-400 animate-pulse">⏳ 应用补丁中…</p>';
        } else if (toolcall.status === 'success') {
            bodyHtml += `<p class="mt-1 text-sm text-slate-500">✅ 补丁已应用</p>`;
            if (toolcall.result) {
                bodyHtml += `<pre class="mt-1 text-xs text-slate-500 whitespace-pre-wrap">${escapeHtml(toolcall.result)}</pre>`;
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            bodyHtml += `<p class="mt-1 text-sm text-rose-600">${escapeHtml(toolcall.result)}</p>`;
        }

        return renderToolCard({
            icon: '🩹',
            title: '应用补丁',
            status: toolcall.status,
            body: bodyHtml
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const patch = toolcall.args_object?.['patch'] as string | undefined;
        const body: string[] = [];

        if (patch) {
            const lines = patch.split('\n');
            const fileCount = (patch.match(/^--- /gm) || []).length;
            body.push(chalk.yellow(`${fileCount} 个文件`));

            for (const line of lines.slice(0, 5)) {
                if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@')) {
                    body.push(chalk.dim('  ' + truncText(line, width - 10)));
                }
            }
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 应用补丁中…'));
        } else if (toolcall.status === 'success') {
            body.push(chalk.dim('  ✅ 补丁已应用'));
        }

        return new Card({
            icon: '🩹',
            title: '应用补丁',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async executeCommand(args: z.output<typeof applyPatchSchema>): Promise<string> {
        const { patch } = args;

        const operations = parsePatch(patch);
        if (operations.length === 0) {
            return '错误: 无法解析补丁内容，请确保使用 unified diff 格式';
        }

        const results: string[] = [];

        for (const op of operations) {
            op.path = sanitizePath(op.path);
            try {
                if (op.type === 'create') {
                    const dir = path.dirname(op.path);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }

                    let content = '';
                    if (op.hunks) {
                        for (const hunk of op.hunks) {
                            for (const line of hunk.lines) {
                                if (line.startsWith('+')) {
                                    content += line.slice(1) + '\n';
                                }
                            }
                        }
                    }

                    await fs.promises.writeFile(op.path, content, 'utf8');
                    results.push(`✅ 创建: ${op.path}`);
                } else if (op.type === 'delete') {
                    if (fs.existsSync(op.path)) {
                        await fs.promises.unlink(op.path);
                        results.push(`✅ 删除: ${op.path}`);
                    } else {
                        results.push(`⚠️ 文件不存在: ${op.path}`);
                    }
                } else if (op.type === 'update' && op.hunks) {
                    let content = await fs.promises.readFile(op.path, 'utf8');

                    const sortedHunks = [...op.hunks].sort((a, b) => b.oldStart - a.oldStart);
                    for (const hunk of sortedHunks) {
                        content = applyHunk(content, hunk);
                    }

                    await fs.promises.writeFile(op.path, content, 'utf8');
                    results.push(`✅ 更新: ${op.path}`);
                }
            } catch (err: any) {
                results.push(`❌ 失败: ${op.path} - ${err.message}`);
            }
        }

        return results.join('\n');
    }
}

// ==================== Glob 工具 ====================

const DEFAULT_GLOB_IGNORE = [
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    '.next/**',
    '.nuxt/**',
    '__pycache__/**',
    '.cache/**',
    'coverage/**',
    '.tsbuildinfo'
];

const globSchema = z.object({
    pattern: z
        .string()
        .describe('glob 模式，如 **/*.ts、src/**/*.js、*.md 等。不以 **/ 开头的模式会自动加上 **/ 前缀以递归搜索'),
    path: z.string().optional().describe('搜索根目录，默认为当前工作目录'),
    ignore: z
        .array(z.string())
        .optional()
        .describe('额外的忽略模式列表（默认已忽略 node_modules, .git, dist, build 等）'),
    caseSensitive: z.boolean().default(false).describe('是否区分大小写，默认 false'),
    maxResults: z.number().min(1).max(1000).default(200).describe('最大返回结果数，默认 200')
});

export class GlobFilesTool extends BaseTool<typeof globSchema> {
    constructor() {
        super(
            'globFiles',
            '使用 glob 模式搜索文件。支持通配符如 *、**、? 等。例如：**/*.ts 搜索所有 TypeScript 文件，src/**/*.js 搜索 src 目录下所有 JS 文件。不以 **/ 开头的简单模式（如 *.ts）会自动递归搜索',
            globSchema
        );

        this.setExecutor(this.executeCommand);
    }

    getDeclaredPermissions(args: z.output<typeof globSchema>): PermissionRequest[] {
        const searchPath = args.path ? sanitizePath(args.path) : process.cwd();
        return [{ resourceType: 'file', action: 'read', resourcePath: searchPath + '/**' }];
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const pattern = toolcall.args_object?.['pattern'];
        const searchPath = toolcall.args_object?.['path'];
        const ignore = toolcall.args_object?.['ignore'] as string[] | undefined;
        const body: string[] = [];

        if (pattern) {
            body.push(chalk.cyan('模式: ') + chalk.white(String(pattern)));
        }

        if (searchPath) {
            body.push(chalk.dim('目录: ') + truncText(String(searchPath), width - 12));
        }

        if (ignore && ignore.length > 0) {
            body.push(chalk.dim('忽略: ') + ignore.slice(0, 3).join(', ') + (ignore.length > 3 ? '…' : ''));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  🔍 搜索中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            const lines = toolcall.result.split('\n');
            const count = lines.filter((l) => l.trim() && !l.startsWith('找到')).length;
            const foundMatch = toolcall.result.match(/找到 (\d+) 个文件/);
            const fileCount = foundMatch ? foundMatch[1] : count;
            body.push(chalk.dim('  ✅ 找到 ') + chalk.green(fileCount) + chalk.dim(' 个文件'));

            const files = lines.filter((l) => l.trim() && !l.startsWith('找到'));
            for (const file of files.slice(0, 5)) {
                body.push(chalk.dim('    ') + truncText(file, width - 8));
            }
            if (files.length > 5) {
                body.push(chalk.dim(`    … 共 ${files.length} 个结果`));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.red(`  ✗ ${truncText(String(toolcall.result), width - 10)}`));
        }

        return new Card({
            icon: '🔍',
            title: '模式匹配 | Glob',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const pattern = toolcall.args_object?.['pattern'];
        const searchPath = toolcall.args_object?.['path'];

        let bodyHtml = '';
        if (pattern) {
            bodyHtml += `<p class="text-sm text-slate-600">模式: <code class="bg-slate-100 px-2 py-0.5 rounded font-mono">${escapeHtml(String(pattern))}</code></p>`;
        }
        if (searchPath) {
            bodyHtml += `<p class="mt-1 text-xs text-slate-400">目录: ${escapeHtml(String(searchPath))}</p>`;
        }

        if (toolcall.status === 'running') {
            bodyHtml += '<p class="mt-2 text-sm text-slate-400 animate-pulse">🔍 搜索中…</p>';
        } else if (toolcall.status === 'success' && toolcall.result) {
            const { text, truncated } = truncateContent(toolcall.result);
            bodyHtml += `<div class="mt-2 rounded-lg border border-slate-200 bg-slate-50/80 p-3 text-sm overflow-x-auto max-h-64 overflow-y-auto"><pre class="whitespace-pre-wrap break-words font-mono text-slate-800 text-xs">${escapeHtml(text)}</pre></div>`;
            if (truncated) {
                bodyHtml += '<p class="mt-1 text-xs text-amber-600">… 结果已截断</p>';
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            bodyHtml += `<p class="mt-2 text-sm text-rose-600">${escapeHtml(toolcall.result)}</p>`;
        }

        return renderToolCard({
            icon: '🔍',
            title: '模式匹配 | Glob',
            status: toolcall.status,
            body: bodyHtml
        });
    }

    async executeCommand(args: z.output<typeof globSchema>): Promise<string> {
        let { pattern, path: searchPath, ignore, caseSensitive, maxResults } = args;

        if (!pattern || pattern.trim() === '') {
            return '错误: 请提供 glob 模式';
        }

        if (searchPath) {
            searchPath = sanitizePath(searchPath);
        }

        // 自动为非递归模式添加 **/ 前缀
        pattern = pattern.trim();
        if (!pattern.startsWith('**/') && !pattern.includes('/')) {
            pattern = '**/' + pattern;
        }

        try {
            const ignorePatterns = [...DEFAULT_GLOB_IGNORE, ...(ignore || [])];

            const options: fastGlob.Options = {
                cwd: searchPath || process.cwd(),
                ignore: ignorePatterns,
                caseSensitiveMatch: caseSensitive,
                absolute: true,
                onlyFiles: true,
                followSymbolicLinks: false,
                suppressErrors: true
            };

            let files = await fastGlob(pattern, options);

            // Windows NTFS 不区分大小写，需要在应用层二次过滤
            if (caseSensitive && process.platform === 'win32') {
                const patternToMatch = pattern.replace(/\*\*\//g, '');
                const extMatch = patternToMatch.match(/\.\w+$/);
                if (extMatch) {
                    const ext = extMatch[0];
                    files = files.filter((f) => f.endsWith(ext));
                }
            }

            if (files.length === 0) {
                return '未找到匹配的文件';
            }

            // 将绝对路径转为相对于搜索目录的路径，统一使用正斜杠
            const basePath = searchPath || process.cwd();
            const displayFiles = files.slice(0, maxResults).map((f) => {
                const rel = path.relative(basePath, f);
                return toForwardSlash(rel.startsWith('..') ? f : rel);
            });

            const result = displayFiles.join('\n');

            if (files.length > maxResults) {
                return `找到 ${files.length} 个文件（显示前 ${maxResults} 个）:\n\n${result}\n\n… 还有 ${files.length - maxResults} 个文件未显示`;
            }

            return `找到 ${files.length} 个文件:\n\n${result}`;
        } catch (err: any) {
            return `搜索失败: ${err.message}`;
        }
    }
}

// ==================== Grep 工具 ====================

const DEFAULT_GREP_IGNORE = [
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    '*.min.js',
    '*.min.css',
    '*.map',
    '*.lock',
    '.next/**',
    '.nuxt/**',
    '__pycache__/**',
    '.cache/**',
    'coverage/**'
];

const grepSchema = z.object({
    pattern: z.string().describe('要搜索的正则表达式模式'),
    path: z.string().optional().describe('搜索路径，可以是文件或目录，默认为当前工作目录'),
    filePattern: z.string().optional().describe('文件名 glob 模式，如 *.ts、**/*.js，默认搜索所有文件'),
    ignoreCase: z.boolean().default(true).describe('是否忽略大小写，默认 true'),
    maxResults: z.number().min(1).max(500).default(50).describe('最大返回结果数，默认 50'),
    contextLines: z.number().min(0).max(5).default(2).describe('显示匹配行的上下文行数，默认 2')
});

interface GrepMatch {
    file: string;
    line: number;
    column: number;
    content: string;
    contextBefore: string[];
    contextAfter: string[];
}

export class GrepFilesTool extends BaseTool<typeof grepSchema> {
    constructor() {
        super(
            'grepFiles',
            '在文件内容中搜索文本模式。支持正则表达式。例如：搜索 "TODO" 查找所有待办事项，搜索 "function\\s+\\w+" 查找所有函数定义',
            grepSchema
        );

        this.setExecutor(this.executeCommand);
    }

    getDeclaredPermissions(args: z.output<typeof grepSchema>): PermissionRequest[] {
        const searchPath = args.path ? sanitizePath(args.path) : process.cwd();
        return [
            {
                resourceType: 'file',
                action: 'read',
                resourcePath: searchPath.includes('.') && !searchPath.endsWith('/') ? searchPath : searchPath + '/**'
            }
        ];
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const pattern = toolcall.args_object?.['pattern'];
        const searchPath = toolcall.args_object?.['path'];
        const filePattern = toolcall.args_object?.['filePattern'];
        const ignoreCase = toolcall.args_object?.['ignoreCase'];
        const body: string[] = [];

        if (pattern) {
            body.push(chalk.cyan('模式: ') + chalk.white(String(pattern)));
        }

        if (searchPath) {
            body.push(chalk.dim('路径: ') + truncText(String(searchPath), width - 12));
        }

        if (filePattern) {
            body.push(chalk.dim('文件: ') + String(filePattern));
        }

        if (ignoreCase === false) {
            body.push(chalk.dim('选项: 区分大小写'));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  🔍 搜索中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            const lines = toolcall.result.split('\n');

            // 从第一行统计摘要提取数据: "在 X 个文件中找到 Y 处匹配:"
            const summaryMatch = lines[0]?.match(/在 (\d+) 个文件中找到 (\d+) 处匹配/);
            if (summaryMatch) {
                body.push(
                    chalk.dim('  ✅ 在 ') +
                        chalk.green(summaryMatch[1]) +
                        chalk.dim(' 个文件中找到 ') +
                        chalk.green(summaryMatch[2]) +
                        chalk.dim(' 处匹配')
                );
            }

            // 显示匹配行（以 > 开头的是匹配行）
            const matchLines = lines.filter((l) => l.startsWith('> '));
            for (const m of matchLines.slice(0, 5)) {
                body.push(chalk.dim('    ') + truncText(m, width - 8));
            }
            if (matchLines.length > 5) {
                body.push(chalk.dim(`    … 共 ${matchLines.length} 个结果`));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.red(`  ✗ ${truncText(String(toolcall.result), width - 10)}`));
        }

        return new Card({
            icon: '🔎',
            title: '内容搜索 | Grep',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const pattern = toolcall.args_object?.['pattern'];
        const searchPath = toolcall.args_object?.['path'];
        const filePattern = toolcall.args_object?.['filePattern'];

        let bodyHtml = '';
        if (pattern) {
            bodyHtml += `<p class="text-sm text-slate-600">模式: <code class="bg-slate-100 px-2 py-0.5 rounded font-mono">${escapeHtml(String(pattern))}</code></p>`;
        }
        if (searchPath) {
            bodyHtml += `<p class="mt-1 text-xs text-slate-400">路径: ${escapeHtml(String(searchPath))}</p>`;
        }
        if (filePattern) {
            bodyHtml += `<p class="mt-1 text-xs text-slate-400">文件: ${escapeHtml(String(filePattern))}</p>`;
        }

        if (toolcall.status === 'running') {
            bodyHtml += '<p class="mt-2 text-sm text-slate-400 animate-pulse">🔎 搜索中…</p>';
        } else if (toolcall.status === 'success' && toolcall.result) {
            const { text, truncated } = truncateContent(toolcall.result);
            bodyHtml += `<div class="mt-2 rounded-lg border border-slate-200 bg-slate-50/80 p-3 text-sm overflow-x-auto max-h-64 overflow-y-auto"><pre class="whitespace-pre-wrap break-words font-mono text-slate-800 text-xs">${escapeHtml(text)}</pre></div>`;
            if (truncated) {
                bodyHtml += '<p class="mt-1 text-xs text-amber-600">… 结果已截断</p>';
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            bodyHtml += `<p class="mt-2 text-sm text-rose-600">${escapeHtml(toolcall.result)}</p>`;
        }

        return renderToolCard({
            icon: '🔎',
            title: '内容搜索 | Grep',
            status: toolcall.status,
            body: bodyHtml
        });
    }

    async executeCommand(args: z.output<typeof grepSchema>): Promise<string> {
        const { pattern, path: searchPath, filePattern, ignoreCase, maxResults, contextLines } = args;

        if (!pattern || pattern.trim() === '') {
            return '错误: 请提供搜索模式';
        }

        try {
            const regexFlags = ignoreCase ? 'gi' : 'g';
            let regex: RegExp;
            try {
                regex = new RegExp(pattern, regexFlags);
            } catch (e: any) {
                return `错误: 无效的正则表达式 - ${e.message}`;
            }

            const basePath = searchPath ? sanitizePath(searchPath) : process.cwd();

            // 单文件搜索快速路径
            let filesToSearch: string[];
            try {
                const stat = await fs.promises.stat(basePath);
                if (stat.isFile()) {
                    filesToSearch = [basePath];
                } else {
                    const globPattern = filePattern || '**/*';
                    filesToSearch = await fastGlob(globPattern, {
                        cwd: basePath,
                        ignore: DEFAULT_GREP_IGNORE,
                        absolute: true,
                        onlyFiles: true,
                        suppressErrors: true
                    });
                }
            } catch {
                const globPattern = filePattern || '**/*';
                filesToSearch = await fastGlob(globPattern, {
                    cwd: basePath,
                    ignore: DEFAULT_GREP_IGNORE,
                    absolute: true,
                    onlyFiles: true,
                    suppressErrors: true
                });
            }

            const matches: GrepMatch[] = [];

            const searchFile = async (filePath: string): Promise<GrepMatch[]> => {
                const fileMatches: GrepMatch[] = [];

                try {
                    // 预检测二进制文件：读取文件头判断
                    const fd = await fs.promises.open(filePath, 'r');
                    const headBuf = Buffer.alloc(512);
                    let bytesRead: number;
                    try {
                        const readResult = await fd.read(headBuf, 0, 512, 0);
                        bytesRead = readResult.bytesRead;
                    } finally {
                        await fd.close();
                    }
                    if (bytesRead > 0 && hasBinaryContent(headBuf.subarray(0, bytesRead))) {
                        return fileMatches;
                    }

                    const content = await fs.promises.readFile(filePath, 'utf-8');
                    const lines = content.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        regex.lastIndex = 0;

                        let match;
                        while ((match = regex.exec(line)) !== null) {
                            fileMatches.push({
                                file: filePath,
                                line: i + 1,
                                column: match.index + 1,
                                content: line,
                                contextBefore: lines.slice(Math.max(0, i - contextLines), i),
                                contextAfter: lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines))
                            });

                            if (fileMatches.length >= maxResults) break;

                            // 防止零宽匹配导致无限循环
                            if (match[0].length === 0) {
                                regex.lastIndex++;
                            }
                        }

                        regex.lastIndex = 0;
                        if (fileMatches.length >= maxResults) break;
                    }
                } catch {
                    // 跳过无法读取的文件
                }

                return fileMatches;
            };

            const batchSize = 20;
            for (let i = 0; i < filesToSearch.length && matches.length < maxResults; i += batchSize) {
                const batch = filesToSearch.slice(i, i + batchSize);
                const batchResults = await Promise.all(batch.map(searchFile));
                matches.push(...batchResults.flat());

                if (matches.length >= maxResults) {
                    matches.length = maxResults;
                    break;
                }
            }

            if (matches.length === 0) {
                return '未找到匹配的内容';
            }

            const output: string[] = [];
            let currentFile = '';
            const displayBasePath = searchPath || process.cwd();

            // 去重：同一文件同一行只输出一次，合并列号
            let lastFile = '';
            let lastLine = -1;
            for (const match of matches) {
                if (match.file !== currentFile) {
                    currentFile = match.file;
                    lastLine = -1;
                    const relPath = path.relative(displayBasePath, match.file);
                    output.push(`\n${toForwardSlash(relPath.startsWith('..') ? match.file : relPath)}`);
                }

                if (match.line === lastLine && match.file === lastFile) {
                    continue;
                }
                lastFile = match.file;
                lastLine = match.line;

                if (contextLines > 0 && match.contextBefore.length > 0) {
                    for (let j = 0; j < match.contextBefore.length; j++) {
                        const lineNum = match.line - match.contextBefore.length + j;
                        output.push(`  ${lineNum} | ${match.contextBefore[j]}`);
                    }
                }

                output.push(`> ${match.line} | ${match.content}`);

                if (contextLines > 0 && match.contextAfter.length > 0) {
                    for (let j = 0; j < match.contextAfter.length; j++) {
                        const lineNum = match.line + 1 + j;
                        output.push(`  ${lineNum} | ${match.contextAfter[j]}`);
                    }
                }
            }

            const fileCount = new Set(matches.map((m) => m.file)).size;
            output.unshift(`在 ${fileCount} 个文件中找到 ${matches.length} 处匹配:`);

            return output.join('\n');
        } catch (err: any) {
            return `搜索失败: ${err.message}`;
        }
    }
}

// ==================== 工具集工厂函数 ====================

export function createFileManagerToolset(): BaseToolset {
    const toolset = new BaseToolset('filemgr');
    toolset.addTool(new ReadFilesTool());
    toolset.addTool(new WriteFileTool());
    toolset.addTool(new EditFileTool());
    toolset.addTool(new SearchReplaceTool());
    toolset.addTool(new ApplyPatchTool());
    toolset.addTool(new GlobFilesTool());
    toolset.addTool(new GrepFilesTool());
    return toolset;
}
