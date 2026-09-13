import { describe, expect, it } from '@jest/globals';
import fs from 'fs';

import {
    PREVIEW_FONT_FAMILY,
    PREVIEW_LINE_HEIGHT,
    buildAceShadowStyles,
    getFileExplorerCSS
} from '../../../renderer/components/fileExplorer.js';

/** 读取文本并折叠所有空白（含换行缩进），便于比较跨文件的 CSS 声明值。 */
function readCss(relPath: string): string {
    return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

/** 从 fonts.css 的 :root 块中提取 --font-mono 的字面量值（左侧聊天/终端等宽渲染的唯一事实来源）。 */
function readLeftMonospaceStack(): string {
    const css = readCss('../../../renderer/styles/fonts.css');
    const match = css.match(/--font-mono:\s*([\s\S]*?);/);
    expect(match).not.toBeNull();
    return collapseWhitespace(match![1]);
}

/** 从 custom.css 的 .code-block-body 规则中提取左侧聊天代码块的行高。 */
function readLeftCodeBlockLineHeight(): string {
    const css = readCss('../../../renderer/styles/custom.css');
    const match = css.match(/\.code-block-body\s*\{[^}]*?line-height:\s*([0-9.]+)/s);
    expect(match).not.toBeNull();
    return match![1];
}

/** 从 getFileExplorerCSS() 产物中提取指定选择器规则的声明体。 */
function extractRule(css: string, selector: string): string {
    const match = css.match(new RegExp(`(?:^|\\n)\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
    expect(match).not.toBeNull();
    return collapseWhitespace(match![1]);
}

describe('右侧文件预览/编辑器与左侧等宽渲染对齐', () => {
    it('PREVIEW_FONT_FAMILY 必须与 fonts.css 的 --font-mono 完全一致', () => {
        expect(PREVIEW_FONT_FAMILY).toBe(readLeftMonospaceStack());
    });

    it('PREVIEW_LINE_HEIGHT 必须与左侧聊天 .code-block-body 行高一致', () => {
        expect(PREVIEW_LINE_HEIGHT).toBe(readLeftCodeBlockLineHeight());
    });

    it('getFileExplorerCSS 的代码预览/编辑器规则必须使用同一字体栈与行高', () => {
        const css = getFileExplorerCSS();
        for (const selector of ['.ws-preview-pre', '.ws-preview-code-container', '.ws-editor-container']) {
            const rule = extractRule(css, selector);
            expect(rule).toContain(`font-family: ${PREVIEW_FONT_FAMILY}`);
            expect(rule).toContain(`line-height: ${PREVIEW_LINE_HEIGHT}`);
        }
    });

    it('编辑器容器的字号必须与左侧代码块一致（--fs-sm），而非更大的正文档位', () => {
        const rule = extractRule(getFileExplorerCSS(), '.ws-editor-container');
        expect(rule).toContain('font-size: var(--fs-sm)');
    });

    it('注入 Shadow DOM 的 ace 样式必须锁定字体栈并显式声明容器行高', () => {
        const css = buildAceShadowStyles('/* theme */');
        expect(css).toContain('/* theme */');
        expect(css).toContain(`.ace_editor, .ace_editor * { font-family: ${PREVIEW_FONT_FAMILY} !important; }`);
        expect(css).toContain(`.ace_editor { line-height: ${PREVIEW_LINE_HEIGHT}; }`);
    });

    it('深色模式下 ace 样式必须把 dracula 默认底色覆盖为右侧边栏面板背景 #1e1e1e', () => {
        const light = buildAceShadowStyles('.ace-dracula { background-color: #282a36; }');
        expect(light).not.toContain('background-color: #1e1e1e');
        const dark = buildAceShadowStyles('.ace-dracula { background-color: #282a36; }', true);
        expect(dark).toContain('.ace_editor, .ace_editor .ace_gutter { background-color: #1e1e1e !important; }');
    });

    it('预览/编辑器头部与代码区浅色背景必须与右侧边栏面板背景 #fff 一致', () => {
        const css = getFileExplorerCSS();
        for (const selector of [
            '.ws-preview-header',
            '.ws-editor-toolbar',
            '.ws-preview-body',
            '.ws-preview-code-host'
        ]) {
            const rule = extractRule(css, selector);
            expect(rule).toContain('background: #fff');
        }
    });
});
