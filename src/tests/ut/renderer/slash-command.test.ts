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

    test('GUI slash command list does not expose goal', async () => {
        const { getSlashCommands, filterSlashCommands } = await import('../../../renderer/components/slash-command');

        expect(getSlashCommands().map((cmd) => cmd.name)).not.toContain('goal');
        expect(filterSlashCommands('go')).toEqual([]);
    });

    test('executing goal as a GUI slash command is ignored as unknown', async () => {
        const { executeSlashCommand } = await import('../../../renderer/components/slash-command');
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
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
            '修复导出问题'
        );

        expect(createGoal).not.toHaveBeenCalled();
        expect(window.alert).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith('Unknown slash command: /goal');
    });
});
