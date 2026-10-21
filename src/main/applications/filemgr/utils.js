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

// FileMgr source identifiers remain untouched; only filesystem/path boundaries use this view.
export function resolveDriveRootPath(value, platform) {
    if (platform === 'win32' && typeof value === 'string' && /^[A-Za-z]:[/\\]?$/.test(value)) {
        return `${value.slice(0, 2)}/`;
    }
    return value;
}
