import { jest } from '@jest/globals';
import { getLocalePackStore, type LocalePackSnapshot } from '../../../locale/packs.js';
import { translateWithDomain } from '../../../locale/index.js';

const pack = (tag: string, entries: Record<string, string>, fallback?: string) => ({
    tag,
    fallback,
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
            { tag: 'tr-TR', fallback: 'en-US', entries: { 'app.greet': 'Merhaba' }, sourceFile: 'locales/tr-TR.json' }
        ]);
        expect(translateWithDomain('app.greet', domain, undefined, 'tr-TR')).toBe('Merhaba');
        expect(translateWithDomain('extra', domain, undefined, 'tr-TR')).toBe('English extra');
        expect(translateWithDomain('missing', domain, undefined, 'tr-TR')).toBe('missing');
        // 插值经同一链路生效
        expect(translateWithDomain('app.greet', domain, { who: 'X' }, 'zh-CN')).toBe('你好');
    });
});
