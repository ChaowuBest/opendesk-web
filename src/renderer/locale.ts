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
import { isSupportedLocale, resolveLocaleSetting } from '../common/locale.js';

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
    return resolveLocaleSetting('auto', getRendererPreferredLanguages());
}

export function resolveRendererLocale(localeSource?: RendererLocaleSource): string {
    if (typeof localeSource === 'object' && localeSource !== null) {
        if (isSupportedLocale(localeSource.locale)) {
            return localeSource.locale;
        }
        if (isSupportedLocale(localeSource.resolved_locale)) {
            return localeSource.resolved_locale;
        }
        return detectRendererLocale();
    }
    return resolveLocaleSetting(localeSource, getRendererPreferredLanguages());
}

/**
 * 基于给定词表创建翻译函数，供各应用在 renderer 侧复用自己的 locale 词条。
 * 词条缺失时回退到 zh-CN，再回退到 key 本身。
 */
export function createTranslator(
    translations: Record<string, Record<string, string>>,
    localeSetting?: RendererLocaleSource
): (key: string, params?: Record<string, string | number>) => string {
    const locale = resolveRendererLocale(localeSetting);
    return (key, params) => {
        let text = translations[locale]?.[key] ?? translations['zh-CN']?.[key] ?? key;
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                text = text.replace(new RegExp(`\\$\\{${k}\\}`, 'g'), String(v));
            }
        }
        return text;
    };
}

export function createRendererTranslator(
    localeSetting?: RendererLocaleSource
): (key: string, params?: Record<string, string | number>) => string {
    return createTranslator(translations, localeSetting);
}
