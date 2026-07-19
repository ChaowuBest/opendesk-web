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

import * as crypto from 'crypto';

export function toArkDataDbPath(dbPath: string): string {
    if (dbPath.endsWith('-arkdata-database.db')) return dbPath;
    return dbPath.endsWith('.db') ? dbPath.replace(/\.db$/, '-arkdata-database.db') : `${dbPath}-arkdata-database.db`;
}

export function createArkDataStoreId(prefix: string, dbPath: string): string {
    const hash = crypto.createHash('sha1').update(dbPath).digest('hex').slice(0, 16);
    return `${prefix}:${hash}`;
}
