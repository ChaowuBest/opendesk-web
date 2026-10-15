/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { type ChildProcess } from 'node:child_process';
import { BaseTool, ToolResult, type ToolSystemPromptContribution } from '../../../aikernel/tool.js';
import { ToolCall } from '../../../aikernel/messages.js';
import { z } from 'zod';
import fs from 'node:fs';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import { Setting } from '../../../utils/setting.js';
import { killProcessTree } from '../background.js';
import { t } from '../locale/index.js';
import { createTerminalSystemPromptContribution } from '../prompt.js';
import { virtualPathToHostPath } from '../sandboxes/ask-path.js';
import { executeShellCommand, parseCdAndCommand, renderTerminalToolCall, renderTerminalToolCallCli } from './common.js';

const createPwshArgsSchema = (sandboxed = false) =>
    z.object({
        command: z.string().min(1, t('pwsh.command.empty')).describe(t('pwsh.command')),
        description: z.string().describe(t('pwsh.intent')),
        workingDirectory: z
            .string()
            .optional()
            .describe(t(sandboxed ? 'pwsh.cwd.sandbox' : 'pwsh.cwd')),
        timeout: z.number().optional().describe(t('pwsh.timeout')).default(30000)
    });
type PwshArgsSchema = ReturnType<typeof createPwshArgsSchema>;

export function normalizeSandboxPwshArgs(args: z.output<PwshArgsSchema>): z.output<PwshArgsSchema> {
    const parsed = parseCdAndCommand(args.command);
    const workingDirectory = parsed.cwd ?? args.workingDirectory;
    return {
        ...args,
        command: parsed.command,
        workingDirectory: workingDirectory ? (virtualPathToHostPath(workingDirectory) ?? workingDirectory) : undefined
    };
}

export class ExecutePwshTool extends BaseTool<PwshArgsSchema> {
    private runningProcesses: Set<ChildProcess> = new Set();
    private _killedByStop = false;
    private _stopPromises: Map<ChildProcess, Promise<void>> = new Map();

    constructor(
        private readonly shellPath: string,
        private readonly sandboxed = false,
        // 仅在沙箱激活时生效：沙箱内直接删除的文件送 Windows 回收站
        private readonly deleteToTrash = false
    ) {
        super(
            'executePwsh',
            t(sandboxed ? 'sandbox.description' : 'pwsh.description'),
            createPwshArgsSchema(sandboxed),
            undefined,
            { 'zh-CN': '执行 PowerShell 命令', 'en-US': 'Run PowerShell Command' }
        );
        this.serialExecution = sandboxed;
        this.setUniversalExecutor(this.executeCommand.bind(this));
    }

    getSystemPromptContribution(): ToolSystemPromptContribution {
        return createTerminalSystemPromptContribution({
            kind: 'powershell',
            shellPath: this.shellPath,
            sandboxed: this.sandboxed,
            deleteToTrash: this.deleteToTrash
        });
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
        return renderTerminalToolCall('powershell', toolcall, this.sandboxed);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return renderTerminalToolCallCli('powershell', toolcall, width, this.sandboxed);
    }

    async executeCommand(args: z.output<PwshArgsSchema>, result: ToolResult, taskState?: TaskState): Promise<void> {
        const normalizedArgs = this.sandboxed ? normalizeSandboxPwshArgs(args) : args;
        let command: string = normalizedArgs.command ?? '';
        if (!command) throw new Error(t('pwsh.command.empty'));
        let workingDirectory: string | undefined = normalizedArgs.workingDirectory;
        const timeout: number = normalizedArgs.timeout ?? 30000;

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

        const encodingCommand =
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; ' +
            // PS 5.1 的 Get-Content 对无 BOM 文件默认按系统 ANSI（中文系统为 GBK）解码，
            // 不受 chcp/[Console]::OutputEncoding 影响，读取 UTF-8 源码会输出乱码。
            // 为其设置 UTF-8 默认值；仅作用于读文件 cmdlet，不触碰写文件与重定向行为。
            "$PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'; ";
        const utf8Command = `${process.platform === 'win32' ? 'chcp 65001 | Out-Null; ' : ''}${encodingCommand}${command}`;
        const dynamicSandbox = this.sandboxed && process.platform === 'win32';
        await executeShellCommand({
            shellPath: this.shellPath,
            shellType: 'powershell',
            // Windows 沙箱子进程（AppContainer）读不到用户执行策略时按 Restricted
            // 处理，npx.ps1 等 npm shim 会被 AuthorizationManager 拦截；进程级
            // Bypass 只作用于本次工具调用，与仓库内构建脚本的用法一致。
            shellArgs:
                process.platform === 'win32'
                    ? ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command', utf8Command]
                    : ['-NoProfile', '-Command', utf8Command],
            command,
            cwd,
            timeout,
            result,
            taskState,
            runningProcesses: this.runningProcesses,
            stopPromises: this._stopPromises,
            isKilledByStop: () => this._killedByStop,
            useDynamicSandbox: dynamicSandbox,
            sandboxDeleteToTrash: dynamicSandbox && this.deleteToTrash
        });
    }
}
