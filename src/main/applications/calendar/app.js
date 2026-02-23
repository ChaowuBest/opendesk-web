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
import { BaseToolset, BaseTool } from "../../aikernel/tool";
import { z } from 'zod';
import { logger } from "../../utils/logger.js";
import CalendarWorker from "./service/worker";


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

    /**
     * Get the toolsets for the calendar application
     * @returns {Promise<BaseToolset[]>}
     */
    async getToolsets() {
        let calendarToolset = new BaseToolset('calendar');
        let getCalendarItemsTool = new BaseTool(
            'getCalendarItems',
            '获取指定日期的日程安排和会议列表（注：交流，研讨，培训等各种广义的日程安排也包含在内）',
            z.object({
                dateString: z.string().describe('日期字符串，格式为YYYY-MM-DD')
            })
        );
        getCalendarItemsTool.setExecutor(async (args) => {
            let items = await this.callWorker('getCalendarItems', args.dateString);
            if (items.status !== 'ok') {
                return `错误: 无法获取日程信息: ${items.message}`;
            }

            let result = `在${args.dateString}的日程安排列表为: \n`;
            for (let item of items.data) {
                result += `- ${item.subject}\n`;
                result += `  - 开始时间: ${new Date(item.startTime).toLocaleString()}\n`;
                result += `  - 结束时间: ${new Date(item.endTime).toLocaleString()}\n`;
                if (item.location) {
                    result += `  - 地点: ${item.location}\n`;
                }
            }
            logger.info(`getCalendarItemsTool: ${result}`);
            return result;
        });
        calendarToolset.addTool(getCalendarItemsTool);

        return [calendarToolset];
    }

}

export { CalendarApplication };