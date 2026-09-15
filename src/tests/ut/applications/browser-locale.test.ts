import { zhCn as browserZhCn } from '../../../main/applications/browser/locale/zh-cn.js';
import { enUs as browserEnUs } from '../../../main/applications/browser/locale/en-us.js';
import { t as browserT } from '../../../main/applications/browser/locale/index.js';
import { createTranslatorForBrowser } from '../../../main/applications/browser/locale/renderer.js';
import { zhCn as appZhCn } from '../../../locale/zh-cn.js';
import { enUs as appEnUs } from '../../../locale/en-us.js';
import { setRuntimeLocale } from '../../../locale/index.js';
import { resolveRendererLocale } from '../../../renderer/locale.js';

function keyDiff(a: Record<string, string>, b: Record<string, string>): string[] {
    const missingInB = Object.keys(a).filter((k) => !(k in b));
    const missingInA = Object.keys(b).filter((k) => !(k in a));
    return [...missingInB, ...missingInA];
}

describe('browser locale', () => {
    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('per-app zh-CN and en-US dictionaries have identical key sets', () => {
        expect(keyDiff(browserZhCn, browserEnUs)).toEqual([]);
    });

    test('main-process t() follows the active locale and interpolates params', () => {
        setRuntimeLocale('zh-CN');
        expect(browserT('app.name')).toBe('浏览器');
        expect(browserT('error.sessionNotInitialized')).toBe('浏览器会话未初始化');
        expect(browserT('message.cookiesCleared', { count: 5 })).toBe('已清除 5 个 Cookie');

        setRuntimeLocale('en-US');
        expect(browserT('app.name')).toBe('Browser');
        expect(browserT('error.sessionNotInitialized')).toBe('Browser session not initialized');
        expect(browserT('message.certImported', { name: 'RootCA' })).toBe(
            'Certificate "RootCA" imported. Restart OpenDesk to apply it.'
        );
    });

    test('main-process t() returns the key itself for unknown keys', () => {
        expect(browserT('browser.does.not.exist')).toBe('browser.does.not.exist');
    });

    test('renderer translator resolves locale from setting and interpolates params', () => {
        expect(createTranslatorForBrowser({ locale: 'zh-CN' })('renderer.browser.menu.history')).toBe('历史记录');
        expect(createTranslatorForBrowser({ locale: 'en-US' })('renderer.browser.menu.history')).toBe('History');
        expect(
            createTranslatorForBrowser({ locale: 'zh-CN' })('renderer.browser.snapshot.failed.message', {
                message: 'x'
            })
        ).toBe('快照导出失败：x');
        expect(createTranslatorForBrowser({ locale: 'en-US' })('renderer.browser.fav.barWithCount', { count: 4 })).toBe(
            'Bookmarks Bar (4)'
        );
    });

    test('locale switch detection matches the hot-swap contract', () => {
        // onSettingChanged 广播的是原始 setting（无 resolved_locale），显式语言必须能直接命中
        expect(resolveRendererLocale({ locale: 'zh-CN', resolved_locale: 'zh-CN' })).toBe('zh-CN');
        expect(resolveRendererLocale({ locale: 'en-US' })).toBe('en-US');
        // loadSettingObject 附带 resolved_locale，auto 设置按主进程解析结果渲染
        expect(resolveRendererLocale({ locale: 'auto', resolved_locale: 'zh-CN' })).toBe('zh-CN');
        expect(resolveRendererLocale({ locale: 'auto', resolved_locale: 'en-US' })).toBe('en-US');
        expect(resolveRendererLocale('en-US')).toBe('en-US');

        const needsRefresh = (prev: unknown, next: unknown) =>
            resolveRendererLocale(next) !== resolveRendererLocale(prev);
        expect(needsRefresh({ locale: 'zh-CN', resolved_locale: 'zh-CN' }, { locale: 'zh-CN' })).toBe(false);
        expect(needsRefresh({ locale: 'zh-CN', resolved_locale: 'zh-CN' }, { locale: 'en-US' })).toBe(true);
        expect(needsRefresh({ locale: 'auto', resolved_locale: 'zh-CN' }, { locale: 'en-US' })).toBe(true);

        // 翻译器按新设置重建后输出随即切换（浏览器 widget 的就地刷新依赖此契约）
        let currentSetting: unknown = { locale: 'auto', resolved_locale: 'zh-CN' };
        const t = () => createTranslatorForBrowser(currentSetting as { locale?: string });
        expect(t()('renderer.browser.toolbar.back')).toBe('后退');
        currentSetting = { locale: 'en-US' };
        expect(t()('renderer.browser.toolbar.back')).toBe('Back');
        expect(t()('renderer.browser.menu.clearData')).toBe('Clear browsing data');
    });

    test('browser-specific keys stay out of the OpenDesk core locale (no pollution)', () => {
        // renderer.browser.pageHints* 是共享组件（browserHintPanel）的键，合法存在于主 locale
        const sharedComponentKeys = Object.keys(appZhCn).filter((k) => k.startsWith('renderer.browser.pageHints'));
        expect(sharedComponentKeys.length).toBeGreaterThan(0);
        for (const key of Object.keys(browserZhCn)) {
            // app.name 是各应用共用的通用键
            if (key === 'app.name') continue;
            expect(key in appZhCn).toBe(false);
            expect(key in appEnUs).toBe(false);
        }
    });

    test('internal page titles resolve to the locale dictionaries (no hardcoded zh labels)', () => {
        // 回归：getInternalPageTitle 曾写死中文，英文模式下新标签页仍显示"新标签页"。
        // 内部页标题必须经由词条取词，且中英词条都非空、互不相同的 key 命中预期词。
        for (const key of [
            'renderer.browser.fav.manageTitle',
            'renderer.browser.history.title',
            'renderer.browser.tab.new'
        ]) {
            expect(browserZhCn[key].length).toBeGreaterThan(0);
            expect(browserEnUs[key].length).toBeGreaterThan(0);
        }
        expect(browserEnUs['renderer.browser.tab.new']).toBe('New Tab');
        expect(browserEnUs['renderer.browser.history.title']).toBe('History');
        expect(browserEnUs['renderer.browser.fav.manageTitle']).toBe('Bookmark Manager');
        expect(browserZhCn['renderer.browser.tab.new']).toBe('新标签页');
    });
});
