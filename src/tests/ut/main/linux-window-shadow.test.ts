/**
 * Linux 主窗口自绘阴影的 bounds 换算：
 *
 * X11 窗口管理器（Mutter/Muffin/KWin 等）不为无边框窗口绘制阴影，也无法通过
 * _GTK_FRAME_EXTENTS 等 CSD 属性可靠触发（实测 Cinnamon/Muffin 无效）。因此
 * Linux 透明主窗口的阴影采用与 task-status-widget 悬浮窗同构的自绘方式：
 * 窗口矩形四周扩展一段透明边距（LINUX_WINDOW_SHADOW_MARGIN），renderer 内的
 * 内容容器向内收缩同样的边距并用 box-shadow 绘制阴影。
 *
 * 由此 bounds 出现两种语义：
 * - 视觉 bounds：用户看到的内容矩形（gui_config.window_bounds 始终保存该语义，
 *   与无阴影平台/历史数据兼容）；
 * - 窗口 bounds：BrowserWindow 的真实矩形（视觉 bounds 四周扩展阴影边距）。
 *
 * 本模块提供两个方向的纯换算，供 main.ts 在窗口构造、恢复、DPI 修正与退出
 * 保存时调用。
 */

import { describe, it, expect } from '@jest/globals';

import {
    LINUX_WINDOW_SHADOW_MARGIN,
    computeDragBounds,
    computeShadowResizeBounds,
    normalizeShadowResizeDirection,
    expandVisualBounds,
    shrinkWindowBounds
} from '../../../main/windows/linux-window-shadow.js';

describe('expandVisualBounds', () => {
    it('视觉 bounds 四周扩展边距得到窗口 bounds', () => {
        expect(expandVisualBounds({ x: 100, y: 50, width: 800, height: 600 }, 20)).toEqual({
            x: 80,
            y: 30,
            width: 840,
            height: 640
        });
    });

    it('margin 为 0 时恒等（非 Linux 平台路径）', () => {
        const bounds = { x: -12, y: 7, width: 850, height: 400 };
        expect(expandVisualBounds(bounds, 0)).toEqual(bounds);
    });

    it('非整数输入取整，保证 Electron bounds 为整数', () => {
        expect(expandVisualBounds({ x: 100.5, y: 50.2, width: 800.9, height: 600.4 }, 20)).toEqual({
            x: 81,
            y: 30,
            width: 841,
            height: 640
        });
    });
});

describe('shrinkWindowBounds', () => {
    it('窗口 bounds 四周收缩边距得到视觉 bounds', () => {
        expect(shrinkWindowBounds({ x: 80, y: 30, width: 840, height: 640 }, 20)).toEqual({
            x: 100,
            y: 50,
            width: 800,
            height: 600
        });
    });

    it('margin 为 0 时恒等（非 Linux 平台路径）', () => {
        const bounds = { x: 0, y: 0, width: 1600, height: 1080 };
        expect(shrinkWindowBounds(bounds, 0)).toEqual(bounds);
    });

    it('与 expandVisualBounds 互逆', () => {
        const visual = { x: 100, y: 50, width: 800, height: 600 };
        expect(
            shrinkWindowBounds(expandVisualBounds(visual, LINUX_WINDOW_SHADOW_MARGIN), LINUX_WINDOW_SHADOW_MARGIN)
        ).toEqual(visual);
    });
});

describe('computeDragBounds', () => {
    const START = { x: 100, y: 80, width: 1200, height: 800 };

    it('按光标位移整体平移，尺寸不变', () => {
        expect(computeDragBounds({ startBounds: START, dx: 40, dy: -25 })).toEqual({
            x: 140,
            y: 55,
            width: 1200,
            height: 800
        });
    });

    it('无位移时返回起始 bounds', () => {
        expect(computeDragBounds({ startBounds: START, dx: 0, dy: 0 })).toEqual(START);
    });

    it('非整数位移取整（X11 光标坐标为整数，防御小数）', () => {
        expect(computeDragBounds({ startBounds: START, dx: 10.4, dy: -3.6 })).toEqual({
            x: 110,
            y: 76,
            width: 1200,
            height: 800
        });
    });
});
