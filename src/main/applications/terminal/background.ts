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

/**
 * 后台进程管理器。
 * 当 shell 工具（executeBash / executePowerShell / executeZsh）因超时而将进程
 * 放到后台继续执行时，由此模块负责跟踪进程的输出、退出状态，并对外提供查询/终止接口。
 */

import { execSync, type ChildProcess } from 'child_process';
import { ToolResult } from '../../aikernel/tool';
import { decodeShellOutput, filterShellEnvironmentWarnings } from '../../utils/shellExec.js';

// ── 公共类型 ─────────────────────────────────────────────────────────────────

export interface BackgroundProcessStatus {
    /** 是否找到了该 PID 对应的后台进程 */
    found: boolean;
    /** 进程是否已执行完毕 */
    finished: boolean;
    /** 进程退出码（未完成或被信号杀死时为 null） */
    exitCode: number | null;
    /** 进程的完整输出（stdout + stderr） */
    output: string;
    /** 从进程启动到现在经过的毫秒数 */
    elapsedMs: number;
    /** 原始命令 */
    command: string;
}

const NOT_FOUND_STATUS: BackgroundProcessStatus = Object.freeze({
    found: false,
    finished: false,
    exitCode: null,
    output: '',
    elapsedMs: 0,
    command: ''
});

// ── 内部条目 ─────────────────────────────────────────────────────────────────

interface BackgroundProcessEntry {
    pid: number;
    command: string;
    startTime: number;
    proc: ChildProcess;
    output: string;
    exitCode: number | null;
    finished: boolean;
    finishedAt?: number;
}

// 已完成的进程条目最多保留 5 分钟，防止无限增长
const FINISHED_ENTRY_TTL_MS = 5 * 60 * 1000;
const PROCESS_TERMINATION_GRACE_MS = 1000;

// ── BackgroundProcessManager ─────────────────────────────────────────────────

export class BackgroundProcessManager {
    private static instance: BackgroundProcessManager;
    private entries: Map<number, BackgroundProcessEntry> = new Map();

    static getInstance(): BackgroundProcessManager {
        if (!BackgroundProcessManager.instance) {
            BackgroundProcessManager.instance = new BackgroundProcessManager();
        }
        return BackgroundProcessManager.instance;
    }

    /**
     * 将一个超时的进程注册到后台管理器继续跟踪。
     *
     * 调用前应当先将工具自身的 stdout/stderr listener 移除，
     * 然后由本方法重新挂载新的 listener 继续采集输出。
     */
    register(proc: ChildProcess, command: string, currentOutput: string, startTime: number): void {
        const pid = proc.pid;
        if (!pid) return;

        const entry: BackgroundProcessEntry = {
            pid,
            command,
            startTime,
            proc,
            output: currentOutput,
            exitCode: null,
            finished: false
        };

        // 与 executeShellCommand 的采集逻辑保持一致：解码 + 过滤交互模式终端序列噪音
        const appendFiltered = (data: Buffer) => {
            entry.output += filterShellEnvironmentWarnings(decodeShellOutput(data));
        };
        proc.stdout?.on('data', appendFiltered);
        proc.stderr?.on('data', appendFiltered);

        const markFinished = (code: number | null) => {
            if (entry.finished) return;
            entry.exitCode = code;
            entry.finished = true;
            entry.finishedAt = Date.now();
        };

        // Windows 上 taskkill 后 close 事件可能不触发但 exit 事件会触发
        proc.on('exit', (code) => markFinished(code));
        proc.on('close', (code) => markFinished(code));
        proc.on('error', () => markFinished(null));

        this.entries.set(pid, entry);
        this.pruneFinished();
    }

    getStatus(pid: number): BackgroundProcessStatus {
        const entry = this.entries.get(pid);
        if (!entry) return NOT_FOUND_STATUS;
        return {
            found: true,
            finished: entry.finished,
            exitCode: entry.exitCode,
            output: entry.output,
            elapsedMs: Date.now() - entry.startTime,
            command: entry.command
        };
    }

    killProcess(pid: number): boolean {
        const entry = this.entries.get(pid);
        if (!entry || entry.finished) return false;
        // 先用 proc.kill 确保 Node.js 事件能正确触发
        try {
            entry.proc.kill('SIGTERM');
        } catch {
            /* ignore */
        }
        // 再用 killProcessTree 确保子进程树也被杀掉
        killProcessTree(entry.proc);
        return true;
    }

    /**
     * 等待进程结束，最多等待 maxWaitMs 毫秒
     */
    async waitForFinish(pid: number, maxWaitMs: number = 2000): Promise<boolean> {
        const entry = this.entries.get(pid);
        if (!entry) return false;
        if (entry.finished) return true;
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (entry.finished) return true;
        }
        return entry.finished;
    }

    /** 清理过期的已完成条目 */
    private pruneFinished(): void {
        const now = Date.now();
        for (const [pid, entry] of this.entries) {
            if (entry.finished && entry.finishedAt && now - entry.finishedAt > FINISHED_ENTRY_TTL_MS) {
                this.entries.delete(pid);
            }
        }
    }
}

// ── 进程树终止 ───────────────────────────────────────────────────────────────

/**
 * 杀死进程及其整个子进程树。
 * Windows: 使用 taskkill /F /T 强制终止进程树
 * Unix:    向进程组发送 SIGTERM，宽限期后以 SIGKILL 兜底；若无进程组则直接 kill
 */
export function killProcessTree(proc: ChildProcess): void {
    if (!proc.pid) return;
    const pid = proc.pid;
    try {
        if (process.platform === 'win32') {
            execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
        } else {
            let killedProcessGroup = false;
            try {
                process.kill(-pid, 'SIGTERM');
                killedProcessGroup = true;
            } catch {
                proc.kill('SIGTERM');
            }
            const forceTimer = setTimeout(() => {
                try {
                    if (killedProcessGroup) {
                        process.kill(-pid, 'SIGKILL');
                    } else if (proc.exitCode === null && proc.signalCode === null) {
                        proc.kill('SIGKILL');
                    }
                } catch {
                    /* process already dead */
                }
            }, PROCESS_TERMINATION_GRACE_MS);
            forceTimer.unref();
        }
    } catch {
        /* process already dead */
    }
}

// ── Shell 超时后台化辅助 ─────────────────────────────────────────────────────

export interface ShellProcessHandle {
    proc: ChildProcess;
    /** 移除工具自身的 stdout/stderr listener，为后台接管做准备 */
    detachListeners: () => void;
}

/**
 * 为一个 shell 子进程安装超时后台化逻辑。
 *
 * - 如果命令在 timeout 内完成，正常返回结果（resolve(false)）。
 * - 如果命令超时，进程被移交给 BackgroundProcessManager 继续跟踪，
 *   工具立即返回超时提示信息（resolve(true)）。
 * - 如果用户主动 stop，返回中断提示（resolve(false)）。
 *
 * @returns Promise<boolean> — true 表示超时被后台化了，false 表示正常完成/中断
 */
export function installTimeoutBackgrounding(opts: {
    handle: ShellProcessHandle;
    command: string;
    startTime: number;
    timeout: number;
    getOutput: () => string;
    result: ToolResult;
    isKilledByStop: () => boolean;
    onFinish: () => void;
}): Promise<boolean> {
    const { handle, command, startTime, timeout, getOutput, result, isKilledByStop, onFinish } = opts;
    const { proc, detachListeners } = handle;

    let timedOut = false;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    return new Promise<boolean>((resolve) => {
        const settle = (backgrounded: boolean) => {
            if (settled) return;
            settled = true;
            if (timeoutTimer) clearTimeout(timeoutTimer);
            onFinish();
            resolve(backgrounded);
        };

        // 正常完成 / 被用户 stop
        const onClose = (code: number | null) => {
            if (timedOut) return;
            let output = getOutput();
            if (isKilledByStop()) output = `[中断] 命令被用户终止。\n` + output;
            result.updateResult(output.trim() || `进程退出，代码 ${code ?? 'killed'}`);
            if (Number.isInteger(code)) {
                result.updateResultObject({ exitCode: code });
            }
            settle(false);
        };

        const onError = (err: Error) => {
            if (timedOut) return;
            result.updateResult(`执行命令时出错: ${err.message}`);
            settle(false);
        };

        proc.on('close', onClose);
        proc.on('error', onError);

        if (timeout > 0) {
            timeoutTimer = setTimeout(() => {
                if (settled) return;
                timedOut = true;

                // 摘除工具自身的 listener，由后台管理器接管
                detachListeners();
                proc.removeListener('close', onClose);
                proc.removeListener('error', onError);

                const mgr = BackgroundProcessManager.getInstance();
                mgr.register(proc, command, getOutput(), startTime);

                const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
                const pid = proc.pid ?? 'unknown';
                const header = [
                    `[超时] 命令已执行 ${elapsedSec}s 未完成，已将进程放到后台继续执行。`,
                    `PID: ${pid}`,
                    `提示: 使用 checkShellStatus 工具并传入 pid=${pid} 来检查命令的执行状态。如果这是一个合理的长时间任务，请等待一段时间后再检查输出；如果判断进程已卡住，可以通过 checkShellStatus 的 kill 参数终止它。`
                ].join('\n');
                const output = getOutput().trim() || '(暂无输出)';
                result.updateResult(header + '\n---\n' + output);
                settle(true);
            }, timeout);
        }
    });
}
