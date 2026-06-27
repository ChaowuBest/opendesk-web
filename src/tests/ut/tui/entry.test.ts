import { jest } from '@jest/globals';
import { OpenDeskTUI } from '../../../main/tui/entry.js';

describe('OpenDeskTUI active task view state', () => {
    test('clearActiveTask clears stale goal panel data', () => {
        const goalPanel = {
            getGoalState: jest.fn(() => ({ status: 'active' })),
            isVisible: jest.fn(() => true),
            update: jest.fn()
        };
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            taskView: {
                taskState: { task_id: 'task-1' },
                clearMessages: jest.fn()
            },
            activeTaskId: 'task-1',
            goalPanel,
            syncRetryCommandAvailability: jest.fn(),
            inputArea: {
                clearMessageQueue: jest.fn(),
                setStatus: jest.fn(),
                statusBar: {
                    stopTimer: jest.fn(),
                    resetAccumulated: jest.fn(),
                    update: jest.fn()
                }
            },
            tui: {
                requestRender: jest.fn()
            }
        }) as any;

        tui.clearActiveTask();

        expect(tui.taskView.taskState).toBeUndefined();
        expect(tui.activeTaskId).toBeUndefined();
        expect(goalPanel.update).toHaveBeenCalledWith({ goalState: null, totalTokens: 0, elapsedMs: 0 });
        expect(tui.tui.requestRender).toHaveBeenCalled();
    });
});
