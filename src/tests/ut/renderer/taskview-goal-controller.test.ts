import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { GoalController } from '../../../renderer/components/taskview-goal/controller.js';

beforeAll(() => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        HTMLElement: window.HTMLElement,
        CustomEvent: window.CustomEvent
    });
});

function createHost(taskId = 'task-1') {
    const host = document.createElement('div') as HTMLDivElement & Record<string, any>;
    host.task_id = taskId;
    host.task_status = 'running';
    host.reload = jest.fn(async () => undefined);
    host.scrollToMessage = jest.fn(async () => false);
    host._expandRightSidebar = jest.fn();
    host._getRightSidebarEl = jest.fn(() => null);
    host._syncArtifactsTaskStatus = jest.fn();
    host._ensureRightSidebarOpen = jest.fn();
    host._removeWaitingAssistantPlaceholder = jest.fn();
    host.updateStopButtonVisibility = jest.fn();
    host._isTaskInputRunning = jest.fn(() => true);
    return host;
}

describe('task view goal controller', () => {
    test('does not apply an async goal refresh after the host switches tasks', async () => {
        const host = createHost();
        const controller = new GoalController(host);
        controller.currentGoal = { id: 'goal-1', status: 'active', revision: 1 };

        let resolveStatus: (value: unknown) => void = () => undefined;
        const getGoalStatus = jest.fn(
            () =>
                new Promise((resolve) => {
                    resolveStatus = resolve;
                })
        );
        window.taskManagerAPI = { ...window.taskManagerAPI, getGoalStatus };

        const refresh = controller.refreshGoalSummary();
        host.task_id = 'task-2';
        resolveStatus({ summary: { id: 'goal-2', status: 'active', revision: 1 } });

        await expect(refresh).resolves.toBeUndefined();
        expect(controller.currentGoal).toEqual({ id: 'goal-1', status: 'active', revision: 1 });
        expect(host.updateStopButtonVisibility).not.toHaveBeenCalled();
    });

    test('removes document listeners and refresh timers when disconnected', () => {
        jest.useFakeTimers();
        try {
            const host = createHost();
            const controller = new GoalController(host);
            controller.currentGoal = { id: 'goal-1', status: 'active', revision: 1 };
            controller.showPendingGoalEdit = jest.fn();

            controller.connect();
            document.dispatchEvent(
                new CustomEvent('goal-pending', {
                    detail: {
                        type: 'edit',
                        taskId: 'task-1',
                        goalId: 'goal-1',
                        goalRevision: 2,
                        objective: 'Updated objective'
                    }
                })
            );
            expect(controller.showPendingGoalEdit).toHaveBeenCalledTimes(1);
            expect(controller.liveRefreshTimer).not.toBeNull();

            controller.disconnect();
            document.dispatchEvent(
                new CustomEvent('goal-pending', {
                    detail: {
                        type: 'edit',
                        taskId: 'task-1',
                        goalId: 'goal-1',
                        goalRevision: 3,
                        objective: 'Another objective'
                    }
                })
            );

            expect(controller.showPendingGoalEdit).toHaveBeenCalledTimes(1);
            expect(controller.refreshTimer).toBeNull();
            expect(controller.liveRefreshTimer).toBeNull();
            expect(controller.refreshPending).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });
});
