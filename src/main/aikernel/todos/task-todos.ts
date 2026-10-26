/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskTodo {
    id: string;
    task_id: string;
    title: string;
    content: string;
    status: TodoStatus;
    created_at: string;
    updated_at: string;
    /** 首次进入 in_progress 的 ISO 时间戳，用于计算执行耗时 */
    started_at?: string;
    completed_at?: string;
}

/** 只读展示快照：数组与元素都不可写，误改在编译期就被挡住。 */
export type ReadonlyTaskTodos = ReadonlyArray<Readonly<TaskTodo>>;

const taskTodosMap = new Map<string, TaskTodo[]>();

/**
 * 通用快照：数组与元素都浅拷贝一层，调用方后续改写不会影响 Map 内部状态。
 * 与 toReadonlyTodos 的区别是不冻结——内部更新路径需要可变对象。
 */
function toTodoSnapshot(todos: readonly TaskTodo[]): TaskTodo[] {
    return todos.map((todo) => ({ ...todo }));
}

/**
 * 生成只读展示快照：数组与其中每个待办都浅拷贝一份并冻结。
 * 冻结的是副本而不是 Map 内部对象，因此内部更新路径不受影响；
 * 调用方误改（push / splice / 给字段赋值）会立刻抛 TypeError，而不是静默改掉展示数据。
 */
function toReadonlyTodos(todos: readonly TaskTodo[]): ReadonlyTaskTodos {
    const snapshot = todos.map((todo) => Object.freeze({ ...todo }));
    return Object.freeze(snapshot);
}

export function getTaskTodosForDisplay(taskId: string): ReadonlyTaskTodos {
    return toReadonlyTodos(taskTodosMap.get(taskId) ?? []);
}

export function setTaskTodos(taskId: string, todos: readonly TaskTodo[]): void {
    taskTodosMap.set(taskId, toTodoSnapshot(todos));
}

export function resetInProgressTaskTodos(taskId: string, at: Date = new Date()): TaskTodo[] {
    const todos = taskTodosMap.get(taskId);
    if (!todos || todos.length === 0) return [];

    let changed = false;
    const updatedAt = at.toISOString();
    const nextTodos = todos.map((todo) => {
        if (todo.status !== 'in_progress') return todo;
        changed = true;
        // 用解构剔除计时字段，避免 delete 让 V8 把对象降级为 dictionary 模式
        const { started_at: _startedAt, completed_at: _completedAt, ...rest } = todo;
        return {
            ...rest,
            status: 'pending' as const,
            updated_at: updatedAt
        };
    });

    if (changed) {
        taskTodosMap.set(taskId, nextTodos);
    }
    return toTodoSnapshot(changed ? nextTodos : todos);
}

export function deleteTaskTodos(taskId: string): void {
    taskTodosMap.delete(taskId);
}
