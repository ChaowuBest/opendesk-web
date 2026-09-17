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

export const GRID_COLUMNS = 32;
export const GRID_ROWS = 20;
export const MIN_CARD_GRID_W = 4;
export const MIN_CARD_GRID_H = 4;
export const DEFAULT_CARD_GRID_W = 8;
export const DEFAULT_CARD_GRID_H = 6;
export const CARD_GRID_INSET = 8;
/** 缩放手柄的可点击厚度（px） */
export const RESIZE_HANDLE_THICKNESS = 8;

export type ResizeDir = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export type GridRect = {
    gridX: number;
    gridY: number;
    gridW: number;
    gridH: number;
};

export type GridMetrics = {
    left: number;
    top: number;
    width: number;
    height: number;
    cellW: number;
    cellH: number;
    viewportScaleX: number;
    viewportScaleY: number;
};

export type PixelRect = {
    left: number;
    top: number;
    width: number;
    height: number;
};

export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/**
 * 计算网格在本地 CSS 像素空间中的单元格尺寸。
 * getBoundingClientRect() 会包含祖先 transform，不能直接用它的宽高设置绝对定位子元素。
 */
export function computeGridMetrics(
    stageRect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
    localSize: { width: number; height: number } = stageRect
): GridMetrics | null {
    const cellW = localSize.width / GRID_COLUMNS;
    const cellH = localSize.height / GRID_ROWS;
    const viewportScaleX = stageRect.width / localSize.width;
    const viewportScaleY = stageRect.height / localSize.height;
    if (
        !Number.isFinite(cellW) ||
        !Number.isFinite(cellH) ||
        cellW <= 0 ||
        cellH <= 0 ||
        !Number.isFinite(viewportScaleX) ||
        !Number.isFinite(viewportScaleY) ||
        viewportScaleX <= 0 ||
        viewportScaleY <= 0
    )
        return null;
    return {
        left: stageRect.left,
        top: stageRect.top,
        width: localSize.width,
        height: localSize.height,
        cellW,
        cellH,
        viewportScaleX,
        viewportScaleY
    };
}

export function gridRectToPixel(rect: GridRect, metrics: GridMetrics): PixelRect {
    const inset = cardGridInset(metrics);
    return {
        left: rect.gridX * metrics.cellW + inset,
        top: rect.gridY * metrics.cellH + inset,
        width: rect.gridW * metrics.cellW - inset * 2,
        height: rect.gridH * metrics.cellH - inset * 2
    };
}

function cardGridInset(metrics: GridMetrics): number {
    return Math.min(CARD_GRID_INSET, metrics.cellW, metrics.cellH);
}

/** 将像素矩形吸附到最近的网格单元，并约束在网格边界与最小尺寸内。 */
export function snapPixelRectToGrid(
    rect: PixelRect,
    metrics: GridMetrics,
    minW: number = MIN_CARD_GRID_W,
    minH: number = MIN_CARD_GRID_H
): GridRect {
    const inset = cardGridInset(metrics);
    const width = Math.max(rect.width + inset * 2, minW * metrics.cellW);
    const height = Math.max(rect.height + inset * 2, minH * metrics.cellH);
    const snapTo = (value: number): number => Math.round(value);
    const gridW = clamp(snapTo(width / metrics.cellW), minW, GRID_COLUMNS);
    const gridH = clamp(snapTo(height / metrics.cellH), minH, GRID_ROWS);
    let gridX = clamp(snapTo((rect.left - inset) / metrics.cellW), 0, GRID_COLUMNS - gridW);
    let gridY = clamp(snapTo((rect.top - inset) / metrics.cellH), 0, GRID_ROWS - gridH);
    if (gridX + gridW > GRID_COLUMNS) gridX = GRID_COLUMNS - gridW;
    if (gridY + gridH > GRID_ROWS) gridY = GRID_ROWS - gridH;
    return { gridX, gridY, gridW, gridH };
}

export function rectsCollide(a: GridRect, b: GridRect): boolean {
    return (
        a.gridX < b.gridX + b.gridW &&
        a.gridX + a.gridW > b.gridX &&
        a.gridY < b.gridY + b.gridH &&
        a.gridY + a.gridH > b.gridY
    );
}

/** 检查矩形是否与其他卡片（excludeId 除外）重叠。 */
export function layoutCollides(rect: GridRect, others: Array<GridRect & { id?: string }>, excludeId?: string): boolean {
    return others.some((card) => {
        if (excludeId !== undefined && card.id === excludeId) return false;
        return rectsCollide(rect, card);
    });
}

/**
 * 在 (gridX, gridY) 附近寻找第一个不冲突的默认尺寸布局；
 * 若起始位置可用则优先使用，否则按行扫描整个网格；全满时返回 null。
 */
export function findAvailableCardLayout(
    gridX: number,
    gridY: number,
    others: Array<GridRect>,
    gridW: number = DEFAULT_CARD_GRID_W,
    gridH: number = DEFAULT_CARD_GRID_H
): GridRect | null {
    const width = clamp(gridW, MIN_CARD_GRID_W, GRID_COLUMNS);
    const height = clamp(gridH, MIN_CARD_GRID_H, GRID_ROWS);
    const startX = clamp(gridX, 0, GRID_COLUMNS - width);
    const startY = clamp(gridY, 0, GRID_ROWS - height);
    const candidates: Array<{ gridX: number; gridY: number }> = [{ gridX: startX, gridY: startY }];
    for (let y = 0; y <= GRID_ROWS - height; y += 1) {
        for (let x = 0; x <= GRID_COLUMNS - width; x += 1) {
            candidates.push({ gridX: x, gridY: y });
        }
    }
    const found = candidates.find(
        (candidate) => !layoutCollides({ ...candidate, gridW: width, gridH: height }, others)
    );
    return found ? { ...found, gridW: width, gridH: height } : null;
}

/** 拖动结束时选择离当前位置最近的空闲格位，不跨越已占用卡片。 */
export function findNearestAvailableCardLayout(desired: GridRect, others: GridRect[]): GridRect | null {
    const width = clamp(desired.gridW, MIN_CARD_GRID_W, GRID_COLUMNS);
    const height = clamp(desired.gridH, MIN_CARD_GRID_H, GRID_ROWS);
    let nearest: GridRect | null = null;
    let distance = Infinity;
    for (let y = 0; y <= GRID_ROWS - height; y += 1) {
        for (let x = 0; x <= GRID_COLUMNS - width; x += 1) {
            const candidate = { gridX: x, gridY: y, gridW: width, gridH: height };
            const nextDistance = (x - desired.gridX) ** 2 + (y - desired.gridY) ** 2;
            if (nextDistance < distance && !layoutCollides(candidate, others)) {
                nearest = candidate;
                distance = nextDistance;
            }
        }
    }
    return nearest;
}

/** 拖动只改变位置；无论交互期间舞台尺寸是否变化，都必须保留卡片原有格数。 */
export function resolveDraggedCardLayout(
    currentRect: PixelRect,
    interactionMetrics: GridMetrics,
    original: GridRect,
    others: GridRect[]
): GridRect {
    const snapped = snapPixelRectToGrid(currentRect, interactionMetrics);
    const desired = {
        gridX: clamp(snapped.gridX, 0, GRID_COLUMNS - original.gridW),
        gridY: clamp(snapped.gridY, 0, GRID_ROWS - original.gridH),
        gridW: original.gridW,
        gridH: original.gridH
    };
    const nearest = findNearestAvailableCardLayout(desired, others);
    return nearest && !layoutCollides(nearest, others) ? nearest : original;
}

/** 保持未拖动的边不变，找到最接近缩放目标且不碰撞的网格矩形。 */
export function fitResizedCardLayout(
    desired: GridRect,
    original: GridRect,
    dir: ResizeDir,
    others: GridRect[]
): GridRect {
    const right = original.gridX + original.gridW;
    const bottom = original.gridY + original.gridH;
    const desiredRight = desired.gridX + desired.gridW;
    const desiredBottom = desired.gridY + desired.gridH;
    let best = original;
    let distance = Infinity;
    const xStart = dir.includes('w') ? Math.min(original.gridX, desired.gridX) : original.gridX;
    const xEnd = dir.includes('w') ? Math.max(original.gridX, desired.gridX) : original.gridX;
    const rightStart = dir.includes('e') ? Math.min(right, desiredRight) : right;
    const rightEnd = dir.includes('e') ? Math.max(right, desiredRight) : right;
    const yStart = dir.includes('n') ? Math.min(original.gridY, desired.gridY) : original.gridY;
    const yEnd = dir.includes('n') ? Math.max(original.gridY, desired.gridY) : original.gridY;
    const bottomStart = dir.includes('s') ? Math.min(bottom, desiredBottom) : bottom;
    const bottomEnd = dir.includes('s') ? Math.max(bottom, desiredBottom) : bottom;
    for (let y = yStart; y <= yEnd; y += 1) {
        for (let x = xStart; x <= xEnd; x += 1) {
            for (let candidateRight = rightStart; candidateRight <= rightEnd; candidateRight += 1) {
                for (let candidateBottom = bottomStart; candidateBottom <= bottomEnd; candidateBottom += 1) {
                    const candidate = { gridX: x, gridY: y, gridW: candidateRight - x, gridH: candidateBottom - y };
                    if (
                        candidate.gridW < MIN_CARD_GRID_W ||
                        candidate.gridH < MIN_CARD_GRID_H ||
                        candidate.gridX < 0 ||
                        candidate.gridY < 0 ||
                        candidateRight > GRID_COLUMNS ||
                        candidateBottom > GRID_ROWS ||
                        layoutCollides(candidate, others)
                    )
                        continue;
                    const nextDistance =
                        (x - desired.gridX) ** 2 +
                        (y - desired.gridY) ** 2 +
                        (candidateRight - desiredRight) ** 2 +
                        (candidateBottom - desiredBottom) ** 2;
                    if (nextDistance < distance) {
                        best = candidate;
                        distance = nextDistance;
                    }
                }
            }
        }
    }
    return best;
}

/** 根据拖动方向与像素位移计算新的像素矩形，保证不小于最小尺寸且不超过网格边界。 */
export function resizePixelRect(
    dir: ResizeDir,
    startRect: PixelRect,
    dx: number,
    dy: number,
    metrics: GridMetrics,
    minW: number = MIN_CARD_GRID_W * 1,
    minH: number = MIN_CARD_GRID_H * 1,
    boundaryInset = 0
): PixelRect {
    let { left, top, width, height } = startRect;
    const maxWidth = metrics.width - boundaryInset;
    const maxHeight = metrics.height - boundaryInset;

    if (dir.includes('e')) {
        width = clamp(startRect.width + dx, minW, maxWidth - left);
    }
    if (dir.includes('s')) {
        height = clamp(startRect.height + dy, minH, maxHeight - top);
    }
    if (dir.includes('w')) {
        const maxDelta = startRect.width - minW;
        const delta = clamp(dx, boundaryInset - left, maxDelta);
        left = startRect.left + delta;
        width = startRect.width - delta;
    }
    if (dir.includes('n')) {
        const maxDelta = startRect.height - minH;
        const delta = clamp(dy, boundaryInset - top, maxDelta);
        top = startRect.top + delta;
        height = startRect.height - delta;
    }
    return { left, top, width, height };
}

function overlapsWithGap(start: number, size: number, otherStart: number, otherSize: number, gap: number): boolean {
    return start < otherStart + otherSize + gap && start + size + gap > otherStart;
}

/** 每次指针位移在像素空间移动，并对障碍物做扫掠约束，避免快速拖动穿过卡片。 */
export function movePixelRectAvoidingCards(
    start: PixelRect,
    dx: number,
    dy: number,
    metrics: GridMetrics,
    others: PixelRect[]
): PixelRect {
    const inset = cardGridInset(metrics);
    const gap = inset * 2;
    const targetX = clamp(start.left + dx, inset, metrics.width - inset - start.width);
    const targetY = clamp(start.top + dy, inset, metrics.height - inset - start.height);
    const moveX = (rect: PixelRect): PixelRect => {
        let left = targetX;
        for (const other of others) {
            if (!overlapsWithGap(rect.top, rect.height, other.top, other.height, gap)) continue;
            if (left > rect.left && rect.left + rect.width + gap <= other.left) {
                left = Math.min(left, other.left - gap - rect.width);
            } else if (left < rect.left && rect.left >= other.left + other.width + gap) {
                left = Math.max(left, other.left + other.width + gap);
            }
        }
        return { ...rect, left };
    };
    const moveY = (rect: PixelRect): PixelRect => {
        let top = targetY;
        for (const other of others) {
            if (!overlapsWithGap(rect.left, rect.width, other.left, other.width, gap)) continue;
            if (top > rect.top && rect.top + rect.height + gap <= other.top) {
                top = Math.min(top, other.top - gap - rect.height);
            } else if (top < rect.top && rect.top >= other.top + other.height + gap) {
                top = Math.max(top, other.top + other.height + gap);
            }
        }
        return { ...rect, top };
    };
    const horizontalFirst = moveY(moveX(start));
    const verticalFirst = moveX(moveY(start));
    const distance = (rect: PixelRect): number => (targetX - rect.left) ** 2 + (targetY - rect.top) ** 2;
    return distance(verticalFirst) < distance(horizontalFirst) ? verticalFirst : horizontalFirst;
}

/** 缩放时限制正在扩张的边，保留允许的收缩与另一轴的有效位移。 */
export function resizePixelRectAvoidingCards(
    dir: ResizeDir,
    start: PixelRect,
    dx: number,
    dy: number,
    metrics: GridMetrics,
    others: PixelRect[],
    minW: number,
    minH: number
): PixelRect {
    const inset = cardGridInset(metrics);
    const gap = inset * 2;
    const horizontal = resizePixelRect(dir, start, dx, 0, metrics, minW, minH, inset);
    for (const other of others) {
        if (!overlapsWithGap(horizontal.top, horizontal.height, other.top, other.height, gap)) continue;
        if (
            dir.includes('e') &&
            horizontal.left + horizontal.width > start.left + start.width &&
            start.left + start.width + gap <= other.left
        ) {
            horizontal.width = Math.min(horizontal.width, other.left - gap - horizontal.left);
        }
        if (dir.includes('w') && horizontal.left < start.left && start.left >= other.left + other.width + gap) {
            const right = horizontal.left + horizontal.width;
            horizontal.left = Math.max(horizontal.left, other.left + other.width + gap);
            horizontal.width = right - horizontal.left;
        }
    }
    const vertical = resizePixelRect(dir, horizontal, 0, dy, metrics, minW, minH, inset);
    for (const other of others) {
        if (!overlapsWithGap(vertical.left, vertical.width, other.left, other.width, gap)) continue;
        if (
            dir.includes('s') &&
            vertical.top + vertical.height > start.top + start.height &&
            start.top + start.height + gap <= other.top
        ) {
            vertical.height = Math.min(vertical.height, other.top - gap - vertical.top);
        }
        if (dir.includes('n') && vertical.top < start.top && start.top >= other.top + other.height + gap) {
            const bottom = vertical.top + vertical.height;
            vertical.top = Math.max(vertical.top, other.top + other.height + gap);
            vertical.height = bottom - vertical.top;
        }
    }
    return vertical;
}

/** 水平方向拖动卡片：把像素位移换算成整数格位移，并夹紧到网格内。 */
export function moveGridRect(
    start: GridRect,
    startClientX: number,
    startClientY: number,
    clientX: number,
    clientY: number,
    metrics: GridMetrics
): GridRect {
    const dxCells = Math.round((clientX - startClientX) / metrics.cellW);
    const dyCells = Math.round((clientY - startClientY) / metrics.cellH);
    return {
        ...start,
        gridX: clamp(start.gridX + dxCells, 0, GRID_COLUMNS - start.gridW),
        gridY: clamp(start.gridY + dyCells, 0, GRID_ROWS - start.gridH)
    };
}
