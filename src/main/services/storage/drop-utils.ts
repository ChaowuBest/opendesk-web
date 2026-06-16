/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';

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
