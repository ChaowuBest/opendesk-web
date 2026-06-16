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

const translations: Record<string, Record<string, string>> = {
    'zh-CN': zhCn,
    'en-US': enUs
};

function detectRendererLocale(): string {
    return navigator.language.startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function resolveRendererLocale(localeSetting?: string): string {
    if (localeSetting === 'zh-CN' || localeSetting === 'en-US') {
        return localeSetting;
    }
    return detectRendererLocale();
}

export function createRendererTranslator(
    localeSetting?: string
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
