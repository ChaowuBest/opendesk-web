/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { zhCn } from '../locale/zh-cn.js';
import { enUs } from '../locale/en-us.js';
import { isSupportedLocale, isValidLocaleTag, resolveLocaleSetting } from '../common/locale.js';
import { applyLocaleParams, normalizeLocaleTag, resolveLocaleText } from '../common/locale/pack.js';

const translations: Record<string, Record<string, string>> = {
    'zh-CN': zhCn,
    'en-US': enUs
};

type RendererLocaleSource =
    | string
    | {
          locale?: string;
          resolved_locale?: string;
      };

/** preload localeAPI 缓存的语言包快照（与激活语言解耦，按 tag 组织） */
export interface RendererLocalePackSnapshot {
    incrementsByTag: Record<string, Record<string, string>>;
    fallbackByTag: Record<string, string>;
    availableLocales: string[];
}

interface LocaleAPIBridge {
    getLocalePacks?: () => RendererLocalePackSnapshot | null;
    onLocalePacksChanged?: (callback: (snapshot: RendererLocalePackSnapshot | null) => void) => () => void;
}

function getLocaleAPI(): LocaleAPIBridge | undefined {
    if (typeof window === 'undefined') return undefined;
    return (window as unknown as { localeAPI?: LocaleAPIBridge }).localeAPI;
}

/**
 * 同步读取当前语言包快照；preload 尚未拉取完成或非 Electron 环境（单测）时为 null，
 * 翻译器自动退化为仅内置词典。
 */
export function getLocalePackSnapshot(): RendererLocalePackSnapshot | null {
    return getLocaleAPI()?.getLocalePacks?.() ?? null;
}

/**
 * 订阅语言包变更（含 preload 首次拉取完成），供组件重建翻译器并刷新渲染。
 * 返回取消函数；无 localeAPI 时返回空操作。
 */
export function onLocalePacksChanged(callback: (snapshot: RendererLocalePackSnapshot | null) => void): () => void {
    const unsubscribe = getLocaleAPI()?.onLocalePacksChanged?.(callback);
    return unsubscribe ?? (() => undefined);
}

function getRendererPreferredLanguages(): string[] {
    if (typeof navigator === 'undefined') {
        return [];
    }
    if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
        return [...navigator.languages];
    }
    return navigator.language ? [navigator.language] : [];
}

function detectRendererLocale(): string {
    return resolveLocaleSetting('auto', getRendererPreferredLanguages(), getLocalePackSnapshot()?.availableLocales);
}

export function resolveRendererLocale(localeSource?: RendererLocaleSource): string {
    const availableLocales = getLocalePackSnapshot()?.availableLocales;
    // 显式 locale / resolved_locale 除格式合法外还须"可用"：语言包卸载后的残留 tag
    // 不在快照的 availableLocales 中，若放行会让 renderer 与 main 侧（按系统语言回退）脱节。
    // 命中时返回规范化后的 tag（如 tr_TR -> tr-TR），保证词典与增量按同一口径查找；
    // 快照未就绪（preload 首拉完成前 / 单测环境）时退回内置语言判定。
    const usableLocale = (tag: string | undefined): string | undefined => {
        const normalized = isValidLocaleTag(tag) ? normalizeLocaleTag(tag) : undefined;
        if (!normalized) return undefined;
        if (availableLocales) {
            return availableLocales.includes(normalized) ? normalized : undefined;
        }
        return isSupportedLocale(normalized) ? normalized : undefined;
    };
    if (typeof localeSource === 'object' && localeSource !== null) {
        // 保持既有优先级：显式 locale 优先（各组件改语言时只更新 locale 字段），
        // 其次主进程按语言包可用集合解析过的 resolved_locale，最后系统语言探测
        const explicit = usableLocale(localeSource.locale);
        if (explicit) {
            return explicit;
        }
        const resolved = usableLocale(localeSource.resolved_locale);
        if (resolved) {
            return resolved;
        }
        return detectRendererLocale();
    }
    return resolveLocaleSetting(localeSource, getRendererPreferredLanguages(), availableLocales);
}

/**
 * 基于给定词表创建翻译函数，供全局主界面与各应用在 renderer 侧复用自己的 locale 词条。
 *
 * 查找链（与主进程 translateWithDomain 一致）：语言包增量 -> 词表[locale] ->
 * 非 builtin 语言的 fallback（@fallback，缺省 en-US）-> en-US 时的 zh-CN 兜底 -> key。
 * 语言包增量来自 preload 缓存的快照，语言包增删后经 onLocalePacksChanged 通知重建。
 */
export function createTranslator(
    translations: Record<string, Record<string, string>>,
    localeSetting?: RendererLocaleSource
): (key: string, params?: Record<string, string | number>) => string {
    // locale 惰性解析并按快照引用缓存：语言包安装/卸载会推送新快照对象，未接入
    // onLocalePacksChanged 的组件也能在下一次 t() 时自动纠正有效语言（如当前语言包
    // 被卸载后回退系统语言），无需逐个组件补接线；快照未变时零额外解析开销。
    let cachedLocale: string | undefined;
    let cachedSnapshot: RendererLocalePackSnapshot | null | undefined;
    const resolveLocale = (): string => {
        const snapshot = getLocalePackSnapshot();
        if (cachedLocale === undefined || snapshot !== cachedSnapshot) {
            cachedLocale = resolveRendererLocale(localeSetting);
            cachedSnapshot = snapshot;
        }
        return cachedLocale;
    };
    return (key, params) => {
        const packs = getLocalePackSnapshot();
        const text = resolveLocaleText(
            key,
            resolveLocale(),
            translations,
            (tag) => packs?.incrementsByTag[tag],
            (tag) => packs?.fallbackByTag[tag]
        );
        return applyLocaleParams(text, params);
    };
}

export function createRendererTranslator(
    localeSetting?: RendererLocaleSource
): (key: string, params?: Record<string, string | number>) => string {
    return createTranslator(translations, localeSetting);
}
