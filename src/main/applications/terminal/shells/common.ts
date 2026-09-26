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

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'path';
import { ToolResult } from '../../../aikernel/tool.js';
import { ToolCall } from '../../../aikernel/messages.js';
import { escapeHtml } from '../../../../common/utils/escape.js';
import stripAnsi from 'strip-ansi';
import Convert from 'ansi-to-html';
import { Card } from '../../../tui/components/card.js';
import { statusDisplay, truncText } from '../../../tui/components/toolcall.js';
import fs from 'node:fs';
import chalk from 'chalk';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import { runPluginShellEnv } from '../../pluginmgr/runtime/hooks.js';
import { Setting, getTaskToolResultDirectory } from '../../../utils/setting.js';
import { installTimeoutBackgrounding, ShellTimeoutClock } from '../background.js';
import { BoundedOutputBuffer } from '../output-buffer.js';
import {
    buildChildProcessEnv,
    decodeShellOutput,
    filterShellEnvironmentWarnings,
    trackDetachedProcess
} from '../../../utils/shellExec.js';
import { prepareDynamicSandbox } from '../sandboxes/dynabox.js';
import { prepareLinuxSandbox } from '../sandboxes/linux-sandbox.js';
import { appendSandboxPathDiagnostic } from '../sandboxes/path-diagnostic.js';
import { t } from '../locale/index.js';

const ansiConverter = new Convert({ escapeXML: true });

export function getTaskWorkspace(taskState?: TaskState): string {
    return taskState?.getWorkspace() || Setting.getInstance().getEffectiveWorkspace();
}

function getTerminalOutputArtifactPath(taskState: TaskState | undefined, pid: number | undefined): string | undefined {
    const taskId = taskState?.task_id;
    if (!taskId) return undefined;
    const filename = `terminal-output-${Date.now()}-${pid ?? 'unknown'}.log`;
    return path.join(getTaskToolResultDirectory(taskId, false), filename);
}

export {
    buildInterpretersEnv,
    hasUserPythonEnvironment,
    shouldUseIsolatedPython,
    stripUserPythonEnvironment
} from '../../../utils/shellExec.js';
export { findExecutableInPath, hasZsh } from '../../../utils/shellExec.js';

const MAX_CLI_OUTPUT_LINES = 10;
const LIVE_UPDATE_INTERVAL_MS = 200;

export function renderTerminalToolCallCli(
    shellLabel: string,
    toolcall: ToolCall,
    width: number,
    sandboxed = false
): string[] {
    const command = toolcall.args_object?.['command'];
    const cwd = toolcall.args_object?.['workingDirectory'];
    const description = toolcall.args_object?.['description'];
    const descriptionText = description ? String(description).trim() : '';
    const shellTitle = sandboxed ? `${shellLabel} [${t('shell.sandboxTag')}]` : shellLabel;
    const title = descriptionText
        ? `${shellTitle} (${truncText(descriptionText, Math.max(12, width - 28))})`
        : shellTitle;
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

export function renderTerminalToolCall(cmdName: string, toolcall: ToolCall, sandboxed = false): string | undefined {
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
            <span class="text-[12px] ${headerTextColor} font-medium truncate min-w-0 flex-1">${headerText}</span>
            <span class="terminal-shell-tag terminal-shell-tag-${escapeHtml(cmdName)} shrink-0">${escapeHtml(cmdName)}</span>
            ${sandboxed ? `<span class="terminal-shell-tag terminal-shell-tag-sandbox shrink-0">${escapeHtml(t('shell.sandboxTag'))}</span>` : ''}
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
export function parseCdAndCommand(command: string): { cwd?: string; command: string } {
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
export async function executeShellCommand(opts: {
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
    useDynamicSandbox?: boolean;
    sandboxDeleteToTrash?: boolean;
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
        isKilledByStop,
        useDynamicSandbox = false,
        sandboxDeleteToTrash = false
    } = opts;

    const baseEnv = buildChildProcessEnv(taskState?.harnessContext.environ);
    const env = await runPluginShellEnv(taskState, { shell: shellPath, command }, baseEnv);
    const startTime = Date.now();
    // 沙箱权限弹窗等待用户决策期间暂停超时计时（见 dynabox 的 onPermissionWaitChange）
    const timeoutClock = new ShellTimeoutClock(timeout, startTime);
    const sandbox =
        useDynamicSandbox && process.platform === 'linux'
            ? await prepareLinuxSandbox({
                  shellPath,
                  shellArgs,
                  command,
                  cwd,
                  taskState,
                  deleteToTrash: sandboxDeleteToTrash,
                  onPermissionWaitChange: (waiting) => {
                      if (waiting) timeoutClock.pause();
                      else timeoutClock.resume();
                  }
              })
            : useDynamicSandbox
              ? await prepareDynamicSandbox({
                    shellPath,
                    shellArgs,
                    command,
                    cwd,
                    taskState,
                    deleteToTrash: sandboxDeleteToTrash,
                    onPermissionWaitChange: (waiting) => {
                        if (waiting) timeoutClock.pause();
                        else timeoutClock.resume();
                    }
                })
              : null;
    let proc: ChildProcessWithoutNullStreams;
    try {
        proc = sandbox
            ? spawn(sandbox.file, sandbox.args, {
                  cwd: sandbox.cwd,
                  env: sandbox.env ? { ...env, ...sandbox.env } : env,
                  detached: false,
                  windowsHide: true
              })
            : spawn(shellPath, shellArgs, { cwd, env, detached: process.platform !== 'win32' });
        sandbox?.attach(proc);
    } catch (error) {
        await sandbox?.cleanup();
        throw error;
    }
    proc.stdin?.end();
    trackDetachedProcess(proc);
    runningProcesses.add(proc);

    const output = new BoundedOutputBuffer(
        '',
        t('output.truncated'),
        getTerminalOutputArtifactPath(taskState, proc.pid),
        t('output.artifactSaved')
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
        formatOutput: (message) => appendSandboxPathDiagnostic(message, useDynamicSandbox),
        result,
        isKilledByStop,
        clock: timeoutClock,
        onFinish: (backgrounded) => {
            if (!backgrounded) output.closeArtifact();
            clearInterval(updateTimer);
            runningProcesses.delete(proc);
            stopPromises.delete(proc);
            resolveStopPromise?.();
        }
    });
}
