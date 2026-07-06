import { jest } from '@jest/globals';
import { GoalController } from '../../../main/aikernel/goal/controller.js';
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
                clearGoalSupplementQueuedHint: jest.fn(),
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

    test('running active goal input is submitted as supplemental context without starting a user turn', async () => {
        const task = {
            task_id: 'task-1',
            task_status: 'stopped',
            task_name: 'Task',
            chat_context: { messages: [] },
            goal_state: undefined,
            goal_event_log: undefined,
            task_manager_state: {
                publishTaskListUpdate: jest.fn()
            },
            persistLater: jest.fn(),
            isGoalRuntimeInterrupted: jest.fn(() => false)
        } as any;
        GoalController.create(task, { objective: 'ship fix', source: 'tui' });
        task.task_status = 'running';

        const communicate = jest.fn();
        const startTimer = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            taskView: {
                taskState: task,
                communicate
            },
            activeTaskId: 'task-1',
            taskManagerState: {
                getTask: jest.fn(() => task)
            },
            goalPanel: {
                update: jest.fn()
            },
            inputArea: {
                clearGoalSupplementQueuedHint: jest.fn(),
                statusBar: {
                    startTimer,
                    stopTimer: jest.fn(),
                    getAccumulatedMs: jest.fn(() => 0),
                    update: jest.fn()
                },
                setStatus: jest.fn()
            },
            resolveModelInfo: jest.fn(),
            processQueue: jest.fn(),
            tui: {
                requestRender: jest.fn()
            }
        }) as any;

        await tui.onRequestSubmit('Use packages/appsdk as the target.');

        expect(communicate).not.toHaveBeenCalled();
        expect(startTimer).not.toHaveBeenCalled();
        expect(task.goal_state?.pendingSupplements).toHaveLength(1);
        expect(task.goal_state?.pendingSupplements[0].content).toBe('Use packages/appsdk as the target.');
        expect(task.goal_state?.pendingSupplements[0].source).toBe('user_message');
        expect(task.chat_context.messages).toHaveLength(0);
    });
});
