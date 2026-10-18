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

/**
 * Linux 阴影窗口的内容边缘 resize 感应条。
 *
 * 阴影边距环（--od-window-margin）内布置 8 个方向的透明感应条，贴着用户看到的
 * 内容窗口边缘提供 resize 光标与拖拽（原生 FramelessView 手柄固定在窗口矩形
 * 外沿，见 shadow-resize.ts 的注释）。感应条覆盖整个边距环；最大化/全屏时
 * 边距折叠为 0，感应条由 CSS 隐藏。
 *
 * 拖动来源按 pointerType 分流：鼠标（driver='cursor'）由主进程轮询系统光标；
 * 触摸屏/手写笔（driver='pointer'）不更新系统光标，由本侧 pointermove 上报指针
 * 的窗口内坐标驱动（触摸的 screenX/screenY 在 X11 下不可靠）。触摸的后续事件挂在
 * window 上而非感应条的 pointer capture 上——resize 会改变窗口尺寸导致感应条重排，
 * capture 目标随之失效，window 级监听不受影响。坐标按帧合并上报，避免触摸屏高频
 * 事件把主进程压垮。
 */

declare global {
    interface Window {
        shadowResizeAPI?: {
            start: (direction: string, options?: ShadowResizeStartOptions) => void;
            move: (x: number, y: number) => void;
            end: () => void;
        };
    }
}

/** 会话驱动来源；driver='pointer' 时附带按下点，主进程据此换算位移 */
interface ShadowResizeStartOptions {
    driver: 'cursor' | 'pointer';
    clientX: number;
    clientY: number;
}

const DIRECTIONS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
const HANDLES_CONTAINER_ID = 'od-shadow-resize-handles';

/** 正在拖动的指针；感应条同一时刻只有一个指针在拖动 */
let activePointer: { pointerId: number; driver: 'cursor' | 'pointer' } | null = null;
/** 待上报的窗口内坐标（按帧合并） */
let pendingPoint: { x: number; y: number } | null = null;
let rafId = 0;

function resetPendingPoint(): void {
    if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
    }
    pendingPoint = null;
}

function flushPendingPoint(): void {
    rafId = 0;
    const point = pendingPoint;
    pendingPoint = null;
    if (point) {
        window.shadowResizeAPI?.move(point.x, point.y);
    }
}

function onPointerMove(event: PointerEvent): void {
    // 多指同按：只跟随发起 resize 的那根手指
    if (!activePointer || event.pointerId !== activePointer.pointerId) {
        return;
    }
    if (activePointer.driver !== 'pointer') {
        return;
    }
    pendingPoint = { x: event.clientX, y: event.clientY };
    if (!rafId) {
        rafId = requestAnimationFrame(flushPendingPoint);
    }
}

function onPointerEnd(event: PointerEvent): void {
    if (!activePointer || event.pointerId !== activePointer.pointerId) {
        return;
    }
    activePointer = null;
    resetPendingPoint();
    window.shadowResizeAPI?.end();
}

/**
 * 首次触摸后给 html 挂 touch-resize-wide，把感应条向内压进内容区放宽命中阈值
 * （见 titlebar.css）。鼠标用户不挂该类——他们有精确指针，放宽只会抢走内容边缘
 * 的点击。挂上后不再监听。
 */
function onTouchPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse') {
        return;
    }
    document.documentElement.classList.add('touch-resize-wide');
    document.removeEventListener('pointerdown', onTouchPointerDown, true);
}

export function installShadowResizeHandles(): void {
    if (!window.shadowResizeAPI) {
        return;
    }
    if (document.getElementById(HANDLES_CONTAINER_ID)) {
        return;
    }

    const container = document.createElement('div');
    container.id = HANDLES_CONTAINER_ID;

    for (const direction of DIRECTIONS) {
        const handle = document.createElement('div');
        handle.className = 'od-shadow-resize-handle';
        handle.dataset.direction = direction;
        handle.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) {
                return;
            }
            event.preventDefault();
            const driver = event.pointerType === 'mouse' ? 'cursor' : 'pointer';
            activePointer = { pointerId: event.pointerId, driver };
            window.shadowResizeAPI?.start(direction, {
                driver,
                clientX: event.clientX,
                clientY: event.clientY
            });
        });
        container.appendChild(handle);
    }

    document.body.appendChild(container);

    // 后续事件挂在 window 上：resize 过程中感应条会随窗口重排，capture 到感应条
    // 的事件流可能中断；window 级监听在指针拖出感应条甚至窗口后依然连续
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);

    // 首次触摸后放宽感应条命中区（鼠标用户保持原宽度）
    document.addEventListener('pointerdown', onTouchPointerDown, true);
}
