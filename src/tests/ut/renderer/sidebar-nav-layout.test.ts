import { describe, expect, it } from '@jest/globals';
import fs from 'fs';

/**
 * 侧边栏两处布局约束：
 * 1. 顶部「新任务 / 技能 / 应用」导航按钮在侧边栏拖窄时不允许换行，空间不足时收起文案只留图标；
 * 2. 任务列表标题行的收藏星号按钮与「按时间」视图按钮必须等高。
 */

const CSS_URL = new URL('../../../renderer/styles/custom.css', import.meta.url);
const css = fs.readFileSync(CSS_URL, 'utf8');

/** 提取扁平规则的选择器声明体（不含嵌套块），并去掉注释避免干扰声明解析。 */
function ruleBody(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
    expect(match).not.toBeNull();
    return match![1].replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 声明值（去掉 !important 与空白）。 */
function declaration(body: string, property: string): string | undefined {
    const value = body.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`))?.[1];
    return value?.replace(/\s*!important\s*$/, '').trim();
}

describe('侧边栏导航按钮窄态', () => {
    it('导航行以自身宽度作为容器查询上下文', () => {
        const body = ruleBody('.sb-nav-row');
        expect(declaration(body, 'container')).toBe('sb-nav / inline-size');
    });

    it('导航按钮文案不换行', () => {
        expect(declaration(ruleBody('.sb-nav-btn'), 'white-space')).toBe('nowrap');
    });

    it('宽度不足时收起文案只保留图标，且阈值不会误伤默认宽度', () => {
        const block = css.match(/@container\s+sb-nav\s*\(max-width:\s*(\d+)px\)\s*\{([^}]*)\{([^}]*)\}/);
        expect(block).not.toBeNull();

        const threshold = Number(block![1]);
        // 单按钮需要 图标 14 + 间距 5 + 「新任务」3 个 13px 汉字 ≈ 58px，三按钮加两个 8px 间距共 190px
        expect(threshold).toBeGreaterThanOrEqual(190);
        // 默认侧边栏 316px（导航行内容宽 288px）必须仍显示文案
        expect(threshold).toBeLessThan(288);

        expect(block![2].trim()).toBe('.sb-nav-btn > [data-sidebar-label]');
        expect(declaration(block![3], 'display')).toBe('none');
    });
});

describe('任务列表标题行控件等高', () => {
    it('标题行定义统一高度变量', () => {
        expect(declaration(ruleBody('.sb-task-list-header'), '--sb-header-control-height')).toMatch(/^\d+px$/);
    });

    it('收藏按钮与视图按钮使用同一高度且都按 border-box 计算', () => {
        const fav = ruleBody('.sb-fav-toggle');
        const summary = ruleBody('.sb-view-menu > summary');

        for (const [name, body] of [
            ['收藏按钮', fav],
            ['视图按钮', summary]
        ] as const) {
            expect([name, declaration(body, 'box-sizing')]).toEqual([name, 'border-box']);
            expect([name, declaration(body, 'height')]).toEqual([name, 'var(--sb-header-control-height)']);
        }
    });
});
