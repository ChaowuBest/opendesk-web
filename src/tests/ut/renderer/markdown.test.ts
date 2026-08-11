import { renderSafeMarkdown } from '../../../renderer/utils/markdown.js';
import { Marked } from 'marked';
import { cjkAutolinkFix } from '../../../common/markdown/cjk-autolink-fix.js';

describe('safe Markdown rendering', () => {
    test('renders common Markdown structures used in staff conversations', () => {
        const html = renderSafeMarkdown('## Status\n\n**Ready**\n\n- one\n- two\n\n`code`');

        expect(html).toContain('<h2>Status</h2>');
        expect(html).toContain('<strong>Ready</strong>');
        expect(html).toContain('<li>one</li>');
        expect(html).toContain('<code>code</code>');
    });

    test('escapes raw HTML and rejects executable link and image protocols', () => {
        const html = renderSafeMarkdown(
            '<script>alert(1)</script>\n\n[x](javascript:alert(2))\n\n![x](data:image/svg+xml,<svg/onload=alert(3)>)'
        );

        expect(html).not.toContain('<script>');
        expect(html).not.toContain('href="javascript:');
        expect(html).not.toContain('src="data:');
        expect(html).toContain('&lt;script&gt;');
    });

    test('opens safe web links without exposing the opener', () => {
        const html = renderSafeMarkdown('[OpenDesk](https://example.com/docs)');

        expect(html).toContain('href="https://example.com/docs"');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
    });
});

describe('CJK autolink fix', () => {
    const marked = new Marked();
    marked.use(cjkAutolinkFix);

    test('truncates URL at CJK fullwidth period (。)', () => {
        const html = marked.parse('浏览器现在显示的就是 https://www.baidu.com。需要我在页面上做点什么操作吗？', {
            async: false
        }) as string;

        expect(html).toContain('href="https://www.baidu.com"');
        expect(html).not.toContain('%E3%80%82');
        expect(html).toContain('需要我在页面上');
    });

    test('preserves CJK characters in a valid URL path', () => {
        const html = marked.parse('https://zh.wikipedia.org/wiki/中文', { async: false }) as string;

        expect(html).toContain('href="https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87"');
        expect(html).toContain('https://zh.wikipedia.org/wiki/中文');
    });

    test('preserves CJK characters in URL query values', () => {
        const html = marked.parse('https://example.com/search?q=结果', { async: false }) as string;

        expect(html).toContain('href="https://example.com/search?q=%E7%BB%93%E6%9E%9C"');
    });

    test('truncates URL at fullwidth comma (，)', () => {
        const html = marked.parse('访问 https://example.com，获取更多信息', { async: false }) as string;

        expect(html).toContain('href="https://example.com"');
        expect(html).toContain('获取更多信息');
    });

    test('preserves normal URL followed by ASCII text', () => {
        const html = marked.parse('Visit https://example.com for more info', { async: false }) as string;

        expect(html).toContain('href="https://example.com"');
    });

    test('preserves URL followed by ASCII trailing punctuation', () => {
        const html = marked.parse('Check https://example.com.', { async: false }) as string;

        expect(html).toContain('href="https://example.com"');
        expect(html).not.toContain('href="https://example.com."');
    });

    test('preserves URL with query string and fragment', () => {
        const html = marked.parse('See https://example.com/search?q=test#results for details', {
            async: false
        }) as string;

        expect(html).toContain('href="https://example.com/search?q=test#results"');
    });

    test('preserves URL in explicit markdown link with CJK label', () => {
        const html = marked.parse('[百度](https://www.baidu.com)', { async: false }) as string;

        expect(html).toContain('href="https://www.baidu.com"');
        expect(html).toContain('百度');
    });

    test('reproduces the exact bug from task_msned5jx_rtb7', () => {
        const text =
            '百度首页已打开！浏览器现在显示的就是 https://www.baidu.com。需要我在页面上做点什么操作吗？比如搜索、点击等，随时说。';
        const html = marked.parse(text, { async: false }) as string;

        // The href must be exactly the URL, not URL-encoded CJK text
        expect(html).toContain('href="https://www.baidu.com"');
        expect(html).not.toContain('%E3%80%82');
        expect(html).not.toContain('%E9%9C%80');
        // The CJK text after the URL should be rendered as plain text
        expect(html).toContain('需要我在页面上做点什么操作吗');
    });
});
