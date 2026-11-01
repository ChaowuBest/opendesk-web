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
 * 跟随 GUI 缩放偏好（gui_config.scale_factor）的窗口集合。
 *
 * 主窗口与「独立应用窗口」共享同一个缩放偏好：任一窗口里按 Ctrl+{+,-,0} 或改设置页，
 * 所有参与同步的窗口一起变。
 *
 * 注意 Electron 的 zoom 按 webContents 独立存储：新建窗口不会继承已设过缩放的窗口，
 * 已设过缩放的窗口也不会跟随同 origin 的其它窗口，因此每个窗口都必须显式设置并
 * 在偏好变化时重新广播。任务状态浮窗、快速截图遮罩的外壳尺寸固定、要求恒定 100%，
 * 不加入集合（否则内容溢出或被裁切）。
 */

/** 参与缩放的窗口需要的最小能力（便于单测注入替身）。 */
export interface DisplayZoomTargetWindow {
    isDestroyed(): boolean;
    webContents: {
        setZoomFactor(factor: number): void;
    };
}

export class DisplayZoomSync<T extends DisplayZoomTargetWindow = DisplayZoomTargetWindow> {
    private readonly windows = new Set<T>();

    add(win: T): void {
        this.windows.add(win);
    }

    remove(win: T): void {
        this.windows.delete(win);
    }

    /**
     * 对集合内仍存活的窗口应用 zoom factor，已销毁的窗口就地剔除。
     * 单个窗口应用失败（webContents 先于窗口销毁等）只影响它自己：缩放跟随是
     * 一条链路上的多窗口广播，不能让一个窗口挡住其余窗口（包括主窗口）。
     * @returns 实际应用成功的窗口，调用方可据此向各自 renderer 推送新值
     */
    apply(factor: number): T[] {
        const applied: T[] = [];
        for (const win of this.windows) {
            if (win.isDestroyed()) {
                this.windows.delete(win);
                continue;
            }
            try {
                win.webContents.setZoomFactor(factor);
            } catch {
                continue;
            }
            applied.push(win);
        }
        return applied;
    }
}
