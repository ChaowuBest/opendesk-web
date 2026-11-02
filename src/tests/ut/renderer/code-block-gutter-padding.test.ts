import { describe, expect, test } from '@jest/globals';
import fs from 'fs';

/**
 * 代码块的上下留白必须由首/末行承担。
 *
 * 曾经 `.code-lines` 自带 `padding: 0.5em 0`，而行号列是每行 `.code-line::before`
 * 的绝对定位块，于是首行之前、末行之后会出现一条铺满整块宽度、没有行号列的
 * 纯代码底色带，浅色主题下表现为语言栏与代码之间 / 代码与卡片底边之间的“白条”。
 */

const customCss = fs
    .readFileSync(new URL('../../../renderer/styles/custom.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

/** 取出某条以行首开始的选择器规则的声明体并折叠空白。 */
function extractRule(selector: string): string {
    const escaped = selector.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&');
    const match = customCss.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
    expect(match).not.toBeNull();
    return match![1].replace(/\s+/g, ' ').trim();
}

describe('markdown 代码块上下留白不得露出“白条”', () => {
    test('.code-lines 不再保留纵向内边距（那会露出没有行号列的底色带）', () => {
        expect(extractRule('.markdown-body .code-lines')).toContain('padding: 0 !important');
    });

    test('上下留白改由首/末行承担，行号列随行框铺到代码块边缘', () => {
        expect(extractRule('.markdown-body .code-line:first-child')).toContain('padding-top: 0.5em !important');
        expect(extractRule('.markdown-body .code-line:first-child::before')).toContain('padding-top: 0.5em !important');
        expect(extractRule('.markdown-body .code-line:last-child')).toContain('padding-bottom: 0.5em !important');
        // 行号列铺满整行（含首/末行的内边距）是留白连续的前提
        expect(extractRule('.markdown-body .code-line::before')).toContain('height: 100% !important');
    });

    test('代码区底色跟随主题变量，不再硬编码纯白', () => {
        const bodyRule = extractRule('html[data-font-preset] .markdown-body .code-block-body');
        expect(bodyRule).toContain('background: var(--chat-code-bg');
        expect(bodyRule).not.toContain('background: #ffffff');
    });

    test('首列代码与行号列分隔线之间必须留出间距', () => {
        const paddingLeft = /padding: 0 [^ ]+ 0 ([0-9.]+)em/.exec(extractRule('.markdown-body .code-line'));
        const gutterWidth = /width: ([0-9.]+)em/.exec(extractRule('.markdown-body .code-line::before'));
        expect(paddingLeft).not.toBeNull();
        expect(gutterWidth).not.toBeNull();
        expect(Number(paddingLeft![1])).toBeGreaterThan(Number(gutterWidth![1]));
    });
});
