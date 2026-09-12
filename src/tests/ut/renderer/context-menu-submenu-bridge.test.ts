import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

// jsdom 不实现布局与 :hover 命中测试，无法真实模拟"鼠标从父项移向子菜单"，
// 因此以 CSS 契约测试固化行为约束：
// 子菜单与父项之间的水平间隙必须被悬停桥（::before）覆盖，
// 否则鼠标穿过间隙时 .ctx-submenu-wrap:hover 瞬间失效，子菜单直接 display:none 且无法恢复。
const css = readFileSync(new URL('../../../renderer/styles/context-menu.css', import.meta.url), 'utf8');

function extractRuleBlock(selector: string): string | null {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    return match ? match[1] : null;
}

function getDecl(block: string, prop: string): string | null {
    const match = block.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i'));
    return match ? match[1].trim() : null;
}

function parsePx(value: string | null): number | null {
    if (!value) return null;
    const match = value.match(/(-?[\d.]+)px/);
    return match ? parseFloat(match[1]) : null;
}

describe('context menu submenu hover bridge', () => {
    test('ctx-submenu 默认隐藏，仅由 wrap 的 hover 展开', () => {
        const block = extractRuleBlock('.ctx-submenu');
        expect(block).not.toBeNull();
        expect(getDecl(block!, 'display')).toBe('none');

        const hoverRule = css.match(/\.ctx-submenu-wrap:hover\s*>\s*\.ctx-submenu[^{]*\{[^}]*display:\s*block/);
        expect(hoverRule).not.toBeNull();
    });

    test('子菜单与父项之间的水平间隙必须被悬停桥完整覆盖', () => {
        const submenu = extractRuleBlock('.ctx-submenu');
        expect(submenu).not.toBeNull();

        // left: calc(100% + 4px) —— 子菜单左缘与父项右缘之间的视觉间隙宽度
        const leftDecl = getDecl(submenu!, 'left') ?? '';
        const gapMatch = leftDecl.match(/calc\(100%\s*\+\s*(-?[\d.]+)px\)/);
        const gap = gapMatch ? parseFloat(gapMatch[1]) : 0;

        if (gap <= 0) {
            // 无间隙时不存在 hover 断链，无需悬停桥
            return;
        }

        const bridge = extractRuleBlock('.ctx-submenu::before');
        // 修复前缺失此规则：鼠标穿过 4px 间隙时 :hover 失效，子菜单关闭后再也无法打开
        expect(bridge).not.toBeNull();

        // 桥向左延伸的绝对值必须 ≥ 间隙宽度（left 为负值），即桥起点要越过
        // wrap 右缘、与父项命中区重叠，避免边界像素上出现 hover 真空
        const bridgeLeft = parsePx(getDecl(bridge!, 'left'));
        expect(bridgeLeft).not.toBeNull();
        expect(bridgeLeft!).toBeLessThanOrEqual(-gap);

        // 桥右缘（left + width）必须至少到达子菜单左缘（坐标 0）
        const bridgeWidth = parsePx(getDecl(bridge!, 'width'));
        expect(bridgeWidth).not.toBeNull();
        expect(bridgeWidth! + bridgeLeft!).toBeGreaterThanOrEqual(0);

        // 桥垂直贯通子菜单，保证从父项上/下边缘斜向移入子菜单时也不脱离命中区
        expect(getDecl(bridge!, 'top')).toBe('0');
        expect(getDecl(bridge!, 'bottom')).toBe('0');
    });
});
