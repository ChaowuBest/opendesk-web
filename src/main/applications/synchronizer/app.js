import { BaseApplication, BaseGUIConfig } from "../base.js";
import { SynchronizationService } from "./service/service.js";
import { z } from 'zod';
import path from 'path';


const __dirname = import.meta.dirname;

const SynchronizationConfigSchema = z.object({
    outlook: z.boolean().default(false),
});

class SynchronizerApplication extends BaseApplication {
    constructor() {
        super('synchronizer');
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

    async handleMessage(message, ...args) {
        console.info('synchronizer application received message:', message);
        switch (message) {
            case 'synchronize':
                return await SynchronizationService.getOutlookCalendarItems();
            default:
                throw new Error(`unknown message: ${message}`);
        }
    }
}

export { SynchronizerApplication };