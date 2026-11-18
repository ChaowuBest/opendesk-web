import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import { declaration, ruleBody } from './cssRules.js';

/**
 * 侧边栏底部导航栏（elastic-toolbar-widget.sidebar-bottom）的文案展开宽度：
 * 展开态（悬停 / 当前页 / 反馈按钮）曾写死 max-width: 56px，多语言下的长文案
 * 被截成 “Système de…”，因此展开上限必须来自实测的文案内容宽度。
 */

const CSS_URL = new URL('../../../renderer/components/toolbar.css', import.meta.url);
const TS_URL = new URL('../../../renderer/components/toolbar.ts', import.meta.url);
const css = fs.readFileSync(CSS_URL, 'utf8');
const ts = fs.readFileSync(TS_URL, 'utf8');

const LABEL_WIDTH_VAR = '--elastic-label-max';

describe('侧边栏底部工具栏文案宽度自适应', () => {
    const expandedRules = [
        'elastic-toolbar-widget.sidebar-bottom .elastic-capsule-btn:hover .elastic-label',
        'elastic-toolbar-widget.sidebar-bottom .elastic-capsule-btn.navbar-active .elastic-label',
        'elastic-toolbar-widget.sidebar-bottom .elastic-capsule-btn.sb-feedback-btn .elastic-label'
    ];

    it.each(expandedRules)('%s 的展开上限取自实测宽度变量，而不是固定像素', (selector) => {
        const maxWidth = declaration(ruleBody(css, selector), 'max-width');
        expect(maxWidth).toContain(`var(${LABEL_WIDTH_VAR}`);
        expect(maxWidth).not.toMatch(/^\d+px$/);
    });

    it('收起态宽度为 0，展开前不占位', () => {
        const body = ruleBody(css, 'elastic-toolbar-widget.sidebar-bottom .elastic-label');
        expect(declaration(body, 'max-width')).toBe('0');
        // 展开宽度参与 max-width 过渡，才能保持原有的推挤展开动效
        expect(declaration(body, 'transition')).toMatch(/max-width/);
    });

    it('工具栏按文案真实宽度写入展开上限', () => {
        expect(ts).toMatch(new RegExp(`setProperty\\('${LABEL_WIDTH_VAR}',[^)]*px`));
        // 宽度必须实测得到，并且量不出宽度（折叠态 / 无布局引擎）时不能写入 0
        expect(ts).toMatch(/label\.scrollWidth/);
        expect(ts).toMatch(/if \(width > 0\)/);
    });

    it('重渲染、恢复可见与字体就绪后都会重新测量', () => {
        // 语言切换通过 setButtons 重渲染，文案变长后必须重新测量
        expect(ts).toMatch(/_renderCapsule\(\)[\s\S]*?_measureLabelWidths\(\);/);
        // 折叠态下无法测量，恢复尺寸后补测
        expect(ts).toMatch(/new ResizeObserver[\s\S]*?_measureLabelWidths\(\)/);
        // 字体加载会改变文本度量
        expect(ts).toMatch(/document\.fonts\?\.ready\?\.then[\s\S]*?_measureLabelWidths\(\)/);
    });

    it('整行放不下常显文案时先收起反馈文案，避免整行溢出到色栏外被裁掉', () => {
        // 测量态禁用压缩，否则压缩会掩盖溢出，量不出「放不下」
        const measureBtn = ruleBody(
            css,
            'elastic-toolbar-widget.sidebar-bottom.elastic-labels-measure .elastic-capsule-btn'
        );
        expect(declaration(measureBtn, 'flex')).toBe('none');
        // 放不下时收起反馈按钮的次要文案，把宽度让给当前页文案
        const tight = ruleBody(
            css,
            'elastic-toolbar-widget.sidebar-bottom.elastic-labels-tight .elastic-capsule-btn.sb-feedback-btn .elastic-label'
        );
        expect(declaration(tight, 'max-width')).toBe('0');
        expect(declaration(tight, 'opacity')).toBe('0');
        expect(ts).toMatch(/classList\.toggle\('elastic-labels-tight', overflow\)/);
    });

    it('文案可压缩并显示省略号，图标不被压缩', () => {
        const btn = ruleBody(css, 'elastic-toolbar-widget.sidebar-bottom .elastic-capsule-btn');
        expect(declaration(btn, 'flex')).toBe('0 1 auto');
        const label = ruleBody(css, 'elastic-toolbar-widget.sidebar-bottom .elastic-label');
        expect(declaration(label, 'min-width')).toBe('0');
        expect(declaration(label, 'text-overflow')).toBe('ellipsis');
    });
});
