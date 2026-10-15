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

/*
 * 主窗口异常恢复。
 *
 * GPU 进程负责所有窗口的合成输出，它退出后已创建窗口的 surface 会与合成器失联，
 * 表现为画面冻结、点击无反馈，而主进程 JS 仍然存活。Chromium 自身会重启 GPU 进程，
 * 但不会把既有窗口重新挂到新进程上，因此需要主进程主动重载窗口。
 *
 * renderer 主线程真 hang 时 Electron 的 unresponsive 事件未必触发，故改用 renderer
 * 心跳上报作为探针：心跳缺失超过阈值即判定冻结。
 */

export interface ChildProcessGoneDetails {
    type: string;
    reason: string;
    exitCode: number;
}

export interface RecoveryLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export interface ReloadBudgetOptions {
    /** 时间窗内允许的最大重载次数，默认 3 */
    maxReloads?: number;
    /** 重载配额的滑动窗口长度（毫秒），默认 10000 */
    windowMs?: number;
    /** 配额耗尽时回调，携带本次请求重载的原因 */
    onExhausted?: (reason: string) => void;
    now?: () => number;
}

export interface ReloadBudget {
    /** 消耗一次重载配额；返回 true 表示调用方可以执行重载 */
    tryConsume(reason: string): boolean;
}

/*
 * 重载配额：滑动窗口计数，避免入口页加载失败、renderer 崩溃、GPU 崩溃互相触发时
 * 形成重载风暴。用时间戳列表而非「计数 + 重置定时器」，不额外持有活动定时器。
 */
export function createReloadBudget(options: ReloadBudgetOptions = {}): ReloadBudget {
    const maxReloads = options.maxReloads ?? 3;
    const windowMs = options.windowMs ?? 10_000;
    const now = options.now ?? Date.now;
    let consumedAt: number[] = [];

    return {
        tryConsume(reason: string): boolean {
            const at = now();
            consumedAt = consumedAt.filter((time) => at - time < windowMs);
            if (consumedAt.length >= maxReloads) {
                options.onExhausted?.(reason);
                return false;
            }
            consumedAt.push(at);
            return true;
        }
    };
}

export interface WindowRecoveryOptions {
    /**
     * 执行一次主窗口重载，返回 false 表示配额耗尽、实际未重载。
     * 配额由调用方注入的重载配额把关，本模块不重复限流。
     */
    reload: (cause: string) => boolean;
    /**
     * 主窗口是否可见。窗口隐藏或最小化时 Chromium 会节流 renderer 定时器，
     * 心跳间隔可达分钟级，此时心跳缺失不能作为冻结依据。
     */
    isWindowVisible: () => boolean;
    log: RecoveryLogger;
    /** 心跳静默超过该时长（毫秒）判定为冻结，默认 15000 */
    heartbeatTimeoutMs?: number;
    /** 冻结巡检间隔（毫秒），默认 5000 */
    heartbeatCheckMs?: number;
    now?: () => number;
}

export interface WindowRecoveryController {
    /** renderer 每次心跳上报时调用 */
    onHeartbeat(): void;
    /** 转发 app 的 child-process-gone 事件 */
    onChildProcessGone(details: ChildProcessGoneDetails): void;
    start(): void;
    stop(): void;
}

export function createWindowRecoveryController(options: WindowRecoveryOptions): WindowRecoveryController {
    const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 15_000;
    const heartbeatCheckMs = options.heartbeatCheckMs ?? 5_000;
    const now = options.now ?? Date.now;
    let lastHeartbeatAt = now();
    let watchdog: NodeJS.Timeout | null = null;

    const markHeartbeat = () => {
        lastHeartbeatAt = now();
    };

    const reloadFor = (cause: string) => {
        if (!options.reload(cause)) {
            options.log.error(`${cause}: reload budget exhausted, giving up automatic recovery`);
            return;
        }
        // 重载会重建 renderer，重置基线避免看门狗紧接着把正常加载误判为冻结
        lastHeartbeatAt = now();
    };

    const checkFreeze = () => {
        if (!options.isWindowVisible()) {
            lastHeartbeatAt = now();
            return;
        }
        const silentFor = now() - lastHeartbeatAt;
        if (silentFor <= heartbeatTimeoutMs) return;
        options.log.error(`renderer heartbeat silent for ${silentFor}ms, reloading main window`);
        reloadFor('freeze recovery');
    };

    return {
        onHeartbeat: markHeartbeat,

        onChildProcessGone(details: ChildProcessGoneDetails) {
            // child-process-gone 不上报 renderer 进程，renderer 崩溃由 webContents 的
            // render-process-gone 处理；这里只关心 GPU，其余子进程退出不影响窗口合成
            if (details.type !== 'GPU') return;
            // 不区分 reason：GPU 退出后画面冻结时 renderer 主线程往往仍然健康，
            // 心跳照常上报，看门狗兜不住这种「进程活着但画不出来」的情况，
            // 因此宁可偶尔多一次重载（clean-exit 场景），也不能漏掉冻结。
            options.log.error(
                `GPU process gone (reason=${details.reason}, exitCode=${details.exitCode}), reloading main window`
            );
            reloadFor('GPU recovery');
        },

        start() {
            if (watchdog) return;
            lastHeartbeatAt = now();
            watchdog = setInterval(checkFreeze, heartbeatCheckMs);
            watchdog.unref?.();
        },

        stop() {
            if (!watchdog) return;
            clearInterval(watchdog);
            watchdog = null;
        }
    };
}
