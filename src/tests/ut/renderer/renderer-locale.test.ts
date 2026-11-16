import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    createRendererTranslator,
    createTranslator,
    resolveRendererLocale,
    type RendererLocalePackSnapshot
} from '../../../renderer/locale.ts';

const snapshotOf = (availableLocales: string[]): RendererLocalePackSnapshot => ({
    incrementsByTag: {},
    fallbackByTag: {},
    availableLocales
});

describe('resolveRendererLocale 语言包可用性门控', () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
    let installedSnapshot: RendererLocalePackSnapshot | null = null;

    beforeEach(() => {
        installedSnapshot = null;
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });
        Object.defineProperty(globalThis, 'window', {
            value: {
                localeAPI: {
                    getLocalePacks: () => installedSnapshot,
                    onLocalePacksChanged: () => () => undefined
                }
            },
            configurable: true
        });
    });

    afterEach(() => {
        Object.defineProperty(globalThis, 'navigator', {
            value: originalNavigator,
            configurable: true
        });
        Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    });

    test('快照就绪时显式 locale 命中可用集合（含语言包语言）', () => {
        installedSnapshot = snapshotOf(['en-US', 'tr-TR', 'zh-CN']);
        expect(resolveRendererLocale({ locale: 'tr-TR' })).toBe('tr-TR');
        // 非规范写法规范化后命中，返回规范化 tag 保证词典按同一口径查找
        expect(resolveRendererLocale({ locale: 'tr_TR' })).toBe('tr-TR');
        expect(resolveRendererLocale({ locale: 'tr-TR', resolved_locale: 'zh-CN' })).toBe('tr-TR');
        expect(resolveRendererLocale({ locale: 'en-US' })).toBe('en-US');
        expect(resolveRendererLocale({ locale: 'auto', resolved_locale: 'zh-CN' })).toBe('zh-CN');
    });

    test('语言包卸载后的残留 locale 让位于主进程解析的 resolved_locale', () => {
        // main 侧已把残留值回退为系统语言（zh-CN），renderer 不得再采用 tr-TR
        installedSnapshot = snapshotOf(['en-US', 'zh-CN']);
        expect(resolveRendererLocale({ locale: 'tr-TR', resolved_locale: 'zh-CN' })).toBe('zh-CN');
        expect(resolveRendererLocale({ locale: 'tr-TR' })).toBe('zh-CN');
    });

    test('快照未就绪时按内置语言判定，残留 tag 不被当作可用', () => {
        installedSnapshot = null;
        expect(resolveRendererLocale({ locale: 'tr-TR', resolved_locale: 'zh-CN' })).toBe('zh-CN');
        expect(resolveRendererLocale({ locale: 'en-US' })).toBe('en-US');
        expect(resolveRendererLocale('zh-CN')).toBe('zh-CN');
        // auto 在无快照时退回内置集合内的系统语言最佳匹配
        expect(resolveRendererLocale('auto')).toBe('zh-CN');
    });

    test('字符串形式设置同样按快照可用集合解析', () => {
        installedSnapshot = snapshotOf(['en-US', 'tr-TR', 'zh-CN']);
        expect(resolveRendererLocale('tr-TR')).toBe('tr-TR');
        expect(resolveRendererLocale('tr_TR')).toBe('tr-TR');
        installedSnapshot = snapshotOf(['en-US', 'zh-CN']);
        // 残留值回退系统语言（navigator 为 zh-CN）
        expect(resolveRendererLocale('tr-TR')).toBe('zh-CN');
    });

    test('createTranslator 在快照更新后自动纠正有效语言（无需重建翻译器）', () => {
        // 模拟未接入 onLocalePacksChanged 的组件：翻译器持有 tr-TR（语言包语言），
        // 卸载该语言包（推送不含 tr-TR 的新快照）后下一次 t() 应回退系统语言 zh-CN
        installedSnapshot = snapshotOf(['en-US', 'tr-TR', 'zh-CN']);
        const t = createRendererTranslator({ locale: 'tr-TR' });
        expect(t('renderer.sidebar.apps')).toBe('Apps');
        installedSnapshot = snapshotOf(['en-US', 'zh-CN']);
        expect(t('renderer.sidebar.apps')).toBe('应用');
    });

    test('createTranslator 带 bundleName 时优先命中语言包的 <bundle>.<key>', () => {
        const notesDomain = { 'en-US': { 'app.name': 'Notes' }, 'zh-CN': { 'app.name': '笔记' } };
        installedSnapshot = {
            incrementsByTag: { 'tr-TR': { 'notes.app.name': 'Notlar', 'app.name': 'Ortak Ad' } },
            fallbackByTag: { 'tr-TR': 'en-US' },
            availableLocales: ['en-US', 'tr-TR', 'zh-CN']
        };
        // 不带 bundle（全局组件）命中裸 key 共享层
        expect(createRendererTranslator({ locale: 'tr-TR' })('app.name')).toBe('Ortak Ad');
        // 带 bundle（notes 应用包装）优先命中前缀 key，拿到自己的显示名
        const notesT = createTranslator(notesDomain, { locale: 'tr-TR' }, 'notes');
        expect(notesT('app.name')).toBe('Notlar');
        // 前缀未命中时回退裸 key，再回退域词典
        installedSnapshot = {
            incrementsByTag: { 'tr-TR': { 'app.name': 'Ortak Ad' } },
            fallbackByTag: {},
            availableLocales: ['en-US', 'tr-TR', 'zh-CN']
        };
        expect(notesT('app.name')).toBe('Ortak Ad');
        installedSnapshot = snapshotOf(['en-US', 'tr-TR', 'zh-CN']);
        expect(notesT('app.name')).toBe('Notes');
    });
});

describe('createTranslator 跟随 setting:changed（系统语言切换 / 应用内语言切换）', () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
    let installedSnapshot: RendererLocalePackSnapshot | null = null;
    let broadcastHandler: ((setting: unknown) => void) | undefined;

    const resetEnvironment = async (): Promise<void> => {
        installedSnapshot = null;
        broadcastHandler = undefined;
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });
        Object.defineProperty(globalThis, 'window', {
            value: {
                localeAPI: {
                    getLocalePacks: () => installedSnapshot,
                    onLocalePacksChanged: () => () => undefined
                },
                settingAPI: {
                    // 模拟 preload 的共享订阅通道：捕获首个订阅者，测试直接触发广播
                    onSettingChanged: (callback: (setting: unknown) => void) => {
                        broadcastHandler = callback;
                    }
                }
            },
            configurable: true
        });
        // 模块级广播缓存需要全新实例，避免跨用例污染
        jest.resetModules();
        return import('../../../renderer/locale.ts');
    };

    afterEach(() => {
        Object.defineProperty(globalThis, 'navigator', {
            value: originalNavigator,
            configurable: true
        });
        Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
        jest.resetModules();
    });

    test('无参翻译器跟随主进程广播的生效语言（系统语言切换场景）', async () => {
        const { createRendererTranslator } = await resetEnvironment();
        const t = createRendererTranslator();
        // 广播前按 navigator 探测（zh-CN），启动行为不变
        expect(t('renderer.sidebar.apps')).toBe('应用');
        // 模拟 main 在系统语言切换后广播 setting:changed（resolved_locale 已按新系统语言解析）
        broadcastHandler?.({ locale: 'auto', resolved_locale: 'en-US' });
        expect(t('renderer.sidebar.apps')).toBe('Apps');
    });

    test('对象形式 setting 原地更新 resolved_locale 后翻译器跟随（应用内语言切换场景）', async () => {
        const { createRendererTranslator } = await resetEnvironment();
        const setting = { locale: 'auto', resolved_locale: 'zh-CN' };
        const t = createRendererTranslator(setting);
        expect(t('renderer.sidebar.apps')).toBe('应用');
        // 组件在 setting:changed 里原地更新同一个 setting 对象而非重建翻译器
        setting.resolved_locale = 'en-US';
        expect(t('renderer.sidebar.apps')).toBe('Apps');
    });

    test('显式 locale 优先级高于广播：用户选定语言不随系统语言切换', async () => {
        const { createRendererTranslator } = await resetEnvironment();
        installedSnapshot = snapshotOf(['en-US', 'tr-TR', 'zh-CN']);
        const t = createRendererTranslator({ locale: 'tr-TR' });
        expect(t('renderer.sidebar.apps')).toBe('Apps');
        broadcastHandler?.({ locale: 'auto', resolved_locale: 'zh-CN' });
        // 显式 tr-TR 保持不变（词典缺失按 @fallback 回退 en-US），不得被广播覆盖为 zh-CN
        expect(t('renderer.sidebar.apps')).toBe('Apps');
    });

    test('广播中的残留 locale 不可用时回退 navigator 系统语言', async () => {
        const { createRendererTranslator } = await resetEnvironment();
        installedSnapshot = snapshotOf(['en-US', 'zh-CN']);
        const t = createRendererTranslator();
        broadcastHandler?.({ locale: 'tr-TR', resolved_locale: 'tr-TR' });
        // tr-TR 不在快照可用集合中（语言包已卸载），按 navigator（zh-CN）解析
        expect(t('renderer.sidebar.apps')).toBe('应用');
    });
});
