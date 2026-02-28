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
import { z } from 'zod';
import { logger } from "../../utils/logger.js";
import CalendarWorker from "./service/worker";
import { CalendarOverlay } from "./tui";
import { GetCalendarItemsTool, AddCalendarItemTool, DeleteCalendarItemTool } from "./tools";


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

    /**
     * Get the toolsets for the calendar application
     * @returns {Promise<BaseToolset[]>}
     */
    async getToolsets() {
        const calendarToolset = new BaseToolset('calendar');

        calendarToolset.addTool(new GetCalendarItemsTool(this));
        calendarToolset.addTool(new AddCalendarItemTool(this));
        calendarToolset.addTool(new DeleteCalendarItemTool(this));

        return [calendarToolset];
    }

}

export { CalendarApplication };