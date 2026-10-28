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
 * 侧边栏任务列表的「触摸左滑 → 圆形删除按钮」手势。
 *
 * 触摸屏没有 hover，鼠标侧的悬停删除按钮与右键菜单在触摸场景下都不可用，
 * 这里补一个移动端惯例的左滑删除：
 *
 * 1. 只在触摸（touch 事件）下生效，鼠标拖动不会触发；单指按下任务行后，
 *    位移超过 AXIS_LOCK_PX 才判定手势轴向，横向位移需明显大于纵向
 *    （AXIS_X_RATIO）才锁定为左滑，否则锁定为纵向并彻底放手，
 *    让列表保持原生竖向滚动（配合 .sb-task-row 的 touch-action: pan-y，
 *    浏览器不会把横向拖动判为滚动而派发 touchcancel 打断手势）。
 * 2. 锁定横向后内容层跟随手指平移，只接受向左方向（向右钳到 0，
 *    最大位移 MAX_OFFSET_PX）；位移超过 PEEK_PX 时删除按钮提前露出作为
 *    反馈，但此时不可点击，避免手指还压在行上就误删。
 * 3. 松手时位移达到 REVEAL_PX 则停在完全展开位（OPEN_OFFSET_PX）并保持
 *    可见，等用户点圆形删除按钮；未达到则回弹关闭。
 * 4. 松手后 Chromium 会补发一次合成 click（触摸未构成滚动时，目标为起止
 *    元素的最近公共祖先），不吞掉会立刻打开任务。手势结束时挂一次性拦截，
 *    超时自动解除：既保证「左滑后首次点击删除按钮」有效，也不会长期吞点击。
 * 5. 展开态是排他的：同一时刻最多一行展开；触摸另一行、点击行外区域、
 *    行被列表重渲染移除时都会收起。
 *
 * 判定逻辑（resolveSwipeAxis / clampSwipeOffset / shouldRevealSwipe）与 DOM
 * 控制器分离，便于单测直接验证边界。
 */

/** 轴向判定位移门槛（px）：小于该值视为手指抖动，不判轴 */
const AXIS_LOCK_PX = 8;
/** 锁定为横向所需的横向位移对纵向位移的倍数，避免斜上斜下误判 */
const AXIS_X_RATIO = 1.2;
/** 删除按钮提前露出的位移（px），仅作反馈不可点击 */
const PEEK_PX = 8;
/**
 * 松手后保持展开所需的最小左滑位移（px）。
 *
 * 必须大于触摸长按手势的位移容差（touchLongPressScript 的 CANCEL_SLOP_PX = 36）：
 * 否则「缓慢左移 20~36px 后按住不放」会让长按圆环走完进度，松手时同时弹右键菜单
 * 又展开删除按钮。取 40 后两个手势按位移天然互斥——位移 ≤36 只可能触发长按，
 * >36 时长按已自行取消，只剩左滑。
 */
const REVEAL_PX = 40;
/**
 * 展开态内容层停住的位移（px）。时间文字右边缘到删除按钮左边缘的净间距
 * = 本值 + 行内右内边距(10) - 按钮右内缩(6) - 按钮直径(22)，取 28 时约 10px，
 * 再大就会在时间与按钮之间拉开一段空白。小于 REVEAL_PX，松手后回吸附到本值。
 */
const OPEN_OFFSET_PX = 28;
/** 拖动过程中允许的最大位移（px），超出后不再跟随 */
const MAX_OFFSET_PX = 56;
/**
 * 合成 click 拦截窗口（ms）。取值与 touchLongPressScript 的 SUPPRESS_MOUSE_MS 一致：
 * 合成序列在松手后数帧内到达，窗口过宽会把用户紧接着点下一行的真实点击也吞掉。
 */
const CLICK_SUPPRESS_MS = 150;
/**
 * 展开态跨列表重渲染的保留窗口（ms）。列表刷新很频繁，restore 只为对抗
 * 「刚划出删除按钮就被刷新收走」；超时后不再复活，避免展开态长期驻留，
 * 让用户下次点这一行时只收起而打不开任务。
 */
const RESTORE_WINDOW_MS = 5000;

const DEFAULT_ROW_SELECTOR = '.task-item.sb-task-row';
const DEFAULT_CONTENT_SELECTOR = '.sb-task-row-main';
const DEFAULT_DELETE_SELECTOR = '.sb-swipe-delete';
/** 可编辑元素：内部按下/拖动是文本选择手势，手势类交互（左滑/框选）都要让路 */
export const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

export type SwipeAxis = 'x' | 'y' | null;

export interface SidebarSwipeDeleteOptions {
    /** 点击展开后的删除按钮时回调，参数为任务 id */
    onDelete: (taskId: string) => void;
    /** 返回 true 时整个手势挂起（如任务列表进入多选形态，避免吞掉选择点击） */
    isSuspended?: () => boolean;
    rowSelector?: string;
    contentSelector?: string;
    deleteSelector?: string;
}

export interface SidebarSwipeDeleteController {
    destroy: () => void;
    /**
     * 列表重渲染（innerHTML 重建）后按任务 id 找回展开行并恢复展开态。
     *
     * 任务状态推送会经 RAF 防抖触发 reloadTaskList，不恢复的话用户刚划出删除按钮
     * 就被刷新收走，手指落下去变成「打开任务」。任务已不在列表（被删除/过滤掉）则清除展开态。
     */
    restoreOpenRow: () => void;
}

/**
 * 判定手势轴向：位移未过门槛返回 null（继续观察）；横向位移明显占优返回 'x'，
 * 否则返回 'y'（交给原生竖向滚动，本手势放弃）。
 */
export function resolveSwipeAxis(dx: number, dy: number, lockPx = AXIS_LOCK_PX, ratio = AXIS_X_RATIO): SwipeAxis {
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX < lockPx && absY < lockPx) return null;
    return absX >= absY * ratio ? 'x' : 'y';
}

/** 把横向位移换算成内容层位移：只接受向左（负值），并限制最大位移 */
export function clampSwipeOffset(dx: number, maxOffset = MAX_OFFSET_PX): number {
    return Math.max(-maxOffset, Math.min(0, dx));
}

/** 松手时是否应保持展开（offset 为 clampSwipeOffset 的结果，负值表示左滑） */
export function shouldRevealSwipe(offset: number, revealPx = REVEAL_PX): boolean {
    return -offset >= revealPx;
}

interface SwipeGesture {
    row: HTMLElement;
    content: HTMLElement;
    touchId: number;
    startX: number;
    startY: number;
    axis: SwipeAxis;
    offset: number;
}

function findTouch(touchList: any, identifier: number): any {
    if (!touchList) return null;
    for (let i = 0; i < touchList.length; i++) {
        if (touchList[i].identifier === identifier) return touchList[i];
    }
    return null;
}

function touchPoint(event: any): { x: number; y: number; id: number } | null {
    const touch = event && event.changedTouches && event.changedTouches[0];
    if (!touch) return null;
    return { x: touch.clientX, y: touch.clientY, id: touch.identifier };
}

function closestFrom(target: any, selector: string): any {
    if (!target) return null;
    if (typeof target.closest === 'function') return target.closest(selector);
    return null;
}

/**
 * 在容器上挂载左滑删除手势。容器内的任务行由 innerHTML 重渲染，因此所有
 * 监听都以事件委托挂在容器（或 document）上，行级状态只靠 class 与内联位移表达。
 */
export function attachSidebarSwipeDelete(
    container: HTMLElement,
    options: SidebarSwipeDeleteOptions
): SidebarSwipeDeleteController {
    const rowSelector = options.rowSelector || DEFAULT_ROW_SELECTOR;
    const contentSelector = options.contentSelector || DEFAULT_CONTENT_SELECTOR;
    const deleteSelector = options.deleteSelector || DEFAULT_DELETE_SELECTOR;

    let gesture: SwipeGesture | null = null;
    let openRow: HTMLElement | null = null;
    /** 展开行的任务 id：行 DOM 会被列表重渲染替换，靠它把展开态迁移到新节点上 */
    let openTaskId: string | null = null;
    /** 展开时刻，用于限制跨重渲染的保留窗口 */
    let openAt = 0;
    let suppressClickTimer: any = null;

    /** 行内内容层的横向位移；置空字符串回到 CSS 默认位（0）并触发回弹过渡 */
    function setContentOffset(content: HTMLElement, offset: number): void {
        content.style.transform = offset === 0 ? '' : `translateX(${offset}px)`;
    }

    /** 按任务 id 在容器里找行；用遍历而非属性选择器，避免 task_id 需要转义 */
    function findRowByTaskId(taskId: string): HTMLElement | null {
        const rows = container.querySelectorAll(rowSelector);
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i] as HTMLElement;
            if (row.dataset && row.dataset.task_id === taskId) return row;
        }
        return null;
    }

    function applyOpenState(row: HTMLElement): void {
        row.classList.add('is-swipe-open', 'is-swipe-peek');
        const content = row.querySelector(contentSelector) as HTMLElement | null;
        if (content) setContentOffset(content, -OPEN_OFFSET_PX);
    }

    function closeRow(row: HTMLElement): void {
        row.classList.remove('is-swipe-open', 'is-swipe-peek', 'is-swipe-dragging');
        const content = row.querySelector(contentSelector) as HTMLElement | null;
        if (content) setContentOffset(content, 0);
        if (openRow === row) {
            openRow = null;
            openTaskId = null;
        }
    }

    function closeOpenRow(): void {
        if (!openRow) return;
        const row = openRow;
        openRow = null;
        openTaskId = null;
        if (row.isConnected) closeRow(row);
    }

    function resetGesture(): void {
        if (!gesture) return;
        const { row, content } = gesture;
        const wasDragging = row.classList.contains('is-swipe-dragging');
        gesture = null;
        if (!wasDragging || !row.isConnected) return;
        row.classList.remove('is-swipe-dragging');
        // 手势被打断时回到该行的既定状态：展开态回停位，否则回弹，不能停在半开位置
        setContentOffset(content, row.classList.contains('is-swipe-open') ? -OPEN_OFFSET_PX : 0);
    }

    /** 吞掉松手后 Chromium 补发的合成 click，避免左滑刚结束就打开任务 */
    function armClickSuppress(): void {
        if (suppressClickTimer) clearTimeout(suppressClickTimer);
        suppressClickTimer = setTimeout(() => {
            suppressClickTimer = null;
        }, CLICK_SUPPRESS_MS);
    }

    function onTouchStart(event: any): void {
        if (options.isSuspended?.()) return;
        resetGesture();
        const target = event.target;
        // 已展开时点删除按钮属于点击意图，不进入滑动手势（也不因此收起展开行）
        if (closestFrom(target, deleteSelector)) return;
        // 内联重命名的输入框内横向拖动是选词/移光标，不能被左滑劫持
        if (closestFrom(target, EDITABLE_SELECTOR)) return;
        // 多指视为缩放/其它手势
        if (event.touches && event.touches.length !== 1) {
            closeOpenRow();
            return;
        }
        const row = closestFrom(target, rowSelector);
        if (!row || !container.contains(row)) {
            closeOpenRow();
            return;
        }
        if (openRow && openRow !== row) closeOpenRow();
        const point = touchPoint(event);
        if (!point) return;
        const content = row.querySelector(contentSelector) as HTMLElement | null;
        gesture = {
            row,
            content: content || row,
            touchId: point.id,
            startX: point.x,
            startY: point.y,
            axis: null,
            offset: 0
        };
    }

    function onTouchMove(event: any): void {
        if (!gesture) return;
        if (options.isSuspended?.()) {
            resetGesture();
            return;
        }
        const touch = findTouch(event.changedTouches, gesture.touchId);
        if (!touch) return;
        const dx = touch.clientX - gesture.startX;
        const dy = touch.clientY - gesture.startY;
        if (!gesture.axis) {
            gesture.axis = resolveSwipeAxis(dx, dy);
            // 锁定纵向：交还原生列表滚动，本次手势彻底放弃
            if (gesture.axis === 'y') {
                gesture = null;
                return;
            }
            // 位移还没过判轴门槛：继续观察，绝不能当成放弃（真实触摸屏的 touchmove
            // 往往每 1~5px 就来一次，首个事件几乎都在门槛内，放弃会让左滑永远无法开始）
            if (gesture.axis !== 'x') return;
            gesture.row.classList.add('is-swipe-dragging');
        }
        const offset = clampSwipeOffset(dx);
        gesture.offset = offset;
        setContentOffset(gesture.content, offset);
        gesture.row.classList.toggle('is-swipe-peek', -offset >= PEEK_PX);
    }

    function onTouchEnd(event: any): void {
        if (!gesture) return;
        if (!findTouch(event.changedTouches, gesture.touchId)) return;
        const { row, axis, offset } = gesture;
        gesture = null;
        // 未锁定横向（纯点击或纵向滚动）不产生合成 click 风险，也不改动画
        if (axis !== 'x') return;
        // 列表在手势期间被重渲染：旧节点已作废，无内容可展开，也不该吞掉后续点击
        if (!row.isConnected) {
            openRow = null;
            openTaskId = null;
            return;
        }
        armClickSuppress();
        row.classList.remove('is-swipe-dragging');
        if (shouldRevealSwipe(offset)) {
            applyOpenState(row);
            openRow = row;
            openTaskId = row.dataset ? row.dataset.task_id || null : null;
            openAt = Date.now();
        } else {
            closeRow(row);
        }
    }

    function onClickCapture(event: any): void {
        if (options.isSuspended?.()) return;
        if (suppressClickTimer) {
            clearTimeout(suppressClickTimer);
            suppressClickTimer = null;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        const button = closestFrom(event.target, deleteSelector);
        if (button) {
            // 阻止冒泡到任务行的「打开任务」点击
            event.preventDefault();
            event.stopPropagation();
            const row = closestFrom(button, rowSelector);
            const taskId = (button.dataset && button.dataset.task_id) || (row && row.dataset && row.dataset.task_id);
            closeOpenRow();
            if (taskId) options.onDelete(taskId);
            return;
        }
        // 展开态下点行内其它区域视为收起，不打开任务
        if (openRow && closestFrom(event.target, rowSelector) === openRow) {
            event.preventDefault();
            event.stopPropagation();
            closeOpenRow();
        }
    }

    function onDocumentTouchStart(event: any): void {
        if (!openRow) return;
        if (closestFrom(event.target, rowSelector) === openRow) return;
        closeOpenRow();
    }

    /**
     * 鼠标/触控笔按下时收起展开态。触摸监听覆盖不到鼠标：触摸屏划出删除按钮后
     * 改用鼠标点别处（含右键弹菜单）时，展开态会一直挂着。右键同样会派发
     * mousedown，且早于 contextmenu，因此收起发生在任务右键菜单弹出之前。
     */
    function onDocumentMouseDown(event: any): void {
        if (!openRow) return;
        if (closestFrom(event.target, rowSelector) === openRow) return;
        closeOpenRow();
    }

    /**
     * Esc 退出左滑展开态。不拦截事件，也不判断修饰键：弹窗、右键菜单等其它 Esc
     * 语义照常生效（点删除/右键时展开态已收起，两者不会互相抢）。
     */
    function onDocumentKeyDown(event: any): void {
        if (!openRow) return;
        if (event.key !== 'Escape') return;
        closeOpenRow();
    }

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', onTouchEnd);
    container.addEventListener('touchcancel', onTouchEnd);
    container.addEventListener('click', onClickCapture, true);
    document.addEventListener('touchstart', onDocumentTouchStart, true);
    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('keydown', onDocumentKeyDown);

    return {
        restoreOpenRow(): void {
            if (!openTaskId || gesture) return;
            // 超过保留窗口或任务已不在列表：不再复活，统一收起
            const row = Date.now() - openAt > RESTORE_WINDOW_MS ? null : findRowByTaskId(openTaskId);
            if (!row) {
                closeOpenRow();
                return;
            }
            openRow = row;
            applyOpenState(row);
        },
        destroy(): void {
            resetGesture();
            closeOpenRow();
            if (suppressClickTimer) clearTimeout(suppressClickTimer);
            suppressClickTimer = null;
            container.removeEventListener('touchstart', onTouchStart);
            container.removeEventListener('touchmove', onTouchMove);
            container.removeEventListener('touchend', onTouchEnd);
            container.removeEventListener('touchcancel', onTouchEnd);
            container.removeEventListener('click', onClickCapture, true);
            document.removeEventListener('touchstart', onDocumentTouchStart, true);
            document.removeEventListener('mousedown', onDocumentMouseDown, true);
            document.removeEventListener('keydown', onDocumentKeyDown);
        }
    };
}
