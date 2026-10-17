/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT ANY KIND OF WARRANTY,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/** 窗口/视觉矩形边界。 */
export interface WindowBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Linux 主窗口自绘阴影边距（DIP）。
 *
 * X11 窗口管理器不为无边框窗口绘制阴影，_GTK_FRAME_EXTENTS 等 CSD 属性也无法
 * 可靠触发（实测 Cinnamon/Muffin 无效，且 KWin/GNOME 行为各异）。主窗口的阴影
 * 采用与 task-status-widget 悬浮窗同构的自绘方式：窗口矩形四周扩展本边距的
 * 透明区域，renderer 内的内容容器（#app-root）向内收缩同样的边距，box-shadow
 * 绘制在扩展出的透明区域内。renderer 侧的收缩量必须与此处保持一致
 * （titlebar.css 的 --od-window-margin）。
 */
export const LINUX_WINDOW_SHADOW_MARGIN = 20;

/**
 * 视觉 bounds（用户看到的内容矩形）四周扩展阴影边距，得到 BrowserWindow 的
 * 窗口 bounds。用于窗口构造、保存的 bounds 恢复与 per-monitor DPI 修正。
 */
export function expandVisualBounds(bounds: WindowBounds, margin: number): WindowBounds {
    return {
        x: Math.round(bounds.x - margin),
        y: Math.round(bounds.y - margin),
        width: Math.round(bounds.width + margin * 2),
        height: Math.round(bounds.height + margin * 2)
    };
}

/**
 * 窗口 bounds 四周收缩阴影边距，得到视觉 bounds。用于退出时保存
 * gui_config.window_bounds（该字段始终保存视觉矩形语义，与无阴影平台及
 * 历史数据兼容）。
 */
export function shrinkWindowBounds(bounds: WindowBounds, margin: number): WindowBounds {
    return {
        x: Math.round(bounds.x + margin),
        y: Math.round(bounds.y + margin),
        width: Math.round(bounds.width - margin * 2),
        height: Math.round(bounds.height - margin * 2)
    };
}

export type ShadowResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const SHADOW_RESIZE_DIRECTIONS: readonly ShadowResizeDirection[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** 校验 renderer 传来的方向参数，非法值返回 null。 */
export function normalizeShadowResizeDirection(value: unknown): ShadowResizeDirection | null {
    if (typeof value !== 'string') {
        return null;
    }
    return (SHADOW_RESIZE_DIRECTIONS as readonly string[]).includes(value) ? (value as ShadowResizeDirection) : null;
}

export interface ShadowResizeInput {
    startBounds: WindowBounds;
    direction: ShadowResizeDirection;
    /** 光标相对拖动起点的位移（屏幕坐标） */
    dx: number;
    dy: number;
    minWidth: number;
    minHeight: number;
}

/**
 * 按方向与位移差换算拖动 resize 的新 bounds。西/北方向收缩到最小尺寸时
 * x/y 同步补偿，保证对边（视觉上正在拖的那条边）固定不动。会话管理见
 * shadow-resize.ts（renderer 感应条贴内容边缘，主进程轮询光标驱动）。
 */
export function computeShadowResizeBounds(input: ShadowResizeInput): WindowBounds {
    const { startBounds, direction, dx, dy, minWidth, minHeight } = input;
    let { x, y, width, height } = startBounds;

    if (direction.includes('e')) {
        width = Math.max(startBounds.width + dx, minWidth);
    }
    if (direction.includes('s')) {
        height = Math.max(startBounds.height + dy, minHeight);
    }
    if (direction.includes('w')) {
        width = Math.max(startBounds.width - dx, minWidth);
        x = startBounds.x + (startBounds.width - width);
    }
    if (direction.includes('n')) {
        height = Math.max(startBounds.height - dy, minHeight);
        y = startBounds.y + (startBounds.height - height);
    }
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export interface WindowDragInput {
    startBounds: WindowBounds;
    /** 光标相对拖动起点的位移（屏幕坐标） */
    dx: number;
    dy: number;
}

/**
 * 整窗移动：起始 bounds 按光标位移整体平移，尺寸不变。
 * 会话管理见 window-drag.ts（Linux 下拖拽层为 no-drag，renderer 通知主进程
 * 轮询光标驱动整窗移动——避免 -webkit-app-region: drag 触发 GTK 标题栏右键
 * 系统窗口菜单，见 linux-context-menu.ts 说明）。
 */
export function computeDragBounds(input: WindowDragInput): WindowBounds {
    const { startBounds, dx, dy } = input;
    return {
        x: Math.round(startBounds.x + dx),
        y: Math.round(startBounds.y + dy),
        width: startBounds.width,
        height: startBounds.height
    };
}

/** 二维坐标点（窗口内坐标或屏幕 DIP 坐标，语义由调用方指定）。 */
export interface Point {
    x: number;
    y: number;
}

export interface PointerFeedInput {
    /** 会话起始窗口 bounds（尚未应用任何位移时即窗口当时的 bounds） */
    startBounds: WindowBounds;
    /** 主进程当前已应用的窗口 bounds（含本会话此前的移动） */
    appliedBounds: WindowBounds;
    /** 按下点：renderer 窗口内坐标 */
    startClient: Point;
    /** 当前 pointer 位置：renderer 窗口内坐标 */
    client: Point;
}

/**
 * pointer 驱动会话（触摸屏/手写笔）的位移换算。
 *
 * 触摸不会更新系统光标位置，主进程无法用 screen.getCursorScreenPoint() 轮询；
 * 触摸事件的 screenX/screenY 在 X11 下也不可靠（可能退化成窗口内坐标，用它做
 * 绝对定位会形成正反馈、窗口乱跳），因此改由 renderer 上报 pointer 的窗口内
 * 坐标。窗口内坐标随窗口自身移动而变（窗口右移 50px，同一屏幕位置的 clientX
 * 小 50），故屏幕位移为：
 *
 *   d = (appliedBounds.origin + client) - (startBounds.origin + startClient)
 *     = 已应用位移 + 指针在窗口内的位移
 *
 * 结果始终以会话起点为基准（非逐帧累加），事件延迟与丢帧不会累积漂移；
 * appliedBounds 与事件采样时刻的窗口位置之差最多一帧，由调用侧的按帧合并压到
 * 最小。
 */
export function computePointerFeedDelta(input: PointerFeedInput): { dx: number; dy: number } {
    const { startBounds, appliedBounds, startClient, client } = input;
    return {
        dx: appliedBounds.x - startBounds.x + (client.x - startClient.x),
        dy: appliedBounds.y - startBounds.y + (client.y - startClient.y)
    };
}
