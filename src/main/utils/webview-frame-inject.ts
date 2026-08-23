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
 * 向 webview guest 的 frame 树注入脚本。
 *
 * preload 只在主 frame 执行，而搜索框位于 OOPIF iframe 的站点（如 Bing 搜索框）
 * 不会运行主 frame 的 preload，导致 iframe 内的 renderer 自发起导航缺少拦截。
 * 此处通过 WebFrameMain.executeJavaScript 把脚本注入主 frame 及其所有子 frame；
 * 脚本自身应具备幂等安装标记（如 NAV_INTERCEPT_SCRIPT 的 __odNavInterceptInstalled）。
 */

/** 可执行脚本的最小接口（WebFrameMain 的子集）。 */
export interface FrameScriptExecutor {
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

/** frame 树的最小接口（WebContents 的 mainFrame 子集）。 */
export interface FrameTreeHost {
    mainFrame?: (FrameScriptExecutor & { frames: FrameScriptExecutor[] }) | null;
}

/**
 * 将脚本注入主 frame 与所有子 frame，返回尝试注入的 frame 数量。
 * 单个 frame 执行失败会被静默忽略（frame 可能已销毁），不影响其余 frame。
 */
export function injectScriptIntoFrames(webContents: FrameTreeHost, script: string): number {
    const mainFrame = webContents.mainFrame;
    if (!mainFrame) return 0;

    let count = 0;
    try {
        mainFrame.executeJavaScript(script).catch(() => {
            /* 主 frame 可能已销毁 */
        });
        count += 1;
    } catch {
        /* 主 frame 不可用 */
    }

    let frames: FrameScriptExecutor[] | undefined;
    try {
        frames = mainFrame.frames;
    } catch {
        frames = undefined;
    }
    if (frames) {
        for (const frame of frames) {
            try {
                frame.executeJavaScript(script).catch(() => {
                    /* frame 可能已销毁 */
                });
                count += 1;
            } catch {
                /* frame 不可用 */
            }
        }
    }
    return count;
}
