import { BaseApplication } from "../base.js";
import { MailboxConfigSchema } from "./common.js"; // 引入新的 Schema
import { logger } from "../../utils/logger.js";
import MailboxWorker from "./service/worker";


class MailboxApplication extends BaseApplication {

    constructor() {
        super('mailbox', '邮箱');
    }

    static getWorkerClass() {
        return MailboxWorker;
    }

    // 【重要】这里必须返回包含 profiles 数组的 Schema
    static getConfigSchema() {
        return MailboxConfigSchema;
    }

    onConfigChanged() {
        logger.info(`mailbox application config changed`);
    }

}

export { MailboxApplication };