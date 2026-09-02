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

import { jsonrepair } from 'jsonrepair';

/**
 * 返回可直接 JSON.parse 的字符串：合法 JSON 原样返回；非合法 JSON 经 jsonrepair 修复后返回。
 *
 * 背景：jsonrepair 3.15 对「完全合法」的 JSON 存在误判 bug——当对象的最后一个字符串值
 * 内含未闭合的花括号（如代码片段中的函数体或对象字面量起始）且其后紧跟右花括号时，
 * jsonrepair 会误以为字符串尚未结束并越界扫描，最终对合法 JSON 抛出 JSONRepairError。
 * 因此必须先尝试 JSON.parse，只有确实解析失败（JSON 有缺陷）时才引入 jsonrepair 修复。
 *
 * @param text 待解析的 JSON 字符串
 * @returns 可直接 JSON.parse 的字符串（合法 JSON 时与入参相同）
 * @throws JSON.parse 与 jsonrepair 均失败时抛错
 */
export function repairJsonString(text: string): string {
    try {
        JSON.parse(text);
        return text;
    } catch {
        return jsonrepair(text);
    }
}

/**
 * 解析 JSON 字符串：优先 JSON.parse，失败时才用 jsonrepair 修复后重新解析。
 *
 * 相比直接 `JSON.parse(jsonrepair(text))`，此函数保证合法 JSON 不经过 jsonrepair，
 * 从而绕开 jsonrepair 对部分合法 JSON 的误判 bug（详见 {@link repairJsonString}）。
 *
 * @param text 待解析的 JSON 字符串
 * @returns 解析后的值
 * @throws JSON.parse 与 jsonrepair 均失败时抛错
 */
export function parseJsonWithRepair<T = unknown>(text: string): T {
    try {
        return JSON.parse(text) as T;
    } catch {
        return JSON.parse(jsonrepair(text)) as T;
    }
}
