import { jest } from '@jest/globals';
import { SlashCommandRegistry } from '../../../main/tui/commands/base.js';
import { syncPluginTuiCommands } from '../../../main/applications/pluginmgr/runtime/commands.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { definePlugin } from '../../../../packages/plugin/src/index.js';
import type { OpenDeskTUI } from '../../../main/tui/entry.js';

describe('plugin TUI commands', () => {
    afterEach(async () => {
        await getPluginHost().dispose();
    });

    test('注册命令、传递任务上下文并展示结果', async () => {
        const abort = new AbortController().signal;
        await getPluginHost().activate(
            definePlugin({
                id: 'demo',
                setup(ctx) {
                    ctx.commands.register({
                        name: 'status',
                        description: 'Show status',
                        execute: (args, context) => ({
                            title: 'Plugin status',
                            output: `${context.taskId}:${context.workspace}:${args}:${context.abort === abort}`
                        })
                    });
                }
            }),
            { origin: 'test:command-provider' }
        );
        const commandRegistry = new SlashCommandRegistry();
        const showTextPage = jest.fn();
        const tui = {
            commandRegistry,
            workspace: '/workspace',
            getActiveTask: () => ({
                task_id: 'task-1',
                getWorkspace: () => '/workspace',
                getAbortSignal: () => abort
            }),
            showTextPage
        } as unknown as OpenDeskTUI;

        let registered = syncPluginTuiCommands(tui, new Set());
        await expect(commandRegistry.execute('/demo.status verbose')).resolves.toBe(true);
        expect(showTextPage).toHaveBeenCalledWith('Plugin status', 'task-1:/workspace:verbose:true');

        await getPluginHost().deactivate('demo');
        registered = syncPluginTuiCommands(tui, registered);
        expect(registered.size).toBe(0);
        await expect(commandRegistry.execute('/demo.status')).resolves.toBe(false);
    });
});
