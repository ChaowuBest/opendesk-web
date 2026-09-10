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
 * Keeps the one-time Browser Use layout reveal scoped to a task for the current
 * renderer session, and remembers reveals requested while the task was hidden.
 *
 * 会话级语义：OpenDesk 重启后每个任务重新拥有首次自动进入大屏预览的机会；
 * 同一会话内机会只会被消费一次，手动退出大屏布局后不再自动进入。
 */
export class BrowserAutoRevealState {
    private readonly _claimedTaskIds = new Set<string>();
    private readonly _pendingRevealTaskIds = new Set<string>();

    /** Claim the task's single automatic Browser Use layout reveal of this session. */
    consume(taskId: string): boolean {
        if (!taskId || this._claimedTaskIds.has(taskId)) return false;
        this._claimedTaskIds.add(taskId);
        return true;
    }

    /**
     * 后台任务首次 Browser Use 时记录其期望的大屏预览状态。
     * 状态按任务维度保存，不在前台立即生效，避免打断用户当前布局。
     */
    markPendingReveal(taskId: string): void {
        if (!taskId) return;
        this._pendingRevealTaskIds.add(taskId);
    }

    /** 任务对用户可见时消费待应用的预览状态；返回 true 表示应立即进入浏览器大屏布局。 */
    takePendingReveal(taskId: string): boolean {
        if (!taskId || !this._pendingRevealTaskIds.has(taskId)) return false;
        this._pendingRevealTaskIds.delete(taskId);
        return true;
    }

    /** 浏览器被完整销毁时丢弃尚未应用的预览状态。 */
    clearPendingReveal(taskId: string): void {
        if (!taskId) return;
        this._pendingRevealTaskIds.delete(taskId);
    }
}

export const browserAutoRevealState = new BrowserAutoRevealState();
