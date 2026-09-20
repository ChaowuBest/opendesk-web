/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT ANY KIND OF WARRANTY,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * Linux 主窗口内容边缘 resize 的拖动会话管理。
 *
 * 阴影边距环内的 renderer 感应条（titlebar.css 的 .od-shadow-resize-handle）
 * 贴着内容边缘，让 resize 光标出现在用户看到的窗口边上（Chromium FramelessView
 * 的原生手柄固定在含阴影边距的窗口矩形外沿，不可配置）。拖动会话由主进程轮询
 * screen.getCursorScreenPoint() 驱动——鼠标可能被拖出窗口（边距仅 20px），
 * renderer 无法保证持续收到 mousemove/mouseup；pointer capture 负责正常路径的
 * mouseup，失焦/销毁/超时兜底结束会话。
 *
 * bounds 换算纯函数见 linux-window-shadow.ts。
 */

import { BrowserWindow, screen } from 'electron';
import { computeShadowResizeBounds, type ShadowResizeDirection } from './linux-window-shadow.js';

const RESIZE_POLL_INTERVAL_MS = 16;
/** 安全网：异常情况下（如 pointerup 丢失）避免会话永久挂起。 */
const RESIZE_SESSION_MAX_MS = 30_000;

interface ShadowResizeSession {
    win: BrowserWindow;
    pollTimer: NodeJS.Timeout;
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
    minHeight: number
): void {
    endShadowResizeSession();
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) {
        return;
    }

    const startBounds = win.getBounds();
    const startPoint = screen.getCursorScreenPoint();

    const pollTimer = setInterval(() => {
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

    activeSession = { win, pollTimer, deadlineTimer, blurHandler, closedHandler };
}

export function endShadowResizeSession(): void {
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
