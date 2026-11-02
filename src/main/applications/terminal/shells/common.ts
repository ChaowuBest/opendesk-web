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
import os from 'os';
import path from 'path';
import { ToolResult } from '../../../aikernel/tool.js';
import { ToolCall } from '../../../aikernel/messages.js';
import { escapeHtml } from '../../../../common/utils/escape.js';
import stripAnsi from 'strip-ansi';
import { Card } from '../../../tui/components/card.js';
import { statusDisplay, truncText, MAX_CLI_OUTPUT_LINES } from '../../../tui/components/toolcall.js';
import fs from 'node:fs';
import chalk from 'chalk';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import type { PluginShellType } from '../../../../../packages/plugin-sdk/src/index.js';
import { runPluginShellEnv } from '../../pluginmgr/runtime/hooks.js';
import { Setting, getTaskToolResultDirectory, getTaskTrashDirectory } from '../../../utils/setting.js';
import { installTimeoutBackgrounding, ShellTimeoutClock } from '../background.js';
import { BoundedOutputBuffer } from '../output-buffer.js';
import { computeTerminalLiveOutputFrame } from '../output-delta.js';
import { TerminalLiveUpdateThrottle, TERMINAL_LIVE_UPDATE_INTERVAL_MS } from '../live-update-throttle.js';
import {
    buildChildProcessEnv,
    createShellOutputDecoder,
    filterShellEnvironmentWarnings,
    trackDetachedProcess
} from '../../../utils/shellExec.js';
import { prepareDynamicSandbox } from '../sandboxes/dynabox.js';
import { prepareLinuxSandbox } from '../sandboxes/linux-sandbox.js';
import { prepareDarwinSandbox } from '../sandboxes/darwin-sandbox.js';
import { prepareOpenHarmonySandbox } from '../sandboxes/openharmony-sandbox.js';
import { appendSandboxPathDiagnostic, appendSandboxPipeDiagnostic } from '../sandboxes/path-diagnostic.js';
import { MAIN_AGENT_UNLIMITED_MODE } from '../../../aikernel/agents/main/modes/unlimited.js';
import { t } from '../locale/index.js';

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
    // 实际语义是「还没有任何输出」：live tick 每 200ms 就把当前输出写回 result，
    // 命令一出字它就变 false，只用来决定是否渲染输出块，不能当作「是否在跑」。
    const isRunning = toolcall.result === undefined && toolcall.status !== 'error';
    // 运行指示与 toolcall 状态同源：pending 是「尚未开始执行」，不算运行中。
    const showRunningIndicator = toolcall.status === 'running';
    const isError = toolcall.status === 'error';

    const headerText = description
        ? escapeHtml(description)
        : escapeHtml(command.length > 80 ? command.slice(0, 77) + '…' : command);

    const borderColor = isError ? 'border-red-200' : 'border-gray-200';
    const iconColor = isError ? 'text-red-400' : 'text-gray-400';
    const headerTextColor = isError ? 'text-red-600' : 'text-gray-600';

    // 运行中提示：与侧边栏「运行中任务」同款转圈，放在标签胶囊左侧。
    // 只由 toolcall.status 决定，与输出渲染解耦；状态迁移会触发全量重渲，转圈随之消失。
    const runningIndicator = showRunningIndicator
        ? `\n            <span class="terminal-tool-running shrink-0" role="img" aria-label="${escapeHtml(t('shell.running'))}"></span>`
        : '';

    // 命令回显行：.terminal-tool-command 保留多行命令的换行并允许长 token 折行（如超长 PATH），
    // 否则命令块会把卡片撑出横向溢出，让滚动区出现横向滚动条。
    // 标签与命令之间不能留模板缩进空白——pre-wrap 会把它们原样渲染成前导空格。
    let bodyContent = `<div class="terminal-tool-command px-4 py-2.5 font-mono text-[12px] text-gray-700 leading-relaxed"><span class="text-gray-400 select-none">$ </span>${escapeHtml(command)}</div>`;
    if (!isRunning && toolcall.result) {
        const outputColor = isError ? 'text-red-600' : 'text-gray-600';
        // 终端输出以纯文本展示：剥离 ANSI 颜色控制序列后仅做 HTML 转义，
        // 避免终端配色与前端主题背景冲突导致的可读性问题（用户要求）。
        const cleanOutput = escapeHtml(stripAnsi(toolcall.result));
        bodyContent += `
            <div class="px-4 py-2.5 border-t border-gray-100">
                <pre class="terminal-tool-output ${outputColor}">${cleanOutput}</pre>
            </div>`;
    }

    return `
    <details data-toolcall-id="${escapeHtml(toolcall.id)}" class="terminal-tool od-card-shadow my-2 rounded-[14px] border ${borderColor} bg-white overflow-hidden" open>
        <summary class="terminal-tool-summary flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150 font-medium">
            <svg class="w-4 h-4 ${iconColor} shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
                <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 9l3 3-3 3"/><line x1="14" y1="15" x2="16" y2="15"/>
            </svg>
            <span class="text-[12px] ${headerTextColor} font-medium truncate min-w-0 flex-1">${headerText}</span>${runningIndicator}
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
    shellType: PluginShellType;
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
    /** 发起本次命令的工具名（沙箱权限弹窗展示来源，如 executeBash） */
    toolName?: string;
}): Promise<void> {
    const {
        shellPath,
        shellType,
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
        sandboxDeleteToTrash = false,
        toolName
    } = opts;

    // 无限制模式强制禁用沙箱：即使工具实例早于模式切换创建（如已缓存的沙箱工具），
    // unlimited 下也直接以宿主权限 spawn，删除送回收站（依赖沙箱原生层拦截）随之失效。
    const unlimitedMode = taskState?.activeModeId === MAIN_AGENT_UNLIMITED_MODE.id;
    const effectiveUseDynamicSandbox = unlimitedMode ? false : useDynamicSandbox;
    const effectiveDeleteToTrash = unlimitedMode ? false : sandboxDeleteToTrash;

    const baseEnv = buildChildProcessEnv(taskState?.harnessContext.environ);
    const env = await runPluginShellEnv(taskState, { shell: shellPath, shellType, command }, baseEnv);
    // 任务级统一回收站目录（<opendesk>/trash/<taskId>）：每次拉起沙箱都基于当前
    // 任务 ID 构建并传入，各平台参数格式见各 prepare*Sandbox 实现。删除送回收站
    // 的开关（sandboxDeleteToTrash）仍由设置控制，原生层仅在开启时使用该目录。
    let sandboxTrashDir: string | undefined;
    if (effectiveUseDynamicSandbox) {
        try {
            sandboxTrashDir = getTaskTrashDirectory(taskState?.task_id || 'unknown-task');
        } catch (error) {
            // 任务 ID 非法等异常情况不阻塞命令执行，仅放弃回收站隔离
            console.warn('[trash] 构建 sandbox trash dir 失败:', error);
        }
    }
    // 回收站排除清单：已知临时目录（构建零时产物如 /tmp/esbuild-* 灌进回收站
    // 是纯噪音，原生层还有内建默认兜底）。Windows 的 %TEMP% 由原生层展开内建，
    // 这里统一传 os.tmpdir() 的解析结果保证覆盖。
    const sandboxTrashExcludeDirs = effectiveUseDynamicSandbox
        ? ['/tmp', '/var/tmp', '/dev/shm', os.tmpdir()].filter((dir, index, all) => dir && all.indexOf(dir) === index)
        : undefined;
    const startTime = Date.now();
    // 沙箱权限弹窗等待用户决策期间暂停超时计时（见 dynabox 的 onPermissionWaitChange）
    const timeoutClock = new ShellTimeoutClock(timeout, startTime);
    const sandbox =
        effectiveUseDynamicSandbox && process.platform === 'linux'
            ? await prepareLinuxSandbox({
                  shellPath,
                  shellArgs,
                  command,
                  cwd,
                  taskState,
                  toolName,
                  deleteToTrash: effectiveDeleteToTrash,
                  trashDir: sandboxTrashDir,
                  trashExcludeDirs: sandboxTrashExcludeDirs,
                  onPermissionWaitChange: (waiting) => {
                      if (waiting) timeoutClock.pause();
                      else timeoutClock.resume();
                  }
              })
            : effectiveUseDynamicSandbox && process.platform === 'darwin'
              ? await prepareDarwinSandbox({
                    shellPath,
                    shellArgs,
                    command,
                    cwd,
                    taskState,
                    toolName,
                    deleteToTrash: effectiveDeleteToTrash,
                    trashDir: sandboxTrashDir,
                    trashExcludeDirs: sandboxTrashExcludeDirs,
                    onPermissionWaitChange: (waiting) => {
                        if (waiting) timeoutClock.pause();
                        else timeoutClock.resume();
                    }
                })
              : effectiveUseDynamicSandbox && (process.platform as string) === 'openharmony'
                ? await prepareOpenHarmonySandbox({
                      shellPath,
                      shellArgs,
                      command,
                      cwd,
                      taskState,
                      toolName,
                      deleteToTrash: effectiveDeleteToTrash,
                      trashDir: sandboxTrashDir,
                      trashExcludeDirs: sandboxTrashExcludeDirs,
                      onPermissionWaitChange: (waiting) => {
                          if (waiting) timeoutClock.pause();
                          else timeoutClock.resume();
                      }
                  })
                : effectiveUseDynamicSandbox
                  ? await prepareDynamicSandbox({
                        shellPath,
                        shellArgs,
                        command,
                        cwd,
                        taskState,
                        toolName,
                        deleteToTrash: effectiveDeleteToTrash,
                        trashDir: sandboxTrashDir,
                        trashExcludeDirs: sandboxTrashExcludeDirs,
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
                  // detached：macOS 沙箱的 watchdog（宿主死 → kill(-pg) 整树陪葬）
                  // 依赖独立进程组（shell setpgid）；其余平台 sandbox 不设此位，
                  // 保持既有 detached: false 语义。
                  detached: sandbox.detached ?? false,
                  windowsHide: true
              })
            : // 非沙箱路径同样不能弹出控制台窗口：Electron 主进程无控制台，
              // 缺 windowsHide 时 Windows 会为子进程创建可见的控制台窗口
              spawn(shellPath, shellArgs, {
                  cwd,
                  env,
                  detached: process.platform !== 'win32',
                  windowsHide: true
              });
        sandbox?.attach(proc);
    } catch (error) {
        await sandbox?.cleanup();
        throw error;
    }
    proc.stdin?.end();
    trackDetachedProcess(proc);
    runningProcesses.add(proc);

    // artifact 落盘背压：磁盘跟不上时暂停子进程输出，避免异步写缓冲无限增长。
    // 进程退出时必须恢复，否则 pause 状态下 stdout 的 'end'/'close' 不会触发，
    // 会让命令看起来"卡住"。
    const resumeChildOutput = () => {
        proc.stdout?.resume();
        proc.stderr?.resume();
    };
    proc.once('exit', resumeChildOutput);

    const output = new BoundedOutputBuffer(
        '',
        t('output.truncated'),
        getTerminalOutputArtifactPath(taskState, proc.pid),
        t('output.artifactSaved'),
        {
            onBackpressure: (paused) => {
                if (paused) {
                    proc.stdout?.pause();
                    proc.stderr?.pause();
                } else {
                    resumeChildOutput();
                }
            }
        }
    );
    let lastSentOutput = '';
    /** 上一次放行的快照（已剥离 ANSI）——增量与渲染端整份渲染同源的基准 */
    let lastSentStripped = '';
    // zsh -i 等交互模式下，shell integration 会向 stdout/stderr 输出终端控制序列噪音，统一过滤
    // stdout 与 stderr 各自独立走流式解码器：UTF-8 多字节字符（中文/emoji）可能被管道分片
    // 切断在 chunk 边界，逐 chunk 解码会把半个字符误判为 GBK 产生乱码（锟斤拷）
    const stdoutDecoder = createShellOutputDecoder();
    const stderrDecoder = createShellOutputDecoder();
    const appendFiltered = (data: Buffer, decoder: ReturnType<typeof createShellOutputDecoder>) => {
        output.append(filterShellEnvironmentWarnings(decoder.push(data)));
    };
    const onStdout = (data: Buffer) => appendFiltered(data, stdoutDecoder);
    const onStderr = (data: Buffer) => appendFiltered(data, stderrDecoder);
    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', onStderr);
    // 冲刷流式解码器残留：无换行结尾的最后一段输出在 close 前只缓存未 append，
    // 必须在 installTimeoutBackgrounding 读取最终输出之前 flush（注册先于其
    // onClose；exit/close 幂等，超时转后台后同样兜底不丢尾）
    const flushDecoders = () => {
        const tailOut = filterShellEnvironmentWarnings(stdoutDecoder.flush());
        const tailErr = filterShellEnvironmentWarnings(stderrDecoder.flush());
        if (tailOut) output.append(tailOut);
        if (tailErr) output.append(tailErr);
    };
    proc.on('close', flushDecoders);
    proc.on('exit', flushDecoders);

    // 推送节奏按快照形态分层（见 TerminalLiveUpdateThrottle）：小快照 200ms 尾部增量、
    // 大快照 400ms、截断态（reset + 全量文本）1s，避免每 tick 重传 256KiB 并让渲染端整体重写。
    const updateThrottle = new TerminalLiveUpdateThrottle();
    const updateTimer = setInterval(() => {
        // 兜底自愈：进程已退出（无论是否走过 settle）就停掉定时器，避免异常路径下
        // 定时器与输出缓冲一直存活
        if (proc.exitCode !== null || proc.signalCode !== null) {
            clearInterval(updateTimer);
            return;
        }
        // 先过节流再取快照：被节流掉的 tick 不必 join 出 256KiB 文本
        if (!updateThrottle.shouldPush(Date.now(), output.isTruncated(), output.getSnapshotLength())) return;
        const currentOutput = output.getText();
        if (currentOutput === lastSentOutput) return;
        // 增量在「剥离 ANSI 后的文本」上计算：与渲染端整份渲染用的 stripAnsi(result)
        // 完全同源，避免转义序列恰好跨 tick 边界时增量里残留半个序列。
        const { stripped, reset, delta } = computeTerminalLiveOutputFrame(lastSentStripped, currentOutput);
        lastSentOutput = currentOutput;
        lastSentStripped = stripped;
        result.outputDelta = delta;
        result.outputReset = reset || undefined;
        result.updateResult(currentOutput);
    }, TERMINAL_LIVE_UPDATE_INTERVAL_MS);

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
                proc.stdout.removeListener('data', onStdout);
                proc.stderr.removeListener('data', onStderr);
            }
        },
        command,
        startTime,
        timeout,
        getOutput: () => output.getText(),
        getOutputBuffer: () => output,
        formatOutput: (message) =>
            appendSandboxPipeDiagnostic(
                appendSandboxPathDiagnostic(message, effectiveUseDynamicSandbox),
                effectiveUseDynamicSandbox
            ),
        result,
        isKilledByStop,
        clock: timeoutClock,
        onFinish: (backgrounded) => {
            if (!backgrounded) void output.closeArtifact();
            clearInterval(updateTimer);
            runningProcesses.delete(proc);
            stopPromises.delete(proc);
            resolveStopPromise?.();
        }
    }).finally(() => {
        // 兜底：正常 settle 时 onFinish 已清过，这里再保证一次——异常路径（回调抛错
        // 导致 Promise 永不 settle 之外的提前返回）不能让 live tick 定时器继续跑
        clearInterval(updateTimer);
    });
}
