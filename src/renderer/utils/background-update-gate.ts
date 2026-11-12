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
 * 窗口隐藏期间的渲染冻结闸门。
 *
 * TaskView 既有的丢帧条件只覆盖视图不可见（display:none / data-background），不感知
 * 窗口可见性：窗口最小化/被完全遮挡但任务视图仍活跃时，backgroundThrottling 只节流
 * timer/rAF，IPC 到达后的 DOM 工作照常执行，后台期间持续积攒渲染债务。窗口拉回前台
 * 时合成器恢复需要渲染主线程提交新帧，却被积压债务与 timer 补发潮占满，表现为回前台
 * 数秒 UI 不响应。
 *
 * 语义：窗口不可见时丢弃渲染工作（调用方仍可同步 task_status 等轻量状态），并登记
 * 一次待补齐的 reload；窗口恢复可见时消费该标记触发一次补齐，后台跳过的更新由此
 * 全量兜底。标记一次性消费，多次丢帧合并为一次 reload。
 */
export class BackgroundUpdateGate {
    private pendingReload = false;

    constructor(
        /** 返回当前窗口是否可见；undefined 等非 false 值视为可见（标志未初始化时不丢帧） */
        private readonly isWindowVisible: () => boolean,
        /** 窗口恢复可见后需要补齐更新时的回调（TaskView.reload） */
        private readonly onPendingReload: () => void
    ) {}

    /**
     * 处理一条任务更新前调用：窗口隐藏时返回 true 表示应跳过本次渲染工作。
     * 每次跳过都会（重新）登记待补齐标记，恢复可见后由 onWindowBecameVisible 消费。
     */
    shouldSkipRender(): boolean {
        if (this.isWindowVisible() !== false) return false;
        this.markPendingReload();
        return true;
    }

    /**
     * 登记（或合并）一次待补齐标记，不经跳过判定直接使用。
     * 供 shouldSkipRender 之外的丢弃路径使用，如缓冲定时器跨隐藏边界丢弃快照。
     */
    markPendingReload(): void {
        this.pendingReload = true;
    }

    /** 窗口恢复可见时调用：若后台期间发生过丢帧，触发一次补齐。 */
    onWindowBecameVisible(): void {
        if (!this.pendingReload) return;
        this.pendingReload = false;
        this.onPendingReload();
    }
}
