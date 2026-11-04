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
import { Card } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import { escapeHtml } from '../../../common/utils/escape.js';
import { t } from './locale/index.js';
import chalk from 'chalk';
import { z } from 'zod';

function fmtTimeGui(ts: number): string {
    const d = new Date(ts);
    const h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${m} ${ampm}`;
}

function fmtDateFullGui(d: Date): string {
    return t('date.format.full', {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        monthName: t(`date.month.${d.getMonth() + 1}`)
    });
}

function renderCalendarItemCard(item: any, title: string, status: string): string {
    const start = new Date(item.startTime);
    const monthLabel = t(`date.month.${start.getMonth() + 1}`);
    const subject = escapeHtml(item.subject);
    const location = item.location ? escapeHtml(item.location) : '';
    const timeStr = item.isAllDay ? t('common.allDay') : `${fmtTimeGui(item.startTime)} — ${fmtTimeGui(item.endTime)}`;
    const dateStr = `${fmtDateFullGui(start)} ${t(`date.weekday.${start.getDay()}`)}`;
    const surface = 'var(--od-bg-elevated, #fff)';
    const surfaceMuted = 'var(--od-bg-muted, #FAFAFA)';
    const text = 'var(--od-text, #1d1d1f)';
    const textMuted = 'var(--od-text-muted, #8E8E93)';
    const border = 'var(--od-border, #F0F0F0)';
    const borderStrong = 'var(--od-border-strong, #EBEBEB)';

    const statusIcon =
        status === 'success'
            ? '<i class="fa-solid fa-circle-check" style="color:#34C759;font-size:14px;"></i>'
            : status === 'error'
              ? '<i class="fa-solid fa-circle-xmark" style="color:#FF3B30;font-size:14px;"></i>'
              : '<i class="fa-solid fa-spinner fa-spin" style="color:#007AFF;font-size:14px;"></i>';

    return `<div style="max-width:380px;font-family:var(--font-sans);-webkit-font-smoothing:antialiased; margin-top: 10px; margin-bottom: 10px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        ${statusIcon}
        <span style="font-size:13px;font-weight:600;color:${text};">${escapeHtml(title)}</span>
    </div>
    <div style="border-radius:14px;background:${surface};border:1px solid ${border};overflow:hidden;">
        <div style="padding:16px;display:flex;align-items:flex-start;gap:14px;">
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:52px;height:52px;border-radius:12px;background:${surfaceMuted};border:1px solid ${borderStrong};flex-shrink:0;">
                <span style="font-size:10px;font-weight:700;color:#FF3B30;text-transform:uppercase;">${monthLabel}</span>
                <span style="font-size:18px;font-weight:800;color:${text};line-height:1;">${start.getDate()}</span>
            </div>
            <div style="flex:1;min-width:0;">
                <div style="font-size:15px;font-weight:700;color:${text};letter-spacing:-0.01em;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${subject}</div>
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <div style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:${text};">
                        <i class="fa-regular fa-clock" style="color:${textMuted};font-size:12px;width:14px;text-align:center;"></i>
                        ${timeStr}
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:${textMuted};">
                        <i class="fa-regular fa-calendar" style="font-size:12px;width:14px;text-align:center;"></i>
                        ${dateStr}
                    </div>
                    ${
                        location
                            ? `<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:${textMuted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                        <i class="fa-solid fa-location-dot" style="font-size:12px;width:14px;text-align:center;"></i>
                        ${location}
                    </div>`
                            : ''
                    }
                </div>
            </div>
        </div>
    </div>
</div>`;
}

// ========== getCalendarItems 工具 ==========

const GetCalendarItemsArgsSchema = z.object({
    dateString: z.string().describe('日期字符串，格式为YYYY-MM-DD')
});

export class GetCalendarItemsTool extends BaseTool<typeof GetCalendarItemsArgsSchema> {
    private calendarApp: any;

    constructor(calendarApp: any) {
        super(
            'getCalendarItems',
            '获取指定日期的日程安排和会议列表（注：交流，研讨，培训等各种广义的日程安排也包含在内）',
            GetCalendarItemsArgsSchema,
            undefined,
            { 'zh-CN': '日程列表', 'en-US': 'Calendar Items' }
        );
        this.calendarApp = calendarApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const dateString = args?.['dateString'];
        const body: string[] = [];

        if (dateString) {
            body.push(chalk.dim(t('tool.label.date')) + chalk.cyan(String(dateString)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim(`  ⏳ ${t('tool.query.running')}`));
        } else if (toolcall.status === 'success' && toolcall.result) {
            const lines = toolcall.result.split('\n').filter((l) => l.startsWith('- '));
            if (lines.length === 0) {
                body.push(chalk.dim(`  ∅ ${t('tool.query.empty')}`));
            } else {
                body.push(chalk.dim(`  ${t('tool.query.total', { count: chalk.white(String(lines.length)) })}`));
                for (const line of lines.slice(0, 5)) {
                    body.push(chalk.hex('#c0c0c0')(truncText(line, width - 8)));
                }
                if (lines.length > 5) {
                    body.push(chalk.dim(`  ${t('tool.query.more', { count: lines.length - 5 })}`));
                }
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '📅',
            title: t('tool.get.title'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof GetCalendarItemsArgsSchema>): Promise<string> {
        const items = await this.calendarApp.callWorker('getCalendarItems', args.dateString);
        if (items.status !== 'ok') {
            return `错误: 无法获取日程信息: ${items.message}`;
        }

        let result = `在${args.dateString}的日程安排列表为: \n`;
        for (const item of items.data) {
            result += `- ${item.subject} (uid: ${item.uid})\n`;
            result += `  - 开始时间: ${new Date(item.startTime).toLocaleString()}\n`;
            result += `  - 结束时间: ${new Date(item.endTime).toLocaleString()}\n`;
            if (item.location) {
                result += `  - 地点: ${item.location}\n`;
            }
        }
        return result;
    }
}

// ========== addCalendarItem 工具 ==========

const AddCalendarItemArgsSchema = z.object({
    subject: z.string().describe('日程标题'),
    dateString: z.string().describe('日期字符串，格式为YYYY-MM-DD'),
    startTime: z.string().describe('开始时间，格式为HH:MM（24小时制）'),
    endTime: z.string().describe('结束时间，格式为HH:MM（24小时制）'),
    location: z.string().optional().describe('地点'),
    isAllDay: z.boolean().optional().default(false).describe('是否为全天事件')
});

export class AddCalendarItemTool extends BaseTool<typeof AddCalendarItemArgsSchema> {
    private calendarApp: any;

    constructor(calendarApp: any) {
        super(
            'addCalendarItem',
            '添加一个新的日程项（会议、约会、活动等），需要指定日期、时间和标题',
            AddCalendarItemArgsSchema,
            undefined,
            { 'zh-CN': '添加日程', 'en-US': 'Add Calendar Item' }
        );
        this.calendarApp = calendarApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const item = JSON.parse(toolcall.result);
                return renderCalendarItemCard(item, t('tool.add.done'), toolcall.status);
            } catch {
                /* fall through */
            }
        }
        if (toolcall.status === 'running') {
            const args = toolcall.args_object as any;
            if (args?.['subject'] && args?.['dateString']) {
                const dateParts = String(args['dateString']).replace(/-/g, '/');
                const startTs = args['isAllDay']
                    ? new Date(dateParts).getTime()
                    : new Date(`${dateParts} ${args['startTime'] || '00:00'}`).getTime();
                const endTs = args['isAllDay']
                    ? startTs + 86400000
                    : new Date(`${dateParts} ${args['endTime'] || '01:00'}`).getTime();
                const pseudo = {
                    subject: args['subject'],
                    startTime: startTs,
                    endTime: endTs,
                    location: args['location'] || '',
                    isAllDay: !!args['isAllDay']
                };
                return renderCalendarItemCard(pseudo, t('tool.add.running'), toolcall.status);
            }
        }
        return undefined;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];

        if (args?.['subject']) {
            body.push(chalk.dim(t('tool.label.subject')) + chalk.white(truncText(String(args['subject']), width - 16)));
        }
        if (args?.['dateString']) {
            body.push(chalk.dim(t('tool.label.date')) + chalk.cyan(String(args['dateString'])));
        }
        if (args?.['isAllDay']) {
            body.push(chalk.dim(t('tool.label.time')) + chalk.hex('#FFAB00')(t('common.allDay')));
        } else if (args?.['startTime'] && args?.['endTime']) {
            body.push(chalk.dim(t('tool.label.time')) + chalk.cyan(`${args['startTime']} — ${args['endTime']}`));
        }
        if (args?.['location']) {
            body.push(chalk.dim(t('tool.label.location')) + chalk.hex('#4A90D9')(String(args['location'])));
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ' + t('tool.add.successWithId')) + chalk.green(String(result.uid)));
            } catch {
                body.push(chalk.dim('  ' + t('tool.add.success')));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '📝',
            title: t('tool.add.title'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof AddCalendarItemArgsSchema>): Promise<string> {
        const { subject, dateString, startTime, endTime, location, isAllDay } = args;

        const dateParts = dateString.replace(/-/g, '/');
        let startTimestamp: number;
        let endTimestamp: number;

        if (isAllDay) {
            startTimestamp = new Date(dateParts).getTime();
            endTimestamp = startTimestamp + 86400000;
        } else {
            startTimestamp = new Date(`${dateParts} ${startTime}`).getTime();
            endTimestamp = new Date(`${dateParts} ${endTime}`).getTime();
        }

        if (isNaN(startTimestamp) || isNaN(endTimestamp)) {
            throw new Error('日期或时间格式无效，请使用 YYYY-MM-DD 和 HH:MM 格式');
        }

        if (endTimestamp <= startTimestamp) {
            throw new Error('结束时间必须晚于开始时间');
        }

        const result = await this.calendarApp.callWorker('addCalendarItem', {
            subject,
            startTime: startTimestamp,
            endTime: endTimestamp,
            location: location || '',
            isAllDay
        });

        const item = result?.data ?? result;
        return JSON.stringify(item);
    }
}

// ========== deleteCalendarItem 工具 ==========

const DeleteCalendarItemArgsSchema = z.object({
    uid: z.string().describe('要删除的日程项的唯一标识符（uid）')
});

export class DeleteCalendarItemTool extends BaseTool<typeof DeleteCalendarItemArgsSchema> {
    private calendarApp: any;

    constructor(calendarApp: any) {
        super(
            'deleteCalendarItem',
            '删除指定的日程项，需要提供日程项的uid（可通过getCalendarItems获取）',
            DeleteCalendarItemArgsSchema,
            undefined,
            { 'zh-CN': '删除日程', 'en-US': 'Delete Calendar Item' }
        );
        this.calendarApp = calendarApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const uid = args?.['uid'];
        const body: string[] = [];

        if (uid) {
            body.push(chalk.dim(t('tool.label.id')) + chalk.cyan(truncText(String(uid), width - 12)));
        }

        if (toolcall.status === 'success') {
            body.push(chalk.dim('  ' + t('tool.delete.success')));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🗑',
            title: t('tool.delete.title'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof DeleteCalendarItemArgsSchema>): Promise<string> {
        const result = await this.calendarApp.callWorker('deleteCalendarItem', args.uid);
        const data = result?.data ?? result;
        return JSON.stringify({ success: true, uid: args.uid, ...data });
    }
}

// ========== editCalendarItem 工具 ==========

const EditCalendarItemArgsSchema = z.object({
    itemId: z.string().describe('要修改的日程项的唯一标识符（uid），可通过 getCalendarItems 获取'),
    subject: z.string().optional().describe('新的日程标题'),
    dateString: z.string().optional().describe('新的日期字符串，格式为YYYY-MM-DD'),
    startTime: z.string().optional().describe('新的开始时间，格式为HH:MM（24小时制）'),
    endTime: z.string().optional().describe('新的结束时间，格式为HH:MM（24小时制）'),
    location: z.string().optional().describe('新的地点'),
    isAllDay: z.boolean().optional().describe('是否为全天事件')
});

export class EditCalendarItemTool extends BaseTool<typeof EditCalendarItemArgsSchema> {
    private calendarApp: any;

    constructor(calendarApp: any) {
        super(
            'editCalendarItem',
            '修改一个已有的日程项，需要提供日程项的uid和要修改的字段',
            EditCalendarItemArgsSchema,
            undefined,
            { 'zh-CN': '修改日程', 'en-US': 'Edit Calendar Item' }
        );
        this.calendarApp = calendarApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const item = JSON.parse(toolcall.result);
                return renderCalendarItemCard(item, t('tool.edit.done'), toolcall.status);
            } catch {
                /* fall through */
            }
        }
        if (toolcall.status === 'running') {
            const args = toolcall.args_object as any;
            if (args?.['subject'] && args?.['dateString']) {
                const dateParts = String(args['dateString']).replace(/-/g, '/');
                const startTs = args['isAllDay']
                    ? new Date(dateParts).getTime()
                    : new Date(`${dateParts} ${args['startTime'] || '00:00'}`).getTime();
                const endTs = args['isAllDay']
                    ? startTs + 86400000
                    : new Date(`${dateParts} ${args['endTime'] || '01:00'}`).getTime();
                const pseudo = {
                    subject: args['subject'],
                    startTime: startTs,
                    endTime: endTs,
                    location: args['location'] || '',
                    isAllDay: !!args['isAllDay']
                };
                return renderCalendarItemCard(pseudo, t('tool.edit.running'), toolcall.status);
            }
        }
        return undefined;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];

        if (args?.['itemId']) {
            body.push(chalk.dim(t('tool.label.id')) + chalk.cyan(truncText(String(args['itemId']), width - 12)));
        }
        if (args?.['subject']) {
            body.push(chalk.dim(t('tool.label.subject')) + chalk.white(truncText(String(args['subject']), width - 16)));
        }
        if (args?.['dateString']) {
            body.push(chalk.dim(t('tool.label.date')) + chalk.cyan(String(args['dateString'])));
        }
        if (args?.['isAllDay']) {
            body.push(chalk.dim(t('tool.label.time')) + chalk.hex('#FFAB00')(t('common.allDay')));
        } else if (args?.['startTime'] && args?.['endTime']) {
            body.push(chalk.dim(t('tool.label.time')) + chalk.cyan(`${args['startTime']} — ${args['endTime']}`));
        }
        if (args?.['location']) {
            body.push(chalk.dim(t('tool.label.location')) + chalk.hex('#4A90D9')(String(args['location'])));
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ' + t('tool.edit.successWithId')) + chalk.green(String(result.uid)));
            } catch {
                body.push(chalk.dim('  ' + t('tool.edit.success')));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '✏️',
            title: t('tool.edit.title'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof EditCalendarItemArgsSchema>): Promise<string> {
        const { itemId, subject, dateString, startTime, endTime, location, isAllDay } = args;

        const updates: Record<string, any> = {};
        if (subject !== undefined) updates.subject = subject;
        if (location !== undefined) updates.location = location;
        if (isAllDay !== undefined) updates.isAllDay = isAllDay;

        if (dateString !== undefined && (startTime !== undefined || endTime !== undefined)) {
            const dateParts = dateString.replace(/-/g, '/');
            if (isAllDay) {
                updates.startTime = new Date(dateParts).getTime();
                updates.endTime = updates.startTime + 86400000;
            } else {
                if (startTime !== undefined) {
                    updates.startTime = new Date(`${dateParts} ${startTime}`).getTime();
                }
                if (endTime !== undefined) {
                    updates.endTime = new Date(`${dateParts} ${endTime}`).getTime();
                }
            }
        } else if (dateString !== undefined) {
            const dateParts = dateString.replace(/-/g, '/');
            if (isAllDay) {
                updates.startTime = new Date(dateParts).getTime();
                updates.endTime = updates.startTime + 86400000;
            } else {
                const baseDate = new Date(dateParts);
                if (startTime !== undefined) {
                    const [h, m] = startTime.split(':').map(Number);
                    baseDate.setHours(h, m, 0, 0);
                    updates.startTime = baseDate.getTime();
                }
                if (endTime !== undefined) {
                    const [h, m] = endTime.split(':').map(Number);
                    const endDate = new Date(dateParts);
                    endDate.setHours(h, m, 0, 0);
                    updates.endTime = endDate.getTime();
                }
            }
        }

        if (Object.keys(updates).length === 0) {
            throw new Error('未提供任何要修改的字段');
        }

        if (updates.startTime !== undefined && isNaN(updates.startTime)) {
            throw new Error('日期或时间格式无效，请使用 YYYY-MM-DD 和 HH:MM 格式');
        }
        if (updates.endTime !== undefined && isNaN(updates.endTime)) {
            throw new Error('日期或时间格式无效，请使用 YYYY-MM-DD 和 HH:MM 格式');
        }

        const result = await this.calendarApp.callWorker('updateCalendarItem', itemId, updates);
        const item = result?.data ?? result;
        return JSON.stringify(item);
    }
}
