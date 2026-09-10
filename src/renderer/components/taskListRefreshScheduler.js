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

// RAF 兜底期限。窗口可见时 requestAnimationFrame 通常在下一帧（~16ms）内执行；
// 若仅依赖 RAF，页面被节流/冻结等异常场景下回调被无限推迟，调度状态被永久占用，
// 此后所有刷新都会被跳过。注意：Electron backgroundThrottling 对 hidden/occluded
// 页面的 timer 有 ~1s 的下限，窗口被遮挡时该兜底实际由节流后的 timer 触发。
export const RAF_FALLBACK_TIMEOUT_MS = 400;

// 兜底 warn 日志的节流窗口。RAF 长期挂死时活跃任务每次更新都会触发兜底，
// 节流避免日志刷屏；强制刷新不受节流影响，始终执行。
export const FALLBACK_WARN_LOG_INTERVAL_MS = 10000;

/**
 * 任务列表刷新调度器：requestAnimationFrame 防抖 + setTimeout 超时兜底。
 *
 * 不依赖 DOM，requestAnimationFrame/setTimeout 使用全局实现，
 * 便于在 Node 测试环境中通过 mock 全局函数来模拟"RAF 回调被丢弃"等场景。
 */
export class TaskListRefreshScheduler {
    /**
     * @param {object} options
     * @param {() => void} options.refresh 执行实际列表刷新的回调
     * @param {(level: string, message: string) => void} [options.log] 诊断日志回调（转发到主进程日志）
     * @param {() => boolean} [options.isWindowVisible] 窗口可见性查询
     */
    constructor({ refresh, log, isWindowVisible }) {
        this._refresh = refresh;
        this._log = log ?? (() => {});
        this._isWindowVisible = isWindowVisible ?? (() => true);
        this._pendingRafId = undefined;
        this._coalescedUpdates = 0;
        this._pendingRefreshWhileHidden = false;
        this._lastFallbackWarnAt = -Infinity;
    }

    // 调度一次列表刷新：RAF pending 期间的更新被合并，RAF 丢失时由 setTimeout 兜底强制刷新
    schedule() {
        // 窗口隐藏时跳过渲染以省电，只标记待刷新，由窗口恢复可见事件触发刷新
        if (!this._isWindowVisible()) {
            this._pendingRefreshWhileHidden = true;
            return;
        }
        if (this._pendingRafId !== undefined) {
            this._coalescedUpdates += 1;
            return;
        }
        // 兜底定时器用闭包绑定本轮调度：RAF 正常触发时立即 clearTimeout，
        // 既消除遗留的 no-op 定时器，也避免浏览器复用数值 RAF id 时，
        // 旧一轮的兜底定时器凭 id 相等误判归属、取消新一轮 pending 的 RAF
        const fallbackTimerId = setTimeout(() => {
            // 到达此处说明 RAF 回调在期限内未执行（页面被节流/遮挡/冻结或主线程长任务），
            // 此日志用于诊断"任务列表停止刷新"类问题。兜底定时器只可能在本轮 RAF
            // 未执行时存活，故 _pendingRafId 必为本轮 id，直接取消即可
            cancelAnimationFrame(this._pendingRafId);
            this._pendingRafId = undefined;
            this._flushCoalescedUpdatesLog();
            if (this._isWindowVisible()) {
                // 节流窗口内的重复兜底不再记 warn，避免 RAF 长期挂死时日志刷屏；
                // 强制刷新始终执行
                const now = Date.now();
                if (now - this._lastFallbackWarnAt >= FALLBACK_WARN_LOG_INTERVAL_MS) {
                    this._lastFallbackWarnAt = now;
                    this._log(
                        'warn',
                        `[sidebar] task list refresh: RAF callback did not fire within ${RAF_FALLBACK_TIMEOUT_MS}ms` +
                            ' (possible page throttling/occlusion/freeze or long task), forced refresh via setTimeout fallback'
                    );
                }
                this._refresh();
            } else {
                // 兜底触发时窗口已隐藏：遵循省电设计不渲染，等恢复可见时刷新
                this._pendingRefreshWhileHidden = true;
            }
        }, RAF_FALLBACK_TIMEOUT_MS);
        const rafId = requestAnimationFrame(() => {
            this._pendingRafId = undefined;
            clearTimeout(fallbackTimerId);
            this._flushCoalescedUpdatesLog();
            this._refresh();
        });
        this._pendingRafId = rafId;
    }

    // 窗口隐藏期间发现数据过期时置位待刷新标记（如 chat badge 定时器）
    markPendingRefreshWhileHidden() {
        this._pendingRefreshWhileHidden = true;
    }

    // 窗口恢复可见时读取并清除待刷新标记
    consumePendingRefreshWhileHidden() {
        const pending = this._pendingRefreshWhileHidden;
        this._pendingRefreshWhileHidden = false;
        return pending;
    }

    _flushCoalescedUpdatesLog() {
        if (this._coalescedUpdates > 0) {
            this._log(
                'debug',
                `[sidebar] task list refresh: ${this._coalescedUpdates} update(s) coalesced while RAF pending`
            );
            this._coalescedUpdates = 0;
        }
    }
}
