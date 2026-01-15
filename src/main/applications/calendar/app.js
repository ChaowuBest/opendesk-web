import { BaseApplication } from "../base.js";
import { BaseGUIConfig } from "../base.js";
import { FSService } from "../../services/fs/service.js";
import { z } from 'zod';
import path from 'path';


class CalendarApplication extends BaseApplication {
    constructor() {
        super('calendar', '日历');
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(import.meta.dirname, 'renderer', 'entry.js')],
            'filemgr-entry-widget',
            path.join(import.meta.dirname, 'icon.png')
        );
    }

    getConfigSchema() {
        return z.object({

        });
    }

    getTools() {
        const config = this.getConfig();
        if (config === undefined) {
            return [];
        }

        let tools = [];
        return tools;
    }

    async handleMessage(message, ...args) {
        switch (message) {
            default:
                throw new Error(`unknown message: ${message}`);
        }
    }
}

export { CalendarApplication };