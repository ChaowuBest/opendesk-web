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
 * Linux 主窗口内容边缘 resize 的拖动会话管理。
 *
 * 阴影边距环内的 renderer 感应条（titlebar.css 的 .od-shadow-resize-handle）
 * 贴着内容边缘，让 resize 光标出现在用户看到的窗口边上（原生 FramelessView
 * 手柄固定在窗口矩形外沿，见 shadow-resize.ts 的注释）。
 *
 * 会话有两种驱动来源（driver），与 window-drag.ts 同构：
 * - cursor（鼠标）：主进程轮询 screen.getCursorScreenPoint()——鼠标可能被拖出
 *   窗口（边距仅 20px），renderer 无法保证持续收到 mousemove/mouseup；
 * - pointer（触摸屏/手写笔）：这类输入不更新系统光标，轮询取到的始终是陈旧坐标
 *   （位移恒为 0，触摸完全无法 resize），改由 renderer 在 pointermove 中上报
 *   pointer 的窗口内坐标，经 updateShadowResizeSession 驱动。窗口内坐标随窗口
 *   自身移动而变，换算需带上已应用位移（computePointerFeedDelta）；主进程按帧
 *   合并更新，避免快速拖动时事件排队造成过冲后卡住。
 *
 * pointer capture 负责正常路径的 pointerup，失焦/销毁/超时兜底结束会话。
 * bounds 换算纯函数见 linux-window-shadow.ts。
 *
 * renderer 上报的窗口内坐标是 CSS 像素（主窗口按缩放偏好设置了
 * webContents.setZoomFactor），会话入口统一换算成 DIP 后再参与 bounds 计算，
 * 否则缩放偏好下 resize 位移会按 zoom 比例失真（见 clientCssToDip）。
 */

import { BrowserWindow, screen } from 'electron';
import {
    clientCssToDip,
    computePointerFeedDelta,
    computeShadowResizeBounds,
    type Point,
    type ShadowResizeDirection,
    type WindowBounds
} from './linux-window-shadow.js';

const RESIZE_POLL_INTERVAL_MS = 16;
/** 安全网：异常情况下（如 pointerup 丢失）避免会话永久挂起。 */
const RESIZE_SESSION_MAX_MS = 30_000;

/** resize 会话的驱动来源，见模块注释。 */
export type ShadowResizeDriver = 'cursor' | 'pointer';

interface ShadowResizeSession {
    win: BrowserWindow;
    driver: ShadowResizeDriver;
    direction: ShadowResizeDirection;
    startBounds: WindowBounds;
    /** cursor 驱动：会话起始光标屏幕坐标 */
    startPoint: Point;
    /** pointer 驱动：按下点（renderer 窗口内坐标，已换算为 DIP） */
    startClient: Point;
    minWidth: number;
    minHeight: number;
    /** pointer 驱动不轮询 */
    pollTimer: NodeJS.Timeout | null;
    deadlineTimer: NodeJS.Timeout;
    blurHandler: () => void;
    closedHandler: () => void;
}

let activeSession: ShadowResizeSession | null = null;

export function isShadowResizeSessionActive(): boolean {
    return activeSession !== null;
}

/**
 * 开始一次内容边缘拖动 resize。重复调用会先结束上一个会话（renderer 感应条
 * 保证同一时刻只有一个条在拖动，这里防御异常路径）。
 */
export function startShadowResizeSession(
    win: BrowserWindow,
    direction: ShadowResizeDirection,
    minWidth: number,
    minHeight: number,
    driver: ShadowResizeDriver = 'cursor',
    startClient?: Point
): void {
    endShadowResizeSession();
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) {
        return;
    }
    // 没有按下点窗口内坐标就无法换算位移，退回光标轮询路径
    const pointerDriven = driver === 'pointer' && !!startClient;
    const startBounds = win.getBounds();
    // 按下点是 renderer 上报的 CSS 像素坐标，换算成 DIP 后才能与 bounds 同系计算
    const client = startClient ? clientCssToDip(startClient, win.webContents.getZoomFactor()) : { x: 0, y: 0 };
    const startPoint = pointerDriven ? client : screen.getCursorScreenPoint();

    const pollTimer = pointerDriven
        ? null
        : setInterval(() => {
              if (win.isDestroyed()) {
                  endShadowResizeSession();
                  return;
              }
              const cursor = screen.getCursorScreenPoint();
              win.setBounds(
                  computeShadowResizeBounds({
                      startBounds,
                      direction,
                      dx: cursor.x - startPoint.x,
                      dy: cursor.y - startPoint.y,
                      minWidth,
                      minHeight
                  })
              );
          }, RESIZE_POLL_INTERVAL_MS);

    const blurHandler = () => endShadowResizeSession();
    const closedHandler = () => endShadowResizeSession();
    win.on('blur', blurHandler);
    win.once('closed', closedHandler);

    const deadlineTimer = setTimeout(() => endShadowResizeSession(), RESIZE_SESSION_MAX_MS);

    activeSession = {
        win,
        driver: pointerDriven ? 'pointer' : 'cursor',
        direction,
        startBounds,
        startPoint,
        startClient: client,
        minWidth,
        minHeight,
        pollTimer,
        deadlineTimer,
        blurHandler,
        closedHandler
    };
}

/** pointer 驱动：待应用的最新窗口内坐标与按帧合并定时器 */
let pendingClient: Point | null = null;
let coalesceTimer: NodeJS.Timeout | null = null;

function applyPendingClient(): void {
    coalesceTimer = null;
    const client = pendingClient;
    pendingClient = null;
    const session = activeSession;
    if (!session || session.driver !== 'pointer' || !client || session.win.isDestroyed()) {
        return;
    }
    const { dx, dy } = computePointerFeedDelta({
        startBounds: session.startBounds,
        appliedBounds: session.win.getBounds(),
        startClient: session.startClient,
        client
    });
    session.win.setBounds(
        computeShadowResizeBounds({
            startBounds: session.startBounds,
            direction: session.direction,
            dx,
            dy,
            minWidth: session.minWidth,
            minHeight: session.minHeight
        })
    );
}

/**
 * pointer 驱动会话的坐标更新（renderer pointermove 上报的窗口内坐标，CSS 像素）。
 * 无会话或会话为光标驱动时忽略——鼠标路径由主进程轮询驱动。
 *
 * 按帧合并：触摸屏 pointermove 可达 240Hz，逐条换算会反复读到「已应用位移超前于
 * 事件采样时刻」的 bounds 并把误差叠加进位移（快速拖动时表现为乱跳后卡住），
 * 因此同一帧内只应用最后一个坐标。
 */
export function updateShadowResizeSession(client: Point): void {
    if (!activeSession || activeSession.driver !== 'pointer') {
        return;
    }
    // 上报的窗口内坐标是 CSS 像素，与按下点同系换算为 DIP 后再参与位移计算
    pendingClient = clientCssToDip(client, activeSession.win.webContents.getZoomFactor());
    if (coalesceTimer) {
        return;
    }
    applyPendingClient();
    coalesceTimer = setTimeout(applyPendingClient, RESIZE_POLL_INTERVAL_MS);
}

export function endShadowResizeSession(): void {
    if (coalesceTimer) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
    }
    pendingClient = null;
    if (!activeSession) {
        return;
    }
    if (activeSession.pollTimer) {
        clearInterval(activeSession.pollTimer);
    }
    clearTimeout(activeSession.deadlineTimer);
    if (!activeSession.win.isDestroyed()) {
        activeSession.win.removeListener('blur', activeSession.blurHandler);
        activeSession.win.removeListener('closed', activeSession.closedHandler);
    }
    activeSession = null;
}
