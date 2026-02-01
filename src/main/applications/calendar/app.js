import { BaseApplication } from "../base.js";
import { BaseGUIConfig } from "../base.js";
import { BaseToolset, BaseTool } from "../../agents/tool";
import { z } from 'zod';
import { logger } from "../../utils/logger.js";
import path from 'path';


class CalendarApplication extends BaseApplication {

    constructor() {
        super('calendar', '日历');
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(import.meta.dirname, 'renderer', 'entry.js')],
            'calendar-entry-widget',
            "/applications/calendar/icon.png",
        );
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