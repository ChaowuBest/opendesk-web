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

import { spawn, type ChildProcess } from 'child_process';
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
    /** checkShellStatus 轮询限流状态：上次放行查询的时间、输出快照与连续拒绝计数 */
    pollState?: { lastAt: number; lastOutput: string; blockedCount: number };
}

// 已完成的进程条目最多保留 5 分钟，防止无限增长
const FINISHED_ENTRY_TTL_MS = 5 * 60 * 1000;
const PROCESS_TERMINATION_GRACE_MS = 1000;
const PROCESS_STATUS_POLL_INTERVAL_MS = 200;

/** 后台进程已运行超过该时长且零输出时，checkShellStatus 追加静默诊断提示 */
export const SILENT_OUTPUT_HINT_ELAPSED_MS = 5 * 60 * 1000;

/**
 * 状态查询限流的冷却基准与上限：对"输出无变化"的运行中进程，重复
 * checkShellStatus 查询按连续拒绝次数从基准指数升级到上限。
 */
export const STATUS_POLL_COOLDOWN_BASE_MS = 90 * 1000;
export const STATUS_POLL_COOLDOWN_MAX_MS = 15 * 60 * 1000;

/** beginStatusPoll 的闸门决策结果 */
export interface StatusPollGate {
    /** 是否放行本次查询 */
    allowed: boolean;
    /** 当前冷却窗口；被拒绝时为下一次可查询需等待的窗口 */
    cooldownMs: number;
    /** 连续被拒绝次数（放行查询清零） */
    blockedCount: number;
    /** 距上次放行查询经过的毫秒数 */
    sinceLastPollMs: number;
}

// 识别把全部输出缓冲到命令结束才输出的管道消费端（Select-Object -Last/-First、
// tail/head/tee 等）。这类命令在结束前对外零输出，"暂无输出"不代表卡死。
const OUTPUT_BUFFERING_PATTERN =
    /Select-Object\s+-\w+|Out-String|Tee-Object|Sort-Object|Measure-Object|Group-Object|\|\s*(?:tail|head|tee)\b/;

export function matchesOutputBufferingPipeline(command: string): boolean {
    return OUTPUT_BUFFERING_PATTERN.test(command);
}

/**
 * 超时转后台 / 长时间零输出轮询时的诊断提示：区分「缓冲管道的正常静默」
 * 与「进程真实卡死」，并一律引导到可见性替代方案而非继续轮询（真实事故：
 * 构建命令带 Select-Object -Last 缓冲，36 分钟零输出，agent 轮询 60+ 次无法
 * 决策，最终用户只能手动关闭沙箱）。
 */
export function silentBackgroundHint(command: string): string {
    if (matchesOutputBufferingPipeline(command)) {
        return '提示: 该命令包含 Select-Object -Last/-First、tail 等缓冲类管道，全部输出要等命令完全结束才会一次性输出，结束前无法观察进度。若需要实时进度，建议 kill=true 终止后去掉缓冲管道直接输出重跑（超长输出由宿主自动截断并保存完整日志）；若确认命令本身耗时可静默等待，不要频繁轮询。';
    }
    return '提示: 进程转后台至今没有任何输出。若该命令本应持续产生进度（如构建、安装），可能是进程真实卡死：建议 kill=true 终止后分步重跑、直接观察输出定位卡点；不要频繁轮询。';
}

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
            void entry.output.closeArtifact();
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

    /**
     * checkShellStatus 查询闸门：对"输出无变化"的运行中进程做冷却限流。
     *
     * 零输出的长时间后台进程（如缓冲管道包裹的构建）曾导致模型以 30s waitMs
     * 盲轮询十几分钟、任务体感卡死，用户只能手动关闭沙箱。此处做确定性拦截：
     * 输出无变化时按连续拒绝次数从基准指数升级冷却（放行查询清零）；输出有
     * 新增（健康构建的进度轮询）、进程已完成或 kill 操作不受限。
     */
    beginStatusPoll(pid: number): StatusPollGate {
        const idle: StatusPollGate = { allowed: true, cooldownMs: 0, blockedCount: 0, sinceLastPollMs: 0 };
        const entry = this.entries.get(pid);
        if (!entry || entry.finished || !entry.pollState) return idle;
        const output = entry.output.getText();
        if (output !== entry.pollState.lastOutput) return idle;
        const sinceLastPollMs = Date.now() - entry.pollState.lastAt;
        const cooldownFor = (blocked: number) =>
            Math.min(STATUS_POLL_COOLDOWN_BASE_MS * 2 ** blocked, STATUS_POLL_COOLDOWN_MAX_MS);
        const cooldownMs = cooldownFor(entry.pollState.blockedCount);
        if (sinceLastPollMs < cooldownMs) {
            entry.pollState.blockedCount += 1;
            return {
                allowed: false,
                cooldownMs: cooldownFor(entry.pollState.blockedCount),
                blockedCount: entry.pollState.blockedCount,
                sinceLastPollMs
            };
        }
        return { allowed: true, cooldownMs, blockedCount: entry.pollState.blockedCount, sinceLastPollMs };
    }

    /** 记录一次放行的查询（时间戳与输出快照），并把连续拒绝计数清零；未知/已完成 PID 为空操作 */
    completeStatusPoll(pid: number): void {
        const entry = this.entries.get(pid);
        if (!entry || entry.finished) return;
        entry.pollState = { lastAt: Date.now(), lastOutput: entry.output.getText(), blockedCount: 0 };
    }

    killProcess(pid: number): boolean {
        const entry = this.entries.get(pid);
        if (!entry || entry.finished) return false;
        // Windows 上必须先杀树：taskkill /T 需要父进程还活着才能枚举出子树，
        // 先 proc.kill 会让子进程成为孤儿、逃过 /T（taskkill 不可用时由
        // killProcessTree 内部回落到 proc.kill）。
        // Unix 上先对进程本身发 SIGTERM，确保 Node 的 exit 事件尽快触发。
        if (process.platform !== 'win32') {
            try {
                entry.proc.kill('SIGTERM');
            } catch {
                /* ignore */
            }
        }
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
            // 必须异步：execSync 会在「停止」「超时转后台」「退出清理」时冻结主进程，
            // 进程树较大或系统繁忙时可达数秒（GUI 表现为整窗卡死）
            const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
                stdio: 'ignore',
                windowsHide: true
            });
            // taskkill 不可用（ENOENT）或拒绝执行（非 0 退出）时回落到只杀父进程：
            // 否则调用方会误以为已经终止，stop() 等 close 事件时可能永久挂住
            const fallbackKill = () => {
                try {
                    proc.kill('SIGTERM');
                } catch {
                    /* 进程可能已退出 */
                }
            };
            killer.on('error', fallbackKill);
            killer.on('exit', (code) => {
                if (code !== 0) fallbackKill();
            });
            // 不等待 taskkill 结束，避免阻塞调用方（unref 让事件循环不因它而保活）
            killer.unref();
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
        /**
         * 事件/定时器回调里的异常不会被 Promise 捕获：一旦因此错过 settle()，
         * 工具就永久挂起——closeArtifact 不会被调用（artifact 不落盘）、
         * runningProcesses / stopPromises 不清理、stop() 的等待也永远等不到。
         * 因此这些回调必须自己兜住异常，并把 settle() 放进 finally。
         */
        const logHandlerFailure = (label: string, err: unknown) => {
            console.warn(
                `[terminal] ${label} handler failed: ${err instanceof Error ? err.stack || err.message : String(err)}`
            );
        };

        const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

        const settle = (backgrounded: boolean) => {
            if (settled) return;
            settled = true;
            clock.cancel();
            try {
                onFinish(backgrounded);
            } catch (err) {
                // onFinish 是调用方注入的清理逻辑（关 artifact / 清定时器 / 复位队列），
                // 即使它抛错也必须 resolve，否则工具永久挂起
                logHandlerFailure('finish', err);
            } finally {
                resolve(backgrounded);
            }
        };

        /**
         * 终态/错误/转后台时写入最终输出。
         *
         * 必须先清掉 live tick 残留的 outputDelta：ToolResult 上的增量字段不会自动过期，
         * 若带着它调用 updateResult，回调方（TaskState）会把上一帧的增量误判成新的
         * live tick 再推一次，渲染端就会把同一段文本重复追加一次。
         */
        const updateFinalResult = (text: string) => {
            result.outputDelta = undefined;
            result.outputReset = undefined;
            result.updateResult(text);
        };

        // 正常完成 / 被用户 stop
        const onClose = (code: number | null) => {
            if (timedOut) return;
            try {
                let output = getOutput();
                if (isKilledByStop()) output = `[中断] 命令被用户终止。\n` + output;
                const message = output.trim() || `进程退出，代码 ${code ?? 'killed'}`;
                updateFinalResult(formatOutput?.(message) ?? message);
                if (Number.isInteger(code)) {
                    result.updateResultObject({ exitCode: code });
                }
            } catch (err) {
                logHandlerFailure('close', err);
            } finally {
                settle(false);
            }
        };

        const onError = (err: Error) => {
            if (timedOut) return;
            try {
                const message = `执行命令时出错: ${err.message}`;
                updateFinalResult(formatOutput?.(message) ?? message);
            } catch (handlerError) {
                logHandlerFailure('error', handlerError);
            } finally {
                settle(false);
            }
        };

        proc.on('close', onClose);
        proc.on('error', onError);

        /** 后台接管是否真的完成：失败时进程已无人跟踪，必须终止并关闭 artifact */
        let handoffCompleted = false;

        clock.onTimeout(() => {
            if (settled) return;
            timedOut = true;

            try {
                // 摘除工具自身的 listener，由后台管理器接管
                detachListeners();
                proc.removeListener('close', onClose);
                proc.removeListener('error', onError);

                const mgr = BackgroundProcessManager.getInstance();
                // register 对缺失 pid 是静默 no-op：不提前拦住的话会把「没接管成功」
                // 当成 handoffCompleted，artifact 就再也没人关了
                if (!proc.pid) throw new Error('进程缺少 pid，无法转入后台跟踪');
                // 权限弹窗等待时间不计入后台进程的“已执行时长”
                const activeElapsedMs = clock.getActiveElapsedMs();
                mgr.register(proc, command, getOutputBuffer?.() ?? getOutput(), Date.now() - activeElapsedMs);
                handoffCompleted = true;

                const elapsedSec = (activeElapsedMs / 1000).toFixed(1);
                const pid = proc.pid ?? 'unknown';
                const header = [
                    `[超时] 命令已执行 ${elapsedSec}s 未完成，已将进程放到后台继续执行。`,
                    `PID: ${pid}`,
                    `提示: 使用 checkShellStatus 工具并传入 pid=${pid}；waitMs 的允许范围是 0-30000 毫秒。仅在确实需要即时状态、且查询后可继续其他独立工作时使用 waitMs=0；确实需要很快再次观察进度时可用 waitMs=1000-5000；若下一步依赖完成结果，优先使用 waitMs=10000-30000。进程完成时会提前返回，无需等满 waitMs。避免对同一运行中 PID 连续零等待查询；只有判断进程卡住时才使用 kill=true。`
                ].join('\n');
                const trimmedOutput = getOutput().trim();
                const output = trimmedOutput || '(暂无输出)';
                // 零输出转后台时说明"暂无输出"的含义：缓冲类管道属正常静默，否则提示排查方向
                const silenceHint = trimmedOutput ? '' : `\n${silentBackgroundHint(command)}`;
                const message = header + silenceHint + '\n---\n' + output;
                updateFinalResult(formatOutput?.(message) ?? message);
            } catch (err) {
                logHandlerFailure('timeout', err);
                if (!handoffCompleted) {
                    // 接管失败：进程既查不到也杀不掉，继续跑只会泄漏，直接终止
                    killProcessTree(proc);
                }
                try {
                    // 这里不再走 formatOutput：它可能正是抛错的那一步
                    const pid = proc.pid ?? 'unknown';
                    updateFinalResult(
                        handoffCompleted
                            ? `[超时] 命令仍在后台运行（PID: ${pid}），但超时提示生成失败：${errorText(err)}\n\n${getOutput()}`
                            : `[超时] 命令超时后的后台接管失败：${errorText(err)}\n\n${getOutput()}`
                    );
                } catch {
                    /* 结算优先：结果文本写不进去也不能再抛 */
                }
            } finally {
                settle(handoffCompleted);
            }
        });
        clock.start();
    });
}
