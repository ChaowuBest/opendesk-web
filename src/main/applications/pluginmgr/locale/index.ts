/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { getLocale } from '../../../../locale/index.js';
import { enUs } from './en-us.js';
import { zhCn } from './zh-cn.js';

const translations: Record<string, Record<string, string>> = {
    'zh-CN': zhCn,
    'en-US': enUs
};

export function t(key: string): string {
    const locale = getLocale();
    return translations[locale]?.[key] ?? translations['zh-CN']?.[key] ?? key;
}
