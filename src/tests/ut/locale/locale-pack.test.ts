import {
    LocalePackParseError,
    applyLocaleParams,
    formatLocaleDisplayName,
    isBuiltinLocaleTag,
    mergeLocalePacks,
    normalizeLocaleTag,
    orderLocaleOptions,
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

    test('@priority 解析合并优先级（字符串与数字形式均可，缺省为 1）', () => {
        expect(parseLocalePackJson({ '@priority': '5', key: 'v' }, 'tr-TR.json').priority).toBe(5);
        expect(parseLocalePackJson({ '@priority': 3, key: 'v' }, 'tr-TR.json').priority).toBe(3);
        expect(parseLocalePackJson({ '@priority': '0', key: 'v' }, 'tr-TR.json').priority).toBe(0);
        expect(parseLocalePackJson({ '@priority': '999', key: 'v' }, 'tr-TR.json').priority).toBe(999);
        expect(parseLocalePackJson({ key: 'v' }, 'tr-TR.json').priority).toBe(1);
    });

    test('@priority 必须是 0-999 的整数', () => {
        expect(() => parseLocalePackJson({ '@priority': '-1', key: 'v' }, 'tr-TR.json')).toThrow(/@priority/);
        expect(() => parseLocalePackJson({ '@priority': '1000', key: 'v' }, 'tr-TR.json')).toThrow(/@priority/);
        expect(() => parseLocalePackJson({ '@priority': '1.5', key: 'v' }, 'tr-TR.json')).toThrow(/@priority/);
        expect(() => parseLocalePackJson({ '@priority': 'abc', key: 'v' }, 'tr-TR.json')).toThrow(/@priority/);
        expect(() => parseLocalePackJson({ '@priority': 1000, key: 'v' }, 'tr-TR.json')).toThrow(/@priority/);
        expect(() => parseLocalePackJson({ '@priority': '', key: 'v' }, 'tr-TR.json')).toThrow(/@priority/);
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
    const pack = (pluginId: string, entries: Record<string, string>, fallback?: string, priority = 1) => ({
        pluginId,
        content: { tag: 'tr-TR', fallback, priority, entries }
    });

    test('按插件 ID 字典序合并，后者覆盖前者', () => {
        const merged = mergeLocalePacks([
            pack('beta-plugin', { 'a.key': 'from-beta', 'only-beta': 'b' }),
            pack('alpha-plugin', { 'a.key': 'from-alpha', 'only-alpha': 'a' })
        ]);
        expect(merged?.entries).toEqual({ 'a.key': 'from-beta', 'only-beta': 'b', 'only-alpha': 'a' });
    });

    test('priority 高者胜，与插件 ID 无关', () => {
        const merged = mergeLocalePacks([
            pack('zeta-plugin', { 'a.key': 'from-zeta' }, undefined, 1),
            pack('alpha-plugin', { 'a.key': 'from-alpha', 'only-alpha': 'a' }, undefined, 5)
        ]);
        expect(merged?.entries).toEqual({ 'a.key': 'from-alpha', 'only-alpha': 'a' });
        expect(merged?.conflicts).toEqual([{ key: 'a.key', winner: 'alpha-plugin', losers: ['zeta-plugin'] }]);
    });

    test('priority 相同时回退插件 ID 字典序（后者胜）', () => {
        const merged = mergeLocalePacks([
            pack('beta-plugin', { 'a.key': 'from-beta' }, undefined, 2),
            pack('alpha-plugin', { 'a.key': 'from-alpha' }, undefined, 2)
        ]);
        expect(merged?.entries['a.key']).toBe('from-beta');
    });

    test('混合 priority 下的冲突报告按合并顺序记录', () => {
        const merged = mergeLocalePacks([
            pack('alpha-plugin', { 'a.key': 'from-alpha' }, undefined, 1),
            pack('beta-plugin', { 'a.key': 'from-beta' }, undefined, 2),
            pack('gamma-plugin', { 'a.key': 'from-gamma' }, undefined, 1)
        ]);
        // 合并顺序：alpha(1) -> gamma(1) -> beta(2)，最终 beta 胜
        expect(merged?.entries['a.key']).toBe('from-beta');
        expect(merged?.conflicts).toEqual([
            { key: 'a.key', winner: 'gamma-plugin', losers: ['alpha-plugin'] },
            { key: 'a.key', winner: 'beta-plugin', losers: ['alpha-plugin', 'gamma-plugin'] }
        ]);
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

    test('fallback 由 priority 最高的声明决定，平局仍按 ID 字典序', () => {
        expect(mergeLocalePacks([pack('a', {}, 'zh-CN', 9), pack('b', {}, 'en-US', 1)])?.fallback).toBe('zh-CN');
        expect(mergeLocalePacks([pack('a', {}, 'zh-CN', 1), pack('b', {}, 'en-US', 1)])?.fallback).toBe('en-US');
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

describe('resolveLocaleText 域前缀查找（应用歧义 key 按 <bundle>.<key> 覆盖）', () => {
    // 模拟 notes 应用域：app.name 在多个应用同名不同义，语言包只能用 notes.app.name 表达
    const domain = {
        'zh-CN': { 'app.name': '笔记' },
        'en-US': { 'app.name': 'Notes' }
    };
    const lookupPack = (tag: string) => {
        if (tag === 'tr-TR') return { 'notes.app.name': 'Notlar', 'app.name': 'ShellName' };
        return undefined;
    };
    const fallbackOf = (tag: string) => (tag === 'tr-TR' ? 'en-US' : undefined);

    test('带前缀时优先命中 <bundle>.<key>，屏蔽同名的共享层 key', () => {
        expect(resolveLocaleText('app.name', 'tr-TR', domain, lookupPack, fallbackOf, 'notes')).toBe('Notlar');
    });

    test('前缀未命中时回退裸 key（共享域覆盖语义保留）', () => {
        const packWithoutPrefix = (tag: string) => (tag === 'tr-TR' ? { 'app.name': 'Ortak Ad' } : undefined);
        expect(resolveLocaleText('app.name', 'tr-TR', domain, packWithoutPrefix, fallbackOf, 'notes')).toBe('Ortak Ad');
    });

    test('前缀与裸 key 都未命中时落到域词典', () => {
        const emptyPack = () => undefined;
        expect(resolveLocaleText('app.name', 'en-US', domain, emptyPack, fallbackOf, 'notes')).toBe('Notes');
    });

    test('前缀查找同样作用于 @fallback 回退链', () => {
        // tr-TR 包未命中，回退 en-US 包中带前缀的词条
        const packWithFallbackEntry = (tag: string) =>
            tag === 'en-US' ? { 'notes.app.name': 'Notes (pack)' } : undefined;
        expect(resolveLocaleText('app.name', 'tr-TR', domain, packWithFallbackEntry, fallbackOf, 'notes')).toBe(
            'Notes (pack)'
        );
    });

    test('不带前缀时行为与旧链完全一致（裸 key 优先于域词典）', () => {
        expect(resolveLocaleText('app.name', 'tr-TR', domain, lookupPack, fallbackOf)).toBe('ShellName');
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

    test('展示名统一首字母大写（各语言自身书写规范大小写不一致）', () => {
        // CLDR 的 fr 环境写作小写 français，选项列表统一为大写开头
        expect(formatLocaleDisplayName('fr-FR')).toBe('Français');
        expect(formatLocaleDisplayName('de-DE')).toBe('Deutsch');
        for (const tag of ['de-DE', 'en-US', 'fr-FR', 'id-ID', 'tr-TR']) {
            const label = formatLocaleDisplayName(tag);
            expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
        }
    });

    test('无法生成展示名时退回原始 tag（不做大小写改写）', () => {
        expect(formatLocaleDisplayName('')).toBe('');
    });
});

describe('orderLocaleOptions', () => {
    test('中文紧随默认项之后，其余按字母序', () => {
        expect(orderLocaleOptions(['zh-CN', 'en-US', 'tr-TR', 'de-DE', 'fr-FR', 'id-ID'])).toEqual([
            'zh-CN',
            'de-DE',
            'en-US',
            'fr-FR',
            'id-ID',
            'tr-TR'
        ]);
    });

    test('不修改入参，且保留同语言多区域 tag', () => {
        const input = ['zh-TW', 'en-US', 'zh-CN'];
        expect(orderLocaleOptions(input)).toEqual(['zh-CN', 'zh-TW', 'en-US']);
        expect(input).toEqual(['zh-TW', 'en-US', 'zh-CN']);
    });
});
