import { renderSafeMarkdown } from '../../../renderer/utils/markdown.js';

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
