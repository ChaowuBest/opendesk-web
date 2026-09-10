import { describe, expect, jest, test, beforeEach } from '@jest/globals';
import { enUs } from '../../../locale/en-us.js';

const showConfirmModal = jest.fn();
const showInfoModal = jest.fn();
const showCommandResultDialog = jest.fn();

jest.unstable_mockModule('../../../renderer/components/confirmModal.js', () => ({
    showConfirmModal,
    showInfoModal,
    // 与真实实现同构的轻量转换：转义 HTML 并保留换行
    escapeModalText: (text: string) =>
        text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}));

jest.unstable_mockModule('../../../renderer/components/commandResultDialog.js', () => ({
    showCommandResultDialog
}));

// 锁定 en-US locale，使测试不依赖运行环境的 navigator.language
jest.unstable_mockModule('../../../renderer/locale.js', () => {
    const translate = (key: string, params?: Record<string, string | number>): string => {
        let text: string = enUs[key] ?? key;
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                text = text.replace(new RegExp(`\\$\\{${k}\\}`, 'g'), String(v));
            }
        }
        return text;
    };
    return {
        createRendererTranslator: () => translate,
        resolveRendererLocale: () => 'en-US'
    };
});

describe('renderer slash commands', () => {
    beforeEach(async () => {
        showConfirmModal.mockReset();
        showConfirmModal.mockResolvedValue(true);
        showInfoModal.mockReset();
        showInfoModal.mockResolvedValue(undefined);
        showCommandResultDialog.mockReset();
        const storage = new Map<string, string>();
        Object.assign(globalThis, {
            window: {
                alert: jest.fn()
            },
            document: {
                querySelector: jest.fn(),
                dispatchEvent: jest.fn()
            },
            sessionStorage: {
                getItem: jest.fn((key: string) => storage.get(key) ?? null),
                setItem: jest.fn((key: string, value: string) => {
                    storage.set(key, value);
                }),
                removeItem: jest.fn((key: string) => {
                    storage.delete(key);
                })
            }
        });
        const { setPluginSlashCommands } = await import('../../../renderer/components/slash-command');
        setPluginSlashCommands([]);
    });

    test('GUI slash command list exposes goal', async () => {
        const { getSlashCommands, filterSlashCommands } = await import('../../../renderer/components/slash-command');

        const goalCommand = getSlashCommands().find((cmd) => cmd.name === 'goal');
        expect(goalCommand).toBeDefined();
        expect(goalCommand?.acceptsArgs).toBe(true);
        expect(filterSlashCommands('go').map((cmd) => cmd.name)).toEqual(['goal']);
    });

    test('loads and executes plugin commands through the application registry bridge', async () => {
        const callMainWorld = jest
            .fn()
            .mockResolvedValueOnce([{ name: 'demo.deploy', description: 'Deploy a project', acceptsArgs: true }])
            .mockResolvedValueOnce({
                status: 'success',
                result: { title: 'Deployment', output: 'Started production' }
            });
        Object.assign(window, {
            applicationRegistryAPI: { callMainWorld }
        });
        const { executeSlashCommand, getSlashCommands, refreshPluginSlashCommands } =
            await import('../../../renderer/components/slash-command');

        await refreshPluginSlashCommands();
        expect(getSlashCommands()).toContainEqual(
            expect.objectContaining({ name: 'demo.deploy', description: 'Deploy a project', acceptsArgs: true })
        );

        const result = await executeSlashCommand(
            'demo.deploy',
            {
                globalControlAPI: {},
                taskManagerAPI: {},
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue: null
            },
            'production --force'
        );

        expect(callMainWorld).toHaveBeenLastCalledWith(
            'pluginmgr',
            'runCommandForUI',
            'demo.deploy',
            'production --force',
            'task-1'
        );
        expect(showCommandResultDialog).toHaveBeenCalledWith({
            commandName: 'demo.deploy',
            title: 'Deployment',
            output: 'Started production',
            variant: 'success'
        });
        expect(result).toEqual({ inputDisposition: 'clear' });
    });

    test('reports plugin argument errors and preserves GUI input', async () => {
        const callMainWorld = jest.fn().mockResolvedValue({
            status: 'invalid_arguments',
            code: 'commander.missingArgument',
            message: "missing required argument 'environment'",
            usage: 'Usage: demo.deploy <environment>'
        });
        Object.assign(window, {
            applicationRegistryAPI: { callMainWorld }
        });
        const { executeSlashCommand, setPluginSlashCommands } =
            await import('../../../renderer/components/slash-command');
        setPluginSlashCommands([{ name: 'demo.deploy', description: 'Deploy', acceptsArgs: true }]);

        const result = await executeSlashCommand(
            'demo.deploy',
            {
                globalControlAPI: {},
                taskManagerAPI: {},
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue: null
            },
            ''
        );

        expect(showCommandResultDialog).toHaveBeenCalledWith({
            commandName: 'demo.deploy',
            title: 'Invalid command arguments',
            output: "missing required argument 'environment'\n\nUsage: demo.deploy <environment>",
            variant: 'error'
        });
        expect(result).toEqual({ inputDisposition: 'preserve' });
    });

    test('renders plugin help in the command result dialog', async () => {
        const callMainWorld = jest.fn().mockResolvedValue({
            status: 'help',
            text: 'Usage: demo.deploy <environment>'
        });
        Object.assign(window, {
            applicationRegistryAPI: { callMainWorld }
        });
        const { executeSlashCommand, setPluginSlashCommands } =
            await import('../../../renderer/components/slash-command');
        setPluginSlashCommands([{ name: 'demo.deploy', description: 'Deploy', acceptsArgs: true }]);

        const result = await executeSlashCommand(
            'demo.deploy',
            {
                globalControlAPI: {},
                taskManagerAPI: {},
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue: null
            },
            '--help'
        );

        expect(showCommandResultDialog).toHaveBeenCalledWith({
            commandName: 'demo.deploy',
            title: 'Command help',
            output: 'Usage: demo.deploy <environment>',
            variant: 'info'
        });
        expect(result).toEqual({ inputDisposition: 'clear' });
    });

    test('bare goal shows help and does not create a goal', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        const createGoal = jest.fn();

        await executeSlashCommand('goal', {
            globalControlAPI: {},
            taskManagerAPI: {
                createGoal
            },
            currentTaskId: 'task-1',
            stopCallback: null,
            clearMessageQueue: null
        });

        expect(createGoal).not.toHaveBeenCalled();
        // goal 提示必须走页内模态弹窗（issue #265：原生 window.alert 关闭后使输入框失焦）
        expect(showInfoModal).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Goal',
                message: expect.stringContaining('/goal &lt;objective&gt;'),
                confirmText: 'Confirm'
            })
        );
        expect(window.alert).not.toHaveBeenCalled();
    });

    test('/goal help resolves only after the in-page modal closes so the input can refocus', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        let resolveModal: (() => void) | undefined;
        showInfoModal.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveModal = resolve;
                })
        );

        let commandFinished = false;
        const execution = executeSlashCommand(
            'goal',
            {
                globalControlAPI: {},
                taskManagerAPI: {},
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue: null
            },
            'help'
        ).then((result) => {
            commandFinished = true;
            return result;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        // 弹窗打开期间命令保持挂起：agentinput 在命令结束后才调用 textarea.focus()，
        // 因此弹窗关闭前不能结束，焦点才能在关闭后回到输入框（issue #265）
        expect(showInfoModal).toHaveBeenCalledTimes(1);
        expect(commandFinished).toBe(false);

        resolveModal?.();
        const result = await execution;

        expect(commandFinished).toBe(true);
        expect(result).toEqual({ inputDisposition: 'clear' });
        expect(window.alert).not.toHaveBeenCalled();
    });

    test('executing goal creates a goal on the current task', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const createGoal = jest.fn(async () => ({
            ok: true,
            status: 'active',
            summary: { id: 'goal-1', status: 'active' }
        }));
        const getFullTask = jest.fn(async () => ({ task_status: 'running' }));

        await executeSlashCommand(
            'goal',
            {
                globalControlAPI: {},
                taskManagerAPI: {
                    createGoal,
                    getFullTask
                },
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue: null
            },
            '修复导出问题'
        );

        expect(createGoal).toHaveBeenCalledWith('task-1', '修复导出问题', undefined);
        expect(getFullTask).toHaveBeenCalledWith('task-1');
        expect(document.dispatchEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'goal-pending',
                detail: expect.objectContaining({
                    taskId: 'task-1',
                    type: 'create',
                    objective: '修复导出问题',
                    goalId: 'goal-1'
                })
            })
        );
        expect(window.alert).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalledWith('Unknown slash command: /goal');
    });

    test('goal status is treated as objective text, not a subcommand', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        const createGoal = jest.fn(async () => ({ ok: true, status: 'active' }));

        await executeSlashCommand(
            'goal',
            {
                globalControlAPI: {},
                taskManagerAPI: {
                    createGoal
                },
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue: null
            },
            'status'
        );

        expect(createGoal).toHaveBeenCalledWith('task-1', 'status', undefined);
        expect(window.alert).not.toHaveBeenCalled();
    });

    test('executing goal without a current task creates a task and starts the goal', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        const createTask = jest.fn(async () => 'task-new');
        const createGoal = jest.fn(async () => ({ ok: true, status: 'active' }));
        const openTask = jest.fn();

        await executeSlashCommand(
            'goal',
            {
                globalControlAPI: {
                    openTask
                },
                taskManagerAPI: {
                    createTask,
                    createGoal
                },
                currentTaskId: null,
                stopCallback: null,
                clearMessageQueue: null
            },
            '整理发布流程'
        );

        expect(createTask).toHaveBeenCalledWith({});
        expect(createGoal).toHaveBeenCalledWith('task-new', '整理发布流程', undefined);
        expect(sessionStorage.setItem).not.toHaveBeenCalledWith('opendesk:pendingGoalCreation', 'task-new');
        expect(openTask).toHaveBeenCalledWith('task-new');
    });

    test('executing goal confirms before editing an unfinished current goal', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        const createGoal = jest.fn();
        const editGoal = jest.fn(async () => ({
            ok: true,
            status: 'active',
            summary: {
                id: 'goal-1',
                status: 'active',
                revision: 2,
                objective: '新目标',
                objectiveEvents: [{ type: 'edited', revision: 2, objective: '新目标' }]
            }
        }));
        const getFullTask = jest.fn(async () => ({ task_status: 'running' }));
        const getGoalStatus = jest.fn(async () => ({
            summary: {
                id: 'goal-1',
                status: 'active',
                revision: 1,
                objective: '旧目标'
            }
        }));
        const clearMessageQueue = jest.fn();

        await executeSlashCommand(
            'goal',
            {
                globalControlAPI: {},
                taskManagerAPI: {
                    createGoal,
                    editGoal,
                    getGoalStatus,
                    getFullTask
                },
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue
            },
            '新目标'
        );

        expect(getGoalStatus).toHaveBeenCalledWith('task-1');
        expect(showConfirmModal).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Edit Current Goal',
                message: expect.stringContaining('旧目标'),
                confirmText: 'Edit Goal'
            })
        );
        expect(editGoal).toHaveBeenCalledWith('task-1', '新目标', {
            ifMatch: {
                id: 'goal-1',
                revision: 1,
                status: 'active'
            }
        });
        expect(createGoal).not.toHaveBeenCalled();
        expect(document.dispatchEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'goal-pending',
                detail: expect.objectContaining({
                    taskId: 'task-1',
                    type: 'edit',
                    objective: '新目标',
                    goalId: 'goal-1'
                })
            })
        );
        expect(clearMessageQueue).not.toHaveBeenCalled();
    });

    test('cancelling goal edit confirmation preserves the command and does not edit', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        showConfirmModal.mockResolvedValueOnce(false);
        const editGoal = jest.fn();

        const result = await executeSlashCommand(
            'goal',
            {
                globalControlAPI: {},
                taskManagerAPI: {
                    editGoal,
                    getGoalStatus: jest.fn(async () => ({
                        summary: {
                            id: 'goal-1',
                            status: 'active',
                            revision: 3,
                            objective: '当前目标'
                        }
                    }))
                },
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue: null
            },
            '替代目标'
        );

        expect(result).toEqual({ inputDisposition: 'preserve' });
        expect(editGoal).not.toHaveBeenCalled();
        expect(document.dispatchEvent).not.toHaveBeenCalled();
    });

    test('preserves the command when the goal changes during confirmation', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        const editGoal = jest.fn(async () => ({
            ok: false,
            errorCode: 'goal_conflict',
            messageKey: 'goal.edit.conflict'
        }));

        const result = await executeSlashCommand(
            'goal',
            {
                globalControlAPI: {},
                taskManagerAPI: {
                    editGoal,
                    getFullTask: jest.fn(async () => ({ task_status: 'running' })),
                    getGoalStatus: jest.fn(async () => ({
                        summary: {
                            id: 'goal-1',
                            status: 'active',
                            revision: 1,
                            objective: '当前目标'
                        }
                    }))
                },
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue: null
            },
            '替代目标'
        );

        expect(result).toEqual({ inputDisposition: 'preserve' });
        expect(showInfoModal).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'The goal changed while confirmation was open. Review the latest goal and try again.'
            })
        );
        expect(window.alert).not.toHaveBeenCalled();
        expect(document.dispatchEvent).not.toHaveBeenCalled();
    });

    test('does not confirm or edit when the objective is unchanged', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        const editGoal = jest.fn();

        const result = await executeSlashCommand(
            'goal',
            {
                globalControlAPI: {},
                taskManagerAPI: {
                    editGoal,
                    getGoalStatus: jest.fn(async () => ({
                        summary: {
                            id: 'goal-1',
                            status: 'active',
                            revision: 1,
                            objective: '相同目标'
                        }
                    }))
                },
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue: null
            },
            '相同目标'
        );

        expect(result).toEqual({ inputDisposition: 'clear' });
        expect(showConfirmModal).not.toHaveBeenCalled();
        expect(editGoal).not.toHaveBeenCalled();
    });

    test('escapes goal objectives rendered in the confirmation modal', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        const editGoal = jest.fn(async () => ({
            ok: true,
            summary: { id: 'goal-1', status: 'paused', revision: 2 }
        }));

        await executeSlashCommand(
            'goal',
            {
                globalControlAPI: {},
                taskManagerAPI: {
                    editGoal,
                    getFullTask: jest.fn(async () => ({ task_status: 'stopped' })),
                    getGoalStatus: jest.fn(async () => ({
                        summary: {
                            id: 'goal-1',
                            status: 'paused',
                            revision: 1,
                            objective: '<img src=x onerror=alert(1)>'
                        }
                    }))
                },
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue: null
            },
            '<script>alert(2)</script>'
        );

        const message = showConfirmModal.mock.calls.at(-1)?.[0]?.message as string;
        expect(message).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(message).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
        expect(message).not.toContain('<script>');
    });

    test('goal clear rejects unexpected arguments', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        const clearGoal = jest.fn();

        await executeSlashCommand(
            'goal',
            {
                globalControlAPI: {},
                taskManagerAPI: {
                    clearGoal
                },
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue: null
            },
            'clear now'
        );

        expect(clearGoal).not.toHaveBeenCalled();
        expect(showInfoModal).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('clear') })
        );
        expect(window.alert).not.toHaveBeenCalled();
    });

    test.each([
        { clearedActiveGoal: true, expectedQueueClears: 1 },
        { clearedActiveGoal: false, expectedQueueClears: 0 }
    ])(
        'goal clear only clears the message queue when clearedActiveGoal is $clearedActiveGoal',
        async ({ clearedActiveGoal, expectedQueueClears }) => {
            const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
            const clearGoal = jest.fn(async () => ({
                ok: true,
                status: 'cleared',
                clearedActiveGoal
            }));
            const clearMessageQueue = jest.fn();

            await executeSlashCommand(
                'goal',
                {
                    globalControlAPI: {},
                    taskManagerAPI: { clearGoal },
                    currentTaskId: 'task-1',
                    stopCallback: null,
                    clearMessageQueue
                },
                'clear'
            );

            expect(clearGoal).toHaveBeenCalledWith('task-1');
            expect(clearMessageQueue).toHaveBeenCalledTimes(expectedQueueClears);
        }
    );
});
