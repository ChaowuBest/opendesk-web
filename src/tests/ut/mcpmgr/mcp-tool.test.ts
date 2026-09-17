import { afterAll, beforeAll, expect, jest, test } from '@jest/globals';
import { AssistantMessage, ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import {
    BaseTaskUpdateSubscriber,
    TaskManagerState,
    TaskState,
    type TaskUpdateChunk
} from '../../../main/aikernel/states/tasks.js';
import { BaseToolset } from '../../../main/aikernel/tool.js';
import { MCPTool } from '../../../main/applications/mcpmgr/mcp-tool.js';
import { setRuntimeLocale } from '../../../locale/index.js';

beforeAll(() => setRuntimeLocale('zh-CN'));
afterAll(() => setRuntimeLocale(null));

function call(args: Record<string, unknown>): ToolCall {
    const value = new ToolCall(0, 'id', 'server__search', JSON.stringify(args));
    value.args_object = args;
    value.status = 'running';
    return value;
}

class HtmlSnapshotSubscriber extends BaseTaskUpdateSubscriber {
    wantsHtmlRender = true;

    constructor(private readonly chunks: TaskUpdateChunk[]) {
        super();
    }

    send(chunk: TaskUpdateChunk): void {
        this.chunks.push(JSON.parse(JSON.stringify(chunk)) as TaskUpdateChunk);
    }
}

test('injects a required description only for tools without that business parameter', async () => {
    const tool = new MCPTool('server', 'search', 'Search', {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false
    });
    const execute = jest.fn(async () => 'ok');
    tool.setExecutor(execute);

    const schema = tool.getJsonSchema();
    expect(schema.properties.description).toEqual(expect.objectContaining({ type: 'string' }));
    expect(schema.required).toContain('description');
    const args = { query: 'text', description: 'Find <button> & docs' };
    const validation = tool.validateArgs(args);
    expect(validation).toEqual({ success: true, data: args });

    const result = await tool.execute(args);
    expect(result.status).toBe('success');
    expect(execute).toHaveBeenCalledWith({ query: 'text' }, undefined, undefined);

    const html = await tool.renderToolCall(call(validation.success ? validation.data : {}));
    expect(html).toContain('title="server · search"');
    expect(html).toContain('MCP工具');
    expect(html).toContain('Find &lt;button&gt; &amp; docs');
    expect(html).not.toContain('<button>');
});

test('forwards the display description when the server schema permits extra parameters', async () => {
    const tool = new MCPTool('server', 'search', 'Search', {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: true
    });
    const execute = jest.fn(async () => 'ok');
    tool.setExecutor(execute);

    const args = { query: 'text', description: 'Find documentation' };
    expect((await tool.execute(args)).status).toBe('success');
    expect(execute).toHaveBeenCalledWith(args, undefined, undefined);
});

test('reuses and preserves a server-defined description parameter', async () => {
    const tool = new MCPTool('server', 'create', 'Create', {
        type: 'object',
        properties: { description: { type: 'string' }, name: { type: 'string' } },
        required: ['description', 'name'],
        additionalProperties: false
    });
    const execute = jest.fn(async () => 'ok');
    tool.setExecutor(execute);

    expect(tool.hasInjectedDescription).toBe(false);
    expect(tool.getJsonSchema().required).toContain('description');
    expect(Object.keys(tool.getJsonSchema().properties)).toEqual(['description', 'name']);
    const result = await tool.execute({ description: 'Business data', name: 'item' });
    expect(result.status).toBe('success');
    expect(execute).toHaveBeenCalledWith({ description: 'Business data', name: 'item' }, undefined, undefined);

    const html = await tool.renderToolCall(call({ description: 'Business data', name: 'item' }));
    expect(html).toContain('Business data');
});

test('preserves composed schemas and detects a business description inside allOf', async () => {
    const tool = new MCPTool('server', 'create', 'Create', {
        type: 'object',
        allOf: [
            {
                type: 'object',
                properties: { description: { type: 'string' } },
                required: ['description']
            },
            {
                type: 'object',
                properties: { count: { type: 'number' } },
                required: ['count']
            }
        ]
    });
    const execute = jest.fn(async () => 'ok');
    tool.setExecutor(execute);

    expect(tool.hasInjectedDescription).toBe(false);
    expect(tool.getJsonSchema()).toHaveProperty('allOf');
    expect(tool.validateArgs({ anything: true }).success).toBe(false);
    const result = await tool.execute({ description: 'Business data', count: 2 });
    expect(result.status).toBe('success');
    expect(execute).toHaveBeenCalledWith({ description: 'Business data', count: 2 }, undefined, undefined);
});

test('keeps composed validation when injecting a display description', async () => {
    const tool = new MCPTool('server', 'search', 'Search', {
        type: 'object',
        allOf: [
            {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
                additionalProperties: false
            }
        ]
    });
    const execute = jest.fn(async () => 'ok');
    tool.setExecutor(execute);

    expect(tool.hasInjectedDescription).toBe(true);
    expect(tool.getJsonSchema()).toHaveProperty('allOf');
    expect(tool.getJsonSchema().properties.description).toEqual(expect.objectContaining({ type: 'string' }));
    expect(tool.getJsonSchema().allOf[0].properties.description).toEqual(expect.objectContaining({ type: 'string' }));
    expect(tool.validateArgs({ description: 'Find docs' }).success).toBe(false);
    const result = await tool.execute({ query: 'button', description: 'Find docs' });
    expect(result.status).toBe('success');
    expect(execute).toHaveBeenCalledWith({ query: 'button' }, undefined, undefined);
});

test('truncates string descriptions and falls back to the full tool name for other types', async () => {
    const tool = new MCPTool('server', 'search', 'Search', {
        type: 'object',
        properties: { description: {} }
    });
    const longDescription = 'x'.repeat(100);

    expect(await tool.renderToolCall(call({ description: 42 }))).toContain('>server · search</span>');
    expect(await tool.renderToolCall(call({ description: { purpose: 'search' } }))).toContain(
        '>server · search</span>'
    );
    expect(tool.renderToolCallCli(call({ description: 42 }), 100)?.join('\n')).toContain('server · search');
    const truncated = await tool.renderToolCall(call({ description: longDescription }));
    expect(truncated).toContain(`${'x'.repeat(79)}…`);
    expect(truncated).not.toContain(longDescription);

    const fallback = await tool.renderToolCall(call({ description: '   ' }));
    expect(fallback).toContain('server · search');
    expect(fallback).toContain('title="server · search"');
});

test('keeps the MCP identity and purpose when rendering an error', async () => {
    const tool = new MCPTool('server', 'search', 'Search', {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
    });
    const toolCall = call({ query: 'button', description: 'Find button docs' });
    toolCall.status = 'error';
    toolCall.result = '<failed request>';
    toolCall.setTool(tool);

    const html = await toolCall.render();
    expect(html).toContain('title="server · search"');
    expect(html).toContain('MCP工具');
    expect(html).toContain('Find button docs');
    expect(html).toContain('&lt;failed request&gt;');
    expect(html).not.toContain('<failed request>');
});

test('keeps the purpose after TaskState validates and completes the tool call', async () => {
    const manager = new TaskManagerState();
    manager.save = jest.fn() as any;
    manager.publishTaskListUpdate = jest.fn() as any;
    manager.moveTaskToEnd = jest.fn() as any;
    const task = new TaskState(manager);
    task.task_status = 'running';

    const tool = new MCPTool('server', 'search', 'Search', {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false
    });
    const args = { query: 'button', description: 'Find button documentation' };
    const toolCall = new ToolCall(0, 'call-lifecycle', tool.name, JSON.stringify(args));
    toolCall.args_object = args;
    toolCall.setTool(tool);
    let runningHtml = '';
    const execute = jest.fn(async () => {
        runningHtml = await toolCall.render();
        return 'done';
    });
    tool.setExecutor(execute);
    const toolset = new BaseToolset('mcp-test');
    toolset.addTool(tool);
    task.chat_context.attachToolsets(toolset);

    const pendingHtml = await toolCall.render();
    await task.processToolCall(toolCall, true);
    await toolCall.freezeRenderResult();

    expect(toolCall.status).toBe('success');
    expect(toolCall.args_object).toEqual(args);
    expect(execute).toHaveBeenCalledWith({ query: 'button' }, task, toolCall);
    expect(pendingHtml).toContain('Find button documentation');
    expect(runningHtml).toContain('Find button documentation');
    expect(toolCall.rendered).toContain('MCP工具');
    expect(toolCall.rendered).toContain('Find button documentation');
    expect(toolCall.rendered).not.toContain('server · search</span>');
});

test('keeps every purpose while multiple MCP calls execute in parallel', async () => {
    const manager = new TaskManagerState();
    manager.save = jest.fn() as any;
    manager.publishTaskListUpdate = jest.fn() as any;
    manager.moveTaskToEnd = jest.fn() as any;
    const task = new TaskState(manager);
    task.task_status = 'running';

    const toolset = new BaseToolset('mcp-parallel-test');
    const part = new ToolCallMessagePart();
    const purposes = ['Ask about React Fiber', 'Get the current date', 'Find stations in Beijing'];
    const releases: Array<() => void> = [];
    const started: Promise<void>[] = [];
    const executors: Array<ReturnType<typeof jest.fn>> = [];

    for (let index = 0; index < purposes.length; index++) {
        const tool = new MCPTool('server', `tool${index}`, 'Test', {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false
        });
        let markStarted!: () => void;
        started.push(new Promise<void>((resolve) => (markStarted = resolve)));
        const release = new Promise<void>((resolve) => releases.push(resolve));
        const executor = jest.fn(async () => {
            markStarted();
            await release;
            return 'done';
        });
        executors.push(executor);
        tool.setExecutor(executor);
        toolset.addTool(tool);

        const args = { query: `query-${index}`, description: purposes[index] };
        part.push(new ToolCall(index, `parallel-${index}`, tool.name, JSON.stringify(args)));
    }

    task.chat_context.attachToolsets(toolset);

    const executions = part.toolcalls.map((toolCall) => task.processToolCall(toolCall, true));
    await Promise.all(started);
    const runningHtml = await part.render();

    releases[0]();
    await executions[0];
    const partiallyCompletedHtml = await part.render();

    releases.slice(1).forEach((release) => release());
    await Promise.all(executions);
    const completedHtml = await part.render();

    for (const purpose of purposes) {
        expect(runningHtml).toContain(purpose);
        expect(partiallyCompletedHtml).toContain(purpose);
        expect(completedHtml).toContain(purpose);
    }
    for (let index = 0; index < executors.length; index++) {
        expect(executors[index]).toHaveBeenCalledWith({ query: `query-${index}` }, task, part.toolcalls[index]);
        expect(part.toolcalls[index].args_object).toEqual({
            query: `query-${index}`,
            description: purposes[index]
        });
    }
});

test('publishes the purpose in Electron running and completed HTML updates', async () => {
    const manager = new TaskManagerState();
    manager.save = jest.fn() as any;
    manager.publishTaskListUpdate = jest.fn() as any;
    manager.moveTaskToEnd = jest.fn() as any;
    const task = new TaskState(manager);
    task.task_status = 'running';
    Object.defineProperty(task, 'needsHtmlRender', { value: true });

    const purpose = 'Look up the React Fiber architecture';
    const tool = new MCPTool('deepwiki', 'ask_question', 'Ask a question', {
        type: 'object',
        properties: { repoName: { type: 'string' }, question: { type: 'string' } },
        required: ['repoName', 'question'],
        additionalProperties: false
    });
    tool.setExecutor(async () => 'answer');
    const toolset = new BaseToolset('mcp-subscription-test');
    toolset.addTool(tool);
    task.chat_context.attachToolsets(toolset);

    const args = {
        repoName: 'facebook/react',
        question: 'How does Fiber work?',
        description: purpose
    };
    const toolCall = new ToolCall(0, 'subscription-call', tool.name, JSON.stringify(args));
    const part = new ToolCallMessagePart();
    part.push(toolCall);
    task.chat_context.appendMessage(new AssistantMessage([part]));

    const chunks: TaskUpdateChunk[] = [];
    task.addSubscriber(new HtmlSnapshotSubscriber(chunks));

    await task.processToolCalls();

    const assistantChunks = chunks.filter((chunk) => chunk.type === 'assistant');
    expect(assistantChunks.length).toBeGreaterThanOrEqual(2);
    const runningChunk = assistantChunks.find(
        (chunk) => chunk.type === 'assistant' && chunk.last_part.toolcalls[0]?.status === 'running'
    );
    const completedChunk = assistantChunks.find(
        (chunk) => chunk.type === 'assistant' && chunk.last_part.toolcalls[0]?.status === 'success'
    );
    expect(runningChunk?.type === 'assistant' ? runningChunk.last_part.rendered : undefined).toContain(purpose);
    expect(completedChunk?.type === 'assistant' ? completedChunk.last_part.rendered : undefined).toContain(purpose);
    expect(toolCall.args_object).toEqual(args);
    expect(JSON.parse(toolCall.args_string)).toEqual(args);

    const restored = ToolCall.assign(JSON.parse(JSON.stringify(toolCall)));
    expect(restored.args_object).toEqual(args);
    expect(await restored.render()).toContain(purpose);
});
