import { jest } from '@jest/globals';
import { z } from 'zod';
import { ToolCall } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';
import { GlobPermissionEnforcer } from '../../../main/aikernel/security/enforcer.js';
import type { PermissionRequest } from '../../../main/aikernel/security/permission.js';
import { TaskProfiler } from '../../../main/aikernel/profiler.js';
import { AgentExecutionInstrumentationRegistry } from '../../../main/telemetry/agent-execution.js';
import {
    TelemetryOperationRegistry,
    type OperationInstrumentation,
    type TelemetryOperation
} from '../../../main/telemetry/operation.js';

class OperationRecorder implements OperationInstrumentation {
    constructor(private readonly names: string[]) {}

    aroundOperation<T>(operation: TelemetryOperation, next: () => Promise<T>): Promise<T> {
        this.names.push(operation.name);
        return next();
    }
}

function makeTask(): { task: TaskState; operations: string[] } {
    const manager = new TaskManagerState();
    manager.save = jest.fn() as any;
    manager.publishTaskListUpdate = jest.fn() as any;
    manager.moveTaskToEnd = jest.fn() as any;
    const task = new TaskState(manager);
    task.task_status = 'running';
    const operations: string[] = [];
    TelemetryOperationRegistry.install([new OperationRecorder(operations)]);
    return { task, operations };
}

function attachTool(task: TaskState, tool: BaseTool<any>): void {
    const toolset = new BaseToolset('test');
    toolset.addTool(tool);
    task.chat_context.attachToolsets(toolset);
}

describe('processToolCall: hook ordering & exec-phase pairing', () => {
    afterEach(() => {
        AgentExecutionInstrumentationRegistry.reset();
        TelemetryOperationRegistry.reset();
        jest.restoreAllMocks();
    });

    test('beforeToolCallValidate runs before validation and can correct params so execution proceeds', async () => {
        const { task, operations } = makeTask();
        const tool = new BaseTool('needPath', 'needs path', z.object({ path: z.string().min(1) })).setExecutor(
            async (args) => `executed:${args.path}`
        );
        attachTool(task, tool);

        // 原始参数非法（缺 path），但 validate 钩子就地修正
        task.hooks.beforeToolCallValidate(({ toolCall }) => {
            toolCall.args_object = { path: '/fixed-by-hook' };
            return { operation: 'allow' };
        });

        const toolCall = new ToolCall(0, 'call-1', 'needPath', '{}');
        await task.processToolCall(toolCall, true);

        expect(toolCall.status).toBe('success');
        expect(toolCall.result).toBe('executed:/fixed-by-hook');
        expect(operations).toEqual(['hook.before_tool_call', 'tool.execute', 'hook.after_tool_call']);
    });

    test('tool elapsed time starts after validation and excludes pre-execution waiting', async () => {
        let now = 1_000;
        jest.spyOn(Date, 'now').mockImplementation(() => now);

        const { task } = makeTask();
        task.profiler = new TaskProfiler(task.task_id);
        const tool = new BaseTool('slowValidation', 'slow validation', z.object({})).setExecutor(async () => {
            now += 2_000;
            return 'ok';
        });
        attachTool(task, tool);

        task.hooks.beforeToolCallValidate(() => {
            now += 10_000;
            return { operation: 'allow' };
        });

        const toolCall = new ToolCall(0, 'call-1', 'slowValidation', '{}');
        await task.processToolCall(toolCall, true);

        expect(toolCall.elapsedSeconds).toBe(2);
        expect(task.profiler.finish().tool_total_ms).toBe(2_000);
    });

    test('tool elapsed time excludes permission prompt waiting', async () => {
        let now = 1_000;
        jest.spyOn(Date, 'now').mockImplementation(() => now);

        const { task } = makeTask();
        task.harnessContext.permission = GlobPermissionEnforcer.createSync([]);
        task.harnessContext.permissionPrompt = {
            prompt: async () => {
                now += 10_000;
                return { decision: 'allow', rememberScope: 'none' };
            }
        } as any;

        const guardedSchema = z.object({});
        const tool = new (class extends BaseTool<typeof guardedSchema> {
            constructor() {
                super('permissionWait', 'permission wait', guardedSchema);
                this.setExecutor(async () => {
                    now += 2_000;
                    return 'ok';
                });
            }

            override getDeclaredPermissions(): PermissionRequest[] {
                return [{ resourceType: 'file', action: 'read', resourcePath: '/workspace/file.txt' }];
            }
        })();
        attachTool(task, tool);

        const toolCall = new ToolCall(0, 'call-1', 'permissionWait', '{}');
        await task.processToolCall(toolCall, false);

        expect(toolCall.elapsedSeconds).toBe(2);
    });

    test('beforeToolCallValidate deny skips the whole exec phase (before/after both absent)', async () => {
        const { task, operations } = makeTask();
        const tool = new BaseTool('ok', 'ok', z.object({})).setExecutor(async () => 'ok');
        attachTool(task, tool);

        let beforeCount = 0;
        let afterCount = 0;
        task.hooks.beforeToolCallValidate(() => ({ operation: 'deny', message: 'rejected' }));
        task.hooks.beforeToolCall(() => {
            beforeCount++;
            return { operation: 'allow' };
        });
        task.hooks.afterToolCall(() => {
            afterCount++;
        });

        const toolCall = new ToolCall(0, 'call-1', 'ok', '{}');
        await task.processToolCall(toolCall, true);

        expect(operations).toEqual([]);
        expect(beforeCount).toBe(0);
        expect(afterCount).toBe(0);
        expect(toolCall.status).toBe('error');
    });

    test('arg validation failure skips afterToolCall (no exec phase)', async () => {
        const { task, operations } = makeTask();
        const tool = new BaseTool('needPath', 'needs path', z.object({ path: z.string().min(1) })).setExecutor(
            async () => 'ok'
        );
        attachTool(task, tool);

        let afterCount = 0;
        task.hooks.afterToolCall(() => {
            afterCount++;
        });

        const toolCall = new ToolCall(0, 'call-1', 'needPath', '{}');
        await task.processToolCall(toolCall, true);

        expect(operations).toEqual([]);
        expect(afterCount).toBe(0);
        expect(toolCall.status).toBe('error');
        expect(toolCall.result).toContain('path');
    });

    test('beforeToolCall deny runs before-hook but skips afterToolCall', async () => {
        const { task, operations } = makeTask();
        const tool = new BaseTool('ok', 'ok', z.object({})).setExecutor(async () => 'ok');
        attachTool(task, tool);

        let afterCount = 0;
        task.hooks.beforeToolCall(() => ({ operation: 'deny', message: 'blocked' }));
        task.hooks.afterToolCall(() => {
            afterCount++;
        });

        const toolCall = new ToolCall(0, 'call-1', 'ok', '{}');
        await task.processToolCall(toolCall, true);

        expect(operations).toEqual(['hook.before_tool_call']);
        expect(afterCount).toBe(0);
        expect(toolCall.status).toBe('error');
    });

    test('permission (user) deny skips the whole exec phase', async () => {
        const { task, operations } = makeTask();
        task.harnessContext.permission = await GlobPermissionEnforcer.create([]);
        const guardedSchema = z.object({});
        const tool = new (class extends BaseTool<typeof guardedSchema> {
            constructor() {
                super('guarded', 'guarded', guardedSchema);
                this.setExecutor(async () => 'ok');
            }
            override getDeclaredPermissions(): PermissionRequest[] {
                return [{ resourceType: 'file', action: 'read', resourcePath: '/x' }];
            }
        })();
        attachTool(task, tool);

        let afterCount = 0;
        task.hooks.beforePermissionAsk(({ action }) => {
            action.decision = 'deny';
        });
        task.hooks.afterToolCall(() => {
            afterCount++;
        });

        const toolCall = new ToolCall(0, 'call-1', 'guarded', '{}');
        await task.processToolCall(toolCall, false);

        expect(operations).toEqual([]);
        expect(afterCount).toBe(0);
        expect(toolCall.status).toBe('error');
    });

    test('even when execute throws, afterToolCall still runs (exec-phase pair preserved)', async () => {
        const { task, operations } = makeTask();
        const tool = new BaseTool('boom', 'boom', z.object({})).setExecutor(async () => {
            throw new Error('exec-failure');
        });
        attachTool(task, tool);

        let afterCount = 0;
        task.hooks.afterToolCall(() => {
            afterCount++;
        });

        const toolCall = new ToolCall(0, 'call-1', 'boom', '{}');
        await task.processToolCall(toolCall, true);

        expect(operations).toEqual(['hook.before_tool_call', 'tool.execute', 'hook.after_tool_call']);
        expect(afterCount).toBe(1);
        expect(toolCall.status).toBe('error');
        expect(toolCall.result).toContain('exec-failure');
    });
});
