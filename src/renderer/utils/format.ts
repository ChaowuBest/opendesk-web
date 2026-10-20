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

/** part 占 total 的百分比（一位小数），非法或非正输入返回 '0%' */
export function formatPercent(part: number, total: number): string {
    if (!Number.isFinite(part) || !Number.isFinite(total) || part <= 0 || total <= 0) {
        return '0%';
    }
    return `${((part / total) * 100).toFixed(1)}%`;
}
