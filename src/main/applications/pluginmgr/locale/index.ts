/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { translateWithDomain } from '../../../../locale/index.js';
import { enUs } from './en-us.js';
import { zhCn } from './zh-cn.js';

const translations: Record<string, Record<string, string>> = {
    'zh-CN': zhCn,
    'en-US': enUs
};

/**
 * 插件应用的本地化文案。
 *
 * @param key 文案键
 * @param params `${name}` 形式的占位参数
 */
export function t(key: string, params?: Record<string, string | number>): string {
    return translateWithDomain(key, translations, params);
}
