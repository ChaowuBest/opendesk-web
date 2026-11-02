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

/** 终端 live 输出在未截断且快照较小时的推送间隔（尾部增量很小，保持流畅度）。 */
export const TERMINAL_LIVE_UPDATE_INTERVAL_MS = 200;

/**
 * 「大快照」的推送间隔与门槛。
 *
 * 每个 tick 主进程都要重新渲染整份 part HTML（escapeHtml(stripAnsi(输出))），并把
 * 同等大小的快照随 IPC 传一遍，成本与快照长度成正比。输出涨到 64KiB 以上时把节奏
 * 降到 2.5Hz（400ms，正好是 200ms tick 的整数倍，实际落点可预测）：观感上仍是连续
 * 刷新，主线程与 IPC 开销减半。
 */
export const TERMINAL_LIVE_UPDATE_HEAVY_INTERVAL_MS = 400;
export const TERMINAL_LIVE_UPDATE_HEAVY_CHARS = 64 * 1024;

/**
 * 终端 live 输出在缓冲截断后的推送间隔。
 *
 * BoundedOutputBuffer 截断（>256KiB）后快照变成 head + 截断标记 + tail，
 * tail 每滑动一次就破坏前缀关系，computeTerminalOutputDelta 只能返回
 * reset + 全量文本。实测 20 秒持续构建日志：100 次 tick 中 83 次 reset，
 * 平均每 tick 重传 215KiB；对应渲染端每 200ms 整体重写输出区。
 * 降频到 1s 可在保住「能看到进度」的同时把这条路径的开销压到 1/5。
 */
export const TERMINAL_LIVE_UPDATE_TRUNCATED_INTERVAL_MS = 1000;

/**
 * 终端 live 输出推送节流器。
 *
 * 只决定「这一次 tick 要不要推给前端」，不参与 delta 计算：任何时刻的语义都是
 * 「未截断时推送尾部增量、截断时推送 reset + 全量」，节流只改变推送频率，
 * 因此调用方必须按同一基准（上次放行的快照）计算增量。
 */
export class TerminalLiveUpdateThrottle {
    private lastPushAt = Number.NEGATIVE_INFINITY;

    constructor(
        private readonly intervalMs: number = TERMINAL_LIVE_UPDATE_INTERVAL_MS,
        private readonly heavyIntervalMs: number = TERMINAL_LIVE_UPDATE_HEAVY_INTERVAL_MS,
        private readonly truncatedIntervalMs: number = TERMINAL_LIVE_UPDATE_TRUNCATED_INTERVAL_MS,
        private readonly heavyChars: number = TERMINAL_LIVE_UPDATE_HEAVY_CHARS,
        /**
         * 定时器抖动容差：setInterval 可能比标称间隔早 1~2ms 触发，
         * 没有容差时未截断路径会偶尔丢掉一次 tick（下一次 delta 变大，视觉上出现跳帧）。
         */
        private readonly toleranceMs: number = 16
    ) {}

    /**
     * @param snapshotChars 本次快照的近似字符数（O(1) 取长度，不要为此 join 整份文本）
     */
    shouldPush(now: number, truncated: boolean, snapshotChars = 0): boolean {
        const interval = truncated
            ? this.truncatedIntervalMs
            : snapshotChars >= this.heavyChars
              ? this.heavyIntervalMs
              : this.intervalMs;
        if (now - this.lastPushAt < interval - this.toleranceMs) return false;
        this.lastPushAt = now;
        return true;
    }
}
