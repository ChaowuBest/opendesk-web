import { TodoWriteTool } from '../../../main/applications/todomgr/tools.js';
import { ToolCall } from '../../../main/aikernel/messages.js';
import { setRuntimeLocale } from '../../../locale/index.js';
import { deleteTaskTodos, getTaskTodosForDisplay } from '../../../main/aikernel/todos/task-todos.js';

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

describe('TodoWriteTool title fallback', () => {
    beforeAll(() => setRuntimeLocale('zh-CN'));
    afterAll(() => setRuntimeLocale(null));

    const tool = new TodoWriteTool({ emitEvent: async () => {} } as any);
    const TASK_ID = 'task-title-fallback';

    afterEach(() => deleteTaskTodos(TASK_ID));

    test('title defaults to content when omitted', async () => {
        await tool.execute(
            { todos: [{ content: '查看 0.3.8 release note 风格', status: 'in_progress' }] } as any,
            undefined,
            {
                task_id: TASK_ID
            } as any
        );

        const todos = getTaskTodosForDisplay(TASK_ID);
        expect(todos).toHaveLength(1);
        expect(todos[0].title).toBe('查看 0.3.8 release note 风格');
        expect(todos[0].content).toBe('查看 0.3.8 release note 风格');
    });

    test('explicit title is kept and fallback caps title at 200 chars', async () => {
        await tool.execute(
            {
                todos: [
                    { title: '明确标题', content: '详细内容', status: 'pending' },
                    { content: '长'.repeat(300), status: 'pending' }
                ]
            } as any,
            undefined,
            { task_id: TASK_ID } as any
        );

        const todos = getTaskTodosForDisplay(TASK_ID);
        expect(todos[0].title).toBe('明确标题');
        expect(todos[1].title).toBe('长'.repeat(200));
    });

    test('timing fields are absent instead of present-but-undefined', async () => {
        await tool.execute({ todos: [{ content: '待办', status: 'pending' }] } as any, undefined, {
            task_id: TASK_ID
        } as any);

        const [pendingTodo] = getTaskTodosForDisplay(TASK_ID);
        expect(Object.keys(pendingTodo)).not.toContain('started_at');
        expect(Object.keys(pendingTodo)).not.toContain('completed_at');

        await tool.execute(
            { todos: [{ id: pendingTodo.id, content: '待办', status: 'completed' }] } as any,
            undefined,
            { task_id: TASK_ID } as any
        );

        const [completedTodo] = getTaskTodosForDisplay(TASK_ID);
        expect(Object.keys(completedTodo)).toContain('started_at');
        expect(Object.keys(completedTodo)).toContain('completed_at');
    });
});
