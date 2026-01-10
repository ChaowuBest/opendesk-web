import { BaseApplication, BaseGUIConfig } from "../base.js";
import { z } from 'zod';
import path from 'path';
import { A2AService } from "./service/service.js";

const __dirname = import.meta.dirname;

class A2AApplication extends BaseApplication {
    constructor() {
        super('a2a');
    }

    getConfigSchema() {
        return z.object({});
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(__dirname, 'renderer', 'entry.js')],
            'a2a-entry-widget'
        );
    }

    async handleMessage(message, ...args) {
        switch (message) {
            case 'listAgents':
                return await A2AService.listAgents(args[0] || {});
            case 'createConversation':
                return await A2AService.createConversation();
            case 'clearConversation':
                return await A2AService.clearConversation(args[0]);
            case 'sendChatMessage':
                return await A2AService.sendChatMessage(args[0], args[1]);
            case 'getConversationHistory':
                return await A2AService.getConversationHistory(args[0]);
            default:
                throw new Error(`unknown message: ${message}`);
        }
    }


    getServices() {
        return [A2AService];
    }
}

export { A2AApplication };
