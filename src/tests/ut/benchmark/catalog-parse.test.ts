import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { setRuntimeLocale } from '../../../locale/index.js';

/**
 * parseCatalogDocument：清单文档 → 清单项的纯解析。
 *
 * 这份文件是清单（远程数据）进入主进程的第一道闸，规则必须逐条钉住：
 * - 线上清单只接受 https 下载地址（清单写坏/被替换也不至于让主进程去 http 落盘解压）；
 * - 宽松模式单条容错（跳过坏项并保序去重），严格模式第一条就报错；
 * - 版本号按 dataset.json 的同一套规则归一化。
 */

const { parseCatalogDocument } = await import('../../../main/applications/benchmark/catalog.js');

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

beforeEach(() => {
    setRuntimeLocale('zh-CN');
});

afterEach(() => {
    setRuntimeLocale(null);
});

/** 线上清单的取用方式：宽松模式 */
const LENIENT = { lenient: true } as const;

describe('parseCatalogDocument 下载地址', () => {
    test('线上清单接受 https 下载地址', () => {
        const entries = parseCatalogDocument([ENTRY], 'fixture', LENIENT);
        expect(entries).toHaveLength(1);
        expect(entries[0].downloadUrl).toBe('https://example.com/workbuddy-bench-0.1.zip');
    });

    test('线上清单不接受明文 http 下载地址', () => {
        const entry = { ...ENTRY, downloadUrl: 'http://example.com/workbuddy-bench-0.1.zip' };
        // 宽松模式：跳过这一条，不让它进到下载器
        expect(parseCatalogDocument([entry, { ...ENTRY, id: 'other-bench' }], 'fixture', LENIENT)).toHaveLength(1);
        expect(parseCatalogDocument([entry, { ...ENTRY, id: 'other-bench' }], 'fixture', LENIENT)[0].id).toBe(
            'other-bench'
        );
        // 严格模式：直接报错
        expect(() => parseCatalogDocument([entry], 'fixture')).toThrow(/downloadUrl/);
    });

    test('file:// 之类的协议一律拒绝', () => {
        const entry = { ...ENTRY, downloadUrl: 'file:///tmp/workbuddy-bench.zip' };
        expect(parseCatalogDocument([entry, { ...ENTRY, id: 'other-bench' }], 'fixture', LENIENT)).toHaveLength(1);
        expect(() => parseCatalogDocument([entry], 'fixture')).toThrow(/downloadUrl/);
    });

    test('本地调试清单才放行明文 http', () => {
        const entry = { ...ENTRY, downloadUrl: 'http://127.0.0.1:8000/workbuddy-bench.zip' };
        const entries = parseCatalogDocument([entry], 'fixture', {
            lenient: true,
            allowInsecureDownloadUrl: true
        });
        expect(entries[0].downloadUrl).toBe('http://127.0.0.1:8000/workbuddy-bench.zip');
    });
});

describe('parseCatalogDocument 相对下载地址', () => {
    // 与官方 registry（清单与 zip 同仓托管）的形态一致：清单地址在 raw/main 下，zip 写相对路径
    const CATALOG_URL = 'https://gitcode.com/OpenDesk-Community/official-benchmark-registry/raw/main/category.json';
    const WITH_BASE = { ...LENIENT, baseUrl: CATALOG_URL };

    test('相对路径以清单地址为基准解析成绝对地址', () => {
        const entries = parseCatalogDocument(
            [{ ...ENTRY, downloadUrl: 'zips/workbuddy-bench-0.1.zip' }],
            CATALOG_URL,
            WITH_BASE
        );
        expect(entries[0].downloadUrl).toBe(
            'https://gitcode.com/OpenDesk-Community/official-benchmark-registry/raw/main/zips/workbuddy-bench-0.1.zip'
        );
    });

    test('`./` 与 `../` 开头的相对路径同样按清单地址解析', () => {
        const entries = parseCatalogDocument(
            [
                { ...ENTRY, id: 'a', downloadUrl: './zips/a.zip' },
                { ...ENTRY, id: 'b', downloadUrl: '../shared/b.zip' }
            ],
            CATALOG_URL,
            WITH_BASE
        );
        expect(entries[0].downloadUrl).toBe(
            'https://gitcode.com/OpenDesk-Community/official-benchmark-registry/raw/main/zips/a.zip'
        );
        expect(entries[1].downloadUrl).toBe(
            'https://gitcode.com/OpenDesk-Community/official-benchmark-registry/raw/shared/b.zip'
        );
    });

    test('绝对地址不受 baseUrl 影响', () => {
        const entries = parseCatalogDocument(
            [{ ...ENTRY, downloadUrl: 'https://mirror.example.com/workbuddy-bench.zip' }],
            CATALOG_URL,
            WITH_BASE
        );
        expect(entries[0].downloadUrl).toBe('https://mirror.example.com/workbuddy-bench.zip');
    });

    test('清单不是 JSON 地址（没有 baseUrl）时相对路径按无效地址处理', () => {
        const entry = { ...ENTRY, downloadUrl: 'zips/workbuddy-bench.zip' };
        // 宽松模式：跳过这一条，不让它进到下载器
        expect(parseCatalogDocument([entry, { ...ENTRY, id: 'other-bench' }], 'fixture', LENIENT)).toHaveLength(1);
        // 严格模式：直接报错
        expect(() => parseCatalogDocument([entry], 'fixture')).toThrow(/downloadUrl/);
    });

    test('相对路径解析后仍要过下载地址校验：http 按线上清单规则拒绝', () => {
        const base = 'http://insecure.example.com/categories/benchmarks.json';
        const entry = { ...ENTRY, downloadUrl: 'zips/workbuddy-bench.zip' };
        expect(
            parseCatalogDocument([entry, { ...ENTRY, id: 'other-bench' }], base, { ...LENIENT, baseUrl: base })
        ).toHaveLength(1);
        // 本地调试清单（allowInsecureDownloadUrl）才放行解析出的明文 http
        expect(
            parseCatalogDocument([entry], base, {
                lenient: true,
                allowInsecureDownloadUrl: true,
                baseUrl: base
            })
        ).toHaveLength(1);
    });
});

describe('parseCatalogDocument 单条容错', () => {
    test('一条写坏只跳过它，其余照常可用', () => {
        const entries = parseCatalogDocument(
            [
                { ...ENTRY, downloadUrl: '' },
                { ...ENTRY, id: 'other-bench' }
            ],
            'fixture',
            LENIENT
        );
        expect(entries.map((entry) => entry.id)).toEqual(['other-bench']);
    });

    test('宽松模式下 id 重复保留第一条', () => {
        const entries = parseCatalogDocument([ENTRY, { ...ENTRY, name: 'Another Bench' }], 'fixture', LENIENT);
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe('WorkBuddy Bench');
    });

    test('严格模式下 id 重复直接报错', () => {
        expect(() => parseCatalogDocument([ENTRY, { ...ENTRY, name: 'Another Bench' }], 'fixture')).toThrow(/重复/);
    });

    test('严格模式下第一条坏项就报错，并带上序号', () => {
        expect(() => parseCatalogDocument([{ ...ENTRY, name: '  ' }], 'fixture')).toThrow(/第 1 项/);
    });

    test('一条都用不了时报出第一条错误（好让调用方回退缓存）', () => {
        expect(() => parseCatalogDocument([{ ...ENTRY, downloadUrl: '' }], 'fixture', LENIENT)).toThrow(/downloadUrl/);
    });

    test('空清单是合法的空结果，不是错误', () => {
        expect(parseCatalogDocument([], 'fixture', LENIENT)).toEqual([]);
    });

    test('顶层不是数组时报出来源', () => {
        expect(() => parseCatalogDocument({ datasets: [ENTRY] }, 'https://example.com/benchmarks.json')).toThrow(
            /https:\/\/example\.com\/benchmarks\.json/
        );
    });
});

describe('parseCatalogDocument 版本与 track 归一化', () => {
    test('tracks 写成字符串数组也接受', () => {
        const entries = parseCatalogDocument([{ ...ENTRY, tracks: ['Office', 'Code'] }], 'fixture', LENIENT);
        expect(entries[0].tracks).toEqual([{ name: 'Office' }, { name: 'Code' }]);
    });

    test('两段式版本号补齐成三段', () => {
        // 线上清单目前就是 `0.2` 这种两段式写法
        expect(parseCatalogDocument([ENTRY], 'fixture', LENIENT)[0].version).toBe('0.1.0');
    });

    test('非 SemVer 版本号的清单项被跳过', () => {
        const entries = parseCatalogDocument(
            [
                { ...ENTRY, version: '2024-09' },
                { ...ENTRY, id: 'other-bench' }
            ],
            'fixture',
            LENIENT
        );
        expect(entries.map((entry) => entry.id)).toEqual(['other-bench']);
    });
});
