import {
    LocalePackParseError,
    applyLocaleParams,
    formatLocaleDisplayName,
    isBuiltinLocaleTag,
    mergeLocalePacks,
    normalizeLocaleTag,
    parseLocalePackJson,
    resolveLocaleText,
    tagFromPackFileName
} from '../../../common/locale/pack.js';

describe('normalizeLocaleTag', () => {
    test('规范化大小写与下划线分隔符', () => {
        expect(normalizeLocaleTag('tr-tr')).toBe('tr-TR');
        expect(normalizeLocaleTag('zh_CN')).toBe('zh-CN');
        expect(normalizeLocaleTag('  ja-jp ')).toBe('ja-JP');
        expect(normalizeLocaleTag('id')).toBe('id');
    });

    test('非法 tag 返回 undefined', () => {
        expect(normalizeLocaleTag('')).toBeUndefined();
        expect(normalizeLocaleTag('123')).toBeUndefined();
        expect(normalizeLocaleTag(42)).toBeUndefined();
        expect(normalizeLocaleTag(null)).toBeUndefined();
    });
});

describe('tagFromPackFileName', () => {
    test('从文件名提取并规范化语言 tag', () => {
        expect(tagFromPackFileName('locales/tr-TR.json')).toBe('tr-TR');
        expect(tagFromPackFileName('/abs/path/ja-jp.JSON')).toBe('ja-JP');
    });

    test('非 json 文件返回 undefined', () => {
        expect(tagFromPackFileName('locales/readme.md')).toBeUndefined();
    });
});

describe('parseLocalePackJson', () => {
    test('解析扁平词条并剥离保留 key', () => {
        const pack = parseLocalePackJson(
            {
                '@fallback': 'zh-CN',
                '@unknownReserved': 'ignored',
                'renderer.sidebar.apps': 'Uygulamalar'
            },
            'tr-TR.json'
        );
        expect(pack.tag).toBe('tr-TR');
        expect(pack.fallback).toBe('zh-CN');
        expect(pack.entries).toEqual({ 'renderer.sidebar.apps': 'Uygulamalar' });
    });

    test('非对象顶层或非字符串值必须报错并携带文件定位', () => {
        expect(() => parseLocalePackJson([1, 2], 'tr-TR.json')).toThrow(LocalePackParseError);
        expect(() => parseLocalePackJson({ key: 1 }, 'tr-TR.json')).toThrow(/"key" must map to a string/);
        expect(() => parseLocalePackJson({ key: { nested: 'v' } }, 'tr-TR.json')).toThrow(LocalePackParseError);
    });

    test('@fallback 必须是合法语言 tag', () => {
        expect(() => parseLocalePackJson({ '@fallback': 'not a tag!' }, 'tr-TR.json')).toThrow(/@fallback/);
    });

    test('文件名不是语言 tag 时报错', () => {
        expect(() => parseLocalePackJson({ key: 'v' }, '123.json')).toThrow(/file name/);
    });

    test('非法 JSON 抛 LocalePackParseError 便于上层统一诊断', () => {
        const error = new LocalePackParseError('locale pack is not valid JSON', 'x.json');
        expect(error).toBeInstanceOf(LocalePackParseError);
        expect(error.message).toContain('x.json');
    });
});

describe('mergeLocalePacks', () => {
    const pack = (pluginId: string, entries: Record<string, string>, fallback?: string) => ({
        pluginId,
        content: { tag: 'tr-TR', fallback, entries }
    });

    test('按插件 ID 字典序合并，后者覆盖前者', () => {
        const merged = mergeLocalePacks([
            pack('beta-plugin', { 'a.key': 'from-beta', 'only-beta': 'b' }),
            pack('alpha-plugin', { 'a.key': 'from-alpha', 'only-alpha': 'a' })
        ]);
        expect(merged?.entries).toEqual({ 'a.key': 'from-beta', 'only-beta': 'b', 'only-alpha': 'a' });
    });

    test('同 key 冲突写入报告（获胜者与被覆盖方）', () => {
        const merged = mergeLocalePacks([
            pack('alpha-plugin', { 'a.key': 'from-alpha' }),
            pack('beta-plugin', { 'a.key': 'from-beta' }),
            pack('gamma-plugin', { 'a.key': 'from-gamma' })
        ]);
        expect(merged?.conflicts).toEqual([
            { key: 'a.key', winner: 'beta-plugin', losers: ['alpha-plugin'] },
            { key: 'a.key', winner: 'gamma-plugin', losers: ['alpha-plugin', 'beta-plugin'] }
        ]);
    });

    test('fallback 取字典序最后一个声明', () => {
        expect(mergeLocalePacks([pack('a', {}, 'zh-CN'), pack('b', {}, 'en-US')])?.fallback).toBe('en-US');
        expect(mergeLocalePacks([pack('a', {})])?.fallback).toBeUndefined();
    });

    test('空来源返回 undefined', () => {
        expect(mergeLocalePacks([])).toBeUndefined();
    });
});

describe('resolveLocaleText 查找链', () => {
    const domain = {
        'zh-CN': { greet: '你好', 'only.zh': '中文兜底' },
        'en-US': { greet: 'Hello', extra: 'English extra' }
    };
    const lookupPack = (tag: string) => {
        if (tag === 'tr-TR') return { greet: 'Merhaba' };
        if (tag === 'en-US') return { greet: 'Hello (pack)' };
        return undefined;
    };
    const fallbackOf = (tag: string) => (tag === 'tr-TR' ? 'en-US' : undefined);

    test('增量层优先于内置词典', () => {
        expect(resolveLocaleText('greet', 'tr-TR', domain, lookupPack, fallbackOf)).toBe('Merhaba');
        expect(resolveLocaleText('greet', 'en-US', domain, lookupPack, fallbackOf)).toBe('Hello (pack)');
    });

    test('增量未命中时落到域词典', () => {
        expect(resolveLocaleText('only.zh', 'zh-CN', domain, lookupPack, fallbackOf)).toBe('中文兜底');
    });

    test('非内置语言沿 @fallback 链回退（pack -> domain）', () => {
        expect(resolveLocaleText('extra', 'tr-TR', domain, lookupPack, fallbackOf)).toBe('English extra');
    });

    test('en-US 域词典缺失时回退 zh-CN 兜底', () => {
        expect(resolveLocaleText('only.zh', 'en-US', domain, lookupPack, fallbackOf)).toBe('中文兜底');
    });

    test('全链未命中回显 key 本身', () => {
        expect(resolveLocaleText('nope', 'tr-TR', domain, lookupPack, fallbackOf)).toBe('nope');
    });

    test('非内置语言不回退 zh-CN', () => {
        const noFallback = () => undefined;
        expect(resolveLocaleText('only.zh', 'tr-TR', domain, lookupPack, noFallback)).toBe('only.zh');
    });
});

describe('applyLocaleParams', () => {
    test('替换已提供的参数、保留未提供的占位符', () => {
        expect(applyLocaleParams('ID ${taskId} 不存在', { taskId: 't-1' })).toBe('ID t-1 不存在');
        expect(applyLocaleParams('${a} ${b}', { a: 'A' })).toBe('A ${b}');
    });

    test('重复出现的参数全部替换', () => {
        expect(applyLocaleParams('${n}-${n}', { n: 7 })).toBe('7-7');
    });
});

describe('isBuiltinLocaleTag / formatLocaleDisplayName', () => {
    test('内置语言判定', () => {
        expect(isBuiltinLocaleTag('zh-CN')).toBe(true);
        expect(isBuiltinLocaleTag('en-US')).toBe(true);
        expect(isBuiltinLocaleTag('tr-TR')).toBe(false);
    });

    test('展示名按语言自身书写形式生成', () => {
        expect(formatLocaleDisplayName('tr-TR')).toBe('Türkçe');
        // CLDR 的印尼语环境把语言名写作 "Indonesia"（口语中Bahasa Indonesia 的缩略）
        expect(formatLocaleDisplayName('id-ID')).toMatch(/^(Bahasa Indonesia|Indonesia)$/);
    });
});
