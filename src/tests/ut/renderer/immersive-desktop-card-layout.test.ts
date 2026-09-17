import {
    CARD_GRID_INSET,
    DEFAULT_CARD_GRID_H,
    DEFAULT_CARD_GRID_W,
    GRID_COLUMNS,
    GRID_ROWS,
    MIN_CARD_GRID_H,
    MIN_CARD_GRID_W,
    clamp,
    computeGridMetrics,
    findAvailableCardLayout,
    findNearestAvailableCardLayout,
    fitResizedCardLayout,
    gridRectToPixel,
    layoutCollides,
    moveGridRect,
    movePixelRectAvoidingCards,
    resolveDraggedCardLayout,
    resizePixelRect,
    resizePixelRectAvoidingCards,
    snapPixelRectToGrid,
    rectsCollide
} from '../../../renderer/components/desktop/cardLayout.js';

const METRICS = {
    left: 0,
    top: 0,
    width: 640,
    height: 400,
    cellW: 640 / GRID_COLUMNS,
    cellH: 400 / GRID_ROWS,
    viewportScaleX: 1,
    viewportScaleY: 1
};

describe('immersive desktop card layout', () => {
    test('clamp keeps values within bounds', () => {
        expect(clamp(5, 0, 3)).toBe(3);
        expect(clamp(-2, 0, 3)).toBe(0);
        expect(clamp(2, 0, 3)).toBe(2);
    });

    test('computeGridMetrics returns null for degenerate stages', () => {
        expect(
            computeGridMetrics({
                width: 0,
                height: 100,
                left: 0,
                top: 0,
                right: 0,
                bottom: 100,
                x: 0,
                y: 0,
                toJSON: () => ({})
            } as DOMRect)
        ).toBeNull();
        const metrics = computeGridMetrics({
            width: 640,
            height: 400,
            left: 0,
            top: 0,
            right: 640,
            bottom: 400,
            x: 0,
            y: 0,
            toJSON: () => ({})
        } as DOMRect);
        expect(metrics?.cellW).toBeCloseTo(20);
        expect(metrics?.cellH).toBeCloseTo(20);
    });

    test('computeGridMetrics uses local layout dimensions instead of transformed viewport dimensions', () => {
        const metrics = computeGridMetrics({ width: 320, height: 200, left: 12, top: 18 }, { width: 640, height: 400 });
        expect(metrics).toMatchObject({
            left: 12,
            top: 18,
            width: 640,
            height: 400,
            cellW: 20,
            cellH: 20,
            viewportScaleX: 0.5,
            viewportScaleY: 0.5
        });
    });

    test('gridRectToPixel converts cells to pixels', () => {
        const rect = gridRectToPixel({ gridX: 2, gridY: 1, gridW: 4, gridH: 3 }, METRICS);
        expect(rect).toEqual({
            left: 40 + CARD_GRID_INSET,
            top: 20 + CARD_GRID_INSET,
            width: 80 - CARD_GRID_INSET * 2,
            height: 60 - CARD_GRID_INSET * 2
        });
    });

    test('snapPixelRectToGrid aligns and clamps to grid bounds', () => {
        // 高度 61px 低于最小 4 格（80px），应被抬升到最小尺寸
        const snapped = snapPixelRectToGrid(
            {
                left: 21 + CARD_GRID_INSET,
                top: 9 + CARD_GRID_INSET,
                width: 83 - CARD_GRID_INSET * 2,
                height: 61 - CARD_GRID_INSET * 2
            },
            METRICS
        );
        expect(snapped).toEqual({ gridX: 1, gridY: 0, gridW: 4, gridH: 4 });

        const clampedRight = snapPixelRectToGrid({ left: 600, top: 380, width: 400, height: 300 }, METRICS);
        expect(clampedRight.gridX + clampedRight.gridW).toBeLessThanOrEqual(GRID_COLUMNS);
        expect(clampedRight.gridY + clampedRight.gridH).toBeLessThanOrEqual(GRID_ROWS);
        expect(clampedRight.gridW).toBeGreaterThanOrEqual(MIN_CARD_GRID_W);
        expect(clampedRight.gridH).toBeGreaterThanOrEqual(MIN_CARD_GRID_H);
    });

    test('rectsCollide and layoutCollides detect overlaps', () => {
        const a = { id: 'a', gridX: 0, gridY: 0, gridW: 4, gridH: 4 };
        const b = { id: 'b', gridX: 2, gridY: 2, gridW: 4, gridH: 4 };
        const c = { id: 'c', gridX: 4, gridY: 0, gridW: 4, gridH: 4 };
        expect(rectsCollide(a, b)).toBe(true);
        expect(rectsCollide(a, c)).toBe(false);
        expect(layoutCollides(b, [a, c])).toBe(true);
        expect(layoutCollides(a, [a, c], 'a')).toBe(false);
    });

    test('findAvailableCardLayout prefers the requested slot and skips occupied ones', () => {
        const layout = findAvailableCardLayout(0, 0, []);
        expect(layout).toEqual({ gridX: 0, gridY: 0, gridW: DEFAULT_CARD_GRID_W, gridH: DEFAULT_CARD_GRID_H });

        const occupied = { gridX: 0, gridY: 0, gridW: DEFAULT_CARD_GRID_W, gridH: DEFAULT_CARD_GRID_H };
        const next = findAvailableCardLayout(0, 0, [occupied]);
        expect(layoutCollides(next, [occupied])).toBe(false);
    });

    test('findAvailableCardLayout rejects a full grid instead of overlapping cards', () => {
        const others = [] as Array<{ gridX: number; gridY: number; gridW: number; gridH: number }>;
        for (let y = 0; y < GRID_ROWS; y += DEFAULT_CARD_GRID_H) {
            for (let x = 0; x < GRID_COLUMNS; x += DEFAULT_CARD_GRID_W) {
                others.push({ gridX: x, gridY: y, gridW: DEFAULT_CARD_GRID_W, gridH: DEFAULT_CARD_GRID_H });
            }
        }
        const layout = findAvailableCardLayout(2, 2, others);
        expect(layout).toBeNull();
    });

    test('nearest free placement avoids occupied slots after a drag', () => {
        const occupied = { gridX: 8, gridY: 0, gridW: 8, gridH: 6 };
        const desired = { gridX: 8, gridY: 0, gridW: 8, gridH: 6 };
        const nearest = findNearestAvailableCardLayout(desired, [occupied]);
        expect(nearest).not.toBeNull();
        expect(layoutCollides(nearest!, [occupied])).toBe(false);
        expect(findNearestAvailableCardLayout(desired, [])).toEqual(desired);
    });

    test('drag drop keeps the original card size when the stage resizes during the interaction', () => {
        const original = { gridX: 8, gridY: 0, gridW: 7, gridH: 6 };
        const others = [
            { gridX: 0, gridY: 0, gridW: 8, gridH: 6 },
            { gridX: 15, gridY: 0, gridW: 8, gridH: 11 },
            { gridX: 0, gridY: 6, gridW: 15, gridH: 9 },
            { gridX: 23, gridY: 0, gridW: 9, gridH: 15 }
        ];
        const resizedMetrics = { ...METRICS, width: 960, cellW: 960 / GRID_COLUMNS };
        const currentRect = gridRectToPixel(original, METRICS);

        expect(snapPixelRectToGrid(currentRect, resizedMetrics).gridW).toBe(5);
        const destination = resolveDraggedCardLayout(currentRect, METRICS, original, others);

        expect(destination).toEqual(original);
        expect(layoutCollides(destination, others)).toBe(false);
    });

    test('continuous drag stops before an adjacent card and cannot tunnel through it', () => {
        const start = gridRectToPixel({ gridX: 0, gridY: 0, gridW: 8, gridH: 6 }, METRICS);
        const obstacle = gridRectToPixel({ gridX: 8, gridY: 0, gridW: 8, gridH: 6 }, METRICS);
        const moved = movePixelRectAvoidingCards(start, 300, 0, METRICS, [obstacle]);
        expect(moved.left).toBe(start.left);
        const free = movePixelRectAvoidingCards(start, 7, 3, METRICS, []);
        expect(free.left).toBe(start.left + 7);
        expect(free.top).toBe(start.top + 3);
        const around = movePixelRectAvoidingCards(start, 300, 130, METRICS, [obstacle]);
        expect(around.left + around.width <= obstacle.left || around.top >= obstacle.top + obstacle.height).toBe(true);
    });

    test('resize cannot expand through another card, including diagonally', () => {
        const start = gridRectToPixel({ gridX: 0, gridY: 0, gridW: 8, gridH: 6 }, METRICS);
        const east = gridRectToPixel({ gridX: 8, gridY: 0, gridW: 8, gridH: 6 }, METRICS);
        const below = gridRectToPixel({ gridX: 0, gridY: 6, gridW: 8, gridH: 6 }, METRICS);
        const resized = resizePixelRectAvoidingCards(
            'se',
            start,
            300,
            200,
            METRICS,
            [east, below],
            MIN_CARD_GRID_W * METRICS.cellW - CARD_GRID_INSET * 2,
            MIN_CARD_GRID_H * METRICS.cellH - CARD_GRID_INSET * 2
        );
        expect(resized).toEqual(start);
        const smaller = resizePixelRectAvoidingCards('se', start, -10, -10, METRICS, [east, below], 40, 40);
        expect(smaller.width).toBe(start.width - 10);
        expect(smaller.height).toBe(start.height - 10);
    });

    test('resize snap keeps the closest legal dimensions when rounding reaches a neighbor', () => {
        const original = { gridX: 0, gridY: 0, gridW: 8, gridH: 6 };
        const desired = { gridX: 0, gridY: 0, gridW: 11, gridH: 7 };
        const neighbor = { gridX: 10, gridY: 0, gridW: 8, gridH: 6 };
        expect(fitResizedCardLayout(desired, original, 'se', [neighbor])).toEqual({
            gridX: 0,
            gridY: 0,
            gridW: 10,
            gridH: 7
        });
    });

    test('resizePixelRect respects minimum size and stage bounds for each direction', () => {
        const start = { left: 100, top: 100, width: 100, height: 100 };
        const minW = MIN_CARD_GRID_W * METRICS.cellW;
        const minH = MIN_CARD_GRID_H * METRICS.cellH;

        const east = resizePixelRect('e', start, -200, 0, METRICS, minW, minH);
        expect(east.width).toBeCloseTo(minW);

        const west = resizePixelRect('w', start, -300, 0, METRICS, minW, minH);
        expect(west.left).toBe(0);
        expect(west.width).toBeCloseTo(start.left + start.width);

        const north = resizePixelRect('n', start, 0, -300, METRICS, minW, minH);
        expect(north.top).toBe(0);
        expect(north.height).toBeCloseTo(start.top + start.height);

        const south = resizePixelRect('s', start, 0, 500, METRICS, minW, minH);
        expect(south.top + south.height).toBeLessThanOrEqual(METRICS.height);
    });

    test('moveGridRect converts pixel deltas into clamped integer cell moves', () => {
        const start = { gridX: 10, gridY: 10, gridW: 4, gridH: 4 };
        const moved = moveGridRect(start, 100, 100, 100 + 2.5 * METRICS.cellW, 100 - 1.6 * METRICS.cellH, METRICS);
        expect(moved.gridX).toBe(13);
        expect(moved.gridY).toBe(8);

        const pinned = moveGridRect({ gridX: 0, gridY: 0, gridW: 4, gridH: 4 }, 0, 0, -500, -500, METRICS);
        expect(pinned.gridX).toBe(0);
        expect(pinned.gridY).toBe(0);
    });
});
