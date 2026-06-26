import { jest } from '@jest/globals';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import {
    deleteTaskTodos,
    getTaskTodosForDisplay,
    setTaskTodos,
    type TaskTodo
} from '../../../main/aikernel/todos/task-todos.js';

function createManager(): TaskManagerState {
    const manager = new TaskManagerState();
    jest.spyOn(manager, 'publishTaskListUpdate').mockImplementation(() => {});
    jest.spyOn(manager, 'saveSync').mockImplementation(() => {});
    jest.spyOn(manager as any, 'cleanupOldTaskFiles').mockImplementation(() => {});
    return manager;
}

function createTask(manager: TaskManagerState, taskId: string, parentId: string | null = null): TaskState {
    const task = new TaskState(manager, parentId);
    task.task_id = taskId;
    jest.spyOn(task, 'cleanup').mockImplementation(() => {});
    jest.spyOn(task, 'stop').mockImplementation(() => {});
    manager.tasks.push(task);
    return task;
}

function todo(taskId: string, id = `${taskId}-todo`): TaskTodo {
    const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
    return {
        id,
        task_id: taskId,
        title: `Todo ${taskId}`,
        content: `Todo ${taskId}`,
        status: 'in_progress',
        created_at: now,
        updated_at: now,
        started_at: now
    };
}

describe('task-level todos cleanup', () => {
    afterEach(() => {
        deleteTaskTodos('parent-task');
        deleteTaskTodos('child-task');
        deleteTaskTodos('other-task');
        jest.restoreAllMocks();
    });

    test('removeTask clears todos for the removed task tree only', () => {
        const manager = createManager();
        createTask(manager, 'parent-task');
        createTask(manager, 'child-task', 'parent-task');
        createTask(manager, 'other-task');
        setTaskTodos('parent-task', [todo('parent-task')]);
        setTaskTodos('child-task', [todo('child-task')]);
        setTaskTodos('other-task', [todo('other-task')]);

        const removedIds = manager.removeTask('parent-task');

        expect(removedIds.sort()).toEqual(['child-task', 'parent-task']);
        expect(getTaskTodosForDisplay('parent-task')).toEqual([]);
        expect(getTaskTodosForDisplay('child-task')).toEqual([]);
        expect(getTaskTodosForDisplay('other-task')).toHaveLength(1);
    });

    test('clearAllTasks clears todos for every task', () => {
        const manager = createManager();
        createTask(manager, 'parent-task');
        createTask(manager, 'other-task');
        setTaskTodos('parent-task', [todo('parent-task')]);
        setTaskTodos('other-task', [todo('other-task')]);

        const removedIds = manager.clearAllTasks();

        expect(removedIds.sort()).toEqual(['other-task', 'parent-task']);
        expect(getTaskTodosForDisplay('parent-task')).toEqual([]);
        expect(getTaskTodosForDisplay('other-task')).toEqual([]);
    });
});
