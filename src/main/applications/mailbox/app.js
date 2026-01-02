import { BaseApplication, BaseGUIConfig } from "../base.js";
import path from 'path';
import { MailboxService } from "./service/service.js";
import { EmailProfileSchema } from "./common.js";

const __dirname = import.meta.dirname;

class MailboxApplication extends BaseApplication {

    constructor() {
        super('mailbox');
    }

    getConfigSchema() {
        return EmailProfileSchema;
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(__dirname, 'renderer', 'entry.js')],
            'mailbox-entry-widget'
        );
    }

    async handleMessage(message, ...args) {
        switch (message) {
            case 'getEmailHeaderList':
                return await MailboxService.getEmailHeaderList();
            case 'getEmailContent':
                return await MailboxService.getEmailContent(args[0]);
            default:
                throw new Error(`unknown message: ${message}`);
        }
    }

    getServices() {
        return [MailboxService];
    }
}

export { MailboxApplication };