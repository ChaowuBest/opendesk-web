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
import { safeSendToWebContents } from '../utils/electron-ipc.js';
import {
    buildTaskStatusSummary,
    computeTriggerActive,
    updateTaskSnapshot,
    type FloatingWindowMode,
    type TaskStatusListEntry,
    type TaskStatusWidgetSummary,
    type TaskStatusWidgetTask
} from './task-status-widget.js';
import { getTaskTodosForDisplay } from '../aikernel/todos/task-todos.js';
import { Setting } from '../utils/setting.js';

/**
 * 任务状态浮窗（主进程侧窗口管理）。
 *
 * 依据设置的显示模式（pill=单行胶囊 / card=完整卡片 / 未设置=关闭）与当前是否
 * 存在活跃任务，在屏幕右上角创建常驻最前的无边框小窗展示活跃任务；浮窗开启期间
 * 任务结束后保留为完成状态，直到主窗口恢复前台才关闭。pill 模式默认胶囊、获得焦点
 * 展开、失焦收回；card 模式默认完整卡片，仅手动收起。
 */

const WIDGET_WIDTH = 340;
const WIDGET_HEIGHT = 300;
const WIDGET_COLLAPSED_WIDTH = 240;
const WIDGET_COLLAPSED_HEIGHT = 44;
const WIDGET_MARGIN = 28;

export interface TaskStatusWidgetHost {
    getPreloadPath(): string;
    getMainWindow(): BrowserWindow | null;
    getTaskList(): TaskStatusListEntry[];
    addTaskListSubscriber(subscriber: BaseTaskManagerUpdateSubscriber): string;
    loadWidgetPage(win: BrowserWindow): void;
    getFloatingWindowMode(): FloatingWindowMode;
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

function reevaluate(): void {
    if (!host) {
        return;
    }
    const mode = host.getFloatingWindowMode();
    const triggerActive = computeTriggerActive(mode, {
        hidden: isWindowHidden,
        focused: isWindowFocused
    });

    if (!triggerActive) {
        // 触发条件失效：清空本次打开周期内的快照。
        lastTriggerActive = false;
        snapshot = [];
        hideWidget();
        return;
    }

    if (!lastTriggerActive) {
        // 新的打开周期：按模式初始化形态（pill 默认胶囊，card 默认完整卡片）。
        lastTriggerActive = true;
        setWidgetCollapsed(mode === 'pill');
    }

    snapshot = updateTaskSnapshot(snapshot, taskList);
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
            preload: host.getPreloadPath()
        }
    });

    win.setAlwaysOnTop(true, 'floating');
    // 注意：不要传 { visibleOnFullScreen: true }，该参数在 macOS 上会让应用从 Dock 消失
    // （见 electron/electron#26350）。仅保持「在所有工作区可见」。
    win.setVisibleOnAllWorkspaces(true);
    win.setMenu(null);

    win.on('closed', () => {
        widgetWindow = null;
    });

    host.loadWidgetPage(win);
    widgetWindow = win;
    return win;
}

function positionWidget(win: BrowserWindow): void {
    const main = host?.getMainWindow();
    const display =
        main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
    const { x, y, width } = display.workArea;
    // 右上角锚定：胶囊与完整面板的右上角保持一致。
    const rightEdge = x + width - WIDGET_MARGIN;
    const top = y + WIDGET_MARGIN;
    const widgetWidth = isCollapsed ? WIDGET_COLLAPSED_WIDTH : WIDGET_WIDTH;
    const widgetHeight = isCollapsed ? WIDGET_COLLAPSED_HEIGHT : WIDGET_HEIGHT;
    win.setBounds({
        x: Math.round(rightEdge - widgetWidth),
        y: Math.round(top),
        width: widgetWidth,
        height: widgetHeight
    });
}

function buildSummary(): TaskStatusWidgetSummary {
    return buildTaskStatusSummary(
        snapshot,
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
        // 被动状态窗不抢占焦点，避免打断用户当前操作。
        win.showInactive();
    } else {
        pushSummary();
    }
}

function hideWidget(): void {
    if (widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()) {
        widgetWindow.hide();
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
    // 右上角锚定：展开向左下扩展，收起向右上收拢。
    const rightEdge = bounds.x + bounds.width;
    const top = bounds.y;
    const widgetWidth = collapsed ? WIDGET_COLLAPSED_WIDTH : WIDGET_WIDTH;
    const widgetHeight = collapsed ? WIDGET_COLLAPSED_HEIGHT : WIDGET_HEIGHT;
    widgetWindow.setBounds({
        x: rightEdge - widgetWidth,
        y: top,
        width: widgetWidth,
        height: widgetHeight
    });
}

function handleTaskListChanged(list: TaskStatusListEntry[]): void {
    taskList = list ?? [];
    reevaluate();
}

function handleSettingChanged(): void {
    const mode = host?.getFloatingWindowMode();
    if (mode !== lastMode) {
        // 模式变化：重置打开周期标记，让 reevaluate 按新模式重新初始化形态。
        lastMode = mode;
        lastTriggerActive = false;
    }
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
