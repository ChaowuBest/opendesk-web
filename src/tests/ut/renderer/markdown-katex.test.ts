/**
 * Issue #332 回归测试：渲染端流式兜底渲染必须支持 KaTeX 数学公式。
 *
 * 现象（截图 screenshot_20261022_203010.jpg）：中断轮的消息由渲染端
 * renderSafeMarkdown 兜底渲染，但 renderer 的 safeMarked 实例未启用
 * marked-katex-extension，`$E=mc^2$` 等行内/块级公式以源码露出。
 * 修复：renderer 的 safeMarked 启用与主进程一致的 KaTeX 扩展
 * （nonStandard: true，$..$ 行内 + $$..$$ 块级），其余安全策略不变。
 */
import { renderSafeMarkdown } from '../../../renderer/utils/markdown.js';

describe('renderer 兜底 markdown 渲染的 KaTeX 支持 (issue #332)', () => {
    test('行内公式 $...$ 渲染为 KaTeX HTML', () => {
        const html = renderSafeMarkdown('质能方程 $E=mc^2$ 是物理学基石。');

        expect(html).toContain('katex');
        expect(html).not.toContain('$E=mc^2$');
    });

    test('块级公式 $$...$$ 渲染为 KaTeX display 块', () => {
        const html = renderSafeMarkdown('$$\\begin{pmatrix}0&-r\\\\r&0\\end{pmatrix}$$');

        expect(html).toContain('katex');
        expect(html).toContain('katex-display');
        // 源码露出的形态是 <p>$$\begin{pmatrix}...$$</p> 纯文本；KaTeX 的
        // MathML annotation 内含原始 TeX 属正常无障碍输出，不算露出
        expect(html).not.toContain('<p>$$');
    });

    test('公式渲染失败时降级为源码而非抛错', () => {
        const html = renderSafeMarkdown('公式 $\\notacommand{x}$ 保持可读。');

        expect(html).toContain('保持可读');
    });

    test('既有安全策略不回退：HTML 转义与 javascript: 链接拦截仍然生效', () => {
        const html = renderSafeMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(2))');

        expect(html).not.toContain('<script>');
        expect(html).not.toContain('href="javascript:');
        expect(html).toContain('&lt;script&gt;');
    });

    test('既有 GFM 行为不回退：标题、加粗、删除线', () => {
        const html = renderSafeMarkdown('## 状态\n\n**完成** 与 ~~废弃~~');

        expect(html).toContain('<h2>状态</h2>');
        expect(html).toContain('<strong>完成</strong>');
        expect(html).toContain('<del>废弃</del>');
    });
});
