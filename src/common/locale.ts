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

export type SupportedLocale = 'zh-CN' | 'en-US';
export type LocaleSetting = 'auto' | SupportedLocale;

export function isSupportedLocale(locale: unknown): locale is SupportedLocale {
    return locale === 'zh-CN' || locale === 'en-US';
}

export function isLocaleSetting(locale: unknown): locale is LocaleSetting {
    return locale === 'auto' || isSupportedLocale(locale);
}

export function isChineseLanguageTag(languageTag: unknown): boolean {
    if (typeof languageTag !== 'string') {
        return false;
    }
    const normalized = languageTag.trim().toLowerCase().replace(/_/g, '-');
    return normalized === 'zh' || normalized.startsWith('zh-');
}

export function resolvePreferredLocale(preferredLanguages: readonly unknown[] = []): SupportedLocale {
    const primaryLanguage = preferredLanguages.find((language) => typeof language === 'string' && language.trim());
    return isChineseLanguageTag(primaryLanguage) ? 'zh-CN' : 'en-US';
}

export function resolveLocaleSetting(
    localeSetting: unknown,
    preferredLanguages: readonly unknown[] = []
): SupportedLocale {
    if (isSupportedLocale(localeSetting)) {
        return localeSetting;
    }
    return resolvePreferredLocale(preferredLanguages);
}
