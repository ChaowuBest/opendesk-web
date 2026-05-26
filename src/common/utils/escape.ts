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
 * HTML 转义 — 将用户可控文本转为 HTML 实体，防止 XSS。
 * 覆盖 & < > " ' 五个关键字符。
 */
export function escapeHtml(content: string | undefined | null): string {
    if (content === null || content === undefined) {
        return '';
    }
    const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(content).replace(/[&<>"']/g, function (m: string) {
        return map[m];
    });
}

/**
 * 正则表达式转义 — 转义字符串中所有正则特殊字符。
 * 用于将用户输入安全地嵌入 RegExp 构造。
 */
export function escapeRegExp(s: string): string {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * SQL 字符串转义 — 将单引号转义为 SQL 标准的两个单引号。
 * 用于将值安全地嵌入到 SQL 字符串字面量中（仅限必须内联的简单场景）。
 * 优先使用参数化查询。
 */
export function escapeSqlStr(s: string): string {
    return s.replace(/'/g, "''");
}
