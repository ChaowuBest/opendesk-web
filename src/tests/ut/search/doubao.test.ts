import { DoubaoSearchTool } from '../../../main/applications/search/tools/doubao';

const apiKey = process.env.DOUBAO_API_KEY;

let reachable = false;

beforeAll(async () => {
    if (!apiKey) return;
    try {
        const tool = new DoubaoSearchTool(apiKey);
        const probe = await tool.execute({ query: 'test', count: 1 });
        reachable = probe.status !== 'error';
    } catch {
        reachable = false;
    }
}, 30000);

describe('豆包搜索工具', () => {
    let tool: DoubaoSearchTool;

    beforeAll(() => {
        tool = new DoubaoSearchTool(apiKey!);
    });

    test('基本搜索 - "人工智能发展趋势"', async () => {
        if (!reachable) return;

        const result = await tool.execute({ query: '人工智能发展趋势', count: 5 });
        expect(result.status).not.toBe('error');
        expect(result.result).toContain('**结果数量**');
    }, 30000);

    test('返回结果包含 url 与摘要', async () => {
        if (!reachable) return;

        const result = await tool.execute({ query: 'OpenHarmony 5.1 发布', count: 3 });
        expect(result.status).not.toBe('error');
        expect(result.result).toContain('url:');
        expect(result.result).toContain('<summary>');
    }, 30000);

    test('命令行渲染', () => {
        const mockToolCall = {
            index: 0,
            id: 'test-id',
            tool_name: 'doubaoSearch',
            args_string: JSON.stringify({ query: '机器学习' }),
            args_object: { query: '机器学习' },
            status: 'success' as const,
            result: '## 豆包搜索结果\n**结果数量**: 5'
        };
        const rendered = tool.renderToolCallCli(mockToolCall as any, 80);
        expect(rendered).toBeDefined();
        expect(rendered!.join('')).toContain('豆包');
    });

    test('inline 渲染', async () => {
        const mockToolCall = {
            index: 0,
            id: 'test-id',
            tool_name: 'doubaoSearch',
            args_string: JSON.stringify({ query: '机器学习' }),
            args_object: { query: '机器学习' },
            status: 'success' as const,
            result: '## 豆包搜索结果\n**结果数量**: 5'
        };
        const rendered = await tool.renderToolCall(mockToolCall as any);
        expect(rendered).toBeDefined();
        expect(rendered).toContain('搜索 (豆包)');
        expect(rendered).toContain('5 条结果');
    });
});
