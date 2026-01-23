import { BaseApplication, BaseGUIConfig } from "../base.js";
import { MailboxConfigSchema } from "./common.js"; // 引入新的 Schema
import { logger } from "../../utils/logger.js";
import path from 'path';


const __dirname = import.meta.dirname;

class MailboxApplication extends BaseApplication {

    constructor() {
        super('mailbox', '邮箱');
    }

    // 【重要】这里必须返回包含 profiles 数组的 Schema
    getConfigSchema() {
        return MailboxConfigSchema;
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