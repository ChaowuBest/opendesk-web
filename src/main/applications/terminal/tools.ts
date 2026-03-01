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

import { spawn } from "child_process";
import { BaseTool } from "../../aikernel/tool";
import { ToolCall } from "../../aikernel/messages";
import { escapeHtml } from "../../utils/escape";
import { Card } from "../../tui/components/card";
import { statusDisplay, truncText } from "../../tui/components/toolcall";
import chalk from "chalk";
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import * as diff from 'diff';


const MAX_CLI_OUTPUT_LINES = 8;
const MAX_DIFF_LINES = 50;
const DIFF_CONTEXT_LINES = 3; // 上下文行数

/**
 * 渲染类似 git diff 格式的输出
 * 显示行号、上下文、带背景色的增删行
 * 使用 diff 库进行差异计算
 */
function renderDiffOutput(oldContent: string, newContent: string, width: number): string[] {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // 使用 diff 库计算行级别差异
    const diffResult = diff.diffLines(oldContent, newContent);

    // 统计修改行数
    let addedCount = 0;
    let removedCount = 0;
    for (const part of diffResult) {
        if (part.added) {
            addedCount += part.count || 0;
        } else if (part.removed) {
            removedCount += part.count || 0;
        }
    }

    // 如果修改行数超过 50 行，不显示 diff
    if (addedCount + removedCount > MAX_DIFF_LINES) {
        return [chalk.dim(`  修改超过 ${MAX_DIFF_LINES} 行，不显示 diff`)];
    }

    const body: string[] = [];

    // 构建带行号的 diff 输出
    let oldLineNum = 1;
    let newLineNum = 1;

    // 收集所有 diff 块，用于确定需要显示的上下文
    interface DiffBlock {
        oldStart: number;
        oldEnd: number;
        newStart: number;
        newEnd: number;
        lines: Array<{ type: 'context' | 'removed' | 'added'; oldNum?: number; newNum?: number; content: string }>;
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
            // 上下文行
            if (currentBlock) {
                // 添加到当前块的末尾（最多 DIFF_CONTEXT_LINES 行）
                let contextCount = 0;
                for (const line of lines) {
                    if (contextCount < DIFF_CONTEXT_LINES) {
                        currentBlock.lines.push({ type: 'context', oldNum: oldLineNum, newNum: newLineNum, content: line });
                        contextCount++;
                    }
                    oldLineNum++;
                    newLineNum++;
                }
                blocks.push(currentBlock);
                currentBlock = null;
            } else {
                // 检查是否需要作为下一个块的前置上下文
                const contextLines = lines.slice(-DIFF_CONTEXT_LINES);
                oldLineNum += lines.length - contextLines.length;
                newLineNum += lines.length - contextLines.length;

                // 这些上下文行会在下一个块开始时处理
                if (contextLines.length > 0) {
                    currentBlock = {
                        oldStart: oldLineNum,
                        oldEnd: oldLineNum + contextLines.length - 1,
                        newStart: newLineNum,
                        newEnd: newLineNum + contextLines.length - 1,
                        lines: []
                    };
                    for (const line of contextLines) {
                        currentBlock.lines.push({ type: 'context', oldNum: oldLineNum, newNum: newLineNum, content: line });
                        oldLineNum++;
                        newLineNum++;
                    }
                    // 不立即 push，等待后续的修改行
                } else {
                    oldLineNum += lines.length;
                    newLineNum += lines.length;
                }
            }
        }
    }

    // 处理最后一个块
    if (currentBlock) {
        blocks.push(currentBlock);
    }

    // 渲染所有块
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];

        // 添加块分隔（如果需要）
        if (i > 0) {
            body.push(chalk.dim('  ...'));
        }

        // 添加 diff header（类似 git diff 的 @@ -1,5 +1,6 @@）
        const oldRange = block.oldStart === block.oldEnd ? `${block.oldStart}` : `${block.oldStart},${block.oldEnd - block.oldStart + 1}`;
        const newRange = block.newStart === block.newEnd ? `${block.newStart}` : `${block.newStart},${block.newEnd - block.newStart + 1}`;
        body.push(chalk.cyan(`@@ -${oldRange} +${newRange} @@`));

        // 渲染行
        for (const line of block.lines) {
            const maxLineNum = Math.max(block.oldEnd, block.newEnd);
            const lineNumWidth = String(maxLineNum).length + 1;

            if (line.type === 'removed') {
                const lineNum = String(line.oldNum || '').padEnd(lineNumWidth);
                const content = `- ${line.content}`;
                // 浅色模式：使用非常浅的红色背景，深红色文字
                const fullLine = lineNum + ' ' + content;
                const paddedLine = fullLine.padEnd(width - 4);
                body.push(chalk.bgRgb(255, 230, 230)(chalk.rgb(180, 60, 60)(paddedLine)));
            } else if (line.type === 'added') {
                const lineNum = String(line.newNum || '').padEnd(lineNumWidth);
                const content = `+ ${line.content}`;
                // 浅色模式：使用非常浅的绿色背景，深绿色文字
                const fullLine = lineNum + ' ' + content;
                const paddedLine = fullLine.padEnd(width - 4);
                body.push(chalk.bgRgb(230, 255, 230)(chalk.rgb(40, 140, 40)(paddedLine)));
            } else {
                // 上下文行
                const oldNumStr = String(line.oldNum || '').padEnd(lineNumWidth);
                const newNumStr = String(line.newNum || '').padEnd(lineNumWidth);
                const truncatedContent = truncText(line.content, width - 10 - lineNumWidth * 2);
                body.push(chalk.dim(oldNumStr) + chalk.dim(newNumStr) + chalk.dim(`   ${truncatedContent}`));
            }
        }
    }

    return body;
}

function renderTerminalToolCallCli(shellLabel: string, toolcall: ToolCall, width: number): string[] {
    const command = toolcall.args_object?.['command'];
    const cwd = toolcall.args_object?.['workingDirectory'];
    const body: string[] = [];

    if (cwd) {
        body.push(chalk.dim('📂 ') + chalk.yellow(truncText(cwd, width - 10)));
    }

    if (command) {
        body.push(chalk.blueBright('❯ ') + chalk.white(truncText(String(command), width - 10)));
    }

    if (toolcall.status === 'running' && !toolcall.result) {
        body.push(chalk.dim('  ⏳ 命令执行中…'));
    } else if (toolcall.result) {
        body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
        const rawLines = toolcall.result.replace(/\r/g, '').split('\n');
        const displayLines = rawLines.slice(0, MAX_CLI_OUTPUT_LINES);
        for (const line of displayLines) {
            body.push('  ' + chalk.dim(truncText(line, width - 10)));
        }
        if (rawLines.length > MAX_CLI_OUTPUT_LINES) {
            body.push(chalk.dim.italic(`  … 共 ${rawLines.length} 行输出`));
        }
    }

    return new Card({
        icon: '🖥',
        title: shellLabel,
        status: statusDisplay(toolcall.status),
        body,
    }).render(width);
}

function renderTerminalToolCall(cmdName: string, toolcall: ToolCall): string | undefined {
    return `
    <!-- 终端主容器 -->
    <div class="terminal-window w-full max-w-4xl rounded-xl overflow-hidden border border-gray-300 flex flex-col my-2 font-mono">
        <!-- macOS 顶部标题栏 (浅色渐变) -->
        <div class="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-gray-100 to-gray-200 border-b border-gray-300">
            <div class="text-[12px] font-medium text-gray-600 flex items-center gap-2">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                OpenDesk Agent -- ${cmdName} Terminal
            </div>
            <div class="w-12"></div>
        </div>

        <!-- 终端内容区域 -->
        <div class="p-3 text-xs xs:text-base leading-relaxed overflow-y-none custom-scrollbar text-gray-800">

            <!-- 执行脚本 -->
            <div class="mb-2 flex items-start">
                <span class="text-blue-500 font-bold mr-2">❯</span>
                <div>
                    <span class="text-blue-600">/home</span>
                    <span class="text-gray-800 ml-1">${toolcall.args_object?.['command']}</span>
                </div>
            </div>

            <!-- 过程记录 -->
            <div class="space-y-1 mb-4 border-l-2 border-gray-200 pl-4 ml-1">
                ${toolcall.result === undefined
                    ? `<div class="flex items-center gap-2 text-gray-400 animate-pulse h-7">
                            <svg class="w-5 h-5 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                            <span>命令执行中，请稍候…</span>
                        </div>`
                    : `<pre>${escapeHtml(toolcall.result)}</pre>`}
            </div>
        </div>
    </div>
    `
}

const ExecutePowerShellArgsSchema = z.object({
    command: z.string().describe('要执行的PowerShell命令'),
    workingDirectory: z.string().optional().describe('执行命令的工作目录，如果不指定则使用系统默认目录')
});

/**
 * 解析命令中的 "cd path; rest" 或 "Set-Location path; rest"，提取工作目录与剩余命令
 */
function parseCdAndCommand(command: string): { cwd?: string; command: string } {
    const t = command.trim();
    // 匹配 "cd path; rest" 或 "Set-Location path; rest"
    const cdMatch = t.match(/^(?:cd|Set-Location)\s+(['"]?)([^\s'";]+)\1\s*;\s*(.+)$/is);
    if (cdMatch) {
        const pathPart = cdMatch[2].trim();
        const rest = cdMatch[3].trim();
        if (rest && fs.existsSync(pathPart)) {
            return { cwd: pathPart, command: rest };
        }
    }
    return { command: t };
}

export class ExecutePowerShellTool extends BaseTool<typeof ExecutePowerShellArgsSchema> {
    constructor() {
        super(
            'executePowerShell',
            '在 Windows 下执行 PowerShell 命令。可以执行任何有效的 PowerShell 命令，如 Get-ChildItem、Set-Location、Get-Content、Write-Output 等。若命令含 "cd 路径; 后续命令" 或 "Set-Location 路径; 后续命令"，将自动在指定目录下执行后续命令',
            ExecutePowerShellArgsSchema
        );

        this.setExecutor(this.executeCommand);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderTerminalToolCall('PowerShell', toolcall);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return renderTerminalToolCallCli('PowerShell', toolcall, width);
    }

    async executeCommand(args: z.output<typeof ExecutePowerShellArgsSchema>): Promise<string> {
        let command: string = args.command;
        let workingDirectory: string | undefined = args.workingDirectory;

        const parsed = parseCdAndCommand(command);
        if (parsed.cwd) {
            workingDirectory = parsed.cwd;
            command = parsed.command;
        }

        // 使用 spawn 直接调用 powershell.exe，避免 exec 的引号转义问题
        return new Promise((resolve) => {
            const { spawn } = require('child_process');

            // 校验命令
            if (!command || typeof command !== 'string') {
                return resolve('请输入要执行的 PowerShell 命令。');
            }

            // 设置工作目录
            let cwd: string | undefined = undefined;
            if (workingDirectory && typeof workingDirectory === 'string' && fs.existsSync(workingDirectory)) {
                cwd = workingDirectory;
            }

            // 使用 -NoProfile 加快启动，-Command 执行命令
            // 设置 Console.OutputEncoding 为 UTF-8 避免中文乱码
            const utf8Command = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
            const powershell = spawn('powershell.exe', ['-NoProfile', '-Command', utf8Command], { cwd });

            let stdout = '';
            let stderr = '';

            powershell.stdout.on('data', (data: Buffer) => {
                stdout += data.toString('utf8');
            });

            powershell.stderr.on('data', (data: Buffer) => {
                stderr += data.toString('utf8');
            });

            powershell.on('close', (code: number) => {
                let result = '';
                if (stdout) { result += `标准输出流：\n${stdout}\n`; }
                if (stderr) { result += `标准错误流：\n${stderr}\n`; }
                if (!stdout && !stderr) { result = `进程退出，代码 ${code}`; }
                const output = result.trim() || '命令执行完成。';
                resolve(output);
            });

            powershell.on('error', (err: Error) => {
                resolve(`执行命令时出错: ${err.message}`);
            });
        });
    }
}

const ExecuteBashArgsSchema = z.object({
    command: z.string().describe('要执行的BASH命令'),
    workingDirectory: z.string().optional().describe('执行命令的工作目录，如果不指定则使用系统默认目录')
});

/**
 * 检测系统中是否存在指定的可执行文件
 */
export function findExecutable(executable: string): string | null {
    const pathEnv = process.env.PATH || '';
    const pathSeparator = process.platform === 'win32' ? ';' : ':';
    const executableName = process.platform === 'win32' && !executable.endsWith('.exe')
        ? `${executable}.exe`
        : executable;

    for (const dir of pathEnv.split(pathSeparator)) {
        const fullPath = require('path').join(dir, executableName);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }
    return null;
}

export class ExecuteBashTool extends BaseTool<typeof ExecuteBashArgsSchema> {
    private bashPath: string;

    /**
     * @param bashPath bash 可执行文件路径，默认为 '/bin/bash'
     *   - Windows: 可传入 'bash' 自动从 PATH 中查找，或传入完整路径如 'C:\\Program Files\\Git\\bin\\bash.exe'
     *   - macOS/Linux: 默认 '/bin/bash'
     */
    constructor(bashPath: string = '/bin/bash') {
        super(
            'executeBash',
            '执行 bash 命令。可以执行任何有效的 BASH 命令，如 ls、cd、cat、echo 等',
            ExecuteBashArgsSchema
        );

        this.bashPath = bashPath;
        this.setExecutor(this.executeCommand);
    }

    executeCommand(args: z.output<typeof ExecuteBashArgsSchema>): Promise<string> {
        let command: string = args.command;
        let workingDirectory: string | undefined = args.workingDirectory;

        return new Promise((resolve, reject) => {
            // 校验命令
            if (!command || typeof command !== 'string') {
                return resolve('请输入要执行的 bash 命令。');
            }

            // 设置工作目录
            let cwd: string | undefined = undefined;
            if (workingDirectory && typeof workingDirectory === 'string' && fs.existsSync(workingDirectory)) {
                cwd = workingDirectory;
            }

            // 开启进程
            const bash = spawn(this.bashPath, ['-c', command], { cwd });

            let stdout = '';
            let stderr = '';

            bash.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            bash.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            bash.on('close', (code: number) => {
                let result = ``;
                if (stdout) { result += `标准输出流：\n${stdout}\n`; }
                if (stderr) { result += `标准错误流：\n${stderr}\n`; }
                if (!stdout && !stderr) { result = `进程退出，代码 ${code}`; }
                const output = result.trim() || '命令执行完成。';
                resolve(output);
            });

            bash.on('error', (err: Error) => {
                resolve(`执行命令时出错: ${err.message}`);
            });
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderTerminalToolCall('BASH', toolcall);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return renderTerminalToolCallCli('Bash', toolcall, width);
    }
}

const ExecuteZshArgsSchema = z.object({
    command: z.string().describe('要执行的ZSH命令'),
    workingDirectory: z.string().optional().describe('执行命令的工作目录，如果不指定则使用当前目录')
});

export class ExecuteZshTool extends BaseTool<typeof ExecuteZshArgsSchema> {
    constructor() {
        super(
            'executeZsh',
            '执行 zsh 命令。可以执行任何有效的ZSH 命令，如 ls、cd、cat、echo 等',
            ExecuteZshArgsSchema
        );

        this.setExecutor(this.executeCommand);
    }

    executeCommand(args: z.output<typeof ExecuteBashArgsSchema>): Promise<string> {
        let command: string = args.command;
        let workingDirectory: string | undefined = args.workingDirectory;

        // MacOS/Linux 下执行命令
        return new Promise((resolve, reject) => {
            const { spawn } = require('child_process');
            const fs = require('fs');
            const path = require('path');

            // 校验命令
            if (!command || typeof command !== 'string') {
                return resolve('请输入要执行的 bash 命令。');
            }

            // 设置工作目录
            let cwd: string | undefined = undefined;
            if (workingDirectory && typeof workingDirectory === 'string' && fs.existsSync(workingDirectory)) {
                cwd = workingDirectory;
            }

            // 开启进程
            const zsh = spawn('/bin/zsh', ['-c', command], { cwd });

            let stdout = '';
            let stderr = '';

            zsh.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            zsh.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            zsh.on('close', (code: number) => {
                let result = `> ${args.command} 的执行结果为:`;
                if (stdout) { result += `标准输出流：\n${stdout}\n`; }
                if (stderr) { result += `标准错误流：\n${stderr}\n`; }
                if (!stdout && !stderr) { result = `进程退出，代码 ${code}`; }
                const output = result.trim() || '命令执行完成。';
                resolve(output);
            });

            zsh.on('error', (err: Error) => {
                resolve(`执行命令时出错: ${err.message}`);
            });
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderTerminalToolCall('Zsh', toolcall);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return renderTerminalToolCallCli('Zsh', toolcall, width);
    }
}

const readFilesSchema = z.object({
    paths: z.array(z.string()).describe('要读取的文件路径列表，支持多个文件并行读取')
});

/**
 * 读取单个文件内容
 */
function readSingleFile(path: string): Promise<{ path: string; content?: string; error?: string }> {
    return new Promise((resolve) => {
        fs.readFile(path, 'utf8', (err, data) => {
            if (err) {
                resolve({ path, error: err.message });
            } else {
                resolve({ path, content: data });
            }
        });
    });
}

export class ReadFilesTool extends BaseTool<typeof readFilesSchema> {
    constructor() {
        super(
            'readFiles',
            '并行读取多个文件的原始文本内容，可用来读取文本、代码、配置文件等文本格式数据。支持同时读取多个文件，提高效率',
            readFilesSchema
        );

        this.setExecutor(this.executeCommand);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const paths = toolcall.args_object?.['paths'] as string[] | undefined;
        const body: string[] = [];

        if (paths && Array.isArray(paths)) {
            body.push(chalk.yellow(`${paths.length} 个文件`));
            for (const p of paths.slice(0, 5)) {
                body.push(chalk.dim('  • ') + truncText(p, width - 12));
            }
            if (paths.length > 5) {
                body.push(chalk.dim(`  … 共 ${paths.length} 个文件`));
            }
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 读取中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            const lineCount = toolcall.result.split('\n').length;
            const charCount = toolcall.result.length;
            body.push(chalk.dim(`  ${lineCount} 行, ${charCount.toLocaleString()} 字符`));
        }

        return new Card({ icon: '📖', title: '读取文件', status: statusDisplay(toolcall.status), body }).render(width);
    }

    async executeCommand(args: z.output<typeof readFilesSchema>): Promise<string> {
        if (!args.paths || args.paths.length === 0) {
            return '请提供要读取的文件路径列表';
        }

        // 并行读取所有文件
        const results = await Promise.all(args.paths.map(path => readSingleFile(path)));

        // 格式化输出
        const output: string[] = [];
        for (const result of results) {
            output.push(`\n--- ${result.path} ---`);
            if (result.error) {
                output.push(`错误: ${result.error}`);
            } else {
                output.push(result.content || '');
            }
        }

        return output.join('\n');
    }
}

const writeFileSchema = z.object({
    path: z.string().describe('要写入的文件路径'),
    mode: z.enum(['append', 'overwrite'])
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
    // 存储 diff 信息
    oldContent?: string;
}

const _writeFileCache = new WeakMap<ToolCall, WriteFileRenderCache>();

/**
 * 快速计算内容的哈希值（用于缓存验证）
 * 使用采样策略避免全量扫描，O(n/k) 复杂度
 */
function computeContentHash(content: string): string {
    const len = content.length;
    if (len === 0) return '0:';

    // 采样策略：根据内容长度动态调整采样间隔
    // 短内容全量采样，长内容稀疏采样
    const sampleInterval = len > 10000 ? 100 : len > 1000 ? 20 : 5;

    let hash = `${len}:`;
    // 首尾各取一段 + 中间采样
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

/**
 * 增量计算 content 的行数 + 反向提取尾部行。
 * - 行数：仅扫描自上次缓存位置以来的新增字符，O(delta)
 * - 尾部：从末尾向前查找 N 个换行符，O(tail) 而非 O(content)
 */
function getWriteFileInfo(toolcall: ToolCall, content: string): WriteFileRenderCache {
    const prev = _writeFileCache.get(toolcall);
    const contentHash = computeContentHash(content);

    // 缓存命中条件：哈希值相同（确保内容真的相同）
    if (prev && prev.contentHash === contentHash) return prev;

    let lineCount: number;
    if (prev && content.length > prev.contentLen) {
        // 增量计算：检查新增部分是否与缓存内容衔接
        // 只有当新增内容确实是在原内容基础上追加时才使用增量计算
        const prevContentMatch = content.substring(0, prev.contentLen).length === prev.contentLen;
        if (prevContentMatch) {
            lineCount = prev.lineCount;
            for (let i = prev.contentLen; i < content.length; i++) {
                if (content.charCodeAt(i) === 10) lineCount++;
            }
        } else {
            // 内容被修改，重新计算
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

    const info: WriteFileRenderCache = { contentHash, contentLen: content.length, lineCount, tailLines };
    _writeFileCache.set(toolcall, info);
    return info;
}

export class WriteFileTool extends BaseTool<typeof writeFileSchema> {
    constructor() {
        super(
            'writeFile',
            '将文件内容写入给定的文件路径中，支持覆盖模式与追加模式, 默认为覆盖模式',
            writeFileSchema
        );

        this.setExecutor(this.executeCommand);
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
        } else if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 等待内容…'));
        }

        const mode = toolcall.args_object?.['mode'];
        const title = '写入文件' + (mode === 'append' ? ' (追加)' : '');
        return new Card({ icon: '✏️', title: title, status: statusDisplay(toolcall.status), body }).render(width);
    }

    executeCommand(args: z.output<typeof writeFileSchema>): Promise<string> {
        return new Promise((resolve, reject) => {
            if (args.mode === 'append') {
                fs.appendFile(args.path, args.content, 'utf8', (err) => {
                    if (err) {
                        reject(err);
                    }
                    resolve('文件内容追加成功');
                });
            } else {
                fs.writeFile(args.path, args.content, 'utf8', (err) => {
                    if (err) {
                        reject(err);
                    }
                    resolve('文件内容写入成功');
                });
            }
        });
    }
}

// ==================== editFile 工具 ====================

const editFileSchema = z.object({
    filePath: z.string().describe('要修改或创建的文件路径，可以使用工作区相对路径或绝对路径'),
    oldString: z.string().describe('要替换的原始文本（必须与文件内容完全匹配，包括所有空白和缩进）。对于单次替换，建议在目标文本前后各包含至少3行上下文。使用空字符串可创建新文件'),
    newString: z.string().describe('替换后的新文本。当创建新文件时（oldString 为空），此参数将成为文件内容'),
    expectedReplacements: z.number().min(1).optional().describe('预期的替换次数，默认为 1。当需要替换同一文本的多个出现时使用')
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

                // 显示 diff
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
        return new Card({ icon: isNewFile ? '📄' : '✂️', title: title, status: statusDisplay(toolcall.status), body }).render(width);
    }

    async executeCommand(args: z.output<typeof editFileSchema>): Promise<string> {
        const { filePath, oldString, newString, expectedReplacements = 1 } = args;

        // 创建新文件的情况
        if (oldString === '') {
            // 确保目录存在
            const dir = require('path').dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            await fs.promises.writeFile(filePath, newString, 'utf8');
            return `文件已创建: ${filePath}`;
        }

        // 读取现有文件
        let content: string;
        try {
            content = await fs.promises.readFile(filePath, 'utf8');
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                return `错误: 文件不存在 - ${filePath}`;
            }
            throw err;
        }

        // 检查 oldString 是否存在
        if (!content.includes(oldString)) {
            return `错误: 未找到要替换的文本。请确保 oldString 与文件内容完全匹配（包括空白和缩进）`;
        }

        // 执行替换
        let count = 0;
        let lastIndex = 0;
        let result = '';

        while (true) {
            const index = content.indexOf(oldString, lastIndex);
            if (index === -1) break;

            result += content.slice(lastIndex, index) + newString;
            lastIndex = index + oldString.length;
            count++;
        }
        result += content.slice(lastIndex);

        // 验证替换次数
        if (count !== expectedReplacements) {
            return `警告: 实际替换了 ${count} 处，但预期是 ${expectedReplacements} 处。请检查 oldString 是否正确`;
        }

        // 写入文件
        await fs.promises.writeFile(filePath, result, 'utf8');
        return `成功替换 ${count} 处`;
    }
}

// ==================== searchReplace 工具 ====================

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

            // 显示 diff
            if (oldString && newString !== undefined) {
                const diffLines = renderDiffOutput(oldString, newString, width);
                if (diffLines.length > 0) {
                    body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
                    body.push(...diffLines);
                }
            }
        }

        return new Card({ icon: '🔍', title: '搜索替换', status: statusDisplay(toolcall.status), body }).render(width);
    }

    async executeCommand(args: z.output<typeof searchReplaceSchema>): Promise<string> {
        const { filePath, oldString, newString } = args;

        // 读取文件
        let content: string;
        try {
            content = await fs.promises.readFile(filePath, 'utf8');
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                return `错误: 文件不存在 - ${filePath}`;
            }
            throw err;
        }

        // 检查是否存在
        if (!content.includes(oldString)) {
            return `错误: 未找到搜索的文本 "${oldString}"`;
        }

        // 执行替换（只替换第一次出现）
        const index = content.indexOf(oldString);
        const result = content.slice(0, index) + newString + content.slice(index + oldString.length);

        // 写入文件
        await fs.promises.writeFile(filePath, result, 'utf8');
        return `成功替换 1 处`;
    }
}

// ==================== applyPatch 工具 ====================

const applyPatchSchema = z.object({
    patch: z.string().describe('要应用的补丁内容。可以包含多个文件操作（添加、删除、更新）')
});

/**
 * 解析 unified diff 格式的补丁
 */
function parsePatch(patch: string): Array<{
    type: 'create' | 'delete' | 'update';
    path: string;
    content?: string;
    hunks?: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>;
}> {
    const operations: Array<{
        type: 'create' | 'delete' | 'update';
        path: string;
        content?: string;
        hunks?: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>;
    }> = [];

    const lines = patch.split('\n');
    let i = 0;

    while (i < lines.length) {
        // 查找 --- 行
        if (lines[i].startsWith('--- ')) {
            const oldPath = lines[i].slice(4).trim();
            i++;

            // 查找 +++ 行
            if (i < lines.length && lines[i].startsWith('+++ ')) {
                const newPath = lines[i].slice(4).trim();
                i++;

                // 收集 hunks
                const hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }> = [];

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

                        // 收集 hunk 内容
                        while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff') && !lines[i].startsWith('---')) {
                            hunk.lines.push(lines[i]);
                            i++;
                        }

                        hunks.push(hunk);
                    } else {
                        i++;
                    }
                }

                // 确定操作类型
                let type: 'create' | 'delete' | 'update' = 'update';
                if (oldPath === '/dev/null' || oldPath === 'a/dev/null') {
                    type = 'create';
                } else if (newPath === '/dev/null' || newPath === 'b/dev/null') {
                    type = 'delete';
                }

                // 提取实际路径
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

/**
 * 应用单个 hunk 到内容
 */
function applyHunk(content: string, hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }): string {
    const contentLines = content.split('\n');
    const result: string[] = [];
    let contentIndex = 0;

    // 添加 hunk 之前的内容
    while (contentIndex < hunk.oldStart - 1) {
        result.push(contentLines[contentIndex]);
        contentIndex++;
    }

    // 处理 hunk 行
    for (const line of hunk.lines) {
        if (line.startsWith(' ')) {
            // 上下文行
            result.push(line.slice(1));
            contentIndex++;
        } else if (line.startsWith('-')) {
            // 删除行
            contentIndex++;
        } else if (line.startsWith('+')) {
            // 添加行
            result.push(line.slice(1));
        }
    }

    // 跳过原始内容中已处理的行
    contentIndex = hunk.oldStart - 1 + hunk.oldLines;

    // 添加剩余内容
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

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const patch = toolcall.args_object?.['patch'] as string | undefined;
        const body: string[] = [];

        if (patch) {
            const lines = patch.split('\n');
            const fileCount = (patch.match(/^--- /gm) || []).length;
            body.push(chalk.yellow(`${fileCount} 个文件`));

            // 显示前几行
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

        return new Card({ icon: '🩹', title: '应用补丁', status: statusDisplay(toolcall.status), body }).render(width);
    }

    async executeCommand(args: z.output<typeof applyPatchSchema>): Promise<string> {
        const { patch } = args;

        const operations = parsePatch(patch);
        if (operations.length === 0) {
            return '错误: 无法解析补丁内容，请确保使用 unified diff 格式';
        }

        const results: string[] = [];

        for (const op of operations) {
            try {
                if (op.type === 'create') {
                    // 创建新文件
                    const dir = require('path').dirname(op.path);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }

                    // 从 hunks 提取内容
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
                    // 删除文件
                    if (fs.existsSync(op.path)) {
                        await fs.promises.unlink(op.path);
                        results.push(`✅ 删除: ${op.path}`);
                    } else {
                        results.push(`⚠️ 文件不存在: ${op.path}`);
                    }

                } else if (op.type === 'update' && op.hunks) {
                    // 更新文件
                    let content = await fs.promises.readFile(op.path, 'utf8');

                    // 从后向前应用 hunks，避免行号偏移
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
