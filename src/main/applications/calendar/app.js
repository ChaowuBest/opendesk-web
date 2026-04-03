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

import { BaseApplication } from "../base";
import { BaseToolset } from "../../aikernel/tool";
import { Skill } from "../../aikernel/skill.js";
import { z } from 'zod';
import { logger } from "../../utils/logger.js";
import CalendarWorker from "./service/worker";
import { CalendarOverlay } from "./tui";
import { GetCalendarItemsTool, AddCalendarItemTool, DeleteCalendarItemTool } from "./tools";
import { CALENDAR_SKILL } from "./skills";


class CalendarApplication extends BaseApplication {

    constructor() {
        super('calendar', '日历');
    }

    static getWorkerClass() {
        return CalendarWorker;
    }

    static getConfigSchema() {
        return z.object({
            dataSources: z.object({
                outlook: z.object({
                    enabled: z.boolean().default(false).describe('是否同步Outlook日历数据'),
                }).optional()
            }).default({})
        });
    }

    getCliSlashCommands(tui) {
        return [
            {
                name: 'calendar',
                description: '打开日历',
                execute: async () => {
                    try {
                        const calendarOverlay = new CalendarOverlay(tui);
                        await calendarOverlay.show();
                    } catch (err) {
                        logger.error(`打开日历失败: ${err}`);
                    }
                },
            },
        ];
    }

    async getSkills() {
        const skill = Skill.parseMd(CALENDAR_SKILL);
        const toolset = new BaseToolset('calendar');
        toolset.addTool(new GetCalendarItemsTool(this));
        toolset.addTool(new AddCalendarItemTool(this));
        toolset.addTool(new DeleteCalendarItemTool(this));
        skill.toolsets = [toolset];
        return [skill];
    }

}

export { CalendarApplication };