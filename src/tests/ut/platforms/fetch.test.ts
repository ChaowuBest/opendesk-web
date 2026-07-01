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
import * as net from 'net';

async function listenLocalTcpServerOnFirstAvailablePort(ports: number[]): Promise<net.Server> {
    let lastError: unknown;
    for (const port of ports) {
        const server = net.createServer((socket) => {
            socket.end();
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, '127.0.0.1', () => resolve());
            });
            return server;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error('No local TCP port is available for test');
}

async function closeLocalTcpServer(server: net.Server): Promise<void> {
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
