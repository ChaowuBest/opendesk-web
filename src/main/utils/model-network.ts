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

type ModelFetchInput = string | URL | Request;

function isRequestInput(input: ModelFetchInput): input is Request {
    return typeof Request !== 'undefined' && input instanceof Request;
}

function normalizeFetchUrl(input: ModelFetchInput): string {
    if (typeof input === 'string') {
        return input;
    }
    if (input instanceof URL) {
        return input.href;
    }
    return input.url;
}

function normalizeFetchInit(input: ModelFetchInput, init?: RequestInit): RequestInit | undefined {
    if (init || !isRequestInput(input)) {
        return init;
    }

    const requestInit: RequestInit = {
        method: input.method,
        headers: input.headers,
        signal: input.signal,
        redirect: input.redirect
    };

    if (input.body === null) {
        return requestInit;
    }

    // Node.js undici fetch requires `duplex: 'half'` when the body is a
    // ReadableStream, but other body types (string, FormData, Blob, etc.)
    // must not carry this property.
    if (typeof ReadableStream !== 'undefined' && input.body instanceof ReadableStream) {
        return {
            ...requestInit,
            body: input.body,
            duplex: 'half'
        } as RequestInit;
    }

    return {
        ...requestInit,
        body: input.body
    };
}

export function applyModelNetworkConfig(model: ModelNetworkConfig): void {
    if (model.no_ssl && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        logger.info('no_ssl: SSL certificate verification disabled');
    }
}

export async function fetchModelUrl(
    model: ModelNetworkConfig,
    input: ModelFetchInput,
    init?: RequestInit
): Promise<Response> {
    applyModelNetworkConfig(model);
    const url = normalizeFetchUrl(input);
    const requestInit = normalizeFetchInit(input, init);
    return getPlatform().fetch(url, requestInit, {
        forceEnvironmentProxy: true,
        bypassProxy: !!model.no_proxy || isLoopbackUrl(url) || isLoopbackUrl(model.base_url),
        skipTlsVerification: !!model.no_ssl
    });
}
