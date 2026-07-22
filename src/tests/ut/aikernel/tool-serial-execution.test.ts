import { jest } from '@jest/globals';
import { z } from 'zod';
import { AssistantMessage, ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';
import {
    WriteFileTool,
    EditFileTool,
    SearchReplaceTool,
    ApplyPatchTool,
    ReadFileTool,
    GlobFilesTool,
    GrepFilesTool
} from '../../../main/applications/filemgr/tools.js';
import type { DeviceMgrApplication } from '../../../main/applications/devicemgr/app.js';
import { createNodeExecutionTools } from '../../../main/applications/devicemgr/node-tools.js';

function createTask(): TaskState {
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();
    const task = new TaskState(manager);
    task.task_status = 'running';
    manager.tasks.push(task);
    return task;
}

function makeTool(name: string, serial: boolean): BaseTool<any> {
    const tool = new BaseTool(name, 'test tool', z.object({}));
    tool.serialExecution = serial;
    return tool;
}

function makeToolCall(id: string, toolName: string): ToolCall {
    return new ToolCall(0, id, toolName, '{}');
}

function appendToolCalls(task: TaskState, calls: ToolCall[]): void {
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    for (const call of calls) {
        part.push(call);
    }
    assistant.content.push(part);
    task.chat_context.appendMessage(assistant);
}

/**
 * 为 task 安装工具集并 mock processToolCall，返回执行日志。
 * 日志格式: ['callId:start', 'callId:end', ...]
 */
function setupTaskWithTracking(task: TaskState, tools: BaseTool<any>[]) {
    const toolset = new BaseToolset('test');
    toolset.addTools(...tools);
    task.chat_context.attachToolsets(toolset);

    const log: string[] = [];
    const spy = jest.spyOn(task, 'processToolCall').mockImplementation(async (tool_call: ToolCall) => {
        log.push(`${tool_call.id}:start`);
        await new Promise((r) => setTimeout(r, 10));
        tool_call.status = 'success';
        log.push(`${tool_call.id}:end`);
    });
    return { log, spy };
}

describe('processToolCalls serial/parallel execution', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('serial tools execute sequentially without overlap', async () => {
        const task = createTask();
        const { log } = setupTaskWithTracking(task, [makeTool('serialA', true), makeTool('serialB', true)]);
        appendToolCalls(task, [makeToolCall('call-a', 'serialA'), makeToolCall('call-b', 'serialB')]);

        await task.processToolCalls();

        // 第一个工具必须先 start 再 end，第二个才 start
        expect(log.indexOf('call-a:start')).toBeLessThan(log.indexOf('call-a:end'));
        expect(log.indexOf('call-a:end')).toBeLessThan(log.indexOf('call-b:start'));
        expect(log.indexOf('call-b:start')).toBeLessThan(log.indexOf('call-b:end'));
    });

    test('parallel tools execute concurrently with overlap', async () => {
        const task = createTask();
        const { log } = setupTaskWithTracking(task, [makeTool('parallelA', false), makeTool('parallelB', false)]);
        appendToolCalls(task, [makeToolCall('call-c', 'parallelA'), makeToolCall('call-d', 'parallelB')]);

        await task.processToolCalls();

        // 两个工具都 start 后才出现 end —— 证明并发
        const firstEnd = Math.min(log.indexOf('call-c:end'), log.indexOf('call-d:end'));
        const secondStart = Math.max(log.indexOf('call-c:start'), log.indexOf('call-d:start'));
        expect(secondStart).toBeLessThan(firstEnd);
    });

    test('mixed serial and parallel: serial group sequential, parallel group concurrent', async () => {
        const task = createTask();
        const { log } = setupTaskWithTracking(task, [
            makeTool('serialA', true),
            makeTool('serialB', true),
            makeTool('parallelA', false),
            makeTool('parallelB', false)
        ]);
        appendToolCalls(task, [
            makeToolCall('s1', 'serialA'),
            makeToolCall('p1', 'parallelA'),
            makeToolCall('s2', 'serialB'),
            makeToolCall('p2', 'parallelB')
        ]);

        await task.processToolCalls();

        // 串行组内部无重叠
        expect(log.indexOf('s1:end')).toBeLessThan(log.indexOf('s2:start'));

        // 并行组内部有重叠
        const pFirstEnd = Math.min(log.indexOf('p1:end'), log.indexOf('p2:end'));
        const pSecondStart = Math.max(log.indexOf('p1:start'), log.indexOf('p2:start'));
        expect(pSecondStart).toBeLessThan(pFirstEnd);
    });

    test('serial tool error does not block subsequent serial tools', async () => {
        const task = createTask();
        const toolset = new BaseToolset('test');
        toolset.addTools(makeTool('serialA', true), makeTool('serialB', true));
        task.chat_context.attachToolsets(toolset);

        const spy = jest
            .spyOn(task, 'processToolCall')
            .mockImplementationOnce(async (tool_call: ToolCall) => {
                tool_call.status = 'error';
                throw new Error('boom');
            })
            .mockImplementationOnce(async (tool_call: ToolCall) => {
                tool_call.status = 'success';
            });

        appendToolCalls(task, [makeToolCall('s1', 'serialA'), makeToolCall('s2', 'serialB')]);

        await task.processToolCalls();

        // 第一个工具抛异常后，第二个仍然被执行
        expect(spy).toHaveBeenCalledTimes(2);
    });

    test('BaseTool.serialExecution defaults to false', () => {
        const tool = new BaseTool('test', 'desc', z.object({}));
        expect(tool.serialExecution).toBe(false);
    });

    test('file writing tools have serialExecution = true', () => {
        expect(new WriteFileTool().serialExecution).toBe(true);
        expect(new EditFileTool().serialExecution).toBe(true);
        expect(new SearchReplaceTool().serialExecution).toBe(true);
        expect(new ApplyPatchTool().serialExecution).toBe(true);
    });

    test('file read-only tools have serialExecution = false', () => {
        expect(new ReadFileTool().serialExecution).toBe(false);
        expect(new GlobFilesTool().serialExecution).toBe(false);
        expect(new GrepFilesTool().serialExecution).toBe(false);
    });

    test('node file writing tools have serialExecution = true', () => {
        const fakeApp = { getGateway: () => null } as unknown as DeviceMgrApplication;
        const tools = createNodeExecutionTools(fakeApp);
        const byName = new Map(tools.map((t) => [t.name, t]));

        expect(byName.get('writeNodeFile')?.serialExecution).toBe(true);
        expect(byName.get('sendNodeFile')?.serialExecution).toBe(true);
        expect(byName.get('fetchNodeFile')?.serialExecution).toBe(true);
        expect(byName.get('editNodeFile')?.serialExecution).toBe(true);
        expect(byName.get('searchReplaceNodeFile')?.serialExecution).toBe(true);
    });

    test('node file read-only tools have serialExecution = false', () => {
        const fakeApp = { getGateway: () => null } as unknown as DeviceMgrApplication;
        const tools = createNodeExecutionTools(fakeApp);
        const byName = new Map(tools.map((t) => [t.name, t]));

        expect(byName.get('readNodeFile')?.serialExecution).toBe(false);
        expect(byName.get('globNodeFiles')?.serialExecution).toBe(false);
        expect(byName.get('grepNodeFiles')?.serialExecution).toBe(false);
    });
});
