import { ToolCall } from '../../../main/aikernel/messages.js';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';
import { runPluginAfterToolCall, runPluginBeforeToolCall } from '../../../main/applications/pluginmgr/runtime/hooks.js';

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

    test('before hook 可以修改随后用于权限检查和执行的参数', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'argument-normalizer',
                setup(ctx) {
                    ctx.hooks.on('tool.execute.before', (_input, output) => {
                        output.args = { value: 2 };
                    });
                }
            }),
            { origin: 'test:argument-normalizer' }
        );
        const call = new ToolCall(0, 'call-1', 'demo', '{"value":1}');

        await expect(runPluginBeforeToolCall(task, call, { value: 1 })).resolves.toEqual({
            operation: 'allow',
            args: { value: 2 }
        });
    });

    test('普通 before hook 失败时回滚参数并继续工具执行', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'broken-before',
                setup(ctx) {
                    ctx.hooks.on('tool.execute.before', (_input, output) => {
                        output.args = { value: 99 };
                        throw new Error('before failed');
                    });
                }
            }),
            { origin: 'test:broken-before' }
        );
        const call = new ToolCall(0, 'call-1', 'demo', '{"value":1}');

        await expect(runPluginBeforeToolCall(task, call, { value: 1 })).resolves.toEqual({
            operation: 'allow',
            args: { value: 1 }
        });
    });

    test('closed before hook 失败时阻止工具执行', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'required-before',
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
            { origin: 'test:required-before' }
        );
        const call = new ToolCall(0, 'call-1', 'demo', '{}');

        await expect(runPluginBeforeToolCall(task, call, {})).resolves.toEqual({
            operation: 'deny',
            message: expect.any(String)
        });
    });

    test('before hook 显式 deny 时始终阻止工具执行', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'explicit-policy',
                setup(ctx) {
                    ctx.hooks.on('tool.execute.before', (_input, output) => {
                        output.deny = { message: 'blocked by policy' };
                    });
                }
            }),
            { origin: 'test:explicit-policy' }
        );
        const call = new ToolCall(0, 'call-1', 'demo', '{}');

        await expect(runPluginBeforeToolCall(task, call, {})).resolves.toEqual({
            operation: 'deny',
            message: 'blocked by policy',
            metadata: undefined
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
