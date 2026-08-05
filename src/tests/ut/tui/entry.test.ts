import { jest } from '@jest/globals';
import { GoalController } from '../../../main/aikernel/goal/controller.js';
import { GoalStates } from '../../../main/aikernel/goal/state.js';
import { OpenDeskTUI } from '../../../main/tui/entry.js';

describe('OpenDeskTUI active task view state', () => {
    test('syncs input status from the current task instead of forcing idle', () => {
        const task = { task_id: 'task-1', task_status: 'running' };
        const setStatus = jest.fn();
        const startTimer = jest.fn();
        const stopTimer = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            activeTaskId: task.task_id,
            taskManagerState: {
                getTask: jest.fn(() => task)
            },
            inputArea: {
                setStatus,
                statusBar: { startTimer, stopTimer }
            }
        }) as any;

        expect(tui.syncInputStatusFromTask(task.task_id)).toBe(true);

        expect(setStatus).toHaveBeenLastCalledWith('running');
        expect(startTimer).toHaveBeenCalledTimes(1);
        expect(stopTimer).not.toHaveBeenCalled();

        task.task_status = 'stopped';
        expect(tui.syncInputStatusFromTask(task.task_id)).toBe(false);

        expect(stopTimer).toHaveBeenCalledTimes(1);
        expect(setStatus).toHaveBeenLastCalledWith('idle');
    });

    test('clearActiveTask clears stale active task state', () => {
        const clearTodos = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            taskView: {
                taskState: { task_id: 'task-1' },
                clearMessages: jest.fn()
            },
            todoList: {
                clear: clearTodos
            },
            activeTaskId: 'task-1',
            goalEvaluationInProgressByTask: new Map(),
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
        expect(clearTodos).toHaveBeenCalledTimes(1);
        expect(tui.inputArea.clearGoalSupplementQueuedHint).toHaveBeenCalled();
        expect(tui.tui.requestRender).toHaveBeenCalled();
    });

    test('running active goal input is submitted as supplemental context without starting a user turn', async () => {
        const task = {
            task_id: 'task-1',
            task_status: 'stopped',
            task_name: 'Task',
            chat_context: {
                messages: [],
                appendMessage: jest.fn()
            },
            goal_state: undefined,
            goal_event_log: undefined,
            task_manager_state: {
                publishTaskListUpdate: jest.fn()
            },
            persistLater: jest.fn(),
            sendSubscriptionFeedback: jest.fn(),
            isGoalRuntimeInterrupted: jest.fn(() => false)
        } as any;
        GoalController.create(task, { objective: 'ship fix', source: 'tui' });
        task.task_status = 'running';

        const communicate = jest.fn();
        const appendPendingGoalSupplementMessage = jest.fn();
        const syncGoalPanel = jest.fn();
        const startTimer = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            taskView: {
                taskState: task,
                communicate,
                appendLocalUserMessage: jest.fn(),
                appendPendingGoalSupplementMessage,
                syncGoalPanel
            },
            activeTaskId: 'task-1',
            goalEvaluationInProgressByTask: new Map(),
            taskManagerState: {
                getTask: jest.fn(() => task)
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
        expect(appendPendingGoalSupplementMessage).toHaveBeenCalledWith(
            'Use packages/appsdk as the target.',
            task.goal_state?.pendingSupplements[0].id
        );
        expect(syncGoalPanel).toHaveBeenCalledWith({
            goalState: task.goal_state,
            totalTokens: 0,
            elapsedMs: expect.any(Number)
        });
    });

    test.each(['complete', 'cleared'] as const)(
        'processes queued task messages after a goal becomes %s',
        async (status) => {
            const queue = ['continue with ordinary task work'];
            const goal = GoalStates.create('task-1', { objective: 'goal' });
            goal.status = status;
            const task = {
                task_id: 'task-1',
                task_status: 'stopped',
                goal_state: goal,
                message_queue: [...queue]
            };
            const communicate = jest.fn(async () => {});
            const clearMessageQueue = jest.fn();
            const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
                activeTaskId: task.task_id,
                taskManagerState: {
                    getTask: jest.fn(() => task)
                },
                taskView: {
                    communicate
                },
                inputArea: {
                    hasQueuedMessages: jest.fn(() => queue.length > 0),
                    getQueueSnapshot: jest.fn(() => [...queue]),
                    dequeueMessage: jest.fn(() => queue.shift()),
                    clearMessageQueue,
                    setStatus: jest.fn(),
                    statusBar: {
                        startTimer: jest.fn(),
                        stopTimer: jest.fn()
                    }
                },
                undoStacks: new Map()
            }) as any;

            await tui.processQueue();

            expect(communicate).toHaveBeenCalledWith('continue with ordinary task work');
            expect(clearMessageQueue).not.toHaveBeenCalled();
            expect(task.message_queue).toEqual([]);
        }
    );

    test('goal evaluation end immediately moves terminal goal panel into task history', () => {
        const goal = GoalStates.create('task-1', { objective: 'ship fix' });
        goal.createdAt = '2026-01-01T00:00:00.000Z';
        goal.executionStarted = true;
        goal.startedAt = '2026-01-01T00:00:00.000Z';
        goal.status = 'complete';
        goal.completedAt = '2026-01-01T00:00:05.000Z';
        const task = {
            task_id: 'task-1',
            goal_state: goal,
            chat_context: {
                messages: []
            }
        } as any;
        const syncGoalPanel = jest.fn();
        const requestRender = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            taskView: {
                taskState: task,
                syncGoalPanel
            },
            activeTaskId: 'task-1',
            goalEvaluationInProgressByTask: new Map([[task.task_id, `${goal.id}:${goal.revision}`]]),
            inputArea: {
                clearGoalSupplementQueuedHint: jest.fn()
            },
            tui: {
                requestRender
            }
        }) as any;

        tui.handleGoalEvalUpdate({
            type: 'goal_eval',
            task_id: 'task-1',
            task_status: 'running',
            goalId: goal.id,
            goalRevision: goal.revision,
            phase: 'end',
            evaluationId: 'eval-1',
            status: 'met',
            message: 'done',
            evidence: [],
            evaluatedAt: '2026-01-01T00:00:05.000Z'
        });

        expect(syncGoalPanel).toHaveBeenCalledWith({
            goalState: goal,
            totalTokens: 0,
            elapsedMs: 5_000,
            evaluating: false
        });
        expect(requestRender).toHaveBeenCalled();
    });

    test('goal evaluation superseded by edit keeps goal panel evaluating', () => {
        const goal = GoalStates.create('task-1', { objective: 'replacement goal' });
        goal.revision = 2;
        const task = {
            task_id: 'task-1',
            goal_state: goal,
            chat_context: {
                messages: []
            }
        } as any;
        const syncGoalPanel = jest.fn();
        const requestRender = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            taskView: {
                taskState: task,
                syncGoalPanel
            },
            activeTaskId: 'task-1',
            goalEvaluationInProgressByTask: new Map([[task.task_id, `${goal.id}:1`]]),
            tui: {
                requestRender
            }
        }) as any;

        tui.handleGoalEvalUpdate({
            type: 'goal_eval',
            task_id: 'task-1',
            task_status: 'running',
            goalId: goal.id,
            goalRevision: goal.revision,
            phase: 'end',
            evaluationId: 'eval-1',
            status: 'superseded',
            message: 'edited during evaluation',
            evaluatedAt: '2026-01-01T00:00:05.000Z'
        });

        expect(syncGoalPanel).toHaveBeenCalledWith({
            goalState: goal,
            totalTokens: 0,
            elapsedMs: expect.any(Number),
            evaluating: true
        });
        expect(tui.goalEvaluationInProgressByTask.get('task-1')).toBe(`${goal.id}:${goal.revision}`);
        expect(requestRender).toHaveBeenCalled();
    });
});

describe('OpenDeskTUI focusInputAreaIfAvailable', () => {
    test('restores focus in modelNotConfiguredMode so /model overlay does not freeze', () => {
        const setFocus = jest.fn();
        const input = { type: 'input' };
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            isConfigMode: jest.fn(() => false),
            isModelNotConfiguredMode: jest.fn(() => true),
            isInputAreaMounted: jest.fn(() => true),
            inputArea: { input },
            tui: { setFocus }
        }) as any;

        tui.focusInputAreaIfAvailable();

        // Before the fix, setFocus was NOT called when modelNotConfiguredMode=true,
        // causing the focus to be lost after InfoOverlay closes (the "freeze" bug).
        expect(setFocus).toHaveBeenCalledWith(input);
    });

    test('still skips focus in configMode', () => {
        const setFocus = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            isConfigMode: jest.fn(() => true),
            isModelNotConfiguredMode: jest.fn(() => false),
            isInputAreaMounted: jest.fn(() => true),
            inputArea: { input: {} },
            tui: { setFocus }
        }) as any;

        tui.focusInputAreaIfAvailable();

        expect(setFocus).not.toHaveBeenCalled();
    });
});
