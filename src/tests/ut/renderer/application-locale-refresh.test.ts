import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

/**
 * 应用视图的语言跟随（关闭重建策略）：
 * 应用 iframe 是宿主窗口的子 frame，收不到主进程的 setting:changed /
 * locale:packsChanged 广播，无法原地跟随语言切换。生效语言变化或当前语言的
 * 语言包词条变化时，宿主必须重建应用视图（重开后按最新语言全新渲染）。
 * 覆盖判定器行为 + 主窗口关闭逻辑 + index.html / application_window.html 的接线。
 */

import {
    activeLocalePackKey,
    closeAllOpenApplicationViews,
    createLocaleAppViewRefresher
} from '../../../renderer/scripts/application-locale-refresh.js';

function makeSnapshot(
    incrementsByTag: Record<string, Record<string, string>>,
    fallbackByTag: Record<string, string> = {}
) {
    return {
        incrementsByTag,
        fallbackByTag,
        availableLocales: ['zh-CN', 'en-US', ...Object.keys(incrementsByTag)]
    };
}

function makeHost() {
    const removed: string[] = [];
    const frames: Record<string, { remove(): unknown }> = {};
    const inlineApps: Array<{ remove(): unknown }> = [];
    let homeOpened = 0;
    const nonAppSlot = {
        querySelectorAll(selectors: string) {
            expect(selectors).toBe('[data-inline-app]');
            return inlineApps;
        }
    };
    return {
        host: {
            appFrameCache: frames,
            nonAppSlot,
            currentOpenAppBundleName: null as string | null,
            openHomePage() {
                homeOpened++;
            }
        },
        frames,
        inlineApps,
        removed,
        addFrame(bundleName: string) {
            const frame = {
                remove() {
                    removed.push(bundleName);
                    delete frames[bundleName];
                }
            };
            frames[bundleName] = frame;
            return frame;
        },
        homeOpenedCount: () => homeOpened
    };
}

describe('closeAllOpenApplicationViews', () => {
    test('销毁全部驻留 iframe 与内联应用，前台是应用时回主页', () => {
        const env = makeHost();
        env.host.currentOpenAppBundleName = 'notes';
        env.addFrame('notes');
        env.addFrame('calendar');
        const inlineBrowser = { remove: jest.fn() };
        env.inlineApps.push(inlineBrowser);

        const closed = closeAllOpenApplicationViews(env.host);

        expect(closed).toBe(true);
        expect(env.removed.sort()).toEqual(['calendar', 'notes']);
        expect(Object.keys(env.frames)).toEqual([]);
        expect(inlineBrowser.remove).toHaveBeenCalled();
        expect(env.homeOpenedCount()).toBe(1);
    });

    test('前台不是应用视图时只清理后台驻留，不切换视图', () => {
        const env = makeHost();
        env.host.currentOpenAppBundleName = null;
        env.addFrame('notes');
        env.inlineApps.push({ remove: jest.fn() });

        const closed = closeAllOpenApplicationViews(env.host);

        expect(closed).toBe(false);
        expect(env.removed).toEqual(['notes']);
        expect(env.homeOpenedCount()).toBe(0);
    });
});

describe('createLocaleAppViewRefresher', () => {
    test('生效语言变化触发一次重建，首次记录是基线', () => {
        const rebuild = jest.fn();
        const refresher = createLocaleAppViewRefresher(rebuild);

        refresher.recordLocale('en-US');
        expect(rebuild).not.toHaveBeenCalled();

        refresher.recordLocale('en-US');
        expect(rebuild).not.toHaveBeenCalled();

        refresher.recordLocale('tr-TR');
        expect(rebuild).toHaveBeenCalledTimes(1);

        refresher.recordLocale('tr-TR');
        expect(rebuild).toHaveBeenCalledTimes(1);
    });

    test('当前语言的语言包词条变化触发重建；无关语言变化不触发', () => {
        const rebuild = jest.fn();
        const refresher = createLocaleAppViewRefresher(rebuild);
        refresher.recordLocale('tr-TR');

        // 基线：tr 包已装
        refresher.recordPackSnapshot(makeSnapshot({ 'tr-TR': { 'app.name': 'Notlar' } }));
        expect(rebuild).not.toHaveBeenCalled();

        // 无关语言（fr）新增包：当前语言词条不变，不重建
        refresher.recordPackSnapshot(
            makeSnapshot({ 'tr-TR': { 'app.name': 'Notlar' }, 'fr-FR': { 'app.name': 'Notes' } })
        );
        expect(rebuild).not.toHaveBeenCalled();

        // 当前语言词条更新（修文案 / 新增 key）：重建
        refresher.recordPackSnapshot(makeSnapshot({ 'tr-TR': { 'app.name': 'Notlar', 'renderer.note.new': 'Yeni' } }));
        expect(rebuild).toHaveBeenCalledTimes(1);
    });

    test('当前语言的回退链变化（@fallback 或回退语言词条）触发重建', () => {
        const rebuild = jest.fn();
        const refresher = createLocaleAppViewRefresher(rebuild);
        refresher.recordLocale('tr-TR');

        refresher.recordPackSnapshot(makeSnapshot({ 'tr-TR': { 'app.name': 'Notlar' } }, { 'tr-TR': 'en-US' }));
        expect(rebuild).not.toHaveBeenCalled();

        // @fallback 改成 zh-CN：回退链变化会改变缺 key 时的展示，重建
        refresher.recordPackSnapshot(makeSnapshot({ 'tr-TR': { 'app.name': 'Notlar' } }, { 'tr-TR': 'zh-CN' }));
        expect(rebuild).toHaveBeenCalledTimes(1);

        // 回退语言（en-US 为内置语言，词条可被包覆盖）的增量变化：重建
        refresher.recordPackSnapshot(
            makeSnapshot({ 'tr-TR': { 'app.name': 'Notlar' }, 'en-US': { 'app.name': 'Memos' } }, { 'tr-TR': 'en-US' })
        );
        expect(rebuild).toHaveBeenCalledTimes(2);
    });

    test('内置语言只看自身增量，回退变化不触发重建', () => {
        const rebuild = jest.fn();
        const refresher = createLocaleAppViewRefresher(rebuild);
        refresher.recordLocale('en-US');

        refresher.recordPackSnapshot(makeSnapshot({}));
        expect(rebuild).not.toHaveBeenCalled();

        // en-US 词条被包覆盖（"修正官方文案"场景）：重建
        refresher.recordPackSnapshot(makeSnapshot({ 'en-US': { 'app.name': 'Memos' } }));
        expect(rebuild).toHaveBeenCalledTimes(1);
    });

    test('语言未记录或快照缺失时只记基线，不触发重建', () => {
        const rebuild = jest.fn();
        const refresher = createLocaleAppViewRefresher(rebuild);

        // 快照先于语言基线到达（启动竞态）：语言未知下只记基线
        refresher.recordPackSnapshot(makeSnapshot({ 'tr-TR': { 'app.name': 'Notlar' } }));
        expect(refresher.getLocale()).toBeNull();
        expect(rebuild).not.toHaveBeenCalled();

        // 语言基线就绪后静默重算指纹；无快照（preload 未就绪）不动基线
        refresher.recordLocale('tr-TR');
        refresher.recordPackSnapshot(null);
        expect(rebuild).not.toHaveBeenCalled();

        // 之后的真实词条变更正常触发重建
        refresher.recordPackSnapshot(makeSnapshot({ 'tr-TR': { 'app.name': 'Not Defteri' } }));
        expect(rebuild).toHaveBeenCalledTimes(1);
    });

    test('activeLocalePackKey 对非法输入返回 null', () => {
        expect(activeLocalePackKey(null, 'tr-TR')).toBeNull();
        expect(activeLocalePackKey(makeSnapshot({}), null)).toBeNull();
    });

    test('快照带修订号时用 O(1) 修订号拼指纹，不序列化增量', () => {
        const rebuild = jest.fn();
        const refresher = createLocaleAppViewRefresher(rebuild);
        refresher.recordLocale('tr-TR');

        const bigIncrement: Record<string, string> = { 'app.name': 'Notlar' };
        refresher.recordPackSnapshot({
            incrementsByTag: { 'tr-TR': bigIncrement },
            fallbackByTag: { 'tr-TR': 'en-US' },
            availableLocales: ['en-US', 'tr-TR'],
            revisionsByTag: { 'tr-TR': 1, 'en-US': 0 }
        });
        expect(rebuild).not.toHaveBeenCalled();

        // 修订号不变：即使增量对象引用被替换成新对象（内容相同），也不触发重建
        refresher.recordPackSnapshot({
            incrementsByTag: { 'tr-TR': { ...bigIncrement } },
            fallbackByTag: { 'tr-TR': 'en-US' },
            availableLocales: ['en-US', 'tr-TR'],
            revisionsByTag: { 'tr-TR': 1, 'en-US': 0 }
        });
        expect(rebuild).not.toHaveBeenCalled();

        // 修订号自增：触发重建
        refresher.recordPackSnapshot({
            incrementsByTag: { 'tr-TR': { ...bigIncrement, 'renderer.note.new': 'Yeni' } },
            fallbackByTag: { 'tr-TR': 'en-US' },
            availableLocales: ['en-US', 'tr-TR'],
            revisionsByTag: { 'tr-TR': 2, 'en-US': 0 }
        });
        expect(rebuild).toHaveBeenCalledTimes(1);

        // 回退语言修订号变化同样触发重建
        refresher.recordPackSnapshot({
            incrementsByTag: { 'tr-TR': { ...bigIncrement, 'renderer.note.new': 'Yeni' } },
            fallbackByTag: { 'tr-TR': 'en-US' },
            availableLocales: ['en-US', 'tr-TR'],
            revisionsByTag: { 'tr-TR': 2, 'en-US': 3 }
        });
        expect(rebuild).toHaveBeenCalledTimes(2);
    });
});

describe('宿主页面的接线', () => {
    let indexHtml: string;
    let appWindowHtml: string;

    beforeAll(() => {
        indexHtml = readFileSync(new URL('../../../renderer/index.html', import.meta.url), 'utf8');
        appWindowHtml = readFileSync(new URL('../../../renderer/application_window.html', import.meta.url), 'utf8');
    });

    test('index.html 建立了语言/语言包刷新守卫并注入关闭逻辑', () => {
        expect(indexHtml).toContain('application-locale-refresh');
        expect(indexHtml).toContain('createLocaleAppViewRefresher');
        expect(indexHtml).toContain('closeAllOpenApplicationViews');
        // setting:changed 与启动基线都走 recordLocale
        expect(indexHtml).toContain('recordLocale');
        // 语言包快照走 recordPackSnapshot
        expect(indexHtml).toContain('recordPackSnapshot');
    });

    test('application_window.html 语言变化时原地重挂应用 iframe', () => {
        expect(appWindowHtml).toContain('application-locale-refresh');
        expect(appWindowHtml).toContain('createLocaleAppViewRefresher');
        expect(appWindowHtml).toContain('recordLocale');
    });

    test('两个宿主注册 packsChanged 监听器后立即用 preload 缓存快照补建基线', () => {
        // preload 首拉快照的分发可能早于宿主脚本注册监听器（错过首播）；若基线完全
        // 依赖事件推送，首次真实词条变更会被误当基线吞掉、不触发重建。注册后必须
        // 立即补拉 preload 缓存快照兜底（首播未发生时缓存为 null，由首播补建基线）
        expect(indexHtml).toMatch(/recordPackSnapshot\(window\.localeAPI\.getLocalePacks\?\.?\(\)/);
        expect(appWindowHtml).toMatch(/recordPackSnapshot\(window\.localeAPI\?\.getLocalePacks\?\.?\(\)/);
    });
});
