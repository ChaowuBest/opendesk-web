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
import { z } from 'zod';
import { type TaskTodo, getOrInitTaskTodos, setTaskTodos } from '../../aikernel/todos/task-todos';
import type { TaskState } from '../../aikernel/states/tasks';
import { escapeHtml } from '../../utils/escape';
import { type TodoMgrApplication } from './app';
import { describeCron } from '../../utils/cron';
import chalk from 'chalk';

const GetCurrentTimeArgsSchema = z.object({});

export class GetCurrentTimeTool extends BaseTool<typeof GetCurrentTimeArgsSchema> {
    constructor() {
        super(
            'getCurrentTime',
            '获取当前精确的日期和时间。返回包含 UTC 时间、本地时间和时区信息',
            GetCurrentTimeArgsSchema
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

        // 使用 getTimezoneOffset() 获取更可靠的时区偏移量
        const offsetMin = -now.getTimezoneOffset(); // e.g. +480 for UTC+8
        const offsetHours = Math.floor(Math.abs(offsetMin) / 60);
        const offsetRemainingMin = Math.abs(offsetMin) % 60;
        const offsetSign = offsetMin >= 0 ? '+' : '-';
        const offsetStr = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetRemainingMin).padStart(2, '0')}`;
        const timezone = `UTC${offsetStr}`;

        return [
            `- **UTC 时间**: ${iso}`,
            `- **当地时间**: ${locale}`,
            `- **时区**: ${timezone}`,
            `- **时间戳**: ${now.getTime()}`
        ].join('\n');
    }
}

// ========== 触发器 Schema ==========

const EventTriggerSchema = z.object({
    type: z.literal('event'),
    bundleName: z.string().describe('触发事件的应用标识，如 "mailbox", "mcpmgr"'),
    eventName: z.string().describe('事件名称，如 "newEmailCountsUpdated"')
});

const ScheduledTriggerSchema = z.object({
    type: z.literal('scheduled'),
    triggerAt: z
        .string()
        .describe(
            '任务触发时间，必须使用UTC时间（ISO8601格式，以Z结尾），请先调用getCurrentTime工具获取当前UTC时间为基准进行计算'
        )
});

const CronTriggerSchema = z.object({
    type: z.literal('cron'),
    cronExpression: z
        .string()
        .describe('crontab 表达式: "分 时 日 月 周"，如 "0 9 * * 1-5" 表示工作日每天9点, "*/30 * * * *" 表示每30分钟')
});

const TriggerSchema = z.discriminatedUnion('type', [EventTriggerSchema, ScheduledTriggerSchema, CronTriggerSchema]);

/**
 * 解析 trigger 字段，处理大模型可能将整个 trigger 对象作为字符串传递的情况
 * @param trigger - 原始 trigger 值（可能是对象或字符串）
 * @returns 解析后的 trigger 对象，如果解析失败则返回原始值
 */
function parseTriggerField(trigger: unknown): any {
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
            return `🔁 ${describeCron(trigger.cronExpression)}`;
        default:
            return '';
    }
}

function formatDeliverDisplay(deliver: any): string {
    if (!deliver) return '';
    return `${deliver.channel}:${deliver.accountId} → ${deliver.recipientId}`;
}

const TRIGGER_ICON_CONFIG: Record<string, { icon: string; bg: string; color: string; label: string }> = {
    scheduled: { icon: 'fa-clock', bg: '#EFF6FF', color: '#2563EB', label: '定时任务' },
    cron: { icon: 'fa-arrows-rotate', bg: '#F0FDF4', color: '#16A34A', label: '周期任务' },
    event: { icon: 'fa-bolt', bg: '#FFF7ED', color: '#EA580C', label: '按需触发' }
};
const PRIORITY_BADGE: Record<string, { color: string; bg: string; label: string }> = {
    high: { color: '#DC2626', bg: '#FEF2F2', label: '高' },
    medium: { color: '#D97706', bg: '#FFFBEB', label: '中' },
    low: { color: '#16A34A', bg: '#F0FDF4', label: '低' }
};
const STATUS_BADGE: Record<string, { color: string; bg: string; label: string; dot: string }> = {
    pending: { color: '#8E8E93', bg: '#F5F5F7', label: '待执行', dot: '#C7C7CC' },
    in_progress: { color: '#2563EB', bg: '#EFF6FF', label: '执行中', dot: '#007AFF' },
    completed: { color: '#16A34A', bg: '#F0FDF4', label: '已完成', dot: '#34C759' }
};

function renderTodoCardHtml(actionLabel: string, args: any, toolcall: ToolCall): string {
    const title = args?.['title'] || '';
    const content = args?.['content'] || '';
    const priority = args?.['priority'] || 'medium';
    const category = args?.['category'];
    const trigger = args?.['trigger'];
    const status = args?.['status'] || 'pending';

    const triggerType = trigger?.type || 'scheduled';
    const tCfg = TRIGGER_ICON_CONFIG[triggerType] || TRIGGER_ICON_CONFIG.scheduled;
    const pCfg = PRIORITY_BADGE[priority] || PRIORITY_BADGE.medium;
    const sCfg = STATUS_BADGE[status] || STATUS_BADGE.pending;
    const triggerDesc = formatTriggerDisplay(trigger);

    const isRunning = toolcall.status === 'running';
    const isSuccess = toolcall.status === 'success';
    const isError = toolcall.status === 'error';

    let resultHtml = '';
    if (isSuccess && toolcall.result) {
        try {
            const result = JSON.parse(toolcall.result);
            resultHtml = `<div style="display:flex;align-items:center;gap:5px;margin-top:10px;padding:8px 10px;background:#F0FDF4;border-radius:8px;font-size:12px;color:#16A34A;">
                <i class="fas fa-check-circle"></i> 操作成功${result.id ? `（ID: ${escapeHtml(String(result.id).slice(0, 16))}…）` : ''}
            </div>`;
        } catch {
            resultHtml =
                '<div style="margin-top:10px;padding:8px 10px;background:#F0FDF4;border-radius:8px;font-size:12px;color:#16A34A;"><i class="fas fa-check-circle"></i> 操作成功</div>';
        }
    } else if (isError && toolcall.result) {
        resultHtml = `<div style="margin-top:10px;padding:8px 10px;background:#FEF2F2;border-radius:8px;font-size:12px;color:#DC2626;"><i class="fas fa-circle-xmark"></i> ${escapeHtml(String(toolcall.result).slice(0, 120))}</div>`;
    }

    return `<div style="padding:0;margin:6px 0;">
        <div style="border:1px solid #EBEBEB;border-radius:12px;overflow:hidden;background:#fff;">
            <div style="padding:12px 14px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                    <div style="width:28px;height:28px;border-radius:8px;background:${tCfg.bg};color:${tCfg.color};display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;">
                        <i class="fas ${tCfg.icon}"></i>
                    </div>
                    <span style="font-size:12px;color:#8E8E93;font-weight:500;">${escapeHtml(actionLabel)}</span>
                    ${isRunning ? '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#3B82F6;animation:pulse 1.5s infinite;margin-left:auto;"></span>' : ''}
                </div>
                <div style="display:flex;align-items:flex-start;gap:10px;">
                    <div style="width:32px;height:32px;border-radius:8px;background:${pCfg.bg};display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">
                        <span style="width:8px;height:8px;border-radius:50%;background:${pCfg.color};display:inline-block;"></span>
                    </div>
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:13px;font-weight:600;color:#1d1d1f;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(String(title))}</div>
                        ${content ? `<div style="font-size:12px;color:#8E8E93;line-height:1.4;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(String(content).slice(0, 80))}</div>` : ''}
                        <div style="display:flex;align-items:center;gap:6px;margin-top:5px;flex-wrap:wrap;">
                            <span style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:6px;font-size:11px;font-weight:500;line-height:1.6;background:${sCfg.bg};color:${sCfg.color};">
                                <span style="width:7px;height:7px;border-radius:50%;background:${sCfg.dot};display:inline-block;"></span>
                                ${sCfg.label}
                            </span>
                            ${triggerDesc ? `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:6px;font-size:11px;font-weight:500;line-height:1.6;background:#F5F5F7;color:#8E8E93;">${escapeHtml(triggerDesc)}</span>` : ''}
                            ${category ? `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:6px;font-size:11px;font-weight:500;line-height:1.6;background:#F5F3FF;color:#7C3AED;">${escapeHtml(String(category))}</span>` : ''}
                        </div>
                    </div>
                </div>
                ${resultHtml}
            </div>
        </div>
    </div>`;
}

// ========== TodoWrite 工具 ==========

const TodoWriteTodoSchema = z.object({
    id: z.string().optional().describe('待办项ID，更新或删除时必填'),
    title: z.string().describe('待办标题（简短描述，用于列表展示）'),
    content: z
        .string()
        .describe(
            '待办内容（详细描述，发送给 Agent 执行。Agent 有能力调用工具访问文件、执行命令等，因此具体需求应明确写在 content 中）'
        ),
    status: z
        .enum(['pending', 'in_progress', 'completed'])
        .describe('状态：pending[待定], in_progress[进行中], completed[已完成]')
});

const TodoWriteArgsSchema = z.object({
    todos: z.array(TodoWriteTodoSchema).describe('完整的待办事项列表（替换当前所有待办）')
});

export class TodoWriteTool extends BaseTool<typeof TodoWriteArgsSchema> {
    private todoMgrApp: TodoMgrApplication;

    constructor(todoMgrApp: TodoMgrApplication) {
        super(
            'TodoWrite',
            '管理任务级待办事项。每次调用传入完整的待办列表来替换当前所有待办。任务级待办仅在当前任务会话中有效，严格按列表顺序执行',
            TodoWriteArgsSchema
        );
        this.todoMgrApp = todoMgrApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private getTaskTodos(taskId: string): TaskTodo[] {
        return getOrInitTaskTodos(taskId);
    }

    private setTaskTodos(taskId: string, todos: TaskTodo[]): void {
        setTaskTodos(taskId, todos);
    }

    renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        // 聊天界面仅展示一行简洁摘要，风格与 filemgr 的 readFile / writeFile 一致；
        // 完整的待办清单会展示在右侧"任务计划"面板中。
        const args = toolcall.args_object as any;
        const todos = Array.isArray(args?.['todos']) ? args['todos'] : [];
        const total = todos.length;
        const completed = todos.filter((t: any) => t.status === 'completed').length;

        let title = '更新任务计划';
        let detail = '';
        if (total > 0) {
            if (completed === total) {
                title = '任务计划已完成';
                detail = `${total} 项`;
            } else {
                detail = `${completed}/${total}`;
            }
        }

        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : toolcall.status === 'error'
                  ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
                  : '';

        const detailHtml = detail ? `<span class="truncate text-xs text-slate-600">${escapeHtml(detail)}</span>` : '';

        const html = `<div class="my-2">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-list-check shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(title)}</span>
                ${statusIcon}
                ${detailHtml}
            </div>
        </div>`;
        return Promise.resolve(html);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const todos = Array.isArray(args?.['todos']) ? args['todos'] : [];

        const total = todos.length;
        const completed = todos.filter((t) => t.status === 'completed').length;
        const inProgress = todos.filter((t) => t.status === 'in_progress').length;
        const pending = todos.filter((t) => t.status === 'pending').length;

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

        return [`📋 ${summary}`];
    }

    private renderCompletedTodosCli(todos: any[], width: number): string[] {
        const accentColor = chalk.hex('#F96850');
        const borderConfig: BorderConfig = {
            style: 'square',
            colorFn: accentColor
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
            border: borderConfig
        });

        return card.render(width);
    }

    private getStatusIcon(status: string): string {
        const map: Record<string, string> = {
            pending: '⭕',
            in_progress: '🔄',
            completed: '✅'
        };
        return map[status] || '⭕';
    }

    private async handleExecute(args: z.output<typeof TodoWriteArgsSchema>, taskState?: TaskState): Promise<string> {
        const { todos } = args;
        const taskId = taskState?.task_id || 'current_task';
        let currentTodos = this.getTaskTodos(taskId);

        // 传入空列表视为"无变更"，避免 Agent 在任务结束时误传 [] 把已完成的计划清掉。
        // 用户希望计划执行结束后完整保留在"任务计划"面板里以便回看。
        if (todos.length === 0) {
            try {
                await this.todoMgrApp.emitEvent('taskTodosUpdated', { taskId, todos: currentTodos });
            } catch (err) {
                console.warn('emit taskTodosUpdated failed', err);
            }
            return JSON.stringify({
                success: true,
                todos: currentTodos,
                note: currentTodos.length
                    ? '传入的待办列表为空，已保留原有任务计划（如需清空请显式传入空数组意图不被采纳）'
                    : '当前任务无任务计划，传入空列表被视为无操作'
            });
        }

        const nowIso = new Date().toISOString();
        currentTodos = todos.map((todoParam) => {
            const existingTodo = todoParam.id ? currentTodos.find((t) => t.id === todoParam.id) : undefined;

            // started_at：首次进入 in_progress 或 completed 时记录一次，后续保持不变。
            // 这样已完成项能回溯到"最早启动时间"，进行中项也有稳定的计时起点。
            let started_at = existingTodo?.started_at;
            if (!started_at && (todoParam.status === 'in_progress' || todoParam.status === 'completed')) {
                started_at = nowIso;
            }

            // completed_at：进入 completed 时记录一次，后续保持不变。
            const completed_at = todoParam.status === 'completed' ? existingTodo?.completed_at || nowIso : undefined;

            return {
                id: todoParam.id || `task_todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                task_id: taskId,
                title: todoParam.title,
                content: todoParam.content,
                status: todoParam.status,
                created_at: existingTodo?.created_at || nowIso,
                updated_at: nowIso,
                started_at,
                completed_at
            };
        });

        // 即使全部完成也保留在内存中，让任务计划面板继续展示"已完成"的勾选状态，
        // 方便用户回看整条计划。下一次 TodoWrite 仍会以传入的 todos 整体替换，不会叠加。
        this.setTaskTodos(taskId, currentTodos);

        // 向订阅者广播任务级待办变更，UI 侧据此实时刷新"任务计划"面板
        try {
            await this.todoMgrApp.emitEvent('taskTodosUpdated', {
                taskId,
                todos: currentTodos
            });
        } catch (err) {
            // 事件分发失败不影响工具本身的成功返回
            console.warn('emit taskTodosUpdated failed', err);
        }

        return JSON.stringify({ success: true, todos: currentTodos });
    }
}

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
    content: z
        .string()
        .describe(
            '待办内容（详细描述，发送给 Agent 执行。Agent 有能力调用工具访问文件、执行命令等，因此具体需求应明确写在 content 中）'
        ),
    priority: z
        .enum(['low', 'medium', 'high'])
        .optional()
        .default('medium')
        .describe('优先级：low[低], medium[中], high[高]'),
    category: z.string().optional().describe('分类标签，如 "bug", "feature", "idea"'),
    trigger: TriggerSchema.optional().describe(
        '触发器配置。event: 事件触发; scheduled: 定时一次性触发 (**必须使用 UTC 时间**); cron: crontab 重复触发。不指定则为手动模式。'
    )
});

export class AddGlobalTodoTool extends BaseTool<typeof AddGlobalTodoArgsSchema> {
    private todoMgrApp: TodoMgrApplication;

    constructor(todoMgrApp: TodoMgrApplication) {
        super(
            'addGlobalTodo',
            '添加全局待办事项，跨所有任务持久保存。可选配置触发器实现自动执行：event(事件触发)、scheduled(定时一次性)、cron(crontab重复)。注意：content 是发送给 Agent 执行的详细指令，Agent 有能力调用工具访问文件、执行命令等，因此具体需求应明确写在 content 中。',
            AddGlobalTodoArgsSchema
        );
        this.todoMgrApp = todoMgrApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return Promise.resolve(renderTodoCardHtml('添加自动化任务', toolcall.args_object, toolcall));
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
                if (result.todo?.deliver) {
                    body.push(chalk.dim('  📨 投递到: ') + chalk.blueBright(formatDeliverDisplay(result.todo.deliver)));
                }
            } catch {
                body.push(chalk.dim('  ✓ 待办已添加!'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🌍',
            title: '添加全局待办',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private getPriorityColor(priority: string): (s: string) => string {
        const map: Record<string, (s: string) => string> = {
            low: chalk.blue,
            medium: chalk.yellow,
            high: chalk.red
        };
        return map[priority] || chalk.yellow;
    }

    private async handleExecute(
        args: z.output<typeof AddGlobalTodoArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        // 解析并验证 trigger 字段（处理大模型可能传入字符串形式的情况）
        const normalizedTrigger = validateAndNormalizeTrigger(args.trigger);

        // 验证 scheduled trigger 的时间格式
        validateScheduledTrigger(normalizedTrigger);

        // 从当前任务的 origin 继承 deliver（如飞书发起的会话，待办也投递到飞书）
        const deliver = taskState?.origin;

        const result = await this.todoMgrApp.callWorker(
            'addGlobalTodo',
            args.title,
            args.content,
            args.priority,
            args.category,
            normalizedTrigger,
            deliver
        );
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
    removeTrigger: z.boolean().optional().describe('设为 true 时移除当前触发器')
});

export class UpdateGlobalTodoTool extends BaseTool<typeof UpdateGlobalTodoArgsSchema> {
    private todoMgrApp: TodoMgrApplication;

    constructor(todoMgrApp: TodoMgrApplication) {
        super(
            'updateGlobalTodo',
            '更新全局待办事项的标题、内容、状态、优先级、分类或触发器。设 removeTrigger 为 true 可移除触发器。**注意**: 1. 设置 scheduled 触发器时，triggerAt 必须使用 UTC 时间（如 "2026-03-01T01:00:00Z"）；2. cron 类型的待办是周期性任务，不允许标记为 completed 状态；3. content 是发送给 Agent 执行的详细指令，Agent 有能力调用工具访问文件、执行命令等。',
            UpdateGlobalTodoArgsSchema
        );
        this.todoMgrApp = todoMgrApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return Promise.resolve(renderTodoCardHtml('更新自动化任务', toolcall.args_object, toolcall));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const id = args?.['id'];
        const body: string[] = [];

        if (id) {
            body.push(chalk.dim('ID: ') + chalk.cyan(String(id)));
            const updates: string[] = [];
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

        return new Card({
            icon: '🔄',
            title: '更新全局待办',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof UpdateGlobalTodoArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        // 解析并验证 trigger 字段（处理大模型可能传入字符串形式的情况）
        const normalizedTrigger = validateAndNormalizeTrigger(args.trigger);

        // 验证 scheduled trigger 的时间格式
        validateScheduledTrigger(normalizedTrigger);

        // 从当前任务的 origin 继承 deliver
        const deliver = taskState?.origin;

        // 构建更新参数，使用规范化后的 trigger
        const updateArgs = {
            ...args,
            trigger: normalizedTrigger,
            deliver
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
    priority: z.enum(['low', 'medium', 'high']).optional().describe('优先级筛选')
});

export class ListGlobalTodosTool extends BaseTool<typeof ListGlobalTodosArgsSchema> {
    private todoMgrApp: TodoMgrApplication;

    constructor(todoMgrApp: TodoMgrApplication) {
        super('listGlobalTodos', '列出所有全局待办事项，支持按状态、分类和优先级筛选。', ListGlobalTodosArgsSchema);
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
                        const statusColor =
                            todoStatus === 'completed'
                                ? chalk.green
                                : todoStatus === 'in_progress'
                                  ? chalk.blue
                                  : chalk.gray;
                        const priority = String(todo.priority || 'medium');
                        const priorityColor = this.getPriorityColor(priority);
                        const triggerInfo = todo.trigger ? ' ' + chalk.dim(formatTriggerDisplay(todo.trigger)) : '';
                        const deliverInfo = todo.deliver
                            ? ' ' + chalk.dim('📨 ' + formatDeliverDisplay(todo.deliver))
                            : '';
                        const displayText = todo.title || todo.content;
                        body.push(
                            `    ${statusColor(statusIcon)} ${priorityColor('[' + priority.toUpperCase() + ']')} ${truncText(String(displayText), width - 40)}${triggerInfo}${deliverInfo}`
                        );
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

        return new Card({
            icon: '📋',
            title: '全局待办列表',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private getPriorityColor(priority: string): (s: string) => string {
        const map: Record<string, (s: string) => string> = {
            low: chalk.blue,
            medium: chalk.yellow,
            high: chalk.red
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
    id: z.string().describe('待办项ID')
});

export class DeleteGlobalTodoTool extends BaseTool<typeof DeleteGlobalTodoArgsSchema> {
    private todoMgrApp: TodoMgrApplication;

    constructor(todoMgrApp: TodoMgrApplication) {
        super('deleteGlobalTodo', '删除指定的全局待办事项。', DeleteGlobalTodoArgsSchema);
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

        return new Card({
            icon: '🗑',
            title: '删除全局待办',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof DeleteGlobalTodoArgsSchema>): Promise<string> {
        const result = await this.todoMgrApp.callWorker('deleteGlobalTodo', args.id);
        const todo = result?.data ?? result;
        return JSON.stringify({ success: true, id: args.id, deletedTodo: todo });
    }
}

// ========== getSupportedEvents 工具 ==========

const GetSupportedEventsArgsSchema = z.object({});

export class GetSupportedEventsTool extends BaseTool<typeof GetSupportedEventsArgsSchema> {
    private todoMgrApp: TodoMgrApplication;

    constructor(todoMgrApp: TodoMgrApplication) {
        super(
            'getSupportedEvents',
            '获取所有应用已注册的事件清单。返回一个列表，包含每个应用声明的事件名称和描述，用于创建事件触发型待办事项时选择合适的触发事件。',
            GetSupportedEventsArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
        this.todoMgrApp = todoMgrApp;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return [chalk.dim('📡 获取应用事件清单')];
    }

    private async handleExecute(): Promise<string> {
        const applicationRegistry = this.todoMgrApp.registry;
        if (!applicationRegistry) {
            return '错误：未找到ApplicationRegistry，无法获取可用事件';
        }
        const eventsMap = await applicationRegistry.getAllSupportedEvents();

        const result: { bundleName: string; eventName: string; eventDescription: string }[] = [];
        for (const [bundleName, events] of eventsMap) {
            for (const event of events) {
                result.push({
                    bundleName,
                    eventName: event.eventName,
                    eventDescription: event.eventDescription
                });
            }
        }

        return JSON.stringify({ success: true, events: result }, null, 2);
    }
}
