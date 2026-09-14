import { ToolCall } from '../../../main/aikernel/messages.js';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';
import {
    runPluginAfterToolCall,
    runPluginBeforeToolCallValidate
} from '../../../main/applications/pluginmgr/runtime/hooks.js';

describe('OpenDesk plugin shell hooks', () => {
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

    function makeCall(toolName: string, args: object = {}, status = 'success'): ToolCall {
        const call = new ToolCall(0, 'call-1', toolName, JSON.stringify(args));
        call.args_object = args;
        call.status = status as ToolCall['status'];
        return call;
    }

    test('shell.execute.before 在 bash 工具上触发，input 携带 shellType=bash', async () => {
        const seen: Array<{ tool: string; shellType: string }> = [];
        await getPluginHost().activate(
            definePlugin({
                id: 'shell-echo-before',
                setup(ctx) {
                    ctx.hooks.on('shell.execute.before', (input) => {
                        seen.push({ tool: input.tool, shellType: input.shellType });
                    });
                }
            }),
            { origin: 'test:shell-echo-before' }
        );
        const call = makeCall('terminal-executeBash', { command: 'ls' });

        await runPluginBeforeToolCallValidate(task, call);

        expect(seen).toEqual([{ tool: 'terminal-executeBash', shellType: 'bash' }]);
    });

    test('shell.execute.before 覆盖 bash/zsh/powershell 三种 shellType', async () => {
        const seen: string[] = [];
        await getPluginHost().activate(
            definePlugin({
                id: 'shell-capture-before',
                setup(ctx) {
                    ctx.hooks.on('shell.execute.before', (input) => {
                        seen.push(input.shellType);
                    });
                }
            }),
            { origin: 'test:shell-capture-before' }
        );

        await runPluginBeforeToolCallValidate(task, makeCall('terminal-executeBash', { command: 'a' }));
        await runPluginBeforeToolCallValidate(task, makeCall('terminal-executeZsh', { command: 'b' }));
        await runPluginBeforeToolCallValidate(task, makeCall('terminal-executePowerShell', { command: 'c' }));
        await runPluginBeforeToolCallValidate(task, makeCall('terminal-executePwsh', { command: 'd' }));

        expect(seen).toEqual(['bash', 'zsh', 'powershell', 'powershell']);
    });

    test('shell.execute.before 不触发非 shell 工具', async () => {
        const seen: string[] = [];
        await getPluginHost().activate(
            definePlugin({
                id: 'shell-filter-before',
                setup(ctx) {
                    ctx.hooks.on('shell.execute.before', (input) => {
                        seen.push(input.tool);
                    });
                }
            }),
            { origin: 'test:shell-filter-before' }
        );
        const call = makeCall('demo-tool', {});

        await runPluginBeforeToolCallValidate(task, call);

        expect(seen).toEqual([]);
    });

    test('shell.execute.before 可以改写 shell 命令参数并写回 toolCall', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'shell-rewrite-before',
                setup(ctx) {
                    ctx.hooks.on('shell.execute.before', (_input, output) => {
                        output.args = { command: 'rewritten', timeout: 5000 };
                    });
                }
            }),
            { origin: 'test:shell-rewrite-before' }
        );
        const call = makeCall('terminal-executeBash', { command: 'ls' });

        await expect(runPluginBeforeToolCallValidate(task, call)).resolves.toEqual({ operation: 'allow' });
        expect(call.args_object).toEqual({ command: 'rewritten', timeout: 5000 });
    });

    test('shell.execute.before 显式 deny 时阻止执行并写回 metadata', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'shell-block-before',
                setup(ctx) {
                    ctx.hooks.on('shell.execute.before', (_input, output) => {
                        output.deny = { message: 'shell blocked', metadata: { blocked: true } };
                    });
                }
            }),
            { origin: 'test:shell-block-before' }
        );
        const call = makeCall('terminal-executeBash', { command: 'rm -rf /' });

        await expect(runPluginBeforeToolCallValidate(task, call)).resolves.toEqual({
            operation: 'deny',
            message: 'shell blocked'
        });
        expect(call.result_object).toEqual({ blocked: true });
    });

    test('shell.execute.after 在 bash 工具上触发，input 携带 shellType 与 returnCode', async () => {
        const seen: Array<{ shellType: string; returnCode: number | null; command: unknown }> = [];
        await getPluginHost().activate(
            definePlugin({
                id: 'shell-echo-after',
                setup(ctx) {
                    ctx.hooks.on('shell.execute.after', (input) => {
                        seen.push({ shellType: input.shellType, returnCode: input.returnCode, command: input.args });
                    });
                }
            }),
            { origin: 'test:shell-echo-after' }
        );
        const call = makeCall('terminal-executeBash', { command: 'ls' });
        call.result = 'ok';
        call.result_object = { exitCode: 0 };

        await runPluginAfterToolCall(task, call);

        expect(seen).toEqual([{ shellType: 'bash', returnCode: 0, command: { command: 'ls' } }]);
    });

    test('shell.execute.after 从 resultObject.exitCode 提取非零 returnCode', async () => {
        const seen: Array<number | null> = [];
        await getPluginHost().activate(
            definePlugin({
                id: 'shell-rc-after',
                setup(ctx) {
                    ctx.hooks.on('shell.execute.after', (input) => {
                        seen.push(input.returnCode);
                    });
                }
            }),
            { origin: 'test:shell-rc-after' }
        );
        const call = makeCall('terminal-executeBash', { command: 'ls' });
        call.result_object = { exitCode: 1 };

        await runPluginAfterToolCall(task, call);

        expect(seen).toEqual([1]);
    });

    test('shell.execute.after 无退出码时 returnCode 为 null，不触发非 shell 工具', async () => {
        const seen: Array<{ tool: string; returnCode: number | null }> = [];
        await getPluginHost().activate(
            definePlugin({
                id: 'shell-null-after',
                setup(ctx) {
                    ctx.hooks.on('shell.execute.after', (input) => {
                        seen.push({ tool: input.tool, returnCode: input.returnCode });
                    });
                }
            }),
            { origin: 'test:shell-null-after' }
        );

        // 非 shell 工具不触发
        const nonShell = makeCall('demo-tool');
        await runPluginAfterToolCall(task, nonShell);

        // shell 工具但无退出码：returnCode 为 null
        const noRc = makeCall('terminal-executeZsh', { command: 'x' });
        noRc.result_object = undefined;
        await runPluginAfterToolCall(task, noRc);

        expect(seen).toEqual([{ tool: 'terminal-executeZsh', returnCode: null }]);
    });

    test('shell.execute.after 可以改写返回给模型的结果', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'shell-rewrite-after',
                setup(ctx) {
                    ctx.hooks.on('shell.execute.after', (_input, output) => {
                        output.result = 'shell filtered';
                        output.resultObject = { filtered: true, exitCode: 1 };
                    });
                }
            }),
            { origin: 'test:shell-rewrite-after' }
        );
        const call = makeCall('terminal-executeBash', { command: 'ls' });
        call.result = 'original';
        call.result_object = { exitCode: 1 };

        await runPluginAfterToolCall(task, call);

        expect(call.result).toBe('shell filtered');
        expect(call.result_object).toEqual({ filtered: true, exitCode: 1 });
    });

    test('shell.execute.before 与 tool.validate.before 在 shell 工具上都会触发', async () => {
        const order: string[] = [];
        await getPluginHost().activate(
            definePlugin({
                id: 'shell-order',
                setup(ctx) {
                    ctx.hooks.on('tool.validate.before', () => {
                        order.push('tool.before');
                    });
                    ctx.hooks.on('shell.execute.before', () => {
                        order.push('shell.before');
                    });
                    ctx.hooks.on('tool.execute.after', () => {
                        order.push('tool.after');
                    });
                    ctx.hooks.on('shell.execute.after', () => {
                        order.push('shell.after');
                    });
                }
            }),
            { origin: 'test:shell-order' }
        );
        const call = makeCall('terminal-executeBash', { command: 'ls' });
        call.result_object = { exitCode: 0 };

        await runPluginBeforeToolCallValidate(task, call);
        await runPluginAfterToolCall(task, call);

        expect(order).toEqual(['tool.before', 'shell.before', 'tool.after', 'shell.after']);
    });

    test('shell.execute.before 抛出 PluginHookError(failureMode=closed) 时返回 deny', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'shell-error-before',
                failureMode: 'closed',
                setup(ctx) {
                    ctx.hooks.on('shell.execute.before', () => {
                        throw new Error('denied by policy');
                    });
                }
            }),
            { origin: 'test:shell-error-before' }
        );
        const call = makeCall('terminal-executeBash', { command: 'ls' });

        const result = await runPluginBeforeToolCallValidate(task, call);

        expect(result.operation).toBe('deny');
        expect(result.message).toBeTruthy();
    });

    test('shell.execute.before 抛出普通 Error 时不阻止执行', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'shell-plain-error',
                setup(ctx) {
                    ctx.hooks.on('shell.execute.before', () => {
                        throw new Error('unexpected');
                    });
                }
            }),
            { origin: 'test:shell-plain-error' }
        );
        const call = makeCall('terminal-executeBash', { command: 'ls' });

        const result = await runPluginBeforeToolCallValidate(task, call);

        expect(result).toEqual({ operation: 'allow' });
    });
});
