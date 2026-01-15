import { BaseApplication, BaseGUIConfig } from "../base.js";
import { BaseTool } from "../../agents/tool.js";
import { SynchronizationService } from "./service/service.js";
import { z } from 'zod';
import path from 'path';


const __dirname = import.meta.dirname;

const SynchronizationConfigSchema = z.object({
    outlook: z.boolean().default(false),
});

class SynchronizerApplication extends BaseApplication {
    constructor() {
        super('synchronizer', '同步');
    }

    getConfigSchema() {
        return SynchronizationConfigSchema;
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(__dirname, 'widgets', 'entry.js')],
            'synchronizer-entry-widget'
        );
    }

    getTools() {
        let tool = new BaseTool('getFutureCalendarItems', '获取未来指定天数内的日历事件', z.object({
            days: z.number().default(10),
        }));
        tool.setExecutor(async (args) => {
            const result = await SynchronizationService.getOutlookCalendarItems(-1, args.days);
            console.info(result);
            return JSON.stringify(result);
        });
        return [tool];
    }
}

export { SynchronizerApplication };