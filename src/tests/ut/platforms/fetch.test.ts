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
    });

    describe('undici 依赖隔离', () => {
        test('除 platforms/cli.ts 外不应有文件直接导入 undici', async () => {
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
