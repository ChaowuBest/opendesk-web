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

import { AccountConfigController } from './config.js';
import { AccountService } from './service.js';

export class AccountRuntime {
    constructor(
        private readonly service: AccountService,
        readonly config: AccountConfigController
    ) {}

    /** 返回共享的账号服务；后端尚未注册时 init() 返回 false，后续调用会继续重试。 */
    getService(): AccountService {
        this.service.init();
        return this.service;
    }
}
