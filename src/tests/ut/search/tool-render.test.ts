import { renderSearchToolCall } from '../../../main/applications/search/tools/render.js';
import { ToolCall } from '../../../main/aikernel/messages.js';

describe('search tool GUI rendering', () => {
    test('renders an HTTP URL as a safe external link', () => {
        const call = new ToolCall(0, 'call-web-fetch', 'search-webFetch', '{}');
        call.status = 'success';

        const html = renderSearchToolCall({
            icon: 'fas fa-globe',
            title: '网页获取',
            toolcall: call,
            query: 'https://example.com/docs?a=1&b=2'
        });

        expect(html).toContain('href="https://example.com/docs?a=1&amp;b=2"');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
    });

    test.each(['javascript:alert(1)', 'file:///tmp/private.txt', '普通搜索词'])(
        'keeps non-web query %s as plain text',
        (query) => {
            const call = new ToolCall(0, 'call-search', 'search-WebSearch', '{}');
            const html = renderSearchToolCall({
                icon: 'fas fa-magnifying-glass',
                title: '搜索网页',
                toolcall: call,
                query
            });

            expect(html).not.toContain('<a ');
        }
    );
});
