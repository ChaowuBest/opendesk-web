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
import { getTaskTodosForDisplay, setTaskTodos, type TaskTodo } from '../../aikernel/todos/task-todos';
import type { TaskState } from '../../aikernel/states/tasks';
import { escapeHtml } from '../../../common/utils/escape.js';
import { t } from './locale/index.js';
import { type TodoMgrApplication } from './app';
import { describeLegacyRecurrence, describeTodoRecurrence } from '../../../common/utils/recurrence-description.js';
import { getRecurrenceValidationMessage } from './recurrence-validation.js';
import chalk from 'chalk';
import path from 'path';
import type { Participant } from '../../plugins/types';
import type { TodoWorkspaceConfig } from './common.js';
import { REASONING_EFFORT_VALUES } from '../../aikernel/types/reasoning.js';
import { formatDateTimeInTimezone, getSystemTimezone, isValidTimezone } from '../../../common/utils/timezone.js';

const GetCurrentTimeArgsSchema = z.object({});

export class GetCurrentTimeTool extends BaseTool<typeof GetCurrentTimeArgsSchema> {
    constructor() {
        super(
            'getCurrentTime',
            '获取当前精确的日期和时间，返回 UTC 绝对时间、本地时间、系统 IANA 时区和 UTC 偏移。创建 scheduled 触发器时使用 UTC triggerAt；重复任务使用 recurrence，周期 time 按目标 IANA timezone 的当地时间填写，间隔 anchorAt 使用 UTC。',
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
            `- **${t('tool.getCurrentTime.labelTimezone')}**: ${getSystemTimezone()} (${timezone})`,
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

const TimezoneSchema = z
    .string()
    .refine(isValidTimezone, {
        error: (issue) => t('error.timezoneInvalid', { timezone: String(issue.input) })
    })
    .optional()
    .describe(
        'IANA 时区，如 "Asia/Shanghai"、"America/New_York"；新建时默认使用系统时区，更新时应保留原时区，旧 cron 未指定时保持 UTC；scheduled 中仅用于展示'
    );

const ScheduledTriggerSchema = z.object({
    type: z.literal('scheduled'),
    triggerAt: z
        .string()
        .describe(
            '任务触发时间，必须使用UTC时间（ISO8601格式，以Z结尾），请先调用getCurrentTime工具获取当前UTC时间为基准进行计算'
        ),
    timezone: TimezoneSchema
});

const RecurrenceSchema = z
    .object({
        mode: z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'yearly', 'interval']),
        time: z
            .string()
            .optional()
            .describe('当地执行时间 HH:mm；周期模式及新建 day、week、month、year 间隔必填，hour 间隔不填写'),
        weekdays: z
            .array(z.number().int().min(0).max(6))
            .optional()
            .describe(
                'weekly、biweekly 及带 time 的 week 间隔必填非空星期数组，0=周日，1=周一，6=周六；旧间隔计划的星期筛选仅作兼容'
            ),
        days: z
            .array(z.number().int().min(1).max(31))
            .min(1)
            .optional()
            .describe(
                'monthly、yearly 及带 time 的 month、year 间隔必填非空日期数组，1..31；优先于旧 day 字段，没有所选日期的月份跳过'
            ),
        months: z
            .array(z.number().int().min(1).max(12))
            .min(1)
            .optional()
            .describe(
                'yearly 及带 time 的 year 间隔必填非空月份数组，1..12；每个所选月份的每个所选日期都执行，优先于旧 month 字段'
            ),
        day: z.number().int().optional().describe('兼容旧 monthly、yearly 计划的单个日期；新计划使用 days'),
        month: z.number().int().optional().describe('兼容旧 yearly 计划的单个月份；新计划使用 months'),
        anchorDate: z.string().optional().describe('biweekly 必填 YYYY-MM-DD，该日期所在的当地周一至周日为首个执行周'),
        anchorAt: z
            .string()
            .optional()
            .describe(
                'interval 必填 UTC ISO 时间，必须精确到整分钟。hour 从此时刻累计真实小时；带 time 的 day、week、month、year 以此刻所在当地日、周（周一起始）、月、年为首个周期，仅执行不早于此刻的所选当地日期和时间'
            ),
        intervalValue: z.number().int().min(1).max(10000).optional().describe('interval 的正整数间隔值'),
        intervalUnit: z
            .enum(['hour', 'day', 'week', 'month', 'year'])
            .optional()
            .describe('interval 的单位：小时、天、周、月或年'),
        intervalHours: z
            .number()
            .int()
            .optional()
            .describe('仅兼容旧 interval 计划的正整数小时数，最大 8760；新计划使用 intervalValue 和 intervalUnit')
    })
    .strict()
    .superRefine((value, context) => {
        const message = getRecurrenceValidationMessage(value, t);
        if (message) context.addIssue({ code: 'custom', message });
    });

const CronTriggerSchema = z
    .object({
        type: z.literal('cron'),
        cronExpression: z
            .string()
            .optional()
            .describe(
                '仅用于兼容已有计划的内部 5 字段表达式。新建重复任务请使用 recurrence 并省略此字段；recurrence 存在时会自动填充内部唤醒规则，不要向用户展示表达式。'
            ),
        timezone: TimezoneSchema,
        recurrence: RecurrenceSchema.optional().describe(
            '可视化周期或间隔计划：每天/每周/双周/每月/每年，或每隔 N 小时、天、周、月、年；按天及更长单位的新间隔需指定当地日期和时间'
        )
    })
    .superRefine((value, context) => {
        if (!value.recurrence && !value.cronExpression?.trim()) {
            context.addIssue({ code: 'custom', message: t('error.recurrenceInvalid') });
        }
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

    if (result.data.type === 'cron' && result.data.recurrence) {
        return { ...result.data, cronExpression: '* * * * *' };
    }
    return result.data;
}

function formatTriggerDisplay(trigger: any, cronTimezoneFallback = 'UTC'): string {
    if (!trigger) return '';
    switch (trigger.type) {
        case 'event':
            return `📡 ${trigger.bundleName}:${trigger.eventName}`;
        case 'scheduled': {
            const timezone = trigger.timezone ?? getSystemTimezone();
            return `⏱ ${formatDateTimeInTimezone(trigger.triggerAt, timezone)} (${timezone})`;
        }
        case 'cron': {
            const timezone = trigger.timezone ?? cronTimezoneFallback;
            return `🔁 ${trigger.recurrence ? describeTodoRecurrence(trigger.recurrence, t, timezone) : describeLegacyRecurrence(trigger.cronExpression, t, timezone)}`;
        }
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

function renderTodoCardHtml(actionLabel: string, args: any, toolcall: ToolCall, cronTimezoneFallback = 'UTC'): string {
    const title = args?.['title'] || '';
    const content = args?.['content'] || '';
    const trigger = args?.['trigger'];
    const isEnabled = args?.['enabled'] !== false;

    const triggerType = trigger?.type || 'scheduled';
    const tCfg = TRIGGER_ICON_CONFIG[triggerType] || TRIGGER_ICON_CONFIG.scheduled;
    const sCfg = getStatusBadge(isEnabled);
    const triggerDesc = formatTriggerDisplay(trigger, cronTimezoneFallback);

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
    title: z.string().optional().describe('待办标题（简短描述，用于列表展示）。可省略，省略时自动取 content 作为标题'),
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

    private setTaskTodos(taskId: string, todos: readonly TaskTodo[]): void {
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

        // 传入空列表视为"无变更"，避免 Agent 在任务结束时误传 [] 把已完成的计划清掉。
        // 用户希望计划执行结束后完整保留在"任务计划"面板里以便回看。
        if (todos.length === 0) {
            // 用只读快照广播，避免把 Map 内部的数组引用交给事件订阅者
            const unchangedTodos = getTaskTodosForDisplay(taskId);
            try {
                await this.todoMgrApp.emitEvent('taskTodosUpdated', { taskId, todos: unchangedTodos });
            } catch (err) {
                console.warn('emit taskTodosUpdated failed', err);
            }
            return JSON.stringify({
                success: true,
                todos: unchangedTodos,
                note: unchangedTodos.length
                    ? '传入的待办列表为空，已保留原有任务计划（如需清空请显式传入空数组意图不被采纳）'
                    : '当前任务无任务计划，传入空列表被视为无操作'
            });
        }

        const existingTodos = getTaskTodosForDisplay(taskId);
        const nowIso = new Date().toISOString();
        const currentTodos = todos.map((todoParam) => {
            const existingTodo = todoParam.id ? existingTodos.find((t) => t.id === todoParam.id) : undefined;

            // title 缺省时用 content 兜底，保证任务计划面板始终有展示文本
            const title = (todoParam.title || todoParam.content).slice(0, 200);

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
                title,
                content: todoParam.content,
                status: todoParam.status,
                created_at: existingTodo?.created_at || nowIso,
                updated_at: nowIso,
                // 只在有值时才写入字段，避免留下值为 undefined 的键（缺省字段就该是不存在）
                ...(started_at ? { started_at } : {}),
                ...(completed_at ? { completed_at } : {})
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
        '触发器配置。event: 事件触发；scheduled: 定时一次性触发（triggerAt 必须为 UTC 绝对时间，timezone 仅用于展示）；cron: 使用 recurrence 设置重复任务，time 为当地时间。hour 间隔从 UTC anchorAt 累计真实小时；新 day/week/month/year 间隔指定 time 及对应星期/日期/月份。新建时 timezone 未指定则使用系统时区。不指定 trigger 则为手动模式。'
    ),
    deliver: ChannelDeliverSchema.optional().describe(
        '任务完成后的回复投递目标。指定后，触发任务的最终回复会发送到该渠道联系人；不指定时，如果当前任务来自渠道会自动继承当前会话。'
    ),
    workspace: z.string().optional().describe('触发后创建任务时使用的工作空间绝对路径；不指定则使用当前默认工作空间。'),
    model: z.string().min(1).optional().describe('触发任务使用的聊天模型 alias；不指定则使用触发时的全局默认模型。'),
    reasoningEffort: z
        .enum(REASONING_EFFORT_VALUES)
        .optional()
        .describe('推理档位；空字符串或不指定表示使用所选模型的默认档位。')
});

export class AddGlobalTodoTool extends BaseTool<typeof AddGlobalTodoArgsSchema> {
    private todoMgrApp: TodoMgrApplication;

    constructor(todoMgrApp: TodoMgrApplication) {
        super(
            'addGlobalTodo',
            '添加全局待办事项，跨所有任务持久保存。可选配置触发器实现自动执行：event(事件触发)、scheduled(单次)、cron(用 recurrence 设置周期或间隔)。向用户用自然语言说明执行频率，不展示内部表达式。可通过 workspace 指定触发任务的工作空间，通过 deliver 指定最终回复发送到哪个渠道联系人。注意：content 是发送给 Agent 执行的详细指令，Agent 有能力调用工具访问文件、执行命令等，因此具体需求应明确写在 content 中。',
            AddGlobalTodoArgsSchema,
            undefined,
            { 'zh-CN': '添加全局待办', 'en-US': 'Add Global Todo' }
        );
        this.todoMgrApp = todoMgrApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return Promise.resolve(
            renderTodoCardHtml(t('tool.card.add'), toolcall.args_object, toolcall, getSystemTimezone())
        );
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
                body.push(
                    chalk.dim(t('tool.cli.label.trigger')) +
                        chalk.cyan(formatTriggerDisplay(trigger, getSystemTimezone()))
                );
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
            workspace,
            args.model,
            args.reasoningEffort
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
    removeWorkspace: z.boolean().optional().describe('设为 true 时移除当前工作空间配置，恢复使用默认工作空间'),
    model: z.string().min(1).optional().describe('新的聊天模型 alias；不指定则保持原配置。'),
    removeModel: z.boolean().optional().describe('设为 true 时移除当前模型配置，恢复使用全局默认模型。'),
    reasoningEffort: z
        .enum(REASONING_EFFORT_VALUES)
        .optional()
        .describe('新的推理档位；空字符串表示使用所选模型的默认档位。')
});

export class UpdateGlobalTodoTool extends BaseTool<typeof UpdateGlobalTodoArgsSchema> {
    private todoMgrApp: TodoMgrApplication;

    constructor(todoMgrApp: TodoMgrApplication) {
        super(
            'updateGlobalTodo',
            '更新全局待办事项的标题、内容、启用状态、触发器、工作空间或回复投递目标。设 removeTrigger/removeDeliver/removeWorkspace 为 true 可移除对应配置。注意：scheduled.triggerAt 是 UTC 绝对时间，timezone 仅用于展示；重复任务通过 recurrence 更新频率，time 是所选时区当地时间。hour 间隔累计真实小时，新 day/week/month/year 间隔通过 time 及星期/日期/月份指定当地执行时间；修改其他信息时保留原频率和时区。向用户使用自然语言说明频率，不展示内部表达式。content 是发送给 Agent 执行的详细指令。',
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
        const {
            trigger,
            removeTrigger,
            deliver,
            removeDeliver,
            workspace,
            removeWorkspace,
            model,
            removeModel,
            ...rest
        } = args;
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
        if (removeModel) {
            updateArgs.removeModel = true;
        } else if (model !== undefined) {
            updateArgs.model = model;
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
