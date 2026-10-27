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

import { getLocale } from '../../../../locale/index.js';
import { modelZhCn, modelEnUs } from '../../../../common/locale/model.js';
import { zhCn } from './zh-cn.js';
import { enUs } from './en-us.js';

// todomgr 词典优先，未命中的通用 model 词条回退到共享词典
const translations: Record<string, Record<string, string>> = {
    'zh-CN': { ...modelZhCn, ...zhCn },
    'en-US': { ...modelEnUs, ...enUs }
};

export function t(key: string, params?: Record<string, string | number>): string {
    const locale = getLocale();
    let text = translations[locale]?.[key] ?? translations['zh-CN']?.[key] ?? key;
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\$\\{${k}\\}`, 'g'), String(v));
        }
    }
    return text;
}
