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
 * 侧边栏任务列表「多选」模式的纯判定逻辑，与 DOM 控制器（sidebar.js）分离，
 * 便于单测直接验证边界。
 *
 * - Ctrl/Cmd 点选：toggleTaskId
 * - Shift 区间选：rangeByAnchor（按列表渲染顺序取锚点到目标的连续区间）
 * - 框选进入多选的门槛：至少覆盖 MIN_MARQUEE_SELECTION 个任务才生效，防误操作
 */

/** 框选进入多选状态所需覆盖的最少任务数 */
export const MIN_MARQUEE_SELECTION = 2;

/** Ctrl/Cmd 点选：已选中则移除，未选中则添加。返回新集合，不修改入参 */
export function ctrlToggleId(selected: Set<string>, taskId: string): Set<string> {
    const next = new Set(selected);
    if (next.has(taskId)) {
        next.delete(taskId);
    } else {
        next.add(taskId);
    }
    return next;
}

/**
 * Shift 区间选：按列表渲染顺序取 anchorId 到 targetId 的连续区间（含两端）。
 * anchorId 不在列表中时退化为仅选中目标；targetId 不在列表中时返回空集。
 */
export function rangeByAnchor(orderedIds: readonly string[], anchorId: string | null, targetId: string): Set<string> {
    const targetIndex = orderedIds.indexOf(targetId);
    if (targetIndex < 0) return new Set();
    const anchorIndex = anchorId === null ? -1 : orderedIds.indexOf(anchorId);
    if (anchorIndex < 0) return new Set([targetId]);
    const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    return new Set(orderedIds.slice(start, end + 1));
}

/** 框选结束时是否应进入多选状态：选区需覆盖至少 MIN_MARQUEE_SELECTION 个任务 */
export function shouldStartMarquee(selectedCount: number, minSelection = MIN_MARQUEE_SELECTION): boolean {
    return selectedCount >= minSelection;
}
