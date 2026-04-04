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
import chalk from 'chalk';
import { z } from 'zod';

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
            GetCalendarItemsArgsSchema
        );
        this.calendarApp = calendarApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const dateString = args?.['dateString'];
        const body: string[] = [];

        if (dateString) {
            body.push(chalk.dim('日期: ') + chalk.cyan(String(dateString)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 正在获取日程…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            const lines = toolcall.result.split('\n').filter((l) => l.startsWith('- '));
            if (lines.length === 0) {
                body.push(chalk.dim('  ∅ 当日暂无日程'));
            } else {
                body.push(chalk.dim(`  共 ${chalk.white(String(lines.length))} 项日程:`));
                for (const line of lines.slice(0, 5)) {
                    body.push(chalk.hex('#c0c0c0')(truncText(line, width - 8)));
                }
                if (lines.length > 5) {
                    body.push(chalk.dim(`  … 还有 ${lines.length - 5} 项`));
                }
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '📅',
            title: '查询日程',
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
            AddCalendarItemArgsSchema
        );
        this.calendarApp = calendarApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];

        if (args?.['subject']) {
            body.push(chalk.dim('标题: ') + chalk.white(truncText(String(args['subject']), width - 16)));
        }
        if (args?.['dateString']) {
            body.push(chalk.dim('日期: ') + chalk.cyan(String(args['dateString'])));
        }
        if (args?.['isAllDay']) {
            body.push(chalk.dim('时间: ') + chalk.hex('#FFAB00')('全天'));
        } else if (args?.['startTime'] && args?.['endTime']) {
            body.push(chalk.dim('时间: ') + chalk.cyan(`${args['startTime']} — ${args['endTime']}`));
        }
        if (args?.['location']) {
            body.push(chalk.dim('地点: ') + chalk.hex('#4A90D9')(String(args['location'])));
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ✓ 日程已添加，ID: ') + chalk.green(String(result.uid)));
            } catch {
                body.push(chalk.dim('  ✓ 日程已添加'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '📝',
            title: '添加日程',
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
            DeleteCalendarItemArgsSchema
        );
        this.calendarApp = calendarApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const uid = args?.['uid'];
        const body: string[] = [];

        if (uid) {
            body.push(chalk.dim('ID: ') + chalk.cyan(truncText(String(uid), width - 12)));
        }

        if (toolcall.status === 'success') {
            body.push(chalk.dim('  ✓ 日程已删除'));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🗑',
            title: '删除日程',
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
