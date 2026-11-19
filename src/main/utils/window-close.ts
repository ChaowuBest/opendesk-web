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
    isMaximized(): boolean;
    getNormalBounds(): { x: number; y: number; width: number; height: number };
    restore(): void;
    show(): void;
    hide(): void;
    moveTop(): void;
    setAlwaysOnTop(flag: boolean): void;
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
    /**
     * 获取可信的 normal bounds。Linux 透明无边框窗口最大化后
     * getNormalBounds() 可能返回最大化尺寸（restored bounds 缓存缺失/被污染），
     * 由调用方注入基于 normal-bounds-tracker 的实现；缺省回退 getNormalBounds()。
     * 仅在退出时窗口处于最大化时使用。
     */
    getTrustedNormalBounds?: () => { x: number; y: number; width: number; height: number };
}

export const CLOSE_DIALOG_REQUEST_CHANNEL = 'closeWindow:request';
export const CLOSE_DIALOG_RESPONSE_CHANNEL = 'closeWindow:response';

/**
 * Windows 上临时置顶后撤销置顶的延迟（ms）。
 *
 * SetForegroundWindow 是在目标窗口的线程上异步生效的：置顶、focus、撤顶挤在同一个
 * 事件循环 tick 里，撤顶有可能先落地，窗口在真正拿到前台之前就被摘掉置顶，前台锁
 * 依旧生效。晚一拍再撤销能稳定避开这个竞争，同时置顶只持续极短时间用户感知不到。
 */
const WIN32_TOPMOST_REVERT_DELAY_MS = 50;

/**
 * 把主窗口带到前台。
 *
 * 关闭确认弹窗是应用内模态：若窗口处于最小化/隐藏/后台状态（例如用户在任务栏
 * 右键关闭窗口、或窗口被其他应用遮挡），弹窗会在用户看不到的地方弹出，用户会
 * 误以为应用卡死。因此在展示弹窗前必须先恢复并聚焦主窗口。
 *
 * 系统通知点击、托盘点击、第二实例也要把窗口带到前台，统一复用这里的实现，
 * 避免各处只调 show() 而在 Windows 上留下「窗口没真正到前台」的差异。
 *
 * 调用方拿到的窗口可能已经被销毁（托盘/第二实例仍持有旧引用），这里统一早退，
 * 免得在事件回调里抛 "Object has been destroyed"。
 */
export function bringMainWindowToForeground(window: MainWindowLike): void {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) {
        window.restore();
    }
    if (!window.isVisible()) {
        window.show();
    }
    window.moveTop();
    if (process.platform === 'win32') {
        // Windows 的 SetForegroundWindow 受前台锁限制，后台进程直接 focus() 往往只让
        // 任务栏图标闪一下，窗口仍被其它应用盖住（electron/electron#20911）。
        // 临时置顶再撤销是通行的规避手段：置顶期间 focus() 不受前台锁约束。
        // 这里假定主窗口自身不是常驻置顶窗口（目前没有该配置）；将来若要支持窗口置顶，
        // 撤顶需改为恢复调用前的状态，而不是一律置 false。
        window.setAlwaysOnTop(true);
        window.focus();
        setTimeout(() => {
            if (window.isDestroyed()) return;
            window.setAlwaysOnTop(false);
        }, WIN32_TOPMOST_REVERT_DELAY_MS);
        return;
    }
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
            // 应用退出时保存窗口 normal bounds 与最大化标志，下次启动恢复；
            // Linux 阴影窗口需先收缩为视觉矩形（见 normalizeSaveBounds 注释）。
            // 最大化时 getNormalBounds() 在 Linux 上不可信（可能返回最大化尺寸），
            // 改用跟踪缓存的 trusted normal bounds。
            try {
                const maximized = deps.window.isMaximized();
                const rawBounds =
                    maximized && deps.getTrustedNormalBounds
                        ? deps.getTrustedNormalBounds()
                        : deps.window.getNormalBounds();
                const bounds = deps.normalizeSaveBounds ? deps.normalizeSaveBounds(rawBounds) : rawBounds;
                const data = deps.getSettingData();
                const guiConfig = (data.gui_config ?? {}) as Record<string, unknown>;
                guiConfig.window_bounds = {
                    x: bounds.x,
                    y: bounds.y,
                    width: bounds.width,
                    height: bounds.height,
                    // 仅在最大化时写入，缺省（undefined）即非最大化，兼容历史数据
                    ...(maximized ? { is_maximized: true } : {})
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
