import { describe, expect, jest, test, beforeEach } from '@jest/globals';

const showConfirmModal = jest.fn();

jest.unstable_mockModule('../../../renderer/components/confirmModal.js', () => ({
    showConfirmModal
}));

describe('renderer slash commands', () => {
    beforeEach(() => {
        showConfirmModal.mockReset();
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
    });

    test('GUI slash command list exposes goal', async () => {
        const { getSlashCommands, filterSlashCommands } = await import('../../../renderer/components/slash-command');

        const goalCommand = getSlashCommands().find((cmd) => cmd.name === 'goal');
        expect(goalCommand).toBeDefined();
        expect(goalCommand?.acceptsArgs).toBe(true);
        expect(filterSlashCommands('go').map((cmd) => cmd.name)).toEqual(['goal']);
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
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('/goal <objective>'));
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

    test('executing goal edits an unfinished current goal instead of replacing it', async () => {
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
        expect(editGoal).toHaveBeenCalledWith('task-1', '新目标');
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
        expect(showConfirmModal).not.toHaveBeenCalled();
        expect(clearMessageQueue).not.toHaveBeenCalled();
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
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('clear'));
    });
});
