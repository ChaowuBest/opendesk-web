import { BaseApplication, BaseGUIConfig } from "../base.js";
import { EmailProfileSchema } from "./common.js";
import { logger } from "../../utils/logger.js";
import path from 'path';


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
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(__dirname, 'renderer', 'entry.js')],
            'mailbox-entry-widget',

        );
    }
}

export { MailboxApplication };