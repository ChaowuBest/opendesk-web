import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import { declaration, ruleBody } from './cssRules.js';

/**
 * 设置页左栏导航宽度自适应契约：
 * - 固定 164px 列宽在长文本语言（如德语「Einrichtungsassistent」）下必然溢出；
 * - 列宽改为跟随最长文案自适应，下限维持原 164px 设计宽度，上限封顶；
 * - 超出上限的文案以省略号收敛，因此 tab 按钮的文案必须有 span 包裹才可截断。
 */

const js = fs.readFileSync(new URL('../../../renderer/components/settingpanel.js', import.meta.url), 'utf8');
// 组件样式内联在首个 <style>…</style> 块中
const css = js.slice(js.indexOf('<style>'), js.indexOf('</style>'));

describe('设置页导航列宽自适应', () => {
    it('导航列不再固定 164px，改为跟随内容自适应并封顶', () => {
        const body = ruleBody(css, '.sp-nav');
        expect(declaration(body, 'width')).toBe('auto');
        // 下限维持原设计宽度，短文案语言视觉不变
        expect(declaration(body, 'min-width')).toBe('164px');
        // 必须有上限：超长文案语言不至于无限撑宽内容区
        expect(declaration(body, 'max-width')).toMatch(/^\d+px$/);
        expect(declaration(body, 'flex')).toBe('none');
    });

    it('按钮文案保持不换行', () => {
        expect(declaration(ruleBody(css, '.sp-nav-item'), 'white-space')).toBe('nowrap');
    });

    it('文案 span 超宽时以省略号收敛，不再溢出导航列', () => {
        const body = ruleBody(css, '.sp-nav-label');
        expect(declaration(body, 'overflow')).toBe('hidden');
        expect(declaration(body, 'text-overflow')).toBe('ellipsis');
    });

    it('tab 按钮渲染时文案包裹在 sp-nav-label span 中', () => {
        expect(js).toMatch(/<span class="sp-nav-label">\$\{t\.label\}<\/span>/);
    });
});
