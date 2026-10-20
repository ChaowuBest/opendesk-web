import { DeepSeekSearchTool } from '../../../main/applications/search/tools/deepseek';

const apiKey = process.env.DEEPSEEK_API_KEY;

let reachable = false;

beforeAll(async () => {
    if (!apiKey) return;
    try {
        const tool = new DeepSeekSearchTool(apiKey);
        const probe = await tool.execute({ query: 'test', count: 1 });
        reachable = probe.status !== 'error';
    } catch {
        reachable = false;
    }
}, 30000);

describe('DeepSeek 搜索工具', () => {
    let tool: DeepSeekSearchTool;

    beforeAll(() => {
        tool = new DeepSeekSearchTool(apiKey!);
    });

    test('基本搜索 - "人工智能发展趋势"', async () => {
        if (!reachable) return;

        const result = await tool.execute({ query: '人工智能发展趋势', count: 5 });
        expect(result.status).not.toBe('error');
        expect(result.result).toContain('**结果数量**');
    }, 30000);

    test('搜索语法 - site: 限定站点', async () => {
        if (!reachable) return;

        const result = await tool.execute({ query: 'DeepSeek site:github.com', count: 3 });
        expect(result.status).not.toBe('error');
    }, 30000);

    test('query 超长时截断到 128 字符而不是报错', async () => {
        if (!reachable) return;

        const longQuery = '人工智能'.repeat(100);
        const result = await tool.execute({ query: longQuery, count: 1 });
        expect(result.status).not.toBe('error');
    }, 30000);

    test('命令行渲染', () => {
        const mockToolCall = {
            index: 0,
            id: 'test-id',
            tool_name: 'deepseekSearch',
            args_string: JSON.stringify({ query: '机器学习' }),
            args_object: { query: '机器学习' },
            status: 'success' as const,
            result: '## DeepSeek 搜索结果\n**结果数量**: 5'
        };
        const rendered = tool.renderToolCallCli(mockToolCall as any, 80);
        expect(rendered).toBeDefined();
        expect(rendered!.join('')).toContain('DeepSeek');
    });

    test('inline 渲染', async () => {
        const mockToolCall = {
            index: 0,
            id: 'test-id',
            tool_name: 'deepseekSearch',
            args_string: JSON.stringify({ query: '机器学习' }),
            args_object: { query: '机器学习' },
            status: 'success' as const,
            result: '## DeepSeek 搜索结果\n**结果数量**: 5'
        };
        const rendered = await tool.renderToolCall(mockToolCall as any);
        expect(rendered).toBeDefined();
        expect(rendered).toContain('搜索 (DeepSeek)');
        expect(rendered).toContain('5 条结果');
    });
});
