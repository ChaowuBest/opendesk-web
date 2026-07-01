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

import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { isHostInNoProxy } from '../main/utils/proxy.js';
import { logger } from '../main/utils/logger.js';

interface ResolvedProxyFetchOptions {
    proxyUrl?: string | null;
    useEnvironmentProxy?: boolean;
    bypassProxy?: boolean;
    skipTlsVerification?: boolean;
}

const dispatcherCache = new Map<string, Dispatcher>();
const FETCH_BODY_PREVIEW_CHARS = 2_000;
const FETCH_BODY_PREVIEW_ENV = 'OPENDESK_DEBUG_FETCH_BODY';
const REDACTED_HEADER_VALUE = '<redacted>';
const REDACTED_URL_VALUE = 'redacted';
const SENSITIVE_HEADER_NAMES = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'api-key',
    'openai-api-key',
    'anthropic-api-key'
]);
const SENSITIVE_QUERY_NAMES = new Set([
    'api_key',
    'apikey',
    'key',
    'token',
    'access_token',
    'auth_token',
    'authorization',
    'password',
    'secret',
    'signature'
]);

type FetchBodySummary =
    | { present: false }
    | {
          present: true;
          type: string;
          length?: number;
          byteLength?: number;
          size?: number;
          keys?: string[];
          preview?: string;
      };

function headerTypeName(headers: HeadersInit | undefined): string {
    if (!headers) {
        return 'none';
    }
    if (Array.isArray(headers)) {
        return 'array';
    }
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        return 'Headers';
    }
    return 'record';
}

function shouldRedactHeader(name: string): boolean {
    const normalized = name.toLowerCase();
    return SENSITIVE_HEADER_NAMES.has(normalized) || normalized.endsWith('-api-key');
}

function redactHeaderValue(name: string, value: string): string {
    return shouldRedactHeader(name) ? REDACTED_HEADER_VALUE : value;
}

function headersToLogObject(headers: HeadersInit | undefined): Record<string, string> | undefined {
    if (!headers) {
        return undefined;
    }
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers.map(([name, value]) => [name, redactHeaderValue(name, value)]));
    }
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        return Object.fromEntries(
            Array.from(headers.entries()).map(([name, value]) => [name, redactHeaderValue(name, value)])
        );
    }
    return Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, redactHeaderValue(name, String(value))])
    );
}

function isBodyPreviewEnabled(): boolean {
    return process.env[FETCH_BODY_PREVIEW_ENV] === '1';
}

function redactUrlForLog(value: string | null | undefined): string | null {
    if (!value) {
        return null;
    }

    try {
        const url = new URL(value);
        if (url.username) {
            url.username = REDACTED_URL_VALUE;
        }
        if (url.password) {
            url.password = REDACTED_URL_VALUE;
        }
        for (const name of Array.from(url.searchParams.keys())) {
            if (SENSITIVE_QUERY_NAMES.has(name.toLowerCase()) || name.toLowerCase().endsWith('_token')) {
                url.searchParams.set(name, REDACTED_URL_VALUE);
            }
        }
        return url.href;
    } catch {
        return value;
    }
}

function getEnv(name: string, lowercaseName: string): string | undefined {
    return process.env[lowercaseName] || process.env[name] || undefined;
}

function getEnvironmentProxyUrl(url: string): string | null {
    let protocol: string;
    try {
        protocol = new URL(url).protocol;
    } catch {
        return null;
    }

    const httpProxy = getEnv('HTTP_PROXY', 'http_proxy');
    const httpsProxy = getEnv('HTTPS_PROXY', 'https_proxy');
    if (protocol === 'http:') {
        return httpProxy ?? null;
    }
    if (protocol === 'https:') {
        return httpsProxy ?? httpProxy ?? null;
    }
    return null;
}

function shouldTunnelProxyRequest(targetUrl: string, proxyUrl: string): boolean {
    try {
        const target = new URL(targetUrl);
        const proxy = new URL(proxyUrl);
        return !(target.protocol === 'http:' && proxy.protocol === 'http:');
    } catch {
        return true;
    }
}

function summarizeBody(body: BodyInit | null | undefined): FetchBodySummary {
    if (body === undefined || body === null) {
        return { present: false };
    }

    if (typeof body === 'string') {
        return {
            present: true,
            type: 'string',
            length: body.length,
            ...(isBodyPreviewEnabled() ? { preview: body.slice(0, FETCH_BODY_PREVIEW_CHARS) } : {})
        };
    }

    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        const text = body.toString();
        return {
            present: true,
            type: 'URLSearchParams',
            length: text.length,
            ...(isBodyPreviewEnabled() ? { preview: text.slice(0, FETCH_BODY_PREVIEW_CHARS) } : {})
        };
    }

    if (typeof FormData !== 'undefined' && body instanceof FormData) {
        return {
            present: true,
            type: 'FormData',
            keys: Array.from(body.keys())
        };
    }

    if (typeof Blob !== 'undefined' && body instanceof Blob) {
        return {
            present: true,
            type: 'Blob',
            size: body.size
        };
    }

    if (body instanceof ArrayBuffer) {
        return {
            present: true,
            type: 'ArrayBuffer',
            byteLength: body.byteLength
        };
    }

    if (ArrayBuffer.isView(body)) {
        return {
            present: true,
            type: body.constructor.name,
            byteLength: body.byteLength
        };
    }

    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
        return {
            present: true,
            type: 'ReadableStream'
        };
    }

    return {
        present: true,
        type: Object.prototype.toString.call(body)
    };
}

function buildFetchLogPayload(
    url: string,
    init: RequestInit | undefined,
    fetchOptions: RequestInit & { dispatcher?: Dispatcher },
    options: ResolvedProxyFetchOptions,
    resolved: {
        bypassProxy: boolean;
        proxyUrl: string | null;
        dispatcher?: Dispatcher;
    }
): object {
    return {
        url: redactUrlForLog(url),
        method: fetchOptions.method ?? init?.method ?? 'GET',
        proxy: {
            requestedProxyUrl: redactUrlForLog(options.proxyUrl),
            useEnvironmentProxy: !!options.useEnvironmentProxy,
            resolvedProxyUrl: redactUrlForLog(resolved.proxyUrl),
            requestedBypassProxy: !!options.bypassProxy,
            resolvedBypassProxy: resolved.bypassProxy,
            skipTlsVerification: !!options.skipTlsVerification
        },
        dispatcher: {
            present: !!resolved.dispatcher,
            type: resolved.dispatcher?.constructor?.name
        },
        transport: 'native',
        headers: {
            inputType: headerTypeName(init?.headers),
            fetchOptionsType: headerTypeName(fetchOptions.headers),
            values: headersToLogObject(fetchOptions.headers)
        },
        body: summarizeBody(fetchOptions.body)
    };
}

function getDispatcher(
    url: string,
    proxyUrl: string | null | undefined,
    skipTlsVerification: boolean,
    forceDirect: boolean
): Dispatcher | undefined {
    if (proxyUrl) {
        const proxyTunnel = shouldTunnelProxyRequest(url, proxyUrl);
        const key = `proxy:${proxyUrl}:tunnel:${proxyTunnel ? 'yes' : 'no'}:tls:${skipTlsVerification ? 'skip' : 'verify'}`;
        let dispatcher = dispatcherCache.get(key);
        if (!dispatcher) {
            dispatcher = new ProxyAgent({
                uri: proxyUrl,
                proxyTunnel,
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

    if (!forceDirect && !skipTlsVerification) {
        return undefined;
    }

    const key = `direct:tls:${skipTlsVerification ? 'skip' : 'verify'}`;
    let dispatcher = dispatcherCache.get(key);
    if (!dispatcher) {
        dispatcher = skipTlsVerification ? new Agent({ connect: { rejectUnauthorized: false } }) : new Agent();
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
    const bypassProxy = !!options.bypassProxy || isHostInNoProxy(url);
    const proxyUrl =
        !bypassProxy && options.proxyUrl
            ? options.proxyUrl
            : !bypassProxy && options.useEnvironmentProxy
              ? getEnvironmentProxyUrl(url)
              : null;
    const dispatcher = getDispatcher(url, proxyUrl, !!options.skipTlsVerification, bypassProxy);
    const fetchOptions: RequestInit & { dispatcher?: Dispatcher } = { ...init };
    if (dispatcher) {
        fetchOptions.dispatcher = dispatcher;
    }
    if (typeof globalThis.fetch !== 'function') {
        throw new Error('globalThis.fetch is not available; CLI model requests require Node.js 18 or later');
    }
    logger.info(
        `[proxy-fetch] fetch request ${JSON.stringify(
            buildFetchLogPayload(url, init, fetchOptions, options, {
                bypassProxy,
                proxyUrl,
                dispatcher
            })
        )}`
    );
    const startedAt = Date.now();
    try {
        const response = dispatcher
            ? ((await undiciFetch(url, fetchOptions as Parameters<typeof undiciFetch>[1])) as unknown as Response)
            : await globalThis.fetch(url, fetchOptions);
        logger.info(
            `[proxy-fetch] fetch response ${JSON.stringify({
                url: redactUrlForLog(url),
                elapsedMs: Date.now() - startedAt,
                status: response.status,
                statusText: response.statusText,
                headers: headersToLogObject(response.headers)
            })}`
        );
        return response;
    } catch (error) {
        logger.warn(
            `[proxy-fetch] fetch error ${JSON.stringify({
                url: redactUrlForLog(url),
                elapsedMs: Date.now() - startedAt,
                error: error instanceof Error ? error.message : String(error)
            })}`
        );
        throw error;
    }
}
