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

import { logger } from '../../utils/logger.js';

export const ARKDATA_MAX_RESULT_ROWS = 5000;

/**
 * ArkData adapter enforces a 5000-row SELECT result cap. Clamp inside ArkData
 * backends so generic storage/indexer callers do not need to know this limit.
 */
export function normalizeArkDataResultLimit(
    name: 'limit' | 'topK',
    value: unknown,
    defaultValue: number,
    context: string
): number {
    if (value === undefined) return defaultValue;
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`${context}: invalid ${name}=${String(value)}`);
    }
    if ((value as number) > ARKDATA_MAX_RESULT_ROWS) {
        logger.warn(`[arkdata] ${context}: ${name} clamped from ${value} to ${ARKDATA_MAX_RESULT_ROWS}`);
        return ARKDATA_MAX_RESULT_ROWS;
    }
    return value as number;
}

export function arkDataNonNegativeIntegerLiteral(name: 'offset', value: unknown, context: string): string {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`${context}: invalid ${name}=${String(value)}`);
    }
    return String(value);
}
