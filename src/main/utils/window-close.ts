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

import type { IpcMain, IpcMainEvent, WebContents } from 'electron';

/** 主窗口关闭处理器所依赖的窗口能力子集，便于单元测试注入 mock。 */
export interface MainWindowLike {
    webContents: WebContents | null;
    isDestroyed(): boolean;
    isMinimized(): boolean;
    isVisible(): boolean;
    getNormalBounds(): { x: number; y: number; width: number; height: number };
    restore(): void;
    show(): void;
    hide(): void;
    moveTop(): void;
    focus(): void;
}

export interface MainWindowCloseHandlerDeps {
    /** 应用是否正在退出（before-quit 等场景置 true，此时允许真正关闭窗口） */
    isAppQuitting: () => boolean;
    window: MainWindowLike;
    getSettingData: () => Record<string, unknown>;
    saveSettingData: (data: Record<string, unknown>) => void;
    ipcMain: Pick<IpcMain, 'on' | 'removeListener'>;
    quit: () => void;
    sendToRenderer: (channel: string, ...args: unknown[]) => boolean;
    /** 生成请求 id 的时间源，测试可注入固定值 */
    now?: () => number;
    /**
     * 保存前把窗口 bounds 换算为视觉 bounds。Linux 自绘阴影主窗口的 BrowserWindow
     * 矩形比用户看到的内容矩形四周大一圈（阴影边距），window_bounds 需保持视觉矩形
     * 语义；缺省按原样保存。
     */
    normalizeSaveBounds?: (bounds: { x: number; y: number; width: number; height: number }) => {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}

export const CLOSE_DIALOG_REQUEST_CHANNEL = 'closeWindow:request';
export const CLOSE_DIALOG_RESPONSE_CHANNEL = 'closeWindow:response';

/**
 * 把主窗口带到前台。
 *
 * 关闭确认弹窗是应用内模态：若窗口处于最小化/隐藏/后台状态（例如用户在任务栏
 * 右键关闭窗口、或窗口被其他应用遮挡），弹窗会在用户看不到的地方弹出，用户会
 * 误以为应用卡死。因此在展示弹窗前必须先恢复并聚焦主窗口。
 */
export function bringMainWindowToForeground(window: MainWindowLike): void {
    if (window.isMinimized()) {
        window.restore();
    }
    if (!window.isVisible()) {
        window.show();
    }
    window.moveTop();
    window.focus();
}

/**
 * 生成主窗口 close 事件处理器：
 *
 * - 应用退出中：保存窗口 normal bounds 后放行关闭；
 * - 配置为退出：直接退出；
 * - 配置为最小化：隐藏窗口；
 * - 配置未设置：把主窗口带到前台后，请求 renderer 展示「退出/最小化」确认弹窗，
 *   并等待用户通过 closeWindow:response 回传结果。
 */
export function createMainWindowCloseHandler(
    deps: MainWindowCloseHandlerDeps
): (event: { preventDefault(): void }) => void {
    let isCloseDialogShowing = false;

    return (event) => {
        if (deps.isAppQuitting()) {
            // 应用退出时保存窗口 normal bounds，下次启动恢复；Linux 阴影窗口需先
            // 收缩为视觉矩形（见 normalizeSaveBounds 注释）
            try {
                const rawBounds = deps.window.getNormalBounds();
                const bounds = deps.normalizeSaveBounds ? deps.normalizeSaveBounds(rawBounds) : rawBounds;
                const data = deps.getSettingData();
                const guiConfig = (data.gui_config ?? {}) as Record<string, unknown>;
                guiConfig.window_bounds = {
                    x: bounds.x,
                    y: bounds.y,
                    width: bounds.width,
                    height: bounds.height
                };
                deps.saveSettingData(data);
            } catch {
                /* best-effort */
            }
            return;
        }

        event.preventDefault();

        const data = deps.getSettingData();
        const guiConfig = (data.gui_config ?? {}) as Record<string, unknown>;
        const closeAction = guiConfig.on_mainwindow_close as string | undefined;

        if (closeAction === 'quit') {
            deps.quit();
        } else if (closeAction === 'minimize') {
            deps.window.hide();
        } else {
            // undefined — 询问用户退出还是最小化
            if (isCloseDialogShowing) return;
            isCloseDialogShowing = true;
            const requestId = `close-${(deps.now ?? Date.now)()}`;
            const handler = (_e: IpcMainEvent, respRequestId: unknown, response: unknown) => {
                if (respRequestId !== requestId) return;
                deps.ipcMain.removeListener(CLOSE_DIALOG_RESPONSE_CHANNEL, handler);
                const result = response as { action: string; dontAsk: boolean };
                if (result.action === 'cancel') {
                    isCloseDialogShowing = false;
                    return;
                }
                if (result.dontAsk) {
                    guiConfig.on_mainwindow_close = result.action === 'quit' ? 'quit' : 'minimize';
                    deps.saveSettingData(data);
                }
                if (result.action === 'quit') {
                    deps.quit();
                } else {
                    deps.window.hide();
                }
                isCloseDialogShowing = false;
            };
            deps.ipcMain.on(CLOSE_DIALOG_RESPONSE_CHANNEL, handler);
            // 弹窗在应用内部展示：窗口处于后台/最小化/隐藏时先把它带到前台
            bringMainWindowToForeground(deps.window);
            deps.sendToRenderer(CLOSE_DIALOG_REQUEST_CHANNEL, requestId);
        }
    };
}
