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

/**
 * renderer 侧专用翻译器。与 ./index.ts 分开维护：
 * index.ts 依赖主进程的 Setting（getLocale），不能被 renderer 打包引用。
 */

import { createTranslator } from '../../../../renderer/locale.js';
import { zhCn } from './zh-cn.js';
import { enUs } from './en-us.js';

const translations: Record<string, Record<string, string>> = {
    'zh-CN': zhCn,
    'en-US': enUs
};

export function createTranslatorForNotes(
    localeSetting?:
        | string
        | {
              locale?: string;
              resolved_locale?: string;
          }
): (key: string, params?: Record<string, string | number>) => string {
    return createTranslator(translations, localeSetting, 'notes');
}
