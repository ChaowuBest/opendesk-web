import { TextMessagePart } from '../../../main/aikernel/messages';

async function renderCodeBlock(code: string, lang?: string): Promise<string> {
    const fence = '```';
    const source = lang ? `${fence}${lang}\n${code}\n${fence}` : `${fence}\n${code}\n${fence}`;
    const part = new TextMessagePart(source);
    await part.render();
    return part.rendered || '';
}

describe('代码块渲染（pre/code + CSS 计数器行号）', () => {
    test('输出 pre/code 结构且不再使用逐行表格', async () => {
        const html = await renderCodeBlock('const a = 1;\nconst b = 2;', 'javascript');
        expect(html).toContain('<pre class="code-block-pre font-mono"><code class="code-lines">');
        expect(html).toContain('<span class="code-line font-mono">');
        expect(html).not.toContain('<table');
        expect(html).not.toContain('td');
    });

    test('行数与代码行一一对应，行号不在 HTML 文本中（由 CSS 计数器生成）', async () => {
        const html = await renderCodeBlock('line-one\nline-two\nline-three', 'plaintext');
        const lineSpans = html.match(/<span class="code-line font-mono">/g) || [];
        expect(lineSpans).toHaveLength(3);
        expect(html).not.toMatch(/>(\d+)<\/span>/);
        expect(html).toContain('line-one');
        expect(html).toContain('line-three');
    });

    test('每行保留 hljs 高亮标记', async () => {
        const html = await renderCodeBlock('const a = 1;', 'javascript');
        expect(html).toContain('hljs-');
    });

    test('跨行注释的每个代码行都包含闭合的高亮标签', async () => {
        const html = await renderCodeBlock('/**\n * comment\n */\nconst value = 1;', 'typescript');
        const expectedCommentLines = [
            '<span class="code-line font-mono"><span class="hljs-comment">/**</span></span>',
            '<span class="code-line font-mono"><span class="hljs-comment"> * comment</span></span>',
            '<span class="code-line font-mono"><span class="hljs-comment"> */</span></span>'
        ];

        for (const line of expectedCommentLines) {
            expect(html).toContain(line);
        }
    });

    test('空行渲染为占位空格，保持行框高度', async () => {
        const html = await renderCodeBlock('first\n\nthird', 'plaintext');
        const lineSpans = html.match(/<span class="code-line font-mono">[^<]*<\/span>/g) || [];
        expect(lineSpans.some((span) => span.includes('> <'))).toBe(true);
    });

    test('可预览语言保留 data-previewable 与 data-raw-code 属性', async () => {
        const html = await renderCodeBlock('<p>hi</p>', 'html');
        expect(html).toContain('data-previewable="true"');
        expect(html).toContain('data-preview-lang="html"');
        const rawCode = Buffer.from('<p>hi</p>').toString('base64');
        expect(html).toContain(`data-raw-code="${rawCode}"`);
    });

    test('mermaid 代码块仍输出占位容器，不受新结构影响', async () => {
        const html = await renderCodeBlock('graph TD;\nA-->B;', 'mermaid');
        expect(html).toContain('mermaid-block');
        expect(html).not.toContain('code-lines');
    });
});
