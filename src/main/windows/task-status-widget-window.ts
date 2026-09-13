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

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { BaseTaskManagerUpdateSubscriber } from '../aikernel/task/manager.js';
import { errorToMessage, type TaskUpdateChunk } from '../aikernel/task/types.js';
import { BaseTaskUpdateSubscriber } from '../aikernel/states/tasks.js';
import { logger } from '../utils/logger.js';
import { safeSendToWebContents } from '../utils/electron-ipc.js';
import {
    buildTaskStatusSummary,
    computeTriggerActive,
    isWidgetTriggerEffective,
    mergeTaskLiveUsage,
    pruneStaleWaitingTaskIds,
    updateTaskSnapshot,
    type FloatingWindowMode,
    type TaskStatusListEntry,
    type TaskStatusWidgetSummary,
    type TaskStatusWidgetTask,
    type TaskUsageTrackedState,
    type WidgetSuppressionState
} from './task-status-widget.js';
import type { TaskUsageSnapshot } from '../aikernel/task/types.js';
import { getTaskTodosForDisplay } from '../aikernel/todos/task-todos.js';
import { Setting } from '../utils/setting.js';

/**
 * 任务状态浮窗（主进程侧窗口管理）。
 *
 * 依据设置的显示模式（pill=单行胶囊 / card=完整卡片 / 未设置=关闭）与当前是否
 * 存在活跃任务，在屏幕右下角创建常驻最前的无边框小窗展示活跃任务；浮窗开启期间
 * 任务结束后保留为完成状态，直到主窗口恢复前台才关闭。pill 模式默认胶囊、获得焦点
 * 展开、失焦收回；card 模式默认完整卡片，仅手动收起。每次启动的初始显示位置由设置
 * floating_window_position 决定（默认右下角）；会话内用户拖拽后的位置保持到应用退出。
 */

const WIDGET_WIDTH = 340;
const WIDGET_HEIGHT = 215;
const WIDGET_COLLAPSED_WIDTH = 240;
const WIDGET_COLLAPSED_HEIGHT = 44;
const WIDGET_MARGIN = 28;
/** 浮窗专用 session partition，用于把页面缩放状态与主窗口隔离。 */
const WIDGET_PARTITION = 'task-status-widget';

/** 悬浮窗显示位置（与设置 gui_config.floating_window_position 对齐）。 */
type FloatingWindowPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface TaskStatusWidgetHost {
    getPreloadPath(): string;
    getMainWindow(): BrowserWindow | null;
    getTaskList(): TaskStatusListEntry[];
    addTaskListSubscriber(subscriber: BaseTaskManagerUpdateSubscriber): string;
    loadWidgetPage(win: BrowserWindow): void;
    getFloatingWindowMode(): FloatingWindowMode;
    /** 获取任务的 usage 快照（累计 usage_summary + 在途消息实时 usage）。 */
    getTaskUsageSnapshot?(taskId: string): TaskUsageSnapshot | undefined;
    /** 订阅任务的实时更新（流式 chunk），返回取消订阅函数。 */
    subscribeTaskUpdate?(taskId: string, subscriber: BaseTaskUpdateSubscriber): (() => void) | undefined;
}

let host: TaskStatusWidgetHost | null = null;
let widgetWindow: BrowserWindow | null = null;
let initialized = false;

/** 主窗口是否处于隐藏状态（最小化或最小化到托盘）。 */
let isWindowHidden = false;
/** 主窗口是否处于前台（拥有焦点）。 */
let isWindowFocused = true;
/** 最近一次任务列表快照，用于计算活跃任务。 */
let taskList: TaskStatusListEntry[] = [];
/** 本次浮窗「打开周期」内保留的任务快照（含已结束任务）。 */
let snapshot: TaskStatusWidgetTask[] = [];
/** 当前正在等待用户输入的任务 ID 集合（由 renderer 转发 task-waiting-state 事件）。 */
const waitingTaskIds = new Set<string>();
/** 浮窗当前是否处于收起（胶囊）状态。 */
let isCollapsed = true;
/** 上一次触发是否激活，用于在打开周期开始时按模式初始化形态。 */
let lastTriggerActive = false;
/** 上一次的显示模式，用于检测设置变更。 */
let lastMode: FloatingWindowMode = undefined;
/**
 * 本次会话内用户拖拽后的窗口左上角（仅存内存，不落盘，应用退出即失效）。
 * null 表示本次会话尚未拖拽过，使用设置中的初始角。
 */
let sessionPosition: { x: number; y: number } | null = null;
/** 上次程序化 setBounds 的目标左上角，用于在 moved 事件中区分用户拖拽与程序化移动。 */
let lastProgrammaticOrigin: { x: number; y: number } | null = null;
/**
 * 用户通过关闭菜单设置的抑制状态：
 * - dismissed：本次触发周期内不再显示（主窗口回到前台后自动恢复）；
 * - sessionDisabled：本次会话内不再显示（「下次启动恢复」，随应用退出重置）。
 */
const suppression: WidgetSuppressionState = {};

/**
 * 每个任务的 usage 合并跟踪状态（key = task_id）。
 * 跨「任务列表更新 / 流式 chunk 推送」保持，避免在途消息请求提交后重复计数。
 */
const usageTrackedByTask = new Map<string, TaskUsageTrackedState>();
/** 活跃任务的状态更新订阅（key = task_id，value = 取消订阅函数）。 */
const taskUpdateUnsubscribers = new Map<string, () => void>();
/** 流式 chunk 推送的节流定时器（普通文本 chunk 不逐个推送）。 */
let pushTimer: ReturnType<typeof setTimeout> | null = null;
const PUSH_THROTTLE_MS = 5000;

function schedulePushSummary(): void {
    if (pushTimer !== null) {
        return;
    }
    pushTimer = setTimeout(() => {
        pushTimer = null;
        pushSummary();
    }, PUSH_THROTTLE_MS);
}

function cancelScheduledPush(): void {
    if (pushTimer !== null) {
        clearTimeout(pushTimer);
        pushTimer = null;
    }
}

function chunkCarriesUsage(chunk: TaskUpdateChunk): boolean {
    return (
        (chunk.type === 'assistant' || chunk.type === 'assistant_replace' || chunk.type === 'user') &&
        chunk.usage !== undefined &&
        chunk.usage !== null
    );
}

function handleTaskUpdateChunk(chunk: TaskUpdateChunk): void {
    if (chunkCarriesUsage(chunk)) {
        // 携带 usage 的 chunk（请求结束/消息边界的最终 usage）是 token 数真正变化的时刻：
        // 立即同步推送，保证最终数值及时送达；同时在请求提交进 usage_summary 之前完成
        // 合并，避免 live 值已被吸收后重复计数。
        cancelScheduledPush();
        pushSummary();
        return;
    }
    // 普通流式 chunk：5s 节流推送即可。
    schedulePushSummary();
}

/**
 * 让浮窗订阅快照中的活跃任务（running/waiting）以接收流式更新，并取消
 * 已不再活跃任务的订阅。在快照变化后调用。
 */
function syncTaskUpdateSubscriptions(): void {
    if (!host) {
        return;
    }
    const activeIds = new Set(snapshot.filter((task) => task.task_status !== 'completed').map((task) => task.task_id));

    for (const [taskId, unsubscribe] of taskUpdateUnsubscribers) {
        if (activeIds.has(taskId)) {
            continue;
        }
        try {
            unsubscribe();
        } catch (err) {
            logger.warn(`failed to unsubscribe task ${taskId} update subscription: ${errorToMessage(err)}`);
        }
        taskUpdateUnsubscribers.delete(taskId);
        usageTrackedByTask.delete(taskId);
    }

    for (const taskId of activeIds) {
        if (taskUpdateUnsubscribers.has(taskId)) {
            continue;
        }
        const subscriber = new (class extends BaseTaskUpdateSubscriber {
            send(chunk: TaskUpdateChunk): void {
                handleTaskUpdateChunk(chunk);
            }
        })();
        const unsubscribe = host.subscribeTaskUpdate?.(taskId, subscriber);
        if (typeof unsubscribe === 'function') {
            taskUpdateUnsubscribers.set(taskId, unsubscribe);
        }
    }
}

function reevaluate(): void {
    if (!host) {
        return;
    }
    const mode = host.getFloatingWindowMode();
    const state = {
        hidden: isWindowHidden,
        focused: isWindowFocused
    };
    const triggerActive = computeTriggerActive(mode, state);
    const effectiveActive = isWidgetTriggerEffective(mode, state, suppression);

    if (!triggerActive) {
        // 触发条件失效（主窗口回到前台等）：恢复「关闭一次」的抑制标记，
        // 清空本次打开周期内的快照。
        suppression.dismissed = false;
        lastTriggerActive = false;
        snapshot = [];
        // 同步取消所有任务订阅，避免任务结束后仍持续接收流式 chunk。
        syncTaskUpdateSubscriptions();
        hideWidget();
        return;
    }

    if (!effectiveActive) {
        // 触发条件激活但用户已通过关闭菜单抑制显示（本次触发周期 / 本次会话）。
        hideWidget();
        return;
    }

    if (!lastTriggerActive) {
        // 新的打开周期：按模式初始化形态（pill 默认胶囊，card 默认完整卡片）。
        lastTriggerActive = true;
        setWidgetCollapsed(mode === 'pill');
    }

    snapshot = updateTaskSnapshot(snapshot, taskList);
    syncTaskUpdateSubscriptions();
    if (snapshot.length > 0) {
        showWidget();
    } else {
        // 触发激活但当前没有活跃任务：不显示，等待活跃任务出现。
        hideWidget();
    }
}

function ensureWidgetWindow(): BrowserWindow | null {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
        return widgetWindow;
    }
    if (!host) {
        return null;
    }

    const win = new BrowserWindow({
        width: WIDGET_WIDTH,
        height: WIDGET_HEIGHT,
        show: false,
        frame: false,
        resizable: false,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: true,
        roundedCorners: true,
        transparent: true,
        backgroundColor: '#00000000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
            preload: host.getPreloadPath(),
            // Chromium 的页面缩放按 session + host 存储：主窗口应用用户缩放
            // （设置里的 scale_factor、Ctrl+{+,-,0}）会连带放大同 session 同 origin
            // 的浮窗，而浮窗外壳尺寸固定，放大后内容溢出出现滚动条。使用独立 session
            // partition 让浮窗的缩放状态与主窗口隔离，恒定保持 100%。
            partition: WIDGET_PARTITION
        }
    });

    win.setAlwaysOnTop(true, 'floating');
    // 注意：不要传 { visibleOnFullScreen: true }，该参数在 macOS 上会让应用从 Dock 消失
    // （见 electron/electron#26350）。仅保持「在所有工作区可见」。
    win.setVisibleOnAllWorkspaces(true);
    win.setMenu(null);

    // 禁止浮窗内的捏合缩放，保证固定外壳内的布局不被破坏。
    win.webContents.setVisualZoomLevelLimits(1, 1);

    win.on('closed', () => {
        widgetWindow = null;
    });

    // 记录用户拖拽后的位置（仅本次会话内保持，不落盘）。程序化 setBounds 的目标位置
    // 会先写入 lastProgrammaticOrigin，moved 事件中通过位置比对区分并跳过。
    win.on('moved', () => {
        const bounds = win.getBounds();
        if (lastProgrammaticOrigin && bounds.x === lastProgrammaticOrigin.x && bounds.y === lastProgrammaticOrigin.y) {
            lastProgrammaticOrigin = null;
            return;
        }
        lastProgrammaticOrigin = null;
        sessionPosition = { x: bounds.x, y: bounds.y };
    });

    host.loadWidgetPage(win);
    widgetWindow = win;
    return win;
}

/** 读取设置中的悬浮窗显示位置，无效值回退右下角。 */
function getFloatingWindowPosition(): FloatingWindowPosition {
    try {
        const guiConfig = Setting.getInstance().getData().gui_config as Record<string, unknown> | undefined;
        const pos = guiConfig?.floating_window_position;
        return pos === 'top-left' || pos === 'top-right' || pos === 'bottom-left' || pos === 'bottom-right'
            ? pos
            : 'bottom-right';
    } catch {
        return 'bottom-right';
    }
}

/** 按设置中的初始角计算窗口左上角坐标（默认右下角，仅启动首显时使用）。 */
function getWidgetOrigin(): { x: number; y: number } {
    const main = host?.getMainWindow();
    const display =
        main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
    const { x, y, width, height } = display.workArea;
    const widgetWidth = isCollapsed ? WIDGET_COLLAPSED_WIDTH : WIDGET_WIDTH;
    const widgetHeight = isCollapsed ? WIDGET_COLLAPSED_HEIGHT : WIDGET_HEIGHT;
    const left = x + WIDGET_MARGIN;
    const top = y + WIDGET_MARGIN;
    const right = Math.round(x + width - WIDGET_MARGIN - widgetWidth);
    const bottom = Math.round(y + height - WIDGET_MARGIN - widgetHeight);
    switch (getFloatingWindowPosition()) {
        case 'top-left':
            return { x: Math.round(left), y: Math.round(top) };
        case 'top-right':
            return { x: right, y: Math.round(top) };
        case 'bottom-left':
            return { x: Math.round(left), y: bottom };
        case 'bottom-right':
        default:
            return { x: right, y: bottom };
    }
}

/**
 * Windows 上透明无边框窗口的已知缺陷（electron/electron#40515）：窗口显示或尺寸
 * 变化时，DirectComposition 合成层偶发丢失 alpha 通道，透明背景退化为不透明底色，
 * 圆角浮窗变成直角矩形且时有时无。在显示与程序化 setBounds 之后重新声明完全透明
 * 的背景色并强制重绘一帧，让合成层恢复 alpha 通道。该问题仅存在于 Windows，其余
 * 平台直接跳过。
 */
function reassertTransparentBackground(win: BrowserWindow): void {
    if (process.platform !== 'win32') {
        return;
    }
    try {
        win.setBackgroundColor('#00000000');
        win.webContents.invalidate();
    } catch (err) {
        logger.warn(`failed to reassert transparent background: ${errorToMessage(err)}`);
    }
}

/** 设置窗口 bounds，并把目标位置记为程序化移动（供 moved 事件区分用户拖拽）。 */
function applyWidgetBounds(win: BrowserWindow, bounds: { x: number; y: number; width: number; height: number }): void {
    lastProgrammaticOrigin = { x: bounds.x, y: bounds.y };
    win.setBounds(bounds);
    // 尺寸变化是透明背景丢失的触发点之一，变完立即修复。
    reassertTransparentBackground(win);
}

function positionWidget(win: BrowserWindow): void {
    const widgetWidth = isCollapsed ? WIDGET_COLLAPSED_WIDTH : WIDGET_WIDTH;
    const widgetHeight = isCollapsed ? WIDGET_COLLAPSED_HEIGHT : WIDGET_HEIGHT;
    // 本次会话内用户拖拽过：保持拖拽位置；否则使用设置中的初始角。
    const origin = sessionPosition ?? getWidgetOrigin();
    applyWidgetBounds(win, {
        x: origin.x,
        y: origin.y,
        width: widgetWidth,
        height: widgetHeight
    });
}

function buildSummary(): TaskStatusWidgetSummary {
    const mergedTasks = snapshot.map((task) => {
        const usageSnapshot = host?.getTaskUsageSnapshot?.(task.task_id);
        if (!usageSnapshot) {
            // 主进程无法提供 usage 快照（host 未实现或任务已不在管理器）时，保留快照中的原值。
            return task;
        }
        const merged = mergeTaskLiveUsage(
            usageSnapshot.usage_summary,
            usageSnapshot.live,
            usageTrackedByTask.get(task.task_id)
        );
        usageTrackedByTask.set(task.task_id, merged.tracked);
        return { ...task, usage: merged.usage };
    });
    return buildTaskStatusSummary(
        mergedTasks,
        waitingTaskIds,
        taskList.length,
        (taskId) => getTaskTodosForDisplay(taskId),
        host?.getFloatingWindowMode()
    );
}

function pushSummary(): void {
    if (!widgetWindow || widgetWindow.isDestroyed()) {
        return;
    }
    safeSendToWebContents(widgetWindow.webContents, 'taskStatusWidget:summaryUpdate', buildSummary());
}

function showWidget(): void {
    if (!host) {
        return;
    }
    const win = ensureWidgetWindow();
    if (!win || win.isDestroyed()) {
        return;
    }
    if (!win.isVisible()) {
        // 首次显示时定位；已显示时保留用户拖拽后的位置，仅刷新内容。
        positionWidget(win);
        pushSummary();
        if (win.webContents.isLoading()) {
            // 首次加载：等页面完成首帧渲染（加载视图）后再显示，避免出现空白窗口闪烁；
            // 异步回调执行前重新校验触发条件，防止期间主窗口回到前台导致误显示。
            win.once('ready-to-show', () => showWidgetInactiveIfStillWanted(win));
            // 兜底：防止 ready-to-show 在监听注册前已触发导致窗口迟迟不显示。
            setTimeout(() => showWidgetInactiveIfStillWanted(win), 2000);
        } else {
            // 被动状态窗不抢占焦点，避免打断用户当前操作。
            win.showInactive();
            // 显示透明窗口是透明背景丢失的另一个触发点，显示后立即修复。
            reassertTransparentBackground(win);
        }
    } else {
        pushSummary();
    }
}

/** 仅在触发条件仍然有效且未被用户抑制时显示浮窗（用于异步展示路径）。 */
function showWidgetInactiveIfStillWanted(win: BrowserWindow): void {
    if (win.isDestroyed() || win.isVisible()) {
        return;
    }
    const mode = host?.getFloatingWindowMode();
    if (isWidgetTriggerEffective(mode, { hidden: isWindowHidden, focused: isWindowFocused }, suppression)) {
        win.showInactive();
        // ready-to-show 异步显示路径与同步显示路径同样需要修复透明背景。
        reassertTransparentBackground(win);
    }
}

function hideWidget(): void {
    if (widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()) {
        const main = host?.getMainWindow();
        // 主窗口可见但不在前台（后台/最小化）时，直接隐藏浮窗会让系统把浮窗释放的
        // 焦点转移给主窗口，从而把它带到前台。临时禁止主窗口接收焦点，让焦点
        // 回退到其他应用，隐藏完再恢复可聚焦（macOS 行为，见验证脚本）。
        const mainInBackground =
            process.platform === 'darwin' && !!main && !main.isDestroyed() && main.isVisible() && !main.isFocused();
        if (mainInBackground) {
            main.setFocusable(false);
        }
        widgetWindow.hide();
        if (mainInBackground) {
            main.setFocusable(true);
        }
    }
}

function activateMainWindow(main: BrowserWindow): void {
    if (main.isMinimized()) {
        main.restore();
    }
    main.show();
    if (process.platform === 'darwin') {
        // macOS 上 window.show() 恢复隐藏窗口后可能不会激活应用，导致 Dock 图标
        // 不高亮、窗口不进入前台；用 app.focus({ steal: true }) 强制激活。
        app.focus({ steal: true });
    }
    main.focus();
}

function restoreMainWindow(): void {
    const main = host?.getMainWindow();
    if (main && !main.isDestroyed()) {
        activateMainWindow(main);
    }
    hideWidget();
}

function openTaskInMainWindow(taskId: string): void {
    const main = host?.getMainWindow();
    if (main && !main.isDestroyed()) {
        activateMainWindow(main);
        if (taskId) {
            // 主窗口从最小化/隐藏恢复是异步的；延迟到恢复后再发送，避免 IPC 在窗口恢复
            // 期间被丢弃，确保 command:openTask 能触发 renderer 打开对应任务详情。
            setTimeout(() => {
                safeSendToWebContents(main.webContents, 'command:openTask', taskId);
            }, 150);
        }
    }
    hideWidget();
}

function getSummary(): TaskStatusWidgetSummary {
    return buildSummary();
}

function setWidgetCollapsed(collapsed: boolean): void {
    if (isCollapsed === collapsed) {
        return;
    }
    isCollapsed = collapsed;
    if (!widgetWindow || widgetWindow.isDestroyed()) {
        return;
    }
    const bounds = widgetWindow.getBounds();
    // 按显示位置锚定：展开/收起保持对应的角不变。
    const widgetWidth = collapsed ? WIDGET_COLLAPSED_WIDTH : WIDGET_WIDTH;
    const widgetHeight = collapsed ? WIDGET_COLLAPSED_HEIGHT : WIDGET_HEIGHT;
    let x = bounds.x;
    let y = bounds.y;
    switch (getFloatingWindowPosition()) {
        case 'top-left':
            // 左上角锚定：展开向右下扩展，收起向左上收拢。
            break;
        case 'top-right':
            // 右上角锚定：展开向左下扩展，收起向右上收拢。
            x = bounds.x + bounds.width - widgetWidth;
            break;
        case 'bottom-left':
            // 左下角锚定：展开向右上扩展，收起向左下收拢。
            y = bounds.y + bounds.height - widgetHeight;
            break;
        case 'bottom-right':
        default:
            // 右下角锚定：展开向左上扩展，收起向右下收拢。
            x = bounds.x + bounds.width - widgetWidth;
            y = bounds.y + bounds.height - widgetHeight;
            break;
    }
    applyWidgetBounds(widgetWindow, {
        x,
        y,
        width: widgetWidth,
        height: widgetHeight
    });
}

function handleTaskListChanged(list: TaskStatusListEntry[]): void {
    taskList = list ?? [];
    // 兜底清理：任务结束/移除后，renderer 侧 prompt 组件可能已销毁而无法发送
    // waiting=false 事件，导致 waitingTaskIds 残留、浮窗一直显示「需要操作」。
    // 每次任务列表更新时按活跃任务集合对齐一次，并刷新已显示浮窗中的提示。
    const staleWaiting = pruneStaleWaitingTaskIds(waitingTaskIds, taskList);
    if (staleWaiting.length !== waitingTaskIds.size) {
        waitingTaskIds.clear();
        for (const taskId of staleWaiting) {
            waitingTaskIds.add(taskId);
        }
        pushSummary();
    }
    reevaluate();
}

function handleSettingChanged(): void {
    const mode = host?.getFloatingWindowMode();
    if (mode !== lastMode) {
        // 模式变化：重置打开周期标记，让 reevaluate 按新模式重新初始化形态。
        lastMode = mode;
        lastTriggerActive = false;
    }
    // 注意：显示位置（floating_window_position）只决定每次启动时首次显示的初始角，
    // 会话内用户拖拽后应保持拖拽位置，因此这里不响应位置变更。
    reevaluate();
}

/**
 * 初始化任务状态浮窗：注册任务列表订阅与 IPC handler。
 * 需在 GlobalState.initialize() 之后调用，确保订阅能收到任务列表。
 */
export function initTaskStatusWidget(nextHost: TaskStatusWidgetHost): void {
    if (initialized) {
        return;
    }
    initialized = true;
    host = nextHost;
    lastMode = host.getFloatingWindowMode();
    Setting.afterSetDataCallbacks.push(handleSettingChanged);

    const subscriber = new (class extends BaseTaskManagerUpdateSubscriber {
        send(list: object[]): void {
            handleTaskListChanged(list as TaskStatusListEntry[]);
        }
    })();
    host.addTaskListSubscriber(subscriber);

    ipcMain.handle('taskStatusWidget:getSummary', () => getSummary());
    ipcMain.handle('taskStatusWidget:restoreMainWindow', () => {
        restoreMainWindow();
    });
    ipcMain.handle('taskStatusWidget:setCollapsed', (_event, collapsed: unknown) => {
        setWidgetCollapsed(collapsed === true);
    });
    ipcMain.handle('taskStatusWidget:openTask', (_event, taskId: unknown) => {
        openTaskInMainWindow(typeof taskId === 'string' ? taskId : '');
    });
    // 关闭菜单 · 关闭一次：本次触发周期内不再显示（主窗口回到前台后恢复）。
    ipcMain.handle('taskStatusWidget:hide', () => {
        suppression.dismissed = true;
        hideWidget();
    });
    // 关闭菜单 · 下次启动恢复：本次会话内不再显示（随应用退出重置）。
    ipcMain.handle('taskStatusWidget:disableSession', () => {
        suppression.sessionDisabled = true;
        suppression.dismissed = false;
        snapshot = [];
        syncTaskUpdateSubscriptions();
        hideWidget();
    });
    // 关闭菜单 · 永久：恢复主窗口并打开系统设置，高亮悬浮窗模式下拉框引导用户关闭。
    ipcMain.handle('taskStatusWidget:closePermanently', () => {
        const main = host?.getMainWindow();
        if (main && !main.isDestroyed()) {
            activateMainWindow(main);
            // 主窗口从最小化/隐藏恢复是异步的；延迟到恢复后再发送，避免 IPC 在窗口恢复
            // 期间被丢弃。
            setTimeout(() => {
                safeSendToWebContents(main.webContents, 'command:openSettingEditor', {
                    highlightFloatingWindowMode: true
                });
            }, 150);
        }
        hideWidget();
    });
    ipcMain.on('taskStatusWidget:notifyWaiting', (_event, taskId: unknown, waiting: unknown) => {
        notifyTaskWaitingForInput(typeof taskId === 'string' ? taskId : '', waiting === true);
    });

    // 用当前任务列表初始化状态（避免依赖首次 publish 时机）。
    handleTaskListChanged(host.getTaskList());
}

/**
 * 更新主窗口「最小化/隐藏」状态。可在 initTaskStatusWidget 之前调用（仅记录状态）。
 */
export function setMainWindowHidden(hidden: boolean): void {
    isWindowHidden = hidden;
    if (initialized) {
        reevaluate();
    }
}

/**
 * 更新主窗口「前台/失焦」状态。可在 initTaskStatusWidget 之前调用（仅记录状态）。
 */
export function setMainWindowFocused(focused: boolean): void {
    isWindowFocused = focused;
    if (initialized) {
        reevaluate();
    }
}

/**
 * 更新某任务的「等待用户输入」状态，并刷新已显示浮窗中的「需要操作」提示。
 */
export function notifyTaskWaitingForInput(taskId: string, waiting: boolean): void {
    if (!taskId) {
        return;
    }
    if (waiting) {
        waitingTaskIds.add(taskId);
    } else {
        waitingTaskIds.delete(taskId);
    }
    if (initialized) {
        pushSummary();
    }
}
