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

import type { AccountConfig } from './types.js';

export interface AccountConfigRepository {
    get(): AccountConfig;
    update(patch: Partial<AccountConfig>): AccountConfig;
}

export class AccountConfigController {
    constructor(private readonly repository: AccountConfigRepository) {}

    get(): AccountConfig {
        return this.repository.get();
    }

    configure(patch: Partial<AccountConfig>): AccountConfig {
        return this.repository.update(patch);
    }

    getBaseUrl(kind: 'personal' | 'enterprise'): string {
        const config = this.repository.get();
        return kind === 'enterprise' ? config.enterprise_base_url : config.default_base_url;
    }

    isAvailable(kind: 'personal' | 'enterprise'): boolean {
        return kind === 'personal' || this.getBaseUrl(kind).trim().length > 0;
    }

    isSetupComplete(): boolean {
        return this.repository.get().mode !== 'nologin';
    }
}
