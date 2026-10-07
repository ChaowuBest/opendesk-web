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
import { escapeHtml } from '../../../common/utils/escape.js';
import { t } from './locale/index.js';
import { type TodoMgrApplication } from './app';
import { describeCron, type CronDescribeLabels } from '../../utils/cron';
import chalk from 'chalk';
import path from 'path';
import type { Participant } from '../../plugins/types';
import type { TodoWorkspaceConfig } from './common.js';

const GetCurrentTimeArgsSchema = z.object({});

/** describeCron 的多语言文案，词条随当前 locale 动态解析 */
function cronLabels(): CronDescribeLabels {
    return {
        dowNames: Array.from({ length: 7 }, (_, i) => t(`cron.desc.dowNames.${i}`)),
        everyDowTemplate: t('cron.desc.everyDow'),
        dowTemplate: t('cron.desc.dow'),
        monthlyDomTemplate: t('cron.desc.monthlyDom'),
        monthTemplate: t('cron.desc.month'),
        hourTemplate: t('cron.desc.hourOnly'),
        minuteTemplate: t('cron.desc.minuteOnly'),
        everyMinute: t('cron.desc.everyMinute')
    };
}

export class GetCurrentTimeTool extends BaseTool<typeof GetCurrentTimeArgsSchema> {
    constructor() {
        super(
            'getCurrentTime',
            '获取当前精确的日期和时间。返回包含 UTC 时间、本地时间和时区信息',
            GetCurrentTimeArgsSchema,
            undefined,
            { 'zh-CN': '当前时间', 'en-US': 'Current Time' }
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return [chalk.dim(`🕐 ${t('tool.getCurrentTime.name')}`)];
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : '';

        return `<div class="od-inline-toolcall-container">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="far fa-clock shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(t('tool.getCurrentTime.name'))}</span>
                ${statusIcon}
                <span class="text-xs text-slate-600">${escapeHtml(timeStr)}</span>
            </div>
        </div>`;
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
            `- **${t('tool.getCurrentTime.labelUtc')}**: ${iso}`,
            `- **${t('tool.getCurrentTime.labelLocal')}**: ${locale}`,
            `- **${t('tool.getCurrentTime.labelTimezone')}**: ${timezone}`,
            `- **${t('tool.getCurrentTime.labelTimestamp')}**: ${now.getTime()}`
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

const ChannelDeliverSchema = z.object({
    type: z.literal('channel').optional().describe('投递目标类型，当前仅支持 channel，可省略'),
    channel: z.string().min(1).describe('渠道 ID，如 feishu、weixin'),
    accountId: z.string().min(1).describe('渠道账号 ID'),
    recipientId: z.string().min(1).describe('接收方 ID，私聊为 senderId，群聊为 groupId')
});

function normalizeDeliverField(deliver?: z.output<typeof ChannelDeliverSchema>): Participant | undefined {
    if (!deliver) return undefined;
    return {
        type: 'channel',
        channel: deliver.channel,
        accountId: deliver.accountId,
        recipientId: deliver.recipientId
    };
}

function normalizeWorkspaceField(workspace?: string): TodoWorkspaceConfig | undefined {
    if (workspace === undefined) return undefined;

    const normalized = workspace.trim();
    if (!normalized) {
        throw new Error(t('error.workspaceEmpty'));
    }
    if (!path.isAbsolute(normalized)) {
        throw new Error(t('error.workspaceNotAbsolute', { workspace }));
    }
    return { type: 'path', path: normalized };
}

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
            t('error.triggerInvalid', {
                message: result.error.message
            })
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
            return `🔁 ${describeCron(trigger.cronExpression, cronLabels())}`;
        default:
            return '';
    }
}

function formatDeliverDisplay(deliver: any): string {
    if (!deliver) return '';
    return `${deliver.channel}:${deliver.accountId} → ${deliver.recipientId}`;
}

const TRIGGER_ICON_CONFIG: Record<string, { icon: string; bg: string; color: string }> = {
    scheduled: { icon: 'fa-clock', bg: '#EFF6FF', color: '#2563EB' },
    cron: { icon: 'fa-arrows-rotate', bg: '#F0FDF4', color: '#16A34A' },
    event: { icon: 'fa-bolt', bg: '#FFF7ED', color: '#EA580C' }
};

function getStatusBadge(isEnabled: boolean): { color: string; bg: string; label: string; dot: string } {
    const style = isEnabled
        ? { color: '#2563EB', bg: '#EFF6FF', dot: '#007AFF' }
        : { color: '#8E8E93', bg: '#F5F5F7', dot: '#C7C7CC' };
    return { ...style, label: t(isEnabled ? 'status.enabled' : 'status.disabled') };
}

function renderTodoCardHtml(actionLabel: string, args: any, toolcall: ToolCall): string {
    const title = args?.['title'] || '';
    const content = args?.['content'] || '';
    const trigger = args?.['trigger'];
    const isEnabled = args?.['enabled'] !== false;

    const triggerType = trigger?.type || 'scheduled';
    const tCfg = TRIGGER_ICON_CONFIG[triggerType] || TRIGGER_ICON_CONFIG.scheduled;
    const sCfg = getStatusBadge(isEnabled);
    const triggerDesc = formatTriggerDisplay(trigger);

    const isRunning = toolcall.status === 'running';
    const isSuccess = toolcall.status === 'success';
    const isError = toolcall.status === 'error';

    let resultHtml = '';
    if (isSuccess && toolcall.result) {
        try {
            const result = JSON.parse(toolcall.result);
            resultHtml = `<div style="display:flex;align-items:center;gap:5px;margin-top:10px;padding:8px 10px;background:#F0FDF4;border-radius:8px;font-size:12px;color:#16A34A;">
                <i class="fas fa-check-circle"></i> ${
                    result.id
                        ? escapeHtml(t('tool.card.successWithId', { id: String(result.id).slice(0, 16) }))
                        : escapeHtml(t('tool.card.success'))
                }
            </div>`;
        } catch {
            resultHtml = `<div style="margin-top:10px;padding:8px 10px;background:#F0FDF4;border-radius:8px;font-size:12px;color:#16A34A;"><i class="fas fa-check-circle"></i> ${escapeHtml(t('tool.card.success'))}</div>`;
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
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:13px;font-weight:600;color:#1d1d1f;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(String(title))}</div>
                        ${content ? `<div style="font-size:12px;color:#8E8E93;line-height:1.4;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(String(content).slice(0, 80))}</div>` : ''}
                        <div style="display:flex;align-items:center;gap:6px;margin-top:5px;flex-wrap:wrap;">
                            <span style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:6px;font-size:11px;font-weight:500;line-height:1.6;background:${sCfg.bg};color:${sCfg.color};">
                                <span style="width:7px;height:7px;border-radius:50%;background:${sCfg.dot};display:inline-block;"></span>
                                ${sCfg.label}
                            </span>
                            ${triggerDesc ? `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:6px;font-size:11px;font-weight:500;line-height:1.6;background:#F5F5F7;color:#8E8E93;">${escapeHtml(triggerDesc)}</span>` : ''}
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
    status: z.enum(['pending', 'in_progress', 'completed']).describe('状态（保留字段，暂无实际语义）')
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
            TodoWriteArgsSchema,
            undefined,
            { 'zh-CN': '任务规划', 'en-US': 'Plan Tasks' }
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

    /**
     * 根据传入列表判断动作语义：全部待办项都带 id（即更新已有待办）视为"更新"，
     * 存在无 id 的新待办项或空列表视为"创建/规划"。用于微调渲染标题。
     */
    private getTodoWriteActionTitle(todos: any[]): string {
        return todos.length > 0 && todos.every((t) => t?.id != null)
            ? t('tool.todoWrite.cardTitle.update')
            : t('tool.todoWrite.cardTitle.create');
    }

    renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        // 聊天界面仅展示一行简洁摘要，风格与 filemgr 的 readFile / writeFile 一致；
        // 完整的待办清单会展示在右侧"任务计划"面板中。
        const args = toolcall.args_object as any;
        const todos = Array.isArray(args?.['todos']) ? args['todos'] : [];
        const total = todos.length;
        const enabled = todos.filter((t: any) => t.enabled !== false).length;

        let title = this.getTodoWriteActionTitle(todos);
        let detail = '';
        if (total > 0) {
            if (enabled === 0) {
                title = t('tool.todoWrite.cardDisabled');
                detail = t('tool.todoWrite.itemsCount', { count: total });
            } else {
                detail = `${enabled}/${total}`;
            }
        }

        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : toolcall.status === 'error'
                  ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
                  : '';

        const detailHtml = detail ? `<span class="truncate text-xs text-slate-600">${escapeHtml(detail)}</span>` : '';

        const html = `<div class="od-inline-toolcall-container">
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
        const enabled = todos.filter((t: any) => t.enabled !== false).length;
        const disabled = todos.filter((t: any) => t.enabled === false).length;

        // 如果所有任务都未启用，显示完整列表
        if (total > 0 && disabled === total) {
            return this.renderCompletedTodosCli(todos, width);
        }

        // 否则显示简洁摘要
        let summary = `${this.getTodoWriteActionTitle(todos)} · ${t('tool.todoWrite.cliSummary', { total })}`;
        if (total > 0) {
            if (enabled > 0) summary += ` · ${t('tool.todoWrite.cliEnabled', { count: enabled })}`;
            if (disabled > 0) summary += ` · ${t('tool.todoWrite.cliDisabled', { count: disabled })}`;
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
            title: t('tool.todoWrite.cliAllCompleted'),
            body: bodyLines,
            border: borderConfig
        });

        return card.render(width);
    }

    private getStatusIcon(status: string): string {
        const map: Record<string, string> = {
            pending: '⭕',
            in_progress: '🔄',
            completed: '⭕'
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
        throw new Error(t('error.triggerAtMustUtc', { triggerAt }));
    }

    // 验证是否为有效的日期
    const date = new Date(triggerAt);
    if (isNaN(date.getTime())) {
        throw new Error(t('error.triggerAtInvalidDate', { triggerAt }));
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
        .describe('优先级（保留字段，暂无实际语义）'),
    category: z.string().optional().describe('分类标签（保留字段，暂无实际语义）'),
    trigger: TriggerSchema.optional().describe(
        '触发器配置。event: 事件触发; scheduled: 定时一次性触发 (**必须使用 UTC 时间**); cron: crontab 重复触发。不指定则为手动模式。'
    ),
    deliver: ChannelDeliverSchema.optional().describe(
        '任务完成后的回复投递目标。指定后，触发任务的最终回复会发送到该渠道联系人；不指定时，如果当前任务来自渠道会自动继承当前会话。'
    ),
    workspace: z.string().optional().describe('触发后创建任务时使用的工作空间绝对路径；不指定则使用当前默认工作空间。')
});

export class AddGlobalTodoTool extends BaseTool<typeof AddGlobalTodoArgsSchema> {
    private todoMgrApp: TodoMgrApplication;

    constructor(todoMgrApp: TodoMgrApplication) {
        super(
            'addGlobalTodo',
            '添加全局待办事项，跨所有任务持久保存。可选配置触发器实现自动执行：event(事件触发)、scheduled(定时一次性)、cron(crontab重复)。可通过 workspace 指定触发任务的工作空间，通过 deliver 指定最终回复发送到哪个渠道联系人。注意：content 是发送给 Agent 执行的详细指令，Agent 有能力调用工具访问文件、执行命令等，因此具体需求应明确写在 content 中。',
            AddGlobalTodoArgsSchema,
            undefined,
            { 'zh-CN': '添加全局待办', 'en-US': 'Add Global Todo' }
        );
        this.todoMgrApp = todoMgrApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return Promise.resolve(renderTodoCardHtml(t('tool.card.add'), toolcall.args_object, toolcall));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const title = args?.['title'];
        const content = args?.['content'];
        const trigger = args?.['trigger'];
        const body: string[] = [];

        if (title || content) {
            if (title) {
                body.push(chalk.dim(t('tool.cli.label.title')) + truncText(String(title), width - 20));
            }
            if (content) {
                body.push(chalk.dim(t('tool.cli.label.content')) + truncText(String(content), width - 20));
            }
            if (trigger) {
                body.push(chalk.dim(t('tool.cli.label.trigger')) + chalk.cyan(formatTriggerDisplay(trigger)));
            }
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ✓ ' + t('tool.cli.add.successWithId')) + chalk.green(String(result.id)));
                if (result.todo?.deliver) {
                    body.push(
                        chalk.dim('  📨 ' + t('tool.cli.add.deliveredTo')) +
                            chalk.blueBright(formatDeliverDisplay(result.todo.deliver))
                    );
                }
            } catch {
                body.push(chalk.dim('  ✓ ' + t('tool.cli.add.success')));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🌍',
            title: t('tool.cli.add.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof AddGlobalTodoArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        // 解析并验证 trigger 字段（处理大模型可能传入字符串形式的情况）
        const normalizedTrigger = validateAndNormalizeTrigger(args.trigger);

        // 验证 scheduled trigger 的时间格式
        validateScheduledTrigger(normalizedTrigger);

        const explicitDeliver = normalizeDeliverField(args.deliver);
        // 未显式指定 deliver 时，从当前任务的 origin 继承（如飞书发起的会话，待办也投递到飞书）
        const deliver = explicitDeliver ?? taskState?.origin;
        const workspace = normalizeWorkspaceField(args.workspace);

        const result = await this.todoMgrApp.callWorker(
            'addGlobalTodo',
            args.title,
            args.content,
            args.priority,
            args.category,
            normalizedTrigger,
            deliver,
            workspace
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
    enabled: z.boolean().optional().describe('是否启用。设为 true 启用自动触发，设为 false 禁用'),
    priority: z.enum(['low', 'medium', 'high']).optional().describe('新优先级'),
    category: z.string().optional().describe('新分类标签'),
    trigger: TriggerSchema.optional().describe('新的触发器配置'),
    removeTrigger: z.boolean().optional().describe('设为 true 时移除当前触发器'),
    deliver: ChannelDeliverSchema.optional().describe('新的回复投递目标；指定后任务最终回复会发送到该渠道联系人'),
    removeDeliver: z.boolean().optional().describe('设为 true 时移除当前回复投递目标'),
    workspace: z.string().optional().describe('新的触发任务工作空间绝对路径'),
    removeWorkspace: z.boolean().optional().describe('设为 true 时移除当前工作空间配置，恢复使用默认工作空间')
});

export class UpdateGlobalTodoTool extends BaseTool<typeof UpdateGlobalTodoArgsSchema> {
    private todoMgrApp: TodoMgrApplication;

    constructor(todoMgrApp: TodoMgrApplication) {
        super(
            'updateGlobalTodo',
            '更新全局待办事项的标题、内容、启用状态、触发器、工作空间或回复投递目标。设 removeTrigger/removeDeliver/removeWorkspace 为 true 可移除对应配置。**注意**: 1. 设置 scheduled 触发器时，triggerAt 必须使用 UTC 时间（如 "2026-03-01T01:00:00Z"）；2. content 是发送给 Agent 执行的详细指令，Agent 有能力调用工具访问文件、执行命令等。',
            UpdateGlobalTodoArgsSchema,
            undefined,
            { 'zh-CN': '更新全局待办', 'en-US': 'Update Global Todo' }
        );
        this.todoMgrApp = todoMgrApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return Promise.resolve(renderTodoCardHtml(t('tool.card.update'), toolcall.args_object, toolcall));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const id = args?.['id'];
        const body: string[] = [];

        if (id) {
            body.push(chalk.dim('ID: ') + chalk.cyan(String(id)));
            const updates: string[] = [];
            if (args.title) updates.push(t('tool.cli.update.field.title'));
            if (args.content) updates.push(t('tool.cli.update.field.content'));
            if (args.enabled !== undefined) updates.push(t('tool.cli.update.field.enabled'));
            if (args.priority) updates.push(t('tool.cli.update.field.priority'));
            if (args.category) updates.push(t('tool.cli.update.field.category'));
            if (args.trigger) updates.push(t('tool.cli.update.field.trigger'));
            if (args.removeTrigger) updates.push(t('tool.cli.update.field.removeTrigger'));
            if (updates.length > 0) {
                body.push(chalk.dim(t('tool.cli.update.updated')) + chalk.yellow(updates.join(', ')));
            }
        }

        if (toolcall.status === 'success' && toolcall.result) {
            body.push(chalk.dim('  ✓ ' + t('tool.cli.update.success')));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🔄',
            title: t('tool.cli.update.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof UpdateGlobalTodoArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const { trigger, removeTrigger, deliver, removeDeliver, workspace, removeWorkspace, ...rest } = args;
        const updateArgs: Record<string, unknown> = { ...rest };

        if (removeTrigger) {
            updateArgs.removeTrigger = true;
        }
        if (removeDeliver) {
            updateArgs.removeDeliver = true;
        } else if (deliver !== undefined) {
            updateArgs.deliver = normalizeDeliverField(deliver);
        } else if (taskState?.origin) {
            // 保留旧行为：从渠道会话中更新待办时，默认继承当前会话作为投递目标。
            updateArgs.deliver = taskState.origin;
        }
        if (removeWorkspace) {
            updateArgs.removeWorkspace = true;
        } else if (workspace !== undefined) {
            updateArgs.workspace = normalizeWorkspaceField(workspace);
        }
        if (trigger !== undefined) {
            const normalizedTrigger = validateAndNormalizeTrigger(trigger);
            validateScheduledTrigger(normalizedTrigger);
            updateArgs.trigger = normalizedTrigger;
        }

        const result = await this.todoMgrApp.callWorker('updateGlobalTodo', args.id, updateArgs);
        const todo = result?.data ?? result;
        return JSON.stringify({ success: true, id: args.id, todo });
    }
}

// ========== listGlobalTodoDeliverTargets 工具 ==========

const ListGlobalTodoDeliverTargetsArgsSchema = z.object({});

export class ListGlobalTodoDeliverTargetsTool extends BaseTool<typeof ListGlobalTodoDeliverTargetsArgsSchema> {
    private todoMgrApp: TodoMgrApplication;

    constructor(todoMgrApp: TodoMgrApplication) {
        super(
            'listGlobalTodoDeliverTargets',
            '列出自动化任务可用的渠道投递目标。创建或更新全局待办时，可将返回的 deliver 对象传给 addGlobalTodo/updateGlobalTodo。',
            ListGlobalTodoDeliverTargetsArgsSchema,
            undefined,
            { 'zh-CN': '待办触发目标', 'en-US': 'Todo Targets' }
        );
        this.todoMgrApp = todoMgrApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(): Promise<string> {
        const channels = await this.todoMgrApp.getConnectedChannelsForUI();
        if (channels.length === 0) {
            return t('tool.deliverTargets.empty');
        }

        const lines: string[] = [];
        for (const channel of channels) {
            const status = channel.online ? t('tool.deliverTargets.online') : t('tool.deliverTargets.offline');
            lines.push(`- ${channel.label} (${channel.channelId}:${channel.accountId}) ${status}`);
            if (channel.recipients.length === 0) {
                lines.push(`  - ${t('tool.deliverTargets.noContacts')}`);
                continue;
            }
            for (const recipient of channel.recipients) {
                const chatType =
                    recipient.chatType === 'group' ? t('tool.deliverTargets.group') : t('tool.deliverTargets.private');
                const deliver = {
                    type: 'channel',
                    channel: channel.channelId,
                    accountId: channel.accountId,
                    recipientId: recipient.recipientId
                };
                lines.push(`  - ${recipient.displayName} (${chatType}) deliver=${JSON.stringify(deliver)}`);
            }
        }

        return lines.join('\n');
    }
}

// ========== listGlobalTodos 工具 ==========

const ListGlobalTodosArgsSchema = z.object({
    enabled: z
        .enum(['enabled', 'disabled', 'all'])
        .optional()
        .default('all')
        .describe('启用状态筛选：enabled[启用中], disabled[未启用], all[全部]'),
    category: z.string().optional().describe('分类筛选'),
    priority: z.enum(['low', 'medium', 'high']).optional().describe('优先级筛选')
});

export class ListGlobalTodosTool extends BaseTool<typeof ListGlobalTodosArgsSchema> {
    private todoMgrApp: TodoMgrApplication;

    constructor(todoMgrApp: TodoMgrApplication) {
        super(
            'listGlobalTodos',
            '列出所有全局待办事项，支持按启用状态、分类和优先级筛选。',
            ListGlobalTodosArgsSchema,
            undefined,
            {
                'zh-CN': '全局待办列表',
                'en-US': 'List Global Todos'
            }
        );
        this.todoMgrApp = todoMgrApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];

        if (toolcall.status === 'running') {
            body.push(chalk.dim(`  ⏳ ${t('tool.cli.list.loading')}`));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                const todos = Array.isArray(result.todos) ? result.todos : [];
                if (todos.length === 0) {
                    body.push(chalk.dim(`  ${t('tool.cli.list.empty')}`));
                } else {
                    body.push(chalk.dim(`  ${t('tool.cli.list.found', { count: chalk.white(String(todos.length)) })}`));
                    for (const todo of todos.slice(0, 5)) {
                        const isEnabled = todo.enabled !== false;
                        const statusIcon = isEnabled ? '●' : '○';
                        const statusColor = isEnabled ? chalk.blue : chalk.gray;
                        const triggerInfo = todo.trigger ? ' ' + chalk.dim(formatTriggerDisplay(todo.trigger)) : '';
                        const deliverInfo = todo.deliver
                            ? ' ' + chalk.dim('📨 ' + formatDeliverDisplay(todo.deliver))
                            : '';
                        const displayText = todo.title || todo.content;
                        body.push(
                            `    ${statusColor(statusIcon)} ${truncText(String(displayText), width - 40)}${triggerInfo}${deliverInfo}`
                        );
                    }
                    if (todos.length > 5) {
                        body.push(chalk.dim(`    ${t('tool.cli.list.more', { count: todos.length - 5 })}`));
                    }
                }
            } catch {
                body.push(chalk.dim(`  ✓ ${t('tool.cli.list.success')}`));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '📋',
            title: t('tool.cli.list.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof ListGlobalTodosArgsSchema>): Promise<string> {
        const result = await this.todoMgrApp.callWorker('listGlobalTodos', args.enabled, args.category, args.priority);
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
        super('deleteGlobalTodo', '删除指定的全局待办事项。', DeleteGlobalTodoArgsSchema, undefined, {
            'zh-CN': '删除全局待办',
            'en-US': 'Delete Global Todo'
        });
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
            body.push(chalk.dim(`  ✓ ${t('tool.cli.delete.success')}`));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🗑',
            title: t('tool.cli.delete.cardTitle'),
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
            GetSupportedEventsArgsSchema,
            undefined,
            { 'zh-CN': '支持的事件', 'en-US': 'Supported Events' }
        );
        this.setExecutor(this.handleExecute.bind(this));
        this.todoMgrApp = todoMgrApp;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return [chalk.dim(`📡 ${t('tool.cli.events.cardTitle')}`)];
    }

    private async handleExecute(): Promise<string> {
        const applicationRegistry = this.todoMgrApp.registry;
        if (!applicationRegistry) {
            return t('tool.events.errorNoRegistry');
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
