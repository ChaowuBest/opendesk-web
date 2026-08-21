import { ToolCall } from '../../../main/aikernel/messages.js';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';
import {
    runPluginAfterToolCall,
    runPluginBeforeToolCall,
    runPluginBeforeToolCallValidate
} from '../../../main/applications/pluginmgr/runtime/hooks.js';

describe('OpenDesk plugin tool hooks', () => {
    const task = {
        task_id: 'task-1',
        getWorkspace: () => '/workspace'
    } as TaskState;

    beforeEach(async () => {
        await getPluginHost().dispose();
    });

    afterEach(async () => {
        await getPluginHost().dispose();
    });

    // ── tool.validate.before：参数校验前阶段（对应 aikernel beforeToolCallValidate） ──
    test('validate.before 可以就地改写参数（写回 toolCall.args_object）', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'argument-normalizer',
                setup(ctx) {
                    ctx.hooks.on('tool.validate.before', (_input, output) => {
                        output.args = { value: 2 };
                    });
                }
            }),
            { origin: 'test:argument-normalizer' }
        );
        const call = new ToolCall(0, 'call-1', 'demo', '{"value":1}');
        call.args_object = { value: 1 };

        await expect(runPluginBeforeToolCallValidate(task, call)).resolves.toEqual({ operation: 'allow' });
        expect(call.args_object).toEqual({ value: 2 });
    });

    test('普通 validate.before hook 失败时保持原参数并继续工具执行', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'broken-before',
                setup(ctx) {
                    ctx.hooks.on('tool.validate.before', (_input, output) => {
                        output.args = { value: 99 };
                        throw new Error('before failed');
                    });
                }
            }),
            { origin: 'test:broken-before' }
        );
        const call = new ToolCall(0, 'call-1', 'demo', '{"value":1}');
        call.args_object = { value: 1 };

        await expect(runPluginBeforeToolCallValidate(task, call)).resolves.toEqual({ operation: 'allow' });
        expect(call.args_object).toEqual({ value: 1 });
    });

    test('closed validate.before hook 失败时阻止工具执行', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'required-before',
                setup(ctx) {
                    ctx.hooks.on(
                        'tool.validate.before',
                        () => {
                            throw new Error('policy unavailable');
                        },
                        { failureMode: 'closed' }
                    );
                }
            }),
            { origin: 'test:required-before' }
        );
        const call = new ToolCall(0, 'call-1', 'demo', '{}');

        await expect(runPluginBeforeToolCallValidate(task, call)).resolves.toEqual({
            operation: 'deny',
            message: expect.any(String)
        });
    });

    test('validate.before 显式 deny 时始终阻止工具执行', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'explicit-policy',
                setup(ctx) {
                    ctx.hooks.on('tool.validate.before', (_input, output) => {
                        output.deny = { message: 'blocked by policy', metadata: { blocked: true } };
                    });
                }
            }),
            { origin: 'test:explicit-policy' }
        );
        const call = new ToolCall(0, 'call-1', 'demo', '{}');

        await expect(runPluginBeforeToolCallValidate(task, call)).resolves.toEqual({
            operation: 'deny',
            message: 'blocked by policy'
        });
        expect(call.result_object).toEqual({ blocked: true });
    });

    // ── tool.execute.before：执行前阶段（对应 aikernel beforeToolCall） ──
    test('execute.before 不能改写参数（越权写入 args 被忽略）', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'exec-attempt-rewrite',
                setup(ctx) {
                    ctx.hooks.on('tool.execute.before', (_input, output) => {
                        // 新契约已从 output 移除 args 字段，运行时不应用任何参数改写；
                        // 此处用类型断言模拟越权写入，验证其对 toolCall 无影响
                        (output as Record<string, unknown>).args = { value: 9 };
                    });
                }
            }),
            { origin: 'test:exec-attempt-rewrite' }
        );
        const call = new ToolCall(0, 'call-1', 'demo', '{"value":1}');
        call.args_object = { value: 1 };

        await expect(runPluginBeforeToolCall(task, call)).resolves.toEqual({ operation: 'allow' });
        expect(call.args_object).toEqual({ value: 1 });
    });

    test('execute.before 显式 deny 时阻止工具执行', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'exec-explicit-policy',
                setup(ctx) {
                    ctx.hooks.on('tool.execute.before', (_input, output) => {
                        output.deny = { message: 'blocked at exec', metadata: { blocked: true } };
                    });
                }
            }),
            { origin: 'test:exec-explicit-policy' }
        );
        const call = new ToolCall(0, 'call-1', 'demo', '{}');

        await expect(runPluginBeforeToolCall(task, call)).resolves.toEqual({
            operation: 'deny',
            message: 'blocked at exec'
        });
        expect(call.result_object).toEqual({ blocked: true });
    });

    test('closed execute.before hook 失败时阻止工具执行', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'exec-required-before',
                setup(ctx) {
                    ctx.hooks.on(
                        'tool.execute.before',
                        () => {
                            throw new Error('policy unavailable');
                        },
                        { failureMode: 'closed' }
                    );
                }
            }),
            { origin: 'test:exec-required-before' }
        );
        const call = new ToolCall(0, 'call-1', 'demo', '{}');

        await expect(runPluginBeforeToolCall(task, call)).resolves.toEqual({
            operation: 'deny',
            message: expect.any(String)
        });
    });

    test('after hook 可以改写返回给模型的结果', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'result-filter',
                setup(ctx) {
                    ctx.hooks.on('tool.execute.after', (_input, output) => {
                        output.result = 'filtered';
                        output.resultObject = { filtered: true };
                    });
                }
            }),
            { origin: 'test:result-filter' }
        );
        const call = new ToolCall(0, 'call-1', 'demo', '{}');
        call.args_object = {};
        call.status = 'success';
        call.result = 'original';

        await runPluginAfterToolCall(task, call);

        expect(call.result).toBe('filtered');
        expect(call.result_object).toEqual({ filtered: true });
    });
});
