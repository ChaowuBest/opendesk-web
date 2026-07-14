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

import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { pipeline, Readable, Transform, type TransformCallback } from 'node:stream';
import * as tls from 'node:tls';
import * as zlib from 'node:zlib';
import { isHostInNoProxy } from '../main/utils/proxy.js';
import { logger } from '../main/utils/logger.js';

interface ResolvedProxyFetchOptions {
    proxyUrl?: string | null;
    useEnvironmentProxy?: boolean;
    bypassProxy?: boolean;
    skipTlsVerification?: boolean;
}

const FETCH_BODY_PREVIEW_CHARS = 2_000;
const FETCH_BODY_PREVIEW_ENV = 'OPENDESK_DEBUG_FETCH_BODY';
const DEFAULT_ACCEPT_ENCODING = 'gzip, deflate, br';
const MAX_REDIRECTS = 20;
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

type NativeRequestHeaders = HeadersInit | string[] | null | undefined;

interface NativeFetchOptions {
    proxyUrl?: string | null;
    skipTlsVerification?: boolean;
}

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

function shouldTunnelProxyRequest(targetUrl: string): boolean {
    try {
        const target = new URL(targetUrl);
        return target.protocol === 'https:';
    } catch {
        return true;
    }
}

function defaultPortForProtocol(protocol: string): number {
    return protocol === 'https:' ? 443 : 80;
}

function urlPort(url: URL): number {
    return url.port ? Number(url.port) : defaultPortForProtocol(url.protocol);
}

function formatHostPort(url: URL): string {
    const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
    return `${host}:${urlPort(url)}`;
}

function normalizeProxyUrl(proxyUrl: string): URL {
    const proxy = new URL(proxyUrl);
    if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
        throw new Error(`Unsupported proxy protocol: ${proxy.protocol}`);
    }
    return proxy;
}

function toOutgoingHeaders(headers: NativeRequestHeaders): http.OutgoingHttpHeaders {
    const result: http.OutgoingHttpHeaders = {};
    if (!headers) {
        return result;
    }
    if (Array.isArray(headers)) {
        if (headers.length > 0 && Array.isArray(headers[0])) {
            const headerEntries = headers as [string, string][];
            for (const [name, value] of headerEntries) {
                result[name] = value;
            }
            return result;
        }
        const rawHeaders = headers as string[];
        for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
            result[rawHeaders[index]] = rawHeaders[index + 1];
        }
        return result;
    }
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((value, name) => {
            result[name] = value;
        });
        return result;
    }
    for (const [name, value] of Object.entries(headers)) {
        result[name] = value;
    }
    return result;
}

function addProxyAuthorization(headers: http.OutgoingHttpHeaders, proxy: URL): void {
    if (!proxy.username && !proxy.password) {
        return;
    }
    const username = decodeURIComponent(proxy.username);
    const password = decodeURIComponent(proxy.password);
    headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function requestModuleForProtocol(protocol: string): typeof http | typeof https {
    return protocol === 'https:' ? https : http;
}

function ensureAcceptEncoding(headers: http.OutgoingHttpHeaders): void {
    const hasAcceptEncoding = Object.keys(headers).some((name) => name.toLowerCase() === 'accept-encoding');
    if (!hasAcceptEncoding) {
        headers['Accept-Encoding'] = DEFAULT_ACCEPT_ENCODING;
    }
}

function observeSocketErrors(socket: net.Socket, scope: string): void {
    socket.on('error', (error) => {
        logger.warn(`[proxy-fetch] ${scope} socket error: ${error.message}`);
    });
}

async function writeIterableBody(request: http.ClientRequest, body: AsyncIterable<Uint8Array>) {
    for await (const chunk of body) {
        if (!request.write(chunk)) {
            await new Promise<void>((resolve, reject) => {
                request.once('drain', resolve);
                request.once('error', reject);
            });
        }
    }
    request.end();
}

async function writeRequestBody(request: http.ClientRequest, body: BodyInit | null | undefined) {
    if (!body) {
        request.end();
        return;
    }
    try {
        if (typeof body === 'string') {
            request.end(body);
            return;
        }
        if (body instanceof URLSearchParams) {
            request.end(body.toString());
            return;
        }
        if (body instanceof ArrayBuffer) {
            request.end(Buffer.from(body));
            return;
        }
        if (ArrayBuffer.isView(body)) {
            request.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
            return;
        }
        if (typeof Blob !== 'undefined' && body instanceof Blob) {
            await writeIterableBody(request, body.stream() as unknown as AsyncIterable<Uint8Array>);
            return;
        }
        if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
            await writeIterableBody(request, body as unknown as AsyncIterable<Uint8Array>);
            return;
        }

        request.destroy(new Error('Unsupported request body type for native fetch transport'));
    } catch (error) {
        request.destroy(error instanceof Error ? error : new Error(String(error)));
    }
}

function responseHeadersFromRaw(rawHeaders: string[]): Headers {
    const headers = new Headers();
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
        headers.append(rawHeaders[index], rawHeaders[index + 1]);
    }
    return headers;
}

function isZlibWrappedDeflate(prefix: Buffer): boolean {
    if (prefix.length < 2) {
        return true;
    }
    const compressionMethodAndInfo = prefix[0];
    const flags = prefix[1];
    // Some servers send raw RFC 1951 data as "deflate". A valid RFC 1950 wrapper has this two-byte checksum.
    return (
        (compressionMethodAndInfo & 0x0f) === 8 &&
        compressionMethodAndInfo >> 4 <= 7 &&
        ((compressionMethodAndInfo << 8) + flags) % 31 === 0
    );
}

class AutoDeflateDecoder extends Transform {
    private decoder?: Transform;
    private prefix = Buffer.alloc(0);

    private initializeDecoder(prefix: Buffer): Transform {
        const decoder = isZlibWrappedDeflate(prefix) ? zlib.createInflate() : zlib.createInflateRaw();
        decoder.on('data', (chunk: Buffer) => {
            if (!this.push(chunk)) {
                decoder.pause();
            }
        });
        decoder.once('error', (error) => {
            this.destroy(error);
        });
        this.decoder = decoder;
        return decoder;
    }

    override _read(size: number): void {
        super._read(size);
        this.decoder?.resume();
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (this.decoder) {
            this.decoder.write(input, callback);
            return;
        }

        this.prefix = this.prefix.length === 0 ? input : Buffer.concat([this.prefix, input]);
        if (this.prefix.length < 2) {
            callback();
            return;
        }

        const prefix = this.prefix;
        this.prefix = Buffer.alloc(0);
        this.initializeDecoder(prefix).write(prefix, callback);
    }

    override _flush(callback: TransformCallback): void {
        if (this.decoder) {
            this.decoder.once('end', callback);
            this.decoder.end();
            return;
        }

        const prefix = this.prefix;
        this.prefix = Buffer.alloc(0);
        const decoder = this.initializeDecoder(prefix);
        decoder.once('end', callback);
        decoder.end(prefix);
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.decoder?.destroy();
        callback(error);
    }
}

function createContentDecoder(encoding: string): Transform | null {
    switch (encoding) {
        case 'gzip':
        case 'x-gzip':
            return zlib.createGunzip();
        case 'deflate':
        case 'x-deflate':
            return new AutoDeflateDecoder();
        case 'br':
            return zlib.createBrotliDecompress();
        default:
            return null;
    }
}

function observeResponseStreamErrors(response: http.IncomingMessage): void {
    response.on('error', (error) => {
        logger.warn(`[proxy-fetch] response stream error: ${error.message}`);
    });
}

function createDecodedResponseBody(response: http.IncomingMessage, headers: Headers): Readable {
    const contentEncoding = headers.get('content-encoding');
    if (!contentEncoding) {
        observeResponseStreamErrors(response);
        return response;
    }

    const encodings = contentEncoding
        .split(',')
        .map((encoding) => encoding.trim().toLowerCase())
        .filter((encoding) => encoding.length > 0 && encoding !== 'identity');
    if (encodings.length === 0) {
        observeResponseStreamErrors(response);
        return response;
    }

    const decoders: Transform[] = [];
    // Content-Encoding lists encodings in application order, so decoding must happen in reverse.
    for (const encoding of [...encodings].reverse()) {
        const decoder = createContentDecoder(encoding);
        if (!decoder) {
            observeResponseStreamErrors(response);
            return response;
        }
        decoders.push(decoder);
    }

    headers.delete('content-encoding');
    headers.delete('content-length');
    return pipeline([response, ...decoders], (error) => {
        if (error && error.code !== 'ABORT_ERR' && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            logger.warn(`[proxy-fetch] response decompression error: ${error.message}`);
        }
    }) as Readable;
}

function responseHasBody(requestMethod: string, status: number): boolean {
    return requestMethod.toUpperCase() !== 'HEAD' && status !== 204 && status !== 205 && status !== 304;
}

function responseFromIncomingMessage(response: http.IncomingMessage, requestMethod: string): Response {
    const status = response.statusCode ?? 0;
    const headers = responseHeadersFromRaw(response.rawHeaders);
    const hasBody = responseHasBody(requestMethod, status);
    if (!hasBody) {
        observeResponseStreamErrors(response);
    }
    const body = hasBody ? createDecodedResponseBody(response, headers) : null;
    return new Response(body ? (Readable.toWeb(body) as ReadableStream<Uint8Array>) : null, {
        status,
        statusText: response.statusMessage,
        headers
    });
}

function nativeFetchPlainRequest(
    targetUrl: URL,
    init: RequestInit | undefined,
    proxy: URL | null,
    options: NativeFetchOptions
): Promise<Response> {
    return new Promise((resolve, reject) => {
        const requestUrl = proxy ?? targetUrl;
        const requestModule = requestModuleForProtocol(requestUrl.protocol);
        const headers = toOutgoingHeaders(init?.headers as NativeRequestHeaders);
        ensureAcceptEncoding(headers);
        if (proxy) {
            headers.host ??= targetUrl.host;
            addProxyAuthorization(headers, proxy);
        }
        const request = requestModule.request(
            {
                protocol: requestUrl.protocol,
                hostname: requestUrl.hostname,
                port: urlPort(requestUrl),
                method: init?.method ?? 'GET',
                path: proxy ? targetUrl.href : targetUrl.pathname + targetUrl.search,
                headers,
                rejectUnauthorized: options.skipTlsVerification ? false : undefined,
                signal: init?.signal ?? undefined
            },
            (response) => {
                resolve(responseFromIncomingMessage(response, init?.method ?? 'GET'));
            }
        );
        request.on('error', reject);
        void writeRequestBody(request, init?.body);
    });
}

function nativeFetchOverSocket(
    targetUrl: URL,
    init: RequestInit | undefined,
    socket: net.Socket,
    options: NativeFetchOptions
): Promise<Response> {
    return new Promise((resolve, reject) => {
        const requestModule = requestModuleForProtocol(targetUrl.protocol);
        const headers = toOutgoingHeaders(init?.headers as NativeRequestHeaders);
        ensureAcceptEncoding(headers);
        const request = requestModule.request(
            {
                protocol: targetUrl.protocol,
                hostname: targetUrl.hostname,
                port: urlPort(targetUrl),
                method: init?.method ?? 'GET',
                path: targetUrl.pathname + targetUrl.search,
                headers,
                rejectUnauthorized: options.skipTlsVerification ? false : undefined,
                signal: init?.signal ?? undefined,
                createConnection: () => {
                    if (targetUrl.protocol === 'https:') {
                        const tlsSocket = tls.connect({
                            socket,
                            servername: targetUrl.hostname,
                            rejectUnauthorized: !options.skipTlsVerification
                        });
                        observeSocketErrors(tlsSocket, 'target TLS');
                        return tlsSocket;
                    }
                    return socket;
                }
            },
            (response) => {
                resolve(responseFromIncomingMessage(response, init?.method ?? 'GET'));
            }
        );
        request.on('error', reject);
        void writeRequestBody(request, init?.body);
    });
}

function nativeFetchProxyTunnelRequest(
    targetUrl: URL,
    init: RequestInit | undefined,
    proxy: URL,
    options: NativeFetchOptions
): Promise<Response> {
    return new Promise((resolve, reject) => {
        const proxyModule = requestModuleForProtocol(proxy.protocol);
        const connectHeaders: http.OutgoingHttpHeaders = {
            host: formatHostPort(targetUrl)
        };
        addProxyAuthorization(connectHeaders, proxy);
        const connectRequest = proxyModule.request({
            protocol: proxy.protocol,
            hostname: proxy.hostname,
            port: urlPort(proxy),
            method: 'CONNECT',
            path: formatHostPort(targetUrl),
            headers: connectHeaders,
            rejectUnauthorized: options.skipTlsVerification ? false : undefined,
            signal: init?.signal ?? undefined
        });
        connectRequest.on('connect', (response, socket, head) => {
            if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
                socket.destroy();
                reject(new Error(`Proxy CONNECT failed with status ${response.statusCode ?? 0}`));
                return;
            }
            if (head.length > 0) {
                socket.unshift(head);
            }
            observeSocketErrors(socket, 'proxy tunnel');
            nativeFetchOverSocket(targetUrl, init, socket, options).then(resolve, reject);
        });
        connectRequest.on('error', reject);
        connectRequest.end();
    });
}

function nativeFetchOnce(url: string, init: RequestInit | undefined, options: NativeFetchOptions): Promise<Response> {
    const targetUrl = new URL(url);
    const proxy = options.proxyUrl ? normalizeProxyUrl(options.proxyUrl) : null;
    if (proxy && shouldTunnelProxyRequest(targetUrl.href)) {
        return nativeFetchProxyTunnelRequest(targetUrl, init, proxy, options);
    }
    return nativeFetchPlainRequest(targetUrl, init, proxy, options);
}

function isRedirectStatus(status: number): boolean {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function filterRedirectHeaders(
    headers: HeadersInit | undefined,
    removeBodyHeaders: boolean,
    removeSensitiveHeaders: boolean
): HeadersInit | undefined {
    if (!headers) {
        return undefined;
    }

    const excluded = new Set<string>(['host']);
    if (removeBodyHeaders) {
        excluded.add('content-length');
        excluded.add('content-type');
        excluded.add('transfer-encoding');
    }
    if (removeSensitiveHeaders) {
        excluded.add('authorization');
        excluded.add('cookie');
        excluded.add('proxy-authorization');
    }
    const shouldKeep = (name: string) => !excluded.has(name.toLowerCase());

    if (Array.isArray(headers)) {
        return headers.filter(([name]) => shouldKeep(name));
    }
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        const filtered = new Headers(headers);
        for (const name of excluded) {
            filtered.delete(name);
        }
        return filtered;
    }
    return Object.fromEntries(Object.entries(headers).filter(([name]) => shouldKeep(name)));
}

function buildRedirectInit(init: RequestInit | undefined, status: number, fromUrl: URL, toUrl: URL): RequestInit {
    const method = (init?.method ?? 'GET').toUpperCase();
    const switchToGet = (status === 301 || status === 302) && method === 'POST';
    const switchToGetForSeeOther = status === 303 && method !== 'HEAD';
    const removeBody = switchToGet || switchToGetForSeeOther;
    const crossOrigin = fromUrl.origin !== toUrl.origin;

    if (!removeBody && typeof ReadableStream !== 'undefined' && init?.body instanceof ReadableStream) {
        throw new TypeError('Cannot follow redirect with a streaming request body');
    }

    return {
        ...init,
        method: removeBody ? 'GET' : method,
        body: removeBody ? undefined : init?.body,
        headers: filterRedirectHeaders(init?.headers, removeBody, crossOrigin)
    };
}

async function discardRedirectResponse(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch (error) {
        logger.warn(
            `[proxy-fetch] failed to discard redirect response: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

async function nativeFetchWithResolvedProxy(
    url: string,
    init: RequestInit | undefined,
    options: NativeFetchOptions
): Promise<Response> {
    let currentUrl = new URL(url);
    let currentInit = init;
    const redirectMode = init?.redirect ?? 'follow';

    for (let redirectCount = 0; ; redirectCount++) {
        const response = await nativeFetchOnce(currentUrl.href, currentInit, options);
        const location = response.headers.get('location');
        if (!isRedirectStatus(response.status) || !location) {
            return response;
        }
        if (redirectMode === 'manual') {
            return response;
        }

        await discardRedirectResponse(response);
        if (redirectMode === 'error') {
            throw new TypeError(`Redirect encountered for ${currentUrl.href}`);
        }
        if (redirectCount >= MAX_REDIRECTS - 1) {
            throw new TypeError(`Too many redirects for ${url}`);
        }

        const redirectUrl = new URL(location, currentUrl);
        currentInit = buildRedirectInit(currentInit, response.status, currentUrl, redirectUrl);
        currentUrl = redirectUrl;
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
    fetchOptions: RequestInit,
    options: ResolvedProxyFetchOptions,
    resolved: {
        bypassProxy: boolean;
        proxyUrl: string | null;
        useNativeTransport: boolean;
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
        transport: resolved.useNativeTransport ? 'node' : 'native',
        headers: {
            inputType: headerTypeName(init?.headers),
            fetchOptionsType: headerTypeName(fetchOptions.headers),
            values: headersToLogObject(fetchOptions.headers)
        },
        body: summarizeBody(fetchOptions.body)
    };
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
    const useNativeTransport = !!proxyUrl || !!options.bypassProxy || !!options.skipTlsVerification;
    const fetchOptions: RequestInit = { ...init };
    if (typeof globalThis.fetch !== 'function') {
        throw new Error('globalThis.fetch is not available; CLI model requests require Node.js 18 or later');
    }
    logger.info(
        `[proxy-fetch] fetch request ${JSON.stringify(
            buildFetchLogPayload(url, init, fetchOptions, options, {
                bypassProxy,
                proxyUrl,
                useNativeTransport
            })
        )}`
    );
    const startedAt = Date.now();
    try {
        const response = useNativeTransport
            ? await nativeFetchWithResolvedProxy(url, init, {
                  proxyUrl,
                  skipTlsVerification: !!options.skipTlsVerification
              })
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
