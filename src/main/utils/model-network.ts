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

import { getPlatform } from '../../platforms/base.js';
import { logger } from './logger.js';
import { isLoopbackUrl } from './proxy.js';

export interface ModelNetworkConfig {
    base_url: string;
    no_proxy?: boolean;
    no_ssl?: boolean;
}

export function applyModelNetworkConfig(model: ModelNetworkConfig): void {
    if (model.no_ssl && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        logger.info('no_ssl: SSL certificate verification disabled');
    }
}

export async function fetchModelUrl(
    model: ModelNetworkConfig,
    input: string | URL,
    init?: RequestInit
): Promise<Response> {
    applyModelNetworkConfig(model);
    return getPlatform().fetch(input, init, {
        forceEnvironmentProxy: true,
        bypassProxy: !!model.no_proxy || isLoopbackUrl(input instanceof URL ? input.href : input),
        skipTlsVerification: !!model.no_ssl
    });
}
