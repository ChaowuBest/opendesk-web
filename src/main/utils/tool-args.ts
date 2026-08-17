/**
 * Copyright (c) 2026 The OpenDesk Team
 *
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { jsonrepair } from 'jsonrepair';

export function parseNestedToolArgs(value: unknown): Record<string, unknown> {
    if (value === undefined || value === null) {
        return {};
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            return {};
        }
        const parsed = JSON.parse(jsonrepair(trimmed)) as unknown;
        if (parsed === null) {
            return {};
        }
        if (typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    }
    throw new Error('嵌套工具参数无法解析为对象');
}
