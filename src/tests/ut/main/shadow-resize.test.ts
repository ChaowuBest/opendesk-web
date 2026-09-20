/**
 * Linux 主窗口内容边缘 resize 的 bounds 计算：
 *
 * 阴影边距环内的感应条发起拖动 resize 时，主进程轮询光标位置并把位移差
 * 换算为窗口 bounds。本模块验证 8 个方向的换算与最小尺寸 clamp（西/北方向
 * 收缩到最小尺寸时，x/y 需要同步补偿，保证对边固定）。
 */

import { describe, it, expect } from '@jest/globals';

import {
    computeShadowResizeBounds,
    normalizeShadowResizeDirection
} from '../../../main/windows/linux-window-shadow.js';

const START = { x: 100, y: 80, width: 1200, height: 800 };
const MIN_W = 890;
const MIN_H = 440;

describe('computeShadowResizeBounds', () => {
    it('east：只改宽度，左上角不动', () => {
        expect(
            computeShadowResizeBounds({
                startBounds: START,
                direction: 'e',
                dx: 40,
                dy: 0,
                minWidth: MIN_W,
                minHeight: MIN_H
            })
        ).toEqual({
            x: 100,
            y: 80,
            width: 1240,
            height: 800
        });
    });

    it('south：只改高度', () => {
        expect(
            computeShadowResizeBounds({
                startBounds: START,
                direction: 's',
                dx: 0,
                dy: -30,
                minWidth: MIN_W,
                minHeight: MIN_H
            })
        ).toEqual({
            x: 100,
            y: 80,
            width: 1200,
            height: 770
        });
    });

    it('west：右边缘固定，宽度和 x 同步变化', () => {
        expect(
            computeShadowResizeBounds({
                startBounds: START,
                direction: 'w',
                dx: 50,
                dy: 0,
                minWidth: MIN_W,
                minHeight: MIN_H
            })
        ).toEqual({
            x: 150,
            y: 80,
            width: 1150,
            height: 800
        });
    });

    it('west：向左拉（dx 为负）时向左扩展', () => {
        expect(
            computeShadowResizeBounds({
                startBounds: START,
                direction: 'w',
                dx: -60,
                dy: 0,
                minWidth: MIN_W,
                minHeight: MIN_H
            })
        ).toEqual({
            x: 40,
            y: 80,
            width: 1260,
            height: 800
        });
    });

    it('north：下边缘固定，高度和 y 同步变化', () => {
        expect(
            computeShadowResizeBounds({
                startBounds: START,
                direction: 'n',
                dx: 0,
                dy: -25,
                minWidth: MIN_W,
                minHeight: MIN_H
            })
        ).toEqual({
            x: 100,
            y: 55,
            width: 1200,
            height: 825
        });
    });

    it('northeast：同时改宽度和高度', () => {
        expect(
            computeShadowResizeBounds({
                startBounds: START,
                direction: 'ne',
                dx: 10,
                dy: -10,
                minWidth: MIN_W,
                minHeight: MIN_H
            })
        ).toEqual({
            x: 100,
            y: 70,
            width: 1210,
            height: 810
        });
    });

    it('southwest：宽度和高度同时变化且 x 补偿', () => {
        expect(
            computeShadowResizeBounds({
                startBounds: START,
                direction: 'sw',
                dx: 20,
                dy: 30,
                minWidth: MIN_W,
                minHeight: MIN_H
            })
        ).toEqual({
            x: 120,
            y: 80,
            width: 1180,
            height: 830
        });
    });

    it('west 收缩超过最小宽度：宽度钳制在 minWidth，x 相应右移', () => {
        expect(
            computeShadowResizeBounds({
                startBounds: START,
                direction: 'w',
                dx: START.width - MIN_W + 30,
                dy: 0,
                minWidth: MIN_W,
                minHeight: MIN_H
            })
        ).toEqual({
            x: START.x + START.width - MIN_W,
            y: 80,
            width: MIN_W,
            height: 800
        });
    });

    it('north 收缩超过最小高度：高度钳制在 minHeight，y 相应下移', () => {
        expect(
            computeShadowResizeBounds({
                startBounds: START,
                direction: 'n',
                dx: 0,
                dy: START.height - MIN_H + 20,
                minWidth: MIN_W,
                minHeight: MIN_H
            })
        ).toEqual({
            x: 100,
            y: START.y + START.height - MIN_H,
            width: 1200,
            height: MIN_H
        });
    });

    it('east 向左拖越过最小宽度：宽度不小于 minWidth', () => {
        expect(
            computeShadowResizeBounds({
                startBounds: START,
                direction: 'e',
                dx: -(START.width - MIN_W + 5),
                dy: 0,
                minWidth: MIN_W,
                minHeight: MIN_H
            }).width
        ).toBe(MIN_W);
    });

    it('非整数位移取整（X11 光标坐标为整数，防御小数）', () => {
        expect(
            computeShadowResizeBounds({
                startBounds: START,
                direction: 'e',
                dx: 10.4,
                dy: 0,
                minWidth: MIN_W,
                minHeight: MIN_H
            }).width
        ).toBe(1210);
    });
});

describe('normalizeShadowResizeDirection', () => {
    it('合法方向原样返回', () => {
        for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
            expect(normalizeShadowResizeDirection(dir)).toBe(dir);
        }
    });

    it('非法输入返回 null', () => {
        expect(normalizeShadowResizeDirection('xx')).toBeNull();
        expect(normalizeShadowResizeDirection(42)).toBeNull();
        expect(normalizeShadowResizeDirection(undefined)).toBeNull();
    });
});
