import { TodoWriteTool } from '../../../main/applications/todomgr/tools.js';
import { ToolCall } from '../../../main/aikernel/messages.js';
import { setRuntimeLocale } from '../../../locale/index.js';

function makeCall(todos: Array<Record<string, unknown>>): ToolCall {
    const call = new ToolCall(0, 'call-todo', 'TodoWrite', JSON.stringify({ todos }));
    call.args_object = { todos };
    return call;
}

describe('TodoWriteTool display name and rendering', () => {
    beforeAll(() => setRuntimeLocale('zh-CN'));
    afterAll(() => setRuntimeLocale(null));

    const tool = new TodoWriteTool({} as any);

    test('registers the task-level planning display name', () => {
        expect(tool.getDisplayName()).toEqual({ 'zh-CN': '任务规划', 'en-US': 'Plan Tasks' });
        expect(tool.getResolvedDisplayName('zh-CN')).toBe('任务规划');
        expect(tool.getResolvedDisplayName('en-US')).toBe('Plan Tasks');
    });

    test('renders the create title for new todos without ids', async () => {
        const html = await tool.renderToolCall(makeCall([{ title: '写报告', content: '完成季度报告' }]));
        expect(html).toContain('任务规划');
        expect(html).not.toContain('更新任务规划');
    });

    test('renders the update title when every todo carries an id', async () => {
        const html = await tool.renderToolCall(makeCall([{ id: 't1', title: '写报告', content: '完成季度报告' }]));
        expect(html).toContain('更新任务规划');
    });

    test('renders the disabled title when all todos are disabled', async () => {
        const html = await tool.renderToolCall(
            makeCall([{ id: 't1', title: '写报告', content: '完成季度报告', enabled: false }])
        );
        expect(html).toContain('任务计划未启用');
    });

    test('cli summary distinguishes create from update', async () => {
        const createRows = tool.renderToolCallCli(makeCall([{ title: '写报告', content: '完成季度报告' }]), 80);
        expect(createRows?.[0]).toContain('任务规划');

        const updateRows = tool.renderToolCallCli(
            makeCall([{ id: 't1', title: '写报告', content: '完成季度报告' }]),
            80
        );
        expect(updateRows?.[0]).toContain('更新任务规划');
    });
});
