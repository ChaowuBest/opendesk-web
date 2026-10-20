import { zhCn as searchZhCn } from '../../../main/applications/search/locale/zh-cn.js';
import { enUs as searchEnUs } from '../../../main/applications/search/locale/en-us.js';
import { t as searchT } from '../../../main/applications/search/locale/index.js';
import { createTranslatorForSearch } from '../../../main/applications/search/locale/renderer.js';
import { setRuntimeLocale } from '../../../locale/index.js';
import { zhCn as appZhCn } from '../../../locale/zh-cn.js';
import { enUs as appEnUs } from '../../../locale/en-us.js';

function keyDiff(a: Record<string, string>, b: Record<string, string>): string[] {
    const missingInB = Object.keys(a).filter((k) => !(k in b));
    const missingInA = Object.keys(b).filter((k) => !(k in a));
    return [...missingInB, ...missingInA];
}

describe('search locale', () => {
    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('per-app zh-CN and en-US dictionaries have identical key sets', () => {
        expect(keyDiff(searchZhCn, searchEnUs)).toEqual([]);
    });

    test('search keys are owned by the per-app locale, not the global dictionaries', () => {
        for (const dict of [appZhCn, appEnUs]) {
            const leaked = Object.keys(dict).filter((k) => k.startsWith('search.') || k.startsWith('sp.search.'));
            expect(leaked).toEqual([]);
        }
    });

    test('main-process t() follows the active locale (zh-CN / en-US)', () => {
        setRuntimeLocale('zh-CN');
        expect(searchT('app.name')).toBe('融合搜索');
        expect(searchT('search.deepseek.name')).toBe('搜索 (DeepSeek)');
        expect(searchT('search.doubao.name')).toBe('搜索 (豆包)');

        setRuntimeLocale('en-US');
        expect(searchT('app.name')).toBe('Fusion Search');
        expect(searchT('search.deepseek.name')).toBe('Search (DeepSeek)');
        expect(searchT('search.doubao.name')).toBe('Search (Doubao)');
    });

    test('main-process t() returns the key itself for unknown keys', () => {
        expect(searchT('search.does.not.exist')).toBe('search.does.not.exist');
    });

    test('renderer translator resolves locale from setting', () => {
        expect(createTranslatorForSearch({ locale: 'zh-CN' })('sp.search.webTitle')).toBe('网页搜索引擎');
        expect(createTranslatorForSearch({ locale: 'en-US' })('sp.search.webTitle')).toBe('Web Search Engines');
        expect(createTranslatorForSearch({ locale: 'zh-CN' })('sp.search.channel.doubao.name')).toBe('豆包');
        expect(createTranslatorForSearch({ locale: 'en-US' })('sp.search.channel.doubao.name')).toBe('Doubao');
    });
});
