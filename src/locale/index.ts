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

import { Setting } from '../main/utils/setting.js';
import { zhCn } from './zh-cn.js';
import { enUs } from './en-us.js';
import { getLocalePackStore } from './packs.js';
import { createRequire } from 'module';
import {
    isValidLocaleSetting,
    isValidLocaleTag,
    resolveLocaleSetting,
    resolvePreferredLocale
} from '../common/locale.js';
import { applyLocaleParams, normalizeLocaleTag, resolveLocaleText } from '../common/locale/pack.js';

const translations: Record<string, Record<string, string>> = {
    'zh-CN': zhCn,
    'en-US': enUs
};

const require = createRequire(import.meta.url);

/** 命令行 --language 指定的运行时覆盖，不影响设置 */
let runtimeLocaleOverride: string | null = null;
/** 宿主进程注入的系统首选语言，供 Worker 等无法直接访问 Electron app 的环境使用 */
let runtimePreferredSystemLanguages: string[] | null = null;

export function setRuntimePreferredSystemLanguages(languages: readonly unknown[] | null): void {
    if (!languages) {
        runtimePreferredSystemLanguages = null;
        return;
    }
    const normalized = languages.filter((language): language is string => typeof language === 'string');
    runtimePreferredSystemLanguages = normalized.length > 0 ? normalized : null;
}

/** 收集系统首选语言候选（注入值 > OpenHarmony bridge > Electron > Intl），供解析层做最佳匹配 */
function getSystemPreferredLanguages(): string[] {
    if (runtimePreferredSystemLanguages) {
        return [...runtimePreferredSystemLanguages];
    }
    // OpenHarmony bridge：优先通过 SystemPreferenceAdapter 获取系统语言
    const ohosLang = getOhosBridgeSystemLanguage();
    if (ohosLang) {
        return [ohosLang];
    }
    // 退化：Electron app.getPreferredSystemLanguages()
    const electronLanguages = getElectronPreferredSystemLanguages();
    if (electronLanguages && electronLanguages.length > 0) {
        return electronLanguages;
    }
    const lang = Intl.DateTimeFormat().resolvedOptions().locale;
    return lang ? [lang] : [];
}

/**
 * 检测系统语言（在当前可用语言集合内解析；可用集合含语言包注册的语言）
 */
export function detectSystemLocale(): string {
    return resolvePreferredLocale(getSystemPreferredLanguages(), getLocalePackStore().getAvailableLocales());
}

function getOhosBridgeSystemLanguage(): string | undefined {
    try {
        // Only available on OpenHarmony with bridge initialized;
        // uses the same cache as system-theme.ts (warmed up by MainThemeService).
        const { getCachedOhosSystemLanguage } = require('../platforms/bridges/harmonyos/system-theme.js') as {
            getCachedOhosSystemLanguage?: () => string;
        };
        const lang = getCachedOhosSystemLanguage?.();
        return lang || undefined;
    } catch {
        return undefined;
    }
}

function getElectronPreferredSystemLanguages(): string[] | undefined {
    try {
        const electron = require('electron') as {
            app?: {
                isReady?: () => boolean;
                getPreferredSystemLanguages?: () => string[];
            };
        };
        const electronApp = electron.app;
        if (!electronApp?.getPreferredSystemLanguages) {
            return undefined;
        }
        if (electronApp.isReady && !electronApp.isReady()) {
            return undefined;
        }
        const languages = electronApp.getPreferredSystemLanguages();
        return Array.isArray(languages) ? languages : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 获取当前有效语言
 * 优先级：runtimeOverride > setting > system
 *
 * 可用语言集合由 LocaleStore 提供（内置 zh-CN/en-US ∪ 已启用语言包）；
 * 语言包被卸载后 setting 中的残留值自动回退为系统语言解析结果。
 */
export function getLocale(): string {
    if (runtimeLocaleOverride) {
        const normalized = normalizeLocaleTag(runtimeLocaleOverride);
        if (normalized) {
            return normalized;
        }
    }
    const setting = Setting.getInstance();
    const savedLocale = setting.data.locale as string;
    const availableLocales = getLocalePackStore().getAvailableLocales();
    const normalizedSaved = normalizeLocaleTag(savedLocale);
    // 显式设置且语言可用（含语言包注册的语言）：直接采用，不触发系统语言检测
    if (normalizedSaved && availableLocales.includes(normalizedSaved)) {
        return normalizedSaved;
    }
    // auto、语言包卸载后的残留值或非法值：按系统语言解析（此时才做系统检测）
    return resolveLocaleSetting(savedLocale, getSystemPreferredLanguages(), availableLocales);
}

/**
 * 获取原始语言设置（auto / 内置语言 / 语言包注册的语言 tag）
 */
export function getLocaleSetting(): string {
    return Setting.getInstance().data.locale as string;
}

/**
 * 设置语言（仅修改设置，不影响 runtime override）
 * @param locale - 语言设置值（'auto' 或合法 BCP-47 tag，含语言包注册的语言）
 */
export function setLocale(locale: string): void {
    if (!isValidLocaleSetting(locale)) {
        return;
    }
    const setting = Setting.getInstance();
    setting.setData({ ...setting.data, locale });
}

/**
 * 设置运行时语言覆盖（不修改设置，仅影响本次运行）
 * @param locale - 语言 tag 或 null 清除覆盖；非法值按未设置处理
 */
export function setRuntimeLocale(locale: string | null): void {
    runtimeLocaleOverride = locale && isValidLocaleTag(locale) ? locale : null;
}

/**
 * 全局翻译函数：在「语言包增量 -> 内置词典」统一查找链上解析 key。
 * @param key - 翻译键名，格式为 '模块.键名'
 * @param params - 可选的插值参数对象，如 { id: 'xxx' } 会替换字符串中的 ${id}
 */
export function t(key: string, params?: Record<string, string | number>): string {
    return translateWithDomain(key, translations, params);
}

/**
 * 在给定词典域上按统一查找链翻译（供各应用词典的 t() 委托，使语言包能覆盖应用文案）。
 *
 * 链序与 resolveLocaleText 一致：语言包增量 -> domain[locale] ->
 * 非 builtin 语言的 fallback（@fallback，缺省 en-US）-> en-US 时的 zh-CN 兜底 -> 回显 key。
 * @param key - 翻译键名
 * @param domainTranslations - 所属域的词典（全局词典或某应用的 zh-CN/en-US 词典）
 * @param params - 可选插值参数
 * @param locale - 显式指定语言；缺省取当前有效语言
 */
export function translateWithDomain(
    key: string,
    domainTranslations: Record<string, Record<string, string>>,
    params?: Record<string, string | number>,
    locale: string = getLocale()
): string {
    const store = getLocalePackStore();
    const text = resolveLocaleText(
        key,
        locale,
        domainTranslations,
        (tag) => store.getMergedPack(tag)?.entries,
        (tag) => store.getPackFallback(tag)
    );
    return applyLocaleParams(text, params);
}
