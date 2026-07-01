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
import * as http from 'http';
import * as net from 'net';

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

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;

function captureProxyEnv(): Record<(typeof PROXY_ENV_KEYS)[number], string | undefined> {
    return Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
        (typeof PROXY_ENV_KEYS)[number],
        string | undefined
    >;
}

function restoreProxyEnv(snapshot: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>): void {
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

        test('CLI fetch 默认使用内置 fetch 搭配环境代理 dispatcher', async () => {
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

        test('fetch bypassProxy 强制直连，跳过 undici 全局代理 dispatcher', async () => {
            const { getGlobalDispatcher, setGlobalDispatcher, ProxyAgent } = await import('undici');
            const { CliPlatform } = await import('../../../platforms/cli');
            const originalDispatcher = getGlobalDispatcher();
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

            try {
                setGlobalDispatcher(new ProxyAgent({ uri: `http://127.0.0.1:${proxyPort}` }));

                const platform = new CliPlatform();
                const response = await platform.fetch(`http://127.0.0.1:${modelPort}/v1/models`, undefined, {
                    bypassProxy: true
                });

                await expect(response.text()).resolves.toBe('direct-ok');
                expect(proxyConnections).toBe(0);
            } finally {
                setGlobalDispatcher(originalDispatcher);
                await closeLocalTcpServer(modelServer);
                await closeLocalTcpServer(proxyServer);
            }
        });

        test('proxy fetch 使用原生 fetch，并对请求日志中的敏感信息脱敏', async () => {
            const { logger } = await import('../../../main/utils/logger');
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            const originalFetch = globalThis.fetch;
            const originalBodyPreviewFlag = process.env.OPENDESK_DEBUG_FETCH_BODY;
            const nativeFetch = jest.fn(async () => new Response('native-ok'));
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
            globalThis.fetch = nativeFetch as unknown as typeof fetch;
            delete process.env.OPENDESK_DEBUG_FETCH_BODY;

            try {
                const response = await fetchWithResolvedProxy(
                    'https://user:password@model.local/v1/chat/completions?token=url-secret&safe=ok',
                    {
                        method: 'POST',
                        headers: new Headers({
                            Authorization: 'Bearer test-key',
                            'X-Trace-Id': 'trace-123'
                        }),
                        body: JSON.stringify({ stream: true, input: 'body-secret' })
                    }
                );

                await expect(response.text()).resolves.toBe('native-ok');
                expect(nativeFetch).toHaveBeenCalledTimes(1);
                expect(nativeFetch.mock.calls[0][0]).toBe(
                    'https://user:password@model.local/v1/chat/completions?token=url-secret&safe=ok'
                );
                expect(nativeFetch.mock.calls[0][1]?.headers).toBeInstanceOf(Headers);
                const requestLog = infoSpy.mock.calls
                    .map((call) => String(call[0]))
                    .find((message) => message.includes('[proxy-fetch] fetch request'));
                expect(requestLog).toContain('"authorization":"<redacted>"');
                expect(requestLog).toContain('"x-trace-id":"trace-123"');
                expect(requestLog).toContain('https://redacted:redacted@model.local');
                expect(requestLog).toContain('token=redacted');
                expect(requestLog).toContain('safe=ok');
                expect(requestLog).not.toContain('Bearer test-key');
                expect(requestLog).not.toContain('url-secret');
                expect(requestLog).not.toContain('body-secret');
            } finally {
                globalThis.fetch = originalFetch;
                if (originalBodyPreviewFlag === undefined) {
                    delete process.env.OPENDESK_DEBUG_FETCH_BODY;
                } else {
                    process.env.OPENDESK_DEBUG_FETCH_BODY = originalBodyPreviewFlag;
                }
            }
        });

        test('proxy fetch 使用 dispatcher 时不混用 global fetch', async () => {
            const { fetchWithResolvedProxy } = await import('../../../platforms/proxy-fetch');
            const originalFetch = globalThis.fetch;
            const nativeFetch = jest.fn(async () => {
                throw new Error('global fetch should not be used when dispatcher is present');
            });
            const proxyRequests: string[] = [];
            const proxyServer = http.createServer((req, res) => {
                proxyRequests.push(`${req.method} ${req.url ?? ''}`);
                res.end('proxied-ok');
            });
            const proxyPort = await listenLocalServer(proxyServer);
            globalThis.fetch = nativeFetch as unknown as typeof fetch;

            try {
                const response = await fetchWithResolvedProxy('http://model.local/v1/models', undefined, {
                    proxyUrl: `http://127.0.0.1:${proxyPort}`
                });

                await expect(response.text()).resolves.toBe('proxied-ok');
                expect(nativeFetch).not.toHaveBeenCalled();
                expect(proxyRequests).toEqual(['GET http://model.local/v1/models']);
            } finally {
                globalThis.fetch = originalFetch;
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

        test('fetch 在无 parentPort 时抛出异常', async () => {
            const { WorkerPlatform } = await import('../../../platforms/worker');
            const platform = new WorkerPlatform();

            await expect(platform.fetch('https://example.com')).rejects.toThrow('parentPort is not available');
        });
    });

    describe('proxy.ts', () => {
        test('resolveProxyUrl 已移除 undici 依赖', async () => {
            const proxyModule = await import('../../../main/utils/proxy');
            expect(typeof proxyModule.resolveProxyUrl).toBe('function');

            const fs = await import('fs');
            const proxyPath = fileURLToPath(new URL('../../../main/utils/proxy.ts', import.meta.url));
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

    describe('undici 依赖隔离', () => {
        test('ElectronPlatform 必须保持 Chromium net/session fetch，不得导入 undici helper', async () => {
            const fs = await import('fs');
            const electronPath = fileURLToPath(new URL('../../../platforms/electron.ts', import.meta.url));
            const moduleSource = fs.readFileSync(electronPath, 'utf-8').replace(/\r\n/g, '\n');
            expect(moduleSource).not.toContain("from 'undici'");
            expect(moduleSource).not.toContain("from './proxy-fetch.js'");
            expect(moduleSource).toContain('do not replace this');
        });

        test('除平台 fetch 实现外不应有文件直接导入 undici', async () => {
            const fs = await import('fs');
            const path = await import('path');
            const srcDir = fileURLToPath(new URL('../../../', import.meta.url));
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
                        if (relativePath.startsWith('platforms/cli')) continue;
                        if (relativePath.startsWith('platforms/proxy-fetch')) continue;
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
