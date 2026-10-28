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
 * 侧边栏任务列表「多选模式」的框选与退出交互控制器。
 *
 * 多选状态本身由宿主（sidebar.js）持有（_multiSelect / _multiSelectIds /
 * _multiSelectAnchorId），行内点选（Ctrl/Cmd/Shift）也由宿主在行点击里处理；
 * 这里只负责三块：
 *
 * 1. 框选（rubber band）：仅鼠标。在任务列表空白处按住左键拖动，松开时若选区
 *    覆盖 >= 2 个任务则进入多选并选中覆盖的任务（门槛见 sidebarMultiSelect.ts，
 *    覆盖 0/1 个任务时静默放弃，防误操作）。拖到列表上下边缘自动滚动。
 *    触屏不做框选：单指滑动是自然的列表滚动手势，且多选态的触摸操作统一走退出。
 * 2. 多选态的退出路径：选区外点击（带修饰键的点击是选择手势，不退出）、
 *    任何触屏操作（多选菜单内除外）、Esc 键。
 * 3. 列表重渲染后把选中集合同步到新行节点（is-multi-selected class）。
 *
 * 行由 innerHTML 重渲染，因此监听全部以委托方式挂在容器与 document 上，
 * 行级状态只靠 class 表达。判定门槛等纯逻辑在 sidebarMultiSelect.ts，便于单测。
 */

import { shouldStartMarquee } from './sidebarMultiSelect.js';
import { EDITABLE_SELECTOR } from './sidebarSwipeDelete.js';

const DEFAULT_ROW_SELECTOR = '.task-item.sb-task-row';
const DEFAULT_GROUPS_SELECTOR = '.sb-task-groups';
/** 拖动超过该距离才算一次有意的框选，避免误触 */
const MARQUEE_MIN_DRAG_PX = 6;
/** 框选拖到列表上下边缘时的自动滚动速度（px/帧） */
const MARQUEE_AUTOSCROLL_SPEED = 8;
/** 框选松手后拦截合成 click 的窗口（ms），与 sidebarSwipeDelete 的做法一致 */
const CLICK_SUPPRESS_MS = 150;
/** 组头/加载更多等非任务行区域：按住不进入框选（组头是开合语义） */
const NON_ROW_SELECTOR = 'summary, .sb-load-more';
/** 展开分组内的独立滚动容器：time/workspace 视图的任务行在内层 body 里滚动 */
const GROUP_BODY_SELECTOR = '.sb-task-group[open] .sb-task-group-body';

interface MarqueeRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface SidebarMultiSelectOptions {
    rowSelector?: string;
    groupsSelector?: string;
    /** 当前是否处于多选状态 */
    isMultiSelect: () => boolean;
    /** 进入/退出多选状态（宿主负责重渲染与菜单收起） */
    setMultiSelect: (on: boolean) => void;
    /** 当前选中任务 id 集合 */
    getSelection: () => Set<string>;
    /** 框选命中后更新选中集合（宿主负责刷新行样式，不重渲染） */
    setSelection: (ids: Set<string>, anchorId: string | null) => void;
}

export interface SidebarMultiSelectController {
    destroy: () => void;
    /**
     * 列表重渲染（innerHTML 重建）后同步多选态到新节点：
     * 选中集合不变，仅按新 DOM 刷新行的选中样式。
     */
    syncAfterRender: () => void;
}

function closestFrom(target: any, selector: string): any {
    if (!target) return null;
    if (typeof target.closest === 'function') return target.closest(selector);
    return null;
}

/**
 * 在任务列表容器上挂载框选与多选退出交互。
 */
export function attachSidebarMultiSelect(
    container: HTMLElement,
    options: SidebarMultiSelectOptions
): SidebarMultiSelectController {
    const rowSelector = options.rowSelector || DEFAULT_ROW_SELECTOR;
    const groupsSelector = options.groupsSelector || DEFAULT_GROUPS_SELECTOR;

    let marquee: {
        startX: number;
        startY: number;
        lastX: number;
        lastY: number;
        active: boolean;
    } | null = null;
    /** 本次框选拖动中扫过（任一时刻与选区相交）的任务 id：自动滚动累积语义 */
    const marqueeScannedIds = new Set<string>();
    let box: HTMLElement | null = null;
    let scrollRaf: number | null = null;
    let suppressClickTimer: any = null;
    // document 级监听挂 ownerDocument 而非全局 document：不依赖全局单例，
    // 也让测试可以在 linkedom 的隔离文档里验证委托行为。
    const doc = container.ownerDocument;

    function rows(): HTMLElement[] {
        return Array.from(container.querySelectorAll(rowSelector)) as HTMLElement[];
    }

    /** 选中集合变化后刷新行样式；不触发列表重渲染，避免打断框选手势 */
    function refreshRowClasses(): void {
        const selected = options.getSelection();
        for (const row of rows()) {
            const taskId = row.dataset ? row.dataset.task_id : undefined;
            const isSelected = !!taskId && selected.has(taskId);
            row.classList.toggle('is-multi-selected', isSelected);
            // 圆形选择框的选中态需与行同步：点选/框选只改集合不重渲染行
            const checkbox = row.querySelector('.sb-multi-checkbox');
            if (checkbox) checkbox.classList.toggle('is-checked', isSelected);
        }
    }

    function removeMarqueeBox(): void {
        if (!box) return;
        box.remove();
        box = null;
    }

    function stopAutoScroll(): void {
        if (scrollRaf !== null) {
            cancelAnimationFrame(scrollRaf);
            scrollRaf = null;
        }
    }

    /**
     * 拖动期间缓存一次行几何，mousemove 高频路径不再反复 getBoundingClientRect
     * （每帧全量读 rect 会强制同步 layout）。自动滚动改变行位置时以两容器的
     * scrollTop 增量修正缓存，与真实视口位置保持一致。
     */
    interface CachedRowRect {
        row: HTMLElement;
        taskId: string;
        left: number;
        right: number;
        top: number;
        bottom: number;
    }
    let rowRects: CachedRowRect[] | null = null;
    let cacheOuterScrollTop = 0;
    let cacheInnerScrollTop = 0;
    let cachedInnerScrollEl: HTMLElement | null = null;
    /** 拖动中列表重建后游离的旧行：hover 已标在它们身上，松手时需一并清理 */
    let detachedHoverRows: HTMLElement[] = [];

    function captureRowRects(): void {
        // 重新捕获前把失联的旧行挪进游离清单，保证松手时 hover 能被清干净
        if (rowRects) {
            for (const entry of rowRects) {
                if (!entry.row.isConnected && entry.row.classList.contains('is-marquee-hover')) {
                    detachedHoverRows.push(entry.row);
                }
            }
        }
        const inner = container.querySelector(GROUP_BODY_SELECTOR) as HTMLElement | null;
        cachedInnerScrollEl = inner;
        cacheOuterScrollTop = (container.querySelector(groupsSelector) as HTMLElement | null)?.scrollTop ?? 0;
        cacheInnerScrollTop = inner?.scrollTop ?? 0;
        rowRects = rows().map((row) => {
            const r = row.getBoundingClientRect();
            return {
                row,
                taskId: (row.dataset && row.dataset.task_id) || '',
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom
            };
        });
    }

    function releaseRowRects(): void {
        rowRects = null;
        cachedInnerScrollEl = null;
    }
    function innerScrollDelta(): number {
        if (!cachedInnerScrollEl) return 0;
        return cachedInnerScrollEl.scrollTop - cacheInnerScrollTop;
    }

    function outerScrollDelta(): number {
        const outer = container.querySelector(groupsSelector) as HTMLElement | null;
        return (outer?.scrollTop ?? 0) - cacheOuterScrollTop;
    }

    /** 取当前有效行几何：缓存存在时按滚动增量修正，否则实时读取 */
    function rowGeometry(): CachedRowRect[] {
        // 拖动中列表可能被重建（重命名确认、订阅刷新都会触发 reloadTaskList）：
        // 缓存的行一旦游离，缓存整体作废，重新捕获一次避免 hover/命中打在旧节点上
        if (rowRects && !rowRects[0]?.row?.isConnected) {
            captureRowRects();
        }
        if (!rowRects) {
            return rows().map((row) => {
                const r = row.getBoundingClientRect();
                return {
                    row,
                    taskId: (row.dataset && row.dataset.task_id) || '',
                    left: r.left,
                    right: r.right,
                    top: r.top,
                    bottom: r.bottom
                };
            });
        }
        const delta = innerScrollDelta() + outerScrollDelta();
        if (delta === 0) return rowRects;
        return rowRects.map((entry) => ({ ...entry, top: entry.top - delta, bottom: entry.bottom - delta }));
    }

    /** 计算选区覆盖的行；用几何相交而非 elementFromPoint，半覆盖的行也能命中 */
    function rowsInRect(rect: MarqueeRect): Set<string> {
        const hit = new Set<string>();
        for (const entry of rowGeometry()) {
            const intersects =
                entry.left < rect.right &&
                entry.right > rect.left &&
                entry.top < rect.bottom &&
                entry.bottom > rect.top;
            if (intersects && entry.taskId) hit.add(entry.taskId);
        }
        return hit;
    }

    function ensureBox(): void {
        if (box && box.isConnected) return;
        box = doc.createElement('div');
        box.className = 'sb-marquee-box';
        doc.body.appendChild(box);
    }

    /** 当前选区的视口矩形 */
    function marqueeRect(): MarqueeRect | null {
        if (!marquee) return null;
        return {
            left: Math.min(marquee.startX, marquee.lastX),
            top: Math.min(marquee.startY, marquee.lastY),
            right: Math.max(marquee.startX, marquee.lastX),
            bottom: Math.max(marquee.startY, marquee.lastY)
        };
    }

    function updateBox(): void {
        if (!marquee || !box) return;
        const left = Math.min(marquee.startX, marquee.lastX);
        const top = Math.min(marquee.startY, marquee.lastY);
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.style.width = `${Math.abs(marquee.lastX - marquee.startX)}px`;
        box.style.height = `${Math.abs(marquee.lastY - marquee.startY)}px`;
        const rect = marqueeRect();
        const hit = rect ? rowsInRect(rect) : new Set<string>();
        // 累积语义：自动滚动会让行移出固定选区，扫过即入集，松手时不丢行
        for (const id of hit) marqueeScannedIds.add(id);
        for (const { row, taskId } of rowGeometry()) {
            row.classList.toggle('is-marquee-hover', !!taskId && hit.has(taskId));
        }
    }

    /** 框选拖到列表上下边缘时持续滚动，让用户能框到视口外的任务 */
    function startAutoScroll(): void {
        if (scrollRaf !== null) return;
        const outer = container.querySelector(groupsSelector) as HTMLElement | null;
        if (!outer) return;
        const step = () => {
            if (!marquee || !outer.isConnected) {
                stopAutoScroll();
                return;
            }
            // 光标落在展开分组的内层 body 内 → 滚内层；否则滚外层列表
            const body = container.querySelector(GROUP_BODY_SELECTOR) as HTMLElement | null;
            const bodyRect = body ? body.getBoundingClientRect() : null;
            const cursorInBody =
                !!bodyRect &&
                marquee.lastX >= bodyRect.left &&
                marquee.lastX <= bodyRect.right &&
                marquee.lastY >= bodyRect.top &&
                marquee.lastY <= bodyRect.bottom;
            const scrollEl = cursorInBody && body ? body : outer;
            const rect = scrollEl.getBoundingClientRect();
            if (marquee.lastY < rect.top + 24) {
                scrollEl.scrollTop -= MARQUEE_AUTOSCROLL_SPEED;
            } else if (marquee.lastY > rect.bottom - 24) {
                scrollEl.scrollTop += MARQUEE_AUTOSCROLL_SPEED;
            }
            updateBox();
            scrollRaf = requestAnimationFrame(step);
        };
        scrollRaf = requestAnimationFrame(step);
    }

    function beginMarquee(x: number, y: number): void {
        ensureBox();
        marquee = { startX: x, startY: y, lastX: x, lastY: y, active: false };
        marqueeScannedIds.clear();
        detachedHoverRows = [];
        updateBox();
    }

    function moveMarquee(x: number, y: number): void {
        if (!marquee) return;
        marquee.lastX = x;
        marquee.lastY = y;
        if (!marquee.active) {
            if (Math.hypot(x - marquee.startX, y - marquee.startY) < MARQUEE_MIN_DRAG_PX) return;
            marquee.active = true;
            // 拖动期间临时禁文本选择；常规态不受影响（任务名仍可选中复制）
            doc.documentElement?.classList?.add('sb-marquee-active');
            // 进入框选即退出行内重命名：输入框 blur 收起，避免手势与编辑态叠着
            const activeEl = doc.activeElement as HTMLElement | null;
            if (activeEl && closestFrom(activeEl, rowSelector) && activeEl.matches?.(EDITABLE_SELECTOR)) {
                activeEl.blur();
            }
            captureRowRects();
        }
        updateBox();
    }

    function finishMarquee(): void {
        if (!marquee) return;
        const { active } = marquee;
        const rect = marqueeRect();
        stopAutoScroll();
        removeMarqueeBox();
        marquee = null;
        releaseRowRects();
        doc.documentElement?.classList?.remove('sb-marquee-active');
        if (!active) return;
        // 累积语义：命中 = 当前选区几何 ∪ 拖动过程中扫过的全部行（自动滚动导致的移出不再丢失）
        const hit = rect ? rowsInRect(rect) : new Set<string>();
        for (const id of marqueeScannedIds) hit.add(id);
        // 清 hover 需覆盖游离的旧行节点：rows() 只能查到在册节点，
        // 框选期间被重建的行把 hover 样式带在身上，必须从游离清单里摘掉
        for (const row of detachedHoverRows) row.classList.remove('is-marquee-hover');
        detachedHoverRows = [];
        for (const row of rows()) row.classList.remove('is-marquee-hover');
        // 拖动过但未达框选门槛：同样吞掉合成 click，避免误开任务；不进入多选
        if (!shouldStartMarquee(hit.size)) {
            armClickSuppress();
            return;
        }
        options.setSelection(hit, null);
        options.setMultiSelect(true);
        armClickSuppress();
    }

    function onMouseDown(event: MouseEvent): void {
        if (event.button !== 0) return;
        const target = event.target as any;
        // 行内可编辑元素（重命名输入框等）上按下是文本选择手势，不启动框选
        if (closestFrom(target, EDITABLE_SELECTOR)) return;
        // 常规态下组头是开合、加载更多是翻页，不从这些控件上启动框选；
        // 任务行允许作为框选起点：未拖动仍是普通点击（打开/选择），拖动超阈值
        // 则吞掉行 click 进入框选（用户最自然的框选手势就是按住行拖动）。
        const inRow = !!closestFrom(target, rowSelector);
        const inNonRow = !!closestFrom(target, NON_ROW_SELECTOR);
        if (inNonRow && !options.isMultiSelect()) return;
        if (!inRow && !inNonRow && !closestFrom(target, groupsSelector) && target !== container) return;
        // 多选态下带修饰键的按下是选择手势，不启动框选
        if (event.ctrlKey || event.metaKey || event.shiftKey) return;
        beginMarquee(event.clientX, event.clientY);
        doc.addEventListener('mousemove', onMouseMove);
        doc.addEventListener('mouseup', onMouseUp);
    }

    function onMouseMove(event: MouseEvent): void {
        if (!marquee) return;
        moveMarquee(event.clientX, event.clientY);
        if (marquee && marquee.active) startAutoScroll();
    }

    function onMouseUp(): void {
        if (!marquee) return;
        finishMarquee();
        doc.removeEventListener('mousemove', onMouseMove);
        doc.removeEventListener('mouseup', onMouseUp);
    }

    function armClickSuppress(): void {
        if (suppressClickTimer) clearTimeout(suppressClickTimer);
        suppressClickTimer = setTimeout(() => {
            suppressClickTimer = null;
        }, CLICK_SUPPRESS_MS);
    }

    /** 吞掉框选松手后 Chromium 补发的合成 click，避免立刻打开任务或退出多选 */
    function onClickCapture(event: MouseEvent): void {
        if (!suppressClickTimer) return;
        clearTimeout(suppressClickTimer);
        suppressClickTimer = null;
        event.preventDefault();
        event.stopPropagation();
    }

    /**
     * 多选态下点击「列表区域之外」退出多选。
     *
     * 任务行内（含行间空隙、组头）的点击一律交给行点击/组头开合逻辑处理：
     * - 选中行普通点击 = toggle 取消；未选中行 = 单选该行；Ctrl/Shift = 修饰选。
     *   这些都在 sidebar.js 的行 click handler 里完成，这里提前退出会吞掉 Shift/Ctrl
     *   （document 捕获先于行 handler 触发，一旦退出多选，行 handler 就走打开任务分支）。
     * - 多选菜单内的点击不退出。
     */
    function onDocumentClickCapture(event: MouseEvent): void {
        if (!options.isMultiSelect()) return;
        if (event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (modalOpen()) return;
        const target = event.target as any;
        // 侧边栏内的浮层菜单（多选菜单、常规右键菜单、debug 菜单等）都挂在 sidebar
        // 子树内：菜单项点击交给各自 handler，不能当「列表外点击」退出多选
        // （如常规菜单的「选择多个任务」要在保留选区的前提下切回多选形态）。
        if (closestFrom(target, '.ctx-menu') || closestFrom(target, '.sb-multi-menu')) return;
        // 任务列表区域内的点击（含行与空白）不在此退出，交给行/框选逻辑
        if (closestFrom(target, groupsSelector) || container.contains(target)) return;
        options.setMultiSelect(false);
    }

    /** 多选态下任何触屏操作都退出（浮层菜单与弹窗内除外） */
    function onDocumentTouchStartCapture(event: TouchEvent): void {
        if (!options.isMultiSelect()) return;
        if (closestFrom(event.target as any, '.sb-multi-menu') || closestFrom(event.target as any, '.ctx-menu')) {
            return;
        }
        if (modalOpen()) return;
        // 先退出多选，再吞掉本次触屏的后续事件，避免退出重渲染后触点落在新行上误开任务
        options.setMultiSelect(false);
        // 触点在多选列表区域内才吞事件（防误开任务）；区域外的头部按钮等保持原功能
        if (closestFrom(event.target as any, groupsSelector) || container.contains(event.target as any)) {
            event.preventDefault();
            event.stopPropagation();
        }
    }

    /** 确认/反馈弹窗、原生 modal dialog（如任务搜索）打开时，Esc 与外点交互归弹窗所有 */
    function modalOpen(): boolean {
        if (doc.querySelector('.od-confirm-modal-overlay')) return true;
        return !!doc.querySelector('dialog[open]');
    }

    function onDocumentKeyDown(event: KeyboardEvent): void {
        if (event.key !== 'Escape') return;
        if (modalOpen()) return;
        if (options.isMultiSelect()) options.setMultiSelect(false);
    }

    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('click', onClickCapture, true);
    doc.addEventListener('click', onDocumentClickCapture, true);
    doc.addEventListener('touchstart', onDocumentTouchStartCapture, true);
    doc.addEventListener('keydown', onDocumentKeyDown);

    return {
        syncAfterRender(): void {
            refreshRowClasses();
        },
        destroy(): void {
            stopAutoScroll();
            removeMarqueeBox();
            marquee = null;
            releaseRowRects();
            doc.documentElement?.classList?.remove('sb-marquee-active');
            // onMouseUp 在 marquee 为 null 时不会自清理，销毁时兜底摘掉拖动监听
            doc.removeEventListener('mousemove', onMouseMove);
            doc.removeEventListener('mouseup', onMouseUp);
            if (suppressClickTimer) clearTimeout(suppressClickTimer);
            suppressClickTimer = null;
            container.removeEventListener('mousedown', onMouseDown);
            container.removeEventListener('click', onClickCapture, true);
            doc.removeEventListener('click', onDocumentClickCapture, true);
            doc.removeEventListener('touchstart', onDocumentTouchStartCapture, true);
            doc.removeEventListener('keydown', onDocumentKeyDown);
        }
    };
}
