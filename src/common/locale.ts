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

import { BUILTIN_LOCALES, normalizeLocaleTag } from './locale/pack.js';

/** 宿主内置语言：词典全量、互不回退。常量定义于 locale/pack.ts（避免循环引用），此处转发保持既有导入路径 */
export { BUILTIN_LOCALES };

export type SupportedLocale = (typeof BUILTIN_LOCALES)[number];
export type LocaleSetting = 'auto' | SupportedLocale;

export interface LocaleRuntimeSnapshot {
    readonly setting: LocaleSetting;
    // 语言包可注册内置两种之外的 locale，快照按解析后的 tag 原样携带。
    readonly locale: string;
    readonly preferredSystemLanguages: readonly string[];
    readonly revision: number;
}

export type LocaleRuntimeListener = (snapshot: LocaleRuntimeSnapshot) => void;

export function isSupportedLocale(locale: unknown): locale is SupportedLocale {
    return locale === 'zh-CN' || locale === 'en-US';
}

/**
 * 值是否为格式合法的 BCP-47 语言 tag（如 zh-CN、tr-TR、pt-BR）。
 * 只校验格式，不校验可用性：语言包可动态注册新语言，
 * 可用性判定统一走 resolveLocaleSetting / resolvePreferredLocale 的 availableLocales。
 */
export function isValidLocaleTag(locale: unknown): locale is string {
    return typeof locale === 'string' && normalizeLocaleTag(locale) !== undefined;
}

/** 'auto' 或任意合法语言 tag（含语言包注册的语言） */
export function isValidLocaleSetting(locale: unknown): boolean {
    return locale === 'auto' || isValidLocaleTag(locale);
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

/**
 * 按系统首选语言在可用语言集合中解析语言。
 *
 * 保持首标签语义：只看第一个非空 tag，避免系统语言顺序变化带来的抖动；
 * tag 精确命中可用集合，或其主语言（tr -> tr-TR）命中时返回该语言，
 * 否则回退 en-US。availableLocales 须传入已规范化的 tag 列表。
 */
export function resolvePreferredLocale(
    preferredLanguages: readonly unknown[] = [],
    availableLocales: readonly string[] = BUILTIN_LOCALES
): string {
    const primaryLanguage = preferredLanguages.find((language) => typeof language === 'string' && language.trim());
    const normalized = normalizeLocaleTag(primaryLanguage);
    if (normalized) {
        if (availableLocales.includes(normalized)) return normalized;
        const primary = normalized.toLowerCase().split('-')[0];
        const matched = availableLocales.find((tag) => tag.toLowerCase().split('-')[0] === primary);
        if (matched) return matched;
    }
    return 'en-US';
}

/**
 * 解析语言设置值：显式值命中可用集合时直接返回（已规范化）；
 * auto、不可用（如语言包被卸载后的残留值）或非法值一律按系统语言解析。
 */
export function resolveLocaleSetting(
    localeSetting: unknown,
    preferredLanguages: readonly unknown[] = [],
    availableLocales: readonly string[] = BUILTIN_LOCALES
): string {
    if (localeSetting === 'auto') {
        return resolvePreferredLocale(preferredLanguages, availableLocales);
    }
    const normalized = normalizeLocaleTag(localeSetting);
    if (normalized && availableLocales.includes(normalized)) {
        return normalized;
    }
    return resolvePreferredLocale(preferredLanguages, availableLocales);
}

/**
 * Shared runtime state for hosts that can observe a system-language change.
 *
 * The host owns how preferred languages are discovered. Consumers only receive
 * a normalized snapshot and a monotonically increasing revision, so workers,
 * renderers, and platform adapters can discard stale notifications uniformly.
 */
export class LocaleRuntime {
    private snapshot: LocaleRuntimeSnapshot;
    private readonly listeners = new Set<LocaleRuntimeListener>();

    constructor(setting: LocaleSetting = 'auto', preferredSystemLanguages: readonly unknown[] = []) {
        this.snapshot = this.createSnapshot(setting, preferredSystemLanguages, 0);
    }

    getSnapshot(): LocaleRuntimeSnapshot {
        return this.snapshot;
    }

    subscribe(listener: LocaleRuntimeListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Publish a new setting or host language list only when the effective
     * locale changes. Fixed locales therefore ignore system-language changes.
     */
    update(
        setting: LocaleSetting,
        preferredSystemLanguages: readonly unknown[] = this.snapshot.preferredSystemLanguages
    ): boolean {
        const next = this.createSnapshot(setting, preferredSystemLanguages, this.snapshot.revision);
        if (next.setting === this.snapshot.setting && next.locale === this.snapshot.locale) {
            // Even a fixed locale must retain the latest host languages for a
            // later transition back to auto, without emitting a locale change.
            this.snapshot = next;
            return false;
        }

        this.snapshot = Object.freeze({ ...next, revision: this.snapshot.revision + 1 });
        for (const listener of this.listeners) {
            try {
                listener(this.snapshot);
            } catch {
                // A failed observer must not prevent other consumers from updating.
            }
        }
        return true;
    }

    private createSnapshot(
        setting: LocaleSetting,
        preferredSystemLanguages: readonly unknown[],
        revision: number
    ): LocaleRuntimeSnapshot {
        const languages = preferredSystemLanguages.filter(
            (language): language is string => typeof language === 'string' && language.trim().length > 0
        );
        return Object.freeze({
            setting,
            locale: resolveLocaleSetting(setting, languages),
            preferredSystemLanguages: Object.freeze([...languages]),
            revision
        });
    }
}
