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
 * Linux 主窗口顶部拖拽层的手动拖动会话管理。
 *
 * 背景：`-webkit-app-region: drag` 区域在 Linux(X11)/GTK 下被当作自绘标题栏，
 * 右键会弹 WM 系统窗口菜单（弹位错误 + grab 输入，点击无效且无法关闭）。
 * 因此 Linux 主窗口拖拽层改为 no-drag（见 titlebar.css 的
 * `html.window-rounded .drag-overlay` 覆盖），拖动由本模块以手动会话完成；
 * Windows/macOS 仍走原生 drag region，行为不变。
 *
 * 会话有两种驱动来源（driver）：
 * - cursor（鼠标）：renderer 的 pointer 事件只负责发起/结束信号，本模块轮询
 *   screen.getCursorScreenPoint() 驱动整窗移动（鼠标可能拖出窗口，renderer
 *   无法持续收到 mousemove；pointer capture 负责正常路径的 pointerup）；
 * - pointer（触摸屏/手写笔）：这类输入不会更新系统光标位置，轮询取到的始终是
 *   陈旧坐标（窗口跳到错误位置后不再跟随手指），改由 renderer 在 pointermove 中
 *   上报 pointer 的窗口内坐标，经 updateWindowDragSession 驱动。窗口内坐标随
 *   窗口自身移动而变，换算需带上已应用位移（computePointerFeedDelta）；主进程
 *   按帧合并更新，避免快速拖动时事件排队造成过冲后卡死。
 *
 * 两种来源的兜底一致：blur/closed/超时结束会话。bounds 换算见
 * linux-window-shadow.ts。
 *
 * renderer 上报的窗口内坐标是 CSS 像素（主窗口按缩放偏好设置了
 * webContents.setZoomFactor），会话入口统一换算成 DIP 后再参与 bounds 计算；
 * 混用两种单位会让按下点把窗口拽偏（zoom<1 时整窗向左上跳，见 clientCssToDip）。
 */

import { BrowserWindow, screen } from 'electron';
import {
    clientCssToDip,
    computeDragBounds,
    computePointerFeedDelta,
    type Point,
    type WindowBounds
} from './linux-window-shadow.js';

const DRAG_POLL_INTERVAL_MS = 16;
/** 安全网：异常情况下（如 pointerup 丢失）避免会话永久挂起。 */
const DRAG_SESSION_MAX_MS = 30_000;
/**
 * X11 下 unmaximize 由 WM 异步处理（状态先变、bounds 下一轮才刷新），必须等
 * WM 恢复完成后再按 grab 点定位，否则会被 WM 的恢复覆盖（窗口跳回原位），
 * 或用未刷新的最大化 bounds 写回窗口（还原后尺寸错误、污染 WM 的 normal
 * bounds，导致后续双击还原到错误尺寸）。
 */
const UNMAXIMIZE_SETTLE_MS = 60;

/** 拖动会话的驱动来源，见模块注释。 */
export type WindowDragDriver = 'cursor' | 'pointer';

interface WindowDragSession {
    win: BrowserWindow;
    driver: WindowDragDriver;
    /** 会话起始 bounds，位移换算的基准 */
    startBounds: WindowBounds;
    /** cursor 驱动：会话起始光标屏幕坐标 */
    startPoint: Point;
    /** pointer 驱动：按下点（renderer 窗口内坐标，已换算为 DIP） */
    grabPoint: Point;
    /** pointer 驱动不轮询 */
    pollTimer: NodeJS.Timeout | null;
    deadlineTimer: NodeJS.Timeout;
    blurHandler: () => void;
    closedHandler: () => void;
}

/**
 * 鼠标按下点在窗口内的坐标（renderer 的 event.clientX/Y，Electron 视口原点即窗口原点）。
 * 单位为 CSS 像素，会话入口按 zoom factor 换算为 DIP。
 */
export interface WindowDragGrabPoint {
    x: number;
    y: number;
}

let activeSession: WindowDragSession | null = null;
/** 最大化还原路径中等待 WM 恢复的定位定时器（会话启动前可在 end 时取消）。 */
let pendingMaximizeDragTimer: NodeJS.Timeout | null = null;

/**
 * 开始一次顶部拖拽层拖动。重复调用会先结束上一个会话（拖拽层同一时刻只会
 * 有一个 pointer 会话，这里防御异常路径）。
 *
 * 最大化状态下的拖动会先还原到最大化之前的尺寸（getNormalBounds）并跳到指针
 * 下方（保持按下点相对窗口位置不变），复刻 WM 原生"最大化窗口按住标题栏拖动
 * 即还原跟随"的语义。
 */
export function startWindowDragSession(
    win: BrowserWindow,
    grabPoint?: WindowDragGrabPoint,
    driver: WindowDragDriver = 'cursor'
): void {
    endWindowDragSession();
    if (win.isDestroyed() || win.isFullScreen()) {
        return;
    }
    // 没有按下点就无法换算窗口内坐标，退回光标轮询路径
    const pointerDriven = driver === 'pointer' && !!grabPoint;
    const hasGrabPoint = !!grabPoint;
    // 按下点是 renderer 上报的 CSS 像素坐标，换算成 DIP 后才能与光标、bounds 同系定位
    const grab = grabPoint ? clientCssToDip(grabPoint, win.webContents.getZoomFactor()) : { x: 0, y: 0 };

    if (pointerDriven) {
        if (win.isMaximized()) {
            const normal = win.getNormalBounds();
            win.unmaximize();
            // 等 WM 恢复完成后回到 normal bounds 并进入会话；按下点落到手指下
            // 由首个 pointermove 完成（见 updateWindowDragSession）
            pendingMaximizeDragTimer = setTimeout(() => {
                pendingMaximizeDragTimer = null;
                if (win.isDestroyed()) {
                    return;
                }
                win.setBounds(normal);
                beginDragSession(win, normal, 'pointer', grab, grab);
            }, UNMAXIMIZE_SETTLE_MS);
            return;
        }
        // 触摸按下不做预定位：按陈旧光标定位会让窗口跳到手指之外；首个
        // pointermove 即把按下点落到手指下（阈值位移仅数像素，无跳变感）
        const startBounds = win.getBounds();
        beginDragSession(win, startBounds, 'pointer', grab, grab);
        return;
    }

    const cursor = screen.getCursorScreenPoint();

    if (win.isMaximized()) {
        // 取最大化之前的 bounds 后再 unmaximize（getNormalBounds 不受最大化影响）
        const normal = win.getNormalBounds();
        win.unmaximize();
        // 等 WM 恢复完成（UNMAXIMIZE_SETTLE_MS）再按 grab 点定位并进入拖动会话；
        // 期间 renderer 若已松手（end），会取消本定时器，窗口保持 WM 的还原位置
        pendingMaximizeDragTimer = setTimeout(() => {
            pendingMaximizeDragTimer = null;
            if (win.isDestroyed()) {
                return;
            }
            const target: WindowBounds = {
                x: hasGrabPoint ? cursor.x - grab.x : normal.x,
                y: hasGrabPoint ? cursor.y - grab.y : normal.y,
                width: normal.width,
                height: normal.height
            };
            win.setBounds(target);
            beginDragSession(win, target, 'cursor', screen.getCursorScreenPoint(), grab);
        }, UNMAXIMIZE_SETTLE_MS);
        return;
    }

    let startBounds = win.getBounds();
    if (hasGrabPoint) {
        // 按下点以窗口内坐标给出（视口原点 = 窗口原点）：新位置让该点保持在
        // 当前指针下，即窗口不因按下而跳动（换算正确时新位置 = 原位置）
        startBounds = {
            x: cursor.x - grab.x,
            y: cursor.y - grab.y,
            width: startBounds.width,
            height: startBounds.height
        };
        win.setBounds(startBounds);
    }
    beginDragSession(win, startBounds, 'cursor', screen.getCursorScreenPoint(), grab);
}

function beginDragSession(
    win: BrowserWindow,
    startBounds: WindowBounds,
    driver: WindowDragDriver,
    startPoint: Point,
    grabPoint: Point
): void {
    const pollTimer =
        driver === 'pointer'
            ? null
            : setInterval(() => {
                  if (win.isDestroyed()) {
                      endWindowDragSession();
                      return;
                  }
                  const cursorNow = screen.getCursorScreenPoint();
                  win.setBounds(
                      computeDragBounds({
                          startBounds,
                          dx: cursorNow.x - startPoint.x,
                          dy: cursorNow.y - startPoint.y
                      })
                  );
              }, DRAG_POLL_INTERVAL_MS);

    const blurHandler = () => endWindowDragSession();
    const closedHandler = () => endWindowDragSession();
    win.on('blur', blurHandler);
    win.once('closed', closedHandler);

    const deadlineTimer = setTimeout(() => endWindowDragSession(), DRAG_SESSION_MAX_MS);

    activeSession = {
        win,
        driver,
        startBounds,
        startPoint,
        grabPoint,
        pollTimer,
        deadlineTimer,
        blurHandler,
        closedHandler
    };
}

/** pointer 驱动：待应用的最新窗口内坐标与按帧合并定时器 */
let pendingClient: Point | null = null;
let coalesceTimer: NodeJS.Timeout | null = null;

function applyPendingClient(): void {
    coalesceTimer = null;
    const client = pendingClient;
    pendingClient = null;
    const session = activeSession;
    if (!session || session.driver !== 'pointer' || !client || session.win.isDestroyed()) {
        return;
    }
    const { dx, dy } = computePointerFeedDelta({
        startBounds: session.startBounds,
        appliedBounds: session.win.getBounds(),
        startClient: session.grabPoint,
        client
    });
    session.win.setBounds(computeDragBounds({ startBounds: session.startBounds, dx, dy }));
}

/**
 * pointer 驱动会话的坐标更新（renderer pointermove 上报的窗口内坐标，CSS 像素）。
 * 无会话或会话为光标驱动时忽略——鼠标路径由主进程轮询驱动。
 *
 * 按帧合并：触摸屏 pointermove 可达 240Hz，逐条换算会反复读到「已应用位移超前于
 * 事件采样时刻」的 bounds 并把误差叠加进位移（快速拖动时表现为乱跳后卡住），
 * 因此同一帧内只应用最后一个坐标。
 */
export function updateWindowDragSession(client: Point): void {
    if (!activeSession || activeSession.driver !== 'pointer') {
        return;
    }
    // 上报的窗口内坐标是 CSS 像素，与按下点同系换算为 DIP 后再参与位移计算
    pendingClient = clientCssToDip(client, activeSession.win.webContents.getZoomFactor());
    if (coalesceTimer) {
        return;
    }
    applyPendingClient();
    coalesceTimer = setTimeout(applyPendingClient, DRAG_POLL_INTERVAL_MS);
}

export function endWindowDragSession(): void {
    if (pendingMaximizeDragTimer) {
        clearTimeout(pendingMaximizeDragTimer);
        pendingMaximizeDragTimer = null;
    }
    if (coalesceTimer) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
    }
    pendingClient = null;
    if (!activeSession) {
        return;
    }
    if (activeSession.pollTimer) {
        clearInterval(activeSession.pollTimer);
    }
    clearTimeout(activeSession.deadlineTimer);
    if (!activeSession.win.isDestroyed()) {
        activeSession.win.removeListener('blur', activeSession.blurHandler);
        activeSession.win.removeListener('closed', activeSession.closedHandler);
    }
    activeSession = null;
}
