import { describe, expect, test } from '@jest/globals';
import os from 'node:os';
import path from 'node:path';
import {
    filterCatalogByCategories,
    filterCatalogByQuery,
    parsePluginCatalogDocument
} from '../../../main/applications/pluginmgr/registry/catalog.js';

/**
 * 插件市场清单（plugins.json）的解析与过滤。
 *
 * 关键约定：
 * - 只认 id + 归档包下载地址这两个必需字段；
 * - 单条容错（lenient）下写坏的条目跳过，严格模式下整体报错；
 * - 下载地址默认必须 https 且是 .zip / .tgz，非 https 渠道才放行明文 http；
 * - categories 来自清单自述，缺省表示该渠道不支持按分类显示。
 */

function entry(overrides: Record<string, unknown> = {}) {
    return {
        id: 'hello-plugin',
        displayName: { 'zh-CN': '你好插件', 'en-US': 'Hello Plugin' },
        description: 'A demo plugin',
        version: '1.0.0',
        category: ['开发工具'],
        downloadUrl: 'https://example.com/hello-plugin-1.0.0.zip',
        ...overrides
    };
}

function document(plugins: unknown[], categories?: unknown) {
    // 清单顶层不再有 schemaVersion：它没有版本协商作用，客户端也不读
    return { categories, plugins };
}

describe('parsePluginCatalogDocument', () => {
    test('parses entries, localized text and declared categories', () => {
        const parsed = parsePluginCatalogDocument(
            document([entry()], ['开发工具', '效率']),
            'https://example.com/category/plugins.json'
        );

        expect(parsed.categories).toEqual(['开发工具', '效率']);
        expect(parsed.entries).toHaveLength(1);
        expect(parsed.entries[0]).toMatchObject({
            id: 'hello-plugin',
            version: '1.0.0',
            category: ['开发工具'],
            downloadUrl: 'https://example.com/hello-plugin-1.0.0.zip'
        });
        // 本地化文本的键归一化为主语言标签
        expect(parsed.entries[0].displayName).toEqual({ zh: '你好插件', en: 'Hello Plugin' });
    });

    test('leaves categories undefined when the catalog does not declare them', () => {
        const parsed = parsePluginCatalogDocument(document([entry()]), 'https://example.com/category/plugins.json');

        expect(parsed.categories).toBeUndefined();
    });

    test('accepts a bare array and the entries alias', () => {
        expect(parsePluginCatalogDocument([entry()], 'local.json', { lenient: true }).entries).toHaveLength(1);
        expect(
            parsePluginCatalogDocument({ entries: [entry()] }, 'local.json', { lenient: true }).entries
        ).toHaveLength(1);
    });

    test('treats the empty official catalog placeholder as "no plugin, no categories"', () => {
        // 官方市场尚未上架插件时的占位内容（../OpenDesk-Pages 里的 plugins.json）：
        // 必须解析成空清单而不是报错，界面上退化成「这个插件市场还没有上架插件」
        const parsed = parsePluginCatalogDocument(
            { categories: [], plugins: [] },
            'https://opendesk.matrix.openharmony.cn/static/categories/plugins.json'
        );

        expect(parsed.entries).toEqual([]);
        expect(parsed.categories).toBeUndefined();
    });

    test('skips broken entries in lenient mode and dedupes ids', () => {
        const parsed = parsePluginCatalogDocument(
            document([
                entry(),
                entry(),
                entry({ id: 'bad-id', downloadUrl: 'https://example.com/plugin.exe' }),
                entry({ id: 'no-url', downloadUrl: undefined }),
                entry({ id: 'tarball', downloadUrl: 'https://example.com/tarball.tgz' })
            ]),
            'https://example.com/category/plugins.json',
            { lenient: true }
        );

        expect(parsed.entries.map((item) => item.id)).toEqual(['hello-plugin', 'tarball']);
    });

    test('rejects broken entries in strict mode with a positioned message', () => {
        expect(() =>
            parsePluginCatalogDocument(
                document([entry(), entry({ id: 'no-url', downloadUrl: undefined })]),
                'https://example.com/category/plugins.json'
            )
        ).toThrow(/第 2 条插件不可用/);
    });

    test('a catalog whose entries are all unusable reports an error instead of an empty market', () => {
        // 单条容错只应吞掉个别坏条目；一条都用不了说明清单整体是坏的（字段写错、指到了目录页），
        // 报错才能让界面走「加载失败 + 回退缓存」，而不是显示成一个「空市场」
        expect(() =>
            parsePluginCatalogDocument(
                document([
                    entry({ downloadUrl: 'https://example.com/x.exe' }),
                    entry({ id: 'no-url', downloadUrl: undefined })
                ]),
                'https://example.com/category/plugins.json',
                { lenient: true }
            )
        ).toThrow(/第 1 条插件不可用/);
    });

    test('requires https download urls unless insecure downloads are allowed', () => {
        const insecure = entry({ downloadUrl: 'http://127.0.0.1:8080/plugins/demo.zip' });

        expect(() => parsePluginCatalogDocument(document([insecure]), 'https://example.com/plugins.json')).toThrow(
            /https/
        );
        expect(
            parsePluginCatalogDocument(document([insecure]), 'http://127.0.0.1:8080/category/plugins.json', {
                allowInsecureDownloadUrl: true
            }).entries
        ).toHaveLength(1);
    });

    test('rejects non-archive download urls', () => {
        expect(() =>
            parsePluginCatalogDocument(
                document([entry({ downloadUrl: 'https://example.com/npm-package' })]),
                'https://example.com/plugins.json'
            )
        ).toThrow(/归档包/);
    });

    test('rejects invalid plugin ids', () => {
        expect(() =>
            parsePluginCatalogDocument(document([entry({ id: '1-invalid' })]), 'https://example.com/plugins.json')
        ).toThrow(/id 不合法/);
    });
});

describe('相对下载地址', () => {
    test('相对地址按清单地址解析成绝对 URL', () => {
        const parsed = parsePluginCatalogDocument(
            document([entry({ downloadUrl: 'plugins/test_plugin_1.zip' })]),
            'https://raw.gitcode.com/OpenDesk-Community/demo/raw/main/category.json'
        );

        expect(parsed.entries[0].downloadUrl).toBe(
            'https://raw.gitcode.com/OpenDesk-Community/demo/raw/main/plugins/test_plugin_1.zip'
        );
    });

    test('./ 、../ 与以 / 开头的地址按 URL 语义归一', () => {
        const base = 'https://example.com/market/category.json';
        const resolve = (downloadUrl: string) =>
            parsePluginCatalogDocument(document([entry({ downloadUrl })]), base).entries[0].downloadUrl;

        expect(resolve('./plugins/a.tgz')).toBe('https://example.com/market/plugins/a.tgz');
        expect(resolve('../plugins/a.tgz')).toBe('https://example.com/plugins/a.tgz');
        expect(resolve('/plugins/a.tgz')).toBe('https://example.com/plugins/a.tgz');
    });

    test('本地清单文件里的相对地址解析成同级文件路径', () => {
        const base = path.resolve(os.tmpdir(), 'opendesk-market', 'category.json');
        const parsed = parsePluginCatalogDocument(document([entry({ downloadUrl: 'plugins/a.zip' })]), base, {
            allowInsecureDownloadUrl: true
        });

        expect(parsed.entries[0].downloadUrl).toBe(path.resolve(path.dirname(base), 'plugins', 'a.zip'));
    });

    test('相对地址同样要求指向归档包', () => {
        expect(() =>
            parsePluginCatalogDocument(
                document([entry({ downloadUrl: 'plugins/plugin.exe' })]),
                'https://example.com/market/category.json'
            )
        ).toThrow(/归档包/);
    });

    test('相对地址不会因为清单地址是 http 就放行：仍按清单协议继承', () => {
        const parsed = parsePluginCatalogDocument(
            document([entry({ downloadUrl: 'plugins/a.zip' })]),
            'http://127.0.0.1:8080/market/category.json',
            { allowInsecureDownloadUrl: true }
        );

        expect(parsed.entries[0].downloadUrl).toBe('http://127.0.0.1:8080/market/plugins/a.zip');
    });
});

describe('版本 / apiVersion / platforms', () => {
    function parseEntryOf(overrides: Record<string, unknown>) {
        return parsePluginCatalogDocument(document([entry(overrides)]), 'https://example.com/plugins.json').entries[0];
    }

    test('version 必须是合法 SemVer（与插件清单一致）', () => {
        expect(parseEntryOf({ version: '1.2.3-beta.1' }).version).toBe('1.2.3-beta.1');
        expect(() => parseEntryOf({ version: '1.0' })).toThrow(/SemVer/);
        expect(() => parseEntryOf({ version: 'latest' })).toThrow(/SemVer/);
    });

    test('apiVersion 只接受宿主支持的版本', () => {
        expect(parseEntryOf({ apiVersion: 1 }).apiVersion).toBe(1);
        expect(() => parseEntryOf({ apiVersion: 2 })).toThrow(/apiVersion 不受支持/);
        expect(parseEntryOf({}).apiVersion).toBeUndefined();
    });

    test('platforms 取自与插件清单同一套枚举，重复值会去掉', () => {
        expect(parseEntryOf({ platforms: ['win32', 'openharmony', 'win32'] }).platforms).toEqual([
            'win32',
            'openharmony'
        ]);
        expect(() => parseEntryOf({ platforms: ['windows'] })).toThrow(/platforms 不合法/);
        expect(() => parseEntryOf({ platforms: [] })).toThrow(/platforms 不合法/);
        expect(parseEntryOf({}).platforms).toBeUndefined();
    });

    test('宿主版本上下界可选，必须是合法 SemVer（与插件清单同口径）', () => {
        expect(parseEntryOf({ minOpenDeskVersion: '1.2.0' }).minOpenDeskVersion).toBe('1.2.0');
        expect(parseEntryOf({ maxOpenDeskVersion: '2.0.0' }).maxOpenDeskVersion).toBe('2.0.0');
        expect(parseEntryOf({}).minOpenDeskVersion).toBeUndefined();
        expect(parseEntryOf({}).maxOpenDeskVersion).toBeUndefined();
        // 报错要指到具体字段：写成「插件版本号不合法」会让人去翻 version
        expect(() => parseEntryOf({ minOpenDeskVersion: 'latest' })).toThrow(/minOpenDeskVersion/);
        expect(() => parseEntryOf({ maxOpenDeskVersion: '2.0' })).toThrow(/maxOpenDeskVersion/);
    });
});

describe('filterCatalogByCategories', () => {
    const entries = parsePluginCatalogDocument(
        document([
            entry({ id: 'dev-a', category: ['开发工具'] }),
            entry({ id: 'dev-b', category: ['开发工具', '效率'] }),
            entry({ id: 'office-a', category: ['效率'] }),
            entry({ id: 'plain-a', category: undefined })
        ]),
        'https://example.com/plugins.json'
    ).entries;

    test('returns every entry when no category is requested', () => {
        expect(filterCatalogByCategories(entries, undefined).map((item) => item.id)).toEqual([
            'dev-a',
            'dev-b',
            'office-a',
            'plain-a'
        ]);
        expect(filterCatalogByCategories(entries, []).map((item) => item.id)).toHaveLength(4);
    });

    test('filters by any of the requested categories', () => {
        expect(filterCatalogByCategories(entries, ['开发工具']).map((item) => item.id)).toEqual(['dev-a', 'dev-b']);
        expect(filterCatalogByCategories(entries, ['效率']).map((item) => item.id)).toEqual(['dev-b', 'office-a']);
        expect(filterCatalogByCategories(entries, ['开发工具', '效率']).map((item) => item.id)).toEqual([
            'dev-a',
            'dev-b',
            'office-a'
        ]);
    });

    test('never matches uncategorized entries', () => {
        expect(filterCatalogByCategories(entries, ['不存在'])).toEqual([]);
    });
});

describe('filterCatalogByQuery', () => {
    const entries = parsePluginCatalogDocument(
        document([
            entry({ id: 'hello-plugin' }),
            entry({
                id: 'office-helper',
                displayName: { 'zh-CN': '办公助手' },
                description: 'Spreadsheet assistant',
                category: ['效率']
            })
        ]),
        'https://example.com/plugins.json'
    ).entries;

    test('returns every entry for a blank query', () => {
        expect(filterCatalogByQuery(entries, '   ')).toHaveLength(2);
    });

    test('matches id, display name and description case-insensitively', () => {
        expect(filterCatalogByQuery(entries, 'HELLO').map((item) => item.id)).toEqual(['hello-plugin']);
        expect(filterCatalogByQuery(entries, '办公').map((item) => item.id)).toEqual(['office-helper']);
        expect(filterCatalogByQuery(entries, 'spreadsheet').map((item) => item.id)).toEqual(['office-helper']);
        expect(filterCatalogByQuery(entries, 'nothing-matches')).toEqual([]);
    });
});

describe('iconUrl 图标链接', () => {
    function iconEntry(iconUrl: unknown, source = 'https://example.com/plugins.json') {
        return parsePluginCatalogDocument(document([entry({ id: 'iconed-plugin', iconUrl })]), source, {
            lenient: true
        });
    }

    test('未声明时保持 undefined', () => {
        const parsed = parsePluginCatalogDocument(
            document([entry({ id: 'iconed-plugin' })]),
            'https://example.com/plugins.json'
        );
        expect(parsed.entries[0].iconUrl).toBeUndefined();
    });

    test('绝对 http(s) 图片地址原样保留', () => {
        const parsed = iconEntry('https://cdn.example.com/icon.png');
        expect(parsed.entries[0].iconUrl).toBe('https://cdn.example.com/icon.png');
        const httpParsed = iconEntry('http://cdn.example.com/icon.png');
        expect(httpParsed.entries[0].iconUrl).toBe('http://cdn.example.com/icon.png');
    });

    test('相对链接按清单地址解析成绝对 URL（与 downloadUrl 同一套规则）', () => {
        const parsed = iconEntry('plugins/icon.png', 'https://raw.gitcode.com/acme/registry/raw/main/category.json');
        expect(parsed.entries[0].iconUrl).toBe('https://raw.gitcode.com/acme/registry/raw/main/plugins/icon.png');
    });

    test('本地清单里的相对链接解析成同级文件路径', () => {
        const base = path.resolve(os.tmpdir(), 'opendesk-market', 'category.json');
        const parsed = parsePluginCatalogDocument(
            document([entry({ id: 'iconed-plugin', iconUrl: 'plugins/icon.png' })]),
            base,
            { lenient: true }
        );
        expect(parsed.entries[0].iconUrl).toBe(path.resolve(path.dirname(base), 'plugins', 'icon.png'));
    });

    test('写坏的图标链接按未声明处理，不让整条插件下架', () => {
        // iconUrl 只是展示字段：与 homepage 同一口径地宽松处理，写坏就当没写
        expect(iconEntry('javascript:alert(1)').entries[0].iconUrl).toBeUndefined();
        expect(iconEntry('ftp://example.com/icon.png').entries[0].iconUrl).toBeUndefined();
        expect(iconEntry(42).entries[0].iconUrl).toBeUndefined();
        expect(iconEntry('   ').entries[0].iconUrl).toBeUndefined();
    });
});

describe('作者信息', () => {
    function authorEntry(author: unknown) {
        return entry({ id: 'authored-plugin', author });
    }

    function parseAuthor(author: unknown) {
        return parsePluginCatalogDocument(document([authorEntry(author)]), 'https://example.com/plugins.json')
            .entries[0].author;
    }

    test('解析结构化的 name / institution / homepage', () => {
        expect(
            parseAuthor({
                name: { 'zh-CN': '张三', 'en-US': 'Zhang San' },
                institution: { zh: '开放原子开源基金会' },
                homepage: 'https://example.com'
            })
        ).toEqual({
            name: { zh: '张三', en: 'Zhang San' },
            institution: { zh: '开放原子开源基金会' },
            homepage: 'https://example.com/'
        });
    });

    test('字符串简写不再接受：author 必须是与插件清单同构的对象', () => {
        expect(() => parseAuthor('OpenDesk Team')).toThrow(/作者信息不合法/);
    });

    test('缺名字的 author 直接让这条条目不成立', () => {
        expect(() => parseAuthor({ institution: '某机构' })).toThrow(/作者信息不合法/);
        expect(() => parseAuthor({})).toThrow(/作者信息不合法/);
        expect(() => parseAuthor(42)).toThrow(/作者信息不合法/);
    });

    test('homepage 只接受 http(s)，其余整条拒绝', () => {
        expect(() => parseAuthor({ name: 'A', homepage: 'javascript:alert(1)' })).toThrow(/作者信息不合法/);
        expect(() => parseAuthor({ name: 'A', homepage: 'not-a-url' })).toThrow(/作者信息不合法/);
        expect(parseAuthor({ name: 'A', homepage: 'http://example.com/docs' })?.homepage).toBe(
            'http://example.com/docs'
        );
    });

    test('作者名与机构都参与搜索', () => {
        const entries = parsePluginCatalogDocument(
            document([
                authorEntry({ name: { 'zh-CN': '张三' }, institution: { 'zh-CN': '开放原子开源基金会' } }),
                entry({ id: 'other-plugin' })
            ]),
            'https://example.com/plugins.json'
        ).entries;

        expect(filterCatalogByQuery(entries, '张三').map((item) => item.id)).toEqual(['authored-plugin']);
        expect(filterCatalogByQuery(entries, '开源基金会').map((item) => item.id)).toEqual(['authored-plugin']);
    });
});
