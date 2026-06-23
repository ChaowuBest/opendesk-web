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
