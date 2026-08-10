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

import { HuaweiAccountKit, HuaweiLoginResult } from '../common';
import { hasArkTSAdapter, EtsBridgeMethods, callArkTS } from './arkts';
import { logger } from '../../../main/utils/logger';

export class HarmonyOSHuaweiAccountKit implements HuaweiAccountKit {
    private loginInProgress = false;

    async available(): Promise<boolean> {
        return hasArkTSAdapter();
    }

    async startLogin(): Promise<void> {
        if (this.loginInProgress) {
            throw new Error('Huawei account login is already in progress');
        }
        this.loginInProgress = true;
        logger.info('Starting Huawei account login');
        await callArkTS<void>(EtsBridgeMethods.LOGIN_INIT, 'void');
    }

    async restoreLogin(): Promise<void> {
        if (!this.loginInProgress) {
            return;
        }
        await callArkTS<void>(EtsBridgeMethods.LOGIN_RESTORE, 'void');
    }

    async peekLogin(): Promise<HuaweiLoginResult | null> {
        if (!this.loginInProgress) {
            throw new Error('Huawei account login is not in progress');
        }
        const text = await callArkTS<string>(EtsBridgeMethods.LOGIN_PEEK, 'string');
        const result = JSON.parse(text) as { pending?: boolean } & Partial<HuaweiLoginResult>;
        if (result.pending) {
            return null;
        }
        this.loginInProgress = false;
        return {
            status: result.status ?? false,
            authCode: result.authCode ?? '',
            unionId: result.unionId ?? '',
            openId: result.openId ?? '',
            idToken: result.idToken ?? '',
            anonymousPhone: result.anonymousPhone ?? ''
        };
    }

    async closeLogin(): Promise<void> {
        await callArkTS<void>(EtsBridgeMethods.LOGIN_CLOSE, 'void');
        this.loginInProgress = false;
    }
}
