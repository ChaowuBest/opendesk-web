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


const MAX_CLI_OUTPUT_LINES = 8;

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

const readFileSchema = z.object({
    path: z.string().describe('要读取的文件路径')
});

export class ReadFileTool extends BaseTool<typeof readFileSchema> {
    constructor() {
        super(
            'readFile',
            '读取文件原始文本内容, 可用来读取文本、代码、配置文件等文本格式数据',
            readFileSchema
        );

        this.setExecutor(this.executeCommand);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const filePath = toolcall.args_object?.['path'];
        const body: string[] = [];

        if (filePath) {
            body.push(chalk.yellow(truncText(String(filePath), width - 8)));
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

    executeCommand(args: z.output<typeof readFileSchema>): Promise<string> {
        return new Promise((resolve, reject) => {
            fs.readFile(args.path, 'utf8', (err, data) => {
                if (err) {
                    reject(err);
                }
                resolve(data);
            });
        });
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
