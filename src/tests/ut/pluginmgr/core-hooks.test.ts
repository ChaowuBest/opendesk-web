import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';
import { runPluginBeforePermissionAsk, runPluginShellEnv } from '../../../main/applications/pluginmgr/runtime/hooks.js';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';

describe('OpenDesk plugin core hooks', () => {
    beforeEach(async () => {
        await getPluginHost().dispose();
    });

    afterEach(async () => {
        await getPluginHost().dispose();
    });

    test('permission.ask 可以在进入 UI prompt 前允许或拒绝请求', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'permission-policy',
                setup(ctx) {
                    ctx.hooks.on('permission.ask', (input, output) => {
                        output.decision = input.requests.some((request) => request.resourcePath.includes('blocked'))
                            ? 'deny'
                            : 'allow';
                    });
                }
            }),
            { origin: 'test:permission-policy' }
        );
        const task = {
            task_id: 'task-1',
            getWorkspace: () => '/workspace/one'
        } as TaskState;

        await expect(
            runPluginBeforePermissionAsk(task, {
                tool: 'terminal',
                permissions: [{ resourceType: 'file', action: 'read', resourcePath: '/allowed' }]
            })
        ).resolves.toBe('allow');
        await expect(
            runPluginBeforePermissionAsk(task, {
                tool: 'terminal',
                permissions: [{ resourceType: 'file', action: 'read', resourcePath: '/blocked' }]
            })
        ).resolves.toBe('deny');
    });

    test('shell.env 可以按任务和命令修改子进程环境', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'shell-environment',
                setup(ctx) {
                    ctx.hooks.on('shell.env', (input, output) => {
                        output.env.PLUGIN_TASK = input.taskId;
                        output.env.PLUGIN_COMMAND = input.command;
                        delete output.env.REMOVE_ME;
                    });
                }
            }),
            { origin: 'test:shell-environment' }
        );
        const task = {
            task_id: 'task-1',
            getWorkspace: () => '/workspace/one'
        } as TaskState;

        await expect(
            runPluginShellEnv(task, { shell: '/bin/bash', command: 'pwd' }, { EXISTING: 'yes', REMOVE_ME: 'yes' })
        ).resolves.toEqual({
            EXISTING: 'yes',
            PLUGIN_TASK: 'task-1',
            PLUGIN_COMMAND: 'pwd'
        });
    });

    test('失败的 shell.env hook 会回滚环境变量修改', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'broken-shell-environment',
                setup(ctx) {
                    ctx.hooks.on('shell.env', (_input, output) => {
                        output.env.PARTIAL = 'must rollback';
                        throw new Error('env failed');
                    });
                }
            }),
            { origin: 'test:broken-shell-environment' }
        );

        await expect(
            runPluginShellEnv(undefined, { shell: '/bin/bash', command: 'pwd' }, { EXISTING: 'yes' })
        ).resolves.toEqual({ EXISTING: 'yes' });
    });
});
