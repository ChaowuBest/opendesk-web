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
 * 窗口 normal bounds 跟踪器。
 *
 * 背景（Linux 假最大化 bug）：主窗口在 Linux 上是 frameless + transparent，
 * 最大化后 Chromium/WM 对 restored bounds 的缓存缺失或被污染，此时
 * `BrowserWindow.getNormalBounds()` 可能直接返回最大化尺寸（Electron 在 Linux
 * 上直接透传 GetRestoredBounds()，没有 Windows 那样的最大化透明窗口修正）。
 * 退出时若把这份坏值持久化，下次启动用 setBounds 还原就会得到一个
 * "看似最大化但 isMaximized() === false" 的假最大化窗口。
 *
 * 本模块通过监听窗口事件自行维护一份可信的 normal bounds 缓存：
 * - 非最大化/非全屏/非最小化时的 resize、move 才写入缓存（X11 下 maximize 是
 *   WM 异步完成的：状态先翻转、bounds 下一轮才刷新，resize 触发时
 *   isMaximized() 已为 true，因此最大化尺寸不会混入缓存）；
 * - unmaximize 后等待 settle 窗口再重新采样：unmaximize 同样是状态先翻转、
 *   bounds 后刷新，立即读取会拿到最大化尺寸污染缓存（与 window-drag.ts 的
 *   UNMAXIMIZE_SETTLE_MS 等待同语义）；
 * - 最小化窗口在 Windows 上 bounds 是 -32000 幽灵值，同样排除。
 */

export interface WindowBoundsRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface NormalBoundsTrackerWin {
    on(event: string, listener: () => void): unknown;
    removeListener(event: string, listener: () => void): unknown;
    isDestroyed(): boolean;
    isMaximized(): boolean;
    isFullScreen(): boolean;
    isMinimized(): boolean;
    getBounds(): WindowBoundsRect;
    getNormalBounds(): WindowBoundsRect;
}

export interface NormalBoundsTracker {
    /** 返回可信的 normal bounds；尚无采样值时回退 win.getNormalBounds()。 */
    getNormalBounds(): WindowBoundsRect;
    /** 移除全部事件监听。窗口销毁后监听随之失效，长期驻留场景可不调用。 */
    stop(): void;
}

/** X11 下 WM 应用 unmaximize 的等待窗口，与 window-drag.ts 的 UNMAXIMIZE_SETTLE_MS 同语义。 */
const DEFAULT_UNMAXIMIZE_SETTLE_MS = 60;

export function attachNormalBoundsTracker(
    win: NormalBoundsTrackerWin,
    options?: { settleMs?: number }
): NormalBoundsTracker {
    const settleMs = options?.settleMs ?? DEFAULT_UNMAXIMIZE_SETTLE_MS;
    let cached: WindowBoundsRect = win.getBounds();
    let unmaximizeSettleTimer: NodeJS.Timeout | null = null;
    /** unmaximize 已发出但 WM 尚未刷新 bounds 的窗口期，期间忽略 resize。 */
    let settlingAfterUnmaximize = false;

    const isTrackableState = (): boolean =>
        !win.isDestroyed() && !win.isMaximized() && !win.isFullScreen() && !win.isMinimized();

    const trackBounds = (): void => {
        if (settlingAfterUnmaximize || !isTrackableState()) return;
        cached = win.getBounds();
    };

    const onUnmaximize = (): void => {
        if (unmaximizeSettleTimer) clearTimeout(unmaximizeSettleTimer);
        settlingAfterUnmaximize = true;
        unmaximizeSettleTimer = setTimeout(() => {
            unmaximizeSettleTimer = null;
            settlingAfterUnmaximize = false;
            if (!isTrackableState()) return;
            cached = win.getBounds();
        }, settleMs);
    };

    win.on('resize', trackBounds);
    win.on('move', trackBounds);
    win.on('unmaximize', onUnmaximize);

    return {
        getNormalBounds: () => cached,
        stop: () => {
            if (unmaximizeSettleTimer) {
                clearTimeout(unmaximizeSettleTimer);
                unmaximizeSettleTimer = null;
            }
            win.removeListener('resize', trackBounds);
            win.removeListener('move', trackBounds);
            win.removeListener('unmaximize', onUnmaximize);
        }
    };
}
