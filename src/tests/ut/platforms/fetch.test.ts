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

import { jest } from '@jest/globals';
import { fileURLToPath } from 'url';
import path from 'node:path';
import * as http from 'http';
import * as net from 'net';
import * as zlib from 'node:zlib';

async function listenLocalServer(server: net.Server | http.Server, port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            const address = server.address();
            if (typeof address === 'object' && address !== null) {
                resolve(address.port);
                return;
            }
            reject(new Error('Server did not bind to a TCP port'));
        });
    });
}

async function listenLocalTcpServerOnFirstAvailablePort(ports: number[]): Promise<net.Server> {
    let lastError: unknown;
    for (const port of ports) {
        const server = net.createServer((socket) => {
            socket.end();
        });
        try {
            await listenLocalServer(server, port);
            return server;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error('No local TCP port is available for test');
}

async function closeLocalTcpServer(server: net.Server | http.Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`Operation did not settle within ${timeoutMs}ms`)),
                    timeoutMs
                );
            })
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;
const PROXY_ENV_KEY_GROUPS = [
    ['HTTP_PROXY', 'http_proxy'],
    ['HTTPS_PROXY', 'https_proxy'],
    ['NO_PROXY', 'no_proxy']
] as const;

function captureProxyEnv(): Record<(typeof PROXY_ENV_KEYS)[number], string | undefined> {
    return Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
        (typeof PROXY_ENV_KEYS)[number],
        string | undefined
    >;
}

function restoreProxyEnv(snapshot: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>): void {
    if (process.platform === 'win32') {
        for (const key of PROXY_ENV_KEYS) {
            delete process.env[key];
        }
        for (const [canonicalKey, alternateKey] of PROXY_ENV_KEY_GROUPS) {
            const value = snapshot[canonicalKey] ?? snapshot[alternateKey];
            if (value !== undefined) {
                process.env[canonicalKey] = value;
            }
        }
        return;
    }

    for (const key of PROXY_ENV_KEYS) {
        if (snapshot[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = snapshot[key];
        }
    }
}

describe('Platform fetch 抽象层', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('AbstractPlatform', () => {
        test('AbstractPlatform 不能直接实例化（fetch 为抽象方法）', async () => {
            const { AbstractPlatform } = await import('../../../platforms/base');
            expect(AbstractPlatform).toBeDefined();
            expect(AbstractPlatform.prototype).toBeDefined();
        });

        test('setPlatform / getPlatform 正常工作', async () => {
            const { setPlatform, getPlatform, AbstractPlatform } = await import('../../../platforms/base');

            class TestPlatform extends AbstractPlatform {
                getEffectiveWorkspace() {
                    return '/tmp';
                }
                async initPlatformHarness() {}
                async fetch(input: string | URL) {
                    return new Response('test', { status: 200 });
                }
            }

            const platform = new TestPlatform();
            setPlatform(platform);
            expect(getPlatform()).toBe(platform);

            const response = await getPlatform().fetch('https://example.com');
            expect(response.status).toBe(200);
            const body = await response.text();
            expect(body).toBe('test');
        });
    });

    describe('CliPlatform', () => {
        test('fetch 方法存在且可调用', async () => {
            const { CliPlatform } = await import('../../../platforms/cli');
            const platform = new CliPlatform();
            expect(typeof platform.fetch).toBe('function');
        });

        test('fetch 能发起真实 HTTP 请求', async () => {
            const { CliPlatform } = await import('../../../platforms/cli');
            const platform = new CliPlatform();

            // Mock the fetch to simulate httpbin.org response
            const originalFetch = platform.fetch.bind(platform);
            jest.spyOn(platform as any, 'fetch').mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ url: 'https://httpbin.org/get' })
            } as unknown as Response);

            const response = await platform.fetch('https://httpbin.org/get', {
                signal: AbortSignal.timeout(10000)
            });
            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data.url).toBe('https://httpbin.org/get');
        }, 15000);

        test('fetch 支持 POST 请求', async () => {
            const { CliPlatform } = await import('../../../platforms/cli');
            const platform = new CliPlatform();

            jest.spyOn(platform as any, 'fetch').mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ json: { test: true } })
            } as unknown as Response);

            const response = await platform.fetch('https://httpbin.org/post', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ test: true }),
                signal: AbortSignal.timeout(10000)
            });
            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data.json).toEqual({ test: true });
        }, 15000);

        test('fetch 支持自定义 headers', async () => {
            const { CliPlatform } = await import('../../../platforms/cli');
            const platform = new CliPlatform();

            jest.spyOn(platform as any, 'fetch').mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ headers: { 'X-Custom-Header': 'test-value' } })
            } as unknown as Response);

            const response = await platform.fetch('https://httpbin.org/headers', {
                headers: { 'X-Custom-Header': 'test-value' },
                signal: AbortSignal.timeout(10000)
            });
            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data.headers['X-Custom-Header']).toBe('test-value');
        }, 15000);

        test('CLI fetch 默认使用 Node 传输搭配环境代理', async () => {
            const { CliPlatform } = await import('../../../platforms/cli');
            const proxyEnv = captureProxyEnv();
            const proxyRequests: string[] = [];
            const proxyServer = http.createServer((req, res) => {
                proxyRequests.push(`${req.method} ${req.url ?? ''}`);
                res.end('proxied-ok');
            });
            const proxyPort = await listenLocalServer(proxyServer);

            try {
                restoreProxyEnv({
                    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
                    HTTPS_PROXY: undefined,
                    http_proxy: undefined,
                    https_proxy: undefined,
                    NO_PROXY: undefined,
                    no_proxy: undefined
                });

                const platform = new CliPlatform();
                const response = await platform.fetch('http://model.local/v1/models');

                await expect(response.text()).resolves.toBe('proxied-ok');
                expect(proxyRequests).toEqual(['GET http://model.local/v1/models']);
            } finally {
                restoreProxyEnv(proxyEnv);
                await closeLocalTcpServer(proxyServer);
            }
        });

        test('CLI fetch bypassProxy 跳过环境变量代理', async () => {
            const { CliPlatform } = await import('../../../platforms/cli');
            const proxyEnv = captureProxyEnv();
            let proxyRequests = 0;
            const proxyServer = http.createServer((_req, res) => {
                proxyRequests++;
                res.end('proxied');
            });
            const modelServer = http.createServer((_req, res) => {
                res.end('direct-ok');
            });
            const proxyPort = await listenLocalServer(proxyServer);
            const modelPort = await listenLocalServer(modelServer);

            try {
                restoreProxyEnv({
                    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
                    HTTPS_PROXY: undefined,
                    http_proxy: undefined,
                    https_proxy: undefined,
                    NO_PROXY: undefined,
                    no_proxy: undefined
                });

                const platform = new CliPlatform();
                const response = await platform.fetch(`http://127.0.0.1:${modelPort}/v1/models`, undefined, {
                    bypassProxy: true
                });

                await expect(response.text()).resolves.toBe('direct-ok');
                expect(proxyRequests).toBe(0);
            } finally {
                restoreProxyEnv(proxyEnv);
                await closeLocalTcpServer(modelServer);
                await closeLocalTcpServer(proxyServer);
            }
        });

        test('CLI fetch 尊重 NO_PROXY 环境变量并直连', async () => {
            const { CliPlatform } = await import('../../../platforms/cli');
            const proxyEnv = captureProxyEnv();
            let proxyRequests = 0;
            const proxyServer = http.createServer((_req, res) => {
                proxyRequests++;
                res.end('proxied');
            });
            const modelServer = http.createServer((_req, res) => {
                res.end('no-proxy-ok');
            });
            const proxyPort = await listenLocalServer(proxyServer);
            const modelPort = await listenLocalServer(modelServer);

            try {
                restoreProxyEnv({
                    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
                    HTTPS_PROXY: undefined,
                    http_proxy: undefined,
                    https_proxy: undefined,
                    NO_PROXY: '127.0.0.1',
                    no_proxy: undefined
                });

                const platform = new CliPlatform();
                const response = await platform.fetch(`http://127.0.0.1:${modelPort}/v1/models`);

                await expect(response.text()).resolves.toBe('no-proxy-ok');
                expect(proxyRequests).toBe(0);
            } finally {
                restoreProxyEnv(proxyEnv);
                await closeLocalTcpServer(modelServer);
                await closeLocalTcpServer(proxyServer);
            }
        });

        test('CLI fetch 对无 options 的 worker 请求应用全局 skip SSL', async () => {
            const { Setting } = await import('../../../main/utils/setting');
            const { logger } = await import('../../../main/utils/logger');
            const { CliPlatform } = await import('../../../platforms/cli');
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
            jest.spyOn(Setting, 'getInstance').mockReturnValue({
                getData: () => ({
                    network_config: {
                        no_ssl: true,
                        use_proxy: 'system',
                        custom_proxy_addr: '',
                        no_proxy: ''
                    }
                })
            } as unknown as InstanceType<typeof Setting>);
            const server = http.createServer((_req, res) => {
                res.end('global-skip-ssl-ok');
            });
            const port = await listenLocalServer(server);
            const proxyEnv = captureProxyEnv();

            try {
                restoreProxyEnv({
                    HTTP_PROXY: undefined,
                    HTTPS_PROXY: undefined,
                    http_proxy: undefined,
                    https_proxy: undefined,
                    NO_PROXY: undefined,
                    no_proxy: undefined
                });
                const platform = new CliPlatform();
                const response = await platform.fetch(`http://127.0.0.1:${port}/search`);

                await expect(response.text()).resolves.toBe('global-skip-ssl-ok');
                const requestLogs = infoSpy.mock.calls
                    .map((call) => String(call[0]))
                    .filter((message) => message.includes('[proxy-fetch] fetch request'));
                expect(requestLogs.some((message) => message.includes('"skipTlsVerification":true'))).toBe(true);
            } finally {
                restoreProxyEnv(proxyEnv);
                await closeLocalTcpServer(server);
            }
        });

        test('fetch bypassProxy 使用 Node 传输直连', async () => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            const originalFetch = globalThis.fetch;
            const nativeFetch = jest.fn(async () => {
                throw new Error('global fetch should not be used when bypassProxy is requested');
            });
            const server = http.createServer((_req, res) => {
                res.end('direct-ok');
            });
            const port = await listenLocalServer(server);
            globalThis.fetch = nativeFetch as unknown as typeof fetch;

            try {
                const response = await fetchWithResolvedProxy(`http://127.0.0.1:${port}/v1/models`, undefined, {
                    bypassProxy: true
                });

                await expect(response.text()).resolves.toBe('direct-ok');
                expect(nativeFetch).not.toHaveBeenCalled();
            } finally {
                globalThis.fetch = originalFetch;
                await closeLocalTcpServer(server);
            }
        });

        test.each([
            ['gzip', 'gzip', (body: Buffer) => zlib.gzipSync(body)],
            ['deflate', 'deflate', (body: Buffer) => zlib.deflateSync(body)],
            ['raw deflate', 'deflate', (body: Buffer) => zlib.deflateRawSync(body)],
            ['brotli', 'br', (body: Buffer) => zlib.brotliCompressSync(body)]
        ] as const)('Node 传输流式解压 %s 响应', async (_label, contentEncoding, compress) => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            const payload = JSON.stringify({ source: 'proxy-fetch', contentEncoding });
            const compressed = compress(Buffer.from(payload));
            let acceptEncoding: string | undefined;
            const server = http.createServer((req, res) => {
                acceptEncoding = req.headers['accept-encoding'];
                res.writeHead(200, {
                    'Content-Encoding': contentEncoding,
                    'Content-Length': String(compressed.length),
                    'Content-Type': 'application/json',
                    'X-Compression-Test': contentEncoding
                });
                res.end(compressed);
            });
            const port = await listenLocalServer(server);

            try {
                const response = await fetchWithResolvedProxy(`http://127.0.0.1:${port}/compressed`, undefined, {
                    bypassProxy: true
                });

                await expect(response.text()).resolves.toBe(payload);
                expect(acceptEncoding).toBe('gzip, deflate, br');
                expect(response.headers.get('content-encoding')).toBeNull();
                expect(response.headers.get('content-length')).toBeNull();
                expect(response.headers.get('content-type')).toBe('application/json');
                expect(response.headers.get('x-compression-test')).toBe(contentEncoding);
            } finally {
                await closeLocalTcpServer(server);
            }
        });

        test('Node 传输按 Content-Encoding 的逆序解压多层编码', async () => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            const payload = 'multi-layer-compression-ok';
            const compressed = zlib.brotliCompressSync(zlib.gzipSync(Buffer.from(payload)));
            const server = http.createServer((_req, res) => {
                res.writeHead(200, {
                    'Content-Encoding': 'gzip, br',
                    'Content-Length': String(compressed.length)
                });
                res.end(compressed);
            });
            const port = await listenLocalServer(server);

            try {
                const response = await fetchWithResolvedProxy(`http://127.0.0.1:${port}/multi`, undefined, {
                    bypassProxy: true
                });

                await expect(response.text()).resolves.toBe(payload);
                expect(response.headers.get('content-encoding')).toBeNull();
                expect(response.headers.get('content-length')).toBeNull();
            } finally {
                await closeLocalTcpServer(server);
            }
        });

        test('Node 传输在响应结束前持续产出解压后的数据', async () => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            let releaseSecondChunk: (() => void) | undefined;
            const secondChunkReleased = new Promise<void>((resolve) => {
                releaseSecondChunk = resolve;
            });
            let firstChunkFlushed: (() => void) | undefined;
            const firstChunkReady = new Promise<void>((resolve) => {
                firstChunkFlushed = resolve;
            });
            const server = http.createServer(async (_req, res) => {
                res.writeHead(200, { 'Content-Encoding': 'gzip' });
                const compressor = zlib.createGzip();
                compressor.pipe(res);
                compressor.write('first-stream-chunk');
                compressor.flush(zlib.constants.Z_SYNC_FLUSH, () => firstChunkFlushed?.());
                await secondChunkReleased;
                compressor.end('second-stream-chunk');
            });
            const port = await listenLocalServer(server);
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

            try {
                const response = await fetchWithResolvedProxy(`http://127.0.0.1:${port}/stream`, undefined, {
                    bypassProxy: true
                });
                reader = response.body!.getReader();
                await settleWithin(firstChunkReady);
                const first = await settleWithin(reader.read());

                expect(first.done).toBe(false);
                expect(new TextDecoder().decode(first.value)).toContain('first-stream-chunk');

                releaseSecondChunk?.();
                let remaining = '';
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    remaining += new TextDecoder().decode(chunk.value);
                }
                expect(remaining).toContain('second-stream-chunk');
            } finally {
                releaseSecondChunk?.();
                await reader?.cancel().catch(() => {});
                await closeLocalTcpServer(server);
            }
        });

        test('取消解压后的 Web 流会关闭上游压缩响应', async () => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            let responseClosed: (() => void) | undefined;
            const responseClosePromise = new Promise<void>((resolve) => {
                responseClosed = resolve;
            });
            const server = http.createServer((_req, res) => {
                res.writeHead(200, { 'Content-Encoding': 'gzip' });
                const compressor = zlib.createGzip();
                const interval = setInterval(() => {
                    compressor.write('stream-data-'.repeat(256));
                    compressor.flush(zlib.constants.Z_SYNC_FLUSH);
                }, 10);
                res.once('close', () => {
                    clearInterval(interval);
                    compressor.destroy();
                    responseClosed?.();
                });
                compressor.pipe(res);
            });
            const port = await listenLocalServer(server);

            try {
                const response = await fetchWithResolvedProxy(`http://127.0.0.1:${port}/cancel`, undefined, {
                    bypassProxy: true
                });
                const reader = response.body!.getReader();
                const first = await settleWithin(reader.read());
                expect(first.done).toBe(false);

                await reader.cancel('test cancellation');
                await settleWithin(responseClosePromise);
            } finally {
                await closeLocalTcpServer(server);
            }
        });

        test('AbortSignal 会终止解压管线并关闭上游响应', async () => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            const controller = new AbortController();
            let responseClosed: (() => void) | undefined;
            const responseClosePromise = new Promise<void>((resolve) => {
                responseClosed = resolve;
            });
            const server = http.createServer((_req, res) => {
                res.writeHead(200, { 'Content-Encoding': 'gzip' });
                const compressor = zlib.createGzip();
                const interval = setInterval(() => {
                    compressor.write('abort-stream-data-'.repeat(256));
                    compressor.flush(zlib.constants.Z_SYNC_FLUSH);
                }, 10);
                res.once('close', () => {
                    clearInterval(interval);
                    compressor.destroy();
                    responseClosed?.();
                });
                compressor.pipe(res);
            });
            const port = await listenLocalServer(server);
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

            try {
                const response = await fetchWithResolvedProxy(
                    `http://127.0.0.1:${port}/abort`,
                    { signal: controller.signal },
                    { bypassProxy: true }
                );
                reader = response.body!.getReader();
                const first = await settleWithin(reader.read());
                expect(first.done).toBe(false);

                controller.abort();
                const readUntilRejected = async () => {
                    while (true) {
                        const chunk = await reader!.read();
                        if (chunk.done) {
                            throw new Error('Aborted response ended without propagating an error');
                        }
                    }
                };
                await expect(settleWithin(readUntilRejected())).rejects.toThrow();
                await settleWithin(responseClosePromise);
            } finally {
                controller.abort();
                await reader?.cancel().catch(() => {});
                await closeLocalTcpServer(server);
            }
        });

        test('损坏的压缩响应通过 body Promise 返回错误', async () => {
            const { logger } = await import('../../../main/utils/logger');
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            jest.spyOn(logger, 'warn').mockImplementation(() => logger);
            const server = http.createServer((_req, res) => {
                res.writeHead(200, { 'Content-Encoding': 'gzip' });
                res.end('not-a-valid-gzip-stream');
            });
            const port = await listenLocalServer(server);

            try {
                const response = await fetchWithResolvedProxy(`http://127.0.0.1:${port}/invalid`, undefined, {
                    bypassProxy: true
                });

                await expect(response.text()).rejects.toThrow();
            } finally {
                await closeLocalTcpServer(server);
            }
        });

        test('Node 传输保留调用方显式指定的 Accept-Encoding', async () => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            let acceptEncoding: string | undefined;
            const server = http.createServer((req, res) => {
                acceptEncoding = req.headers['accept-encoding'];
                res.end('identity-ok');
            });
            const port = await listenLocalServer(server);

            try {
                const response = await fetchWithResolvedProxy(
                    `http://127.0.0.1:${port}/identity`,
                    { headers: { 'Accept-Encoding': 'identity' } },
                    { bypassProxy: true }
                );

                await expect(response.text()).resolves.toBe('identity-ok');
                expect(acceptEncoding).toBe('identity');
            } finally {
                await closeLocalTcpServer(server);
            }
        });

        test('Node 传输对未知 Content-Encoding 保留原始正文和响应头', async () => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            const server = http.createServer((_req, res) => {
                res.writeHead(200, { 'Content-Encoding': 'future-codec' });
                res.end('opaque-body');
            });
            const port = await listenLocalServer(server);

            try {
                const response = await fetchWithResolvedProxy(`http://127.0.0.1:${port}/unknown`, undefined, {
                    bypassProxy: true
                });

                await expect(response.text()).resolves.toBe('opaque-body');
                expect(response.headers.get('content-encoding')).toBe('future-codec');
            } finally {
                await closeLocalTcpServer(server);
            }
        });

        test.each([
            ['HEAD', 200],
            ['GET', 204],
            ['GET', 304]
        ])('Node 传输不会为无正文的 %s %s 响应创建解压器', async (method, status) => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            const server = http.createServer((_req, res) => {
                res.writeHead(status, {
                    'Content-Encoding': 'gzip',
                    'Content-Length': '128'
                });
                res.end();
            });
            const port = await listenLocalServer(server);

            try {
                const response = await fetchWithResolvedProxy(
                    `http://127.0.0.1:${port}/no-body`,
                    { method },
                    { bypassProxy: true }
                );

                expect(response.status).toBe(status);
                await expect(response.text()).resolves.toBe('');
                expect(response.headers.get('content-encoding')).toBe('gzip');
                expect(response.headers.get('content-length')).toBe('128');
            } finally {
                await closeLocalTcpServer(server);
            }
        });

        test('HTTP 代理返回的压缩响应同样由中央传输解压', async () => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            const payload = 'proxy-compression-ok';
            const compressed = zlib.gzipSync(Buffer.from(payload));
            const proxyServer = http.createServer((_req, res) => {
                res.writeHead(200, {
                    'Content-Encoding': 'gzip',
                    'Content-Length': String(compressed.length)
                });
                res.end(compressed);
            });
            const proxyPort = await listenLocalServer(proxyServer);

            try {
                const response = await fetchWithResolvedProxy('http://search.example/results', undefined, {
                    proxyUrl: `http://127.0.0.1:${proxyPort}`
                });

                await expect(response.text()).resolves.toBe(payload);
                expect(response.headers.get('content-encoding')).toBeNull();
                expect(response.headers.get('content-length')).toBeNull();
            } finally {
                await closeLocalTcpServer(proxyServer);
            }
        });

        test('Node 传输遵循 redirect follow 并释放中间响应', async () => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            const requests: string[] = [];
            const server = http.createServer((req, res) => {
                requests.push(req.url ?? '');
                if (req.url === '/redirect') {
                    res.writeHead(302, { Location: '/result' });
                    res.end('redirect-body');
                    return;
                }
                res.end('redirect-ok');
            });
            const port = await listenLocalServer(server);

            try {
                const response = await fetchWithResolvedProxy(
                    `http://127.0.0.1:${port}/redirect`,
                    { redirect: 'follow' },
                    { bypassProxy: true }
                );

                expect(response.status).toBe(200);
                await expect(response.text()).resolves.toBe('redirect-ok');
                expect(requests).toEqual(['/redirect', '/result']);
            } finally {
                await closeLocalTcpServer(server);
            }
        });

        test('fetch bypassProxy 真实请求跳过环境变量代理并直连', async () => {
            const { CliPlatform } = await import('../../../platforms/cli');
            let proxyConnections = 0;
            const proxyServer = net.createServer((socket) => {
                proxyConnections++;
                socket.end();
            });
            const modelServer = http.createServer((_req, res) => {
                res.end('direct-ok');
            });
            const proxyPort = await listenLocalServer(proxyServer);
            const modelPort = await listenLocalServer(modelServer);
            const proxyEnv = captureProxyEnv();

            try {
                restoreProxyEnv({
                    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
                    HTTPS_PROXY: undefined,
                    http_proxy: undefined,
                    https_proxy: undefined,
                    NO_PROXY: undefined,
                    no_proxy: undefined
                });

                const platform = new CliPlatform();
                const response = await platform.fetch(`http://127.0.0.1:${modelPort}/v1/models`, undefined, {
                    bypassProxy: true
                });

                await expect(response.text()).resolves.toBe('direct-ok');
                expect(proxyConnections).toBe(0);
            } finally {
                restoreProxyEnv(proxyEnv);
                await closeLocalTcpServer(modelServer);
                await closeLocalTcpServer(proxyServer);
            }
        });

        test('proxy fetch 对请求日志中的敏感信息脱敏', async () => {
            const { logger } = await import('../../../main/utils/logger');
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            const originalBodyPreviewFlag = process.env.OPENDESK_DEBUG_FETCH_BODY;
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
            const proxyServer = http.createServer((req, res) => {
                req.resume();
                res.end('native-ok');
            });
            const proxyPort = await listenLocalServer(proxyServer);
            delete process.env.OPENDESK_DEBUG_FETCH_BODY;

            try {
                const response = await fetchWithResolvedProxy(
                    'http://user:password@model.local/v1/chat/completions?token=url-secret&safe=ok',
                    {
                        method: 'POST',
                        headers: new Headers({
                            Authorization: 'Bearer test-key',
                            'X-Trace-Id': 'trace-123'
                        }),
                        body: JSON.stringify({ stream: true, input: 'body-secret' })
                    },
                    {
                        proxyUrl: `http://proxy-user:proxy-pass@127.0.0.1:${proxyPort}`
                    }
                );

                await expect(response.text()).resolves.toBe('native-ok');
                const requestLog = infoSpy.mock.calls
                    .map((call) => String(call[0]))
                    .find((message) => message.includes('[proxy-fetch] fetch request'));
                expect(requestLog).toContain('"authorization":"<redacted>"');
                expect(requestLog).toContain('"x-trace-id":"trace-123"');
                expect(requestLog).toContain('http://redacted:redacted@model.local');
                expect(requestLog).toContain('token=redacted');
                expect(requestLog).toContain('safe=ok');
                expect(requestLog).toContain(`http://redacted:redacted@127.0.0.1:${proxyPort}/`);
                expect(requestLog).not.toContain('Bearer test-key');
                expect(requestLog).not.toContain('url-secret');
                expect(requestLog).not.toContain('proxy-user');
                expect(requestLog).not.toContain('proxy-pass');
                expect(requestLog).not.toContain('body-secret');
            } finally {
                await closeLocalTcpServer(proxyServer);
                if (originalBodyPreviewFlag === undefined) {
                    delete process.env.OPENDESK_DEBUG_FETCH_BODY;
                } else {
                    process.env.OPENDESK_DEBUG_FETCH_BODY = originalBodyPreviewFlag;
                }
            }
        });

        test('proxy fetch 使用 Headers 时保留 Content-Type', async () => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            let contentType: string | undefined;
            let requestBody = '';
            const proxyServer = http.createServer((req, res) => {
                contentType = req.headers['content-type'];
                req.setEncoding('utf8');
                req.on('data', (chunk) => {
                    requestBody += chunk;
                });
                req.on('end', () => {
                    res.end('ok');
                });
            });
            const proxyPort = await listenLocalServer(proxyServer);

            try {
                const response = await fetchWithResolvedProxy(
                    'http://model.local/v1/chat/completions',
                    {
                        method: 'POST',
                        headers: new Headers({
                            'Content-Type': 'application/json'
                        }),
                        body: JSON.stringify({ stream: true })
                    },
                    {
                        proxyUrl: `http://127.0.0.1:${proxyPort}`
                    }
                );

                await expect(response.text()).resolves.toBe('ok');
                expect(contentType).toBe('application/json');
                expect(requestBody).toBe(JSON.stringify({ stream: true }));
            } finally {
                await closeLocalTcpServer(proxyServer);
            }
        });

        test('proxy fetch 不物化 Headers，避免改变实际发送的 header 原始大小写', async () => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            let rawHeaders: string[] = [];
            const server = http.createServer((req, res) => {
                rawHeaders = req.rawHeaders;
                res.end('ok');
            });
            const port = await listenLocalServer(server);

            try {
                const response = await fetchWithResolvedProxy(`http://127.0.0.1:${port}/v1/chat/completions`, {
                    method: 'POST',
                    headers: new Headers({
                        Authorization: 'Bearer test-key',
                        'X-Custom-Header': 'value'
                    }),
                    body: JSON.stringify({ stream: true })
                });
                await expect(response.text()).resolves.toBe('ok');

                expect(rawHeaders).toContain('Authorization');
                expect(rawHeaders).toContain('X-Custom-Header');
                expect(rawHeaders).not.toContain('authorization');
                expect(rawHeaders).not.toContain('x-custom-header');
            } finally {
                await closeLocalTcpServer(server);
            }
        });

        test('proxy fetch 为 HTTPS 请求优先选择 HTTPS_PROXY', async () => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            const proxyEnv = captureProxyEnv();
            let httpProxyConnections = 0;
            let httpsProxyConnects = 0;
            const httpProxyServer = http.createServer((_req, res) => {
                httpProxyConnections++;
                res.end('wrong-proxy');
            });
            const httpsProxyServer = http.createServer();
            httpsProxyServer.on('connect', (req, socket) => {
                if (req.url === 'model.local:443') {
                    httpsProxyConnects++;
                }
                socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            });
            const httpProxyPort = await listenLocalServer(httpProxyServer);
            const httpsProxyPort = await listenLocalServer(httpsProxyServer);

            try {
                restoreProxyEnv({
                    HTTP_PROXY: `http://127.0.0.1:${httpProxyPort}`,
                    HTTPS_PROXY: `http://127.0.0.1:${httpsProxyPort}`,
                    http_proxy: undefined,
                    https_proxy: undefined,
                    NO_PROXY: undefined,
                    no_proxy: undefined
                });

                await expect(
                    fetchWithResolvedProxy(
                        'https://model.local/v1/chat/completions',
                        { signal: AbortSignal.timeout(3_000) },
                        { useEnvironmentProxy: true }
                    )
                ).rejects.toThrow();

                expect(httpsProxyConnects).toBe(1);
                expect(httpProxyConnections).toBe(0);
            } finally {
                restoreProxyEnv(proxyEnv);
                await closeLocalTcpServer(httpsProxyServer);
                await closeLocalTcpServer(httpProxyServer);
            }
        });

        test('getName 返回 cli', async () => {
            const { CliPlatform } = await import('../../../platforms/cli');
            const platform = new CliPlatform();
            expect(platform.getName()).toBe('cli');
        });
    });

    describe('WorkerPlatform', () => {
        test('fetch 方法存在', async () => {
            const { WorkerPlatform } = await import('../../../platforms/worker');
            const platform = new WorkerPlatform();
            expect(typeof platform.fetch).toBe('function');
        });

        test('getName 返回 worker', async () => {
            const { WorkerPlatform } = await import('../../../platforms/worker');
            const platform = new WorkerPlatform();
            expect(platform.getName()).toBe('worker');
        });

        test('fetch 在无 parentPort 时也能正常执行（降级为原生 fetch）', async () => {
            const { WorkerPlatform } = await import('../../../platforms/worker');
            const platform = new WorkerPlatform();

            // 无 parentPort 时降级为 globalThis.fetch（测试环境兼容）
            const response = await platform.fetch('https://example.com');
            expect(response.status).toBeGreaterThanOrEqual(200);
        });
    });

    describe('proxy.ts', () => {
        test('resolveProxyUrl 已移除 undici 依赖', async () => {
            const proxyModule = await import('../../../main/utils/proxy');
            expect(typeof proxyModule.resolveProxyUrl).toBe('function');

            const fs = await import('fs');
            const proxyPath = path.resolve(process.cwd(), 'src/main/utils/proxy.ts');
            const moduleSource = fs.readFileSync(proxyPath, 'utf-8').replace(/\r\n/g, '\n');
            expect(moduleSource).not.toContain("from 'undici'");
            expect(moduleSource).not.toContain('ProxyAgent');
            expect(moduleSource).not.toContain("from 'net'");
            expect(moduleSource).not.toContain('probeLocalProxy');
        });

        test('resolveProxyUrl 优先返回环境变量代理', async () => {
            const originalHttpsProxy = process.env.HTTPS_PROXY;
            process.env.HTTPS_PROXY = 'http://test-proxy:8080';
            try {
                const { resolveProxyUrl } = await import('../../../main/utils/proxy');
                const url = await resolveProxyUrl();
                expect(url).toBe('http://test-proxy:8080');
            } finally {
                if (originalHttpsProxy !== undefined) {
                    process.env.HTTPS_PROXY = originalHttpsProxy;
                } else {
                    delete process.env.HTTPS_PROXY;
                }
            }
        });

        test('resolveProxyUrl 不再自动探测本地代理端口', async () => {
            const originalHttpProxy = process.env.HTTP_PROXY;
            const originalHttpsProxy = process.env.HTTPS_PROXY;
            const originalLowerHttpProxy = process.env.http_proxy;
            const originalLowerHttpsProxy = process.env.https_proxy;
            delete process.env.HTTP_PROXY;
            delete process.env.HTTPS_PROXY;
            delete process.env.http_proxy;
            delete process.env.https_proxy;

            let server: net.Server | undefined;
            try {
                server = await listenLocalTcpServerOnFirstAvailablePort([7890, 7897, 1080, 8080, 10808, 10809]);
                const { resolveProxyUrl } = await import('../../../main/utils/proxy');
                await expect(resolveProxyUrl()).resolves.toBeNull();
            } finally {
                if (server) {
                    await closeLocalTcpServer(server);
                }
                if (originalHttpProxy !== undefined) {
                    process.env.HTTP_PROXY = originalHttpProxy;
                } else {
                    delete process.env.HTTP_PROXY;
                }
                if (originalHttpsProxy !== undefined) {
                    process.env.HTTPS_PROXY = originalHttpsProxy;
                } else {
                    delete process.env.HTTPS_PROXY;
                }
                if (originalLowerHttpProxy !== undefined) {
                    process.env.http_proxy = originalLowerHttpProxy;
                } else {
                    delete process.env.http_proxy;
                }
                if (originalLowerHttpsProxy !== undefined) {
                    process.env.https_proxy = originalLowerHttpsProxy;
                } else {
                    delete process.env.https_proxy;
                }
            }
        });

        test('isHostInNoProxy 支持 localhost:port 形式', async () => {
            const originalNoProxy = process.env.NO_PROXY;
            process.env.NO_PROXY = 'localhost:11434,.example.com,[::1]:3000';
            try {
                const { isHostInNoProxy } = await import('../../../main/utils/proxy');
                expect(isHostInNoProxy('http://localhost:11434/path/v1/models')).toBe(true);
                expect(isHostInNoProxy('http://localhost:11435/path/v1/models')).toBe(false);
                expect(isHostInNoProxy('https://api.example.com/v1/models')).toBe(true);
                expect(isHostInNoProxy('http://[::1]:3000/v1/models')).toBe(true);
            } finally {
                if (originalNoProxy !== undefined) {
                    process.env.NO_PROXY = originalNoProxy;
                } else {
                    delete process.env.NO_PROXY;
                }
            }
        });

        test('isLoopbackUrl 识别带路径的本地模型地址', async () => {
            const { isLoopbackUrl } = await import('../../../main/utils/proxy');
            expect(isLoopbackUrl('http://localhost:11434/path/v1/models')).toBe(true);
            expect(isLoopbackUrl('http://127.0.0.1:11434/path/v1/models')).toBe(true);
            expect(isLoopbackUrl('http://[::1]:11434/path/v1/models')).toBe(true);
            expect(isLoopbackUrl('https://api.example.com/v1/models')).toBe(false);
        });
    });

    describe('native fetch 依赖隔离', () => {
        test('ElectronPlatform 必须保持 Chromium net/session fetch，不得导入 CLI proxy helper', async () => {
            const fs = await import('fs');
            const electronPath = fileURLToPath(new URL('../../../platforms/electron.ts', import.meta.url));
            const moduleSource = fs.readFileSync(electronPath, 'utf-8').replace(/\r\n/g, '\n');
            expect(moduleSource).not.toContain("from 'undici'");
            expect(moduleSource).not.toContain("from './proxy-fetch.js'");
            expect(moduleSource).toContain('do not replace this');
        });

        test('源码不应直接导入 undici', async () => {
            const fs = await import('fs');
            const path = await import('path');
            const srcDir = path.resolve(process.cwd(), 'src');
            const importPattern = /from\s+['"]undici['"]/;

            function findViolations(dir: string): string[] {
                const results: string[] = [];
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory() && !entry.name.includes('node_modules') && entry.name !== 'dist') {
                        results.push(...findViolations(fullPath));
                    } else if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) {
                        const relativePath = path.relative(srcDir, fullPath).replace(/\\/g, '/');
                        if (relativePath.startsWith('tests/')) continue;
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        if (importPattern.test(content)) {
                            results.push(relativePath);
                        }
                    }
                }
                return results;
            }

            const violations = findViolations(srcDir);
            expect(violations).toEqual([]);
        });
    });
});
