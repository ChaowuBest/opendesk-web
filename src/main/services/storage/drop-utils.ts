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

import fs from 'fs';
import { toWasmDbPath } from './wasm-path.js';

export function assertWasmStoresUnlocked(dbPaths: string[]): void {
    for (const dbPath of dbPaths) {
        const lockPath = `${toWasmDbPath(dbPath)}.lock`;
        try {
            fs.lstatSync(lockPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
        }
        // A conservative snapshot, not a lock acquisition or stale-lock cleanup.
        throw Object.assign(new Error(`EBUSY: ${lockPath}`), { code: 'EBUSY', path: lockPath });
    }
}

export function removePathIfExists(targetPath: string): void {
    try {
        fs.rmSync(targetPath, { recursive: true, force: true });
    } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

export function removeSqliteStoreFiles(dbPath: string, extraPaths: string[] = []): void {
    for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, ...extraPaths]) {
        removePathIfExists(target);
    }
}
