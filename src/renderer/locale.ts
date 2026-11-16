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
    /** 各 tag 的内容修订号（main 侧 replace/remove 时自增）；缺失时消费方退回全量比对 */
    revisionsByTag?: Record<string, number>;
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

/**
 * 主进程最近一次广播的设置（setting:changed 负载，含 resolved_locale）。
 * navigator.languages 在 Chromium 中随窗口创建固化、系统语言切换后不再更新，
 * main 按系统语言 + 语言包可用集合解析出的 resolved_locale 才是生效语言的权威值；
 * 此处缓存让未接线组件（无参翻译器）的 t() 也能跟随语言切换。
 */
let latestBroadcastSetting: { locale?: string; resolved_locale?: string } | undefined;

/**
 * 注入主进程广播的最新设置。renderer 侧由 ensureSettingChangedSubscription 自动订阅
 * setting:changed 调用；单测可直接调用以模拟广播。非对象负载忽略（main 恒发对象）。
 */
export function notifyRendererSettingChanged(setting: unknown): void {
    if (setting && typeof setting === 'object') {
        latestBroadcastSetting = setting as { locale?: string; resolved_locale?: string };
    }
}

let settingChangedSubscriptionInstalled = false;

/** 首次使用时订阅 setting:changed（preload 在页面脚本前同步挂好 settingAPI，单测环境无此通道则跳过） */
function ensureSettingChangedSubscription(): void {
    if (settingChangedSubscriptionInstalled) return;
    settingChangedSubscriptionInstalled = true;
    if (typeof window === 'undefined') return;
    const settingAPI = (
        window as unknown as {
            settingAPI?: { onSettingChanged?: (callback: (setting: unknown) => void) => void };
        }
    ).settingAPI;
    if (typeof settingAPI?.onSettingChanged !== 'function') return;
    settingAPI.onSettingChanged(notifyRendererSettingChanged);
}

/** tag 除格式合法外还须"可用"：语言包卸载后的残留 tag 不被放行，规范化后按同一口径查找 */
function usableLocaleTag(tag: string | undefined, availableLocales: string[] | undefined): string | undefined {
    const normalized = isValidLocaleTag(tag) ? normalizeLocaleTag(tag) : undefined;
    if (!normalized) return undefined;
    if (availableLocales) {
        return availableLocales.includes(normalized) ? normalized : undefined;
    }
    return isSupportedLocale(normalized) ? normalized : undefined;
}

function detectRendererLocale(): string {
    const availableLocales = getLocalePackSnapshot()?.availableLocales;
    // 主进程已广播过设置时优先采用其解析结果（resolved_locale > locale），
    // 快照未就绪 / 未收到广播时退回 navigator 系统语言探测（启动行为不变）
    const fromBroadcast =
        usableLocaleTag(latestBroadcastSetting?.resolved_locale, availableLocales) ??
        usableLocaleTag(latestBroadcastSetting?.locale, availableLocales);
    if (fromBroadcast) {
        return fromBroadcast;
    }
    return resolveLocaleSetting('auto', getRendererPreferredLanguages(), availableLocales);
}

export function resolveRendererLocale(localeSource?: RendererLocaleSource): string {
    const availableLocales = getLocalePackSnapshot()?.availableLocales;
    if (typeof localeSource === 'object' && localeSource !== null) {
        // 保持既有优先级：显式 locale 优先（各组件改语言时只更新 locale 字段），
        // 其次主进程按语言包可用集合解析过的 resolved_locale，最后系统语言探测
        const explicit = usableLocaleTag(localeSource.locale, availableLocales);
        if (explicit) {
            return explicit;
        }
        const resolved = usableLocaleTag(localeSource.resolved_locale, availableLocales);
        if (resolved) {
            return resolved;
        }
        return detectRendererLocale();
    }
    if (localeSource === undefined) {
        // 无参调用（未接入 setting 订阅的组件）：优先主进程广播的生效语言，
        // 未收到广播时 detectRendererLocale 内部退回 navigator 探测（启动行为不变）
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
    localeSetting?: RendererLocaleSource,
    bundleName?: string
): (key: string, params?: Record<string, string | number>) => string {
    // locale 惰性解析并按"语言包快照引用 + 生效设置值"缓存：语言包安装/卸载会推送新
    // 快照对象，语言切换（系统语言切换后的 setting:changed 重播 / 应用内切换）会改变
    // locale/resolved_locale 值，二者都让未接入对应订阅的组件在下一次 t() 时自动纠正
    // 有效语言，无需逐个组件补接线；输入未变时零额外解析开销。
    let cachedLocale: string | undefined;
    let cachedSnapshot: RendererLocalePackSnapshot | null | undefined;
    let cachedSettingKey: string | undefined;
    // 解析结果按 key 记忆化：渲染期同一组件会以相同 key 反复取词（列表行、工具栏等），
    // 命中时跳过前缀拼接与"增量词典 -> 域词典 -> 回退链"的整条查找。失效时机与
    // locale 缓存一致——生效语言变化或快照引用变化（每次 packsChanged 都是新对象，
    // 增量内容随之更新）时整体清空；translations 词典与 bundleName 是翻译器的静态入参。
    const memoByKey = new Map<string, string>();
    const resolveLocale = (snapshot: RendererLocalePackSnapshot | null): string => {
        ensureSettingChangedSubscription();
        // 显式传入的 setting 优先；无参翻译器跟随主进程广播的最新设置。
        // 缓存键取生效输入的值而非对象引用：组件原地更新同一 setting 对象（部分组件
        // 在 setting:changed 里只改字段）时同样失效重解析。
        const source =
            typeof localeSetting === 'object' && localeSetting !== null ? localeSetting : latestBroadcastSetting;
        const settingKey = source ? `${source.locale ?? ''}|${source.resolved_locale ?? ''}` : '';
        if (cachedLocale === undefined || snapshot !== cachedSnapshot || settingKey !== cachedSettingKey) {
            const previousLocale = cachedLocale;
            const previousSnapshot = cachedSnapshot;
            cachedLocale = resolveRendererLocale(localeSetting);
            cachedSnapshot = snapshot;
            cachedSettingKey = settingKey;
            // 仅生效语言或快照（即增量内容来源）真正变化时才清记忆化；
            // 仅 settingKey 变化而语言与快照未变时，已解析词条仍然有效
            if (cachedLocale !== previousLocale || snapshot !== previousSnapshot) {
                memoByKey.clear();
            }
        }
        return cachedLocale;
    };
    return (key, params) => {
        const snapshot = getLocalePackSnapshot();
        const locale = resolveLocale(snapshot);
        const memoized = memoByKey.get(key);
        if (memoized !== undefined) {
            return applyLocaleParams(memoized, params);
        }
        const text = resolveLocaleText(
            key,
            locale,
            translations,
            (tag) => snapshot?.incrementsByTag[tag],
            (tag) => snapshot?.fallbackByTag[tag],
            bundleName
        );
        memoByKey.set(key, text);
        return applyLocaleParams(text, params);
    };
}

export function createRendererTranslator(
    localeSetting?: RendererLocaleSource
): (key: string, params?: Record<string, string | number>) => string {
    return createTranslator(translations, localeSetting);
}
