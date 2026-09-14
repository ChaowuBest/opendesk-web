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
import { BaseTool, ToolResult } from '../../../aikernel/tool.js';
import { ToolCall } from '../../../aikernel/messages.js';
import { z } from 'zod';
import fs from 'node:fs';
import type { PermissionRequest } from '../../../aikernel/security/permission.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import { Setting } from '../../../utils/setting.js';
import { analyzePowerShellPermissions } from '../shellPermissions.js';
import { killProcessTree } from '../background.js';
import { t } from '../locale/index.js';
import {
    executeShellCommand,
    getTaskWorkspace,
    parseCdAndCommand,
    renderTerminalToolCall,
    renderTerminalToolCallCli
} from './common.js';

const createPwshArgsSchema = () =>
    z.object({
        command: z.string().min(1, t('pwsh.command.empty')).describe(t('pwsh.command')),
        description: z.string().optional().describe(t('pwsh.intent')),
        workingDirectory: z.string().optional().describe(t('pwsh.cwd')),
        timeout: z.number().optional().describe(t('pwsh.timeout')).default(30000)
    });
type PwshArgsSchema = ReturnType<typeof createPwshArgsSchema>;

export class ExecutePwshTool extends BaseTool<PwshArgsSchema> {
    override serialExecution = true;
    private runningProcesses: Set<ChildProcess> = new Set();
    private _killedByStop = false;
    private _stopPromises: Map<ChildProcess, Promise<void>> = new Map();

    constructor(
        private readonly shellPath: string,
        private readonly sandboxed = false
    ) {
        super('executePwsh', t(sandboxed ? 'sandbox.description' : 'pwsh.description'), createPwshArgsSchema());
        this.setUniversalExecutor(this.executeCommand.bind(this));
    }

    getDeclaredPermissions(args: z.output<PwshArgsSchema>, taskState?: TaskState): PermissionRequest[] {
        // 强制沙箱的文件权限由实际 I/O 回传宿主路径后判定，静态分析无法解释虚拟盘符。
        if (this.sandboxed && process.platform === 'win32') return [];
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
        return renderTerminalToolCall('powershell', toolcall, this.sandboxed);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return renderTerminalToolCallCli('powershell', toolcall, width, this.sandboxed);
    }

    async executeCommand(args: z.output<PwshArgsSchema>, result: ToolResult, taskState?: TaskState): Promise<void> {
        let command: string = args.command ?? '';
        if (!command) throw new Error(t('pwsh.command.empty'));
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

        const encodingCommand =
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; ';
        const utf8Command = `${process.platform === 'win32' ? 'chcp 65001 | Out-Null; ' : ''}${encodingCommand}${command}`;
        await executeShellCommand({
            shellPath: this.shellPath,
            shellArgs: ['-NoProfile', '-Command', utf8Command],
            command,
            cwd,
            timeout,
            result,
            taskState,
            runningProcesses: this.runningProcesses,
            stopPromises: this._stopPromises,
            isKilledByStop: () => this._killedByStop,
            useDynamicSandbox: this.sandboxed && process.platform === 'win32'
        });
    }
}
