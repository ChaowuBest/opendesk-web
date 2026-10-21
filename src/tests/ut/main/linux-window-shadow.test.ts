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
    clientCssToDip,
    computeDragBounds,
    computePointerFeedDelta,
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

describe('computePointerFeedDelta', () => {
    const START = { x: 100, y: 80, width: 1200, height: 800 };

    it('整窗拖动：窗口未移动时位移即指针在窗口内的位移', () => {
        expect(
            computePointerFeedDelta({
                startBounds: START,
                appliedBounds: START,
                startClient: { x: 300, y: 16 },
                client: { x: 350, y: 16 }
            })
        ).toEqual({ dx: 50, dy: 0 });
    });

    it('整窗拖动：手指停住后 client 随窗口移动回落，位移不再增长', () => {
        // 手指从屏幕 x=400 拖到 x=450（窗口已随之移到 x=150）后停住，
        // 窗口内坐标回落到 300；总位移仍是手指的总位移 50
        expect(
            computePointerFeedDelta({
                startBounds: START,
                appliedBounds: { x: 150, y: 80, width: 1200, height: 800 },
                startClient: { x: 300, y: 16 },
                client: { x: 300, y: 16 }
            })
        ).toEqual({ dx: 50, dy: 0 });
    });

    it('east 边缘：origin 不动，client 位移即宽度增量且停住后不增长', () => {
        expect(
            computePointerFeedDelta({
                startBounds: START,
                appliedBounds: START,
                startClient: { x: 1200, y: 400 },
                client: { x: 1240, y: 400 }
            })
        ).toEqual({ dx: 40, dy: 0 });
        expect(
            computePointerFeedDelta({
                startBounds: START,
                appliedBounds: { x: 100, y: 80, width: 1240, height: 800 },
                startClient: { x: 1200, y: 400 },
                client: { x: 1240, y: 400 }
            })
        ).toEqual({ dx: 40, dy: 0 });
    });

    it('west 边缘：窗口左移使 client 同步补偿，位移保持为手指总位移', () => {
        expect(
            computePointerFeedDelta({
                startBounds: START,
                appliedBounds: START,
                startClient: { x: 0, y: 400 },
                client: { x: -60, y: 400 }
            })
        ).toEqual({ dx: -60, dy: 0 });
        // 窗口已左移到 x=40，手指停在屏幕 x=40 → 窗口内坐标回到 0
        expect(
            computePointerFeedDelta({
                startBounds: START,
                appliedBounds: { x: 40, y: 80, width: 1260, height: 800 },
                startClient: { x: 0, y: 400 },
                client: { x: 0, y: 400 }
            })
        ).toEqual({ dx: -60, dy: 0 });
    });
});

/**
 * renderer 窗口内坐标（CSS 像素）→ DIP。
 *
 * 主窗口按缩放偏好调用 webContents.setZoomFactor，renderer 的 event.clientX/Y
 * 因此是 CSS 像素；窗口 bounds 与 screen.getCursorScreenPoint() 都是 DIP。
 * 拖动/resize 会话把两者混用会让窗口位置按 client*(1-zoom) 偏移。
 */
describe('clientCssToDip', () => {
    it('zoom=1（未设置缩放偏好）时恒等', () => {
        expect(clientCssToDip({ x: 300, y: 16 }, 1)).toEqual({ x: 300, y: 16 });
    });

    it('zoom<1：CSS 像素折算为更小的 DIP（0.8 时 500 CSS = 400 DIP）', () => {
        expect(clientCssToDip({ x: 500, y: 20 }, 0.8)).toEqual({ x: 400, y: 16 });
    });

    it('zoom>1：CSS 像素折算为更大的 DIP', () => {
        expect(clientCssToDip({ x: 100, y: 50 }, 1.5)).toEqual({ x: 150, y: 75 });
    });
});
