import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setRuntimeLocale } from '../../../locale/index.js';

/**
 * 测评集清单不再内置在代码里：
 * - 默认请求线上 benchmarks.json，同一进程内 5 分钟复用内存缓存（手动刷新可绕过）；
 * - OPENDESK_BENCHMARK_CATEGORY 指向本地文件时跳过网络，方便调试；
 * - 单条清单项写坏只跳过它，整份清单都用不了才报错并回退到缓存。
 */

const {
    BENCHMARK_CATALOG_URL,
    BENCHMARK_CATALOG_PATH_ENV,
    loadCatalogDatasets,
    findCatalogDataset,
    parseCatalogDocument,
    resetCatalogCache
} = await import('../../../main/applications/benchmark/catalog.js');

const ENTRY = {
    id: 'workbuddy-bench',
    name: 'WorkBuddy Bench',
    description: 'fixture dataset',
    homepage: 'https://example.com',
    version: '0.1',
    downloadUrl: 'https://example.com/workbuddy-bench-0.1.zip',
    tracks: [
        { id: 'office', name: 'Office' },
        { id: 'code', name: 'Code' }
    ]
};

const originalEnv = process.env[BENCHMARK_CATALOG_PATH_ENV];
const tempDirs: string[] = [];

beforeEach(() => {
    setRuntimeLocale('zh-CN');
    resetCatalogCache();
    delete process.env[BENCHMARK_CATALOG_PATH_ENV];
});

afterEach(() => {
    setRuntimeLocale(null);
    resetCatalogCache();
    if (originalEnv === undefined) delete process.env[BENCHMARK_CATALOG_PATH_ENV];
    else process.env[BENCHMARK_CATALOG_PATH_ENV] = originalEnv;
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}

function makeFetch(body: unknown, status = 200) {
    return jest.fn(async () => jsonResponse(body, status)) as unknown as typeof fetch & {
        mock: { calls: unknown[][] };
    };
}

function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function writeLocalCatalog(content: string | object): string {
    const file = path.join(tempDir('benchmark-catalog-'), 'benchmark.json');
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
}

describe('loadCatalogDatasets', () => {
    test('默认从官网静态地址拉取清单并解析', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        const entries = await loadCatalogDatasets({ fetchImpl });

        expect(fetchImpl.mock.calls).toHaveLength(1);
        expect(fetchImpl.mock.calls[0][0]).toBe(BENCHMARK_CATALOG_URL);
        expect(BENCHMARK_CATALOG_URL).toBe('https://opendesk.matrix.openharmony.cn/static/categories/benchmarks.json');
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('workbuddy-bench');
        expect(entries[0].name).toBe('WorkBuddy Bench');
        expect(entries[0].version).toBe('0.1');
        expect(entries[0].downloadUrl).toBe('https://example.com/workbuddy-bench-0.1.zip');
        expect(entries[0].tracks.map((track) => track.id)).toEqual(['office', 'code']);
    });

    test('内存缓存有效期内复用结果，不再重复请求', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        await loadCatalogDatasets({ fetchImpl });
        await loadCatalogDatasets({ fetchImpl });

        expect(fetchImpl.mock.calls).toHaveLength(1);
    });

    test('forceRefresh 跳过内存缓存，重新拉取线上清单', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        await loadCatalogDatasets({ fetchImpl });
        await loadCatalogDatasets({ fetchImpl, forceRefresh: true });

        expect(fetchImpl.mock.calls).toHaveLength(2);
    });

    test('内存缓存过期后重新拉取', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        await loadCatalogDatasets({ fetchImpl, memoryTtlMs: 0 });
        await loadCatalogDatasets({ fetchImpl, memoryTtlMs: 0 });

        expect(fetchImpl.mock.calls).toHaveLength(2);
    });

    test('并发调用只发一次网络请求', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        const [first, second] = await Promise.all([
            loadCatalogDatasets({ fetchImpl }),
            loadCatalogDatasets({ fetchImpl })
        ]);

        expect(fetchImpl.mock.calls).toHaveLength(1);
        expect(first).toEqual(second);
    });

    test('改返回值不会污染内存缓存', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        const entries = await loadCatalogDatasets({ fetchImpl });
        entries[0].name = 'mutated';
        entries[0].tracks.length = 0;

        const again = await loadCatalogDatasets({ fetchImpl });
        expect(again[0].name).toBe('WorkBuddy Bench');
        expect(again[0].tracks).toHaveLength(2);
    });

    test('HTTP 状态异常时报出地址与状态码', async () => {
        const fetchImpl = makeFetch({ error: 'boom' }, 503);
        await expect(loadCatalogDatasets({ fetchImpl })).rejects.toThrow(/503/);
        await expect(loadCatalogDatasets({ fetchImpl })).rejects.toThrow(/benchmarks\.json/);
    });

    test('响应不是 JSON 时报拉取失败', async () => {
        const fetchImpl = jest.fn(async () => new Response('<html>oops</html>')) as unknown as typeof fetch;
        await expect(loadCatalogDatasets({ fetchImpl })).rejects.toThrow(/获取测评集清单失败/);
    });

    test('顶层不是数组时报清单格式错误', async () => {
        const fetchImpl = makeFetch({ datasets: [ENTRY] });
        await expect(loadCatalogDatasets({ fetchImpl })).rejects.toThrow(/应为测评集数组/);
    });

    test('清单项缺少 downloadUrl 时报错', async () => {
        const fetchImpl = makeFetch([{ ...ENTRY, downloadUrl: '' }]);
        await expect(loadCatalogDatasets({ fetchImpl })).rejects.toThrow(/downloadUrl/);
    });

    test('downloadUrl 不是 http(s) 时报错', async () => {
        const fetchImpl = makeFetch([{ ...ENTRY, downloadUrl: 'file:///tmp/workbuddy.zip' }]);
        await expect(loadCatalogDatasets({ fetchImpl })).rejects.toThrow(/downloadUrl/);
    });

    test('线上清单不接受明文 http 下载地址', async () => {
        const fetchImpl = makeFetch([{ ...ENTRY, downloadUrl: 'http://example.com/workbuddy-bench-0.1.zip' }]);
        await expect(loadCatalogDatasets({ fetchImpl })).rejects.toThrow(/downloadUrl/);
    });

    test('清单项缺少 name 时按 dataset.json 的规则报错并带上序号', async () => {
        const fetchImpl = makeFetch([{ ...ENTRY, name: '  ' }]);
        await expect(loadCatalogDatasets({ fetchImpl })).rejects.toThrow(/第 1 项/);
    });

    test('一条清单项写坏只跳过它，其余照常可用', async () => {
        const fetchImpl = makeFetch([
            { ...ENTRY, downloadUrl: '' },
            { ...ENTRY, id: 'other-bench' }
        ]);
        const entries = await loadCatalogDatasets({ fetchImpl });

        expect(entries.map((entry) => entry.id)).toEqual(['other-bench']);
    });

    test('id 重复时保留第一条并跳过重复项', async () => {
        const fetchImpl = makeFetch([ENTRY, { ...ENTRY, name: 'Another Bench' }]);
        const entries = await loadCatalogDatasets({ fetchImpl });

        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe('WorkBuddy Bench');
    });

    test('环境变量指向本地文件时不发网络请求', async () => {
        const file = writeLocalCatalog([ENTRY]);
        process.env[BENCHMARK_CATALOG_PATH_ENV] = file;
        const fetchImpl = jest.fn(async () => jsonResponse([ENTRY])) as unknown as typeof fetch & {
            mock: { calls: unknown[][] };
        };

        const entries = await loadCatalogDatasets({ fetchImpl });

        expect(fetchImpl.mock.calls).toHaveLength(0);
        expect(entries.map((entry) => entry.id)).toEqual(['workbuddy-bench']);
    });

    test('本地调试清单允许 http 下载地址', async () => {
        process.env[BENCHMARK_CATALOG_PATH_ENV] = writeLocalCatalog([
            { ...ENTRY, downloadUrl: 'http://127.0.0.1:8000/workbuddy-bench-0.1.zip' }
        ]);

        const entries = await loadCatalogDatasets();

        expect(entries[0].downloadUrl).toBe('http://127.0.0.1:8000/workbuddy-bench-0.1.zip');
    });

    test('本地文件不存在时报出路径', async () => {
        const missing = path.join(os.tmpdir(), 'benchmark-catalog-not-exist', 'benchmark.json');
        process.env[BENCHMARK_CATALOG_PATH_ENV] = missing;

        await expect(loadCatalogDatasets()).rejects.toThrow(/读取本地测评集清单失败/);
        await expect(loadCatalogDatasets()).rejects.toThrow(/benchmark\.json/);
    });

    test('本地文件不是合法 JSON 时报读取失败', async () => {
        process.env[BENCHMARK_CATALOG_PATH_ENV] = writeLocalCatalog('not json');

        await expect(loadCatalogDatasets()).rejects.toThrow(/读取本地测评集清单失败/);
    });
});

describe('cache', () => {
    test('拉取成功后把清单写进缓存文件', async () => {
        const cacheFile = path.join(tempDir('benchmark-cache-'), 'catalog-cache.json');

        await loadCatalogDatasets({ fetchImpl: makeFetch([ENTRY]), cacheFile });

        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        expect(cached).toHaveLength(1);
        expect(cached[0].id).toBe('workbuddy-bench');
    });

    test('写缓存后不残留临时文件', async () => {
        const dir = tempDir('benchmark-cache-');
        const cacheFile = path.join(dir, 'catalog-cache.json');

        await loadCatalogDatasets({ fetchImpl: makeFetch([ENTRY]), cacheFile });

        expect(fs.readdirSync(dir)).toEqual(['catalog-cache.json']);
    });

    test('并发写同一个缓存文件后缓存仍然可用', async () => {
        const cacheFile = path.join(tempDir('benchmark-cache-'), 'catalog-cache.json');

        // 两次独立加载（不同 cacheFile 键各自绕过内存缓存）同时写同一个文件
        await Promise.all([
            loadCatalogDatasets({ fetchImpl: makeFetch([ENTRY]), cacheFile }),
            loadCatalogDatasets({ fetchImpl: makeFetch([ENTRY]), cacheFile, forceRefresh: true })
        ]);

        expect(() => JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).not.toThrow();
    });

    test('缓存写不进去也不影响本次使用', async () => {
        // 把目录本身当缓存文件：mkdir 成功，写文件必失败
        const cacheFile = tempDir('benchmark-cache-');

        const entries = await loadCatalogDatasets({ fetchImpl: makeFetch([ENTRY]), cacheFile });

        expect(entries.map((entry) => entry.id)).toEqual(['workbuddy-bench']);
    });

    test('断网时回退到上次的缓存清单', async () => {
        const cacheFile = path.join(tempDir('benchmark-cache-'), 'catalog-cache.json');
        await loadCatalogDatasets({ fetchImpl: makeFetch([ENTRY]), cacheFile });
        resetCatalogCache();

        const offline = jest.fn(async () => {
            throw new Error('getaddrinfo ENOTFOUND opendesk.matrix.openharmony.cn');
        }) as unknown as typeof fetch;
        const entries = await loadCatalogDatasets({ fetchImpl: offline, cacheFile });

        expect(entries.map((entry) => entry.id)).toEqual(['workbuddy-bench']);
    });

    test('线上清单格式坏掉时同样回退到缓存', async () => {
        const cacheFile = path.join(tempDir('benchmark-cache-'), 'catalog-cache.json');
        await loadCatalogDatasets({ fetchImpl: makeFetch([ENTRY]), cacheFile });
        resetCatalogCache();

        const broken = makeFetch([{ ...ENTRY, downloadUrl: '' }]);
        const entries = await loadCatalogDatasets({ fetchImpl: broken, cacheFile });

        expect(entries.map((entry) => entry.id)).toEqual(['workbuddy-bench']);
    });

    test('没有缓存时保留线上拉取的错误', async () => {
        const cacheFile = path.join(tempDir('benchmark-cache-'), 'catalog-cache.json');
        const offline = jest.fn(async () => {
            throw new Error('offline');
        }) as unknown as typeof fetch;

        await expect(loadCatalogDatasets({ fetchImpl: offline, cacheFile })).rejects.toThrow(/获取测评集清单失败/);
    });

    test('缓存文件损坏时报线上拉取的错误，而不是缓存解析错误', async () => {
        const cacheFile = path.join(tempDir('benchmark-cache-'), 'catalog-cache.json');
        fs.writeFileSync(cacheFile, 'not json');
        const fetchImpl = makeFetch({ error: 'boom' }, 503);

        await expect(loadCatalogDatasets({ fetchImpl, cacheFile })).rejects.toThrow(/503/);
    });

    test('环境变量指向本地文件时不写缓存', async () => {
        process.env[BENCHMARK_CATALOG_PATH_ENV] = writeLocalCatalog([ENTRY]);
        const cacheFile = path.join(tempDir('benchmark-cache-'), 'catalog-cache.json');

        await loadCatalogDatasets({ cacheFile });

        expect(fs.existsSync(cacheFile)).toBe(false);
    });
});

describe('findCatalogDataset', () => {
    test('按 id 命中清单项', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        const entry = await findCatalogDataset('workbuddy-bench', { fetchImpl });

        expect(entry?.name).toBe('WorkBuddy Bench');
    });

    test('id 不存在时返回 null', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        await expect(findCatalogDataset('not-exist', { fetchImpl })).resolves.toBeNull();
    });

    test('空 id 直接返回 null，不发网络请求', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        await expect(findCatalogDataset('  ', { fetchImpl })).resolves.toBeNull();
        expect(fetchImpl.mock.calls).toHaveLength(0);
    });
});

describe('parseCatalogDocument', () => {
    test('容忍 dataset.json 里 tracks 写成字符串数组的写法', () => {
        const entries = parseCatalogDocument([{ ...ENTRY, tracks: ['Office', 'Code'] }], 'fixture');

        expect(entries[0].tracks).toEqual([{ name: 'Office' }, { name: 'Code' }]);
    });

    test('严格模式下 id 重复直接报错', () => {
        expect(() => parseCatalogDocument([ENTRY, { ...ENTRY, name: 'Another Bench' }], 'fixture')).toThrow(/重复/);
    });

    test('严格模式下面向远程清单也要求 https 下载地址', () => {
        expect(() => parseCatalogDocument([{ ...ENTRY, downloadUrl: 'http://example.com/x.zip' }], 'fixture')).toThrow(
            /downloadUrl/
        );
    });
});
