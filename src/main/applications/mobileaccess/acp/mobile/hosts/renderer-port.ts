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

import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron';
import type { DesktopEventSender, DesktopRendererPort } from '../../../remote-access/webrtc-transport.js';

export function createElectronRendererPort(
    ipcMain: IpcMain,
    window: BrowserWindow | null
): (DesktopRendererPort & { dispose(): void }) | null {
    if (!window || window.isDestroyed()) return null;
    const contents = window.webContents;
    const hostInstanceId = crypto.randomUUID();
    let generation = 1;
    let disposed = false;
    const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
    const listeners = new Set<(sender: DesktopEventSender, payload: Record<string, unknown>) => void>();
    const invalidate = () => {
        generation++;
        rejectPending();
    };
    const rejectPending = () => {
        for (const entry of pending.values()) entry.reject(new Error('remote network renderer is gone'));
        pending.clear();
    };
    const onNavigate = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
        generation++;
        if (event.isMainFrame && !event.isSameDocument) rejectPending();
    };
    const mainFrame = () => {
        try {
            return disposed || contents.isDestroyed() ? null : contents.mainFrame;
        } catch {
            return null;
        }
    };
    const fromMainFrame = (event: IpcMainEvent) => {
        const frame = mainFrame();
        const sender = event.senderFrame;
        return (
            frame &&
            sender &&
            event.sender === contents &&
            sender.processId === frame.processId &&
            sender.routingId === frame.routingId
        );
    };
    const onResult = (
        event: IpcMainEvent,
        payload: { requestId?: string; ok?: boolean; result?: unknown; error?: string }
    ) => {
        if (!fromMainFrame(event) || typeof payload?.requestId !== 'string') return;
        const entry = pending.get(payload.requestId);
        if (!entry) return;
        pending.delete(payload.requestId);
        if (payload.ok) entry.resolve(payload.result);
        else
            entry.reject(
                new Error(typeof payload.error === 'string' ? payload.error : 'remote network renderer error')
            );
    };
    const onEvent = (event: IpcMainEvent, payload: Record<string, unknown>) => {
        if (!fromMainFrame(event) || !payload || typeof payload !== 'object') return;
        const sender = { webContentsId: contents.id, frameRoutingId: contents.mainFrame.routingId };
        for (const listener of listeners) listener(sender, payload);
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        invalidate();
        listeners.clear();
        ipcMain.off('remote-network:result', onResult);
        ipcMain.off('remote-network:event', onEvent);
        contents.off('did-start-navigation', onNavigate);
        contents.off('destroyed', dispose);
        contents.off('render-process-gone', invalidate);
    };
    contents.on('did-start-navigation', onNavigate);
    contents.once('destroyed', dispose);
    contents.on('render-process-gone', invalidate);
    ipcMain.on('remote-network:result', onResult);
    ipcMain.on('remote-network:event', onEvent);
    return {
        webContentsId: contents.id,
        get owner() {
            return { hostInstanceId, generation };
        },
        mainFrameRoutingId: () => mainFrame()?.routingId ?? null,
        invoke(method, payload) {
            if (disposed || contents.isDestroyed()) return Promise.reject(new Error('remote network renderer is gone'));
            const requestId = crypto.randomUUID();
            return new Promise<unknown>((resolve, reject) => {
                pending.set(requestId, { resolve, reject });
                try {
                    contents.send('remote-network:invoke', { requestId, method, payload });
                } catch (error) {
                    pending.delete(requestId);
                    reject(error);
                }
            });
        },
        onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        dispose
    };
}
