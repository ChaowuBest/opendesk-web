import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
    createRendererTranslator,
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
});
