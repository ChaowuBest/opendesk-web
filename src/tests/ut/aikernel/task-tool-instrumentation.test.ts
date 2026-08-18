import { jest } from '@jest/globals';
import { z } from 'zod';
import { AssistantMessage, ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';
import {
    AgentExecutionInstrumentationRegistry,
    type AgentExecutionInstrumentation,
    type ModelRequestInstrumentationContext,
    type TaskTurnInstrumentationContext,
    type ToolCallInstrumentationContext
} from '../../../main/telemetry/agent-execution.js';
import {
    TelemetryOperationRegistry,
    type OperationInstrumentation,
    type TelemetryOperation
} from '../../../main/telemetry/operation.js';

class ToolObservationRecorder implements AgentExecutionInstrumentation {
    constructor(
        private readonly observations: Array<{
            taskId?: string;
            status: string;
            result: string;
        }>
    ) {}

    aroundTaskTurn<T>(_context: TaskTurnInstrumentationContext, next: () => Promise<T>): Promise<T> {
        return next();
    }

    aroundModelRequest<T>(
        _context: ModelRequestInstrumentationContext,
        next: (headers?: Record<string, string>) => Promise<T>
    ): Promise<T> {
        return next();
    }

    recordToolCall(context: ToolCallInstrumentationContext): void {
        const toolCall = context.toolCall as ToolCall;
        this.observations.push({
            taskId: context.taskId,
            status: toolCall.status,
            result: toolCall.result
        });
    }
}

class OperationRecorder implements OperationInstrumentation {
    constructor(private readonly names: string[]) {}

    aroundOperation<T>(operation: TelemetryOperation, next: () => Promise<T>): Promise<T> {
        this.names.push(operation.name);
        return next();
    }
}

describe('TaskState tool instrumentation boundary', () => {
    afterEach(() => {
        AgentExecutionInstrumentationRegistry.reset();
        TelemetryOperationRegistry.reset();
        jest.restoreAllMocks();
    });

    test('records the final tool result after business hooks at the task execution boundary', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const task = new TaskState(manager);
        task.task_status = 'running';

        const tool = new BaseTool('testTool', 'test tool', z.object({})).setExecutor(async () => 'tool-result');
        const toolset = new BaseToolset('test');
        toolset.addTools(tool);
        task.chat_context.attachToolsets(toolset);

        task.hooks.afterToolCall(({ toolCall }) => {
            toolCall.result = `${toolCall.result}:after-hook`;
        });

        const observations: Array<{ taskId?: string; status: string; result: string }> = [];
        const operations: string[] = [];
        AgentExecutionInstrumentationRegistry.install([new ToolObservationRecorder(observations)]);
        TelemetryOperationRegistry.install([new OperationRecorder(operations)]);

        const toolCall = new ToolCall(0, 'call-1', 'testTool', '{}');
        await task.processToolCall(toolCall, true);

        expect(operations).toEqual(['hook.before_tool_call', 'tool.execute', 'hook.after_tool_call']);
        expect(observations).toEqual([
            {
                taskId: task.task_id,
                status: 'success',
                result: 'tool-result:after-hook'
            }
        ]);
    });

    test('stores the stable turn id in tool-call runtime metadata', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const task = new TaskState(manager);
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task, 'processTaskTurn').mockResolvedValue(undefined);

        await task.startInternalTurn({
            prompt: 'continue',
            source: 'test',
            metadata: {
                scope: 'task',
                origin: { source: 'internal', reason: 'test' }
            }
        });

        const assistantMessage = task.chat_context.lastMessage() as AssistantMessage;
        const toolCall = new ToolCall(0, 'call-with-turn', 'testTool', '{}');
        const toolPart = new ToolCallMessagePart();
        toolPart.push(toolCall);
        assistantMessage.content.push(toolPart);
        task.applyRuntimeMetadataToAssistant(assistantMessage);

        expect(assistantMessage.metadata?.execution?.turnId).toBe(`${task.task_id}:1`);
        expect(toolCall.metadata?.execution?.turnId).toBe(`${task.task_id}:1`);
    });
});
