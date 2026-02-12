/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

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