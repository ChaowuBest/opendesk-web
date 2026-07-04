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

const taskTodosMap = new Map<string, TaskTodo[]>();

export function getTaskTodosForDisplay(taskId: string): TaskTodo[] {
    if (!taskTodosMap.has(taskId)) {
        return [];
    }
    return taskTodosMap.get(taskId)!;
}

export function getOrInitTaskTodos(taskId: string): TaskTodo[] {
    if (!taskTodosMap.has(taskId)) {
        taskTodosMap.set(taskId, []);
    }
    return taskTodosMap.get(taskId)!;
}

export function setTaskTodos(taskId: string, todos: TaskTodo[]): void {
    taskTodosMap.set(taskId, todos);
}

export function resetInProgressTaskTodos(taskId: string, at: Date = new Date()): TaskTodo[] {
    const todos = taskTodosMap.get(taskId);
    if (!todos || todos.length === 0) return [];

    let changed = false;
    const updatedAt = at.toISOString();
    const nextTodos = todos.map((todo) => {
        if (todo.status !== 'in_progress') return todo;
        changed = true;
        const nextTodo: TaskTodo = {
            ...todo,
            status: 'pending' as const,
            updated_at: updatedAt
        };
        delete nextTodo.started_at;
        delete nextTodo.completed_at;
        return nextTodo;
    });

    if (changed) {
        taskTodosMap.set(taskId, nextTodos);
    }
    return changed ? nextTodos : todos;
}

export function deleteTaskTodos(taskId: string): void {
    taskTodosMap.delete(taskId);
}
