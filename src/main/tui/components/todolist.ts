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

import { Component } from "@mariozechner/pi-tui";
import type { TaskTodo } from "../../applications/todomgr/common";
import chalk from "chalk";
import { Card, type BorderConfig } from "./card";

/**
 * TodoList component for CLI
 * Displays task-level todos in a compact format
 * Only visible when there are todos to display
 */
export class TodoList implements Component {
    private todos: TaskTodo[] = [];
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];
    private visible = false;

    private accentColor = chalk.hex('#F96850');
    private borderConfig: BorderConfig = {
        style: 'square',
        colorFn: this.accentColor,
    };

    /**
     * Set the todos to display
     * @param todos - Array of task todos
     */
    setTodos(todos: TaskTodo[]): boolean {
        const hasChanged =
            this.todos.length !== todos.length ||
            this.todos.some((todo, i) =>
                todo.id !== todos[i]?.id ||
                todo.content !== todos[i]?.content ||
                todo.status !== todos[i]?.status
            );

        if (hasChanged) {
            this.todos = [...todos];
            this.visible = todos.length > 0;
            this.invalidated = true;
        }
        return hasChanged;
    }

    /**
     * Get current todos
     */
    getTodos(): TaskTodo[] {
        return this.todos;
    }

    /**
     * Check if the component is visible (has todos)
     */
    isVisible(): boolean {
        return this.visible;
    }

    /**
     * Clear all todos
     */
    clear(): void {
        this.todos = [];
        this.visible = false;
        this.invalidated = true;
    }

    invalidate(): void {
        this.invalidated = true;
    }

    private getStatusIcon(status: string): string {
        const map: Record<string, string> = {
            'pending': '○',
            'in_progress': '●',
            'completed': '✓',
        };
        return map[status] || '○';
    }

    private getStatusColor(status: string): (s: string) => string {
        const map: Record<string, (s: string) => string> = {
            'pending': chalk.gray,
            'in_progress': chalk.blueBright,
            'completed': chalk.green,
        };
        return map[status] || chalk.gray;
    }

    render(width: number): string[] {
        if (!this.visible || this.todos.length === 0) {
            return [];
        }

        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }

        this.lastWidth = width;

        // Build body lines for Card
        const bodyLines: string[] = [];
        for (const todo of this.todos) {
            const icon = this.getStatusIcon(todo.status);
            const colorFn = this.getStatusColor(todo.status);
            const coloredIcon = colorFn(icon);

            let content = todo.content;
            // Apply strikethrough for completed items
            if (todo.status === 'completed') {
                content = chalk.gray.strikethrough(content);
            }

            bodyLines.push(`${coloredIcon} ${content}`);
        }

        // Use Card component with custom border
        const card = new Card({
            icon: '📋',
            title: '当前待办',
            body: bodyLines,
            border: this.borderConfig,
        });

        this.cachedOutput = card.render(width);
        this.invalidated = false;
        return this.cachedOutput;
    }
}
