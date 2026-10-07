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
import { zshInteractiveHasExitTrapNoise } from '../../../utils/shellExec.js';
import { executeShellCommand, renderTerminalToolCall, renderTerminalToolCallCli } from './common.js';
import { createTerminalSystemPromptContribution } from '../prompt.js';

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
    constructor(
        private readonly shellPath: string,
        interactive = false,
        private readonly sandboxed = false,
        private readonly deleteToTrash = false
    ) {
        super(
            'executeZsh',
            '该工具可以执行Zsh终端命令, 并且默认已经将标准错误流和标准输出流合并, 无需额外配置 2>&1。不要用 || true、; true、| head 等兜底后缀或管道吞掉退出码；让命令以真实退出码结束，系统依赖退出码判定命令成败',
            ExecuteZshArgsSchema,
            undefined,
            { 'zh-CN': '执行 Zsh 命令', 'en-US': 'Run Zsh Command' }
        );

        this.interactive = interactive;
        this.setUniversalExecutor(this.executeCommand.bind(this));
    }

    getSystemPromptContribution(): ToolSystemPromptContribution {
        return createTerminalSystemPromptContribution({
            kind: 'zsh',
            shellPath: this.shellPath,
            sandboxed: this.sandboxed
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

    async executeCommand(
        args: z.output<typeof ExecuteZshArgsSchema>,
        result: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        const command: string = args.command ?? '';
        if (!command) throw new Error('命令不能为空');
        const workingDirectory: string | undefined = args.workingDirectory;
        const timeout: number = args.timeout ?? 30000;

        if (!this.shellPath) {
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
        const needsTrapPrefix = this.interactive && zshInteractiveHasExitTrapNoise(this.shellPath);
        const wrappedCommand = needsTrapPrefix ? `trap - EXIT; ${command}` : command;
        const shellArgs = this.interactive ? ['-i', '-c', wrappedCommand] : ['-c', command];
        await executeShellCommand({
            shellPath: this.shellPath,
            shellArgs,
            command,
            cwd,
            timeout,
            result,
            taskState,
            runningProcesses: this.runningProcesses,
            stopPromises: this._stopPromises,
            isKilledByStop: () => this._killedByStop,
            useDynamicSandbox: this.sandboxed,
            sandboxDeleteToTrash: this.sandboxed && this.deleteToTrash
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderTerminalToolCall('zsh', toolcall, this.sandboxed);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return renderTerminalToolCallCli('zsh', toolcall, width);
    }
}
