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

import { BaseApplication } from '../base';
import { t } from './locale/index.js';
import { BaseToolset } from '../../aikernel/tool';
import { Skill } from '../../aikernel/skill.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import CalendarWorker from './service/worker';
import { CalendarOverlay } from './tui';
import { GetCalendarItemsTool, AddCalendarItemTool, DeleteCalendarItemTool, EditCalendarItemTool } from './tools';
import { CALENDAR_SKILL } from './skills';
import chalk from 'chalk';

class CalendarApplication extends BaseApplication {
    constructor() {
        super('calendar');
    }

    getName() {
        return t('app.name');
    }

    async getTUIStatusBlock() {
        try {
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const res = await this.callWorker('getCalendarItems', dateStr);
            if (res?.status === 'ok' && Array.isArray(res.data) && res.data.length > 0) {
                const upcoming = res.data
                    .filter((e) => e.startTime > now.getTime())
                    .sort((a, b) => a.startTime - b.startTime);
                if (upcoming.length > 0) {
                    const next = upcoming[0];
                    const diffMin = Math.round((next.startTime - now.getTime()) / 60000);
                    const timeStr =
                        diffMin <= 60
                            ? t('status.inMinutes', { minutes: diffMin })
                            : t('status.afterHoursMinutes', {
                                  hours: Math.floor(diffMin / 60),
                                  minutes: diffMin % 60
                              });
                    const subject = (next.subject || '').slice(0, 16) || t('common.noTitle');
                    const colorFn = diffMin <= 15 ? chalk.hex('#FF1744') : chalk.hex('#448AFF');
                    return `📅 ${colorFn(`${timeStr}: ${subject}`)}`;
                }
                return `📅 ${t('status.todayCount', { count: res.data.length })}`;
            }
            return null;
        } catch {
            return null;
        }
    }

    static getWorkerClass() {
        return CalendarWorker;
    }

    static getConfigSchema() {
        return z.object({
            dataSources: z
                .object({
                    outlook: z
                        .object({
                            enabled: z.boolean().default(false).describe(t('config.dataSources.outlook.enabled'))
                        })
                        .optional()
                })
                .default({})
        });
    }

    getCliSlashCommands(tui) {
        return [
            {
                name: 'calendar',
                description: t('cli.command.open.description'),
                execute: async () => {
                    try {
                        const calendarOverlay = new CalendarOverlay(tui);
                        await calendarOverlay.show();
                    } catch (err) {
                        logger.error(`打开日历失败: ${err}`);
                    }
                }
            }
        ];
    }

    async getSupportedEvents() {
        return [{ eventName: 'calendarItemsChanged', eventDescription: t('appEvent.calendarItemsChanged') }];
    }

    async getSkills() {
        const skill = Skill.parseMd(CALENDAR_SKILL);
        const toolset = new BaseToolset('calendar');
        toolset.addTool(new GetCalendarItemsTool(this));
        toolset.addTool(new AddCalendarItemTool(this));
        toolset.addTool(new EditCalendarItemTool(this));
        toolset.addTool(new DeleteCalendarItemTool(this));
        skill.toolsets = [toolset];
        return [skill];
    }
}

export { CalendarApplication };
