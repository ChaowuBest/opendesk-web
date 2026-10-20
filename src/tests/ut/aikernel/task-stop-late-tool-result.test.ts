import { jest } from '@jest/globals';
import { z } from 'zod';
import { AssistantMessage, ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';

function makeTask(): TaskState {
    const manager = new TaskManagerState();
    manager.save = jest.fn() as any;
    manager.publishTaskListUpdate = jest.fn() as any;
    manager.moveTaskToEnd = jest.fn() as any;
    const task = new TaskState(manager);
    task.task_status = 'running';
    task.persistLater = jest.fn() as any;
    return task;
}

function attachTool(task: TaskState, tool: BaseTool<any>): void {
    const toolset = new BaseToolset('test');
    toolset.addTool(tool);
    task.chat_context.attachToolsets(toolset);
}

/** 把工具调用挂到会话历史上，stop() 的 markInterruptedToolCalls 才能看见它。 */
function attachRunningToolCall(task: TaskState, toolCall: ToolCall): void {
    const part = new ToolCallMessagePart();
    part.toolcalls = [toolCall];
    const message = new AssistantMessage();
    message.content = [part];
    task.chat_context.messages.push(message);
}

describe('工具执行结果', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('没有被停止时工具结果照常写回', async () => {
        const task = makeTask();
        const tool = new BaseTool('fast', 'fast tool', z.object({})).setExecutor(async () => 'normal result');
        attachTool(task, tool);
        const toolCall = new ToolCall(0, 'call-normal', 'fast', '{}');
        attachRunningToolCall(task, toolCall);

        await task.processToolCall(toolCall, true);
        expect(toolCall.status).toBe('success');
        expect(toolCall.result).toBe('normal result');
    });
});
