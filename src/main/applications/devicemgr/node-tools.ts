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

import { z } from 'zod';
import { BaseTool, BaseToolset, ToolResult } from '../../aikernel/tool.js';
import type { ToolCall } from '../../aikernel/messages.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { ExecutionHost } from '../../aikernel/security/harness.js';
import { escapeHtml } from '../../../common/utils/escape.js';
import { Card } from '../../tui/components/card.js';
import { statusDisplay, truncText } from '../../tui/components/toolcall.js';
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

type SelectedNodeHost = Extract<ExecutionHost, { type: 'node' }>;

const MAX_CLI_OUTPUT_LINES = 10;
const MAX_DIFF_LINES = 50;
const DIFF_CONTEXT_LINES = 3;
const WRITE_FILE_TAIL_LINES = 5;

function getSelectedNodeHost(taskState?: TaskState): SelectedNodeHost | null {
    const host = taskState?.harnessContext?.executionHost;
    return host?.type === 'node' ? host : null;
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

function nodeTitle(title: string): string {
    return `${title} node`;
}

function nodeBadgeHtml(): string {
    return '<span class="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">node</span>';
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
            ${nodeBadgeHtml()}
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
    maxLines: number = 12
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
            ${nodeBadgeHtml()}
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
    if (isRunning) {
        bodyContent += `
        <div class="px-4 py-3 flex items-center gap-2 text-blue-400 text-[12px] border-t border-gray-100">
            <i class="fa-solid fa-circle-notch fa-spin"></i>
            <span class="text-gray-400">命令执行中，请稍候…</span>
        </div>`;
    } else if (toolcall.result) {
        bodyContent += `
        <div class="px-4 py-2.5 border-t border-gray-100">
            <pre class="terminal-tool-output ${outputColor}">${escapeHtml(toolcall.result)}</pre>
        </div>`;
    }

    return `
    <details class="terminal-tool my-1.5 rounded-lg border ${borderColor} bg-white overflow-hidden" open>
        <summary class="terminal-tool-summary flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150">
            <svg class="w-4 h-4 ${iconColor} shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
                <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 9l3 3-3 3"/><line x1="14" y1="15" x2="16" y2="15"/>
            </svg>
            ${nodeBadgeHtml()}
            <span class="text-[12px] ${headerTextColor} font-medium truncate flex-1">${headerText}</span>
            <svg class="terminal-tool-chevron w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M6 9l6 6 6-6"/>
            </svg>
        </summary>
        <div class="border-t border-gray-100 bg-gray-50/40">
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
        ? `${nodeTitle(baseTitle)} (${truncText(description, Math.max(12, width - 36))})`
        : nodeTitle(baseTitle);
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

    isAvailable(taskState?: TaskState): boolean {
        const host = getSelectedNodeHost(taskState);
        if (!host || !nodeSupportsCommand(host.capabilities, this.nodeCommand)) return false;
        const gateway = this.app.getGateway();
        return Boolean(gateway?.isRunning() && gateway.getNodeRegistry().get(host.nodeId));
    }

    protected async invokeSelectedNode(
        taskState: TaskState | undefined,
        payload?: unknown,
        timeoutMs?: number
    ): Promise<unknown> {
        const host = getSelectedNodeHost(taskState);
        if (!host) {
            throw new Error('当前任务未选择 node，无法执行 node 工具');
        }
        if (!nodeSupportsCommand(host.capabilities, this.nodeCommand)) {
            throw new Error(`节点 ${host.nodeId} 不支持 ${this.nodeCommand}`);
        }

        const gateway = this.app.getGateway();
        if (!gateway?.isRunning()) {
            throw new Error('设备网关未启动，无法执行 node 工具');
        }
        const result = await gateway.getNodeRegistry().invoke({
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

    protected async invokeSelectedNodeText(
        taskState: TaskState | undefined,
        payload?: unknown,
        timeoutMs?: number
    ): Promise<string> {
        return payloadToText(await this.invokeSelectedNode(taskState, payload, timeoutMs));
    }
}

const NodeShellSchema = z.object({
    command: z.string().min(1, '命令不能为空').describe('要在当前选中 node 上执行的 shell 命令'),
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
        super(
            app,
            'executeNodeShell',
            '在当前选中的 node 上执行 shell 命令。该工具只访问 node 端环境；OpenDesk 本机 shell 请使用 executeBash/executePowerShell/executeZsh。',
            NodeShellSchema,
            NODE_SHELL_COMMAND
        );
        this.setUniversalExecutor(this.run.bind(this));
    }

    async run(args: z.output<typeof NodeShellSchema>, result: ToolResult, taskState?: TaskState): Promise<void> {
        const host = getSelectedNodeHost(taskState);
        if (!host) {
            throw new Error('当前任务未选择 node，无法执行 node shell 工具');
        }
        const shell = args.shell ?? 'auto';
        if (shell !== 'auto' && !nodeSupportsShell(host.capabilities, shell as Exclude<NodeShell, 'auto'>)) {
            throw new Error(`节点 ${host.nodeId} 不支持 ${shell} shell`);
        }
        const payload = await this.invokeSelectedNode(
            taskState,
            {
                command: args.command,
                shell,
                cwd: args.workingDirectory,
                timeoutMs: args.timeout
            },
            args.timeout
        );
        result.updateResult(formatShellOutput(payload));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderNodeShellToolCall(toolcall);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return renderNodeShellToolCallCli(toolcall, width);
    }
}

const NodeReadFileSchema = z.object({
    path: z.string().min(1).describe('node 上要读取的文件路径，支持 node 默认目录下的相对路径或绝对路径'),
    offset: z.number().int().min(1).optional().describe('起始行号，默认 1'),
    limit: z.number().int().min(1).optional().describe('读取行数，未指定则读取到文件末尾')
});

export class ReadNodeFileTool extends NodeCommandTool<typeof NodeReadFileSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'readNodeFile',
            '读取当前选中 node 本地文件系统中的文本文件。该工具不读取 OpenDesk 本机文件。',
            NodeReadFileSchema,
            NODE_FILE_COMMANDS.readText
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeReadFileSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeSelectedNodeText(taskState, {
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
            detailTitle: filePath
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
            title: nodeTitle('读取文件'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

const NodeWriteFileSchema = z.object({
    path: z.string().min(1).describe('node 上要写入的文件路径，支持 node 默认目录下的相对路径或绝对路径'),
    content: z.string().describe('要写入的文本内容'),
    mode: z.enum(['overwrite', 'append']).optional().default('overwrite').describe('写入模式，默认覆盖，append 为追加')
});

export class WriteNodeFileTool extends NodeCommandTool<typeof NodeWriteFileSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'writeNodeFile',
            '将文本写入当前选中 node 的本地文件系统。该工具不写入 OpenDesk 本机文件。',
            NodeWriteFileSchema,
            NODE_FILE_COMMANDS.writeText
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeWriteFileSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeSelectedNodeText(taskState, {
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
            detailTitle: args?.path
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
            title: nodeTitle(title),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

const NodeEditFileSchema = z.object({
    filePath: z.string().min(1).describe('node 上要修改或创建的文件路径'),
    oldString: z.string().describe('要替换的原始文本。使用空字符串可创建新文件'),
    newString: z.string().describe('替换后的新文本。当创建新文件时，此参数将成为文件内容'),
    expectedReplacements: z.number().int().min(1).optional().describe('预期替换次数，默认 1')
});

export class EditNodeFileTool extends NodeCommandTool<typeof NodeEditFileSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'editNodeFile',
            '在当前选中 node 的文件中执行精确文本替换，也可用空 oldString 创建 node 上的新文件。',
            NodeEditFileSchema,
            NODE_FILE_COMMANDS.editText
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeEditFileSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeSelectedNodeText(taskState, args);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof NodeEditFileSchema> | undefined;
        const filePath = args?.filePath;
        const oldString = args?.oldString;
        const newString = args?.newString;
        const isNewFile = oldString === '' || oldString === undefined;
        const title = isNewFile ? '创建文件' : '编辑文件';
        if (
            !isNewFile &&
            oldString &&
            newString !== undefined &&
            filePath &&
            (toolcall.status === 'success' || toolcall.status === 'running')
        ) {
            return renderNodeDiffCard(title, filePath, oldString, newString, toolcall.status);
        }
        const detailParts = [];
        if (filePath) detailParts.push(filePath);
        if (isNewFile && toolcall.status === 'success' && newString) {
            detailParts.push(`${newString.length.toLocaleString()} 字符`);
        } else if (!isNewFile && oldString && newString !== undefined) {
            detailParts.push(`${args?.expectedReplacements || 1} 处替换`);
        }
        return renderNodeInlineTool({
            icon: isNewFile ? 'fas fa-file-circle-plus' : 'fas fa-scissors',
            title,
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined,
            detailTitle: filePath
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof NodeEditFileSchema> | undefined;
        const oldString = args?.oldString;
        const newString = args?.newString;
        const isNewFile = oldString === '' || oldString === undefined;
        const title = isNewFile ? '创建文件' : '编辑文件';
        const body: string[] = [];
        if (args?.filePath) body.push(chalk.yellow(truncText(args.filePath, Math.max(8, width - 8))));
        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 编辑中…'));
        } else if (toolcall.status === 'success') {
            if (isNewFile) {
                body.push(chalk.dim('  ✅ 新文件已创建'));
            } else {
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
        }
        return new Card({
            icon: isNewFile ? '📄' : '✂️',
            title: nodeTitle(title),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

const NodeSearchReplaceSchema = z.object({
    filePath: z.string().min(1).describe('node 上要执行搜索替换的文件路径'),
    oldString: z.string().describe('要搜索的字符串'),
    newString: z.string().describe('替换 oldString 的新字符串')
});

export class SearchReplaceNodeFileTool extends NodeCommandTool<typeof NodeSearchReplaceSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'searchReplaceNodeFile',
            '在当前选中 node 的指定文件中执行一次搜索替换操作。',
            NodeSearchReplaceSchema,
            NODE_FILE_COMMANDS.searchReplace
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeSearchReplaceSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeSelectedNodeText(taskState, args);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof NodeSearchReplaceSchema> | undefined;
        if (
            args?.oldString &&
            args.newString !== undefined &&
            args.filePath &&
            (toolcall.status === 'success' || toolcall.status === 'running')
        ) {
            return renderNodeDiffCard('替换文件', args.filePath, args.oldString, args.newString, toolcall.status);
        }
        return renderNodeInlineTool({
            icon: 'fas fa-right-left',
            title: '替换文件',
            status: toolcall.status,
            detail: args?.filePath,
            detailTitle: args?.filePath
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
            title: nodeTitle('替换文件'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

const NodeGlobSchema = z.object({
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
            '在当前选中 node 的文件系统中使用 glob 模式搜索文件。',
            NodeGlobSchema,
            NODE_FILE_COMMANDS.glob
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeGlobSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeSelectedNodeText(taskState, args);
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
            fileList: files
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
            title: nodeTitle('搜索文件'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

const NodeGrepSchema = z.object({
    pattern: z.string().min(1).describe('node 上要搜索的文本或正则表达式'),
    path: z.string().optional().describe('node 上的搜索根目录，默认使用 node 默认目录'),
    filePattern: z.string().optional().default('**/*').describe('要搜索的文件 glob 模式，默认 **/*'),
    ignoreCase: z.boolean().optional().default(true).describe('是否忽略大小写，默认 true'),
    maxResults: z.number().int().min(1).max(1000).optional().default(50).describe('最大匹配数，默认 50'),
    contextLines: z.number().int().min(0).max(10).optional().default(0).describe('上下文行数，是否生效取决于 node 实现')
});

export class GrepNodeFilesTool extends NodeCommandTool<typeof NodeGrepSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'grepNodeFiles',
            '在当前选中 node 的文件内容中搜索文本或正则表达式。',
            NodeGrepSchema,
            NODE_FILE_COMMANDS.grep
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeGrepSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeSelectedNodeText(taskState, args);
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
            fileList: matchLines
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
            title: nodeTitle('检索内容'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}

export function createNodeExecutionToolset(app: DeviceMgrApplication): BaseToolset {
    const toolset = new BaseToolset('devicemgr-node');
    toolset.addTool(new ExecuteNodeShellTool(app));
    toolset.addTool(new ReadNodeFileTool(app));
    toolset.addTool(new WriteNodeFileTool(app));
    toolset.addTool(new EditNodeFileTool(app));
    toolset.addTool(new SearchReplaceNodeFileTool(app));
    toolset.addTool(new GlobNodeFilesTool(app));
    toolset.addTool(new GrepNodeFilesTool(app));
    return toolset;
}
