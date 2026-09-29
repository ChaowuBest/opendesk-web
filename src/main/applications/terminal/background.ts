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
 * 当 shell 工具（executeBash / executePwsh / executeZsh）因超时而将进程
 * 放到后台继续执行时，由此模块负责跟踪进程的输出、退出状态，并对外提供查询/终止接口。
 */

import { execSync, type ChildProcess } from 'child_process';
import { ToolResult } from '../../aikernel/tool';
import { createShellOutputDecoder, filterShellEnvironmentWarnings } from '../../utils/shellExec.js';
import { BoundedOutputBuffer } from './output-buffer.js';

// ── 公共类型 ─────────────────────────────────────────────────────────────────

export interface BackgroundProcessStatus {
    /** 是否找到了该 PID 对应的后台进程 */
    found: boolean;
    /** 进程是否已执行完毕 */
    finished: boolean;
    /** 进程退出码（未完成或被信号杀死时为 null） */
    exitCode: number | null;
    /** 进程的有界输出预览（stdout + stderr） */
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
    output: BoundedOutputBuffer;
    exitCode: number | null;
    finished: boolean;
    finishedAt?: number;
}

// 已完成的进程条目最多保留 5 分钟，防止无限增长
const FINISHED_ENTRY_TTL_MS = 5 * 60 * 1000;
const PROCESS_TERMINATION_GRACE_MS = 1000;
const PROCESS_STATUS_POLL_INTERVAL_MS = 200;

/** 可被 abortSignal 打断的延时；返回 true 表示计时结束，false 表示已取消。 */
function waitForDelayOrAbort(delayMs: number, abortSignal?: AbortSignal): Promise<boolean> {
    if (abortSignal?.aborted) return Promise.resolve(false);

    return new Promise((resolve) => {
        let settled = false;

        const settle = (timerElapsed: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            abortSignal?.removeEventListener('abort', onAbort);
            resolve(timerElapsed);
        };
        const onAbort = () => settle(false);

        const timer = setTimeout(() => settle(true), delayMs);
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        if (abortSignal?.aborted) onAbort();
    });
}

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
    register(
        proc: ChildProcess,
        command: string,
        currentOutput: BoundedOutputBuffer | string,
        startTime: number
    ): void {
        const pid = proc.pid;
        if (!pid) return;

        const entry: BackgroundProcessEntry = {
            pid,
            command,
            startTime,
            proc,
            output: typeof currentOutput === 'string' ? new BoundedOutputBuffer(currentOutput) : currentOutput,
            exitCode: null,
            finished: false
        };

        // 与 executeShellCommand 的采集逻辑保持一致：流式解码（跨 chunk 还原
        // UTF-8 多字节字符，避免分片误判 GBK 乱码）+ 过滤交互模式终端序列噪音
        const stdoutDecoder = createShellOutputDecoder();
        const stderrDecoder = createShellOutputDecoder();
        const appendStdout = (data: Buffer) => {
            entry.output.append(filterShellEnvironmentWarnings(stdoutDecoder.push(data)));
        };
        const appendStderr = (data: Buffer) => {
            entry.output.append(filterShellEnvironmentWarnings(stderrDecoder.push(data)));
        };
        proc.stdout?.on('data', appendStdout);
        proc.stderr?.on('data', appendStderr);

        const markFinished = (code: number | null) => {
            if (entry.finished) return;
            entry.exitCode = code;
            entry.finished = true;
            entry.finishedAt = Date.now();
            // 冲刷流式解码器残留（未换行结尾的最后一屏），保证 artifact 不丢尾
            const tailOut = filterShellEnvironmentWarnings(stdoutDecoder.flush());
            const tailErr = filterShellEnvironmentWarnings(stderrDecoder.flush());
            if (tailOut) entry.output.append(tailOut);
            if (tailErr) entry.output.append(tailErr);
            entry.output.closeArtifact();
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
            output: entry.output.getText(),
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
    async waitForFinish(pid: number, maxWaitMs: number = 2000, abortSignal?: AbortSignal): Promise<boolean> {
        const entry = this.entries.get(pid);
        if (!entry) return false;
        if (entry.finished) return true;

        if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0 || abortSignal?.aborted) {
            return entry.finished;
        }

        const deadline = Date.now() + maxWaitMs;
        while (!entry.finished) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0 || abortSignal?.aborted) break;

            const timerElapsed = await waitForDelayOrAbort(
                Math.min(PROCESS_STATUS_POLL_INTERVAL_MS, remainingMs),
                abortSignal
            );
            if (!timerElapsed) break;
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
 * 可暂停的 shell 超时时钟。
 *
 * Windows 动态沙箱触发权限管控时，子进程会阻塞等待用户在权限弹窗上做出决策，
 * 这段等待时间不应计入工具超时：弹窗打开时调用 pause()，权限被批准或拒绝后
 * 调用 resume()，按暂停时刻剩余的预算恢复计时。
 */
export class ShellTimeoutClock {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private deadline: number | undefined;
    private remainingMs: number;
    private fired = false;
    private canceled = false;
    private started = false;
    private pausedAt: number | undefined;
    private pausedTotalMs = 0;
    private timeoutHandler: (() => void) | undefined;

    constructor(
        private readonly timeoutMs: number,
        private readonly startTime: number
    ) {
        this.remainingMs = Math.max(0, timeoutMs);
    }

    get hasFired(): boolean {
        return this.fired;
    }

    /** 注册超时回调；须在 start() 之前调用 */
    onTimeout(handler: () => void): void {
        this.timeoutHandler = handler;
    }

    /** 排除暂停窗口（权限弹窗等待）后的实际执行毫秒数 */
    getActiveElapsedMs(): number {
        let elapsed = Date.now() - this.startTime - this.pausedTotalMs;
        if (this.pausedAt !== undefined) elapsed -= Date.now() - this.pausedAt;
        return Math.max(0, elapsed);
    }

    /** 开始计时；timeout <= 0 表示不限时 */
    start(): void {
        if (this.started || this.fired || this.canceled || this.timeoutMs <= 0) return;
        this.started = true;
        this.arm(this.remainingMs);
    }

    /** 暂停计时：沙箱权限弹窗正在等待用户决策 */
    pause(): void {
        if (this.canceled || this.timer === undefined || this.fired || this.pausedAt !== undefined) return;
        clearTimeout(this.timer);
        this.timer = undefined;
        this.pausedAt = Date.now();
        this.remainingMs = Math.max(0, (this.deadline ?? this.pausedAt) - this.pausedAt);
    }

    /** 恢复计时：权限决策已返回（批准或拒绝） */
    resume(): void {
        if (this.canceled || this.fired || this.pausedAt === undefined) return;
        this.pausedTotalMs += Date.now() - this.pausedAt;
        this.pausedAt = undefined;
        this.arm(this.remainingMs);
    }

    /**
     * 停止计时且不再触发（命令正常结束或中断时由 settle 调用）。
     * cancel 是终态：此后 pause/resume/start 一律失效——权限弹窗可能在
     * 命令结束后才迟迟返回决策（如用户 stop 任务），不得复活计时器。
     */
    cancel(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.canceled = true;
        this.deadline = undefined;
    }

    private arm(delayMs: number): void {
        this.deadline = Date.now() + delayMs;
        this.timer = setTimeout(
            () => {
                this.timer = undefined;
                this.fire();
            },
            Math.max(0, delayMs)
        );
    }

    private fire(): void {
        if (this.fired) return;
        this.fired = true;
        this.deadline = undefined;
        this.timeoutHandler?.();
    }
}

/**
 * 为一个 shell 子进程安装超时后台化逻辑。
 *
 * - 如果命令在 timeout 内完成，正常返回结果（resolve(false)）。
 * - 如果命令超时，进程被移交给 BackgroundProcessManager 继续跟踪，
 *   工具立即返回超时提示信息（resolve(true)）。
 * - 如果用户主动 stop，返回中断提示（resolve(false)）。
 * - 如果传入 clock，沙箱权限弹窗等待期间计时会被暂停（见 ShellTimeoutClock）。
 *
 * @returns Promise<boolean> — true 表示超时被后台化了，false 表示正常完成/中断
 */
export function installTimeoutBackgrounding(opts: {
    handle: ShellProcessHandle;
    command: string;
    startTime: number;
    timeout: number;
    getOutput: () => string;
    getOutputBuffer?: () => BoundedOutputBuffer;
    formatOutput?: (output: string) => string;
    result: ToolResult;
    isKilledByStop: () => boolean;
    /** 外部持有的可暂停超时时钟（executeShellCommand 用于暂停权限等待时间）；缺省时内部创建 */
    clock?: ShellTimeoutClock;
    onFinish: (backgrounded: boolean) => void;
}): Promise<boolean> {
    const {
        handle,
        command,
        startTime,
        timeout,
        getOutput,
        getOutputBuffer,
        formatOutput,
        result,
        isKilledByStop,
        onFinish
    } = opts;
    const { proc, detachListeners } = handle;

    let timedOut = false;
    let settled = false;
    const clock = opts.clock ?? new ShellTimeoutClock(timeout, startTime);

    return new Promise<boolean>((resolve) => {
        const settle = (backgrounded: boolean) => {
            if (settled) return;
            settled = true;
            clock.cancel();
            onFinish(backgrounded);
            resolve(backgrounded);
        };

        // 正常完成 / 被用户 stop
        const onClose = (code: number | null) => {
            if (timedOut) return;
            let output = getOutput();
            if (isKilledByStop()) output = `[中断] 命令被用户终止。\n` + output;
            const message = output.trim() || `进程退出，代码 ${code ?? 'killed'}`;
            result.updateResult(formatOutput?.(message) ?? message);
            if (Number.isInteger(code)) {
                result.updateResultObject({ exitCode: code });
            }
            settle(false);
        };

        const onError = (err: Error) => {
            if (timedOut) return;
            const message = `执行命令时出错: ${err.message}`;
            result.updateResult(formatOutput?.(message) ?? message);
            settle(false);
        };

        proc.on('close', onClose);
        proc.on('error', onError);

        clock.onTimeout(() => {
            if (settled) return;
            timedOut = true;

            // 摘除工具自身的 listener，由后台管理器接管
            detachListeners();
            proc.removeListener('close', onClose);
            proc.removeListener('error', onError);

            const mgr = BackgroundProcessManager.getInstance();
            // 权限弹窗等待时间不计入后台进程的“已执行时长”
            const activeElapsedMs = clock.getActiveElapsedMs();
            mgr.register(proc, command, getOutputBuffer?.() ?? getOutput(), Date.now() - activeElapsedMs);

            const elapsedSec = (activeElapsedMs / 1000).toFixed(1);
            const pid = proc.pid ?? 'unknown';
            const header = [
                `[超时] 命令已执行 ${elapsedSec}s 未完成，已将进程放到后台继续执行。`,
                `PID: ${pid}`,
                `提示: 使用 checkShellStatus 工具并传入 pid=${pid}；waitMs 的允许范围是 0-30000 毫秒。仅在确实需要即时状态、且查询后可继续其他独立工作时使用 waitMs=0；确实需要很快再次观察进度时可用 waitMs=1000-5000；若下一步依赖完成结果，优先使用 waitMs=10000-30000。进程完成时会提前返回，无需等满 waitMs。避免对同一运行中 PID 连续零等待查询；只有判断进程卡住时才使用 kill=true。`
            ].join('\n');
            const output = getOutput().trim() || '(暂无输出)';
            const message = header + '\n---\n' + output;
            result.updateResult(formatOutput?.(message) ?? message);
            settle(true);
        });
        clock.start();
    });
}
