import { jest } from '@jest/globals';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import {
    deleteTaskTodos,
    getTaskTodosForDisplay,
    resetInProgressTaskTodos,
    setTaskTodos,
    type TaskTodo,
    type TodoStatus
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

function todo(taskId: string, id = `${taskId}-todo`, status: TodoStatus = 'in_progress'): TaskTodo {
    const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
    return {
        id,
        task_id: taskId,
        title: `Todo ${taskId}`,
        content: `Todo ${taskId}`,
        status,
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

    test('resetInProgressTaskTodos returns running todos to pending', () => {
        const running = todo('parent-task', 'running-todo');
        const completed: TaskTodo = {
            ...todo('parent-task', 'completed-todo'),
            status: 'completed',
            completed_at: '2026-01-01T00:05:00.000Z'
        };
        setTaskTodos('parent-task', [running, completed]);

        const updated = resetInProgressTaskTodos('parent-task', new Date('2026-01-01T00:10:00.000Z'));

        expect(updated[0]).toEqual({
            id: 'running-todo',
            task_id: 'parent-task',
            title: 'Todo parent-task',
            content: 'Todo parent-task',
            status: 'pending',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:10:00.000Z'
        });
        expect(updated[1]).toEqual(completed);
        expect(getTaskTodosForDisplay('parent-task')).toEqual(updated);
    });
});

describe('task-level todos snapshot isolation', () => {
    const TASK_ID = 'snapshot-task';

    afterEach(() => {
        deleteTaskTodos(TASK_ID);
    });

    test('getTaskTodosForDisplay hands out a frozen snapshot', () => {
        setTaskTodos(TASK_ID, [todo(TASK_ID, 'a', 'pending'), todo(TASK_ID, 'b', 'pending')]);

        const display = getTaskTodosForDisplay(TASK_ID);

        expect(Object.isFrozen(display)).toBe(true);
        expect(display.every((item) => Object.isFrozen(item))).toBe(true);
        expect(getTaskTodosForDisplay(TASK_ID)).not.toBe(display);
    });

    test('mutating the displayed snapshot throws and leaves stored todos intact', () => {
        setTaskTodos(TASK_ID, [todo(TASK_ID, 'a', 'pending'), todo(TASK_ID, 'b', 'pending')]);

        // 快照在类型层已不可写，这里显式越界以验证运行期同样拦住
        const display = getTaskTodosForDisplay(TASK_ID) as unknown as TaskTodo[];

        expect(() => display.push(todo(TASK_ID, 'c', 'pending'))).toThrow(TypeError);
        expect(() => display.splice(0, 1)).toThrow(TypeError);
        expect(() => {
            display[0].status = 'completed';
        }).toThrow(TypeError);

        expect(getTaskTodosForDisplay(TASK_ID).map((item) => item.id)).toEqual(['a', 'b']);
        expect(getTaskTodosForDisplay(TASK_ID)[0].status).toBe('pending');
    });

    test('setTaskTodos does not retain caller array or element references', () => {
        const incoming = [todo(TASK_ID, 'a', 'pending')];
        setTaskTodos(TASK_ID, incoming);

        incoming.push(todo(TASK_ID, 'b', 'pending'));
        incoming[0].status = 'completed';

        expect(getTaskTodosForDisplay(TASK_ID).map((item) => item.id)).toEqual(['a']);
        expect(getTaskTodosForDisplay(TASK_ID)[0].status).toBe('pending');
    });

    test('resetInProgressTaskTodos hands out a copy of the stored array', () => {
        setTaskTodos(TASK_ID, [todo(TASK_ID, 'a', 'pending'), todo(TASK_ID, 'b', 'pending')]);

        const snapshot = resetInProgressTaskTodos(TASK_ID);
        snapshot.splice(0, 1);

        expect(getTaskTodosForDisplay(TASK_ID).map((item) => item.id)).toEqual(['a', 'b']);
    });

    test('resetInProgressTaskTodos does not alias stored todos', () => {
        setTaskTodos(TASK_ID, [todo(TASK_ID, 'running', 'in_progress')]);

        const [resetTodo] = resetInProgressTaskTodos(TASK_ID, new Date('2026-01-01T00:00:03.000Z'));
        expect(resetTodo.status).toBe('pending');

        resetTodo.status = 'completed';

        expect(getTaskTodosForDisplay(TASK_ID)[0].status).toBe('pending');
    });

    test('resetInProgressTaskTodos drops timing fields from reset todos', () => {
        setTaskTodos(TASK_ID, [
            {
                ...todo(TASK_ID, 'running', 'in_progress'),
                completed_at: '2026-01-01T00:00:02.000Z'
            }
        ]);

        const [resetTodo] = resetInProgressTaskTodos(TASK_ID, new Date('2026-01-01T00:00:03.000Z'));

        expect(resetTodo.status).toBe('pending');
        expect(resetTodo.updated_at).toBe('2026-01-01T00:00:03.000Z');
        expect(Object.keys(resetTodo)).not.toContain('started_at');
        expect(Object.keys(resetTodo)).not.toContain('completed_at');
    });
});
