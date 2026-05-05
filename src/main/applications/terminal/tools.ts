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

import { spawn, type ChildProcess } from 'child_process';
import { BaseTool, ToolResult } from '../../aikernel/tool';
import { ToolCall } from '../../aikernel/messages';
import { escapeHtml } from '../../utils/escape';
import { Card } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import type { PermissionRequest } from '../../aikernel/security/permission';
import type { TaskState } from '../../aikernel/states/tasks';
import { Setting, getAppDirectory } from '../../utils/setting.js';
import {
    BackgroundProcessManager,
    killProcessTree,
    installTimeoutBackgrounding,
    type BackgroundProcessStatus
} from './background';
import { analyzeBashPermissions, analyzePowerShellPermissions } from './shellPermissions';
import { findExecutableInPath } from './shellExec.js';

const MAX_CLI_OUTPUT_LINES = 10;
const LIVE_UPDATE_INTERVAL_MS = 200;
const PATH_SEGMENT = process.platform === 'win32' ? ';' : ':';

function buildInterpretersEnv(): NodeJS.ProcessEnv {
    const appRoot = getAppDirectory();
    const interpretersDir = path.join(appRoot, 'interpreters');
    const isWindows = process.platform === 'win32';

    for (const interpreter of ['npm-global', 'pip-global']) {
        const interpreterPath = path.join(interpretersDir, interpreter);

        if (!fs.existsSync(interpreterPath)) {
            fs.mkdirSync(interpreterPath, { recursive: true });
        }
    }

    const npmPrefix = path.join(interpretersDir, 'npm-global');
    const pipTarget = path.join(interpretersDir, 'pip-global');

    const npmBinDir = isWindows ? npmPrefix : path.join(npmPrefix, 'bin');
    const pipBinDir = path.join(pipTarget, isWindows ? 'Scripts' : 'bin');

    return {
        NPM_CONFIG_PREFIX: npmPrefix,
        PIP_TARGET: pipTarget,
        PYTHONPATH: pipTarget + PATH_SEGMENT + (process.env.PYTHONPATH || ''),
        PATH: npmBinDir + PATH_SEGMENT + pipBinDir + PATH_SEGMENT + process.env.PATH
    };
}

/**
 * 构建子进程的环境变量：系统 env + task 的 harnessContext.environ（skill .env 合并而来）
 */
function buildSpawnEnv(taskState?: TaskState): NodeJS.ProcessEnv {
    let env = { ...process.env };
    if (taskState && Object.keys(taskState.harnessContext.environ).length > 0) {
        env = { ...env, ...taskState.harnessContext.environ };
    }
    env = { ...env, ...buildInterpretersEnv() };
    return env;
}

// re-export for backward compatibility
export { findExecutableInPath, hasZsh } from './shellExec.js';

function getZshPath(): string | null {
    return findExecutableInPath('zsh');
}

function renderTerminalToolCallCli(shellLabel: string, toolcall: ToolCall, width: number): string[] {
    const command = toolcall.args_object?.['command'];
    const cwd = toolcall.args_object?.['workingDirectory'];
    const description = toolcall.args_object?.['description'];
    const descriptionText = description ? String(description).trim() : '';
    const title = descriptionText
        ? `${shellLabel} (${truncText(descriptionText, Math.max(12, width - 28))})`
        : shellLabel;
    const body: string[] = [];

    if (cwd) {
        body.push(chalk.dim('📂 ') + chalk.yellow(truncText(cwd, width - 10)));
    }

    if (command) {
        body.push(chalk.blueBright('❯ ') + chalk.white(truncText(String(command), width - 10)));
    }

    if (toolcall.result) {
        body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
        const rawLines = toolcall.result.replace(/\r/g, '').split('\n');
        if (rawLines.length > MAX_CLI_OUTPUT_LINES) {
            body.push(chalk.dim.italic(`  … 共 ${rawLines.length} 行，显示最后 ${MAX_CLI_OUTPUT_LINES} 行`));
        }
        const displayLines = rawLines.slice(-MAX_CLI_OUTPUT_LINES);
        for (const line of displayLines) {
            body.push('  ' + chalk.dim(truncText(line, width - 10)));
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

function renderTerminalToolCall(cmdName: string, toolcall: ToolCall): string | undefined {
    const command = toolcall.args_object?.['command'] || '';
    const description: string | undefined = toolcall.args_object?.['description'];
    const isRunning = toolcall.result === undefined && toolcall.status !== 'error';
    const isError = toolcall.status === 'error';

    const headerText = description
        ? escapeHtml(description)
        : escapeHtml(command.length > 80 ? command.slice(0, 77) + '…' : command);

    const borderColor = isError ? 'border-red-200' : 'border-gray-200';
    const iconColor = isError ? 'text-red-400' : 'text-gray-400';
    const headerTextColor = isError ? 'text-red-600' : 'text-gray-600';

    let bodyContent: string;
    if (isRunning) {
        bodyContent = `
            <div class="px-4 py-2.5 font-mono text-[12px] text-gray-700 leading-relaxed">
                <span class="text-gray-400 select-none">$ </span>${escapeHtml(command)}
            </div>
            <div class="px-4 py-3 flex items-center gap-2 text-blue-400 text-[12px] border-t border-gray-100">
                <i class="fa-solid fa-circle-notch fa-spin"></i>
                <span class="text-gray-400">命令执行中，请稍候…</span>
            </div>`;
    } else {
        bodyContent = `
            <div class="px-4 py-2.5 font-mono text-[12px] text-gray-700 leading-relaxed">
                <span class="text-gray-400 select-none">$ </span>${escapeHtml(command)}
            </div>`;
        if (toolcall.result) {
            const outputColor = isError ? 'text-red-600' : 'text-gray-600';
            bodyContent += `
            <div class="px-4 py-2.5 border-t border-gray-100">
                <pre class="terminal-tool-output ${outputColor}">${escapeHtml(toolcall.result)}</pre>
            </div>`;
        }
    }

    return `
    <details class="terminal-tool my-1.5 rounded-lg border ${borderColor} bg-white overflow-hidden" open>
        <summary class="terminal-tool-summary flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150">
            <svg class="w-4 h-4 ${iconColor} shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
                <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 9l3 3-3 3"/><line x1="14" y1="15" x2="16" y2="15"/>
            </svg>
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

// ── Shell 执行核心逻辑 ──────────────────────────────────────────────────────

/**
 * 通用的 shell 命令执行逻辑，被三种 shell 工具共用。
 * 负责 spawn 子进程、实时输出更新、超时后台化、用户 stop 中断。
 */
async function executeShellCommand(opts: {
    shellPath: string;
    shellArgs: string[];
    command: string;
    cwd?: string;
    timeout: number;
    result: ToolResult;
    taskState?: TaskState;
    runningProcesses: Set<ChildProcess>;
    stopPromises: Map<ChildProcess, Promise<void>>;
    isKilledByStop: () => boolean;
}): Promise<void> {
    const {
        shellPath,
        shellArgs,
        command,
        cwd,
        timeout,
        result,
        taskState,
        runningProcesses,
        stopPromises,
        isKilledByStop
    } = opts;

    const env = buildSpawnEnv(taskState);
    const startTime = Date.now();
    const proc = spawn(shellPath, shellArgs, { cwd, env });
    runningProcesses.add(proc);

    let output = '';
    const stdoutListener = (data: Buffer) => {
        output += data.toString();
    };
    const stderrListener = (data: Buffer) => {
        output += data.toString();
    };
    proc.stdout.on('data', stdoutListener);
    proc.stderr.on('data', stderrListener);

    const updateTimer = setInterval(() => {
        if (output) result.updateResult(output);
    }, LIVE_UPDATE_INTERVAL_MS);

    let resolveStopPromise: (() => void) | undefined;
    stopPromises.set(
        proc,
        new Promise<void>((r) => {
            resolveStopPromise = r;
        })
    );

    await installTimeoutBackgrounding({
        handle: {
            proc,
            detachListeners: () => {
                proc.stdout.removeListener('data', stdoutListener);
                proc.stderr.removeListener('data', stderrListener);
            }
        },
        command,
        startTime,
        timeout,
        getOutput: () => output,
        result,
        isKilledByStop,
        onFinish: () => {
            clearInterval(updateTimer);
            runningProcesses.delete(proc);
            stopPromises.delete(proc);
            resolveStopPromise?.();
        }
    });
}

// ── PowerShell ──────────────────────────────────────────────────────────────

const ExecutePowerShellArgsSchema = z.object({
    command: z.string().min(1, '命令不能为空').describe('要执行的PowerShell命令'),
    description: z
        .string()
        .optional()
        .describe('对该命令意图的简短描述（5-15字），用于在界面中展示，如"检查 PowerShell 版本"'),
    workingDirectory: z.string().optional().describe('执行命令的工作目录，如果不指定则使用系统默认目录'),
    timeout: z.number().optional().describe('命令执行超时时间（毫秒），默认 30000ms（30秒）').default(30000)
});

export class ExecutePowerShellTool extends BaseTool<typeof ExecutePowerShellArgsSchema> {
    private runningProcesses: Set<ChildProcess> = new Set();
    private _killedByStop = false;
    private _stopPromises: Map<ChildProcess, Promise<void>> = new Map();

    constructor() {
        super(
            'executePowerShell',
            '在 Windows 下执行 PowerShell 命令。可以执行任何有效的 PowerShell 命令，如 Get-ChildItem、Set-Location、Get-Content、Write-Output 等。若命令含 "cd 路径; 后续命令" 或 "Set-Location 路径; 后续命令"，将自动在指定目录下执行后续命令',
            ExecutePowerShellArgsSchema
        );

        this.setUniversalExecutor(this.executeCommand.bind(this));
    }

    getDeclaredPermissions(
        args: z.output<typeof ExecutePowerShellArgsSchema>,
        taskState?: TaskState
    ): PermissionRequest[] {
        const command = args.command;
        if (!command || typeof command !== 'string') return [];
        const cwd =
            args.workingDirectory ||
            taskState?.harnessContext?.workspace ||
            Setting.getInstance().getEffectiveWorkspace();
        return analyzePowerShellPermissions(command, cwd).filter((p) => p.action !== 'execute');
    }

    async stop(): Promise<void> {
        this._killedByStop = true;
        const processes = Array.from(this.runningProcesses);
        for (const proc of processes) {
            killProcessTree(proc);
        }
        await Promise.all(Array.from(this._stopPromises.values()));
        this._killedByStop = false;
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderTerminalToolCall('PowerShell', toolcall);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return renderTerminalToolCallCli('PowerShell', toolcall, width);
    }

    async executeCommand(
        args: z.output<typeof ExecutePowerShellArgsSchema>,
        result: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        let command: string = args.command;
        let workingDirectory: string | undefined = args.workingDirectory;
        const timeout: number = args.timeout ?? 30000;

        const parsed = parseCdAndCommand(command);
        if (parsed.cwd) {
            workingDirectory = parsed.cwd;
            command = parsed.command;
        }

        let cwd: string | undefined = undefined;
        if (workingDirectory && typeof workingDirectory === 'string' && fs.existsSync(workingDirectory)) {
            cwd = workingDirectory;
        } else if (taskState?.harnessContext?.workspace) {
            cwd = taskState?.harnessContext?.workspace;
        } else {
            cwd = Setting.getInstance().getEffectiveWorkspace();
        }

        const utf8Command = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
        await executeShellCommand({
            shellPath: 'powershell.exe',
            shellArgs: ['-NoProfile', '-Command', utf8Command],
            command,
            cwd,
            timeout,
            result,
            taskState,
            runningProcesses: this.runningProcesses,
            stopPromises: this._stopPromises,
            isKilledByStop: () => this._killedByStop
        });
    }
}

// ── Bash ────────────────────────────────────────────────────────────────────

const ExecuteBashArgsSchema = z.object({
    command: z.string().min(1, '命令不能为空').describe('要执行的BASH命令'),
    description: z
        .string()
        .optional()
        .describe('对该命令意图的简短描述（5-15字），用于在界面中展示，如"列出当前目录文件"'),
    workingDirectory: z.string().optional().describe('执行命令的工作目录，如果不指定则使用系统默认目录'),
    timeout: z.number().optional().describe('命令执行超时时间（毫秒），默认 30000ms（30秒）').default(30000)
});

export class ExecuteBashTool extends BaseTool<typeof ExecuteBashArgsSchema> {
    private bashPath: string;
    private runningProcesses: Set<ChildProcess> = new Set();
    private _killedByStop = false;
    private _stopPromises: Map<ChildProcess, Promise<void>> = new Map();

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
        this.setUniversalExecutor(this.executeCommand.bind(this));
    }

    getDeclaredPermissions(args: z.output<typeof ExecuteBashArgsSchema>, taskState?: TaskState): PermissionRequest[] {
        const command = args.command;
        if (!command || typeof command !== 'string') return [];
        const cwd =
            args.workingDirectory ||
            taskState?.harnessContext?.workspace ||
            Setting.getInstance().getEffectiveWorkspace();
        return analyzeBashPermissions(command, cwd).filter((p) => p.action !== 'execute');
    }

    async stop(): Promise<void> {
        this._killedByStop = true;
        const processes = Array.from(this.runningProcesses);
        for (const proc of processes) {
            killProcessTree(proc);
        }
        await Promise.all(Array.from(this._stopPromises.values()));
        this._killedByStop = false;
    }

    async executeCommand(
        args: z.output<typeof ExecuteBashArgsSchema>,
        result: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        const command: string = args.command;
        const workingDirectory: string | undefined = args.workingDirectory;
        const timeout: number = args.timeout ?? 30000;

        let cwd: string | undefined = undefined;
        if (workingDirectory && typeof workingDirectory === 'string' && fs.existsSync(workingDirectory)) {
            cwd = workingDirectory;
        } else if (taskState?.harnessContext?.workspace) {
            cwd = taskState.harnessContext.workspace;
        } else {
            cwd = Setting.getInstance().getEffectiveWorkspace();
        }

        await executeShellCommand({
            shellPath: this.bashPath,
            shellArgs: ['-c', command],
            command,
            cwd,
            timeout,
            result,
            taskState,
            runningProcesses: this.runningProcesses,
            stopPromises: this._stopPromises,
            isKilledByStop: () => this._killedByStop
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderTerminalToolCall('BASH', toolcall);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return renderTerminalToolCallCli('Bash', toolcall, width);
    }
}

// ── Zsh ────────────────────────────────────────────────────────────────────

const ExecuteZshArgsSchema = z.object({
    command: z.string().min(1, '命令不能为空').describe('要执行的ZSH命令'),
    description: z
        .string()
        .optional()
        .describe('对该命令意图的简短描述（5-15字），用于在界面中展示，如"列出当前目录文件"'),
    workingDirectory: z.string().optional().describe('执行命令的工作目录，如果不指定则使用当前目录'),
    timeout: z.number().optional().describe('命令执行超时时间（毫秒），默认 30000ms（30秒）').default(30000)
});

export class ExecuteZshTool extends BaseTool<typeof ExecuteZshArgsSchema> {
    private runningProcesses: Set<ChildProcess> = new Set();
    private _killedByStop = false;
    private _stopPromises: Map<ChildProcess, Promise<void>> = new Map();

    constructor() {
        super('executeZsh', '执行 zsh 命令。可以执行任何有效的ZSH 命令，如 ls、cd、cat、echo 等', ExecuteZshArgsSchema);

        this.setUniversalExecutor(this.executeCommand.bind(this));
    }

    getDeclaredPermissions(args: z.output<typeof ExecuteZshArgsSchema>, taskState?: TaskState): PermissionRequest[] {
        const command = args.command;
        if (!command || typeof command !== 'string') return [];
        const cwd =
            args.workingDirectory ||
            taskState?.harnessContext?.workspace ||
            Setting.getInstance().getEffectiveWorkspace();
        return analyzeBashPermissions(command, cwd).filter((p) => p.action !== 'execute');
    }

    async stop(): Promise<void> {
        this._killedByStop = true;
        const processes = Array.from(this.runningProcesses);
        for (const proc of processes) {
            killProcessTree(proc);
        }
        await Promise.all(Array.from(this._stopPromises.values()));
        this._killedByStop = false;
    }

    async executeCommand(
        args: z.output<typeof ExecuteZshArgsSchema>,
        result: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        const command: string = args.command;
        const workingDirectory: string | undefined = args.workingDirectory;
        const timeout: number = args.timeout ?? 30000;

        const zshPath = getZshPath();
        if (!zshPath) {
            result.updateResult('错误：未找到 zsh 可执行文件。请确保 zsh 已安装并位于 PATH 环境变量中。');
            return;
        }

        let cwd: string | undefined = undefined;
        if (workingDirectory && typeof workingDirectory === 'string' && fs.existsSync(workingDirectory)) {
            cwd = workingDirectory;
        } else if (taskState?.harnessContext?.workspace) {
            cwd = taskState.harnessContext.workspace;
        } else {
            cwd = Setting.getInstance().getEffectiveWorkspace();
        }

        await executeShellCommand({
            shellPath: zshPath,
            shellArgs: ['-c', command],
            command,
            cwd,
            timeout,
            result,
            taskState,
            runningProcesses: this.runningProcesses,
            stopPromises: this._stopPromises,
            isKilledByStop: () => this._killedByStop
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderTerminalToolCall('Zsh', toolcall);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return renderTerminalToolCallCli('Zsh', toolcall, width);
    }
}

// ── checkShellStatus 工具 ──────────────────────────────────────────────────

const CheckShellStatusArgsSchema = z.object({
    pid: z.number().describe('要检查的后台 shell 进程的 PID'),
    kill: z.boolean().optional().describe('如果设为 true，则强制终止该后台进程').default(false)
});

export class CheckShellStatusTool extends BaseTool<typeof CheckShellStatusArgsSchema> {
    constructor() {
        super(
            'checkShellStatus',
            '检查后台 shell 进程的执行状态。当 executeBash / executePowerShell / executeZsh 等命令因超时被放到后台继续执行时，可以通过此工具传入对应的 PID 查询进程是否已完成、返回码以及完整的输出内容。也可以通过 kill 参数强制终止卡住的后台进程。此工具是非阻塞的，会立即返回当前状态。',
            CheckShellStatusArgsSchema
        );

        this.setUniversalExecutor(this.executeCheck.bind(this));
    }

    async executeCheck(args: z.output<typeof CheckShellStatusArgsSchema>, result: ToolResult): Promise<void> {
        const { pid, kill } = args;
        const mgr = BackgroundProcessManager.getInstance();

        if (kill) {
            const killed = mgr.killProcess(pid);
            if (!killed) {
                result.updateResult(`PID ${pid} 对应的进程未找到或已经结束，无法终止。`);
                return;
            }
            await mgr.waitForFinish(pid, 3000);
        }

        const status: BackgroundProcessStatus = mgr.getStatus(pid);

        if (!status.found) {
            result.updateResult(
                `未找到 PID ${pid} 对应的后台进程。可能该进程不是因超时被放到后台的，或者 PID 输入有误。`
            );
            return;
        }

        const elapsedSec = (status.elapsedMs / 1000).toFixed(1);

        if (status.finished) {
            const lines = [
                `进程状态: 已完成`,
                `PID: ${pid}`,
                `命令: ${status.command}`,
                `返回码: ${status.exitCode ?? 'unknown'}`,
                `总耗时: ${elapsedSec}s`,
                '---',
                status.output.trim() || '(无输出)'
            ];
            result.updateResult(lines.join('\n'));
        } else {
            const lines = [
                `进程状态: 仍在执行中`,
                `PID: ${pid}`,
                `命令: ${status.command}`,
                `已运行: ${elapsedSec}s`,
                '提示: 进程仍在运行，可以稍后再次检查，或使用 kill=true 来终止它。',
                '---',
                status.output.trim() || '(暂无输出)'
            ];
            result.updateResult(lines.join('\n'));
        }
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const pid = toolcall.args_object?.['pid'];
        const body: string[] = [];

        if (pid) {
            body.push(chalk.blueBright('PID: ') + chalk.white(String(pid)));
        }

        if (toolcall.result) {
            body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
            const rawLines = toolcall.result.replace(/\r/g, '').split('\n');
            if (rawLines.length > MAX_CLI_OUTPUT_LINES) {
                body.push(chalk.dim.italic(`  … 共 ${rawLines.length} 行，显示最后 ${MAX_CLI_OUTPUT_LINES} 行`));
            }
            const displayLines = rawLines.slice(-MAX_CLI_OUTPUT_LINES);
            for (const line of displayLines) {
                body.push('  ' + chalk.dim(truncText(line, width - 10)));
            }
        } else if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 正在查询…'));
        }

        return new Card({
            icon: '🔍',
            title: 'Shell 状态检查',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}
