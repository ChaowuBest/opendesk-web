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

import { BaseTool, BaseToolset, ToolResult } from '../../aikernel/tool';
import { ToolCall, UserMessage, marked } from '../../aikernel/messages';
import { LLM } from '../../aikernel/llm.js';
import { escapeHtml } from '../../../common/utils/escape.js';
import { Card } from '../../tui/components/card';
import { t } from '../../../locale/index.js';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { z } from 'zod';
import { detectEncoding, decodeBuffer, encodingDisplayName, HEAD_BYTES } from '../terminal/encoding.js';
import type { PermissionRequest } from '../../aikernel/security/permission';
import type { TaskState } from '../../aikernel/states/tasks';
import { Setting } from '../../utils/setting.js';
import { getTempDir, getHomeDir } from '../../utils/temp.js';
import { cleanPathInput } from '../../../utils/path.js';
import { EXTRACT_TEXT_SUPPORTED_EXTENSIONS, isExtractTextSupported } from './parser/extract.js';
import { ImageSourceError, isOnlineImageSource, loadImageSource } from './image.js';
import { FILEMGR_SEARCH_MAX_PATHS } from './search/indexed.js';
import fs from 'fs';
import path from 'path';
import * as diff from 'diff';
import fileType from 'file-type';
import chalk from 'chalk';
import fastGlob from 'fast-glob';

const MAX_DIFF_LINES = 50;
const RENDER_CONTENT_MAX_CHARS = 4000;
const RENDER_CONTENT_MAX_LINES = 80;
const DIFF_CONTEXT_LINES = 3;

export const ENFORCE_FILE_READ_BEFORE_WRITE = false;

export type FileReadValidationFailureReason = 'not_read' | 'partial_view' | 'modified_since_read';

export type FileReadValidationResult =
    { ok: true } | { ok: false; reason: FileReadValidationFailureReason; message: string };

function getWorkingDirectory(taskState?: TaskState): string {
    return taskState?.getWorkspace() || Setting.getInstance().getEffectiveWorkspace();
}

// ==================== 路径处理 ====================

/**
 * 修复被 JSON 转义序列污染的 Windows 路径。
 * AI 模型在 JSON 中输出 Windows 路径时，\t \n \b \f \r 会被 JSON.parse 解释为
 * 控制字符（tab、换行、退格、换页、回车），导致路径损坏。
 * 此函数将这些控制字符还原为对应的反斜杠字母组合，然后统一使用正斜杠。
 */
/**
 * 将 MSYS2/Git Bash 风格的路径（如 /c/Projects/...）转换为 Windows 原生路径（如 C:/Projects/...）。
 *
 * 在 Git Bash (MSYS2) 环境下，process.cwd() 返回 /c/Projects/... 形式的路径。
 * Node.js 的 path.resolve() 在 Windows 上会将 /c/Projects/... 解释为相对于当前驱动器
 * 根目录的路径，产生 C:\c\Projects\...（双重前缀），因此需要先转换。
 */
function fromMsysPath(p: string): string {
    if (process.platform !== 'win32') return p;
    // 匹配 /c/、/d/ 等单字母驱动器前缀（MSYS2 风格）
    return p.replace(/^\/([a-zA-Z])\//, (_, letter) => `${letter.toUpperCase()}:/`);
}

function sanitizePath(inputPath: string, basePath?: string): string {
    if (!inputPath || typeof inputPath !== 'string') return '';

    // 清理不可见的 Unicode 字符和首尾空白，避免 path.resolve 误判绝对路径为相对路径
    let p = cleanPathInput(inputPath)
        .replace(/\x08/g, '\\b')
        .replace(/\x09/g, '\\t')
        .replace(/\x0A/g, '\\n')
        .replace(/\x0C/g, '\\f')
        .replace(/\x0D/g, '\\r');

    // 展开 ~ 为用户主目录
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
        p = getHomeDir() + p.slice(1);
    }

    // 将 MSYS2/Git Bash 风格路径转换为 Windows 原生路径，避免 path.resolve 产生双重前缀
    p = fromMsysPath(p);

    // 将相对路径解析为绝对路径，确保权限检查时能与工作空间规则正确匹配
    p = basePath ? path.resolve(basePath, p) : path.resolve(p);

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
            // 统一前缀宽度：确保 removed/added/context 行内容起始位置一致

            if (line.type === 'removed') {
                const lineNum = String(line.oldNum || '').padEnd(lineNumWidth);
                const fillSpaces = ' '.repeat(lineNumWidth);
                const prefixWidth = lineNumWidth + lineNumWidth + 2;
                const contentMaxWidth = width - 4 - prefixWidth;
                const truncated = truncText(line.content, contentMaxWidth);
                const fullLine = lineNum + fillSpaces + '- ' + truncated;
                const paddedLine = truncateToWidth(fullLine, width - 4, '', true);
                body.push(chalk.bgRgb(255, 230, 230)(chalk.rgb(180, 60, 60)(paddedLine)));
            } else if (line.type === 'added') {
                const lineNum = String(line.newNum || '').padEnd(lineNumWidth);
                const fillSpaces = ' '.repeat(lineNumWidth);
                const prefixWidth = lineNumWidth + lineNumWidth + 2;
                const contentMaxWidth = width - 4 - prefixWidth;
                const truncated = truncText(line.content, contentMaxWidth);
                const fullLine = lineNum + fillSpaces + '+ ' + truncated;
                const paddedLine = truncateToWidth(fullLine, width - 4, '', true);
                body.push(chalk.bgRgb(230, 255, 230)(chalk.rgb(40, 140, 40)(paddedLine)));
            } else {
                const oldNumStr = String(line.oldNum || '').padEnd(lineNumWidth);
                const newNumStr = String(line.newNum || '').padEnd(lineNumWidth);
                const prefixWidth = lineNumWidth + 1 + lineNumWidth;
                const truncatedContent = truncText(line.content, width - 4 - prefixWidth - 1);
                body.push(chalk.dim(oldNumStr + ' ' + newNumStr + ' ' + truncatedContent));
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

function trimTrailingWhitespace(text: string): string {
    return text.replace(/[^\S\n\r]+$/gm, '');
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

/** Badge that opens the file with the system default application (data-open-file). */
function openFileBadge(filePath: string): string {
    return `<span class="bg-blue-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded leading-none cursor-pointer hover:bg-blue-600 transition-colors" data-open-file="${escapeHtml(filePath)}">${escapeHtml(t('filemgr.openWithDefault'))}</span>`;
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
    <div class="rounded-xl border border-slate-200 bg-white/90 shadow-sm overflow-hidden my-1">
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

/**
 * 行内工具渲染：图标 + 标题 + 状态点 + 关键信息，紧凑单行风格
 */
function renderInlineTool(opts: {
    icon: string;
    title: string;
    status: string;
    className?: string;
    detail?: string;
    detailTitle?: string;
    fileList?: string[];
    body?: string;
    /** 如果提供，detail 中的文件路径部分会渲染为可点击链接 */
    editorFilePath?: string;
    /** 点击跳转到的行号 */
    editorLine?: number;
}): string {
    const statusIcon =
        opts.status === 'running'
            ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
            : opts.status === 'error'
              ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
              : '';

    let detailHtml = '';
    if (opts.detail) {
        if (opts.editorFilePath) {
            const lineAttr = opts.editorLine != null ? ` data-editor-line="${opts.editorLine}"` : '';
            detailHtml = `<span class="truncate text-xs text-slate-600" ${opts.detailTitle ? `title="${escapeHtml(opts.detailTitle)}"` : ''}><a class="text-slate-600 hover:text-slate-800 hover:underline cursor-pointer" data-open-editor="${escapeHtml(opts.editorFilePath)}"${lineAttr}>${opts.detail}</a></span>`;
        } else {
            detailHtml = `<span class="truncate text-xs text-slate-600" ${opts.detailTitle ? `title="${escapeHtml(opts.detailTitle)}"` : ''}>${opts.detail}</span>`;
        }
    }

    const fileListHtml =
        opts.fileList && opts.fileList.length > 0
            ? `<div class="ml-5 mt-0.5 text-xs text-slate-500 space-y-0">${opts.fileList
                  .slice(0, 12)
                  .map((f) => `<div class="truncate" title="${escapeHtml(f)}">${escapeHtml(f)}</div>`)
                  .join(
                      ''
                  )}${opts.fileList.length > 12 ? `<div class="text-slate-400">… 共 ${opts.fileList.length} 个文件</div>` : ''}</div>`
            : '';

    const bodyHtml = opts.body ? `<div class="ml-5 mt-1">${opts.body}</div>` : '';
    const className = opts.className ? ` ${escapeHtml(opts.className)}` : '';

    return `<div class="od-inline-toolcall-container${className}">
        <div class="flex items-center gap-1.5 min-w-0">
            <i class="${opts.icon} shrink-0 text-slate-400 text-xs"></i>
            <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(opts.title)}</span>
            ${statusIcon}
            ${detailHtml}
        </div>
        ${fileListHtml}
        ${bodyHtml}
    </div>`;
}

/** File extensions whose content can be live-previewed in the renderer via shadow DOM */
const PREVIEW_FILE_EXTS = new Set(['.html', '.htm', '.svg']);

/**
 * Check whether a file path has a previewable extension.
 */
function isPreviewableFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return PREVIEW_FILE_EXTS.has(ext);
}

/**
 * Map file extension to the preview language identifier used by the renderer.
 */
function getPreviewLang(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase().slice(1);
    if (ext === 'htm') return 'html';
    return ext;
}

/**
 * Render a detailed-card-style tool call with an embedded live preview.
 * The actual shadow DOM rendering happens in the renderer's previewer.ts;
 * here we output the card HTML with base64-encoded content in a data attribute.
 */
function renderPreviewCard(opts: {
    icon: string;
    title: string;
    status: string;
    filePath: string;
    content: string;
    detail?: string;
}): string {
    const fileName = path.basename(opts.filePath);
    const lang = getPreviewLang(opts.filePath);
    const rawB64 = Buffer.from(opts.content).toString('base64');
    const baseDir = path.dirname(path.resolve(opts.filePath));
    const statusBadge =
        opts.status === 'running'
            ? `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-500"><i class="fa-solid fa-circle-notch fa-spin text-[8px]"></i>执行中</span>`
            : opts.status === 'error'
              ? `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-50 text-red-500"><i class="fa-solid fa-circle-xmark text-[8px]"></i>失败</span>`
              : '';
    const borderColor = opts.status === 'error' ? 'border-red-200' : 'border-gray-200';
    const detailHtml = opts.detail ? ` · ${escapeHtml(opts.detail)}` : '';
    const editorBadge = `<span class="bg-slate-400 text-white text-[10px] font-bold px-1.5 py-0.5 rounded leading-none cursor-pointer hover:bg-slate-500 transition-colors" data-open-editor="${escapeHtml(opts.filePath)}">${escapeHtml(t('filemgr.openInEditor'))}</span>`;
    const openBadge = openFileBadge(opts.filePath);

    return `<details class="file-tool-card od-card-shadow my-2 rounded-[14px] border ${borderColor} bg-white overflow-hidden w-full" open>
        <summary class="flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150 font-medium">
            <span class="inline-flex items-center justify-center w-5 h-5 rounded bg-blue-50 text-blue-400">
                <i class="${opts.icon} text-[10px]"></i>
            </span>
            <span class="text-[12px] text-gray-500 shrink-0">${escapeHtml(opts.title)}</span>
            <span class="text-[12px] text-gray-600 truncate flex-1" title="${escapeHtml(opts.filePath)}">${escapeHtml(fileName)}${detailHtml}</span>
            ${statusBadge}
            ${editorBadge}
            ${openBadge}
            <svg class="w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
        </summary>
        <div class="border-t border-gray-200 bg-gray-50/40">
            <div class="tool-preview-card" data-preview-lang="${lang}" data-raw-code="${rawB64}" data-base-dir="${escapeHtml(baseDir)}"></div>
        </div>
    </details>`;
}

/**
 * Render a placeholder card shown while a previewable file is being written.
 * Unlike renderPreviewCard, this does NOT include base64-encoded content or
 * data-preview-lang/data-raw-code attributes, so the renderer will skip
 * creating a shadow DOM preview and simply show the "generating" indicator.
 * Once the file write completes (status === 'success'), renderPreviewCard
 * replaces this placeholder with the full preview.
 */
function renderPreviewPlaceholder(opts: { icon: string; title: string; filePath: string }): string {
    const fileName = path.basename(opts.filePath);
    const editorBadge = `<span class="bg-slate-400 text-white text-[10px] font-bold px-1.5 py-0.5 rounded leading-none cursor-pointer hover:bg-slate-500 transition-colors" data-open-editor="${escapeHtml(opts.filePath)}">${escapeHtml(t('filemgr.openInEditor'))}</span>`;
    const openBadge = openFileBadge(opts.filePath);

    return `<details class="file-tool-card od-card-shadow my-2 rounded-[14px] border border-gray-200 bg-white overflow-hidden w-full" open>
        <summary class="flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150 font-medium">
            <span class="inline-flex items-center justify-center w-5 h-5 rounded bg-blue-50 text-blue-400">
                <i class="${opts.icon} text-[10px]"></i>
            </span>
            <span class="text-[12px] text-gray-500 shrink-0">${escapeHtml(opts.title)}</span>
            <span class="text-[12px] text-gray-600 truncate flex-1" title="${escapeHtml(opts.filePath)}">${escapeHtml(fileName)}</span>
            <span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-500"><i class="fa-solid fa-circle-notch fa-spin text-[8px]"></i>${escapeHtml(t('filemgr.generating'))}</span>
            ${editorBadge}
            ${openBadge}
            <svg class="w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
        </summary>
        <div class="border-t border-gray-200 bg-gray-50/40">
            <div class="flex items-center justify-center py-8 text-gray-400 gap-2">
                <i class="fa-solid fa-file-pen text-lg"></i>
                <span class="text-[13px]">${escapeHtml(t('filemgr.generatingPlaceholder'))}</span>
            </div>
        </div>
    </details>`;
}

const FILE_EXT_LABELS: Record<string, { label: string; color: string }> = {
    ts: { label: 'TS', color: 'bg-blue-500' },
    tsx: { label: 'TSX', color: 'bg-blue-500' },
    js: { label: 'JS', color: 'bg-yellow-500' },
    jsx: { label: 'JSX', color: 'bg-yellow-500' },
    py: { label: 'PY', color: 'bg-green-600' },
    rs: { label: 'RS', color: 'bg-orange-600' },
    go: { label: 'GO', color: 'bg-cyan-600' },
    java: { label: 'JV', color: 'bg-red-500' },
    rb: { label: 'RB', color: 'bg-red-600' },
    css: { label: 'CSS', color: 'bg-purple-500' },
    scss: { label: 'CSS', color: 'bg-purple-500' },
    html: { label: 'HTML', color: 'bg-orange-500' },
    vue: { label: 'VUE', color: 'bg-emerald-500' },
    svelte: { label: 'SV', color: 'bg-orange-600' },
    json: { label: 'JSON', color: 'bg-gray-500' },
    yaml: { label: 'YML', color: 'bg-gray-500' },
    yml: { label: 'YML', color: 'bg-gray-500' },
    md: { label: 'MD', color: 'bg-gray-500' },
    sh: { label: 'SH', color: 'bg-gray-600' },
    sql: { label: 'SQL', color: 'bg-blue-600' },
    c: { label: 'C', color: 'bg-blue-700' },
    cpp: { label: 'C++', color: 'bg-blue-700' },
    h: { label: 'H', color: 'bg-blue-700' },
    swift: { label: 'SW', color: 'bg-orange-500' },
    kt: { label: 'KT', color: 'bg-purple-600' }
};

function getFileExtBadge(filePath: string): string {
    const ext = path.extname(filePath).replace('.', '').toLowerCase();
    const info = FILE_EXT_LABELS[ext];
    if (info) {
        return `<span class="${info.color} text-white text-[10px] font-bold px-1.5 py-0.5 rounded leading-none">${info.label}</span>`;
    }
    if (ext) {
        return `<span class="bg-gray-400 text-white text-[10px] font-bold px-1.5 py-0.5 rounded leading-none">${ext.toUpperCase().slice(0, 4)}</span>`;
    }
    return '';
}

/**
 * 渲染 Cursor 风格的文件编辑 diff 卡片
 */
function renderDiffCard(
    filePath: string,
    oldStr: string,
    newStr: string,
    status: string,
    maxLines: number = 12
): string {
    const diffResult = diff.diffLines(oldStr, newStr);

    let addedCount = 0;
    let removedCount = 0;
    const diffRows: Array<{ html: string; changed: boolean }> = [];
    let totalLines = 0;

    for (const part of diffResult) {
        const partLines = part.value.replace(/\n$/, '').split('\n');
        for (const line of partLines) {
            const ln = totalLines + 1;
            const escaped = escapeHtml(line) || '&nbsp;';
            let lineHtml: string;
            let changed = false;
            if (part.added) {
                addedCount++;
                changed = true;
                lineHtml = `<tr class="diff-row-add"><td class="diff-ln text-right px-2 py-px select-none border-r border-emerald-100 text-slate-400 w-[1px] whitespace-nowrap bg-emerald-50/60">${ln}</td><td class="diff-marker text-center px-1 py-px select-none border-r border-emerald-100 text-emerald-500 w-[1px] whitespace-nowrap bg-emerald-50">+</td><td class="diff-code whitespace-pre px-2 py-px text-emerald-800 bg-emerald-50">${escaped}</td></tr>`;
            } else if (part.removed) {
                removedCount++;
                changed = true;
                lineHtml = `<tr class="diff-row-del"><td class="diff-ln text-right px-2 py-px select-none border-r border-rose-100 text-slate-400 w-[1px] whitespace-nowrap bg-rose-50/60">${ln}</td><td class="diff-marker text-center px-1 py-px select-none border-r border-rose-100 text-rose-400 w-[1px] whitespace-nowrap bg-rose-50">-</td><td class="diff-code whitespace-pre px-2 py-px text-rose-800 bg-rose-50">${escaped}</td></tr>`;
            } else {
                lineHtml = `<tr class="diff-row-ctx"><td class="diff-ln text-right px-2 py-px select-none border-r border-slate-100 text-slate-300 w-[1px] whitespace-nowrap">${ln}</td><td class="diff-marker text-center px-1 py-px select-none border-r border-slate-100 text-slate-300 w-[1px] whitespace-nowrap">&nbsp;</td><td class="diff-code whitespace-pre px-2 py-px text-slate-500">${escaped}</td></tr>`;
            }
            diffRows.push({ html: lineHtml, changed });
            totalLines++;
        }
    }

    const previewLimit = Math.max(1, maxLines);
    const firstChangedIndex = diffRows.findIndex((row) => row.changed);
    const previewStart =
        diffRows.length > previewLimit && firstChangedIndex >= previewLimit
            ? Math.max(0, firstChangedIndex - Math.floor(previewLimit / 3))
            : 0;
    const previewEnd = Math.min(diffRows.length, previewStart + previewLimit);
    const visibleLines = diffRows.slice(previewStart, previewEnd).map((row) => row.html);
    const hiddenBeforeLines = diffRows.slice(0, previewStart).map((row) => row.html);
    const hiddenAfterLines = diffRows.slice(previewEnd).map((row) => row.html);
    const truncated = hiddenBeforeLines.length > 0 || hiddenAfterLines.length > 0;
    const expandLabel = t('filemgr.diff.expand', { count: totalLines });
    const collapseLabel = t('filemgr.diff.collapse');
    const fileName = path.basename(filePath);
    const editBadge = `<span class="bg-slate-400 text-white text-[10px] font-bold px-1.5 py-0.5 rounded leading-none cursor-pointer hover:bg-slate-500 transition-colors" data-open-editor="${escapeHtml(filePath)}">${escapeHtml(t('filemgr.openInEditor'))}</span>`;
    const openBadge = openFileBadge(filePath);
    const statsHtml = `<span class="text-emerald-600 font-medium">+${addedCount}</span> <span class="text-rose-500 font-medium">-${removedCount}</span>`;

    const statusDot =
        status === 'running'
            ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse ml-1"></span>'
            : '';

    return `<div class="diff-card od-card-shadow my-2 rounded-[14px] border border-slate-200 overflow-hidden w-full">
        <div class="flex items-center gap-2 px-3.5 py-2.5 bg-slate-50 border-b border-slate-200 cursor-pointer select-none font-medium" onclick="(function(el,ev){if(ev.target.closest('[data-open-editor]')||ev.target.closest('[data-open-file]'))return;var body=el.parentElement.querySelector('.diff-body');var chevron=el.querySelector('.diff-chevron');if(body.style.display==='none'){body.style.display='';chevron.style.transform='rotate(0deg)';}else{body.style.display='none';chevron.style.transform='rotate(-90deg)';}})(this,event)">
            <span class="text-xs text-slate-500 shrink-0">${escapeHtml(t('filemgr.editFile.name'))}</span>
            <span class="text-xs font-medium text-slate-700 truncate">${escapeHtml(fileName)}</span>
            ${statusDot}
            <span class="text-[11px] text-slate-400 ml-auto shrink-0">${statsHtml}</span>
            ${editBadge}
            ${openBadge}
            <svg class="diff-chevron w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform duration-150" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
        </div>
        <div class="diff-body overflow-x-auto bg-white">
            <table class="diff-table w-full border-collapse border-spacing-0 text-[11px] font-mono leading-relaxed">
                ${hiddenBeforeLines.length > 0 ? `<tbody class="diff-hidden-lines" style="display:none">${hiddenBeforeLines.join('')}</tbody>` : ''}
                <tbody>${visibleLines.join('')}</tbody>
                ${hiddenAfterLines.length > 0 ? `<tbody class="diff-hidden-lines" style="display:none">${hiddenAfterLines.join('')}</tbody>` : ''}
            </table>
            ${truncated ? `<button type="button" class="diff-expand-toggle block w-full m-0 text-center py-1 text-[10px] leading-none text-slate-500 bg-slate-50 border-t border-slate-100 hover:bg-slate-100 hover:text-slate-700 cursor-pointer" data-collapsed-label="${escapeHtml(expandLabel)}" data-expanded-label="${escapeHtml(collapseLabel)}" onclick="(function(btn,ev){ev.stopPropagation();var hidden=btn.parentElement.querySelectorAll('.diff-hidden-lines');if(!hidden.length)return;var expanded=hidden[0].style.display!=='none';hidden.forEach(function(el){el.style.display=expanded?'none':'table-row-group';});btn.textContent=expanded?btn.dataset.collapsedLabel:btn.dataset.expandedLabel;})(this,event)">${escapeHtml(expandLabel)}</button>` : ''}
        </div>
    </div>`;
}

/**
 * 将 oldString / newString 渲染为带颜色区分的 HTML diff（保留向后兼容）
 */
function renderHtmlDiff(oldStr: string, newStr: string, maxLines: number = 8): string {
    const rows: string[] = [];

    const diffResult = diff.diffLines(oldStr, newStr);
    let lineCount = 0;
    for (const part of diffResult) {
        if (lineCount >= maxLines) break;
        const partLines = part.value.replace(/\n$/, '').split('\n');
        for (const line of partLines) {
            if (lineCount >= maxLines) break;
            const ln = lineCount + 1;
            const escaped = escapeHtml(line);
            if (part.added) {
                rows.push(
                    `<tr class="diff-row-add"><td class="diff-ln text-right px-2 py-px select-none border-r border-emerald-100 text-slate-400 w-[1px] whitespace-nowrap bg-emerald-50/60">${ln}</td><td class="diff-marker text-center px-1 py-px select-none border-r border-emerald-100 text-emerald-500 w-[1px] whitespace-nowrap bg-emerald-50">+</td><td class="diff-code whitespace-pre px-2 py-px text-emerald-700 bg-emerald-50/80">${escaped}</td></tr>`
                );
            } else if (part.removed) {
                rows.push(
                    `<tr class="diff-row-del"><td class="diff-ln text-right px-2 py-px select-none border-r border-rose-100 text-slate-400 w-[1px] whitespace-nowrap bg-rose-50/60">${ln}</td><td class="diff-marker text-center px-1 py-px select-none border-r border-rose-100 text-rose-400 w-[1px] whitespace-nowrap bg-rose-50">-</td><td class="diff-code whitespace-pre px-2 py-px text-rose-700 bg-rose-50/80">${escaped}</td></tr>`
                );
            } else {
                rows.push(
                    `<tr class="diff-row-ctx"><td class="diff-ln text-right px-2 py-px select-none border-r border-slate-100 text-slate-300 w-[1px] whitespace-nowrap">${ln}</td><td class="diff-marker text-center px-1 py-px select-none border-r border-slate-100 text-slate-300 w-[1px] whitespace-nowrap">&nbsp;</td><td class="diff-code whitespace-pre px-2 py-px text-slate-500">${escaped}</td></tr>`
                );
            }
            lineCount++;
        }
    }

    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    const totalOld = oldLines.length;
    const totalNew = newLines.length;
    const truncated = lineCount >= maxLines && totalOld + totalNew > maxLines;
    const summary = `<span class="text-rose-500">-${totalOld}</span> <span class="text-emerald-600">+${totalNew}</span>`;
    const truncNote = truncated ? `<div class="text-slate-400 mt-0.5">…</div>` : '';

    return `<div class="text-xs font-mono overflow-x-auto"><table class="diff-table w-full border-collapse border-spacing-0 text-[11px] font-mono leading-relaxed"><tbody>${rows.join('')}</tbody></table>${truncNote}</div><div class="text-xs text-slate-400 mt-0.5">${summary}</div>`;
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
    return getTempDir();
}

// ==================== ReadFile 工具 ====================

const READ_FILE_MAX_BYTES = 160 * 1024;

const readFileSchema = z.object({
    file_path: z.string().describe('文件的绝对路径或相对于工作目录的路径'),
    offset: z.number().int().nonnegative().optional().describe('起始行号（从 1 开始）。仅在文件过大需要分段读取时提供'),
    limit: z.number().int().positive().optional().describe('读取的行数。仅在文件过大需要分段读取时提供')
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

function addLineNumbers(lines: string[], startLine: number): string {
    return lines
        .map((line, index) => {
            const numStr = String(index + startLine);
            if (numStr.length >= 6) {
                return `${numStr}\t${line}`;
            }
            return `${numStr.padStart(6, ' ')}\t${line}`;
        })
        .join('\n');
}

function recordReadFileState(
    taskState: TaskState | undefined,
    filePath: string,
    stat: fs.Stats,
    content: string,
    offset: number,
    limit?: number
): void {
    taskState?.getFileReadState().set(filePath, {
        content,
        timestamp: Math.floor(stat.mtimeMs),
        offset,
        limit,
        isPartialView: false
    });
}

function shouldReturnFileUnchanged(
    taskState: TaskState | undefined,
    filePath: string,
    stat: fs.Stats,
    offset: number,
    limit?: number
): boolean {
    const state = taskState?.getFileReadState().get(filePath);
    return (
        state != null &&
        state.isPartialView !== true &&
        state.offset !== undefined &&
        state.offset === offset &&
        state.limit === limit &&
        Math.floor(stat.mtimeMs) === state.timestamp
    );
}

function createFileUnchangedResult(filePath: string): string {
    return JSON.stringify({
        type: 'file_unchanged',
        file: {
            filePath
        },
        message:
            'File unchanged since last read. The content from the earlier readFile tool result in this conversation is still current; refer to that instead of re-reading.'
    });
}

function clearReadFileState(taskState: TaskState | undefined, filePath: string): void {
    taskState?.getFileReadState().delete(filePath);
}

export function validateFileWasReadForWrite(
    taskState: TaskState | undefined,
    filePath: string,
    _currentContent?: string
): FileReadValidationResult {
    if (!taskState) {
        return { ok: true };
    }

    const state = taskState.getFileReadState().get(filePath);
    if (!state) {
        return {
            ok: false,
            reason: 'not_read',
            message: 'File has not been read yet. Read it first with readFile before writing to it.'
        };
    }

    if (state.isPartialView === true) {
        return {
            ok: false,
            reason: 'partial_view',
            message: 'File has only been partially read. Read the full file with readFile before writing to it.'
        };
    }

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch (err: any) {
        if (err?.code === 'ENOENT') {
            return { ok: true };
        }
        throw err;
    }

    if (Math.floor(stat.mtimeMs) > state.timestamp) {
        return {
            ok: false,
            reason: 'modified_since_read',
            message: 'File has been modified since read. Read it again with readFile before attempting to write it.'
        };
    }

    return { ok: true };
}

function validateFileWasReadForWriteIfEnabled(
    taskState: TaskState | undefined,
    filePath: string,
    currentContent?: string
): FileReadValidationResult {
    if (!ENFORCE_FILE_READ_BEFORE_WRITE) {
        return { ok: true };
    }

    return validateFileWasReadForWrite(taskState, filePath, currentContent);
}

export class ReadFileTool extends BaseTool<typeof readFileSchema> {
    constructor() {
        super(
            'readFile',
            '读取本地文件系统中的文件。你可以使用此工具直接访问任意文件。\n\n使用方法：\n- file_path 参数支持绝对路径或相对路径\n- 默认从文件开头读取全部内容\n- 可以通过 offset（起始行号）和 limit（行数）指定读取范围，适用于大文件分段读取\n- 返回结果为 JSON 格式，内容使用 cat -n 风格的行号标注\n- 此工具只能读取文件，不能读取目录。要读取目录内容请使用 shell 工具的 ls 命令\n- 如果读取的文件存在但内容为空，你会收到空文件提示',
            readFileSchema
        );

        this.setExecutor(this.executeCommand);
    }

    getDeclaredPermissions(args: z.output<typeof readFileSchema>, taskState?: TaskState): PermissionRequest[] {
        const basePath = getWorkingDirectory(taskState);
        const p = sanitizePath(args.file_path || '', basePath);
        if (!p) return [];
        return [{ resourceType: 'file' as const, action: 'read' as const, resourcePath: p }];
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const filePath = toolcall.args_object?.['file_path'] as string | undefined;
        const offset = toolcall.args_object?.['offset'] as number | undefined;
        const limit = toolcall.args_object?.['limit'] as number | undefined;

        let detail = filePath ? escapeHtml(filePath) : '';

        if (offset != null || limit != null) {
            const rangeStr = formatLineRange(offset, limit);
            if (rangeStr) {
                detail += ` · ${escapeHtml(rangeStr)}`;
            }
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                if (result.type === 'text' && result.file) {
                    detail += ` · ${result.file.totalLines} 行`;
                } else if (result.type === 'file_unchanged') {
                    detail += ' · 未变化，复用上次读取内容';
                }
            } catch {
                /* ignore */
            }
        }

        return renderInlineTool({
            icon: 'fas fa-file-lines',
            title: t('filemgr.readFile.name'),
            status: toolcall.status,
            detail,
            detailTitle: filePath || undefined,
            editorFilePath: filePath || undefined,
            editorLine: offset != null ? offset : undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const filePath = toolcall.args_object?.['file_path'] as string | undefined;
        const offset = toolcall.args_object?.['offset'] as number | undefined;
        const limit = toolcall.args_object?.['limit'] as number | undefined;
        const body: string[] = [];

        if (filePath) {
            let fileInfo = truncText(String(filePath), width - 8);
            const rangeStr = formatLineRange(offset, limit);
            if (rangeStr) {
                fileInfo += chalk.dim(` (${rangeStr})`);
            }
            body.push(chalk.yellow(fileInfo));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 读取中…'));
        } else if (toolcall.status === 'error' && toolcall.result != null) {
            const errStr = typeof toolcall.result === 'string' ? toolcall.result : String(toolcall.result);
            body.push(chalk.red(`  ✗ ${truncText(errStr, width - 16)}`));
        } else if (toolcall.status === 'success' && toolcall.result != null) {
            try {
                const result = JSON.parse(String(toolcall.result));
                if (result.type === 'error') {
                    body.push(chalk.red(`  ✗ ${truncText(result.error, width - 16)}`));
                } else if (result.type === 'text' && result.file) {
                    const f = result.file;
                    if (f.numLines > 0) {
                        body.push(
                            chalk.dim(
                                `  ${f.numLines} 行 (${f.startLine}~${f.startLine + f.numLines - 1}/${f.totalLines})`
                            )
                        );
                    } else {
                        body.push(chalk.dim(`  空内容 (文件共 ${f.totalLines} 行)`));
                    }
                } else if (result.type === 'file_unchanged') {
                    body.push(chalk.dim('  未变化，复用上次读取内容'));
                }
            } catch {
                body.push(chalk.dim('  见下方结果'));
            }
        }

        return new Card({
            icon: '📖',
            title: t('filemgr.readFile.name'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async executeCommand(args: z.output<typeof readFileSchema>, taskState?: TaskState): Promise<string> {
        const basePath = getWorkingDirectory(taskState);
        const filePath = sanitizePath(args.file_path || '', basePath);
        const { offset, limit } = args;
        const startLine = offset != null ? Math.max(1, offset) : 1;

        if (!filePath) {
            throw new Error('请提供文件路径 (file_path)');
        }

        try {
            const stat = await fs.promises.stat(filePath);

            if (stat.isDirectory()) {
                throw new Error(`路径是目录，不是文件: ${filePath}。要读取目录内容请使用 shell 工具的 ls 命令`);
            }

            if (shouldReturnFileUnchanged(taskState, filePath, stat, startLine, limit)) {
                return createFileUnchangedResult(filePath);
            }

            const size = stat.size;

            if (size === 0) {
                recordReadFileState(taskState, filePath, stat, '', 1);
                return JSON.stringify({
                    type: 'text',
                    file: {
                        filePath,
                        content: '',
                        numLines: 0,
                        startLine: 1,
                        totalLines: 0
                    }
                });
            }

            const headLen = Math.min(size, HEAD_BYTES);
            const headBuf = Buffer.alloc(headLen);
            const fd = await fs.promises.open(filePath, 'r');
            try {
                await fd.read(headBuf, 0, headLen, 0);
            } finally {
                await fd.close();
            }

            const { encoding, bomOffset } = detectEncoding(headBuf);
            const isMultiByteUnicode =
                encoding === 'utf16le' || encoding === 'utf16be' || encoding === 'utf-32le' || encoding === 'utf-32be';

            if (!isMultiByteUnicode) {
                let type: Awaited<ReturnType<typeof fileType.fromFile>> = undefined;
                try {
                    type = await fileType.fromFile(filePath);
                } catch {
                    /* ignore */
                }

                if (type?.mime && isBinaryMedia(type.mime)) {
                    throw new Error(`此文件不是纯文本（检测为 ${type.mime}），readFile 无法打开非文本文件`);
                }

                if (!type && hasBinaryContent(headBuf)) {
                    throw new Error(`此文件不是纯文本（检测为二进制），readFile 无法打开非文本文件`);
                }
            }

            const rawBuf = await fs.promises.readFile(filePath);
            const fullContent = decodeBuffer(rawBuf, encoding, bomOffset);
            const allLines = fullContent.split(/\r?\n/);
            const totalLines = allLines.length;

            const startIdx = startLine - 1;

            if (startIdx >= totalLines) {
                return JSON.stringify({
                    type: 'text',
                    file: {
                        filePath,
                        content: '',
                        numLines: 0,
                        startLine,
                        totalLines
                    }
                });
            }

            const endIdx = limit != null ? Math.min(startIdx + limit, totalLines) : totalLines;
            const selectedLines = allLines.slice(startIdx, endIdx);
            const numberedContent = addLineNumbers(selectedLines, startLine);

            const contentByteLen = Buffer.byteLength(numberedContent, 'utf8');
            if (contentByteLen > READ_FILE_MAX_BYTES) {
                throw new Error(
                    `读取范围过大（${Math.ceil(contentByteLen / 1024)} KB 超过 ${READ_FILE_MAX_BYTES / 1024} KB 限制）。文件共 ${totalLines} 行，请使用 offset 和 limit 参数分段读取。例如：offset=${startLine}, limit=2000`
                );
            }

            recordReadFileState(taskState, filePath, stat, numberedContent, startLine, limit);
            return JSON.stringify({
                type: 'text',
                file: {
                    filePath,
                    content: numberedContent,
                    numLines: selectedLines.length,
                    startLine,
                    totalLines
                }
            });
        } catch (err) {
            if (err instanceof Error) {
                const nodeErr = err as NodeJS.ErrnoException;
                if (nodeErr.code === 'ENOENT') {
                    throw new Error(`文件不存在: ${filePath}`);
                }
                if (nodeErr.code === 'EACCES') {
                    throw new Error(`权限不足，无法读取文件: ${filePath}`);
                }
                if (nodeErr.code === 'EISDIR') {
                    throw new Error(`路径是目录，不是文件: ${filePath}`);
                }
                if (nodeErr.code === 'EMFILE') {
                    throw new Error(`打开文件过多，请稍后重试`);
                }
            }
            throw err;
        }
    }
}

// ==================== ReadImage / AskImage 工具 ====================

const imageSourceSchema = z
    .string()
    .min(1)
    .describe('JPEG、PNG、WebP、BMP、GIF 或 TIFF 图片的本地路径，或以 http:// / https:// 开头的在线图片 URL');

const readImageSchema = z.object({
    path: imageSourceSchema
});

const askImageSchema = z.object({
    question: z.string().min(1).describe('需要视觉模型结合图片回答的问题'),
    path: imageSourceSchema
});

function normalizeImageSource(source: string, taskState?: TaskState): string {
    const value = source.trim();
    if (/^https?:\/\//i.test(value)) {
        try {
            return new URL(value).toString();
        } catch {
            return value;
        }
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
        return value;
    }
    return sanitizePath(value, getWorkingDirectory(taskState));
}

function imageSourcePermission(source: string, taskState?: TaskState): PermissionRequest[] {
    const normalized = normalizeImageSource(source, taskState);
    if (!normalized) return [];
    try {
        if (isOnlineImageSource(normalized)) {
            return [{ resourceType: 'network', action: 'access', resourcePath: normalized }];
        }
    } catch {
        return [];
    }
    return [{ resourceType: 'file', action: 'read', resourcePath: normalized }];
}

function imageSourceErrorMessage(error: unknown, source: string): string {
    if (!(error instanceof ImageSourceError)) {
        const message = error instanceof Error ? error.message : String(error);
        return t('filemgr.image.error.readFailed', { path: source, message });
    }

    switch (error.code) {
        case 'unsupported_protocol':
            return t('filemgr.image.error.unsupportedProtocol', { path: source });
        case 'not_found':
            return t('filemgr.image.error.notFound', { path: source });
        case 'directory':
            return t('filemgr.image.error.directory', { path: source });
        case 'no_access':
            return t('filemgr.image.error.noAccess', { path: source });
        case 'too_large':
            return t('filemgr.image.error.tooLarge', {
                path: source,
                maxMb: Math.floor(Number(error.details) / 1024 / 1024)
            });
        case 'http_error':
            return t('filemgr.image.error.http', { path: source, status: error.details ?? '' });
        case 'fetch_failed':
            return t('filemgr.image.error.fetchFailed', { path: source });
        case 'unsupported_format':
            return t('filemgr.image.error.unsupportedFormat', { path: source });
        case 'resize_unsupported':
            return t('filemgr.image.error.resizeUnsupported', {
                path: source,
                maxDimension: error.details ?? ''
            });
        case 'invalid_image':
            return t('filemgr.image.error.invalid', { path: source });
    }
}

function currentTaskModel(taskState?: TaskState): string | undefined {
    const setting = Setting.getInstance();
    const taskModel = taskState?.model;
    if (taskModel && setting.getModelInstance(taskModel, 'chat')) {
        return taskModel;
    }
    return setting.getData().default_model || undefined;
}

function renderImageTool(
    toolcall: ToolCall,
    options: { title: string; icon: string; className: string; includeQuestion?: boolean }
): string {
    const source = String(toolcall.args_object?.['path'] ?? '');
    const question = options.includeQuestion ? String(toolcall.args_object?.['question'] ?? '') : '';
    // 显示时用文件名替代完整路径，避免路径过长挤掉 question
    const isUrl = /^https?:\/\//i.test(source);
    const displaySource = isUrl ? source : source ? path.basename(source) : '';
    const detail = question ? `${displaySource} · ${question}` : displaySource;
    return renderInlineTool({
        icon: options.icon,
        title: options.title,
        status: toolcall.status,
        className: options.className,
        detail,
        detailTitle: source || undefined,
        editorFilePath: source && !isUrl ? source : undefined
    });
}

function renderImageToolCli(toolcall: ToolCall, width: number, title: string, icon: string): string[] {
    const source = String(toolcall.args_object?.['path'] ?? '');
    const body: string[] = [];
    if (source) {
        body.push(chalk.yellow(truncText(source, width - 8)));
    }
    if (toolcall.status === 'running') {
        body.push(chalk.dim(`  ${t('filemgr.image.loading')}`));
    } else if (toolcall.status === 'error' && toolcall.result) {
        body.push(chalk.red(`  ✗ ${truncText(toolcall.result, width - 10)}`));
    } else if (toolcall.status === 'success') {
        body.push(chalk.dim(`  ${t('filemgr.image.loaded')}`));
    }
    return new Card({
        icon,
        title,
        status: statusDisplay(toolcall.status),
        body
    }).render(width);
}

export class ReadImageTool extends BaseTool<typeof readImageSchema> {
    constructor() {
        super(
            'readImage',
            '读取本地路径或在线 URL 指向的 JPEG、PNG、WebP、BMP、GIF 或 TIFF 图片，并将图片内容返回给当前任务模型进行视觉理解。GIF 按首帧处理；当前任务模型不支持视觉输入时会返回错误。',
            readImageSchema
        );
        this.setUniversalExecutor(this.executeCommand);
    }

    async isAvailable(taskState?: TaskState): Promise<boolean> {
        const model = currentTaskModel(taskState);
        if (!model) return false;
        return LLM.supportsVision(model);
    }

    getDeclaredPermissions(args: z.output<typeof readImageSchema>, taskState?: TaskState): PermissionRequest[] {
        return imageSourcePermission(args.path, taskState);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderImageTool(toolcall, {
            icon: 'fas fa-image',
            title: t('filemgr.readImage.name'),
            className: 'filemgr-read-image-tool'
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return renderImageToolCli(toolcall, width, t('filemgr.readImage.name'), '🖼️');
    }

    async executeCommand(
        args: z.output<typeof readImageSchema>,
        result: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        const model = currentTaskModel(taskState);
        if (!model || !(await LLM.supportsVision(model))) {
            throw new Error(t('filemgr.readImage.error.modelUnsupported'));
        }

        const source = normalizeImageSource(args.path, taskState);
        try {
            const image = await loadImageSource(source);
            result.updateResult(
                JSON.stringify({
                    type: 'image',
                    source: image.source,
                    mediaType: image.mimeType,
                    width: image.width,
                    height: image.height,
                    message: t('filemgr.readImage.result')
                })
            );
            result.updateResultObject({
                type: 'image',
                images: [
                    {
                        image_url: image.dataUrl,
                        media_type: image.mimeType,
                        source: image.source
                    }
                ]
            });
        } catch (error) {
            throw new Error(imageSourceErrorMessage(error, source));
        }
    }
}

export class AskImageTool extends BaseTool<typeof askImageSchema> {
    constructor() {
        super(
            'askImage',
            '使用系统设置中的默认视觉模型分析本地路径或在线 URL 指向的 JPEG、PNG、WebP、BMP、GIF 或 TIFF 图片，并直接返回该视觉模型对 question 的回答。GIF 按首帧处理。',
            askImageSchema
        );
        this.setExecutor(this.executeCommand);
    }

    async isAvailable(taskState?: TaskState): Promise<boolean> {
        const model = currentTaskModel(taskState);
        if (model && (await LLM.supportsVision(model))) {
            return false;
        }
        const visionModel = Setting.getInstance().getDefaultVisionModelInstance();
        if (!visionModel) return false;
        return LLM.supportsVision(visionModel);
    }

    getDeclaredPermissions(args: z.output<typeof askImageSchema>, taskState?: TaskState): PermissionRequest[] {
        return imageSourcePermission(args.path, taskState);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderImageTool(toolcall, {
            icon: 'fas fa-eye',
            title: t('filemgr.askImage.name'),
            className: 'filemgr-ask-image-tool',
            includeQuestion: true
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return renderImageToolCli(toolcall, width, t('filemgr.askImage.name'), '👁️');
    }

    async executeCommand(args: z.output<typeof askImageSchema>, taskState?: TaskState): Promise<string> {
        const question = args.question.trim();
        if (!question) {
            throw new Error(t('filemgr.askImage.error.questionRequired'));
        }

        const visionModel = Setting.getInstance().getDefaultVisionModelInstance();
        if (!visionModel) {
            throw new Error(t('filemgr.askImage.error.modelMissing'));
        }
        if (!(await LLM.supportsVision(visionModel))) {
            throw new Error(t('filemgr.askImage.error.modelUnsupported'));
        }

        const source = normalizeImageSource(args.path, taskState);
        let image;
        try {
            image = await loadImageSource(source);
        } catch (error) {
            throw new Error(imageSourceErrorMessage(error, source));
        }

        const message = new UserMessage(question);
        message.appendImageURL(image.dataUrl);
        return await LLM.ask(message, visionModel, {
            // 使用模型支持的最低推理档位，而非硬编码 'none' 强制关闭思考
            reasoningEffort: LLM.getMinimalReasoningEffort(visionModel),
            ...taskState?.createUsageTelemetryRequestOptions()
        });
    }
}

function formatLineRange(offset?: number, limit?: number): string {
    if (offset != null && limit != null) {
        return `第 ${offset}~${offset + limit - 1} 行`;
    } else if (offset != null) {
        return `从第 ${offset} 行`;
    } else if (limit != null) {
        return `前 ${limit} 行`;
    }
    return '';
}

function renderFileToolStatusBadge(status: string): string {
    if (status === 'running') {
        return `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-500"><i class="fa-solid fa-circle-notch fa-spin text-[8px]"></i>${escapeHtml(t('toolcall.status.running'))}</span>`;
    }
    if (status === 'error') {
        return `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-50 text-red-500"><i class="fa-solid fa-circle-xmark text-[8px]"></i>${escapeHtml(t('toolcall.status.error'))}</span>`;
    }
    if (status === 'success') {
        return `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-600"><i class="fa-solid fa-circle-check text-[8px]"></i>${escapeHtml(t('toolcall.status.success'))}</span>`;
    }
    return `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-600"><i class="fa-solid fa-circle-notch fa-spin text-[8px]"></i>${escapeHtml(t('toolcall.status.pending'))}</span>`;
}

function fileToolTone(status: string): { borderColor: string; iconBg: string } {
    if (status === 'error') {
        return { borderColor: 'border-red-200', iconBg: 'bg-red-50 text-red-400' };
    }
    if (status === 'success') {
        return { borderColor: 'border-gray-200', iconBg: 'bg-emerald-50 text-emerald-500' };
    }
    if (status === 'pending') {
        return { borderColor: 'border-gray-200', iconBg: 'bg-amber-50 text-amber-500' };
    }
    return { borderColor: 'border-gray-200', iconBg: 'bg-blue-50 text-blue-400' };
}

function renderFileToolDetailsCard(opts: {
    className: string;
    icon: string;
    title: string;
    status: string;
    summary: string;
    summaryTitle?: string;
    body: string;
    editorFilePath?: string;
    editorLine?: number;
}): string {
    const tone = fileToolTone(opts.status);
    const className = escapeHtml(opts.className);
    const summaryTitle = opts.summaryTitle ? ` title="${escapeHtml(opts.summaryTitle)}"` : '';
    const editorLine = opts.editorLine != null ? ` data-editor-line="${opts.editorLine}"` : '';
    const editorBadge = opts.editorFilePath
        ? `<span class="bg-slate-400 text-white text-[10px] font-bold px-1.5 py-0.5 rounded leading-none cursor-pointer hover:bg-slate-500 transition-colors" data-open-editor="${escapeHtml(opts.editorFilePath)}"${editorLine}>${escapeHtml(t('filemgr.openInEditor'))}</span>`
        : '';
    const openBadge = opts.editorFilePath ? openFileBadge(opts.editorFilePath) : '';

    return `<details class="file-tool-card ${className} od-card-shadow my-2 rounded-[14px] border ${tone.borderColor} bg-white overflow-hidden w-full" open>
        <summary class="flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150 font-medium">
            <span class="inline-flex items-center justify-center w-5 h-5 rounded ${tone.iconBg}">
                <i class="${escapeHtml(opts.icon)} text-[10px]"></i>
            </span>
            <span class="text-[12px] text-gray-500 shrink-0">${escapeHtml(opts.title)}</span>
            <span class="text-[12px] text-gray-600 truncate flex-1"${summaryTitle}>${escapeHtml(opts.summary)}</span>
            ${renderFileToolStatusBadge(opts.status)}
            ${editorBadge}
            ${openBadge}
            <svg class="w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
        </summary>
        <div class="border-t border-gray-200 bg-gray-50/40">
            ${opts.body}
        </div>
    </details>`;
}

// ==================== ExtractText 工具 ====================

const EXTRACT_TEXT_SUPPORTED_EXTENSIONS_DISPLAY = EXTRACT_TEXT_SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`).join(', ');

const extractTextSchema = z.object({
    file_path: z.string().describe('文件的绝对路径或相对于工作目录的路径')
});

export class ExtractTextTool extends BaseTool<typeof extractTextSchema> {
    private extractDelegate: (filePath: string) => Promise<string | null>;

    constructor(extractDelegate: (filePath: string) => Promise<string | null>) {
        super(
            'extractText',
            `将本地文件提取为纯文本读取，仅适用于读取复杂结构化文档内容，如 pdf/doc/docx/pptx/xls/xlsx/odt/odp/ods 等。纯文本文件请使用 readFile 工具读取。`,
            extractTextSchema
        );

        this.extractDelegate = extractDelegate;
        this.setExecutor(this.executeCommand);
    }

    getDeclaredPermissions(args: z.output<typeof extractTextSchema>, taskState?: TaskState): PermissionRequest[] {
        const basePath = getWorkingDirectory(taskState);
        const p = sanitizePath(args.file_path || '', basePath);
        if (!p) return [];
        return [{ resourceType: 'file' as const, action: 'read' as const, resourcePath: p }];
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const filePath = toolcall.args_object?.['file_path'] as string | undefined;

        let detail = filePath ? escapeHtml(filePath) : '';

        let visualStatus = toolcall.status;
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                if (result.type === 'error') {
                    visualStatus = 'error';
                }
                if (result.type === 'text' && result.file) {
                    detail += ` · ${t('filemgr.extractText.lineSummary', {
                        numLines: result.file.numLines
                    })}`;
                    if (result.file.content) {
                        detail += ` · ${t('filemgr.extractText.charCount', { count: result.file.content.length })}`;
                    }
                }
            } catch {
                /* ignore */
            }
        }

        return renderInlineTool({
            icon: 'fas fa-file-lines',
            title: t('filemgr.extractText.name'),
            status: visualStatus,
            className: 'filemgr-extract-text-tool',
            detail,
            detailTitle: filePath || undefined,
            editorFilePath: filePath || undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const filePath = toolcall.args_object?.['file_path'];
        const body: string[] = [];

        if (filePath) {
            body.push(chalk.yellow(truncText(String(filePath), width - 8)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim(`  ${t('filemgr.extractText.extracting')}`));
        } else if (toolcall.status === 'error' && toolcall.result != null) {
            body.push(chalk.red(`  ✗ ${truncText(String(toolcall.result), width - 16)}`));
        } else if (toolcall.status === 'success' && toolcall.result != null) {
            try {
                const result = JSON.parse(String(toolcall.result));
                if (result.type === 'error') {
                    body.push(chalk.red(`  ✗ ${truncText(result.error, width - 16)}`));
                } else if (result.type === 'text' && result.file) {
                    const f = result.file;
                    if (f.numLines > 0) {
                        body.push(
                            chalk.dim(
                                `  ${t('filemgr.extractText.lineSummary', {
                                    numLines: f.numLines
                                })}`
                            )
                        );
                    } else {
                        body.push(chalk.dim(`  ${t('filemgr.extractText.empty')}`));
                    }
                }
            } catch {
                body.push(chalk.dim(`  ${t('filemgr.extractText.seeResult')}`));
            }
        }

        return new Card({
            icon: '📄',
            title: t('filemgr.extractText.name'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async executeCommand(args: z.output<typeof extractTextSchema>, taskState?: TaskState): Promise<string> {
        const basePath = getWorkingDirectory(taskState);
        const filePath = sanitizePath(args.file_path || '', basePath);

        if (!filePath) {
            throw new Error(t('filemgr.extractText.error.pathRequired'));
        }

        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.isDirectory()) {
                throw new Error(t('filemgr.extractText.error.directory', { path: filePath }));
            }

            if (!isExtractTextSupported(filePath)) {
                return JSON.stringify({
                    type: 'error',
                    error: t('filemgr.extractText.error.unsupported', { path: filePath })
                });
            }

            const extracted = await this.extractDelegate(filePath);
            if (extracted === null) {
                throw new Error(t('filemgr.extractText.error.extractFailed', { path: filePath }));
            }

            const lines = extracted.length === 0 ? [] : extracted.split(/\r?\n/);
            const numberedContent = lines.length > 0 ? addLineNumbers(lines, 1) : '';

            return JSON.stringify({
                type: 'text',
                file: {
                    filePath,
                    content: numberedContent,
                    numLines: lines.length
                }
            });
        } catch (err) {
            if (err instanceof Error) {
                const nodeErr = err as NodeJS.ErrnoException;
                if (nodeErr.code === 'ENOENT') {
                    throw new Error(t('filemgr.extractText.error.notFound', { path: filePath }));
                }
                if (nodeErr.code === 'EACCES') {
                    throw new Error(t('filemgr.extractText.error.noAccess', { path: filePath }));
                }
            }
            throw err;
        }
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
    if (typeof content !== 'string') content = String(content ?? '');
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
    if (typeof content !== 'string') content = String(content ?? '');
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
        this.serialExecution = true;
    }

    getDeclaredPermissions(args: z.output<typeof writeFileSchema>, taskState?: TaskState): PermissionRequest[] {
        const p = sanitizePath(args.path, getWorkingDirectory(taskState));
        if (!p) return [];
        return [{ resourceType: 'file', action: 'write', resourcePath: p }];
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const filePath = toolcall.args_object?.['path'] as string | undefined;
        const rawContent = toolcall.args_object?.['content'];
        const content =
            typeof rawContent === 'string' ? rawContent : rawContent != null ? String(rawContent) : undefined;
        const mode = toolcall.args_object?.['mode'] as string | undefined;
        const title = t('filemgr.writeFile.name') + (mode === 'append' ? t('filemgr.writeFile.append') : '');

        if (filePath && content && isPreviewableFile(filePath) && toolcall.status !== 'error') {
            if (toolcall.status !== 'success') {
                // Show a placeholder during pending (streaming params) and running
                // (writing file) states to avoid preview flickering caused by
                // premature shadow DOM rendering.
                return renderPreviewPlaceholder({
                    icon: 'fas fa-pen-to-square',
                    title,
                    filePath
                });
            }
            const info = getWriteFileInfo(toolcall, content);
            const stat = `${info.lineCount} 行, ${info.contentLen.toLocaleString()} 字符`;
            return renderPreviewCard({
                icon: 'fas fa-pen-to-square',
                title,
                status: toolcall.status,
                filePath,
                content,
                detail: stat
            });
        }

        let detail = filePath ? escapeHtml(filePath) : '';
        if (toolcall.status === 'running' && content && content.length > 0) {
            const info = getWriteFileInfo(toolcall, content);
            detail += ` · 正在写入 ${info.lineCount} 行`;
        } else if (toolcall.status === 'success' && content && content.length > 0) {
            const info = getWriteFileInfo(toolcall, content);
            detail += ` · ${info.lineCount} 行, ${info.contentLen.toLocaleString()} 字符`;
        }

        return renderInlineTool({
            icon: 'fas fa-pen-to-square',
            title,
            status: toolcall.status,
            detail,
            editorFilePath: filePath || undefined
        });
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
        const title = t('filemgr.writeFile.name') + (mode === 'append' ? t('filemgr.writeFile.append') : '');
        return new Card({
            icon: '✏️',
            title: title,
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async executeCommand(args: z.output<typeof writeFileSchema>, taskState?: TaskState): Promise<string> {
        const filePath = sanitizePath(args.path, getWorkingDirectory(taskState));
        const validation = validateFileWasReadForWriteIfEnabled(taskState, filePath);
        if (!validation.ok) {
            return validation.message;
        }

        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            if (args.mode === 'append') {
                const cleanContent = trimTrailingWhitespace(args.content);
                await fs.promises.appendFile(filePath, cleanContent, 'utf8');
                clearReadFileState(taskState, filePath);
                return '文件内容追加成功';
            } else {
                const cleanContent = trimTrailingWhitespace(args.content);
                await fs.promises.writeFile(filePath, cleanContent, 'utf8');
                clearReadFileState(taskState, filePath);
                return '文件内容写入成功';
            }
        } catch (err: any) {
            const tempDir = getTempDirectory();
            const ext = path.extname(filePath) || '.txt';
            const baseName = path.basename(filePath, ext);
            const tempFileName = `opendesk_${baseName}_${Date.now()}${ext}`;
            const tempFilePath = path.join(tempDir, tempFileName);

            try {
                const cleanContent = trimTrailingWhitespace(args.content);
                await fs.promises.writeFile(tempFilePath, cleanContent, 'utf8');
                return `错误: 无法写入目标文件 ${filePath} (${err.message})。文件内容已临时保存至 ${tempFilePath}，请勿再次输出完整内容`;
            } catch {
                return `错误: 无法写入目标文件 ${filePath} (${err.message})，且临时文件写入也失败`;
            }
        }
    }
}

// ==================== EditFile 工具 ====================

const editFileSchema = z.object({
    filePath: z.string().describe('要修改的文件路径，可以使用工作区相对路径或绝对路径'),
    oldString: z
        .string()
        .min(1, 'oldString 不能为空，创建新文件请使用 writeFile 工具')
        .describe(
            '要替换的原始文本（必须与文件内容完全匹配，包括所有空白和缩进）。对于单次替换，建议在目标文本前后各包含至少3行上下文'
        ),
    newString: z.string().describe('替换后的新文本'),
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
            '在现有文件中进行文本替换操作，支持字面字符串替换，可处理多次出现的替换。这是对文件进行精确、针对性修改的首选工具。创建新文件请使用 writeFile 工具',
            editFileSchema
        );

        this.setExecutor(this.executeCommand);
        this.serialExecution = true;
    }

    getDeclaredPermissions(args: z.output<typeof editFileSchema>, taskState?: TaskState): PermissionRequest[] {
        const p = sanitizePath(args.filePath, getWorkingDirectory(taskState));
        if (!p) return [];
        return [
            { resourceType: 'file', action: 'read', resourcePath: p },
            { resourceType: 'file', action: 'write', resourcePath: p }
        ];
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const filePath = toolcall.args_object?.['filePath'] as string | undefined;
        const oldString = toolcall.args_object?.['oldString'] as string | undefined;
        const newString = toolcall.args_object?.['newString'] as string | undefined;

        if (oldString && newString !== undefined && filePath) {
            const resultStr = toolcall.result as string | undefined;
            const isError = resultStr ? resultStr.startsWith('错误:') : false;
            if ((toolcall.status === 'success' || toolcall.status === 'running') && !isError) {
                return renderDiffCard(filePath, oldString, newString, toolcall.status);
            }
        }

        let detail = filePath ? escapeHtml(filePath) : '';
        if (oldString && newString !== undefined) {
            const expectedReplacements = toolcall.args_object?.['expectedReplacements'] || 1;
            detail += ` · ${expectedReplacements} 处替换`;
        }

        return renderInlineTool({
            icon: 'fas fa-scissors',
            title: t('filemgr.editFile.name'),
            status: toolcall.status,
            detail,
            editorFilePath: filePath || undefined
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

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 编辑中…'));
        } else if (toolcall.status === 'success') {
            const resultStr = toolcall.result as string | undefined;
            if (resultStr && resultStr.startsWith('错误:')) {
                body.push(chalk.red(`  ✗ ${truncText(resultStr, width - 6)}`));
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

        return new Card({
            icon: '✂️',
            title: t('filemgr.editFile.name'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async executeCommand(args: z.output<typeof editFileSchema>, taskState?: TaskState): Promise<string> {
        const filePath = sanitizePath(args.filePath, getWorkingDirectory(taskState));
        const { oldString, newString, expectedReplacements = 1 } = args;
        const validation = validateFileWasReadForWriteIfEnabled(taskState, filePath);
        if (!validation.ok) {
            return validation.message;
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
                        return `错误: 未找到要替换的文本。提示：在文件第 ${lineIdx + 1} 行找到了与 oldString 第一行相似的内容，但后续行不完全匹配。请使用 readFile 工具重新读取文件以获取最新内容`;
                    }
                }

                return `错误: 未找到要替换的文本。请确保 oldString 与文件内容完全匹配（包括空白和缩进）。建议先用 readFile 工具读取文件内容`;
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

        // 对被修改区域进行行尾空白清理
        result = trimTrailingWhitespace(result);

        // 恢复原始换行符风格
        if (needRestoreCRLF) {
            result = result.replace(/\n/g, '\r\n');
        }

        await fs.promises.writeFile(filePath, result, 'utf8');
        clearReadFileState(taskState, filePath);
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
        this.serialExecution = true;
    }

    getDeclaredPermissions(args: z.output<typeof searchReplaceSchema>, taskState?: TaskState): PermissionRequest[] {
        const p = sanitizePath(args.filePath, getWorkingDirectory(taskState));
        if (!p) return [];
        return [
            { resourceType: 'file', action: 'read', resourcePath: p },
            { resourceType: 'file', action: 'write', resourcePath: p }
        ];
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const filePath = toolcall.args_object?.['filePath'] as string | undefined;
        const oldString = toolcall.args_object?.['oldString'] as string | undefined;
        const newString = toolcall.args_object?.['newString'] as string | undefined;

        if (
            oldString &&
            newString !== undefined &&
            filePath &&
            (toolcall.status === 'success' || toolcall.status === 'running')
        ) {
            const resultStr = toolcall.result as string | undefined;
            const isError = resultStr ? resultStr.startsWith('错误:') : false;
            if (!isError) {
                return renderDiffCard(filePath, oldString, newString, toolcall.status);
            }
        }

        const detail = filePath ? escapeHtml(filePath) : '';
        return renderInlineTool({
            icon: 'fas fa-right-left',
            title: t('filemgr.searchReplace.name'),
            status: toolcall.status,
            detail
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
            const resultStr = toolcall.result as string | undefined;
            if (resultStr && resultStr.startsWith('错误:')) {
                body.push(chalk.red(`  ✗ ${truncText(resultStr, width - 6)}`));
            } else {
                body.push(chalk.dim('  ✅ 替换完成'));

                if (oldString && newString !== undefined) {
                    const diffLines = renderDiffOutput(oldString, newString, width);
                    if (diffLines.length > 0) {
                        body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
                        body.push(...diffLines);
                    }
                }
            }
        }

        return new Card({
            icon: '🔍',
            title: t('filemgr.searchReplace.name'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async executeCommand(args: z.output<typeof searchReplaceSchema>, taskState?: TaskState): Promise<string> {
        const filePath = sanitizePath(args.filePath, getWorkingDirectory(taskState));
        const { oldString, newString } = args;
        const validation = validateFileWasReadForWriteIfEnabled(taskState, filePath);
        if (!validation.ok) {
            return validation.message;
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

        result = trimTrailingWhitespace(result);

        if (needRestoreCRLF) {
            result = result.replace(/\n/g, '\r\n');
        }

        await fs.promises.writeFile(filePath, result, 'utf8');
        clearReadFileState(taskState, filePath);
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
        this.serialExecution = true;
    }

    getDeclaredPermissions(args: z.output<typeof applyPatchSchema>, taskState?: TaskState): PermissionRequest[] {
        const basePath = getWorkingDirectory(taskState);
        const ops = parsePatch(args.patch);
        const permissions: PermissionRequest[] = [];
        const seen = new Set<string>();
        for (const op of ops) {
            const p = sanitizePath(op.path, basePath);
            if (!p) continue;
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

        let detail = '';
        let fileList: string[] | undefined;
        let body = '';
        if (patch) {
            const fileCount = (patch.match(/^--- /gm) || []).length;
            const addedLines = (patch.match(/^\+[^+]/gm) || []).length;
            const removedLines = (patch.match(/^-[^-]/gm) || []).length;
            detail = `${fileCount} 个文件 · -${removedLines}/+${addedLines} 行`;

            const fileMatches = patch.match(/^\+\+\+ .+$/gm) || [];
            fileList = fileMatches.slice(0, 12).map((l) =>
                l
                    .slice(4)
                    .trim()
                    .replace(/^[ab]\//, '')
            );

            // 渲染 patch diff
            if (toolcall.status === 'success' || toolcall.status === 'running') {
                const patchLines = patch.split('\n');
                const diffLines: string[] = [];
                let lineCount = 0;
                const maxDiffLines = 10;
                for (const line of patchLines) {
                    if (lineCount >= maxDiffLines) break;
                    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
                    const escaped = escapeHtml(line);
                    if (line.startsWith('+')) {
                        diffLines.push(
                            `<div class="text-emerald-700 bg-emerald-50/80 pl-1 border-l-2 border-emerald-400"><span class="inline-block w-3 text-center">+</span>${escaped.slice(1)}</div>`
                        );
                    } else if (line.startsWith('-')) {
                        diffLines.push(
                            `<div class="text-rose-700 bg-rose-50/80 pl-1 border-l-2 border-rose-400"><span class="inline-block w-3 text-center">-</span>${escaped.slice(1)}</div>`
                        );
                    } else {
                        diffLines.push(
                            `<div class="text-slate-500 pl-1 border-l-2 border-transparent"><span class="inline-block w-3 text-center">&nbsp;</span>${escaped}</div>`
                        );
                    }
                    lineCount++;
                }
                const truncated = patchLines.length > maxDiffLines + 10;
                if (diffLines.length > 0) {
                    body = `<div class="text-xs font-mono space-y-0">${diffLines.join('')}${truncated ? '<div class="text-slate-400 mt-0.5">…</div>' : ''}</div>`;
                }
            }
        }

        if (toolcall.status === 'success') {
            detail += ' · 已应用';
        }

        return renderInlineTool({
            icon: 'fas fa-band-aid',
            title: t('filemgr.applyPatch.name'),
            status: toolcall.status,
            detail: detail || undefined,
            fileList,
            body: body || undefined
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
            title: t('filemgr.applyPatch.name'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async executeCommand(args: z.output<typeof applyPatchSchema>, taskState?: TaskState): Promise<string> {
        const { patch } = args;
        const basePath = getWorkingDirectory(taskState);

        const operations = parsePatch(patch);
        if (operations.length === 0) {
            return '错误: 无法解析补丁内容，请确保使用 unified diff 格式';
        }

        const results: string[] = [];

        for (const op of operations) {
            op.path = sanitizePath(op.path, basePath);
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

                    await fs.promises.writeFile(op.path, trimTrailingWhitespace(content), 'utf8');
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

                    await fs.promises.writeFile(op.path, trimTrailingWhitespace(content), 'utf8');
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

    getDeclaredPermissions(args: z.output<typeof globSchema>, taskState?: TaskState): PermissionRequest[] {
        const basePath = getWorkingDirectory(taskState);
        const searchPath = args.path ? sanitizePath(args.path, basePath) : sanitizePath(basePath);
        if (!searchPath) return [];
        return [
            {
                resourceType: 'file',
                action: 'read',
                resourcePath: searchPath.endsWith('/') ? searchPath : searchPath + '/'
            }
        ];
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
            if (toolcall.result.startsWith('未找到')) {
                body.push(chalk.dim('  📭 未找到匹配的文件'));
            } else {
                const lines = toolcall.result.split('\n');
                const foundMatch = toolcall.result.match(/找到 (\d+) 个文件/);
                const fileCount = foundMatch ? foundMatch[1] : '?';
                body.push(chalk.dim('  ✅ 找到 ') + chalk.green(String(fileCount)) + chalk.dim(' 个文件'));

                const files = lines.filter((l) => l.trim() && !l.startsWith('找到'));
                for (const file of files.slice(0, 5)) {
                    body.push(chalk.dim('    ') + truncText(file, width - 8));
                }
                if (files.length > 5) {
                    body.push(chalk.dim(`    … 共 ${files.length} 个结果`));
                }
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.red(`  ✗ ${truncText(String(toolcall.result), width - 10)}`));
        }

        return new Card({
            icon: '🔍',
            title: t('filemgr.glob.name'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const pattern = toolcall.args_object?.['pattern'];
        const searchPath = toolcall.args_object?.['path'];

        let detail = pattern ? escapeHtml(String(pattern)) : '';
        if (searchPath) {
            detail += ` · ${escapeHtml(String(searchPath))}`;
        }
        if (toolcall.status === 'success' && toolcall.result) {
            const foundMatch = toolcall.result.match(/找到 (\d+) 个文件/);
            if (foundMatch) {
                detail += ` · ${foundMatch[1]} 个文件`;
            }
        }

        return renderInlineTool({
            icon: 'fas fa-magnifying-glass',
            title: t('filemgr.glob.name'),
            status: toolcall.status,
            detail
        });
    }

    async executeCommand(args: z.output<typeof globSchema>, taskState?: TaskState): Promise<string> {
        let { pattern, path: searchPath, ignore, caseSensitive, maxResults } = args;
        const workingDir = getWorkingDirectory(taskState);

        if (!pattern || pattern.trim() === '') {
            return '错误: 请提供 glob 模式';
        }

        if (searchPath) {
            searchPath = sanitizePath(searchPath, workingDir);
        }

        // 自动为非递归模式添加 **/ 前缀
        pattern = pattern.trim();
        if (!pattern.startsWith('**/') && !pattern.includes('/')) {
            pattern = '**/' + pattern;
        }

        try {
            const ignorePatterns = [...DEFAULT_GLOB_IGNORE, ...(ignore || [])];

            const options: fastGlob.Options = {
                cwd: searchPath || workingDir,
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
            const basePath = searchPath || workingDir;
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

/**
 * 将单条 .gitignore 规则转换为相对于 basePath 的 fastGlob ignore 模式。
 * 对齐 git 的语义：
 *  - 不含 / → basename 匹配（递归），同时匹配文件和目录内容
 *  - 含 / 或前导 / → 路径锚定：{prefix}{pattern}
 *  - 尾 / → 仅匹配目录
 *  - ! → 否定模式（fastGlob 原生支持）
 */
function convertGitignoreRule(rule: string, prefix: string): string[] | null {
    let line = rule.trim();
    if (!line || line.startsWith('#')) return null;

    let isNegation = false;
    if (line.startsWith('!')) {
        isNegation = true;
        line = line.slice(1).trim();
        if (!line) return null;
    }

    if (!line) return null;

    let isDirOnly = false;
    if (line.endsWith('/')) {
        isDirOnly = true;
        line = line.slice(0, -1);
    }

    let isAnchored = false;
    if (line.startsWith('/')) {
        isAnchored = true;
        line = line.slice(1);
    }

    if (!line) return null;

    const hasPathSep = line.includes('/');
    const results: string[] = [];
    const addResult = (r: string) => {
        results.push(isNegation ? '!' + r : r);
    };

    if (isAnchored || hasPathSep) {
        // 路径锚定：相对于 .gitignore 所在目录
        const base = prefix + line;
        if (isDirOnly) {
            addResult(base + '/**');
        } else {
            addResult(base);
            // 路径模式也可能匹配同名目录
            addResult(base + '/**');
        }
    } else {
        // basename 模式：匹配任意深度。同时匹配文件和目录内容
        addResult(prefix + '**/' + line);
        addResult(prefix + '**/' + line + '/**');
    }

    return results;
}

/**
 * 收集 basePath 下所有 .gitignore 中的规则，转换为 fastGlob 兼容的 ignore 模式。
 * 行为对齐 ripgrep：递归收集各层级 .gitignore 并按所在目录正确作用域化。
 */
async function collectGitignorePatterns(basePath: string): Promise<string[]> {
    const patterns: string[] = [];
    try {
        const gitignoreFiles = await fastGlob('**/.gitignore', {
            cwd: basePath,
            ignore: DEFAULT_GREP_IGNORE,
            absolute: false,
            onlyFiles: true,
            suppressErrors: true,
            dot: true
        });

        for (const relPath of gitignoreFiles) {
            const dir = path.dirname(relPath);
            const prefix = dir === '.' ? '' : dir + '/';
            try {
                const content = await fs.promises.readFile(path.join(basePath, relPath), 'utf-8');
                for (const rawLine of content.split('\n')) {
                    const converted = convertGitignoreRule(rawLine, prefix);
                    if (converted) {
                        patterns.push(...converted);
                    }
                }
            } catch {
                // 读取失败则跳过该 .gitignore
            }
        }
    } catch {
        // fastGlob 失败（如目录不存在）则返回空
    }
    return patterns;
}

const grepSchema = z.object({
    pattern: z.string().describe('要搜索的正则表达式模式'),
    path: z.string().optional().describe('搜索路径，可以是文件或目录，默认为当前工作目录'),
    filePattern: z.string().optional().describe('文件名 glob 模式，如 *.ts、**/*.js，默认搜索所有文件'),
    ignoreCase: z.boolean().default(true).describe('是否忽略大小写，默认 true'),
    maxResults: z.number().min(1).max(500).default(50).describe('最大返回结果数，默认 50'),
    contextLines: z.number().min(0).max(100).default(2).describe('显示匹配行的上下文行数，默认 2')
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

    getDeclaredPermissions(args: z.output<typeof grepSchema>, taskState?: TaskState): PermissionRequest[] {
        const basePath = getWorkingDirectory(taskState);
        const searchPath = args.path ? sanitizePath(args.path, basePath) : sanitizePath(basePath);
        if (!searchPath) return [];
        return [
            {
                resourceType: 'file',
                action: 'read',
                resourcePath: searchPath.endsWith('/') ? searchPath : searchPath + '/'
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
            title: t('filemgr.grep.name'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const pattern = toolcall.args_object?.['pattern'];
        const searchPath = toolcall.args_object?.['path'];

        let detail = pattern ? escapeHtml(String(pattern)) : '';
        if (searchPath) {
            detail += ` · ${escapeHtml(String(searchPath))}`;
        }
        if (toolcall.status === 'success' && toolcall.result) {
            const summaryMatch = toolcall.result.match(/在 (\d+) 个文件中找到 (\d+) 处匹配/);
            if (summaryMatch) {
                detail += ` · ${summaryMatch[1]} 文件 / ${summaryMatch[2]} 处匹配`;
            }
        }

        return renderInlineTool({
            icon: 'fas fa-code',
            title: t('filemgr.grep.name'),
            status: toolcall.status,
            detail
        });
    }

    /**
     * 将 grep filePattern 转换为 fastGlob 可用的模式，对齐 ripgrep 行为：
     * - 不含 / 的 pattern（如 *.ts）→ basename 匹配，递归所有子目录：**\/*.ts
     * - 含 / 的 pattern（如 src/*.ts）→ 路径匹配，原样传递
     * - 空值/未指定 → 默认 **\/* 匹配所有文件
     */
    private normalizeFilePattern(filePattern?: string): string {
        if (!filePattern) return '**/*';
        // 含路径分隔符的是路径匹配，原样传递
        if (filePattern.includes('/') || filePattern.includes('\\')) {
            return filePattern;
        }
        // 纯 basename 模式：对齐 ripgrep，递归匹配
        return `**/${filePattern}`;
    }

    async executeCommand(args: z.output<typeof grepSchema>, taskState?: TaskState): Promise<string> {
        const { pattern, path: searchPath, filePattern, ignoreCase, maxResults, contextLines } = args;
        const workingDir = getWorkingDirectory(taskState);

        if (!pattern || pattern.trim() === '') {
            return '错误: 请提供搜索模式';
        }

        try {
            // 预处理 pattern 中的 \uXXXX 字面量转义序列，将其转换为实际的 Unicode 字符
            // 这样 AI agent 发送的 [\u4e00-\u9fa5] 等 Unicode 范围模式能被正确处理
            const processedPattern = pattern.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
                String.fromCharCode(parseInt(hex, 16))
            );

            // 优先使用 'u' (unicode) flag 以正确处理 Unicode 字符范围
            // 如果 unicode 模式不兼容（某些旧式正则语法），回退到非 unicode 模式
            const baseFlags = ignoreCase ? 'gi' : 'g';
            let regex: RegExp;
            try {
                regex = new RegExp(processedPattern, baseFlags + 'u');
            } catch {
                try {
                    regex = new RegExp(processedPattern, baseFlags);
                } catch (e: any) {
                    return `错误: 无效的正则表达式 - ${e.message}`;
                }
            }

            const basePath = searchPath ? sanitizePath(searchPath, workingDir) : workingDir;
            const globPattern = this.normalizeFilePattern(filePattern);

            // 单文件搜索快速路径
            let filesToSearch: string[];
            try {
                const stat = await fs.promises.stat(basePath);
                if (stat.isFile()) {
                    filesToSearch = [basePath];
                } else {
                    const gitignorePatterns = await collectGitignorePatterns(basePath);
                    const allIgnorePatterns = [...DEFAULT_GREP_IGNORE, ...gitignorePatterns];
                    filesToSearch = await fastGlob(globPattern, {
                        cwd: basePath,
                        ignore: allIgnorePatterns,
                        absolute: true,
                        onlyFiles: true,
                        suppressErrors: true
                    });
                }
            } catch {
                const gitignorePatterns = await collectGitignorePatterns(basePath);
                const allIgnorePatterns = [...DEFAULT_GREP_IGNORE, ...gitignorePatterns];
                filesToSearch = await fastGlob(globPattern, {
                    cwd: basePath,
                    ignore: allIgnorePatterns,
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
            const displayBasePath = searchPath || workingDir;

            // 按文件分组，以便每个文件内统一行号宽度
            const fileGroups = new Map<string, GrepMatch[]>();
            for (const match of matches) {
                const group = fileGroups.get(match.file) ?? [];
                group.push(match);
                fileGroups.set(match.file, group);
            }

            for (const [file, fileMatches] of fileGroups) {
                const relPath = path.relative(displayBasePath, file);
                output.push(`\n${toForwardSlash(relPath.startsWith('..') ? file : relPath)}`);

                // 计算该文件内最大行号（含上下文），确定行号宽度
                let maxLineNum = 0;
                for (const m of fileMatches) {
                    const afterEnd = m.contextAfter.length > 0 ? m.line + m.contextAfter.length : m.line;
                    maxLineNum = Math.max(maxLineNum, afterEnd);
                }
                const lineNumWidth = String(maxLineNum).length;

                // 去重输出
                let lastLine = -1;
                for (const match of fileMatches) {
                    if (match.line === lastLine) {
                        continue;
                    }
                    lastLine = match.line;

                    if (contextLines > 0 && match.contextBefore.length > 0) {
                        for (let j = 0; j < match.contextBefore.length; j++) {
                            const ctxLineNum = match.line - match.contextBefore.length + j;
                            const ctxNumStr = String(ctxLineNum).padStart(lineNumWidth, ' ');
                            output.push(`  ${ctxNumStr} | ${match.contextBefore[j]}`);
                        }
                    }

                    const lineNumStr = String(match.line).padStart(lineNumWidth, ' ');
                    output.push(`> ${lineNumStr} | ${match.content}`);

                    if (contextLines > 0 && match.contextAfter.length > 0) {
                        for (let j = 0; j < match.contextAfter.length; j++) {
                            const ctxLineNum = match.line + 1 + j;
                            const ctxNumStr = String(ctxLineNum).padStart(lineNumWidth, ' ');
                            output.push(`  ${ctxNumStr} | ${match.contextAfter[j]}`);
                        }
                    }
                }
            }

            const fileCount = fileGroups.size;
            output.unshift(`在 ${fileCount} 个文件中找到 ${matches.length} 处匹配:`);

            return output.join('\n');
        } catch (err: any) {
            return `搜索失败: ${err.message}`;
        }
    }
}

// ==================== SemanticSearch 工具 ====================

const semanticSearchScopeSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('path'),
        path: z.string().min(1)
    }),
    z.object({
        type: z.literal('paths'),
        paths: z.array(z.string().min(1)).min(1).max(FILEMGR_SEARCH_MAX_PATHS)
    })
]);

const semanticSearchSchema = z.object({
    query: z.string().describe('要进行语义模糊搜索的内容，一句话简单的自然语言描述即可'),
    maxResults: z.number().int().min(1).max(30).default(30).describe('最大返回结果数，默认 30，最多 30'),
    scope: z
        .preprocess((value) => {
            if (typeof value !== 'string') {
                return value;
            }
            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
        }, semanticSearchScopeSchema)
        .optional()
});

export type FilemgrSearchScope = z.output<typeof semanticSearchScopeSchema>;

interface SemanticSearchItem {
    path: string;
    filename?: string;
    snippet?: string | null;
    snippets?: Array<{ chunkId?: string; text: string; score?: number }>;
    matchTypes?: string[];
    score?: number;
}

interface SemanticSearchResult {
    query?: string;
    results?: SemanticSearchItem[];
    totalHits?: number;
    warning?: string;
    code?: string;
}

type SemanticSearchExecutor = (
    query: string,
    maxResults: number,
    scope?: FilemgrSearchScope
) => Promise<SemanticSearchResult>;

export const SEMANTIC_SEARCH_SNIPPET_BUDGET_CHARS = 8000;

function normalizeMarkdownText(value: unknown): string {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}

function markdownCodeSpan(value: unknown): string {
    const text = normalizeMarkdownText(value);
    const runs = text.match(/`+/g) ?? [];
    const longestRun = runs.length > 0 ? Math.max(...runs.map((run) => run.length)) : 0;
    const tickCount = longestRun + 1;
    const ticks = '`'.repeat(tickCount);
    const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
    return `${ticks}${padding}${text}${padding}${ticks}`;
}

function truncateMarkdownText(value: unknown, maxChars = 500): string {
    const text = normalizeMarkdownText(value);
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function escapeHtmlForMarkdown(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatSemanticMatchTypes(matchTypes: string[] | undefined): string {
    const labels = new Set<string>();
    for (const matchType of matchTypes ?? []) {
        if (matchType === 'content_semantic') {
            labels.add(t('filemgr.semanticSearch.match.content'));
        } else if (matchType === 'name_semantic' || matchType === 'keyword') {
            labels.add(t('filemgr.semanticSearch.match.title'));
        }
    }
    return [...labels].join(', ');
}

export function formatSemanticSearchMarkdown(result: SemanticSearchResult, maxResults = 30): string {
    const results = Array.isArray(result?.results) ? result.results.slice(0, Math.min(maxResults, 30)) : [];
    const lines: string[] = [];

    if (result?.warning) {
        const code = result.code ? ` (${result.code})` : '';
        lines.push(`- ${t('filemgr.semanticSearch.result.warning')}: ${result.warning}${code}`);
    }

    if (results.length === 0) {
        lines.push(
            `- ${t('filemgr.semanticSearch.result.noResults', { query: normalizeMarkdownText(result?.query) })}`
        );
    } else {
        let snippetBudget = SEMANTIC_SEARCH_SNIPPET_BUDGET_CHARS;
        for (const item of results) {
            const matchTypes = formatSemanticMatchTypes(item.matchTypes);
            const matchPart = matchTypes ? ` - ${t('filemgr.semanticSearch.result.match')}: ${matchTypes}` : '';
            lines.push(`- ${markdownCodeSpan(item.path)}${matchPart}`);
            lines.push(
                `  - ${t('filemgr.semanticSearch.result.title')}: ${truncateMarkdownText(item.filename || path.basename(item.path))}`
            );
            const snippets = item.snippets?.length
                ? item.snippets.map((snippet) => snippet.text)
                : item.snippet
                  ? [item.snippet]
                  : [];
            if (snippets.length) {
                for (const snippet of snippets) {
                    const rendered = truncateMarkdownText(snippet);
                    if (rendered.length > snippetBudget) break;
                    lines.push(`  - ${t('filemgr.semanticSearch.result.chunk')}: ${rendered}`);
                    snippetBudget -= rendered.length;
                }
            } else {
                lines.push(
                    `  - ${t('filemgr.semanticSearch.result.chunk')}: ${t('filemgr.semanticSearch.result.noChunk')}`
                );
            }
        }
    }

    const totalHits = typeof result?.totalHits === 'number' ? result.totalHits : results.length;
    if (totalHits > results.length) {
        lines.push(
            `- ${t('filemgr.semanticSearch.result.more', {
                shown: results.length,
                total: totalHits
            })}`
        );
    }

    return lines.join('\n');
}

export class SemanticSearchTool extends BaseTool<typeof semanticSearchSchema> {
    private searchIndexedFiles: SemanticSearchExecutor;

    constructor(searchIndexedFiles: SemanticSearchExecutor) {
        super(
            'semanticSearch',
            '在纳入智能文件系统的目录中按语义进行模糊搜索，并返回最相关的文件片段。在搜索时给定一句话描述即可。' +
                '不要使用大量类似的关键词，也不要一次性搜索不同的主题，搜索多个主题可以多次调用',
            semanticSearchSchema
        );
        this.searchIndexedFiles = searchIndexedFiles;
        this.setExecutor(this.executeCommand);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const query = toolcall.args_object?.['query'] as string | undefined;
        const maxResults = toolcall.args_object?.['maxResults'] as number | undefined;
        let summary = query || '';
        if (maxResults) {
            summary += ` · ${Math.min(maxResults, 30)} ${t('filemgr.semanticSearch.maxSuffix')}`;
        }

        let body = `<div class="px-4 py-3 flex items-center gap-2 text-blue-400 text-[12px]"><i class="fa-solid fa-circle-notch fa-spin"></i><span class="text-gray-400">${escapeHtml(t('filemgr.semanticSearch.running'))}</span></div>`;
        if (toolcall.status === 'success' && toolcall.result) {
            const count = (String(toolcall.result).match(/^- `+/gm) || []).length;
            if (count > 0) {
                summary += ` · ${count} ${t('filemgr.semanticSearch.result.countSuffix')}`;
            }
            const rendered = await marked.parse(escapeHtmlForMarkdown(String(toolcall.result)));
            body = `<div class="px-4 py-2.5 text-xs text-gray-700 leading-relaxed markdown-body max-h-[260px] overflow-y-auto">${rendered}</div>`;
        } else if (toolcall.status === 'error') {
            body = `<div class="px-4 py-2.5 text-xs text-red-600">${escapeHtml(String(toolcall.result ?? ''))}</div>`;
        }

        return renderFileToolDetailsCard({
            icon: 'fas fa-magnifying-glass',
            title: t('filemgr.semanticSearch.name'),
            status: toolcall.status,
            className: 'filemgr-semantic-search-tool',
            summary,
            summaryTitle: query || undefined,
            body
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const query = toolcall.args_object?.['query'];
        const body: string[] = [];

        if (query) {
            body.push(
                chalk.cyan(`${t('filemgr.semanticSearch.query')}: `) + chalk.white(truncText(String(query), width - 12))
            );
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim(`  ${t('filemgr.semanticSearch.running')}`));
        } else if (toolcall.status === 'success' && toolcall.result) {
            const count = (String(toolcall.result).match(/^- `+/gm) || []).length;
            body.push(chalk.dim(`  ${t('filemgr.semanticSearch.result.found', { count })}`));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.red(`  ✗ ${truncText(String(toolcall.result), width - 10)}`));
        }

        return new Card({
            icon: '🔎',
            title: t('filemgr.semanticSearch.name'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async executeCommand(args: z.output<typeof semanticSearchSchema>): Promise<string> {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        const maxResults = Math.max(1, Math.min(Number(args.maxResults) || 30, 30));
        if (!query && args.scope === undefined) {
            return formatSemanticSearchMarkdown({ query, results: [], totalHits: 0 }, maxResults);
        }
        const result = await this.searchIndexedFiles(query, maxResults, args.scope);
        return formatSemanticSearchMarkdown(result, maxResults);
    }
}

// ==================== 工具集工厂函数 ====================

export function createFileManagerToolset(options: {
    extractDelegate: (filePath: string) => Promise<string | null>;
}): BaseToolset {
    const toolset = new BaseToolset('filemgr');
    toolset.addTool(new ReadFileTool());
    toolset.addTool(new ReadImageTool());
    toolset.addTool(new AskImageTool());
    toolset.addTool(new ExtractTextTool(options?.extractDelegate));
    toolset.addTool(new WriteFileTool());
    toolset.addTool(new EditFileTool());
    toolset.addTool(new SearchReplaceTool());
    // toolset.addTool(new ApplyPatchTool());
    toolset.addTool(new GlobFilesTool());
    toolset.addTool(new GrepFilesTool());
    return toolset;
}
