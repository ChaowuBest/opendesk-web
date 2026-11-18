import { jest } from '@jest/globals';
import { getLocalePackStore, type LocalePackSnapshot } from '../../../locale/packs.js';
import { translateWithDomain } from '../../../locale/index.js';

const pack = (tag: string, entries: Record<string, string>, fallback?: string, priority = 1) => ({
    tag,
    fallback,
    priority,
    entries,
    sourceFile: `locales/${tag}.json`
});

describe('LocaleStore', () => {
    let notified: LocalePackSnapshot[];
    let unsubscribe: () => void;

    beforeEach(() => {
        getLocalePackStore().clear();
        notified = [];
        unsubscribe = getLocalePackStore().subscribe((snapshot) => notified.push(snapshot));
    });

    afterEach(() => {
        unsubscribe();
        getLocalePackStore().clear();
    });

    test('可用语言 = 内置语言 ∪ 语言包声明语言（排序去重）', () => {
        expect(getLocalePackStore().getAvailableLocales()).toEqual(['en-US', 'zh-CN']);
        getLocalePackStore().replacePluginPacks('pack-tr', [pack('tr-TR', {})]);
        getLocalePackStore().replacePluginPacks('pack-id', [pack('id-ID', {}), pack('en-US', {})]);
        expect(getLocalePackStore().getAvailableLocales()).toEqual(['en-US', 'id-ID', 'tr-TR', 'zh-CN']);
    });

    test('同语言多插件按 ID 字典序合并，后者胜', () => {
        getLocalePackStore().replacePluginPacks('beta', [pack('tr-TR', { key: 'beta' })]);
        getLocalePackStore().replacePluginPacks('alpha', [pack('tr-TR', { key: 'alpha', only: 'alpha' })]);
        const merged = getLocalePackStore().getMergedPack('tr-TR');
        expect(merged?.entries).toEqual({ key: 'beta', only: 'alpha' });
        expect(merged?.conflicts).toEqual([{ key: 'key', winner: 'beta', losers: ['alpha'] }]);
    });

    test('同语言多插件按 priority 合并，高 priority 胜（与注册/ID 顺序无关）', () => {
        getLocalePackStore().replacePluginPacks('zeta', [pack('tr-TR', { key: 'zeta' }, undefined, 1)]);
        getLocalePackStore().replacePluginPacks('alpha', [pack('tr-TR', { key: 'alpha' }, undefined, 9)]);
        const merged = getLocalePackStore().getMergedPack('tr-TR');
        expect(merged?.entries.key).toBe('alpha');
        expect(merged?.conflicts).toEqual([{ key: 'key', winner: 'alpha', losers: ['zeta'] }]);
    });

    test('合并冲突在缓存重建时输出 warn 日志（含 key 与胜负插件）', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            getLocalePackStore().replacePluginPacks('alpha', [pack('tr-TR', { key: 'alpha' })]);
            warnSpy.mockClear();
            getLocalePackStore().replacePluginPacks('beta', [pack('tr-TR', { key: 'beta' })]);
            // replacePluginPacks 使缓存失效；下一次 getMergedPack 重建并告警一次
            getLocalePackStore().getMergedPack('tr-TR');
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0][0]).toContain('[locale-packs]');
            expect(warnSpy.mock.calls[0][0]).toContain('key (beta over alpha)');
            // 缓存命中不再重复告警
            getLocalePackStore().getMergedPack('tr-TR');
            expect(warnSpy).toHaveBeenCalledTimes(1);
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('插件移除后增量即时消失且缓存失效', () => {
        getLocalePackStore().replacePluginPacks('alpha', [pack('tr-TR', { key: 'alpha' })]);
        expect(getLocalePackStore().getMergedPack('tr-TR')?.entries.key).toBe('alpha');
        getLocalePackStore().removePluginPacks('alpha');
        expect(getLocalePackStore().getMergedPack('tr-TR')).toBeUndefined();
        expect(getLocalePackStore().getAvailableLocales()).toEqual(['en-US', 'zh-CN']);
    });

    test('同插件重复登记整体替换（覆盖安装语义）', () => {
        getLocalePackStore().replacePluginPacks('alpha', [pack('tr-TR', { a: '1' }), pack('id-ID', { b: '1' })]);
        getLocalePackStore().replacePluginPacks('alpha', [pack('tr-TR', { a: '2' })]);
        expect(getLocalePackStore().getMergedPack('tr-TR')?.entries).toEqual({ a: '2' });
        expect(getLocalePackStore().getMergedPack('id-ID')).toBeUndefined();
    });

    test('快照按 tag 组织增量与 fallback，冲突单列', () => {
        getLocalePackStore().replacePluginPacks('alpha', [
            pack('tr-TR', { greet: 'Merhaba' }, 'en-US'),
            pack('en-US', { 'override.only': 'pack' })
        ]);
        const snapshot = getLocalePackStore().getSnapshot();
        expect(snapshot.incrementsByTag['tr-TR']).toEqual({ greet: 'Merhaba' });
        expect(snapshot.fallbackByTag['tr-TR']).toBe('en-US');
        expect(snapshot.incrementsByTag['en-US']).toEqual({ 'override.only': 'pack' });
        expect(snapshot.availableLocales).toContain('tr-TR');
        expect(snapshot.conflicts['tr-TR']).toBeUndefined();
    });

    test('变更通知按注册顺序分发且快照一致', () => {
        expect(notified.length).toBe(0);
        getLocalePackStore().replacePluginPacks('alpha', [pack('tr-TR', { key: 'v' })]);
        expect(notified.length).toBe(1);
        expect(notified[0]).toEqual(getLocalePackStore().getSnapshot());
        expect(notified[0].incrementsByTag['tr-TR']).toEqual({ key: 'v' });
    });

    test('未登记任何包时合并结果为空且不影响内置语言查找', () => {
        getLocalePackStore().clear();
        expect(getLocalePackStore().getMergedPack('zh-CN')).toBeUndefined();
        expect(getLocalePackStore().getPackFallback('zh-CN')).toBeUndefined();
    });

    test('translateWithDomain 委托统一查找链（增量 -> 域词典 -> fallback -> zh-CN 兜底 -> key）', () => {
        getLocalePackStore().clear();
        const domain = {
            'zh-CN': { 'app.greet': '你好', 'only.zh': '仅中文' },
            'en-US': { 'app.greet': 'Hello', extra: 'English extra' }
        };
        // 无增量时等价于内置词典查找
        expect(translateWithDomain('app.greet', domain, undefined, 'zh-CN')).toBe('你好');
        expect(translateWithDomain('only.zh', domain, undefined, 'en-US')).toBe('仅中文');
        // 登记语言包后增量优先、未命中 key 沿 @fallback 回退 en-US
        getLocalePackStore().replacePluginPacks('alpha', [
            {
                tag: 'tr-TR',
                fallback: 'en-US',
                priority: 1,
                entries: { 'app.greet': 'Merhaba' },
                sourceFile: 'locales/tr-TR.json'
            }
        ]);
        expect(translateWithDomain('app.greet', domain, undefined, 'tr-TR')).toBe('Merhaba');
        expect(translateWithDomain('extra', domain, undefined, 'tr-TR')).toBe('English extra');
        expect(translateWithDomain('missing', domain, undefined, 'tr-TR')).toBe('missing');
        // 插值经同一链路生效
        expect(translateWithDomain('app.greet', domain, { who: 'X' }, 'zh-CN')).toBe('你好');
    });

    test('translateWithDomain 带 bundleName 时优先命中语言包的 <bundle>.<key>', () => {
        getLocalePackStore().clear();
        const domain = {
            'zh-CN': { 'app.name': '笔记' },
            'en-US': { 'app.name': 'Notes' }
        };
        getLocalePackStore().replacePluginPacks('pack-tr', [
            {
                tag: 'tr-TR',
                fallback: 'en-US',
                priority: 1,
                entries: { 'notes.app.name': 'Notlar', 'app.name': 'Ortak Ad' },
                sourceFile: 'locales/tr-TR.json'
            }
        ]);
        // 前缀命中：应用拿到自己的显示名，而不是共享层的 "Ortak Ad"
        expect(translateWithDomain('app.name', domain, undefined, 'tr-TR', 'notes')).toBe('Notlar');
        // 不带 bundle 的调用（全局 t()）仍走裸 key
        expect(translateWithDomain('app.name', domain, undefined, 'tr-TR')).toBe('Ortak Ad');
        // 前缀未命中时回退裸 key，再回退域词典
        getLocalePackStore().replacePluginPacks('pack-tr', [
            {
                tag: 'tr-TR',
                fallback: 'en-US',
                priority: 1,
                entries: { 'app.name': 'Ortak Ad' },
                sourceFile: 'locales/tr-TR.json'
            }
        ]);
        expect(translateWithDomain('app.name', domain, undefined, 'tr-TR', 'notes')).toBe('Ortak Ad');
        getLocalePackStore().replacePluginPacks('pack-tr', [
            { tag: 'tr-TR', fallback: 'en-US', priority: 1, entries: {}, sourceFile: 'locales/tr-TR.json' }
        ]);
        expect(translateWithDomain('app.name', domain, undefined, 'tr-TR', 'notes')).toBe('Notes');
    });

    test('getSlimSnapshot 只带生效语言与回退语言的增量，availableLocales 保持全量', () => {
        getLocalePackStore().clear();
        getLocalePackStore().replacePluginPacks('pack-tr', [
            {
                tag: 'tr-TR',
                fallback: 'en-US',
                priority: 1,
                entries: { greet: 'Merhaba' },
                sourceFile: 'locales/tr-TR.json'
            }
        ]);
        getLocalePackStore().replacePluginPacks('pack-de', [
            {
                tag: 'de-DE',
                fallback: 'en-US',
                priority: 1,
                entries: { greet: 'Hallo' },
                sourceFile: 'locales/de-DE.json'
            }
        ]);
        const slim = getLocalePackStore().getSlimSnapshot('tr-TR');
        // 只含生效语言 + 其回退语言（en-US 无增量则缺席）
        expect(Object.keys(slim.incrementsByTag)).toEqual(['tr-TR']);
        expect(slim.incrementsByTag['tr-TR']).toEqual({ greet: 'Merhaba' });
        expect(slim.fallbackByTag['tr-TR']).toBe('en-US');
        // 语言选择器需要的可用集合不受瘦身影响
        expect(slim.availableLocales).toEqual(['de-DE', 'en-US', 'tr-TR', 'zh-CN']);
        expect(slim.revisionsByTag['tr-TR']).toBeGreaterThan(0);
    });

    test('无 @fallback 的语言，瘦身快照不携带 en-US 增量（与重建指纹口径互洽）', () => {
        getLocalePackStore().clear();
        getLocalePackStore().replacePluginPacks('pack-tr', [pack('tr-TR', { greet: 'Merhaba' })]);
        getLocalePackStore().replacePluginPacks('pack-en', [pack('en-US', { greet: 'Hello' })]);
        // tr-TR 未声明 @fallback：取词链 resolveLocaleText 虽缺省回退 en-US，
        // 但瘦身快照不携带 en-US 增量，en-US 词条变化不可能影响该语言显示；
        // 应用视图重建指纹 activeLocalePackKey 据此只跟踪声明过的 fallback。
        // 若破坏本不变式（如恒定带上 en-US），指纹将漏判 en-US 词条变化导致
        // 应用视图滞留旧文案，必须与 activeLocalePackKey / getSlimSnapshot 同步修改
        const slim = getLocalePackStore().getSlimSnapshot('tr-TR');
        expect(slim.incrementsByTag['en-US']).toBeUndefined();
        expect(Object.keys(slim.incrementsByTag)).toEqual(['tr-TR']);
    });

    test('修订号随插件变更单调自增，快照可据此检测词条变化', () => {
        getLocalePackStore().clear();
        getLocalePackStore().replacePluginPacks('alpha', [pack('tr-TR', { a: '1' })]);
        const first = getLocalePackStore().getSnapshot().revisionsByTag['tr-TR'];
        getLocalePackStore().replacePluginPacks('beta', [pack('tr-TR', { b: '1' })]);
        const second = getLocalePackStore().getSnapshot().revisionsByTag['tr-TR'];
        expect(second).toBeGreaterThan(first);
        // 无关语言变更不影响本 tag 修订号
        getLocalePackStore().replacePluginPacks('gamma', [pack('de-DE', { c: '1' })]);
        expect(getLocalePackStore().getSnapshot().revisionsByTag['tr-TR']).toBe(second);
        // 移除时再自增
        getLocalePackStore().removePluginPacks('alpha');
        expect(getLocalePackStore().getSnapshot().revisionsByTag['tr-TR']).toBeGreaterThan(second);
    });
});
