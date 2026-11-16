import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import { declaration, ruleBody } from './cssRules.js';

/**
 * 侧边栏两处布局约束：
 * 1. 顶部「新任务 / 技能 / 应用」导航按钮在侧边栏拖窄时不允许换行，空间不足时收起文案只留图标；
 *    显隐判定必须基于实测的真实文本宽度（随界面语言变化），不得退回固定像素断点，
 *    否则长文本语言（如德语 Anwendungen）在默认宽度下就会溢出；
 * 2. 任务列表标题行的收藏星号按钮与「按时间」视图按钮必须等高。
 */

const CSS_URL = new URL('../../../renderer/styles/custom.css', import.meta.url);
const JS_URL = new URL('../../../renderer/components/sidebar.js', import.meta.url);
const css = fs.readFileSync(CSS_URL, 'utf8');
const js = fs.readFileSync(JS_URL, 'utf8');

/** 截取某个方法定义（`name() {` 起）到下一个同级方法定义之前的源码片段。 */
function methodBody(source: string, name: string): string {
    // 用带 `() {` 的定义形态匹配，避免命中 `this._xxx()` 调用点
    const start = source.indexOf(`${name}() {`);
    expect(start).toBeGreaterThan(-1);
    const next = source.slice(start + 1).search(/\n {4}_[a-zA-Z]/);
    const end = next === -1 ? source.length : start + 1 + next;
    return source.slice(start, end);
}

describe('侧边栏导航按钮窄态', () => {
    it('不再使用按中文文案估算的固定像素断点', () => {
        // 固定断点以「新任务」3 个汉字的宽度估算阈值，换语言后即失真，
        // 显隐判定必须由 JS 按实测宽度给出，CSS 里不应再保留 @container sb-nav
        expect(css).not.toMatch(/@container\s+sb-nav\b/);
        expect(declaration(ruleBody(css, '.sb-nav-row'), 'container')).toBeUndefined();
    });

    it('导航按钮文案不换行', () => {
        expect(declaration(ruleBody(css, '.sb-nav-btn'), 'white-space')).toBe('nowrap');
    });

    it('导航按钮过渡只作用于颜色，布局属性不参与过渡', () => {
        // transition:all 会让测量态的临时宽度在恢复时被动画化：
        // 拖拽时按钮宽度在「内容宽/拉伸宽」间反复插值，视觉上间歇性变窄变宽。
        // 因此过渡白名单只保留 hover/active 的颜色类属性
        const transition = declaration(ruleBody(css, '.sb-nav-btn'), 'transition');
        expect(transition).not.toMatch(/(^|[,\s])all([,\s]|$)/);
        expect(transition).toMatch(/background/);
        expect(transition).not.toMatch(/flex|width|height|padding/);
    });

    it('空间不足时通过 sb-nav-labels-hidden 类收起文案只保留图标', () => {
        const body = ruleBody(css, '.sb-nav-row.sb-nav-labels-hidden .sb-nav-btn > [data-sidebar-label]');
        expect(declaration(body, 'display')).toBe('none');
    });

    it('_updateNavLabelsFit 按实测宽度判定文案显隐，不使用硬编码阈值', () => {
        const block = methodBody(js, '_updateNavLabelsFit');
        // 导航行可用宽度与按钮内容宽度都必须实测
        expect(block).toMatch(/getComputedStyle\(row\)/);
        expect(block).toMatch(/row\.clientWidth/);
        expect(block).toMatch(/getBoundingClientRect\(\)/);
        // 放不下时给导航行加收起类
        expect(block).toMatch(/classList\.add\('sb-nav-labels-hidden'\)/);
        // 判定阈值只能来自测量结果，不得出现硬编码像素断点
        expect(block).not.toMatch(/\b[12]\d{2}\b\s*(px)?\s*[<>=]/);
        // 判定必须留有余量：clientWidth 是取整值而实测宽度是浮点值，
        // 贴着阈值判定会在拖拽到临界宽度时逐帧翻转，导致文案显隐闪烁
        expect(block).toMatch(/const FIT_SLACK = \d+;/);
        expect(block).toMatch(/required > available \+ FIT_SLACK/);
    });

    it('测量态必须禁用按钮过渡，避免临时类切换被 transition:all 动画化', () => {
        // .sb-nav-btn 有 transition: all，测量用的临时类若不禁用过渡，
        // 每次测量都会启停一次按钮宽度动画且实测宽度读到过渡中间值，拖拽时肉眼可见地闪烁
        const block = ruleBody(css, '.sb-nav-row.sb-nav-measure .sb-nav-btn');
        expect(declaration(block, 'flex')).toBe('none');
        expect(declaration(block, 'transition')).toBe('none');
    });

    it('侧边栏宽度变化与界面语言切换时重新判定文案显隐', () => {
        // 侧边栏拖窄/拖宽、折叠展开由 ResizeObserver 感知
        const initBlock = methodBody(js, '_initNavLabelsFit');
        expect(initBlock).toMatch(/new ResizeObserver/);
        expect(initBlock).toMatch(/\.observe\(row\)/);
        // 语言切换会更新 label 文本，需按新文本宽度重新判定
        expect(methodBody(js, '_updateLocalizedChrome')).toMatch(/_updateNavLabelsFit\(\)/);
    });
});

describe('任务列表标题行控件等高', () => {
    it('标题行定义统一高度变量', () => {
        expect(declaration(ruleBody(css, '.sb-task-list-header'), '--sb-header-control-height')).toMatch(/^\d+px$/);
    });

    it('收藏按钮与视图按钮使用同一高度且都按 border-box 计算', () => {
        const fav = ruleBody(css, '.sb-fav-toggle');
        const summary = ruleBody(css, '.sb-view-menu > summary');

        for (const [name, body] of [
            ['收藏按钮', fav],
            ['视图按钮', summary]
        ] as const) {
            expect([name, declaration(body, 'box-sizing')]).toEqual([name, 'border-box']);
            expect([name, declaration(body, 'height')]).toEqual([name, 'var(--sb-header-control-height)']);
        }
    });
});
