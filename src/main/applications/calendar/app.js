import { BaseApplication } from "../base.js";
import { BaseGUIConfig } from "../base.js";
import { CalendarService } from "./service/service.js";
import { BaseToolset, BaseTool } from "../../agents/tool.js";
import { z } from 'zod';
import path from 'path';


class CalendarApplication extends BaseApplication {

    constructor() {
        super('calendar', '日历');
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(import.meta.dirname, 'renderer', 'entry.js')],
            'calendar-entry-widget',
            path.join(import.meta.dirname, 'icon.png')
        );
    }

    getConfigSchema() {
        return z.object({

        });
    }

    /**
     * Get the toolsets for the calendar application
     * @returns {BaseToolset[]}
     */
    getToolsets() {
        let calendarToolset = new BaseToolset('calendar');
        let getCalendarItemsTool = new BaseTool(
            'getCalendarItems', '获取指定日期的日程和会议列表',
            z.object({
                dateString: z.string().describe('日期字符串，格式为YYYY-MM-DD')
            })
        );
        getCalendarItemsTool.setExecutor(async (args) => {
            let items = await CalendarService.getCalendarItems(args.dateString);
            let result = `在${args.dateString}的日程安排列表为: \n`;
            for (let item of items) {
                result += `- ${item.subject}\n`;
                result += `  - 开始时间: ${new Date(item.startTime).toLocaleString()}\n`;
                result += `  - 结束时间: ${new Date(item.endTime).toLocaleString()}\n`;
                if (item.location) {
                    result += `  - 地点: ${item.location}\n`;
                }
            }
            return result;
        });
        calendarToolset.addTool(getCalendarItemsTool);

        return [calendarToolset];
    }

    getServices() {
        return [CalendarService];
    }

    async handleMessage(message, ...args) {
        switch (message) {
            case 'getCalendarItems':
                return await CalendarService.getCalendarItems(args[0]);
            default:
                throw new Error(`unknown message: ${message}`);
        }
    }
}

export { CalendarApplication };