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
 *
 * 但心跳是 renderer 侧 setInterval 驱动的，窗口被其他窗口遮挡（Chromium 的 occlusion
 * 判定）或最小化时会被节流到分钟级，此时心跳缺失并不代表冻结。故静默超时后先发一次
 * IPC 探活请求，要求 renderer 立即补报心跳：IPC 消息不受定时器节流影响，主线程卡死才
 * 会无回应，据此区分「后台节流」与「真冻结」。
 *
 * 设计权衡——为什么保留心跳，而不是让主进程纯轮询探活：
 * 心跳是高频、被动、自动节流的活性遥测：窗口可见时 3s 一次 send-only IPC（renderer
 * 本就活跃，边际成本≈0），后台时 Chromium 自动把它降到分钟级，省电是白送的。探活则是
 * 低频、主动、按需的确认：只在心跳静默给出嫌疑证据后才出手，且带退避。若改成主进程
 * 定时轮询，IPC 不受节流约束，每次探测都会打破 renderer 的 idle，要么高频轮询架空
 * Chromium 的整套后台节流（费电），要么低频轮询让冻结发现延迟到分钟级；且判死只剩
 * 「单次超时」一条证据。现状的双证据（静默超时 + 探活无回应）误判率更低，两个旋钮
 * （静默阈值=灵敏度、探活超时=确认耐心）也可独立调参。改动前请想清楚这层。
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

/*
 * 探活退避上限。renderer 被判定为后台节流后，触发下一次探活所需的静默时长逐次翻倍
 * 直到该值，与 Chromium 自身的后台节流档位（约 1 分钟）对齐，避免窗口长时间被遮挡时
 * 反复唤醒 renderer 抵消掉后台节流本来省下的电。
 */
const PROBE_BACKOFF_MAX_MS = 60_000;

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
    /**
     * 请求主窗口 renderer 立即补报一次心跳，用于二次确认冻结。
     *
     * 心跳是 renderer 侧定时器驱动的，窗口被遮挡或最小化时会被 Chromium 节流；
     * 而 IPC 消息仍会正常投递到 renderer 主线程，故探活能区分「定时器被节流」与
     * 「主线程卡死」。不注入时退化为仅凭心跳静默判定（静默超时即重载）。
     */
    requestHeartbeatProbe?: () => void;
    /** 心跳静默超过该时长（毫秒）判定为疑似冻结，默认 15000 */
    heartbeatTimeoutMs?: number;
    /** 冻结巡检间隔（毫秒），默认 5000 */
    heartbeatCheckMs?: number;
    /** 探活发出后等待心跳回归的时长（毫秒），默认 10000 */
    probeTimeoutMs?: number;
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
    // 探活窗口给到 10s：能卡 15s 以上又自愈的长卡顿（大 JSON 解析、同步 IO）不在少数，
    // 5s 窗口会把它们误判成冻结；真冻结的恢复只多等 5s，感知差异远小于误重载。
    const probeTimeoutMs = options.probeTimeoutMs ?? 10_000;
    const now = options.now ?? Date.now;
    let lastHeartbeatAt = now();
    /** 待确认探活的起始时刻（为空表示当前没有探活在等待回应） */
    let probeStartedAt: number | null = null;
    /** 已确认处于「后台定时器被节流」状态（依赖探活兜底），用于日志只在状态切换时记录 */
    let probeAssisted = false;
    /** 上一轮巡检时的窗口可见性（为空表示尚未巡检过） */
    let lastVisible: boolean | null = null;
    /**
     * 连续被判定为后台节流时，触发下一次探活所需的心跳静默时长。
     * 探活同样要唤醒 renderer，窗口长时间被遮挡时逐步退避到 PROBE_BACKOFF_MAX_MS，
     * 让探活频率不高于 Chromium 自身的节流档位。
     */
    let probeIntervalMs = heartbeatTimeoutMs;
    let watchdog: NodeJS.Timeout | null = null;

    const resetProbeBackoff = () => {
        probeIntervalMs = heartbeatTimeoutMs;
    };

    const markHeartbeat = () => {
        const at = now();
        const gap = at - lastHeartbeatAt;
        lastHeartbeatAt = at;
        if (probeStartedAt !== null) {
            // 探活后 renderer 立刻补报了心跳：主线程仍在派发 IPC，先前的静默只是后台定时器被节流
            probeStartedAt = null;
            probeIntervalMs = Math.min(probeIntervalMs * 2, PROBE_BACKOFF_MAX_MS);
            return;
        }
        // 心跳回到正常周期说明节流已解除（窗口重新可见），退出探活兜底状态
        if (probeAssisted && gap <= heartbeatTimeoutMs) {
            probeAssisted = false;
            resetProbeBackoff();
            options.log.info('renderer heartbeat resumed at normal cadence');
        }
    };

    const reloadFor = (cause: string) => {
        if (!options.reload(cause)) {
            options.log.error(`${cause}: reload budget exhausted, giving up automatic recovery`);
            return;
        }
        // 重载会重建 renderer，重置基线避免看门狗紧接着把正常加载误判为冻结
        lastHeartbeatAt = now();
        probeStartedAt = null;
        probeAssisted = false;
        resetProbeBackoff();
    };

    const beginProbe = (at: number, silentFor: number) => {
        probeStartedAt = at;
        // 遮挡期间会反复走探活路径，日志只在进入该状态时记一条，避免刷屏
        if (!probeAssisted) {
            probeAssisted = true;
            options.log.warn(`renderer heartbeat silent for ${silentFor}ms, probing renderer before reload`);
        }
        try {
            options.requestHeartbeatProbe?.();
        } catch (error) {
            options.log.warn(`failed to dispatch renderer heartbeat probe: ${String(error)}`);
        }
    };

    const checkFreeze = () => {
        const at = now();
        const visible = options.isWindowVisible();
        const becameVisible = visible && lastVisible === false;
        lastVisible = visible;
        if (!visible) {
            // 窗口隐藏/最小化时 renderer 定时器必然被节流，心跳缺失不构成冻结证据；
            // 顺带丢弃进行中的探活，避免窗口重新可见后拿旧的探活结果误判
            lastHeartbeatAt = at;
            probeStartedAt = null;
            return;
        }
        if (probeStartedAt !== null) {
            if (at - probeStartedAt < probeTimeoutMs) return;
            // 探活都拿不到回应，renderer 主线程确实卡住了。
            // 是否真的重载由 reloadFor 内的配额决定，这里不断言结果，避免 budget 拒绝时日志误导
            probeStartedAt = null;
            options.log.error(`renderer heartbeat probe timed out after ${probeTimeoutMs}ms`);
            reloadFor('freeze recovery');
            return;
        }
        // 窗口重新可见且此前一直依赖探活兜底：立即验证一次。renderer 若死在了遮挡期间，
        // 不能让用户切回冻结界面后再等完整个退避周期（最长 60s+超时）才恢复
        if (becameVisible && probeAssisted && options.requestHeartbeatProbe) {
            beginProbe(at, at - lastHeartbeatAt);
            return;
        }
        const silentFor = at - lastHeartbeatAt;
        const requiredSilence = probeAssisted ? probeIntervalMs : heartbeatTimeoutMs;
        if (silentFor <= requiredSilence) return;
        if (!options.requestHeartbeatProbe) {
            options.log.error(`renderer heartbeat silent for ${silentFor}ms, reloading main window`);
            reloadFor('freeze recovery');
            return;
        }
        // 静默超时不直接重载：窗口被遮挡时 Chromium 会节流 renderer 定时器，先探活确认
        beginProbe(at, silentFor);
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
            probeStartedAt = null;
            probeAssisted = false;
            lastVisible = null;
            resetProbeBackoff();
            watchdog = setInterval(checkFreeze, heartbeatCheckMs);
            watchdog.unref?.();
        },

        stop() {
            if (!watchdog) return;
            clearInterval(watchdog);
            watchdog = null;
            probeStartedAt = null;
        }
    };
}
