import { describe, expect, test } from '@jest/globals';
import {
    PILL_GAP_PX,
    countTagsFitting,
    resolveColumnGap
} from '../../../main/applications/benchmark/renderer/tag-fit.js';

/**
 * 卡片胶囊宽度预算的计算规则：
 * - 放得下就全留；
 * - 差一个 gap 也算放不下（边界必须严格，否则会多收一个胶囊导致折行）；
 * - 兜底胶囊自己占位，露头时至少收掉一个 track；
 * - 没有布局能力的环境（linkedom 单测）读不到列间距，必须走兜底值而不是抛异常。
 */

describe('countTagsFitting', () => {
    test('全放得下时全部保留', () => {
        expect(countTagsFitting([50, 50, 50], 300, 6, 3)).toBe(3);
    });

    test('正好卡在边界上（含 gap）全部保留', () => {
        // 50 + 6 + 50 + 6 + 50 = 162
        expect(countTagsFitting([50, 50, 50], 162, 6, 3)).toBe(3);
    });

    test('比边界少 1px 就只留前两个', () => {
        expect(countTagsFitting([50, 50, 50], 161, 6, 3)).toBe(2);
    });

    test('第一个都放不下时返回 0', () => {
        expect(countTagsFitting([50, 50], 49, 6, 2)).toBe(0);
    });

    test('budget 为负（被兜底胶囊吃掉全部宽度）时返回 0', () => {
        expect(countTagsFitting([50, 50], -4, 6, 2)).toBe(0);
    });

    test('limit 小于胶囊总数时不会越过 limit', () => {
        expect(countTagsFitting([10, 10, 10, 10, 10], 1000, 6, 2)).toBe(2);
    });

    test('limit 超过胶囊总数时按实际数量封顶', () => {
        expect(countTagsFitting([10, 10], 1000, 6, 10)).toBe(2);
    });

    test('空列表返回 0', () => {
        expect(countTagsFitting([], 100, 6, 5)).toBe(0);
    });

    test('宽度为 0 的胶囊（面板还没布局）不会被算成放不下', () => {
        expect(countTagsFitting([0, 0], 0, 6, 2)).toBe(1);
    });
});

describe('resolveColumnGap', () => {
    test('没有布局能力的环境退回常量，不抛 ReferenceError', () => {
        expect(resolveColumnGap({})).toBe(PILL_GAP_PX);
        expect(resolveColumnGap({ ownerDocument: null })).toBe(PILL_GAP_PX);
    });

    test('defaultView 缺 getComputedStyle 时也走兜底', () => {
        const el = { ownerDocument: { defaultView: {} } } as unknown as { ownerDocument: Document };
        expect(resolveColumnGap(el, 9)).toBe(9);
    });

    test('能读到样式时用实际列间距', () => {
        const el = {
            ownerDocument: { defaultView: { getComputedStyle: () => ({ columnGap: '12px' }) } }
        } as unknown as { ownerDocument: Document };
        expect(resolveColumnGap(el)).toBe(12);
    });

    test('columnGap 为 normal/空串时走兜底', () => {
        const el = {
            ownerDocument: { defaultView: { getComputedStyle: () => ({ columnGap: 'normal' }) } }
        } as unknown as { ownerDocument: Document };
        expect(resolveColumnGap(el)).toBe(PILL_GAP_PX);
    });
});
