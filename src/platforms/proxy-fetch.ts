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

import { Agent, fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { isHostInNoProxy } from '../main/utils/proxy.js';

interface ResolvedProxyFetchOptions {
    proxyUrl?: string | null;
    bypassProxy?: boolean;
    skipTlsVerification?: boolean;
}

const dispatcherCache = new Map<string, Dispatcher>();

function getDispatcher(proxyUrl: string | null | undefined, skipTlsVerification: boolean): Dispatcher | undefined {
    if (proxyUrl) {
        const key = `proxy:${proxyUrl}:tls:${skipTlsVerification ? 'skip' : 'verify'}`;
        let dispatcher = dispatcherCache.get(key);
        if (!dispatcher) {
            dispatcher = new ProxyAgent({
                uri: proxyUrl,
                ...(skipTlsVerification
                    ? {
                          requestTls: { rejectUnauthorized: false },
                          proxyTls: { rejectUnauthorized: false }
                      }
                    : {})
            });
            dispatcherCache.set(key, dispatcher);
        }
        return dispatcher;
    }

    if (!skipTlsVerification) {
        return undefined;
    }

    const key = 'direct:tls:skip';
    let dispatcher = dispatcherCache.get(key);
    if (!dispatcher) {
        dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
        dispatcherCache.set(key, dispatcher);
    }
    return dispatcher;
}

export async function fetchWithResolvedProxy(
    input: string | URL,
    init?: RequestInit,
    options: ResolvedProxyFetchOptions = {}
): Promise<Response> {
    const url = input instanceof URL ? input.href : input;
    const proxyUrl = options.proxyUrl && !options.bypassProxy && !isHostInNoProxy(url) ? options.proxyUrl : null;
    const dispatcher = getDispatcher(proxyUrl, !!options.skipTlsVerification);
    const fetchOptions: RequestInit & { dispatcher?: Dispatcher } = { ...init };
    if (dispatcher) {
        fetchOptions.dispatcher = dispatcher;
    }
    return undiciFetch(url, fetchOptions as any) as unknown as Response;
}
