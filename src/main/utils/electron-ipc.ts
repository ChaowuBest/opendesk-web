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

import type { WebContents, WebFrameMain } from 'electron';
import { logger } from './logger.js';
import { electron } from '../../utils/electron.js';

function getErrorMessage(err: unknown): string {
    return (err as Error)?.message || String(err);
}

function isSendTargetAvailable(target: { isDestroyed(): boolean } | null | undefined): boolean {
    if (!target) return false;
    if (typeof target.isDestroyed !== 'function') return true;
    try {
        return !target.isDestroyed();
    } catch {
        return false;
    }
}

export function safeSendToWebContents(
    webContents: WebContents | null | undefined,
    channel: string,
    ...args: unknown[]
): boolean {
    if (!isSendTargetAvailable(webContents)) return false;

    try {
        webContents.send(channel, ...args);
        return true;
    } catch (err) {
        logger.warn(`failed to send IPC "${channel}" to webContents: ${getErrorMessage(err)}`);
        return false;
    }
}

export function safeSendToWebFrame(
    webFrame: WebFrameMain | null | undefined,
    channel: string,
    ...args: unknown[]
): boolean {
    if (!isSendTargetAvailable(webFrame)) return false;

    try {
        webFrame.send(channel, ...args);
        return true;
    } catch (err) {
        logger.warn(`failed to send IPC "${channel}" to webFrame: ${getErrorMessage(err)}`);
        return false;
    }
}

/**
 * 向所有未销毁的 BrowserWindow 广播 IPC 消息。
 *
 * 交互类面板（askUser / exitPlanMode）采用事件广播模式：请求发送到所有窗口，
 * 由挂载了对应组件的窗口（主窗口）响应；requestId 匹配保证多窗口响应幂等。
 * 不依赖 getAllWindows() 的顺序假设--常驻子窗口（如任务状态浮窗）可能排在主窗口之前。
 *
 * @returns 是否至少送达了一个窗口
 */
export function broadcastToAllWindows(channel: string, ...args: unknown[]): boolean {
    let windows: Array<{ webContents: WebContents | null; isDestroyed(): boolean }>;
    try {
        windows = electron().BrowserWindow.getAllWindows();
    } catch (err) {
        logger.warn(`failed to list windows for IPC broadcast "${channel}": ${getErrorMessage(err)}`);
        return false;
    }

    let delivered = false;
    for (const win of windows) {
        if (win.isDestroyed()) continue;
        if (safeSendToWebContents(win.webContents, channel, ...args)) {
            delivered = true;
        }
    }
    return delivered;
}
