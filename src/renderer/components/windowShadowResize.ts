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
 * 拖动开始后 setPointerCapture 捕获指针（正常路径下指针拖出窗口仍能收到
 * pointerup 结束会话）；实际 resize 由主进程轮询光标驱动，本模块只负责
 * 发起与结束信号。
 */

declare global {
    interface Window {
        shadowResizeAPI?: {
            start: (direction: string) => void;
            end: () => void;
        };
    }
}

const DIRECTIONS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
const HANDLES_CONTAINER_ID = 'od-shadow-resize-handles';

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
            try {
                handle.setPointerCapture(event.pointerId);
            } catch {
                /* 捕获失败不影响发起 resize，结束由兜底逻辑保证 */
            }
            window.shadowResizeAPI?.start(direction);
        });
        const end = () => window.shadowResizeAPI?.end();
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
        container.appendChild(handle);
    }

    document.body.appendChild(container);
}
