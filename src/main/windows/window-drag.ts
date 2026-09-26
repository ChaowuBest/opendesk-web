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
 * Linux 主窗口顶部拖拽层的手动拖动会话管理。
 *
 * 背景：`-webkit-app-region: drag` 区域在 Linux(X11)/GTK 下被当作自绘标题栏，
 * 右键会弹 WM 系统窗口菜单（弹位错误 + grab 输入，点击无效且无法关闭）。
 * 因此 Linux 主窗口拖拽层改为 no-drag（见 titlebar.css 的
 * `html.window-rounded .drag-overlay` 覆盖），拖动由本模块以手动会话完成；
 * Windows/macOS 仍走原生 drag region，行为不变。
 *
 * 与 shadow-resize.ts 同构：renderer 的 pointer 事件只负责发起/结束信号，
 * 本模块轮询 screen.getCursorScreenPoint() 驱动整窗移动（鼠标可能拖出窗口，
 * renderer 无法持续收到 mousemove；pointer capture 负责正常路径的 pointerup，
 * blur/closed/超时兜底结束会话）。bounds 换算见 linux-window-shadow.ts。
 */

import { BrowserWindow, screen } from 'electron';
import { computeDragBounds, type WindowBounds } from './linux-window-shadow.js';

const DRAG_POLL_INTERVAL_MS = 16;
/** 安全网：异常情况下（如 pointerup 丢失）避免会话永久挂起。 */
const DRAG_SESSION_MAX_MS = 30_000;
/**
 * X11 下 unmaximize 由 WM 异步处理（状态先变、bounds 下一轮才刷新），必须等
 * WM 恢复完成后再按 grab 点定位，否则会被 WM 的恢复覆盖（窗口跳回原位），
 * 或用未刷新的最大化 bounds 写回窗口（还原后尺寸错误、污染 WM 的 normal
 * bounds，导致后续双击还原到错误尺寸）。
 */
const UNMAXIMIZE_SETTLE_MS = 60;

interface WindowDragSession {
    win: BrowserWindow;
    pollTimer: NodeJS.Timeout;
    deadlineTimer: NodeJS.Timeout;
    blurHandler: () => void;
    closedHandler: () => void;
}

/** 鼠标按下点在窗口内的坐标（renderer 的 event.clientX/Y，Electron 视口原点即窗口原点）。 */
export interface WindowDragGrabPoint {
    x: number;
    y: number;
}

let activeSession: WindowDragSession | null = null;
/** 最大化还原路径中等待 WM 恢复的定位定时器（会话启动前可在 end 时取消）。 */
let pendingMaximizeDragTimer: NodeJS.Timeout | null = null;

/**
 * 开始一次顶部拖拽层拖动。重复调用会先结束上一个会话（拖拽层同一时刻只会
 * 有一个 pointer 会话，这里防御异常路径）。
 *
 * 最大化状态下的拖动会先还原到最大化之前的尺寸（getNormalBounds）并跳到指针
 * 下方（保持按下点相对窗口位置不变），复刻 WM 原生"最大化窗口按住标题栏拖动
 * 即还原跟随"的语义。
 */
export function startWindowDragSession(win: BrowserWindow, grabPoint?: WindowDragGrabPoint): void {
    endWindowDragSession();
    if (win.isDestroyed() || win.isFullScreen()) {
        return;
    }
    const cursor = screen.getCursorScreenPoint();

    if (win.isMaximized()) {
        // 取最大化之前的 bounds 后再 unmaximize（getNormalBounds 不受最大化影响）
        const normal = win.getNormalBounds();
        win.unmaximize();
        // 等 WM 恢复完成（UNMAXIMIZE_SETTLE_MS）再按 grab 点定位并进入拖动会话；
        // 期间 renderer 若已松手（end），会取消本定时器，窗口保持 WM 的还原位置
        pendingMaximizeDragTimer = setTimeout(() => {
            pendingMaximizeDragTimer = null;
            if (win.isDestroyed()) {
                return;
            }
            const target: WindowBounds = {
                x: grabPoint ? cursor.x - grabPoint.x : normal.x,
                y: grabPoint ? cursor.y - grabPoint.y : normal.y,
                width: normal.width,
                height: normal.height
            };
            win.setBounds(target);
            beginDragSession(win, win.getBounds(), screen.getCursorScreenPoint());
        }, UNMAXIMIZE_SETTLE_MS);
        return;
    }

    let startBounds = win.getBounds();
    if (grabPoint) {
        // 按下点以窗口内坐标给出（视口原点 = 窗口原点）：新位置让该点保持在
        // 当前指针下，即窗口不因按下而跳动（换算正确时新位置 = 原位置）
        startBounds = {
            x: cursor.x - grabPoint.x,
            y: cursor.y - grabPoint.y,
            width: startBounds.width,
            height: startBounds.height
        };
        win.setBounds(startBounds);
    }
    beginDragSession(win, startBounds, screen.getCursorScreenPoint());
}

function beginDragSession(win: BrowserWindow, startBounds: WindowBounds, startPoint: { x: number; y: number }): void {
    const pollTimer = setInterval(() => {
        if (win.isDestroyed()) {
            endWindowDragSession();
            return;
        }
        const cursorNow = screen.getCursorScreenPoint();
        win.setBounds(
            computeDragBounds({
                startBounds,
                dx: cursorNow.x - startPoint.x,
                dy: cursorNow.y - startPoint.y
            })
        );
    }, DRAG_POLL_INTERVAL_MS);

    const blurHandler = () => endWindowDragSession();
    const closedHandler = () => endWindowDragSession();
    win.on('blur', blurHandler);
    win.once('closed', closedHandler);

    const deadlineTimer = setTimeout(() => endWindowDragSession(), DRAG_SESSION_MAX_MS);

    activeSession = { win, pollTimer, deadlineTimer, blurHandler, closedHandler };
}

export function endWindowDragSession(): void {
    if (pendingMaximizeDragTimer) {
        clearTimeout(pendingMaximizeDragTimer);
        pendingMaximizeDragTimer = null;
    }
    if (!activeSession) {
        return;
    }
    clearInterval(activeSession.pollTimer);
    clearTimeout(activeSession.deadlineTimer);
    if (!activeSession.win.isDestroyed()) {
        activeSession.win.removeListener('blur', activeSession.blurHandler);
        activeSession.win.removeListener('closed', activeSession.closedHandler);
    }
    activeSession = null;
}
