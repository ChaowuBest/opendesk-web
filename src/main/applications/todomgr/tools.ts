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

import { BaseTool } from '../../aikernel/tool';
import { ToolCall } from '../../aikernel/messages';
import { Card, type BorderConfig } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import chalk from 'chalk';
import { z } from 'zod';
import type { TaskTodo } from './common';
import type { TaskState } from '../../states/tasks';
import { escapeHtml } from '../../utils/escape';

// ========== getCurrentTime 工具 ==========

const GetCurrentTimeArgsSchema = z.object({});

export class GetCurrentTimeTool extends BaseTool<typeof GetCurrentTimeArgsSchema> {
    constructor() {
        super(
            'getCurrentTime',
            '获取当前精确的日期和时间。返回包含 UTC 时间、本地时间和时区信息',
            GetCurrentTimeArgsSchema,
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return [chalk.dim('🕐 获取当前时间')];
    }

    private async handleExecute(): Promise<string> {
        const now = new Date();
        const iso = now.toISOString();
        const locale = now.toLocaleString();
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

        // 以 Markdown bullet 格式返回，便于阅读和复用
        return [
            `- **UTC 时间**: ${iso}`,
            `- **当地时间**: ${locale}`,
            `- **时区**: ${timezone}`,
            `- **时间戳**: ${now.getTime()}`,
        ].join('\n');
    }
}

// ========== 触发器 Schema ==========

const EventTriggerSchema = z.object({
    type: z.literal('event'),
    bundleName: z.string().describe('触发事件的应用标识，如 "mailbox", "mcpmgr"'),
    eventName: z.string().describe('事件名称，如 "newEmailCountsUpdated"'),
});

const ScheduledTriggerSchema = z.object({
    type: z.literal('scheduled'),
    triggerAt: z.string()
        .describe('任务触发时间，必须使用UTC时间（ISO8601格式，以Z结尾），请先调用getCurrentTime工具获取当前UTC时间为基准进行计算'),
});

const CronTriggerSchema = z.object({
    type: z.literal('cron'),
    cronExpression: z.string().describe('crontab 表达式: "分 时 日 月 周"，如 "0 9 * * 1-5" 表示工作日每天9点, "*/30 * * * *" 表示每30分钟'),
});

const TriggerSchema = z.discriminatedUnion('type', [
    EventTriggerSchema,
    ScheduledTriggerSchema,
    CronTriggerSchema,
]);

/**
 * 解析 trigger 字段，处理大模型可能将整个 trigger 对象作为字符串传递的情况
 * @param trigger - 原始 trigger 值（可能是对象或字符串）
 * @returns 解析后的 trigger 对象，如果解析失败则返回原始值
 */
function parseTriggerField(trigger: unknown): unknown {
    if (trigger === undefined || trigger === null) {
        return trigger;
    }

    // 如果已经是对象，直接返回
    if (typeof trigger === 'object') {
        return trigger;
    }

    // 如果是字符串，尝试解析为 JSON
    if (typeof trigger === 'string') {
        const trimmed = trigger.trim();
        // 检查是否看起来像 JSON 对象
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                const parsed = JSON.parse(trimmed);
                // 递归处理，以防解析后的结果仍然是字符串形式的 JSON
                return parseTriggerField(parsed);
            } catch (e) {
                // JSON 解析失败，返回原始字符串
                console.warn('Failed to parse trigger string as JSON:', e);
                return trigger;
            }
        }
    }

    return trigger;
}

/**
 * 验证并规范化 trigger 字段
 * @param trigger - 原始 trigger 值
 * @returns 验证后的 trigger 对象，如果无效则抛出错误
 */
function validateAndNormalizeTrigger(trigger: unknown): z.output<typeof TriggerSchema> | undefined {
    if (trigger === undefined || trigger === null) {
        return undefined;
    }

    // 先解析可能存在的字符串形式的 JSON
    const parsedTrigger = parseTriggerField(trigger);

    // 使用 Zod schema 验证
    const result = TriggerSchema.safeParse(parsedTrigger);
    if (!result.success) {
        throw new Error(
            `无效的 trigger 格式: ${result.error.message}。` +
            `trigger 应为对象格式，如: {"type": "scheduled", "triggerAt": "2026-03-01T01:00:00Z"}`
        );
    }

    return result.data;
}

function formatTriggerDisplay(trigger: any): string {
    if (!trigger) return '';
    switch (trigger.type) {
        case 'event':
            return `📡 ${trigger.bundleName}:${trigger.eventName}`;
        case 'scheduled':
            return `⏱ ${new Date(trigger.triggerAt).toLocaleString()}`;
        case 'cron':
            return `🔁 ${trigger.cronExpression}`;
        default:
            return '';
    }
}

// ========== TodoWrite 工具 ==========

const TodoWriteTodoSchema = z.object({
    id: z.string().optional().describe('待办项ID，更新或删除时必填'),
    title: z.string().describe('待办标题（简短描述，用于列表展示）'),
    content: z.string().describe('待办内容（详细描述，发送给 Agent 执行。Agent 有能力调用工具访问文件、执行命令等，因此具体需求应明确写在 content 中）'),
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
            '管理任务级待办事项。每次调用传入完整的待办列表来替换当前所有待办。任务级待办仅在当前任务会话中有效，严格按列表顺序执行',
            TodoWriteArgsSchema,
        );
        this.todoMgrApp = todoMgrApp;
        this.setExecutor(this.handleExecute.bind(this));
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
                const displayText = todo.title || todo.content;
                html += `
          <div style="display: flex; align-items: flex-start; gap: 8px; padding: 8px; background: #f9fafb; border-radius: 8px;">
            <span style="font-size: 16px;">${statusIcon}</span>
            <div style="flex: 1;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-weight: 500; ${isCompleted ? 'text-decoration: line-through; opacity: 0.7;' : ''}">${escapeHtml(displayText)}</span>
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

    private async handleExecute(args: z.output<typeof TodoWriteArgsSchema>, taskState?: TaskState): Promise<string> {
        const { todos } = args;
        const taskId = taskState?.task_id || 'current_task';
        let currentTodos = this.getTaskTodos(taskId);

        currentTodos = todos.map((todoParam) => {
            const existingTodo = todoParam.id ? currentTodos.find(t => t.id === todoParam.id) : undefined;
            return {
                id: todoParam.id || `task_todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                task_id: taskId,
                title: todoParam.title,
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

/**
 * 验证 scheduled trigger 的时间格式
 * @param trigger - 触发器配置
 * @throws Error 如果时间格式不正确
 */
function validateScheduledTrigger(trigger?: z.output<typeof TriggerSchema>): void {
    if (!trigger || trigger.type !== 'scheduled') return;

    const triggerAt = trigger.triggerAt;

    // 检查是否为有效的 ISO 8601 UTC 时间格式（应以 Z 结尾）
    if (!triggerAt.endsWith('Z')) {
        throw new Error(
            `scheduled trigger 的 triggerAt 必须使用 UTC 时间（以 Z 结尾），当前值："${triggerAt}"。` +
            `请使用 getCurrentTime 工具获取当前 UTC 时间，并根据需要计算目标时间。` +
            `例如：当地时间 2026-03-01 09:00 (UTC+8) 应转换为 "2026-03-01T01:00:00Z"`
        );
    }

    // 验证是否为有效的日期
    const date = new Date(triggerAt);
    if (isNaN(date.getTime())) {
        throw new Error(`无效的日期格式："${triggerAt}"，请使用 ISO 8601 UTC 格式，如 "2026-03-01T01:00:00Z"`);
    }
}

const AddGlobalTodoArgsSchema = z.object({
    title: z.string().describe('待办标题（简短描述，用于列表展示）'),
    content: z.string().describe('待办内容（详细描述，发送给 Agent 执行。Agent 有能力调用工具访问文件、执行命令等，因此具体需求应明确写在 content 中）'),
    priority: z.enum(['low', 'medium', 'high']).optional().default('medium').describe('优先级：low[低], medium[中], high[高]'),
    category: z.string().optional().describe('分类标签，如 "bug", "feature", "idea"'),
    trigger: TriggerSchema.optional().describe('触发器配置。event: 事件触发; scheduled: 定时一次性触发 (**必须使用 UTC 时间**); cron: crontab 重复触发。不指定则为手动模式。'),
});

export class AddGlobalTodoTool extends BaseTool<typeof AddGlobalTodoArgsSchema> {
    private todoMgrApp: any;

    constructor(todoMgrApp: any) {
        super(
            'addGlobalTodo',
            '添加全局待办事项，跨所有任务持久保存。可选配置触发器实现自动执行：event(事件触发)、scheduled(定时一次性)、cron(crontab重复)。注意：content 是发送给 Agent 执行的详细指令，Agent 有能力调用工具访问文件、执行命令等，因此具体需求应明确写在 content 中。',
            AddGlobalTodoArgsSchema,
        );
        this.todoMgrApp = todoMgrApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const title = args?.['title'];
        const content = args?.['content'];
        const priority = args?.['priority'] || 'medium';
        const category = args?.['category'];
        const trigger = args?.['trigger'];
        const body: string[] = [];

        if (title || content) {
            const priorityColor = this.getPriorityColor(String(priority));
            if (title) {
                body.push(chalk.dim('标题: ') + truncText(String(title), width - 20));
            }
            if (content) {
                body.push(chalk.dim('内容: ') + truncText(String(content), width - 20));
            }
            body.push(chalk.dim('优先级: ') + priorityColor(String(priority).toUpperCase()));
            if (category) {
                body.push(chalk.dim('分类: ') + chalk.magenta(String(category)));
            }
            if (trigger) {
                body.push(chalk.dim('触发器: ') + chalk.cyan(formatTriggerDisplay(trigger)));
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
        // 解析并验证 trigger 字段（处理大模型可能传入字符串形式的情况）
        const normalizedTrigger = validateAndNormalizeTrigger(args.trigger);

        // 验证 scheduled trigger 的时间格式
        validateScheduledTrigger(normalizedTrigger);

        const result = await this.todoMgrApp.callWorker('addGlobalTodo', args.title, args.content, args.priority, args.category, normalizedTrigger);
        const todo = result?.data ?? result;
        return JSON.stringify({ success: true, id: todo.id, todo });
    }
}

// ========== updateGlobalTodo 工具 ==========

const UpdateGlobalTodoArgsSchema = z.object({
    id: z.string().describe('待办项ID'),
    title: z.string().optional().describe('新的待办标题'),
    content: z.string().optional().describe('新的待办内容（详细描述，发送给 Agent 执行）'),
    status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('新状态'),
    priority: z.enum(['low', 'medium', 'high']).optional().describe('新优先级'),
    category: z.string().optional().describe('新分类标签'),
    trigger: TriggerSchema.optional().describe('新的触发器配置'),
    removeTrigger: z.boolean().optional().describe('设为 true 时移除当前触发器'),
});

export class UpdateGlobalTodoTool extends BaseTool<typeof UpdateGlobalTodoArgsSchema> {
    private todoMgrApp: any;

    constructor(todoMgrApp: any) {
        super(
            'updateGlobalTodo',
            '更新全局待办事项的标题、内容、状态、优先级、分类或触发器。设 removeTrigger 为 true 可移除触发器。**注意**: 1. 设置 scheduled 触发器时，triggerAt 必须使用 UTC 时间（如 "2026-03-01T01:00:00Z"）；2. cron 类型的待办是周期性任务，不允许标记为 completed 状态；3. content 是发送给 Agent 执行的详细指令，Agent 有能力调用工具访问文件、执行命令等。',
            UpdateGlobalTodoArgsSchema,
        );
        this.todoMgrApp = todoMgrApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const id = args?.['id'];
        const body: string[] = [];

        if (id) {
            body.push(chalk.dim('ID: ') + chalk.cyan(String(id)));
            const updates = [];
            if (args.title) updates.push('标题');
            if (args.content) updates.push('内容');
            if (args.status) updates.push('状态');
            if (args.priority) updates.push('优先级');
            if (args.category) updates.push('分类');
            if (args.trigger) updates.push('触发器');
            if (args.removeTrigger) updates.push('移除触发器');
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
        // 解析并验证 trigger 字段（处理大模型可能传入字符串形式的情况）
        const normalizedTrigger = validateAndNormalizeTrigger(args.trigger);

        // 验证 scheduled trigger 的时间格式
        validateScheduledTrigger(normalizedTrigger);

        // 构建更新参数，使用规范化后的 trigger
        const updateArgs = {
            ...args,
            trigger: normalizedTrigger,
        };

        const result = await this.todoMgrApp.callWorker('updateGlobalTodo', args.id, updateArgs);
        const todo = result?.data ?? result;
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
        this.setExecutor(this.handleExecute.bind(this));
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
                        const triggerInfo = todo.trigger ? ' ' + chalk.dim(formatTriggerDisplay(todo.trigger)) : '';
                        const displayText = todo.title || todo.content;
                        body.push(`    ${statusColor(statusIcon)} ${priorityColor('[' + priority.toUpperCase() + ']')} ${truncText(String(displayText), width - 40)}${triggerInfo}`);
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
        const result = await this.todoMgrApp.callWorker('listGlobalTodos', args.status, args.category, args.priority);
        const todos = result?.data ?? result;
        return JSON.stringify({ success: true, todos });
    }
}

// ========== deleteGlobalTodo 工具 ==========

const DeleteGlobalTodoArgsSchema = z.object({
    id: z.string().describe('待办项ID'),
});

export class DeleteGlobalTodoTool extends BaseTool<typeof DeleteGlobalTodoArgsSchema> {
    private todoMgrApp: any;

    constructor(todoMgrApp: any) {
        super(
            'deleteGlobalTodo',
            '删除指定的全局待办事项。',
            DeleteGlobalTodoArgsSchema,
        );
        this.todoMgrApp = todoMgrApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const id = args?.['id'];
        const body: string[] = [];

        if (id) {
            body.push(chalk.dim('ID: ') + chalk.cyan(String(id)));
        }

        if (toolcall.status === 'success') {
            body.push(chalk.dim('  ✓ 待办已删除!'));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({ icon: '🗑', title: '删除全局待办', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(args: z.output<typeof DeleteGlobalTodoArgsSchema>): Promise<string> {
        const result = await this.todoMgrApp.callWorker('deleteGlobalTodo', args.id);
        const todo = result?.data ?? result;
        return JSON.stringify({ success: true, id: args.id, deletedTodo: todo });
    }
}
