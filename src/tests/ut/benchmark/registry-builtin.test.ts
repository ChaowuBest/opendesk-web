import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setRuntimeLocale } from '../../../locale/index.js';

/**
 * 内置 registry 列表：应用默认只有一个官方 registry，
 * OPENDESK_BENCHMARK_CATEGORY 指向本地文件时官方 registry 改读该文件（调试用）。
 */

const { createBenchmarkRegistries, BENCHMARK_CATALOG_URL, BENCHMARK_CATALOG_PATH_ENV, OFFICIAL_REGISTRY_NAME } =
    await import('../../../main/applications/benchmark/registry/index.js');
const { resolveBenchmarkRegistryDisplayName } = await import('../../../main/applications/benchmark/registry/base.js');

const ENTRY = {
    id: 'workbuddy-bench',
    name: 'WorkBuddy Bench',
    description: 'fixture dataset',
    homepage: 'https://example.com',
    version: '0.1.0',
    downloadUrl: 'https://example.com/workbuddy-bench-0.1.0.zip',
    tracks: [{ id: 'office', name: 'Office' }]
};

const originalEnv = process.env[BENCHMARK_CATALOG_PATH_ENV];
const tempDirs: string[] = [];

beforeEach(() => {
    setRuntimeLocale('zh-CN');
    delete process.env[BENCHMARK_CATALOG_PATH_ENV];
});

afterEach(() => {
    setRuntimeLocale(null);
    if (originalEnv === undefined) delete process.env[BENCHMARK_CATALOG_PATH_ENV];
    else process.env[BENCHMARK_CATALOG_PATH_ENV] = originalEnv;
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function makeFetch(body: unknown) {
    return jest.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch & {
        mock: { calls: unknown[][] };
    };
}

describe('createBenchmarkRegistries', () => {
    test('默认只有一个官方 registry', () => {
        const registries = createBenchmarkRegistries({ dataDirectory: tempDir('benchmark-registries-') });

        expect(registries.map((registry) => registry.name)).toEqual([OFFICIAL_REGISTRY_NAME]);
        expect(resolveBenchmarkRegistryDisplayName(registries[0].displayName, 'zh-CN')).toBe('官方测评集');
        expect((registries[0] as { catalogUrl: string }).catalogUrl).toBe(BENCHMARK_CATALOG_URL);
    });

    test('官方清单缓存落在应用数据目录下，按 registry 名区分', async () => {
        const dataDir = tempDir('benchmark-registries-');
        const registries = createBenchmarkRegistries({ dataDirectory: dataDir, fetchImpl: makeFetch([ENTRY]) });

        await expect(registries[0].getBenchmarkCount()).resolves.toBe(1);

        expect(fs.readdirSync(path.join(dataDir, 'catalog-cache'))).toEqual([`${OFFICIAL_REGISTRY_NAME}.json`]);
    });

    test('环境变量指向本地文件时官方 registry 改读该文件，且不发请求、不落缓存', async () => {
        const file = path.join(tempDir('benchmark-registries-'), 'benchmarks.json');
        fs.writeFileSync(file, JSON.stringify([ENTRY]));
        process.env[BENCHMARK_CATALOG_PATH_ENV] = file;

        const dataDir = tempDir('benchmark-registries-');
        const fetchImpl = makeFetch([ENTRY]);
        const registries = createBenchmarkRegistries({ dataDirectory: dataDir, fetchImpl });

        const entries = await registries[0].getCatalog();
        expect(entries.map((entry) => entry.id)).toEqual(['workbuddy-bench']);
        expect(fetchImpl.mock.calls).toHaveLength(0);
        expect(fs.existsSync(path.join(dataDir, 'catalog-cache'))).toBe(false);
    });
});
