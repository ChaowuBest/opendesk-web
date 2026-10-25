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

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BaseTool, ToolResult } from '../../aikernel/tool.js';
import type { ToolCall } from '../../aikernel/messages.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { ExecutionHost, NodeExecutionCapabilities } from '../../aikernel/security/harness.js';
import type { PermissionRequest } from '../../aikernel/security/permission.js';
import { escapeHtml } from '../../../common/utils/escape.js';
import { Card } from '../../tui/components/card.js';
import { statusDisplay, truncText, MAX_CLI_OUTPUT_LINES } from '../../tui/components/toolcall.js';
import { Setting } from '../../utils/setting.js';
import { getTempDir } from '../../utils/temp.js';
import { sanitizeLocalPath } from '../../utils/path.js';
import type { DeviceMgrApplication } from './app.js';
import type { NodeInvokeResult } from './common.js';
import {
    NODE_FILE_COMMANDS,
    NODE_SHELL_COMMAND,
    nodeSupportsCommand,
    nodeSupportsShell,
    type NodeShell
} from './execution.js';
import * as diff from 'diff';
import chalk from 'chalk';
import { t } from '../../../locale/index.js';

type SelectedNodeHost = Extract<ExecutionHost, { type: 'node' }>;

const MAX_DIFF_LINES = 50;
const DIFF_CONTEXT_LINES = 3;
const WRITE_FILE_TAIL_LINES = 5;
const NODE_FILE_TRANSFER_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const NODE_FILE_TRANSFER_HARD_MAX_BYTES = 16 * 1024 * 1024;
const NODE_FILE_TRANSFER_STORE_DIR = 'opendesk-node-file-transfer';

function getSelectedNodeHost(taskState?: TaskState): SelectedNodeHost | null {
    const host = taskState?.harnessContext?.executionHost;
    return host?.type === 'node' ? host : null;
}

/**
 * 解析本次调用的目标节点。
 * - 如果显式指定 nodeId，校验其是否已连接且支持当前命令
 * - 如果未指定，回退到当前任务选中的节点
 */
function resolveTargetNode(
    taskState: TaskState | undefined,
    nodeId: string | undefined,
    command: string,
    app: DeviceMgrApplication
): SelectedNodeHost {
    const gateway = app.getGateway();
    if (!gateway?.isRunning()) {
        throw new Error('设备网关未启动，无法执行 node 工具');
    }

    if (nodeId) {
        let node = gateway.getNodeRegistry().get(nodeId);
        if (!node) {
            const matches = gateway
                .getNodeRegistry()
                .listConnected()
                .filter((n) => n.displayName === nodeId || n.remoteIp === nodeId);
            if (matches.length > 1) {
                throw new Error(`节点 ${nodeId} 匹配到多个在线节点，请使用 nodeId 精确指定`);
            }
            node = matches[0];
        }
        if (!node) {
            throw new Error(`节点 ${nodeId} 未连接`);
        }
        const caps: NodeExecutionCapabilities = {
            nodeId: node.nodeId,
            displayName: node.displayName,
            platform: node.platform,
            workspace: node.workspace,
            commands: node.commands,
            shells: node.shells,
            defaultShell: node.defaultShell
        };
        if (!nodeSupportsCommand(caps, command)) {
            throw new Error(`节点 ${nodeId} 不支持 ${command}`);
        }
        return {
            type: 'node' as const,
            nodeId: node.nodeId,
            nodeLabel: node.displayName,
            capabilities: caps
        };
    }

    // 回退到当前选中的节点
    const host = getSelectedNodeHost(taskState);
    if (!host) {
        throw new Error('当前任务未选择 node 且未指定 nodeId，无法执行 node 工具。请通过 nodeId 参数指定目标节点。');
    }
    if (!nodeSupportsCommand(host.capabilities, command)) {
        throw new Error(`节点 ${host.nodeId} 不支持 ${command}`);
    }
    return host;
}

function parsePayload(result: NodeInvokeResult): unknown {
    if (typeof result.payloadJSON === 'string' && result.payloadJSON.trim()) {
        try {
            return JSON.parse(result.payloadJSON);
        } catch {
            return result.payloadJSON;
        }
    }
    return result.payload;
}

function payloadToText(payload: unknown): string {
    if (payload === undefined || payload === null) return '';
    if (typeof payload === 'string') return payload;
    return JSON.stringify(payload, null, 2);
}

function getWorkingDirectory(taskState?: TaskState): string {
    return taskState?.getWorkspace() || Setting.getInstance().getEffectiveWorkspace();
}

function normalizeBase64ForCompare(value: string): string {
    return value.replace(/=+$/u, '').replace(/-/gu, '+').replace(/_/gu, '/');
}

function decodeStrictBase64(value: string): Buffer {
    const buffer = Buffer.from(value, 'base64');
    if (normalizeBase64ForCompare(buffer.toString('base64')) !== normalizeBase64ForCompare(value)) {
        throw new Error('contentBase64 不是有效的 base64');
    }
    return buffer;
}

function sha256Hex(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function clampTransferMaxBytes(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return NODE_FILE_TRANSFER_DEFAULT_MAX_BYTES;
    }
    return Math.min(Math.floor(value), NODE_FILE_TRANSFER_HARD_MAX_BYTES);
}

function assertTransferSize(size: number): void {
    if (size > NODE_FILE_TRANSFER_HARD_MAX_BYTES) {
        throw new Error(`文件大小 ${size} bytes 超过上限 ${NODE_FILE_TRANSFER_HARD_MAX_BYTES} bytes (16 MB)`);
    }
}

function getNodeSelector(args: { nodeId?: string; node?: string }): string | undefined {
    const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : '';
    if (nodeId) return nodeId;
    const node = typeof args.node === 'string' ? args.node.trim() : '';
    return node || undefined;
}

function asPayloadObject(payload: unknown, invalidMessage: string): Record<string, unknown> {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const obj = payload as Record<string, unknown>;
        if (obj.ok === false) {
            const code = typeof obj.code === 'string' ? obj.code : 'NODE_FILE_TRANSFER_FAILED';
            const message = typeof obj.message === 'string' ? obj.message : invalidMessage;
            throw new Error(`${code}: ${message}`);
        }
        return obj;
    }
    throw new Error(invalidMessage);
}

function safeFetchedFileName(filePath: string): string {
    const base = remoteBasename(filePath)
        .replace(/[^\w.-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return base || 'node-file.bin';
}

async function ensureFileTransferStoreDir(): Promise<string> {
    const dir = path.join(getTempDir(), NODE_FILE_TRANSFER_STORE_DIR);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => undefined);
    return dir;
}

type NodeFileMediaRecord = {
    mediaId: string;
    mediaPath: string;
    localPath: string;
    nodePath?: string;
    size: number;
    mimeType?: string;
    sha256: string;
    createdAtMs: number;
};

async function saveNodeFileMediaRecord(params: {
    buffer: Buffer;
    nodePath: string;
    mimeType?: string;
    sha256: string;
    localPath?: string;
    overwrite?: boolean;
    taskState?: TaskState;
}): Promise<NodeFileMediaRecord> {
    const storeDir = await ensureFileTransferStoreDir();
    const mediaId = `node-file-${crypto.randomUUID()}`;
    const mediaPath = path.join(storeDir, `${mediaId}-${safeFetchedFileName(params.nodePath)}`);
    const outputPath = params.localPath
        ? sanitizeLocalPath(params.localPath, getWorkingDirectory(params.taskState))
        : mediaPath;

    if (!outputPath) {
        throw new Error('localPath 无效');
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    if (!params.overwrite) {
        try {
            await fs.stat(outputPath);
            throw new Error(`本地文件已存在且 overwrite=false: ${outputPath}`);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
            }
        }
    }

    await fs.writeFile(mediaPath, params.buffer, { mode: 0o600 });
    if (outputPath !== mediaPath) {
        try {
            await fs.writeFile(outputPath, params.buffer, { mode: 0o600 });
        } catch (err) {
            await fs.rm(mediaPath, { force: true }).catch(() => undefined);
            throw err;
        }
    }

    const record: NodeFileMediaRecord = {
        mediaId,
        mediaPath,
        localPath: outputPath,
        nodePath: params.nodePath,
        size: params.buffer.byteLength,
        mimeType: params.mimeType,
        sha256: params.sha256,
        createdAtMs: Date.now()
    };
    await fs.writeFile(path.join(storeDir, `${mediaId}.json`), JSON.stringify(record, null, 2), {
        encoding: 'utf8',
        mode: 0o600
    });
    return record;
}

async function readNodeFileMediaRecord(mediaId: string): Promise<NodeFileMediaRecord> {
    if (!/^node-file-[0-9a-f-]+$/i.test(mediaId)) {
        throw new Error('sourceMediaId 无效');
    }
    const storeDir = await ensureFileTransferStoreDir();
    const raw = await fs.readFile(path.join(storeDir, `${mediaId}.json`), 'utf8');
    const record = JSON.parse(raw) as NodeFileMediaRecord;
    if (!record.mediaPath) {
        throw new Error(`sourceMediaId ${mediaId} 缺少 mediaPath`);
    }
    return record;
}

async function readSendSourceBytes(args: {
    localPath?: string;
    contentBase64?: string;
    sourceMediaId?: string;
    taskState?: TaskState;
}): Promise<{
    buffer: Buffer;
    contentBase64: string;
    source: 'localPath' | 'inline' | 'media';
    sourcePath?: string;
    sourceMediaId?: string;
}> {
    const hasLocalPath = typeof args.localPath === 'string' && args.localPath.trim().length > 0;
    const hasContentBase64 = typeof args.contentBase64 === 'string';
    const hasSourceMediaId = typeof args.sourceMediaId === 'string' && args.sourceMediaId.trim().length > 0;
    const sourceCount = [hasLocalPath, hasContentBase64, hasSourceMediaId].filter(Boolean).length;
    if (sourceCount === 0) {
        throw new Error('localPath、contentBase64 或 sourceMediaId 必须提供一个');
    }
    if (sourceCount > 1) {
        throw new Error('localPath、contentBase64、sourceMediaId 只能提供一个，避免来源歧义');
    }

    if (hasSourceMediaId) {
        const mediaId = args.sourceMediaId!.trim();
        const record = await readNodeFileMediaRecord(mediaId);
        const buffer = await fs.readFile(record.mediaPath);
        assertTransferSize(buffer.byteLength);
        if (buffer.byteLength !== record.size) {
            throw new Error(`sourceMediaId ${mediaId} 大小不匹配`);
        }
        if (sha256Hex(buffer) !== record.sha256) {
            throw new Error(`sourceMediaId ${mediaId} sha256 不匹配`);
        }
        return {
            buffer,
            contentBase64: buffer.toString('base64'),
            source: 'media',
            sourceMediaId: mediaId
        };
    }

    if (hasLocalPath) {
        const sourcePath = sanitizeLocalPath(args.localPath, getWorkingDirectory(args.taskState));
        if (!sourcePath) throw new Error('localPath 无效');
        const stat = await fs.stat(sourcePath);
        if (!stat.isFile()) {
            throw new Error(`localPath 不是文件: ${sourcePath}`);
        }
        assertTransferSize(stat.size);
        const buffer = await fs.readFile(sourcePath);
        assertTransferSize(buffer.byteLength);
        return { buffer, contentBase64: buffer.toString('base64'), source: 'localPath', sourcePath };
    }

    const buffer = decodeStrictBase64(args.contentBase64 ?? '');
    assertTransferSize(buffer.byteLength);
    return { buffer, contentBase64: args.contentBase64 ?? '', source: 'inline' };
}

function formatJsonResult(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

function formatShellOutput(payload: unknown): string {
    if (payload && typeof payload === 'object') {
        const obj = payload as Record<string, unknown>;
        const stdout = typeof obj.stdout === 'string' ? obj.stdout : '';
        const stderr = typeof obj.stderr === 'string' ? obj.stderr : '';
        const error = typeof obj.error === 'string' ? obj.error : '';
        const parts = [stdout, stderr, error].filter(Boolean);
        if (parts.length > 0) return parts.join('\n').trimEnd();
    }
    return payloadToText(payload).trimEnd();
}

function nodeTitle(title: string, nodeId?: string): string {
    return nodeId ? `${title} [${nodeId}]` : `${title} node`;
}

function nodeBadgeHtml(nodeId?: string): string {
    const label = nodeId ? escapeHtml(nodeId) : 'node';
    return `<span class="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">${label}</span>`;
}

function statusDot(status: string): string {
    if (status === 'running') {
        return '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>';
    }
    if (status === 'error') {
        return '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>';
    }
    return '';
}

function renderNodeInlineTool(opts: {
    icon: string;
    title: string;
    status: string;
    detail?: string;
    detailTitle?: string;
    fileList?: string[];
    body?: string;
    nodeId?: string;
}): string {
    const detailHtml = opts.detail
        ? `<span class="truncate text-xs text-slate-600" ${opts.detailTitle ? `title="${escapeHtml(opts.detailTitle)}"` : ''}>${escapeHtml(opts.detail)}</span>`
        : '';
    const fileListHtml =
        opts.fileList && opts.fileList.length > 0
            ? `<div class="ml-5 mt-0.5 text-xs text-slate-500 space-y-0">${opts.fileList
                  .slice(0, 12)
                  .map((f) => `<div class="truncate" title="${escapeHtml(f)}">${escapeHtml(f)}</div>`)
                  .join(
                      ''
                  )}${opts.fileList.length > 12 ? `<div class="text-slate-400">… 共 ${opts.fileList.length} 个结果</div>` : ''}</div>`
            : '';
    const bodyHtml = opts.body ? `<div class="ml-5 mt-1">${opts.body}</div>` : '';

    return `<div class="od-inline-toolcall-container">
        <div class="flex items-center gap-1.5 min-w-0">
            <i class="${opts.icon} shrink-0 text-slate-400 text-xs"></i>
            ${nodeBadgeHtml(opts.nodeId)}
            <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(opts.title)}</span>
            ${statusDot(opts.status)}
            ${detailHtml}
        </div>
        ${fileListHtml}
        ${bodyHtml}
    </div>`;
}

function remoteBasename(filePath: string): string {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
}

function remoteExtension(filePath: string): string {
    const name = remoteBasename(filePath);
    const idx = name.lastIndexOf('.');
    if (idx <= 0 || idx === name.length - 1) return '';
    return name.slice(idx + 1).toLowerCase();
}

function fileExtBadgeHtml(filePath: string): string {
    const ext = remoteExtension(filePath);
    if (!ext) return '';
    return `<span class="bg-slate-400 text-white text-[10px] font-bold px-1.5 py-0.5 rounded leading-none">${escapeHtml(ext.toUpperCase().slice(0, 4))}</span>`;
}

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
    type DiffBlock = {
        oldStart: number;
        oldEnd: number;
        newStart: number;
        newEnd: number;
        lines: Array<{ type: 'context' | 'removed' | 'added'; oldNum?: number; newNum?: number; content: string }>;
    };
    const blocks: DiffBlock[] = [];
    let currentBlock: DiffBlock | null = null;

    for (const part of diffResult) {
        const lines = part.value.endsWith('\n') ? part.value.slice(0, -1).split('\n') : part.value.split('\n');
        if (part.added) {
            currentBlock ??= {
                oldStart: oldLineNum,
                oldEnd: oldLineNum,
                newStart: newLineNum,
                newEnd: newLineNum + lines.length - 1,
                lines: []
            };
            for (const line of lines) {
                currentBlock.lines.push({ type: 'added', newNum: newLineNum, content: line });
                currentBlock.newEnd = newLineNum;
                newLineNum++;
            }
        } else if (part.removed) {
            currentBlock ??= {
                oldStart: oldLineNum,
                oldEnd: oldLineNum + lines.length - 1,
                newStart: newLineNum,
                newEnd: newLineNum,
                lines: []
            };
            for (const line of lines) {
                currentBlock.lines.push({ type: 'removed', oldNum: oldLineNum, content: line });
                currentBlock.oldEnd = oldLineNum;
                oldLineNum++;
            }
        } else if (currentBlock) {
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
            oldLineNum += lines.length;
            newLineNum += lines.length;
        }
    }
    if (currentBlock) blocks.push(currentBlock);

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (i > 0) body.push(chalk.dim('  ...'));
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
            const prefix = line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  ';
            const lineNum = String(line.type === 'added' ? line.newNum : (line.oldNum ?? '')).padStart(4);
            const text = truncText(`${lineNum} ${prefix}${line.content}`, Math.max(8, width - 8));
            if (line.type === 'added') {
                body.push(chalk.rgb(40, 140, 40)(text));
            } else if (line.type === 'removed') {
                body.push(chalk.rgb(180, 60, 60)(text));
            } else {
                body.push(chalk.dim(text));
            }
        }
    }
    return body;
}

function renderNodeDiffCard(
    title: string,
    filePath: string,
    oldStr: string,
    newStr: string,
    status: string,
    maxLines: number = 12,
    nodeId?: string
): string {
    const diffResult = diff.diffLines(oldStr, newStr);
    let addedCount = 0;
    let removedCount = 0;
    const lines: string[] = [];
    let lineCount = 0;
    let totalLines = 0;

    for (const part of diffResult) {
        const partLines = part.value.replace(/\n$/, '').split('\n');
        totalLines += partLines.length;
        if (part.added) addedCount += partLines.length;
        else if (part.removed) removedCount += partLines.length;
    }

    for (const part of diffResult) {
        if (lineCount >= maxLines) break;
        const partLines = part.value.replace(/\n$/, '').split('\n');
        for (const line of partLines) {
            if (lineCount >= maxLines) break;
            const escaped = escapeHtml(line) || '&nbsp;';
            if (part.added) {
                lines.push(
                    `<div class="font-mono bg-emerald-50 border-l-3 border-emerald-400 px-2 py-px text-emerald-800"><span class="text-emerald-500 select-none mr-1.5">+</span>${escaped}</div>`
                );
            } else if (part.removed) {
                lines.push(
                    `<div class="font-mono bg-rose-50 border-l-3 border-rose-400 px-2 py-px text-rose-800"><span class="text-rose-400 select-none mr-1.5">-</span>${escaped}</div>`
                );
            } else {
                lines.push(
                    `<div class="font-mono px-2 py-px text-slate-500"><span class="text-slate-300 select-none mr-1.5">&nbsp;</span>${escaped}</div>`
                );
            }
            lineCount++;
        }
    }

    const fileName = remoteBasename(filePath);
    const statsHtml = `<span class="text-emerald-600 font-medium">+${addedCount}</span> <span class="text-rose-500 font-medium">-${removedCount}</span>`;
    const runningDot =
        status === 'running'
            ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse ml-1"></span>'
            : '';

    return `<div class="my-1 rounded-lg border border-slate-200 overflow-hidden w-full">
        <div class="flex items-center gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200 cursor-pointer select-none" onclick="(function(el){var body=el.parentElement.querySelector('.diff-body');var chevron=el.querySelector('.diff-chevron');if(body.style.display==='none'){body.style.display='';chevron.style.transform='rotate(0deg)';}else{body.style.display='none';chevron.style.transform='rotate(-90deg)';}})(this)">
            <span class="text-xs text-slate-500 shrink-0">${escapeHtml(title)}</span>
            ${nodeBadgeHtml(nodeId)}
            <span class="text-xs font-medium text-slate-700 truncate" title="${escapeHtml(filePath)}">${escapeHtml(fileName)}</span>
            ${runningDot}
            <span class="text-[11px] text-slate-400 ml-auto shrink-0">${statsHtml}</span>
            ${fileExtBadgeHtml(filePath)}
            <svg class="diff-chevron w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform duration-150" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
        </div>
        <div class="diff-body text-[11px] font-mono leading-relaxed overflow-x-auto bg-white" style="white-space:pre">
            ${lines.join('')}
            ${lineCount < totalLines ? `<div class="text-center py-1.5 text-[10px] text-slate-400 bg-slate-50 border-t border-slate-100">… 共 ${totalLines} 行变更</div>` : ''}
        </div>
    </div>`;
}

function formatLineRange(offset?: number, limit?: number): string {
    if (offset != null && limit != null) return `第 ${offset}~${offset + limit - 1} 行`;
    if (offset != null) return `从第 ${offset} 行`;
    if (limit != null) return `前 ${limit} 行`;
    return '';
}

function getWriteContentInfo(content: string): { lineCount: number; contentLen: number; tailLines: string[] } {
    if (content.length === 0) return { lineCount: 0, contentLen: 0, tailLines: [] };
    const lines = content.replace(/\n$/, '').split('\n');
    return {
        lineCount: lines.length,
        contentLen: content.length,
        tailLines: lines.slice(-WRITE_FILE_TAIL_LINES)
    };
}

function parseJsonResult(result?: string): any {
    if (!result) return undefined;
    try {
        return JSON.parse(result);
    } catch {
        return undefined;
    }
}

function renderNodeShellToolCall(toolcall: ToolCall): string {
    const args = toolcall.args_object as z.output<typeof NodeShellSchema> | undefined;
    const command = args?.command || '';
    const description = args?.description;
    const nodeId = args?.nodeId;
    const isRunning = toolcall.result === undefined && toolcall.status !== 'error';
    const isError = toolcall.status === 'error';
    const headerText = description
        ? escapeHtml(description)
        : escapeHtml(command.length > 80 ? command.slice(0, 77) + '…' : command);
    const outputColor = isError ? 'text-red-600' : 'text-gray-600';
    const borderColor = isError ? 'border-red-200' : 'border-gray-200';
    const iconColor = isError ? 'text-red-400' : 'text-gray-400';
    const headerTextColor = isError ? 'text-red-600' : 'text-gray-600';

    let bodyContent = `
        <div class="px-4 py-2.5 font-mono text-[12px] text-gray-700 leading-relaxed">
            <span class="text-gray-400 select-none">$ </span>${escapeHtml(command)}
        </div>`;
    if (args?.workingDirectory) {
        bodyContent = `
        <div class="px-4 pt-2.5 text-[11px] text-gray-400">cwd: ${escapeHtml(args.workingDirectory)}</div>${bodyContent}`;
    }
    if (toolcall.result) {
        bodyContent += `
        <div class="px-4 py-2.5 border-t border-gray-100">
            <pre class="terminal-tool-output ${outputColor}">${escapeHtml(toolcall.result)}</pre>
        </div>`;
    }

    return `
    <details class="terminal-tool od-card-shadow my-2 rounded-[14px] border ${borderColor} bg-white overflow-hidden" open>
        <summary class="terminal-tool-summary flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150 font-medium">
            <svg class="w-4 h-4 ${iconColor} shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
                <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 9l3 3-3 3"/><line x1="14" y1="15" x2="16" y2="15"/>
            </svg>
            ${nodeBadgeHtml(nodeId)}
            <span class="text-[12px] ${headerTextColor} font-medium truncate flex-1">${headerText}</span>
            <svg class="terminal-tool-chevron w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M6 9l6 6 6-6"/>
            </svg>
        </summary>
        <div class="border-t border-gray-200 bg-gray-50/40">
            <div class="max-h-[280px] overflow-y-auto terminal-tool-scroll">
                ${bodyContent}
            </div>
        </div>
    </details>`;
}

function renderNodeShellToolCallCli(toolcall: ToolCall, width: number): string[] {
    const args = toolcall.args_object as z.output<typeof NodeShellSchema> | undefined;
    const command = args?.command;
    const cwd = args?.workingDirectory;
    const description = args?.description?.trim();
    const shell = args?.shell || 'auto';
    const nodeId = args?.nodeId;
    const baseTitle =
        shell === 'bash'
            ? 'Bash'
            : shell === 'zsh'
              ? 'Zsh'
              : shell === 'powershell'
                ? 'PowerShell'
                : shell === 'cmd'
                  ? 'CMD'
                  : 'Shell';
    const title = description
        ? `${nodeTitle(baseTitle, nodeId)} (${truncText(description, Math.max(12, width - 36))})`
        : nodeTitle(baseTitle, nodeId);
    const body: string[] = [];

    if (cwd) body.push(chalk.dim('cwd: ') + chalk.yellow(truncText(cwd, Math.max(8, width - 10))));
    if (command) body.push(chalk.blueBright('❯ ') + chalk.white(truncText(String(command), Math.max(8, width - 10))));
    if (toolcall.result) {
        body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
        const rawLines = toolcall.result.replace(/\r/g, '').split('\n');
        if (rawLines.length > MAX_CLI_OUTPUT_LINES) {
            body.push(chalk.dim.italic(`  … 共 ${rawLines.length} 行，显示最后 ${MAX_CLI_OUTPUT_LINES} 行`));
        }
        for (const line of rawLines.slice(-MAX_CLI_OUTPUT_LINES)) {
            body.push('  ' + chalk.dim(truncText(line, Math.max(8, width - 10))));
        }
    } else if (toolcall.status === 'running') {
        body.push(chalk.dim('  ⏳ 命令执行中…'));
    }

    const isInterrupted =
        toolcall.status !== 'running' &&
        (toolcall.result?.startsWith('[超时]') || toolcall.result?.startsWith('[中断]'));
    return new Card({
        icon: '🖥',
        title,
        status: isInterrupted ? statusDisplay('interrupted') : statusDisplay(toolcall.status),
        body
    }).render(width);
}

abstract class NodeCommandTool<T extends z.ZodType> extends BaseTool<T> {
    protected app: DeviceMgrApplication;
    protected nodeCommand: string;

    constructor(app: DeviceMgrApplication, name: string, description: string, params: T, nodeCommand: string) {
        super(name, description, params);
        this.app = app;
        this.nodeCommand = nodeCommand;
    }

    /** 只要有已连接节点支持当前命令即暴露工具（不再依赖 executionHost 类型） */
    isAvailable(taskState?: TaskState): boolean {
        const gateway = this.app.getGateway();
        if (!gateway?.isRunning()) return false;
        const nodes = gateway.getNodeRegistry().listConnected();
        return nodes.some((n) => Array.isArray(n.commands) && n.commands.includes(this.nodeCommand));
    }

    /** 在指定或默认 node 上执行命令（支持显式 nodeId） */
    protected async invokeNode(
        taskState: TaskState | undefined,
        nodeId: string | undefined,
        payload?: unknown,
        timeoutMs?: number
    ): Promise<unknown> {
        const host = resolveTargetNode(taskState, nodeId, this.nodeCommand, this.app);
        const gateway = this.app.getGateway();
        const result = await gateway!.getNodeRegistry().invoke({
            nodeId: host.nodeId,
            command: this.nodeCommand,
            params: payload,
            timeoutMs
        });
        if (!result.ok) {
            const code = result.error?.code ?? 'NODE_INVOKE_FAILED';
            const message = result.error?.message ?? 'node invoke failed';
            throw new Error(`${code}: ${message}`);
        }
        return parsePayload(result);
    }

    /** invokeNode 的文本包装版 */
    protected async invokeNodeText(
        taskState: TaskState | undefined,
        nodeId: string | undefined,
        payload?: unknown,
        timeoutMs?: number
    ): Promise<string> {
        return payloadToText(await this.invokeNode(taskState, nodeId, payload, timeoutMs));
    }
}

const NodeShellSchema = z.object({
    nodeId: z
        .string()
        .optional()
        .describe(
            '目标节点 ID。未指定时使用当前任务的默认执行节点。可用节点列表参见 system prompt 中的"可用执行节点列表"'
        ),
    command: z.string().min(1, '命令不能为空').describe('要在目标 node 上执行的 shell 命令'),
    shell: z
        .enum(['auto', 'bash', 'zsh', 'powershell', 'cmd', 'sh'])
        .optional()
        .default('auto')
        .describe('node 上要使用的 shell。auto 使用 node 声明的默认 shell'),
    description: z.string().optional().describe('对该命令意图的简短描述，用于界面展示'),
    workingDirectory: z
        .string()
        .optional()
        .describe('node 上的执行目录。未指定时使用 node 自己的默认目录；相对路径由 node 端解析'),
    timeout: z.number().int().positive().optional().default(30000).describe('命令执行超时时间（毫秒），默认 30000ms')
});

export class ExecuteNodeShellTool extends NodeCommandTool<typeof NodeShellSchema> {
    constructor(app: DeviceMgrApplication) {
        super(app, 'executeNodeShell', t('tool.nodeShell.description'), NodeShellSchema, NODE_SHELL_COMMAND);
        this.setUniversalExecutor(this.run.bind(this));
    }

    async run(args: z.output<typeof NodeShellSchema>, result: ToolResult, taskState?: TaskState): Promise<void> {
        const host = resolveTargetNode(taskState, args.nodeId, this.nodeCommand, this.app);
        const shell = args.shell ?? 'auto';
        if (shell !== 'auto' && !nodeSupportsShell(host.capabilities, shell as Exclude<NodeShell, 'auto'>)) {
            throw new Error(`节点 ${host.nodeId} 不支持 ${shell} shell`);
        }
        const payload = await this.invokeNode(
            taskState,
            args.nodeId,
            {
                command: args.command,
                shell,
                cwd: args.workingDirectory,
                timeoutMs: args.timeout
            },
            args.timeout
        );
        result.updateResult(formatShellOutput(payload));
        const exitCode =
            payload && typeof payload === 'object' ? (payload as Record<string, unknown>).exitCode : undefined;
        if (!Number.isInteger(exitCode)) {
            throw new Error(`节点 ${host.nodeId} 返回的 shell 结果缺少整数 exitCode`);
        }
        result.updateResultObject({ exitCode: exitCode as number, nodeId: host.nodeId });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderNodeShellToolCall(toolcall);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return renderNodeShellToolCallCli(toolcall, width);
    }
}

const NodeReadFileSchema = z.object({
    nodeId: z.string().optional().describe('目标节点 ID。未指定时使用当前任务的默认执行节点'),
    path: z.string().min(1).describe('node 上要读取的文件路径，支持 node 默认目录下的相对路径或绝对路径'),
    offset: z.number().int().min(1).optional().describe('起始行号，默认 1'),
    limit: z.number().int().min(1).optional().describe('读取行数，未指定则读取到文件末尾')
});

export class ReadNodeFileTool extends NodeCommandTool<typeof NodeReadFileSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'readNodeFile',
            '读取指定或默认 node 本地文件系统中的文本文件。通过 nodeId 选择目标节点。该工具不读取 OpenDesk 本机文件。',
            NodeReadFileSchema,
            NODE_FILE_COMMANDS.readText
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeReadFileSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeNodeText(taskState, args.nodeId, {
            path: args.path,
            file_path: args.path,
            offset: args.offset,
            limit: args.limit
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof NodeReadFileSchema> | undefined;
        const filePath = args?.path;
        const detailParts = [];
        if (filePath) detailParts.push(filePath);
        const rangeStr = formatLineRange(args?.offset, args?.limit);
        if (rangeStr) detailParts.push(rangeStr);
        const result = parseJsonResult(toolcall.result);
        if (toolcall.status === 'success' && result?.type === 'text' && result.file) {
            detailParts.push(`${result.file.totalLines} 行`);
        }
        return renderNodeInlineTool({
            icon: 'fas fa-file-lines',
            title: '读取文件',
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined,
            detailTitle: filePath,
            nodeId: args?.nodeId
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof NodeReadFileSchema> | undefined;
        const body: string[] = [];
        if (args?.path) {
            let fileInfo = truncText(args.path, Math.max(8, width - 8));
            const rangeStr = formatLineRange(args.offset, args.limit);
            if (rangeStr) fileInfo += chalk.dim(` (${rangeStr})`);
            body.push(chalk.yellow(fileInfo));
        }
        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 读取中…'));
        } else if (toolcall.status === 'error' && toolcall.result != null) {
            body.push(chalk.red(`  ✗ ${truncText(String(toolcall.result), Math.max(8, width - 16))}`));
        } else if (toolcall.status === 'success') {
            const result = parseJsonResult(toolcall.result);
            if (result?.type === 'error') {
                body.push(chalk.red(`  ✗ ${truncText(result.error, Math.max(8, width - 16))}`));
            } else if (result?.type === 'text' && result.file) {
                const f = result.file;
                if (f.numLines > 0) {
                    body.push(
                        chalk.dim(`  ${f.numLines} 行 (${f.startLine}~${f.startLine + f.numLines - 1}/${f.totalLines})`)
                    );
                } else {
                    body.push(chalk.dim(`  空内容 (文件共 ${f.totalLines} 行)`));
                }
            }
        }
        return new Card({
            icon: '📖',
            title: nodeTitle('读取文件', args?.nodeId),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

const NodeWriteFileSchema = z.object({
    nodeId: z.string().optional().describe('目标节点 ID。未指定时使用当前任务的默认执行节点'),
    path: z.string().min(1).describe('node 上要写入的文件路径，支持 node 默认目录下的相对路径或绝对路径'),
    content: z.string().describe('要写入的文本内容'),
    mode: z.enum(['overwrite', 'append']).optional().default('overwrite').describe('写入模式，默认覆盖，append 为追加')
});

export class WriteNodeFileTool extends NodeCommandTool<typeof NodeWriteFileSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'writeNodeFile',
            '将文本写入指定或默认 node 的本地文件系统。通过 nodeId 选择目标节点。该工具不写入 OpenDesk 本机文件。',
            NodeWriteFileSchema,
            NODE_FILE_COMMANDS.writeText
        );
        this.setExecutor(this.run.bind(this));
        this.serialExecution = true;
    }

    private async run(args: z.output<typeof NodeWriteFileSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeNodeText(taskState, args.nodeId, {
            path: args.path,
            content: args.content,
            mode: args.mode
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof NodeWriteFileSchema> | undefined;
        const content = typeof args?.content === 'string' ? args.content : '';
        const info = getWriteContentInfo(content);
        const title = args?.mode === 'append' ? '追加文件' : '写入文件';
        const detailParts = [];
        if (args?.path) detailParts.push(args.path);
        if (toolcall.status === 'running' && info.contentLen > 0) {
            detailParts.push(`正在写入 ${info.lineCount} 行`);
        } else if (toolcall.status === 'success' && info.contentLen > 0) {
            detailParts.push(`${info.lineCount} 行, ${info.contentLen.toLocaleString()} 字符`);
        }
        return renderNodeInlineTool({
            icon: 'fas fa-pen-to-square',
            title,
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined,
            detailTitle: args?.path,
            nodeId: args?.nodeId
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof NodeWriteFileSchema> | undefined;
        const content = typeof args?.content === 'string' ? args.content : '';
        const info = getWriteContentInfo(content);
        const body: string[] = [];
        if (args?.path) body.push(chalk.yellow(truncText(args.path, Math.max(8, width - 8))));
        if (info.contentLen > 0) {
            if (toolcall.status === 'success') {
                body.push(chalk.dim(`  ${info.lineCount} 行, ${info.contentLen.toLocaleString()} 字符`));
            } else {
                body.push(chalk.dim(`  ✍ 正在写入… ${info.lineCount} 行`));
                body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
                for (const line of info.tailLines) {
                    body.push('  ' + chalk.cyan(truncText(line, Math.max(8, width - 10))));
                }
            }
        } else if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 等待内容…'));
        }
        const title = args?.mode === 'append' ? '追加文件' : '写入文件';
        return new Card({
            icon: '✏️',
            title: nodeTitle(title, args?.nodeId),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

const FetchNodeFileSchema = z.object({
    nodeId: z.string().optional().describe('目标节点 ID。未指定时使用当前任务的默认执行节点'),
    node: z.string().optional().describe('兼容 file_fetch 的 node 参数，可填写节点 ID、显示名或 IP'),
    path: z.string().min(1).describe('node 上要拉取的文件绝对路径，由 node 端规范化'),
    maxBytes: z.number().int().positive().optional().describe('最大拉取字节数，默认 8 MB，硬上限 16 MB'),
    localPath: z.string().optional().describe('保存到 OpenDesk 本机/网关侧的路径；未指定时保存到临时 media 目录'),
    overwrite: z.boolean().optional().describe('localPath 已存在时是否覆盖，默认 false'),
    timeoutMs: z.number().int().positive().optional().describe('node 调用超时时间（毫秒）')
});

export class FetchNodeFileTool extends NodeCommandTool<typeof FetchNodeFileSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'fetchNodeFile',
            '从指定或默认 node 拉取文件到 OpenDesk 本机/网关侧。参数结构对齐 file_fetch：node/path/maxBytes/timeoutMs，并额外支持 localPath 保存位置。',
            FetchNodeFileSchema,
            NODE_FILE_COMMANDS.fetch
        );
        this.setExecutor(this.run.bind(this));
        this.serialExecution = true;
    }

    getDeclaredPermissions(args: z.output<typeof FetchNodeFileSchema>, taskState?: TaskState): PermissionRequest[] {
        if (typeof args.localPath !== 'string' || !args.localPath.trim()) return [];
        const p = sanitizeLocalPath(args.localPath, getWorkingDirectory(taskState));
        if (!p) return [];
        return [{ resourceType: 'file', action: 'write', resourcePath: p }];
    }

    private async run(args: z.output<typeof FetchNodeFileSchema>, taskState?: TaskState): Promise<string> {
        const nodeSelector = getNodeSelector(args);
        const host = resolveTargetNode(taskState, nodeSelector, this.nodeCommand, this.app);
        const maxBytes = clampTransferMaxBytes(args.maxBytes);
        const payload = await this.invokeNode(
            taskState,
            nodeSelector,
            {
                path: args.path,
                maxBytes
            },
            args.timeoutMs
        );
        const obj = asPayloadObject(payload, 'unexpected file.fetch payload');
        if (obj.ok !== true) {
            throw new Error('unexpected file.fetch payload: ok=true missing');
        }

        const canonicalPath = typeof obj.path === 'string' ? obj.path : '';
        const size = typeof obj.size === 'number' ? obj.size : -1;
        const mimeType = typeof obj.mimeType === 'string' ? obj.mimeType : 'application/octet-stream';
        const hasBase64 = typeof obj.base64 === 'string';
        const base64 = hasBase64 ? (obj.base64 as string) : '';
        const sha256 = typeof obj.sha256 === 'string' ? obj.sha256 : '';
        if (!canonicalPath || size < 0 || !hasBase64 || !sha256) {
            throw new Error('invalid file.fetch payload (missing path/size/base64/sha256)');
        }

        const buffer = Buffer.from(base64, 'base64');
        if (buffer.byteLength !== size) {
            throw new Error(`file.fetch size mismatch: payload says ${size} bytes, decoded ${buffer.byteLength}`);
        }
        const localSha256 = sha256Hex(buffer);
        if (localSha256 !== sha256) {
            throw new Error('file.fetch sha256 mismatch');
        }

        const saved = await saveNodeFileMediaRecord({
            buffer,
            nodePath: canonicalPath,
            mimeType,
            sha256,
            localPath: args.localPath,
            overwrite: args.overwrite === true,
            taskState
        });

        return formatJsonResult({
            ok: true,
            nodeId: host.nodeId,
            path: canonicalPath,
            size,
            mimeType,
            sha256,
            localPath: saved.localPath,
            mediaId: saved.mediaId
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof FetchNodeFileSchema> | undefined;
        const result = parseJsonResult(toolcall.result);
        const detailParts = [];
        if (args?.path) detailParts.push(args.path);
        if (result?.localPath) detailParts.push(`保存到 ${result.localPath}`);
        if (typeof result?.size === 'number') detailParts.push(`${result.size.toLocaleString()} bytes`);
        return renderNodeInlineTool({
            icon: 'fas fa-file-import',
            title: '拉取文件',
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined,
            detailTitle: args?.path,
            nodeId: args?.nodeId || args?.node
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof FetchNodeFileSchema> | undefined;
        const result = parseJsonResult(toolcall.result);
        const body: string[] = [];
        if (args?.path) body.push(chalk.yellow(truncText(args.path, Math.max(8, width - 8))));
        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 拉取中…'));
        } else if (toolcall.status === 'success' && result?.localPath) {
            body.push(chalk.dim('  保存到: ') + chalk.green(truncText(result.localPath, Math.max(8, width - 14))));
            if (typeof result.size === 'number') {
                body.push(chalk.dim(`  ${result.size.toLocaleString()} bytes, sha256:${result.sha256?.slice(0, 12)}`));
            }
        }
        return new Card({
            icon: '⇣',
            title: nodeTitle('拉取文件', args?.nodeId || args?.node),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

const SendNodeFileSchema = z.object({
    nodeId: z.string().optional().describe('目标节点 ID。未指定时使用当前任务的默认执行节点'),
    node: z.string().optional().describe('兼容 file_write 的 node 参数，可填写节点 ID、显示名或 IP'),
    path: z.string().min(1).describe('node 上要写入的绝对路径，由 node 端规范化'),
    localPath: z.string().optional().describe('OpenDesk 本机/网关侧源文件路径，适合发送 skill 内脚本到 node'),
    contentBase64: z.string().optional().describe('要写入的 base64 编码字节，解码后最大 16 MB'),
    sourceMediaId: z.string().optional().describe('fetchNodeFile 返回的 mediaId，用于二进制转发'),
    mimeType: z.string().optional().describe('内容类型提示，仅用于展示和后续兼容，node 端不强校验'),
    overwrite: z.boolean().optional().describe('允许覆盖 node 上已有文件，默认 false'),
    createParents: z.boolean().optional().describe('创建缺失的父目录，默认 false'),
    timeoutMs: z.number().int().positive().optional().describe('node 调用超时时间（毫秒）')
});

export class SendNodeFileTool extends NodeCommandTool<typeof SendNodeFileSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'sendNodeFile',
            '将 OpenDesk 本机/网关侧文件或 base64 内容写入指定或默认 node。参数结构对齐 file_write：node/path/contentBase64/sourceMediaId/overwrite/createParents，并额外支持 localPath。',
            SendNodeFileSchema,
            NODE_FILE_COMMANDS.write
        );
        this.setExecutor(this.run.bind(this));
        this.serialExecution = true;
    }

    getDeclaredPermissions(args: z.output<typeof SendNodeFileSchema>, taskState?: TaskState): PermissionRequest[] {
        if (typeof args.localPath !== 'string' || !args.localPath.trim()) return [];
        const p = sanitizeLocalPath(args.localPath, getWorkingDirectory(taskState));
        if (!p) return [];
        return [{ resourceType: 'file', action: 'read', resourcePath: p }];
    }

    private async run(args: z.output<typeof SendNodeFileSchema>, taskState?: TaskState): Promise<string> {
        const nodeSelector = getNodeSelector(args);
        const host = resolveTargetNode(taskState, nodeSelector, this.nodeCommand, this.app);
        const sourceBytes = await readSendSourceBytes({
            localPath: args.localPath,
            contentBase64: args.contentBase64,
            sourceMediaId: args.sourceMediaId,
            taskState
        });
        const expectedSha256 = sha256Hex(sourceBytes.buffer);

        const payload = await this.invokeNode(
            taskState,
            nodeSelector,
            {
                path: args.path,
                contentBase64: sourceBytes.contentBase64,
                overwrite: args.overwrite === true,
                createParents: args.createParents === true,
                expectedSha256
            },
            args.timeoutMs
        );
        const obj = asPayloadObject(payload, 'unexpected file.write payload');
        if (obj.ok !== true) {
            throw new Error('unexpected file.write payload: ok=true missing');
        }

        const resultPath = typeof obj.path === 'string' ? obj.path : args.path;
        const size = typeof obj.size === 'number' ? obj.size : sourceBytes.buffer.byteLength;
        const sha256 = typeof obj.sha256 === 'string' ? obj.sha256 : expectedSha256;
        if (size !== sourceBytes.buffer.byteLength) {
            throw new Error(`file.write size mismatch: node says ${size} bytes, sent ${sourceBytes.buffer.byteLength}`);
        }
        if (sha256 !== expectedSha256) {
            throw new Error('file.write sha256 mismatch');
        }

        return formatJsonResult({
            ok: true,
            nodeId: host.nodeId,
            path: resultPath,
            size,
            sha256,
            overwritten: obj.overwritten === true,
            source: sourceBytes.source,
            sourcePath: sourceBytes.sourcePath,
            sourceMediaId: sourceBytes.sourceMediaId,
            mimeType: args.mimeType
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof SendNodeFileSchema> | undefined;
        const result = parseJsonResult(toolcall.result);
        const source =
            args?.localPath || args?.sourceMediaId || (args?.contentBase64 !== undefined ? 'contentBase64' : '');
        const detailParts = [];
        if (source) detailParts.push(String(source));
        if (args?.path) detailParts.push(`-> ${args.path}`);
        if (typeof result?.size === 'number') detailParts.push(`${result.size.toLocaleString()} bytes`);
        return renderNodeInlineTool({
            icon: 'fas fa-file-export',
            title: '发送文件',
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined,
            detailTitle: args?.path,
            nodeId: args?.nodeId || args?.node
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof SendNodeFileSchema> | undefined;
        const result = parseJsonResult(toolcall.result);
        const body: string[] = [];
        const source =
            args?.localPath || args?.sourceMediaId || (args?.contentBase64 !== undefined ? 'contentBase64' : '');
        if (source) body.push(chalk.dim('源: ') + chalk.yellow(truncText(String(source), Math.max(8, width - 12))));
        if (args?.path) body.push(chalk.dim('目标: ') + chalk.yellow(truncText(args.path, Math.max(8, width - 14))));
        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 发送中…'));
        } else if (toolcall.status === 'success' && typeof result?.size === 'number') {
            body.push(chalk.dim(`  ${result.size.toLocaleString()} bytes, sha256:${result.sha256?.slice(0, 12)}`));
        }
        return new Card({
            icon: '⇡',
            title: nodeTitle('发送文件', args?.nodeId || args?.node),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

const NodeEditFileSchema = z.object({
    nodeId: z.string().optional().describe('目标节点 ID。未指定时使用当前任务的默认执行节点'),
    filePath: z.string().min(1).describe('node 上要修改的文件路径'),
    oldString: z.string().min(1, 'oldString 不能为空').describe('要替换的原始文本'),
    newString: z.string().describe('替换后的新文本'),
    expectedReplacements: z.number().int().min(1).optional().describe('预期替换次数，默认 1')
});

export class EditNodeFileTool extends NodeCommandTool<typeof NodeEditFileSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'editNodeFile',
            '在指定或默认 node 的文件中执行精确文本替换。通过 nodeId 选择目标节点。',
            NodeEditFileSchema,
            NODE_FILE_COMMANDS.editText
        );
        this.setExecutor(this.run.bind(this));
        this.serialExecution = true;
    }

    private async run(args: z.output<typeof NodeEditFileSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeNodeText(taskState, args.nodeId, args);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof NodeEditFileSchema> | undefined;
        const filePath = args?.filePath;
        const oldString = args?.oldString;
        const newString = args?.newString;
        if (
            oldString &&
            newString !== undefined &&
            filePath &&
            (toolcall.status === 'success' || toolcall.status === 'running')
        ) {
            return renderNodeDiffCard('编辑文件', filePath, oldString, newString, toolcall.status, 12, args?.nodeId);
        }
        const detailParts = [];
        if (filePath) detailParts.push(filePath);
        if (oldString && newString !== undefined) {
            detailParts.push(`${args?.expectedReplacements || 1} 处替换`);
        }
        return renderNodeInlineTool({
            icon: 'fas fa-scissors',
            title: '编辑文件',
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined,
            detailTitle: filePath,
            nodeId: args?.nodeId
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof NodeEditFileSchema> | undefined;
        const oldString = args?.oldString;
        const newString = args?.newString;
        const body: string[] = [];
        if (args?.filePath) body.push(chalk.yellow(truncText(args.filePath, Math.max(8, width - 8))));
        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 编辑中…'));
        } else if (toolcall.status === 'success') {
            const expectedReplacements = args?.expectedReplacements || 1;
            body.push(chalk.dim(`  ✅ 已完成 ${expectedReplacements} 处替换`));
            if (oldString && newString !== undefined) {
                const diffLines = renderDiffOutput(oldString, newString, width);
                if (diffLines.length > 0) {
                    body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
                    body.push(...diffLines);
                }
            }
        }
        return new Card({
            icon: '✂️',
            title: nodeTitle('编辑文件', args?.nodeId),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

const NodeSearchReplaceSchema = z.object({
    nodeId: z.string().optional().describe('目标节点 ID。未指定时使用当前任务的默认执行节点'),
    filePath: z.string().min(1).describe('node 上要执行搜索替换的文件路径'),
    oldString: z.string().describe('要搜索的字符串'),
    newString: z.string().describe('替换 oldString 的新字符串')
});

export class SearchReplaceNodeFileTool extends NodeCommandTool<typeof NodeSearchReplaceSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'searchReplaceNodeFile',
            '在指定或默认 node 的指定文件中执行一次搜索替换操作。通过 nodeId 选择目标节点。',
            NodeSearchReplaceSchema,
            NODE_FILE_COMMANDS.searchReplace
        );
        this.setExecutor(this.run.bind(this));
        this.serialExecution = true;
    }

    private async run(args: z.output<typeof NodeSearchReplaceSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeNodeText(taskState, args.nodeId, args);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof NodeSearchReplaceSchema> | undefined;
        if (
            args?.oldString &&
            args.newString !== undefined &&
            args.filePath &&
            (toolcall.status === 'success' || toolcall.status === 'running')
        ) {
            return renderNodeDiffCard(
                '替换文件',
                args.filePath,
                args.oldString,
                args.newString,
                toolcall.status,
                12,
                args?.nodeId
            );
        }
        return renderNodeInlineTool({
            icon: 'fas fa-right-left',
            title: '替换文件',
            status: toolcall.status,
            detail: args?.filePath,
            detailTitle: args?.filePath,
            nodeId: args?.nodeId
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof NodeSearchReplaceSchema> | undefined;
        const body: string[] = [];
        if (args?.filePath) body.push(chalk.yellow(truncText(args.filePath, Math.max(8, width - 8))));
        if (args?.oldString) {
            const preview = args.oldString.length > 30 ? args.oldString.slice(0, 30) + '…' : args.oldString;
            body.push(chalk.dim(`  搜索: "${preview}"`));
        }
        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 执行中…'));
        } else if (toolcall.status === 'success') {
            body.push(chalk.dim('  ✅ 替换完成'));
            if (args?.oldString && args.newString !== undefined) {
                const diffLines = renderDiffOutput(args.oldString, args.newString, width);
                if (diffLines.length > 0) {
                    body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
                    body.push(...diffLines);
                }
            }
        }
        return new Card({
            icon: '🔍',
            title: nodeTitle('替换文件', args?.nodeId),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

const NodeGlobSchema = z.object({
    nodeId: z.string().optional().describe('目标节点 ID。未指定时使用当前任务的默认执行节点'),
    pattern: z.string().min(1).describe('node 上的 glob 模式，如 **/*.ts、src/**/*.js、*.md'),
    path: z.string().optional().describe('node 上的搜索根目录，默认使用 node 默认目录'),
    ignore: z.array(z.string()).optional().describe('额外忽略模式，是否生效取决于 node 实现'),
    caseSensitive: z.boolean().optional().default(false).describe('是否区分大小写，是否生效取决于 node 实现'),
    maxResults: z.number().int().min(1).max(1000).optional().default(200).describe('最大返回结果数，默认 200')
});

export class GlobNodeFilesTool extends NodeCommandTool<typeof NodeGlobSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'globNodeFiles',
            '在指定或默认 node 的文件系统中使用 glob 模式搜索文件。通过 nodeId 选择目标节点。',
            NodeGlobSchema,
            NODE_FILE_COMMANDS.glob
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeGlobSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeNodeText(taskState, args.nodeId, args);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof NodeGlobSchema> | undefined;
        const detailParts = [];
        if (args?.pattern) detailParts.push(args.pattern);
        if (args?.path) detailParts.push(args.path);
        const foundMatch = toolcall.status === 'success' ? toolcall.result?.match(/找到 (\d+) 个文件/) : undefined;
        if (foundMatch) detailParts.push(`${foundMatch[1]} 个文件`);
        const files = toolcall.result
            ?.split('\n')
            .filter((line) => line.trim() && !line.startsWith('找到') && !line.startsWith('…'));
        return renderNodeInlineTool({
            icon: 'fas fa-magnifying-glass',
            title: '搜索文件',
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined,
            fileList: files,
            nodeId: args?.nodeId
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof NodeGlobSchema> | undefined;
        const body: string[] = [];
        if (args?.pattern) body.push(chalk.cyan('模式: ') + chalk.white(args.pattern));
        if (args?.path) body.push(chalk.dim('目录: ') + truncText(args.path, Math.max(8, width - 12)));
        if (args?.ignore && args.ignore.length > 0) {
            body.push(chalk.dim('忽略: ') + args.ignore.slice(0, 3).join(', ') + (args.ignore.length > 3 ? '…' : ''));
        }
        if (toolcall.status === 'running') {
            body.push(chalk.dim('  🔍 搜索中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            const lines = toolcall.result.split('\n');
            const foundMatch = toolcall.result.match(/找到 (\d+) 个文件/);
            body.push(chalk.dim('  ✅ 找到 ') + chalk.green(foundMatch?.[1] || '0') + chalk.dim(' 个文件'));
            const files = lines.filter((line) => line.trim() && !line.startsWith('找到') && !line.startsWith('…'));
            for (const file of files.slice(0, 5)) {
                body.push(chalk.dim('    ') + truncText(file, Math.max(8, width - 8)));
            }
            if (files.length > 5) body.push(chalk.dim(`    … 共 ${files.length} 个结果`));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.red(`  ✗ ${truncText(String(toolcall.result), Math.max(8, width - 10))}`));
        }
        return new Card({
            icon: '🔍',
            title: nodeTitle('搜索文件', args?.nodeId),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

const NodeGrepSchema = z.object({
    nodeId: z.string().optional().describe('目标节点 ID。未指定时使用当前任务的默认执行节点'),
    pattern: z.string().min(1).describe('node 上要搜索的文本或正则表达式'),
    path: z.string().optional().describe('node 上的搜索根目录，默认使用 node 默认目录'),
    filePattern: z.string().optional().default('**/*').describe('要搜索的文件 glob 模式，默认 **/*'),
    ignoreCase: z.boolean().optional().default(true).describe('是否忽略大小写，默认 true'),
    maxResults: z.number().int().min(1).max(1000).optional().default(50).describe('最大匹配数，默认 50'),
    contextLines: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .default(0)
        .describe('上下文行数，是否生效取决于 node 实现')
});

export class GrepNodeFilesTool extends NodeCommandTool<typeof NodeGrepSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'grepNodeFiles',
            '在指定或默认 node 的文件内容中搜索文本或正则表达式。通过 nodeId 选择目标节点。',
            NodeGrepSchema,
            NODE_FILE_COMMANDS.grep
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeGrepSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeNodeText(taskState, args.nodeId, args);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof NodeGrepSchema> | undefined;
        const detailParts = [];
        if (args?.pattern) detailParts.push(args.pattern);
        if (args?.path) detailParts.push(args.path);
        const summaryMatch =
            toolcall.status === 'success' ? toolcall.result?.match(/在 (\d+) 个文件中找到 (\d+) 处匹配/) : undefined;
        if (summaryMatch) detailParts.push(`${summaryMatch[1]} 文件 / ${summaryMatch[2]} 处匹配`);
        const matchLines = toolcall.result?.split('\n').filter((line) => line.startsWith('> '));
        return renderNodeInlineTool({
            icon: 'fas fa-code',
            title: '检索内容',
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined,
            fileList: matchLines,
            nodeId: args?.nodeId
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof NodeGrepSchema> | undefined;
        const body: string[] = [];
        if (args?.pattern) body.push(chalk.cyan('模式: ') + chalk.white(args.pattern));
        if (args?.path) body.push(chalk.dim('路径: ') + truncText(args.path, Math.max(8, width - 12)));
        if (args?.filePattern) body.push(chalk.dim('文件: ') + args.filePattern);
        if (args?.ignoreCase === false) body.push(chalk.dim('选项: 区分大小写'));
        if (toolcall.status === 'running') {
            body.push(chalk.dim('  🔍 搜索中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            const lines = toolcall.result.split('\n');
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
            const matchLines = lines.filter((line) => line.startsWith('> '));
            for (const matchLine of matchLines.slice(0, 5)) {
                body.push(chalk.dim('    ') + truncText(matchLine, Math.max(8, width - 8)));
            }
            if (matchLines.length > 5) body.push(chalk.dim(`    … 共 ${matchLines.length} 个结果`));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.red(`  ✗ ${truncText(String(toolcall.result), Math.max(8, width - 10))}`));
        }
        return new Card({
            icon: '🔎',
            title: nodeTitle('检索内容', args?.nodeId),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

export function createNodeExecutionTools(app: DeviceMgrApplication): BaseTool<any>[] {
    return [
        new ExecuteNodeShellTool(app),
        new ReadNodeFileTool(app),
        new WriteNodeFileTool(app),
        new SendNodeFileTool(app),
        new FetchNodeFileTool(app),
        new EditNodeFileTool(app),
        new SearchReplaceNodeFileTool(app),
        new GlobNodeFilesTool(app),
        new GrepNodeFilesTool(app)
    ];
}
