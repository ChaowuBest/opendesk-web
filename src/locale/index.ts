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

const translations: Record<string, Record<string, string>> = {
    'zh-CN': zhCn,
    'en-US': enUs
};

/** 命令行 --language 指定的运行时覆盖，不影响设置 */
let runtimeLocaleOverride: string | null = null;

/**
 * 检测系统语言
 */
function detectSystemLocale(): string {
    const lang = Intl.DateTimeFormat().resolvedOptions().locale;
    return lang.startsWith('zh') ? 'zh-CN' : 'en-US';
}

/**
 * 获取当前有效语言
 * 优先级：runtimeOverride > setting > system
 */
export function getLocale(): string {
    if (runtimeLocaleOverride) {
        return runtimeLocaleOverride;
    }
    const setting = Setting.getInstance();
    const savedLocale = setting.data.locale as string;
    return savedLocale === 'auto' ? detectSystemLocale() : savedLocale;
}

/**
 * 获取原始语言设置（auto / zh-CN / en-US）
 */
export function getLocaleSetting(): string {
    return Setting.getInstance().data.locale as string;
}

/**
 * 设置语言（仅修改设置，不影响 runtime override）
 * @param locale - 语言设置值 ('auto' | 'zh-CN' | 'en-US')
 */
export function setLocale(locale: string): void {
    if (locale !== 'auto' && locale !== 'zh-CN' && locale !== 'en-US') {
        return;
    }
    const setting = Setting.getInstance();
    setting.setData({ ...setting.data, locale });
}

/**
 * 设置运行时语言覆盖（不修改设置，仅影响本次运行）
 * @param locale - 语言值 ('zh-CN' | 'en-US')，传入 null 清除覆盖
 */
export function setRuntimeLocale(locale: string | null): void {
    runtimeLocaleOverride = locale;
}

/**
 * 翻译函数
 * @param key - 翻译键名，格式为 '模块.键名'
 * @param params - 可选的插值参数对象，如 { id: 'xxx' } 会替换字符串中的 ${id}
 */
export function t(key: string, params?: Record<string, string | number>): string {
    const locale = getLocale();
    let text = translations[locale]?.[key] ?? key;
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\$\\{${k}\\}`, 'g'), String(v));
        }
    }
    return text;
}
