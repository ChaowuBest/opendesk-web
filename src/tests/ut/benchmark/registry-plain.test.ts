import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setRuntimeLocale } from '../../../locale/index.js';

/**
 * PlainBenchmarkRegistry：从远端清单地址拉测评集的 registry。
 *
 * 关键约定：
 * - 清单下载到本地 JSON 文件，有效期 5 分钟；
 * - getCatalog / getBenchmarkCount 共用同一份清单，谁先调用谁触发下载；
 * - 逾期重试失败时直接复用本地已有文件，不让一次断网把清单清空；
 * - 本地调试清单（本地文件路径）跳过网络、不写缓存，改完立刻生效。
 */

const { PlainBenchmarkRegistry, DEFAULT_CATALOG_TTL_MS } =
    await import('../../../main/applications/benchmark/registry/plain.js');
const { resolveBenchmarkRegistryDisplayName } = await import('../../../main/applications/benchmark/registry/base.js');

const CATALOG_URL = 'https://example.com/static/categories/benchmarks.json';
/** 直接跟随实现里的有效期，改常量时用例跟着走 */
const TTL_MS = DEFAULT_CATALOG_TTL_MS;

const ENTRY = {
    id: 'workbuddy-bench',
    name: 'WorkBuddy Bench',
    description: 'fixture dataset',
    homepage: 'https://example.com',
    version: '0.1.0',
    downloadUrl: 'https://example.com/workbuddy-bench-0.1.0.zip',
    tracks: [
        { id: 'office', name: 'Office' },
        { id: 'code', name: 'Code' }
    ]
};

const tempDirs: string[] = [];
/** 测试时钟：真实时间 + 偏移，缓存文件是真实落盘的，所以基准取真实时间 */
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

function makeRegistry(options: { cacheFile?: string; fetchImpl?: typeof fetch; catalogUrl?: string } = {}) {
    return new PlainBenchmarkRegistry(
        'official',
        { 'zh-CN': '官方测评集', 'en-US': 'Official' },
        options.catalogUrl ?? CATALOG_URL,
        {
            cacheFile: options.cacheFile,
            fetchImpl: options.fetchImpl,
            now: clock
        }
    );
}

function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function writeLocalCatalog(content: string | object): string {
    const file = path.join(tempDir('benchmark-registry-'), 'benchmarks.json');
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
}

describe('PlainBenchmarkRegistry 基本信息', () => {
    test('构造参数即 registry 的标识、显示名与清单地址', () => {
        const registry = makeRegistry();

        expect(registry.name).toBe('official');
        expect(registry.catalogUrl).toBe(CATALOG_URL);
        expect(resolveBenchmarkRegistryDisplayName(registry.displayName, 'zh-CN')).toBe('官方测评集');
        expect(resolveBenchmarkRegistryDisplayName(registry.displayName, 'en-US')).toBe('Official');
    });

    test('displayName 是字符串时所有语言同名', () => {
        expect(resolveBenchmarkRegistryDisplayName('Community', 'zh-CN')).toBe('Community');
    });

    test('displayName 映射按语言主标签兜底', () => {
        expect(resolveBenchmarkRegistryDisplayName({ zh_TW: '官方' }, 'zh-CN')).toBe('官方');
        expect(resolveBenchmarkRegistryDisplayName({ 'zh-CN': '官方', 'en-US': 'Official' }, 'ja-JP')).toBe('官方');
    });
});

describe('PlainBenchmarkRegistry 拉取清单', () => {
    test('从清单地址拉取并解析成清单项', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        const entries = await makeRegistry({ fetchImpl }).getCatalog();

        expect(fetchImpl.mock.calls).toHaveLength(1);
        expect(fetchImpl.mock.calls[0][0]).toBe(CATALOG_URL);
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('workbuddy-bench');
        expect(entries[0].downloadUrl).toBe('https://example.com/workbuddy-bench-0.1.0.zip');
        expect(entries[0].tracks.map((track) => track.name)).toEqual(['Office', 'Code']);
    });

    test('先 getCatalog 再 getBenchmarkCount 复用同一份下载', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        const registry = makeRegistry({ fetchImpl });

        await registry.getCatalog();
        await expect(registry.getBenchmarkCount()).resolves.toBe(1);
        expect(fetchImpl.mock.calls).toHaveLength(1);
    });

    test('先 getBenchmarkCount 再 getCatalog 也复用同一份下载', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        const registry = makeRegistry({ fetchImpl });

        await expect(registry.getBenchmarkCount()).resolves.toBe(1);
        await expect(registry.getCatalog()).resolves.toHaveLength(1);
        expect(fetchImpl.mock.calls).toHaveLength(1);
    });

    test('并发取清单只发一次请求', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        const registry = makeRegistry({ fetchImpl });

        const [first, second] = await Promise.all([registry.getCatalog(), registry.getBenchmarkCount()]);
        expect(first).toHaveLength(1);
        expect(second).toBe(1);
        expect(fetchImpl.mock.calls).toHaveLength(1);
    });

    test('分页：startAt 与 limit', async () => {
        const fetchImpl = makeFetch([
            ENTRY,
            { ...ENTRY, id: 'second-bench', name: 'Second' },
            { ...ENTRY, id: 'third-bench', name: 'Third' }
        ]);
        const registry = makeRegistry({ fetchImpl });

        await expect(registry.getCatalog(1, 1)).resolves.toMatchObject([{ id: 'second-bench' }]);
        await expect(registry.getCatalog(2)).resolves.toMatchObject([{ id: 'third-bench' }]);
        await expect(registry.getCatalog(0, 0)).resolves.toHaveLength(0);
        await expect(registry.getCatalog(-5, 2)).resolves.toMatchObject([
            { id: 'workbuddy-bench' },
            { id: 'second-bench' }
        ]);
        // 分页不影响总数
        await expect(registry.getBenchmarkCount()).resolves.toBe(3);
        expect(fetchImpl.mock.calls).toHaveLength(1);
    });

    test('改返回值不会污染缓存', async () => {
        const fetchImpl = makeFetch([ENTRY]);
        const registry = makeRegistry({ fetchImpl });

        const entries = await registry.getCatalog();
        entries[0].name = 'mutated';
        entries[0].tracks.length = 0;

        const again = await registry.getCatalog();
        expect(again[0].name).toBe('WorkBuddy Bench');
        expect(again[0].tracks).toHaveLength(2);
    });

    test('拉取失败且没有本地缓存时报出地址', async () => {
        const fetchImpl = jest.fn(async () => {
            throw new Error('getaddrinfo ENOTFOUND example.com');
        }) as unknown as typeof fetch;

        await expect(makeRegistry({ fetchImpl }).getCatalog()).rejects.toThrow(/benchmarks\.json/);
        await expect(makeRegistry({ fetchImpl }).getBenchmarkCount()).rejects.toThrow(/获取测评集清单失败/);
    });

    test('HTTP 状态异常时报出状态码', async () => {
        const fetchImpl = makeFetch({ error: 'boom' }, 503);
        await expect(makeRegistry({ fetchImpl }).getCatalog()).rejects.toThrow(/503/);
    });

    test('响应不是 JSON 时报拉取失败', async () => {
        const fetchImpl = jest.fn(async () => new Response('<html>oops</html>')) as unknown as typeof fetch;
        await expect(makeRegistry({ fetchImpl }).getCatalog()).rejects.toThrow(/获取测评集清单失败/);
    });

    test('顶层不是数组时报清单格式错误', async () => {
        const fetchImpl = makeFetch({ datasets: [ENTRY] });
        await expect(makeRegistry({ fetchImpl }).getCatalog()).rejects.toThrow(/应为测评集数组/);
    });

    test('单条清单项写坏只跳过它', async () => {
        const fetchImpl = makeFetch([
            { ...ENTRY, id: 'broken', downloadUrl: '' },
            { ...ENTRY, id: 'other-bench' }
        ]);
        const entries = await makeRegistry({ fetchImpl }).getCatalog();
        expect(entries.map((entry) => entry.id)).toEqual(['other-bench']);
    });
});

describe('PlainBenchmarkRegistry 清单缓存', () => {
    test('拉取成功后把清单写进缓存文件', async () => {
        const cacheFile = path.join(tempDir('benchmark-registry-cache-'), 'official.json');

        await makeRegistry({ fetchImpl: makeFetch([ENTRY]), cacheFile }).getCatalog();

        expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).toMatchObject([{ id: 'workbuddy-bench' }]);
    });

    test('写缓存后不残留临时文件', async () => {
        const dir = tempDir('benchmark-registry-cache-');
        const cacheFile = path.join(dir, 'official.json');

        await makeRegistry({ fetchImpl: makeFetch([ENTRY]), cacheFile }).getCatalog();

        expect(fs.readdirSync(dir)).toEqual(['official.json']);
    });

    test('有效期内不再请求远端', async () => {
        const cacheFile = path.join(tempDir('benchmark-registry-cache-'), 'official.json');
        const fetchImpl = makeFetch([ENTRY]);
        const registry = makeRegistry({ fetchImpl, cacheFile });

        await registry.getCatalog();
        clockOffset += TTL_MS - 1000;
        await registry.getBenchmarkCount();
        expect(fetchImpl.mock.calls).toHaveLength(1);
    });

    test('超过有效期后重新下载', async () => {
        const cacheFile = path.join(tempDir('benchmark-registry-cache-'), 'official.json');
        const fetchImpl = makeFetch([ENTRY]);
        const registry = makeRegistry({ fetchImpl, cacheFile });

        await registry.getCatalog();
        clockOffset += TTL_MS + 1000;
        await registry.getCatalog();
        expect(fetchImpl.mock.calls).toHaveLength(2);
    });

    test('超过有效期重试失败时复用本地缓存文件', async () => {
        const cacheFile = path.join(tempDir('benchmark-registry-cache-'), 'official.json');
        await makeRegistry({ fetchImpl: makeFetch([ENTRY]), cacheFile }).getCatalog();

        clockOffset += TTL_MS + 1000;
        const offline = jest.fn(async () => {
            throw new Error('getaddrinfo ENOTFOUND example.com');
        }) as unknown as typeof fetch;
        const entries = await makeRegistry({ fetchImpl: offline, cacheFile }).getCatalog();

        expect(entries.map((entry) => entry.id)).toEqual(['workbuddy-bench']);
        expect(offline).toHaveBeenCalledTimes(1);
    });

    test('内存缓存过期但本地文件仍在有效期内时不请求远端', async () => {
        const cacheFile = path.join(tempDir('benchmark-registry-cache-'), 'official.json');
        const fetchImpl = makeFetch([ENTRY]);
        await makeRegistry({ fetchImpl, cacheFile }).getCatalog();

        // 模拟另一个进程刚刷新过缓存文件：内容新、mtime 也是新的
        clockOffset += TTL_MS + 1000;
        const nowDate = new Date(clock());
        fs.utimesSync(cacheFile, nowDate, nowDate);

        const entries = await makeRegistry({ fetchImpl, cacheFile }).getCatalog();
        expect(entries.map((entry) => entry.id)).toEqual(['workbuddy-bench']);
        expect(fetchImpl.mock.calls).toHaveLength(1);
    });

    test('本地缓存文件损坏时按远端拉取的错误报错', async () => {
        const cacheFile = path.join(tempDir('benchmark-registry-cache-'), 'official.json');
        fs.writeFileSync(cacheFile, 'not json');
        const fetchImpl = makeFetch({ error: 'boom' }, 503);

        await expect(makeRegistry({ fetchImpl, cacheFile }).getCatalog()).rejects.toThrow(/503/);
    });

    test('缓存文件格式坏掉时同样回退到本地缓存', async () => {
        const cacheFile = path.join(tempDir('benchmark-registry-cache-'), 'official.json');
        await makeRegistry({ fetchImpl: makeFetch([ENTRY]), cacheFile }).getCatalog();

        clockOffset += TTL_MS + 1000;
        // 线上清单被人手改坏（顶层不是数组）：不能因此让下载中心变成空白
        const broken = makeFetch({ datasets: [ENTRY] });
        const entries = await makeRegistry({ fetchImpl: broken, cacheFile }).getCatalog();

        expect(entries.map((entry) => entry.id)).toEqual(['workbuddy-bench']);
        expect(broken.mock.calls).toHaveLength(1);
    });

    test('缓存文件 mtime 落在未来时不算新鲜缓存', async () => {
        const cacheFile = path.join(tempDir('benchmark-registry-cache-'), 'official.json');
        await makeRegistry({ fetchImpl: makeFetch([ENTRY]), cacheFile }).getCatalog();

        // 系统时钟回拨、缓存文件被整体拷贝过来时 mtime 可能在未来，
        // 此时「年龄」是负数，绝不能当成刚下载过，否则清单会一直停在旧版本
        const future = new Date(clock() + TTL_MS * 10);
        fs.utimesSync(cacheFile, future, future);
        const fetchImpl = makeFetch([{ ...ENTRY, version: '0.2.0' }]);

        const entries = await makeRegistry({ fetchImpl, cacheFile }).getCatalog();

        expect(fetchImpl.mock.calls).toHaveLength(1);
        expect(entries[0].version).toBe('0.2.0');
    });

    test('手动刷新（invalidate）绕过缓存重新下载', async () => {
        const cacheFile = path.join(tempDir('benchmark-registry-cache-'), 'official.json');
        const fetchImpl = makeFetch([ENTRY]);
        const registry = makeRegistry({ fetchImpl, cacheFile });

        await registry.getCatalog();
        registry.invalidate();
        await registry.getCatalog();
        expect(fetchImpl.mock.calls).toHaveLength(2);
    });
});

describe('PlainBenchmarkRegistry 本地调试清单', () => {
    test('清单地址是本地文件时不发网络请求', async () => {
        const file = writeLocalCatalog([ENTRY]);
        const fetchImpl = makeFetch([ENTRY]);

        const entries = await makeRegistry({ fetchImpl, catalogUrl: file }).getCatalog();

        expect(fetchImpl.mock.calls).toHaveLength(0);
        expect(entries.map((entry) => entry.id)).toEqual(['workbuddy-bench']);
    });

    test('改完本地文件立刻生效，且不写缓存', async () => {
        const file = writeLocalCatalog([ENTRY]);
        const dir = tempDir('benchmark-registry-cache-');
        const cacheFile = path.join(dir, 'official.json');
        const registry = makeRegistry({ catalogUrl: file, cacheFile });

        await registry.getCatalog();
        writeLocalCatalog([]);
        fs.writeFileSync(file, JSON.stringify([{ ...ENTRY, id: 'local-2', name: 'Local 2' }]));

        const entries = await registry.getCatalog();
        expect(entries.map((entry) => entry.id)).toEqual(['local-2']);
        expect(fs.existsSync(cacheFile)).toBe(false);
    });

    test('本地调试清单允许明文 http 下载地址', async () => {
        const file = writeLocalCatalog([{ ...ENTRY, downloadUrl: 'http://127.0.0.1:8000/workbuddy-bench.zip' }]);
        const entries = await makeRegistry({ catalogUrl: file }).getCatalog();
        expect(entries[0].downloadUrl).toBe('http://127.0.0.1:8000/workbuddy-bench.zip');
    });

    test('本地文件不存在时报出路径', async () => {
        const missing = path.join(os.tmpdir(), 'benchmark-registry-not-exist', 'benchmarks.json');
        await expect(makeRegistry({ catalogUrl: missing }).getCatalog()).rejects.toThrow(/读取本地测评集清单失败/);
    });
});
