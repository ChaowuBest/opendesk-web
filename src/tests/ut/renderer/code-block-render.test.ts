import {
    LANG_DISPLAY_NAMES,
    renderCodeBlockHtml,
    splitHighlightedLines
} from '../../../common/markdown/code-block-render';
import hljs from '../../../renderer/utils/highlight-registry';

describe('code-block-render 共享代码块外观契约', () => {
    test('结构与 taskview marked renderer 输出一致：wrapper/header/body/pre/code-lines/code-line', () => {
        const html = renderCodeBlockHtml('<span class="hljs-keyword">const</span> a = 1;', {
            lang: 'javascript',
            withHeader: true
        });
        expect(html).toContain('<div class="code-block-wrapper">');
        expect(html).toContain('<div class="code-block-header"><span class="code-block-lang">JavaScript</span></div>');
        expect(html).toContain('<div class="code-block-body hljs language-javascript">');
        expect(html).toContain('<pre class="code-block-pre font-mono"><code class="code-lines">');
        expect(html).toContain('<span class="code-line font-mono">');
    });

    test('语言显示名与原 messages.ts 映射一致（抽查 c/ts/py/cpp/csharp/rs/yml/ps1）', () => {
        expect(LANG_DISPLAY_NAMES['c']).toBe('C');
        expect(LANG_DISPLAY_NAMES['ts']).toBe('TypeScript');
        expect(LANG_DISPLAY_NAMES['py']).toBe('Python');
        expect(LANG_DISPLAY_NAMES['cpp']).toBe('C++');
        expect(LANG_DISPLAY_NAMES['csharp']).toBe('C#');
        expect(LANG_DISPLAY_NAMES['rs']).toBe('Rust');
        expect(LANG_DISPLAY_NAMES['yml']).toBe('YAML');
        expect(LANG_DISPLAY_NAMES['ps1']).toBe('PowerShell');
    });

    test('未知语言 header 显示首字母大写，明文注入的 HTML 被转义', () => {
        const html = renderCodeBlockHtml('plain', { lang: 'wisp', withHeader: true });
        expect(html).toContain('>Wisp</span>');
        const xss = renderCodeBlockHtml('x', { lang: '"><script>' });
        expect(xss).not.toContain('<script>');
        expect(xss).toContain('&lt;script&gt;');
    });

    test('跨行高亮 span 在行边界闭合并在下一行重开（splitHighlightedLines）', () => {
        const lines = splitHighlightedLines('<span class="hljs-comment">a\nb</span>');
        expect(lines).toEqual(['<span class="hljs-comment">a</span>', '<span class="hljs-comment">b</span>']);
    });

    test('空行渲染为占位空格，行号不由 HTML 文本携带（CSS counter 生成）', () => {
        const html = renderCodeBlockHtml('first\n\nthird');
        const spans = html.match(/<span class="code-line font-mono">[^<]*<\/span>/g) || [];
        expect(spans.some((s) => s === '<span class="code-line font-mono"> </span>')).toBe(true);
        expect(html).not.toMatch(/>\d+<\/span>/);
    });

    test('无语言且 withHeader 未指定时不输出 header（笔记裸 ``` 场景）', () => {
        const html = renderCodeBlockHtml('x');
        expect(html).not.toContain('code-block-header');
    });

    test('无语言但 withHeader: true 时输出空 header（taskview 兼容）', () => {
        const html = renderCodeBlockHtml('x', { withHeader: true });
        expect(html).toContain('<div class="code-block-header"><span class="code-block-lang"></span></div>');
    });

    test('preview 选项注入 data-previewable 系列属性（base64 原文）', () => {
        const raw = '<p>hi</p>';
        const html = renderCodeBlockHtml('x', {
            lang: 'html',
            preview: { langs: new Set(['html']), rawCode: raw }
        });
        expect(html).toContain('data-previewable="true"');
        expect(html).toContain('data-preview-lang="html"');
        expect(html).toContain(`data-raw-code="${Buffer.from(raw).toString('base64')}"`);
    });

    test('highlight-registry 覆盖常见语言且别名与全量包一致（csharp/swift/sql/bash）', () => {
        for (const lang of ['csharp', 'swift', 'sql', 'bash', 'shell', 'typescript', 'xml']) {
            expect(hljs.getLanguage(lang)).toBeTruthy();
        }
        const result = hljs.highlight('const x = 1;', { language: 'javascript' });
        expect(result.value).toContain('hljs-keyword');
        // plaintext 兜底可用
        expect(hljs.highlight('x', { language: 'plaintext' }).value).toBe('x');
    });

    test('与 taskview 真实渲染链路逐字节一致（同一高亮输入）', () => {
        const highlighted = hljs.highlight('int main() { return 0; }', { language: 'c' }).value;
        const html = renderCodeBlockHtml(highlighted, { lang: 'c', withHeader: true });
        expect(html).toBe(
            `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-block-lang">C</span></div>` +
                `<div class="code-block-body hljs language-c"><pre class="code-block-pre font-mono"><code class="code-lines">` +
                `<span class="code-line font-mono">${highlighted}</span></code></pre></div></div>`
        );
    });
});
