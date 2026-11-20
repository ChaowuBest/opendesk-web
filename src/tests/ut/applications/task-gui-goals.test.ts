import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { TaskManagerState } from '../../../main/aikernel/task/manager.js';

const create = jest.fn<any>();
const edit = jest.fn<any>();
const addSupplement = jest.fn<any>();
const pause = jest.fn<any>();
const resume = jest.fn<any>();
const clear = jest.fn<any>();
const stopActiveGoal = jest.fn<any>();
const dispatchEvent = jest.fn();
jest.unstable_mockModule('../../../main/aikernel/goal/service.js', () => ({
    GoalService: { create, edit, addSupplement, pause, resume, clear, stopActiveGoal }
}));
jest.unstable_mockModule('../../../main/aikernel/goal/controller.js', () => ({
    GoalController: { getStatus: () => ({ summary: { objective: 'current goal' } }) }
}));
jest.unstable_mockModule('../../../main/applications/registry.js', () => ({ ApplicationRegistry: { dispatchEvent } }));
jest.unstable_mockModule('../../../main/aikernel/todos/task-todos.js', () => ({
    getTaskTodosForDisplay: () => ['remaining']
}));
const { createGuiGoalOperations } = await import('../../../main/applications/task-gui/goals.js');

function fixture(status?: string) {
    const task = { goal_state: status ? { status } : undefined, stop: jest.fn() };
    const manager = { getTask: jest.fn(() => task) };
    return { task, manager, operations: createGuiGoalOperations(manager as unknown as TaskManagerState) };
}

describe('shared GUI goal operations', () => {
    beforeEach(() => jest.clearAllMocks());

    test.each(['active', 'paused', 'blocked'])('does not replace an unfinished %s goal', async (status) => {
        const { operations } = fixture(status);
        expect(await operations.createGoal('task', 'replacement')).toEqual({
            status: 'ok',
            data: {
                ok: false,
                status,
                messageKey: 'goal.create.requires_clear',
                errorCode: 'goal_exists'
            }
        });
        expect(create).not.toHaveBeenCalled();
    });

    test('preserves the established task-running success projection and clear notifications', async () => {
        const { task, operations } = fixture();
        create.mockImplementationOnce(async () => {
            task.goal_state = { status: 'active' };
            return { ok: false, errorCode: 'task_running' };
        });
        expect(await operations.createGoal('task', 'objective')).toEqual({
            status: 'ok',
            data: {
                ok: true,
                status: 'active',
                summary: { objective: 'current goal' },
                startedScheduler: false
            }
        });
        expect(create).toHaveBeenCalledWith(
            task,
            { objective: 'objective', source: 'gui' },
            { projectDisplayMessage: true }
        );
        const next = fixture('complete');
        create.mockResolvedValueOnce({ ok: true, clearedTaskTodos: true });
        await next.operations.createGoal('task', 'new');
        expect(dispatchEvent).toHaveBeenCalledWith('todomgr', 'taskTodosUpdated', { taskId: 'task', todos: [] });
    });

    test('rejects malformed edit preconditions before mutating and forwards a valid revision', async () => {
        const { task, operations } = fixture('active');
        expect(await operations.editGoal('task', 'new', { ifMatch: { revision: 0 } })).toEqual({
            status: 'ok',
            data: {
                ok: false,
                messageKey: 'goal.edit.invalid_precondition',
                errorCode: 'invalid_goal_precondition'
            }
        });
        expect(edit).not.toHaveBeenCalled();
        const ifMatch = { id: 'goal', revision: 2, status: 'active' };
        await operations.editGoal('task', 'new', { ifMatch });
        expect(edit).toHaveBeenCalledWith(task, 'new', 'gui', { projectDisplayMessage: true, ifMatch });
    });

    test('clearing publishes the actual post-operation todos and stopping distinguishes active goals', async () => {
        const { task, operations } = fixture('active');
        clear.mockResolvedValueOnce({ ok: true });
        await operations.clearGoal('task');
        expect(dispatchEvent).toHaveBeenCalledWith('todomgr', 'taskTodosUpdated', {
            taskId: 'task',
            todos: ['remaining']
        });
        stopActiveGoal.mockResolvedValueOnce({ ok: true });
        expect(await operations.stopTask('task')).toEqual({ status: 'ok', data: { ok: true } });
        expect(stopActiveGoal).toHaveBeenCalledWith(task, 'gui');
        expect(task.stop).not.toHaveBeenCalled();
        const paused = fixture('paused');
        expect(await paused.operations.stopTask('task')).toEqual({ status: 'ok' });
        expect(paused.task.stop).toHaveBeenCalledTimes(1);
    });

    test('all operations reject a missing task without invoking domain services', async () => {
        const { manager, operations } = fixture();
        manager.getTask.mockReturnValue(undefined as never);
        for (const operation of Object.values(operations)) {
            expect(await operation('missing', 'value')).toEqual({ status: 'error', message: 'task missing not found' });
        }
        expect(create).not.toHaveBeenCalled();
        expect(stopActiveGoal).not.toHaveBeenCalled();
    });
});
