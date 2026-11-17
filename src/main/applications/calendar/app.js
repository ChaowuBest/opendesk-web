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
import AndroidCalendarWorker from './service/android-worker.js';
import { CalendarOverlay } from './tui';
import { GetCalendarItemsTool, AddCalendarItemTool, DeleteCalendarItemTool, EditCalendarItemTool } from './tools';
import { CALENDAR_SKILL } from './skills';
import chalk from 'chalk';

function systemCalendarConfigSchema() {
    return z.object({
        enabled: z.boolean().default(true).describe(t('config.dataSources.systemCalendar.enabled')),
        defaultCalendarId: z.string().default('').describe(t('config.dataSources.systemCalendar.defaultCalendarId'))
    });
}

function unwrapWorkerResponse(result) {
    if (result?.status === 'ok') return result.data;
    throw Object.assign(new Error(result?.message || t('system.error.unavailable')), {
        code: result?.code || 'CALENDAR_UNAVAILABLE'
    });
}

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
        return process.env.OPENDESK_ANDROID_RUNTIME === '1' ? AndroidCalendarWorker : CalendarWorker;
    }

    static getConfigSchema() {
        return z.object({
            dataSources: z
                .object({
                    systemCalendar: systemCalendarConfigSchema().default({ enabled: true, defaultCalendarId: '' }),
                    outlook: z
                        .object({
                            enabled: z.boolean().default(false).describe(t('config.dataSources.outlook.enabled'))
                        })
                        .optional()
                })
                .default({})
        });
    }

    async getCalendarIntegrationState() {
        if (process.env.OPENDESK_ANDROID_RUNTIME === '1')
            return unwrapWorkerResponse(await this.callWorker('getSystemCalendarState'));
        const config = this.getConfig()?.dataSources?.systemCalendar;
        return {
            supported: false,
            readGranted: false,
            writeGranted: false,
            calendars: [],
            enabled: config?.enabled !== false,
            defaultCalendarId: config?.defaultCalendarId ?? ''
        };
    }

    async requestCalendarAccess() {
        if (process.env.OPENDESK_ANDROID_RUNTIME !== '1') return this.getCalendarIntegrationState();
        return unwrapWorkerResponse(await this.callWorker('requestCalendarAccess'));
    }

    async configureCalendarIntegration(patch) {
        const changes = z
            .object({ enabled: z.boolean().optional(), defaultCalendarId: z.string().optional() })
            .strict()
            .parse(patch);
        const config = this.getConfig() ?? {};
        const current = config.dataSources?.systemCalendar ?? {};
        const next = systemCalendarConfigSchema().parse({ ...current, ...changes });
        if (next.enabled && next.defaultCalendarId) {
            const state = await this.getCalendarIntegrationState();
            if (!state.supported)
                throw Object.assign(new Error(t('system.error.unavailable')), { code: 'CALENDAR_UNAVAILABLE' });
            if (!state.readGranted || !state.writeGranted)
                throw Object.assign(new Error(t('system.error.permissionDenied')), {
                    code: 'CALENDAR_PERMISSION_DENIED'
                });
            const calendar = state.calendars.find((candidate) => candidate.id === next.defaultCalendarId);
            if (!calendar)
                throw Object.assign(new Error(t('system.error.calendarMissing')), { code: 'CALENDAR_NOT_FOUND' });
            if (!calendar.canWrite)
                throw Object.assign(new Error(t('system.error.readOnly')), { code: 'CALENDAR_READ_ONLY' });
        }
        const updated = { ...config, dataSources: { ...config.dataSources, systemCalendar: next } };
        this.setConfig(updated);
        if (process.env.OPENDESK_ANDROID_RUNTIME === '1')
            unwrapWorkerResponse(await this.callWorker('applicationConfigChanged', this.getConfig() ?? updated));
        return this.getCalendarIntegrationState();
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
