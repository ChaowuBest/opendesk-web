import { z } from 'zod';
import { AssistantMessage, ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';
import { resolveStreamingToolCallsForTask } from '../../../main/aikernel/task/tool-resolver.js';

/**
 * Bug 1: processToolCall 在用 jsonrepair 解析 args_string 后应同步更新 args_string，
 * 使其成为合法 JSON。这样下游 sanitizeOutboundMessage 用 JSON.parse 检查时能通过，
 * 不会错误地清空参数。
 */
describe('processToolCall: sync repaired args_string', () => {
    test('jsonrepair 修复后的 args_string 被同步更新', async () => {
        const { task, cleanup } = await createTaskWithTool();

        // trailing comma - JSON.parse 失败，但 jsonrepair 可修复
        const malformedArgs = '{"path": "/test.txt", "mode": "overwrite",}';
        const toolCall = new ToolCall(0, 'call-test', 'testTool', malformedArgs);

        await task.processToolCall(toolCall, true);

        // args_string 应被更新为合法 JSON
        expect(() => JSON.parse(toolCall.args_string)).not.toThrow();
        expect(JSON.parse(toolCall.args_string)).toEqual({
            path: '/test.txt',
            mode: 'overwrite'
        });

        cleanup();
    });

    test('合法 JSON 的 args_string 保持不变', async () => {
        const { task, cleanup } = await createTaskWithTool();

        const validArgs = '{"path": "/test.txt", "mode": "overwrite"}';
        const toolCall = new ToolCall(0, 'call-test', 'testTool', validArgs);

        await task.processToolCall(toolCall, true);

        expect(toolCall.args_string).toBe(validArgs);

        cleanup();
    });
});

/**
 * Bug 2: resolveStreamingToolCallsForTask 不应覆盖已执行完成（status !== 'pending'）的
 * ToolCall 的 args_object。
 */
describe('resolveStreamingToolCallsForTask: skip non-pending tool calls', () => {
    test('已执行的工具调用的 args_object 不被覆盖', () => {
        const task = new TaskState(new TaskManagerState(), null);
        const tc = new ToolCall(0, 'call-done', 'testTool', '{}');
        tc.status = 'success';
        tc.args_object = { path: '/test.txt', content: 'hello' };

        const part = new ToolCallMessagePart();
        part.toolcalls.push(tc);
        const message = new AssistantMessage([part]);

        resolveStreamingToolCallsForTask(task, message);

        expect(tc.args_object).toEqual({ path: '/test.txt', content: 'hello' });
    });

    test('pending 状态的工具调用仍正常解析 args_object', () => {
        const task = new TaskState(new TaskManagerState(), null);
        const tc = new ToolCall(0, 'call-pending', 'testTool', '{"path": "/test.txt"}');
        tc.status = 'pending';

        const part = new ToolCallMessagePart();
        part.toolcalls.push(tc);
        const message = new AssistantMessage([part]);

        resolveStreamingToolCallsForTask(task, message);

        expect(tc.args_object).toEqual({ path: '/test.txt' });
    });

    test('混合场景：已执行的不覆盖，pending 的正常解析', () => {
        const task = new TaskState(new TaskManagerState(), null);

        const doneTc = new ToolCall(0, 'call-done', 'testTool', '{}');
        doneTc.status = 'success';
        doneTc.args_object = { file_path: '/done.txt' };

        const pendingTc = new ToolCall(1, 'call-pending', 'testTool', '{"path": "/pending.txt"}');
        pendingTc.status = 'pending';

        const part = new ToolCallMessagePart();
        part.toolcalls.push(doneTc, pendingTc);
        const message = new AssistantMessage([part]);

        resolveStreamingToolCallsForTask(task, message);

        expect(doneTc.args_object).toEqual({ file_path: '/done.txt' });
        expect(pendingTc.args_object).toEqual({ path: '/pending.txt' });
    });
});

async function createTaskWithTool(): Promise<{ task: TaskState; cleanup: () => void }> {
    const manager = new TaskManagerState();
    manager.save = (() => {}) as any;
    manager.publishTaskListUpdate = (() => {}) as any;
    manager.moveTaskToEnd = (() => {}) as any;
    const task = new TaskState(manager);
    task.task_status = 'running';

    const tool = new BaseTool('testTool', 'test tool', z.object({})).setExecutor(async () => 'ok');
    const toolset = new BaseToolset('test');
    toolset.addTools(tool);
    task.chat_context.attachToolsets(toolset);

    return { task, cleanup: () => {} };
}
