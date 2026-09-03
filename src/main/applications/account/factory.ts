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

import { AuthenticationError, OpenDeskClient } from '@bitclub.ai/opendesk-server-sdk';
import { getPlatform } from '../../../platforms/base.js';
import { Setting } from '../../utils/setting.js';
import { AccountConfigController, type AccountConfigRepository } from './config.js';
import { AccountRuntime } from './runtime.js';
import { AccountService } from './service.js';
import { AccountTokenStore } from './token-store.js';
import type { AccountClient, AccountConfig } from './types.js';

class SettingAccountConfigRepository implements AccountConfigRepository {
    get(): AccountConfig {
        return { ...Setting.getInstance().getData().account_config };
    }

    update(patch: Partial<AccountConfig>): AccountConfig {
        const setting = Setting.getInstance();
        const next = { ...setting.getData().account_config, ...patch };
        setting.setData({ ...setting.getData(), account_config: next });
        return { ...next };
    }
}

let runtime: AccountRuntime | undefined;

export function getAccountRuntime(): AccountRuntime {
    if (runtime) {
        return runtime;
    }
    const config = new AccountConfigController(new SettingAccountConfigRepository());
    const service = new AccountService({
        store: new AccountTokenStore(),
        getBaseUrl: (kind) => config.getBaseUrl(kind),
        clientFactory: (baseUrl): AccountClient =>
            new OpenDeskClient({
                baseUrl,
                fetch: (input, init) => getPlatform().fetch(input as string | URL, init)
            }),
        isAuthenticationError: (error) => error instanceof AuthenticationError
    });
    runtime = new AccountRuntime(service, config);
    return runtime;
}
