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
 * 操作系统通知的统一封装。
 *
 * 交互类面板（权限确认 / AskUser / 计划审批）在 renderer 展示内嵌弹窗的同时会推送一条
 * 系统通知。用户往往是在别的应用里看到通知才点回来的，因此把主窗口唤到前台后必须直接
 * 打开请求所属的任务，而不是停在用户离开时的视图上让他自己去侧边栏找。
 *
 * Linux 上通知的 click 事件并不可靠：部分通知守护进程只做「激活应用」，不投递
 * Electron 的 click 事件，窗口照样被拉到前台但回调不触发。因此除了 click 回调，
 * 还以主窗口获得焦点作为兜底入口，两条路径共用同一份「待打开任务」，只会消费一次。
 */

import type { BrowserWindow } from 'electron';
import { logger } from './logger.js';
import { safeSendToWebContents } from './electron-ipc.js';
import { electron } from '../../utils/electron.js';

/** 主窗口解析器，由 Electron 入口注入；未注入时点击通知不做唤起与跳转 */
let mainWindowResolver: (() => BrowserWindow | null) | null = null;

/**
 * 待打开任务：通知发出后等待用户点回来的任务，按 taskId 去重。
 *
 * 权限确认是串行弹窗，同一时刻只有一条通知；但 AskUser 可在单 turn 内并发多个、
 * ExitPlanMode 可跨任务并行，因此这里必须能容纳多条，不能互相覆盖。
 */
const pendingOpenTasks = new Map<string, number>();

/**
 * 唤起主窗口后延迟下发 command:openTask 的等待时长（ms）。
 * 主窗口从最小化/隐藏恢复是异步的，立即发送会让 IPC 在恢复期间被丢弃。
 */
const OPEN_TASK_DELAY_MS = 150;

/** 待打开任务的存活时长：覆盖各交互面板最长的等待时间（10 分钟） */
const PENDING_OPEN_TASK_TTL_MS = 10 * 60 * 1000;

/**
 * 上游在拿不到任务上下文时下发的占位 ID（见 aikernel/interaction/tools.ts）。
 * 它不是真实任务，跳过去只会让 renderer 去打开一个不存在的任务。
 */
const SENTINEL_TASK_IDS = new Set(['unknown']);

/** 归一化 taskId：空值与占位 ID 一律视为「没有任务可跳」 */
function normalizeTaskId(taskId?: string | null): string | null {
    if (!taskId) return null;
    return SENTINEL_TASK_IDS.has(taskId) ? null : taskId;
}

export interface TaskNotificationOptions {
    title: string;
    body: string;
    /** 请求所属任务；点击通知时主窗口直接打开该任务 */
    taskId?: string | null;
}

/**
 * 注册主窗口解析器，供通知点击时唤起主窗口并跳转任务。
 *
 * 顺带把「主窗口获得焦点」挂成兜底入口：通知 click 未投递时，用户点通知唤起的
 * 窗口同样会触发 focus，据此仍能跳转到请求所属任务。
 */
export function registerNotificationMainWindowResolver(resolver: () => BrowserWindow | null): void {
    mainWindowResolver = resolver;
    registerFocusFallback();
}

/**
 * 推送一条与任务关联的系统通知。
 *
 * 点击通知（或通知唤起主窗口后窗口获得焦点）时把主窗口恢复到前台，
 * 并让 renderer 打开 `taskId` 对应的任务。
 * 系统不支持通知（或 Notification 构造失败）时静默跳过，不影响调用方的面板流程。
 */
export function showTaskNotification(options: TaskNotificationOptions): void {
    const { Notification } = electron();
    if (!Notification.isSupported()) return;

    const taskId = normalizeTaskId(options.taskId);
    if (taskId) {
        pruneExpiredPendingTasks();
        // 同一任务可能连续弹出多条（如 AskUser 一轮多问），去重避免兜底路径重复跳转
        pendingOpenTasks.set(taskId, Date.now() + PENDING_OPEN_TASK_TTL_MS);
    }

    try {
        const notification = new Notification({
            title: options.title,
            body: options.body,
            silent: false
        });
        notification.on('click', () => {
            // click 精确绑定了这条通知的任务，用户意图已明确：丢弃全部待打开记录，
            // 交给 click 自己跳。唤起窗口触发的 focus 兜底若还看到别的残留记录，
            // 会在 click 之后又跳一次，最终落在哪个任务取决于定时器注册顺序。
            pendingOpenTasks.clear();
            focusMainWindowForTask(taskId);
        });
        notification.show();
    } catch (err) {
        logger.warn(`failed to show system notification: ${err}`);
    }
}

/**
 * 在主窗口中打开指定任务。
 *
 * 供「应用内跳转到某个任务」复用：与通知点击走同一套「恢复主窗口 + command:openTask」流程，
 * 避免各处重复实现窗口恢复与延迟投递。
 */
export function openTaskInMainWindow(taskId: string): void {
    const normalized = normalizeTaskId(taskId);
    if (!normalized) return;
    focusMainWindowForTask(normalized);
}

/**
 * 把主窗口恢复到前台；带 taskId 时让 renderer 切到该任务。
 *
 * 与 task-status-widget 唤起主窗口的行为保持一致：最小化要先 restore，
 * macOS 上 show() 恢复隐藏窗口后可能不会激活应用，需要 app.focus 强制激活。
 */
function focusMainWindowForTask(taskId?: string | null): void {
    const win = mainWindowResolver?.() ?? null;
    if (!win || win.isDestroyed()) {
        logger.warn('system notification clicked but no main window is available');
        return;
    }

    if (win.isMinimized()) {
        win.restore();
    }
    win.show();
    win.moveTop();
    if (process.platform === 'darwin') {
        electron().app.focus({ steal: true });
    }
    win.focus();

    if (taskId) {
        dispatchOpenTask(win, taskId);
    }
}

/**
 * 兜底入口：主窗口获得焦点时消费待打开任务。
 *
 * 窗口被通知唤起（或用户自己切回）都会触发。与 click 回调互斥：click 会先丢弃
 * 全部待打开记录，因此走 click 时兜底无任务可消费；兜底只在「恰好剩下一条」时生效。
 */
const focusFallbackHandler = (_event: unknown, win: BrowserWindow): void => {
    const main = mainWindowResolver?.() ?? null;
    if (!main || main.isDestroyed() || win !== main) return;
    const taskId = takeSolePendingTask();
    if (!taskId) return;
    logger.info(`main window focused with pending task ${taskId}, opening it`);
    dispatchOpenTask(main, taskId);
};

function registerFocusFallback(): void {
    const { app } = electron();
    // 用稳定的 handler 引用先移除再注册，保证多窗口重建时不会叠加监听
    app.removeListener('browser-window-focus', focusFallbackHandler);
    app.on('browser-window-focus', focusFallbackHandler);
}

/**
 * 取出唯一的待打开任务并消费。
 *
 * 同时存在多条时无法判断用户点的是哪一条通知，宁可不跳也不要把用户带到错误的任务上；
 * 这些残留已无用处，一并丢弃，避免它们之后凑成「唯一一条」时误触发跳转。
 */
function takeSolePendingTask(): string | null {
    pruneExpiredPendingTasks();
    if (pendingOpenTasks.size === 0) return null;
    if (pendingOpenTasks.size > 1) {
        logger.info(`skipping auto open: ${pendingOpenTasks.size} tasks pending, cannot tell which one`);
        pendingOpenTasks.clear();
        return null;
    }
    const [taskId] = pendingOpenTasks.keys();
    pendingOpenTasks.delete(taskId);
    return taskId;
}

/** 清理超过 TTL 的待打开任务：权限请求等多半已超时，跳过去只会误导用户 */
function pruneExpiredPendingTasks(): void {
    const now = Date.now();
    for (const [taskId, expiresAt] of pendingOpenTasks) {
        if (now > expiresAt) {
            pendingOpenTasks.delete(taskId);
        }
    }
}

/**
 * 丢弃待打开任务。
 *
 * 供宿主在请求被结算（用户已在应用内手动应答、任务已停止、已超时）时调用：
 * 用户没点通知就直接应答的话，记录会一直留到 TTL 到期，期间任意一次窗口聚焦
 * 都会把用户强制跳到那个已经处理完的任务上。传入 taskId 只清该任务，省略则全清。
 * 也可用于测试重置模块级状态。
 */
export function clearPendingOpenTasks(taskId?: string | null): void {
    if (taskId === undefined || taskId === null) {
        pendingOpenTasks.clear();
        return;
    }
    pendingOpenTasks.delete(taskId);
}

/**
 * 通知 renderer 打开指定任务。
 *
 * 主窗口从最小化/隐藏恢复是异步的，延迟后再发，避免 IPC 在窗口恢复期间被丢弃。
 */
function dispatchOpenTask(win: BrowserWindow, taskId: string): void {
    setTimeout(() => {
        if (win.isDestroyed()) return;
        const delivered = safeSendToWebContents(win.webContents, 'command:openTask', taskId);
        logger.info(`dispatched command:openTask for task ${taskId}, delivered=${delivered}`);
    }, OPEN_TASK_DELAY_MS);
}
