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
import { escapeHtml } from '../../../common/utils/escape.js';
import stripAnsi from 'strip-ansi';
import Convert from 'ansi-to-html';
import { t } from '../../../locale/index.js';

// GUI 渲染用的 ANSI 转 HTML 转换器（模块级单例，避免重复创建）
const ansiConverter = new Convert({ escapeXML: true });
import { Card } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import type { PermissionRequest } from '../../aikernel/security/permission';
import type { TaskState } from '../../aikernel/states/tasks';
import { runPluginShellEnv } from '../pluginmgr/runtime/hooks.js';
import { Setting, getTaskToolResultDirectory } from '../../utils/setting.js';
import {
    BackgroundProcessManager,
    killProcessTree,
    installTimeoutBackgrounding,
    type BackgroundProcessStatus
} from './background';
import { analyzeBashPermissions, analyzePowerShellPermissions } from './shellPermissions';
import {
    findExecutableInPath,
    buildChildProcessEnv,
    buildInterpretersEnv,
    decodeShellOutput,
    filterShellEnvironmentWarnings,
    hasUserPythonEnvironment,
    shouldUseIsolatedPython,
    stripUserPythonEnvironment,
    trackDetachedProcess,
    zshInteractiveHasExitTrapNoise
} from '../../utils/shellExec.js';
import { BoundedOutputBuffer } from './output-buffer.js';
import { t as terminalT } from './locale/index.js';

const MAX_CLI_OUTPUT_LINES = 10;
const LIVE_UPDATE_INTERVAL_MS = 200;

function getTaskWorkspace(taskState?: TaskState): string {
    return taskState?.getWorkspace() || Setting.getInstance().getEffectiveWorkspace();
}

function getTerminalOutputArtifactPath(taskState: TaskState | undefined, pid: number | undefined): string | undefined {
    const taskId = taskState?.task_id;
    if (!taskId) return undefined;
    const filename = `terminal-output-${Date.now()}-${pid ?? 'unknown'}.log`;
    return path.join(getTaskToolResultDirectory(taskId, false), filename);
}

export { buildInterpretersEnv, hasUserPythonEnvironment, shouldUseIsolatedPython, stripUserPythonEnvironment };

// re-export for backward compatibility
export { findExecutableInPath, hasZsh } from '../../utils/shellExec.js';

// 一个 OpenDesk 实例只会使用一个 bash / zsh 路径，作为模块级全局变量共享，
// 由 terminal 应用按平台探测后经 setBashPath / setZshPath 写入；未配置时为 null。
let bashPath: string | null = null;
let zshPath: string | null = null;

export function setBashPath(path: string): void {
    bashPath = path;
}

export function setZshPath(path: string): void {
    zshPath = path;
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
        // 保留 ANSI 序列用于终端颜色渲染，但按行分割时处理换行符
        const rawLines = toolcall.result.replace(/\r/g, '').split('\n');
        if (rawLines.length > MAX_CLI_OUTPUT_LINES) {
            body.push(chalk.dim.italic(`  … 共 ${rawLines.length} 行，显示最后 ${MAX_CLI_OUTPUT_LINES} 行`));
        }
        const displayLines = rawLines.slice(-MAX_CLI_OUTPUT_LINES);
        for (const line of displayLines) {
            // 截断时需要剥离 ANSI 来计算实际显示宽度，但输出保留 ANSI 用于颜色
            const visibleLen = stripAnsi(line).length;
            if (visibleLen > width - 10) {
                // 需要截断：剥离 ANSI，截断，然后... 保持原 ANSI 输出比较复杂
                // 简化处理：直接输出带 ANSI 的原始行，让终端自己处理
                body.push('  ' + chalk.dim(stripAnsi(line).slice(0, width - 10)));
            } else {
                body.push('  ' + line);
            }
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
            </div>`;
    } else {
        bodyContent = `
            <div class="px-4 py-2.5 font-mono text-[12px] text-gray-700 leading-relaxed">
                <span class="text-gray-400 select-none">$ </span>${escapeHtml(command)}
            </div>`;
        if (toolcall.result) {
            const outputColor = isError ? 'text-red-600' : 'text-gray-600';
            // 使用模块级转换器将 ANSI 颜色码转为 HTML 样式
            const styledOutput = ansiConverter.toHtml(toolcall.result);
            bodyContent += `
            <div class="px-4 py-2.5 border-t border-gray-100">
                <pre class="terminal-tool-output ${outputColor}">${styledOutput}</pre>
            </div>`;
        }
    }

    return `
    <details class="terminal-tool od-card-shadow my-2 rounded-[14px] border ${borderColor} bg-white overflow-hidden" open>
        <summary class="terminal-tool-summary flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150 font-medium">
            <svg class="w-4 h-4 ${iconColor} shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
                <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 9l3 3-3 3"/><line x1="14" y1="15" x2="16" y2="15"/>
            </svg>
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

/**
 * 解析命令中的 "cd path; rest" 或 "Set-Location path; rest"，提取工作目录与剩余命令
 */
function parseCdAndCommand(command: string): { cwd?: string; command: string } {
    if (!command) return { command: '' };
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

    const baseEnv = buildChildProcessEnv(taskState?.harnessContext.environ);
    const env = await runPluginShellEnv(taskState, { shell: shellPath, command }, baseEnv);
    const startTime = Date.now();
    const proc = spawn(shellPath, shellArgs, { cwd, env, detached: process.platform !== 'win32' });
    proc.stdin?.end();
    trackDetachedProcess(proc);
    runningProcesses.add(proc);

    const output = new BoundedOutputBuffer(
        '',
        terminalT('output.truncated'),
        getTerminalOutputArtifactPath(taskState, proc.pid),
        terminalT('output.artifactSaved')
    );
    let lastSentOutput = '';
    // zsh -i 等交互模式下，shell integration 会向 stdout/stderr 输出终端控制序列噪音，统一过滤
    const appendFiltered = (data: Buffer) => {
        output.append(filterShellEnvironmentWarnings(decodeShellOutput(data)));
    };
    proc.stdout.on('data', appendFiltered);
    proc.stderr.on('data', appendFiltered);

    const updateTimer = setInterval(() => {
        const currentOutput = output.getText();
        if (currentOutput !== lastSentOutput) {
            lastSentOutput = currentOutput;
            result.updateResult(currentOutput);
        }
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
                proc.stdout.removeListener('data', appendFiltered);
                proc.stderr.removeListener('data', appendFiltered);
            }
        },
        command,
        startTime,
        timeout,
        getOutput: () => output.getText(),
        getOutputBuffer: () => output,
        result,
        isKilledByStop,
        onFinish: () => {
            output.closeArtifact();
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
        const cwd = args.workingDirectory || getTaskWorkspace(taskState);
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
        let command: string = args.command ?? '';
        if (!command) throw new Error('命令不能为空');
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
        } else if (taskState?.getWorkspace()) {
            cwd = taskState.getWorkspace();
        } else {
            cwd = Setting.getInstance().getEffectiveWorkspace();
        }

        // 先查 powershell（Windows PowerShell 5.1），再查 pwsh（PowerShell 7+）
        const psPath = findExecutableInPath('powershell') || findExecutableInPath('pwsh');
        if (!psPath) {
            result.updateResult(
                '错误：未找到 PowerShell 可执行文件（powershell.exe / pwsh.exe）。请确保 PowerShell 已安装并位于 PATH 环境变量中。'
            );
            return;
        }

        const utf8Command = `chcp 65001 | Out-Null; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
        await executeShellCommand({
            shellPath: psPath,
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
    private runningProcesses: Set<ChildProcess> = new Set();
    private _killedByStop = false;
    private _stopPromises: Map<ChildProcess, Promise<void>> = new Map();

    constructor() {
        super(
            'executeBash',
            '该工具可以执行Bash终端命令, 并且默认已经将标准错误流和标准输出流合并, 无需额外配置 2>&1。不要用 || true、; true、| head 等兜底后缀或管道吞掉退出码；让命令以真实退出码结束，系统依赖退出码判定命令成败',
            ExecuteBashArgsSchema
        );

        this.setUniversalExecutor(this.executeCommand.bind(this));
    }

    getDeclaredPermissions(args: z.output<typeof ExecuteBashArgsSchema>, taskState?: TaskState): PermissionRequest[] {
        const command = args.command;
        if (!command || typeof command !== 'string') return [];
        const cwd = args.workingDirectory || getTaskWorkspace(taskState);
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
        const command: string = args.command ?? '';
        if (!command) throw new Error('命令不能为空');
        const workingDirectory: string | undefined = args.workingDirectory;
        const timeout: number = args.timeout ?? 30000;

        let cwd: string | undefined = undefined;
        if (workingDirectory && typeof workingDirectory === 'string' && fs.existsSync(workingDirectory)) {
            cwd = workingDirectory;
        } else if (taskState?.getWorkspace()) {
            cwd = taskState.getWorkspace();
        } else {
            cwd = Setting.getInstance().getEffectiveWorkspace();
        }

        if (!bashPath) {
            result.updateResult('错误：未找到 bash 可执行文件。请确保 bash 已安装并位于 PATH 环境变量中。');
            return;
        }

        await executeShellCommand({
            shellPath: bashPath,
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
    private interactive: boolean;
    private runningProcesses: Set<ChildProcess> = new Set();
    private _killedByStop = false;
    private _stopPromises: Map<ChildProcess, Promise<void>> = new Map();

    /**
     * @param interactive 为 true 时以 `-i -c` 启动（交互模式，加载 ~/.zshrc 环境变量设置）
     */
    constructor(interactive = false) {
        super(
            'executeZsh',
            '该工具可以执行Zsh终端命令, 并且默认已经将标准错误流和标准输出流合并, 无需额外配置 2>&1。不要用 || true、; true、| head 等兜底后缀或管道吞掉退出码；让命令以真实退出码结束，系统依赖退出码判定命令成败',
            ExecuteZshArgsSchema
        );

        this.interactive = interactive;
        this.setUniversalExecutor(this.executeCommand.bind(this));
    }

    getDeclaredPermissions(args: z.output<typeof ExecuteZshArgsSchema>, taskState?: TaskState): PermissionRequest[] {
        const command = args.command;
        if (!command || typeof command !== 'string') return [];
        const cwd = args.workingDirectory || getTaskWorkspace(taskState);
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
        const command: string = args.command ?? '';
        if (!command) throw new Error('命令不能为空');
        const workingDirectory: string | undefined = args.workingDirectory;
        const timeout: number = args.timeout ?? 30000;

        if (!zshPath) {
            result.updateResult('错误：未找到 zsh 可执行文件。请确保 zsh 已安装并位于 PATH 环境变量中。');
            return;
        }

        let cwd: string | undefined = undefined;
        if (workingDirectory && typeof workingDirectory === 'string' && fs.existsSync(workingDirectory)) {
            cwd = workingDirectory;
        } else if (taskState?.getWorkspace()) {
            cwd = taskState.getWorkspace();
        } else {
            cwd = Setting.getInstance().getEffectiveWorkspace();
        }

        // 部分 OpenHarmony 版本的 /etc/zshrc 无条件注册 EXIT trap（preexit：打印
        // "saving history..." / "completed." 并 fc -AI 写历史），zsh -i -c 退出时必然
        // 触发；另一些版本（source /etc/smartshell.zsh）的 EXIT trap 可能承担实际
        // 功能，不能无差别清除。因此先探测：仅确认存在噪音 trap 的环境才加
        // trap - EXIT 前缀，保证输出确定性的同时不影响其他环境的 trap 语义；
        // 前缀不影响命令自身的退出码与用户命令内自行设置的 trap
        const needsTrapPrefix = this.interactive && zshInteractiveHasExitTrapNoise(zshPath);
        const wrappedCommand = needsTrapPrefix ? `trap - EXIT; ${command}` : command;
        const shellArgs = this.interactive ? ['-i', '-c', wrappedCommand] : ['-c', command];
        await executeShellCommand({
            shellPath: zshPath,
            shellArgs,
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

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const pid = toolcall.args_object?.['pid'];
        const kill = toolcall.args_object?.['kill'];
        const isRunning = toolcall.result === undefined && toolcall.status !== 'error';
        const isError = toolcall.status === 'error';

        const statusIcon = isRunning
            ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
            : isError
              ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-red-500"></span>'
              : '';

        let detail = '';
        if (pid !== undefined) {
            const pidStr = `PID ${escapeHtml(String(pid))}`;
            if (kill) {
                detail = `终止 ${pidStr}`;
            } else {
                detail = pidStr;
            }
        }

        // 如果是已完成状态，从 result 中提取进程状态摘要
        if (!isRunning && !isError && toolcall.result) {
            const firstLine = toolcall.result.split('\n')[0] || '';
            if (firstLine.includes('进程状态:')) {
                detail += ` · ${escapeHtml(firstLine.replace('进程状态:', '').trim())}`;
            } else if (firstLine.includes('未找到')) {
                detail += ` · 未找到`;
            }
        } else if (isRunning) {
            detail += ' · 查询中…';
        }

        return `<div class="od-inline-toolcall-container">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-circle-check shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(t('tools.checkShellStatus.name'))}</span>
                ${statusIcon}
                <span class="truncate text-xs text-slate-600">${detail}</span>
            </div>
        </div>`;
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
                const visibleLen = stripAnsi(line).length;
                if (visibleLen > width - 10) {
                    body.push('  ' + chalk.dim(stripAnsi(line).slice(0, width - 10)));
                } else {
                    body.push('  ' + line);
                }
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
