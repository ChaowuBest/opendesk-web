import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setRuntimeLocale } from '../../../locale/index.js';

/**
 * PlainPluginRegistry：从远端清单地址拉插件目录的 registry。
 *
 * 关键约定：
 * - 清单下载到本地 JSON 文件，有效期 5 分钟；
 * - getCatalog / getPluginCount 共用同一份清单，谁先调用谁触发下载；
 * - 逾期重试失败时直接复用本地已有文件，不让一次断网把市场清空；
 * - 本地调试清单（本地文件路径）跳过网络、不写缓存，改完立刻生效；
 * - categories 由清单自述，缺省表示该仓库不支持按分类显示。
 */

const { PlainPluginRegistry, DEFAULT_CATALOG_TTL_MS } =
    await import('../../../main/applications/pluginmgr/registry/plain.js');
const { createPluginRegistries, pluginCatalogCacheFile, customPluginChannelCacheFile } =
    await import('../../../main/applications/pluginmgr/registry/index.js');
const { PLUGIN_CATALOG_URL, PLUGIN_CATALOG_PATH_ENV, OFFICIAL_PLUGIN_CHANNEL_ID } =
    await import('../../../main/applications/pluginmgr/channels.js');

const CATALOG_URL = 'https://example.com/category/plugins.json';
const TTL_MS = DEFAULT_CATALOG_TTL_MS;

function entry(id: string, category?: string[]) {
    return {
        id,
        displayName: { 'zh-CN': id, 'en-US': id },
        version: '1.0.0',
        category,
        downloadUrl: `https://example.com/${id}-1.0.0.zip`
    };
}

const CATALOG = {
    categories: ['开发工具', '效率'],
    plugins: [entry('dev-plugin', ['开发工具']), entry('office-plugin', ['效率']), entry('uncategorized-plugin')]
};

const tempDirs: string[] = [];
let clockBase = 0;
let clockOffset = 0;
const clock = () => clockBase + clockOffset;

beforeEach(() => {
    setRuntimeLocale('zh-CN');
    clockBase = Date.now();
    clockOffset = 0;
});

afterEach(() => {
    setRuntimeLocale(null);
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeFetch(body: unknown, status = 200) {
    return jest.fn(async () => jsonResponse(body, status)) as unknown as typeof fetch & {
        mock: { calls: unknown[][] };
    };
}

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-market-'));
    tempDirs.push(dir);
    return dir;
}

function makeRegistry(options: { cacheFile?: string; fetchImpl?: typeof fetch; catalogUrl?: string } = {}) {
    return new PlainPluginRegistry(
        'test-market',
        { 'zh-CN': '测试市场', 'en-US': 'Test Market' },
        options.catalogUrl ?? CATALOG_URL,
        {
            cacheFile: options.cacheFile,
            fetchImpl: options.fetchImpl,
            now: clock
        }
    );
}

describe('PlainPluginRegistry', () => {
    test('loads the catalog once and shares it between catalog and count', async () => {
        const fetchImpl = makeFetch(CATALOG);
        const registry = makeRegistry({ fetchImpl });

        const all = await registry.getCatalog();
        expect(all.map((item) => item.id)).toEqual(['dev-plugin', 'office-plugin', 'uncategorized-plugin']);
        expect(registry.categories).toEqual(['开发工具', '效率']);
        expect(await registry.getPluginCount()).toBe(3);
        expect(fetchImpl.mock.calls).toHaveLength(1);
    });

    test('filters by category, and no categories means everything', async () => {
        const registry = makeRegistry({ fetchImpl: makeFetch(CATALOG) });

        expect((await registry.getCatalog({ categories: ['开发工具'] })).map((item) => item.id)).toEqual([
            'dev-plugin'
        ]);
        expect((await registry.getCatalog({ categories: ['效率'] })).map((item) => item.id)).toEqual(['office-plugin']);
        expect(await registry.getPluginCount({ categories: ['效率'] })).toBe(1);
        expect(await registry.getCatalog({ categories: [] })).toHaveLength(3);
    });

    test('pages the catalog with startAt / limit, and category filtering comes first', async () => {
        // 与 benchmark 的 getCatalog(startAt, limit) 同义：省略 limit = 取到末尾，
        // limit 0 = 不取，负数 startAt 夹到 0
        const registry = makeRegistry({ fetchImpl: makeFetch(CATALOG) });

        expect((await registry.getCatalog({ startAt: 1 })).map((item) => item.id)).toEqual([
            'office-plugin',
            'uncategorized-plugin'
        ]);
        expect((await registry.getCatalog({ startAt: 1, limit: 1 })).map((item) => item.id)).toEqual(['office-plugin']);
        expect(await registry.getCatalog({ startAt: 5 })).toEqual([]);
        expect(await registry.getCatalog({ limit: 0 })).toEqual([]);
        expect((await registry.getCatalog({ startAt: -3, limit: 1 })).map((item) => item.id)).toEqual(['dev-plugin']);
        // 先按分类收窄再切页：分页不应把分类过滤的结果削成跳着走的页
        expect(
            (await registry.getCatalog({ categories: ['开发工具', '效率'], limit: 1 })).map((item) => item.id)
        ).toEqual(['dev-plugin']);
    });

    test('treats a catalog without categories as not supporting classification', async () => {
        const registry = makeRegistry({
            fetchImpl: makeFetch({ plugins: [entry('solo')] })
        });

        expect(await registry.getPluginCount()).toBe(1);
        expect(registry.categories).toBeUndefined();
    });

    test('caches the catalog on disk and reuses it within the TTL', async () => {
        const cacheFile = path.join(tempDir(), 'market.json');
        const fetchImpl = makeFetch(CATALOG);
        const registry = makeRegistry({ cacheFile, fetchImpl });

        await registry.getCatalog();
        expect(fs.existsSync(cacheFile)).toBe(true);
        expect(fetchImpl.mock.calls).toHaveLength(1);

        // 新实例（模拟重启）在有效期内直接读缓存，不再发请求。
        // 时钟往前推一点：mtime 是真实时间，负年龄会被实现当成「时钟回拨」而不采信缓存。
        clockOffset = 1000;
        const restarted = makeRegistry({ cacheFile, fetchImpl });
        expect(await restarted.getPluginCount()).toBe(3);
        expect(fetchImpl.mock.calls).toHaveLength(1);

        // 过期后重新拉取
        clockOffset = TTL_MS + 1000;
        await restarted.getCatalog();
        expect(fetchImpl.mock.calls).toHaveLength(2);
    });

    test('falls back to the cached catalog when the network is down', async () => {
        const cacheFile = path.join(tempDir(), 'market.json');
        await makeRegistry({ cacheFile, fetchImpl: makeFetch(CATALOG) }).getCatalog();

        clockOffset = TTL_MS + 1000;
        const failing = jest.fn(async () => {
            throw new Error('offline');
        }) as unknown as typeof fetch;
        const registry = makeRegistry({ cacheFile, fetchImpl: failing });

        expect(await registry.getPluginCount()).toBe(3);
    });

    test('invalidate forces a refetch on the next call', async () => {
        const fetchImpl = makeFetch(CATALOG);
        const registry = makeRegistry({ fetchImpl });

        await registry.getCatalog();
        registry.invalidate();
        await registry.getCatalog();

        expect(fetchImpl.mock.calls).toHaveLength(2);
    });

    test('a manual refresh during an in-flight load fetches fresh data', async () => {
        // invalidate 撞上在途请求时不能复用它的结果：点「刷新」拿到的必须是新清单，
        // 而不是正在路上、按旧内容发出去的那一发
        let served: unknown = CATALOG;
        let releaseFirst: () => void = () => undefined;
        const firstRequest = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let markStarted: () => void = () => undefined;
        const firstFetchStarted = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const fetchImpl = jest.fn(async () => {
            if (fetchImpl.mock.calls.length === 1) {
                // 响应体在请求发出时就定型（快照）：放行后返回的仍是旧清单
                const snapshot = served;
                markStarted();
                await firstRequest;
                return jsonResponse(snapshot);
            }
            return jsonResponse(served);
        }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
        const registry = makeRegistry({ fetchImpl });

        const initial = registry.getCatalog();
        // 等第一发请求真正发出（快照已按旧清单定型）再改数据、手动刷新
        await firstFetchStarted;
        served = { plugins: [entry('fresh-plugin')] };
        registry.invalidate();
        const refreshedPromise = registry.getCatalog();
        // 放行第一发请求：修复后刷新会等它结束再强制重拉；修复前则直接复用它的旧结果
        releaseFirst();
        const refreshed = await refreshedPromise;
        await initial;

        expect(refreshed.map((item) => item.id)).toEqual(['fresh-plugin']);
    });

    test('reads a local catalog file every time and allows http download urls', async () => {
        const localFile = path.join(tempDir(), 'plugins.json');
        fs.writeFileSync(
            localFile,
            JSON.stringify({
                categories: ['本地'],
                plugins: [
                    {
                        id: 'local-plugin',
                        category: ['本地'],
                        downloadUrl: 'http://127.0.0.1:8080/plugins/local-plugin.zip'
                    }
                ]
            })
        );
        const registry = makeRegistry({ catalogUrl: localFile });

        expect((await registry.getCatalog()).map((item) => item.id)).toEqual(['local-plugin']);
        expect(registry.categories).toEqual(['本地']);

        // 改完立刻生效：本地清单不缓存
        fs.writeFileSync(
            localFile,
            JSON.stringify({ plugins: [{ id: 'second', downloadUrl: 'http://127.0.0.1:8080/p/second.zip' }] })
        );
        expect((await registry.getCatalog()).map((item) => item.id)).toEqual(['second']);
    });

    test('resolves relative download urls against the catalog url, also when read back from cache', async () => {
        const cacheFile = path.join(tempDir(), 'market.json');
        const fetchImpl = makeFetch({
            plugins: [{ id: 'relative-plugin', downloadUrl: 'plugins/relative-plugin.zip' }]
        });
        const registry = makeRegistry({ cacheFile, fetchImpl });

        expect((await registry.getCatalog())[0].downloadUrl).toBe(
            'https://example.com/category/plugins/relative-plugin.zip'
        );

        // 重启后（断网）走缓存：基准必须仍是清单地址，不能变成缓存文件所在目录
        clockOffset = 1000;
        const offline = jest.fn(async () => {
            throw new Error('offline');
        }) as unknown as typeof fetch;
        clockOffset = TTL_MS + 1000;
        const restarted = makeRegistry({ cacheFile, fetchImpl: offline });

        expect((await restarted.getCatalog())[0].downloadUrl).toBe(
            'https://example.com/category/plugins/relative-plugin.zip'
        );
    });

    test('surfaces an unreachable catalog as an error', async () => {
        const failing = jest.fn(async () => {
            throw new Error('offline');
        }) as unknown as typeof fetch;
        const registry = makeRegistry({ fetchImpl: failing });

        await expect(registry.getCatalog()).rejects.toThrow(/无法拉取插件清单/);
    });
});

describe('createPluginRegistries', () => {
    const originalEnv = process.env[PLUGIN_CATALOG_PATH_ENV];

    afterEach(() => {
        if (originalEnv === undefined) delete process.env[PLUGIN_CATALOG_PATH_ENV];
        else process.env[PLUGIN_CATALOG_PATH_ENV] = originalEnv;
    });

    test('builds only the enabled channels, official first', () => {
        const registries = createPluginRegistries({
            dataDirectory: tempDir(),
            channels: [
                {
                    id: 'community',
                    name: '社区市场',
                    url: 'https://community.example.com/plugins.json',
                    isEnabled: true
                },
                { id: 'disabled', name: 'Disabled', url: 'https://disabled.example.com/plugins.json', isEnabled: false }
            ]
        });

        expect(registries.map((registry) => registry.name)).toEqual([OFFICIAL_PLUGIN_CHANNEL_ID, 'community']);
    });

    test('skips the official marketplace when it is disabled', () => {
        const registries = createPluginRegistries({
            dataDirectory: tempDir(),
            channels: [{ id: OFFICIAL_PLUGIN_CHANNEL_ID, isEnabled: false }]
        });

        expect(registries).toEqual([]);
    });

    test('points the official marketplace at the env override when set', async () => {
        const localFile = path.join(tempDir(), 'plugins.json');
        fs.writeFileSync(
            localFile,
            JSON.stringify({
                categories: ['本地'],
                plugins: [{ id: 'from-env', category: ['本地'], downloadUrl: 'http://127.0.0.1:8080/p/from-env.zip' }]
            })
        );
        process.env[PLUGIN_CATALOG_PATH_ENV] = localFile;

        const [official] = createPluginRegistries({ dataDirectory: tempDir() });

        expect((official as InstanceType<typeof PlainPluginRegistry>).catalogUrl).toBe(localFile);
        expect((await official.getCatalog()).map((item) => item.id)).toEqual(['from-env']);
    });

    test('keeps the official catalog url from the constant, not from config', () => {
        const [official] = createPluginRegistries({
            dataDirectory: tempDir(),
            channels: [{ id: OFFICIAL_PLUGIN_CHANNEL_ID, url: 'https://evil.example.com/plugins.json' }]
        });

        expect((official as InstanceType<typeof PlainPluginRegistry>).catalogUrl).toBe(PLUGIN_CATALOG_URL);
    });
});

describe('catalog cache file names', () => {
    test('are namespaced per registry and per channel url', () => {
        const dir = tempDir();

        expect(pluginCatalogCacheFile(dir, 'my market')).toBe(path.join(dir, 'plugin-catalog-cache', 'my_market.json'));
        expect(customPluginChannelCacheFile(dir, 'channel-1', 'https://a.example.com/plugins.json')).not.toBe(
            customPluginChannelCacheFile(dir, 'channel-1', 'https://b.example.com/plugins.json')
        );
    });
});
