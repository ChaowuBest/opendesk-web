import { jest } from '@jest/globals';

const fetchMock = jest.fn();

jest.unstable_mockModule('../../../platforms/base', () => ({
    getPlatform: () => ({
        fetch: fetchMock
    })
}));

const makeArxivXml = (
    title: string,
    id: string,
    summary: string,
    published = '2026-01-01T00:00:00Z'
) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>${id}</id>
    <title>${title}</title>
    <summary>${summary}</summary>
    <published>${published}</published>
    <updated>${published}</updated>
    <author><name>OpenDesk Test</name></author>
    <category term="cs.AI" />
  </entry>
</feed>`;

describe('arXiv 搜索工具', () => {
    beforeEach(() => {
        fetchMock.mockReset();
    });

    test('基本搜索 - "deep learning"', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            text: async () => makeArxivXml('Deep Learning Paper', 'https://arxiv.org/abs/1234.5678', 'summary')
        });

        const { ArxivSearchTool } = await import('../../../main/applications/search/tools/arxiv');
        const tool = new ArxivSearchTool();
        const result = await tool.execute({ query: 'deep learning', count: 3 });
        expect(result.status).toBe('success');
        expect(String(result.result)).toContain('Deep Learning Paper');
    });

    test('特定分类搜索 - "cat:cs.AI"', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            text: async () => makeArxivXml('AI Systems Paper', 'https://arxiv.org/abs/2345.6789', 'summary')
        });

        const { ArxivSearchTool } = await import('../../../main/applications/search/tools/arxiv');
        const tool = new ArxivSearchTool();
        const result = await tool.execute({
            query: 'cat:cs.AI',
            count: 2,
            sort_by: 'submittedDate',
            sort_order: 'descending'
        });
        expect(result.status).toBe('success');
        expect(String(result.result)).toContain('AI Systems Paper');
    });

    test('命令行渲染', async () => {
        const { ArxivSearchTool } = await import('../../../main/applications/search/tools/arxiv');
        const tool = new ArxivSearchTool();
        const mockToolCall = {
            index: 0,
            id: 'test-id',
            tool_name: 'arxivSearch',
            args_string: JSON.stringify({ query: 'machine learning' }),
            args_object: { query: 'machine learning' },
            status: 'success' as const,
            result: '**结果数量**: 5'
        };
        const rendered = tool.renderToolCallCli(mockToolCall as any, 80);
        expect(rendered).toBeDefined();
    });
});
