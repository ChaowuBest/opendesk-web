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

/** 后台任务视图在不可见多久后释放（切换任务后旧视图控件默认长期驻留）。 */
export const TASK_VIEW_BACKGROUND_RELEASE_MS = 5 * 60 * 1000;

export interface TaskViewReleaseState {
    /** 视图当前是否不可见（display:none 或 data-background 后台挂载）。 */
    isHidden: boolean;
    /** 进入不可见状态的时间戳；0 表示可见或尚未记录。 */
    hiddenAt: number;
    /** 任务是否仍在运行。 */
    isRunning: boolean;
    /** 消息队列是否非空（队列仅存于控件内存，未持久化）。 */
    hasQueuedMessages?: boolean;
}

/**
 * 后台任务视图释放判定。
 *
 * 任务视图在切换后只是隐藏而非销毁，其整棵会话 DOM（长会话可达数百 MB）持续驻留。
 * 不可见超过 timeoutMs 且任务已不在运行时，应整体销毁控件、下次打开重新加载。
 * 以下情况不释放：
 * - 任务运行中：后台工具（如浏览器自动化）可能正在使用视图内的 webview 等
 *   UI 组件；任务结束后的下一轮扫描会将其释放。
 * - 消息队列非空：队列消息尚未持久化，释放会静默丢弃用户待发送内容。
 *   草稿与附件已由 task-draft-storage 按 task_id 持久化，不阻塞释放。
 */
export function shouldReleaseTaskView(
    state: TaskViewReleaseState,
    now: number,
    timeoutMs: number = TASK_VIEW_BACKGROUND_RELEASE_MS
): boolean {
    if (!state.isHidden) return false;
    if (state.isRunning) return false;
    if (state.hasQueuedMessages) return false;
    if (state.hiddenAt <= 0) return false;
    return now - state.hiddenAt >= timeoutMs;
}
