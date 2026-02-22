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

import { BaseTool } from '../../agents/tool';
import { ToolCall } from '../../agents/messages';
import { Card, type BorderConfig } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import chalk from 'chalk';
import { z } from 'zod';
import type { TaskTodo } from './common';
import type { TaskState } from '../../states/tasks';
import { escapeHtml } from '../../utils/escape';

// ========== TodoWrite 工具 ==========

const TodoWriteTodoSchema = z.object({
    id: z.string().optional().describe('待办项ID，更新或删除时必填'),
    content: z.string().describe('待办内容描述'),
    status: z.enum(['pending', 'in_progress', 'completed']).describe('状态：pending[待定], in_progress[进行中], completed[已完成]'),
});

const TodoWriteArgsSchema = z.object({
  todos: z.array(TodoWriteTodoSchema).describe('完整的待办事项列表（替换当前所有待办）'),
});

const taskTodosMap = new Map<string, TaskTodo[]>();

/**
 * Get todos for a specific task (for display purposes)
 * @param taskId - The task ID to get todos for
 * @returns Array of todos for the task
 */
export function getTaskTodosForDisplay(taskId: string): TaskTodo[] {
    if (!taskTodosMap.has(taskId)) {
        return [];
    }
    return taskTodosMap.get(taskId)!;
}

export class TodoWriteTool extends BaseTool<typeof TodoWriteArgsSchema> {
    private todoMgrApp: any;

    constructor(todoMgrApp: any) {
      super(
        'TodoWrite',
        '管理任务级待办事项。每次调用传入完整的待办列表来替换当前所有待办。任务级待办仅在当前任务会话中有效，严格按列表顺序执行。如需跨任务持久保存，请使用 addGlobalTodo。',
        TodoWriteArgsSchema,
      );
      this.todoMgrApp = todoMgrApp;
        this.executor = this.handleExecute.bind(this);
    }

    private getTaskTodos(taskId: string): TaskTodo[] {
        if (!taskTodosMap.has(taskId)) {
            taskTodosMap.set(taskId, []);
        }
        return taskTodosMap.get(taskId)!;
    }

    private setTaskTodos(taskId: string, todos: TaskTodo[]): void {
        taskTodosMap.set(taskId, todos);
    }

    renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        const todos = args?.['todos'] || [];

        let html = '<div style="padding: 12px;">';
        html += '<div style="font-weight: 600; margin-bottom: 8px;">📋 任务待办列表</div>';

        if (todos.length > 0) {
            html += '<div style="display: flex; flex-direction: column; gap: 8px;">';
            for (const todo of todos) {
                const statusIcon = this.getStatusIcon(todo.status);
                const isCompleted = todo.status === 'completed';
                html += `
          <div style="display: flex; align-items: flex-start; gap: 8px; padding: 8px; background: #f9fafb; border-radius: 8px;">
            <span style="font-size: 16px;">${statusIcon}</span>
            <div style="flex: 1;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-weight: 500; ${isCompleted ? 'text-decoration: line-through; opacity: 0.7;' : ''}">${escapeHtml(todo.content)}</span>
              </div>
            </div>
          </div>
        `;
            }
            html += '</div>';
        } else {
            html += '<div style="color: #6b7280;">暂无待办</div>';
        }

        html += '</div>';
        return Promise.resolve(html);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const todos = Array.isArray(args?.['todos']) ? args['todos'] : [];

        const total = todos.length;
        const completed = todos.filter(t => t.status === 'completed').length;
        const inProgress = todos.filter(t => t.status === 'in_progress').length;
        const pending = todos.filter(t => t.status === 'pending').length;

        // 如果所有任务都已完成，显示完整列表
        if (total > 0 && completed === total) {
            return this.renderCompletedTodosCli(todos, width);
        }

        // 否则显示简洁摘要
        let summary = `共 ${total} 个待办`;
        if (total > 0) {
            summary += ` · 已完成 ${completed}`;
            if (inProgress > 0) summary += ` · 进行中 ${inProgress}`;
            if (pending > 0) summary += ` · 待处理 ${pending}`;
        }

        return [
            `📋 ${summary}`,
        ];
    }

    private renderCompletedTodosCli(todos: any[], width: number): string[] {
        const accentColor = chalk.hex('#F96850');
        const borderConfig: BorderConfig = {
            style: 'square',
            colorFn: accentColor,
        };

        // Build body lines
        const bodyLines: string[] = [];
        for (const todo of todos) {
            const content = truncText(String(todo.content), width - 8);
            bodyLines.push(chalk.green('✓ ') + chalk.gray.strikethrough(content));
        }

        // Use Card component with custom border
        const card = new Card({
            icon: '✅',
            title: '所有待办已完成!',
            body: bodyLines,
            border: borderConfig,
        });

        return card.render(width);
    }

    private getStatusIcon(status: string): string {
        const map: Record<string, string> = {
            'pending': '⭕',
            'in_progress': '🔄',
            'completed': '✅',
        };
        return map[status] || '⭕';
    }

    private getStatusIconCli(status: string): string {
        const map: Record<string, string> = {
            'pending': '○',
            'in_progress': '●',
            'completed': '✓',
        };
        return map[status] || '○';
    }



    private async handleExecute(args: z.output<typeof TodoWriteArgsSchema>, taskState?: TaskState): Promise<string> {
      const { todos } = args;
      const taskId = taskState?.task_id || 'current_task';
      let currentTodos = this.getTaskTodos(taskId);

      currentTodos = todos.map((todoParam) => {
        const existingTodo = todoParam.id ? currentTodos.find(t => t.id === todoParam.id) : undefined;
        return {
          id: todoParam.id || `task_todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          task_id: taskId,
          content: todoParam.content,
          status: todoParam.status,
          created_at: existingTodo?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: todoParam.status === 'completed' ? (existingTodo?.completed_at || new Date().toISOString()) : undefined,
        };
      });

      // 如果所有任务都已完成，清空待办列表（不再保留）
      const allCompleted = currentTodos.length > 0 && currentTodos.every(t => t.status === 'completed');
      if (allCompleted) {
        taskTodosMap.delete(taskId);
      } else {
        this.setTaskTodos(taskId, currentTodos);
      }

      return JSON.stringify({ success: true, todos: currentTodos });
    }
}

// ========== addGlobalTodo 工具 ==========

const AddGlobalTodoArgsSchema = z.object({
    content: z.string().describe('待办内容'),
    priority: z.enum(['low', 'medium', 'high']).optional().default('medium').describe('优先级：low[低], medium[中], high[高]'),
    category: z.string().optional().describe('分类标签，如 "bug", "feature", "idea"'),
});

export class AddGlobalTodoTool extends BaseTool<typeof AddGlobalTodoArgsSchema> {
    private todoMgrApp: any;

    constructor(todoMgrApp: any) {
        super(
            'addGlobalTodo',
            '添加全局待办事项，跨所有任务持久保存。',
            AddGlobalTodoArgsSchema,
        );
        this.todoMgrApp = todoMgrApp;
        this.executor = this.handleExecute.bind(this);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const content = args?.['content'];
        const priority = args?.['priority'] || 'medium';
        const category = args?.['category'];
        const body: string[] = [];

        if (content) {
            const priorityColor = this.getPriorityColor(String(priority));
            body.push(chalk.dim('内容: ') + truncText(String(content), width - 20));
            body.push(chalk.dim('优先级: ') + priorityColor(String(priority).toUpperCase()));
            if (category) {
                body.push(chalk.dim('分类: ') + chalk.magenta(String(category)));
            }
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ✓ 待办已添加，ID: ') + chalk.green(String(result.id)));
            } catch {
                body.push(chalk.dim('  ✓ 待办已添加!'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({ icon: '🌍', title: '添加全局待办', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private getPriorityColor(priority: string): (s: string) => string {
        const map: Record<string, (s: string) => string> = {
            'low': chalk.blue,
            'medium': chalk.yellow,
            'high': chalk.red,
        };
        return map[priority] || chalk.yellow;
    }

    private async handleExecute(args: z.output<typeof AddGlobalTodoArgsSchema>): Promise<string> {
        const todo = await this.todoMgrApp.callWorker('addGlobalTodo', args.content, args.priority, args.category);
        return JSON.stringify({ success: true, id: todo.id, todo });
    }
}

// ========== updateGlobalTodo 工具 ==========

const UpdateGlobalTodoArgsSchema = z.object({
    id: z.string().describe('待办项ID'),
    content: z.string().optional().describe('新的待办内容'),
    status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('新状态'),
    priority: z.enum(['low', 'medium', 'high']).optional().describe('新优先级'),
    category: z.string().optional().describe('新分类标签'),
});

export class UpdateGlobalTodoTool extends BaseTool<typeof UpdateGlobalTodoArgsSchema> {
    private todoMgrApp: any;

    constructor(todoMgrApp: any) {
        super(
            'updateGlobalTodo',
            '更新全局待办事项。注意：全局待办不允许删除，只能更新状态和内容。',
            UpdateGlobalTodoArgsSchema,
        );
        this.todoMgrApp = todoMgrApp;
        this.executor = this.handleExecute.bind(this);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const id = args?.['id'];
        const body: string[] = [];

        if (id) {
            body.push(chalk.dim('ID: ') + chalk.cyan(String(id)));
            const updates = [];
            if (args.content) updates.push('内容');
            if (args.status) updates.push('状态');
            if (args.priority) updates.push('优先级');
            if (args.category) updates.push('分类');
            if (updates.length > 0) {
                body.push(chalk.dim('更新: ') + chalk.yellow(updates.join(', ')));
            }
        }

        if (toolcall.status === 'success' && toolcall.result) {
            body.push(chalk.dim('  ✓ 待办已更新!'));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({ icon: '🔄', title: '更新全局待办', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(args: z.output<typeof UpdateGlobalTodoArgsSchema>): Promise<string> {
        const todo = await this.todoMgrApp.callWorker('updateGlobalTodo', args.id, args);
        return JSON.stringify({ success: true, id: args.id, todo });
    }
}

// ========== listGlobalTodos 工具 ==========

const ListGlobalTodosArgsSchema = z.object({
    status: z.enum(['pending', 'in_progress', 'completed', 'all']).optional().default('all').describe('状态筛选'),
    category: z.string().optional().describe('分类筛选'),
    priority: z.enum(['low', 'medium', 'high']).optional().describe('优先级筛选'),
});

export class ListGlobalTodosTool extends BaseTool<typeof ListGlobalTodosArgsSchema> {
    private todoMgrApp: any;

    constructor(todoMgrApp: any) {
        super(
            'listGlobalTodos',
            '列出所有全局待办事项，支持按状态、分类和优先级筛选。',
            ListGlobalTodosArgsSchema,
        );
        this.todoMgrApp = todoMgrApp;
        this.executor = this.handleExecute.bind(this);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 加载中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                const todos = Array.isArray(result.todos) ? result.todos : [];
                if (todos.length === 0) {
                    body.push(chalk.dim('  暂无全局待办'));
                } else {
                    body.push(chalk.dim(`  找到 ${chalk.white(String(todos.length))} 个全局待办:`));
                    for (const todo of todos.slice(0, 5)) {
                        const todoStatus = String(todo.status || 'pending');
                        const statusIcon = todoStatus === 'completed' ? '✓' : todoStatus === 'in_progress' ? '●' : '○';
                        const statusColor = todoStatus === 'completed' ? chalk.green : todoStatus === 'in_progress' ? chalk.blue : chalk.gray;
                        const priority = String(todo.priority || 'medium');
                        const priorityColor = this.getPriorityColor(priority);
                        body.push(`    ${statusColor(statusIcon)} ${priorityColor('[' + priority.toUpperCase() + ']')} ${truncText(String(todo.content), width - 40)}`);
                    }
                    if (todos.length > 5) {
                        body.push(chalk.dim(`    ... 还有 ${todos.length - 5} 个`));
                    }
                }
            } catch {
                body.push(chalk.dim('  ✓ 已获取待办列表'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({ icon: '📋', title: '全局待办列表', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private getPriorityColor(priority: string): (s: string) => string {
        const map: Record<string, (s: string) => string> = {
            'low': chalk.blue,
            'medium': chalk.yellow,
            'high': chalk.red,
        };
        return map[priority] || chalk.yellow;
    }

    private async handleExecute(args: z.output<typeof ListGlobalTodosArgsSchema>): Promise<string> {
        const todos = await this.todoMgrApp.callWorker('listGlobalTodos', args.status, args.category, args.priority);
        return JSON.stringify({ success: true, todos });
    }
}
