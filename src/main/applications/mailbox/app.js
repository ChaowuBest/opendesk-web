import { BaseApplication, BaseGUIConfig } from "../base.js";
import path from 'path';
import { MailboxService } from "./service/service.js";
import { EmailProfileSchema } from "./common.js";
import { logger } from "../../utils/logger.js";

const __dirname = import.meta.dirname;

class MailboxApplication extends BaseApplication {

    constructor() {
        super('mailbox', '邮箱');
    }

    getConfigSchema() {
        return EmailProfileSchema;
    }

    onConfigChanged() {
        logger.info(`mailbox application config changed`);
        MailboxService.sendApplicationConfig(this.getConfig()).then(() => {
            MailboxService.syncEmails();
        })
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(__dirname, 'renderer', 'entry.js')],
            'mailbox-entry-widget',
            path.join(import.meta.dirname, 'icon.png')
        );
    }

    async handleMessage(message, ...args) {
        switch (message) {
            case 'getEmailHeaderList':
                return await MailboxService.getEmailHeaderList();
            case 'getEmailContent':
                return await MailboxService.getEmailContent(args[0]);
            case 'reDownloadEmailContent':
                return await MailboxService.reDownloadEmailContent(args[0]);
            case 'markEmailAsRead':
                return await MailboxService.markEmailAsRead(args[0]);
            default:
                throw new Error(`unknown message: ${message}`);
        }
    }

    getServices() {
        return [MailboxService];
    }
}

export { MailboxApplication };