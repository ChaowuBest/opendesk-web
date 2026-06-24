import { describe, expect, jest, test, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../renderer/components/confirmModal.js', () => ({
    showConfirmModal: jest.fn()
}));

describe('renderer slash commands', () => {
    beforeEach(() => {
        Object.assign(globalThis, {
            window: {
                alert: jest.fn()
            },
            document: {
                querySelector: jest.fn()
            }
        });
    });

    test('/goal with a non-empty objective creates a goal instead of showing help', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        const createGoal = jest.fn().mockResolvedValue({ ok: true });

        await executeSlashCommand(
            'goal',
            {
                globalControlAPI: {},
                taskManagerAPI: {
                    createGoal
                },
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue: null,
                showConfirmModal: jest.fn()
            },
            '修复导出问题'
        );

        expect(createGoal).toHaveBeenCalledWith('task-1', '修复导出问题');
        expect(window.alert).not.toHaveBeenCalled();
    });

    test('/goal without args shows help and does not create a goal', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        const createGoal = jest.fn();

        await executeSlashCommand(
            'goal',
            {
                globalControlAPI: {},
                taskManagerAPI: {
                    createGoal
                },
                currentTaskId: 'task-1',
                stopCallback: null,
                clearMessageQueue: null,
                showConfirmModal: jest.fn()
            },
            '   '
        );

        expect(createGoal).not.toHaveBeenCalled();
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('/goal <objective>'));
    });
});
