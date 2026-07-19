import { DuckDuckGoSearchTool } from '../../../main/applications/search/tools/duckduckgo';

let reachable = false;

beforeAll(async () => {
    try {
        const tool = new DuckDuckGoSearchTool();
        const probe = await tool.execute({ query: 'test', count: 1 });
        reachable = probe.status !== 'error';
    } catch {
        reachable = false;
    }
}, 30000);

describe('DuckDuckGo 搜索工具', () => {
    test('基本搜索 - "OpenAI GPT"', async () => {
        if (!reachable) return;

        const tool = new DuckDuckGoSearchTool();
        const result = await tool.execute({ query: 'OpenAI GPT', count: 5 });
        expect(result.status).not.toBe('error');
    }, 30000);

    test('中文搜索 - "人工智能发展趋势"', async () => {
        if (!reachable) return;

        const tool = new DuckDuckGoSearchTool();
        const result = await tool.execute({ query: '人工智能发展趋势', count: 3, region: 'cn-zh' });
        expect(result.status).not.toBe('error');
    }, 30000);

    test('不同区域搜索 - "machine learning" (us-en)', async () => {
        if (!reachable) return;

        const tool = new DuckDuckGoSearchTool();
        const result = await tool.execute({ query: 'machine learning', count: 3, region: 'us-en' });
        expect(result.status).not.toBe('error');
    }, 30000);

    test('命令行渲染', () => {
        const tool = new DuckDuckGoSearchTool();
        const mockToolCall = {
            index: 0,
            id: 'test-id',
            tool_name: 'duckduckgoSearch',
            args_string: JSON.stringify({ query: 'TypeScript tutorial' }),
            args_object: { query: 'TypeScript tutorial', region: 'us-en' },
            status: 'success' as const,
            result: '**结果数量**: 5'
        };
        const rendered = tool.renderToolCallCli(mockToolCall as any, 80);
        expect(rendered).toBeDefined();
    });

    test('空关键词应返回错误', async () => {
        const tool = new DuckDuckGoSearchTool();
        const result = await tool.execute({ query: '', count: 5 });
        expect(result.status).toBe('error');
    }, 30000);
});
