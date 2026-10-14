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
 * 模型请求默认超时时间（秒）。用户未在模型配置中填写 timeout 时使用该值。
 */
export const DEFAULT_MODEL_TIMEOUT_SECONDS = 300;

/**
 * 解析 token 数输入：支持纯数字（如 128000）或整数带 k/K 后缀（如 128k、256K，按 ×1000 计算）。
 * 空字符串/空白或非法格式返回 undefined（调用方按"自动估算"处理）。
 */
export function parseTokenCount(raw: string | undefined | null): number | undefined {
    if (raw === undefined || raw === null) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const match = /^(\d+)([kK])?$/.exec(trimmed);
    if (!match) return undefined;
    const num = parseInt(match[1], 10);
    const total = match[2] ? num * 1000 : num;
    return Number.isSafeInteger(total) ? total : undefined;
}

/**
 * 判断 token 数输入是否非法。空值/空白视为合法（调用方按"自动估算"处理），
 * 非空但无法解析为合法的非负整数或 k 格式时返回 true。
 */
export function isInvalidTokenCount(raw: string | undefined | null): boolean {
    if (raw === undefined || raw === null) return false;
    const trimmed = raw.trim();
    if (!trimmed) return false;
    return parseTokenCount(trimmed) === undefined;
}

/**
 * 解析模型请求超时时间输入（单位：秒），只接受正整数。
 * 空字符串/空白或非法格式返回 undefined（调用方按默认超时处理）。
 */
export function parseTimeoutSeconds(raw: string | number | undefined | null): number | undefined {
    if (raw === undefined || raw === null) return undefined;
    const trimmed = String(raw).trim();
    if (!trimmed) return undefined;
    if (!/^\d+$/.test(trimmed)) return undefined;
    const seconds = parseInt(trimmed, 10);
    if (seconds <= 0 || !Number.isSafeInteger(seconds)) return undefined;
    return seconds;
}

/**
 * 判断超时时间输入是否非法。空值/空白视为合法（调用方按默认超时处理），
 * 非空但无法解析为正整数秒时返回 true。
 */
export function isInvalidTimeoutSeconds(raw: string | number | undefined | null): boolean {
    if (raw === undefined || raw === null) return false;
    const trimmed = String(raw).trim();
    if (!trimmed) return false;
    return parseTimeoutSeconds(trimmed) === undefined;
}
