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
 * BaseIndexDB 工厂：根据平台动态加载 Node 原生或 WASM 实现
 * 独立文件避免顶层 import 原生包（better-sqlite3），使 optional 依赖缺失时模块仍可加载
 */
import type { ColumnSchema } from './abstract-storage.js';
import type { BaseIndexStoreProbeResult, IBaseIndexDB } from './base-indexer.js';
import { createWithNativeSqliteFallback, shouldUseArkData } from './platform.js';
import type { RetainStorageInitializationCleanup } from './platform.js';
import { assertWasmStoresUnlocked, removeSqliteStoreFiles } from './drop-utils.js';
import { toWasmDbPath } from './wasm-path.js';

export async function dropBaseIndexStore(dbPath: string): Promise<void> {
    assertWasmStoresUnlocked([dbPath]);
    if (shouldUseArkData()) {
        const { dropBaseIndexStoreArkdata } = await import('./base-index-db-arkdata.js');
        await dropBaseIndexStoreArkdata(dbPath);
        return;
    }
    removeSqliteStoreFiles(dbPath);
    removeSqliteStoreFiles(toWasmDbPath(dbPath));
}

export async function createBaseIndexDB(
    dbPath: string,
    schema: ColumnSchema,
    retainCleanup?: RetainStorageInitializationCleanup
): Promise<IBaseIndexDB> {
    if (shouldUseArkData()) {
        const { BaseIndexDBArkdata } = await import('./base-index-db-arkdata.js');
        return new BaseIndexDBArkdata(dbPath, schema);
    }
    return createWithNativeSqliteFallback(
        async () => {
            const { BaseIndexDB } = await import('./base-index-db.js');
            return new BaseIndexDB(dbPath, schema, retainCleanup);
        },
        async () => {
            const { BaseIndexDBWasm } = await import('./base-index-db-wasm.js');
            return new BaseIndexDBWasm(dbPath, schema, retainCleanup);
        }
    );
}

export async function probeBaseIndexStore(dbPath: string): Promise<BaseIndexStoreProbeResult> {
    if (shouldUseArkData()) {
        const { probeBaseIndexStoreArkdata } = await import('./base-index-db-arkdata.js');
        return probeBaseIndexStoreArkdata(dbPath);
    }
    return createWithNativeSqliteFallback(
        async () => {
            const { probeBaseIndexStoreNative } = await import('./base-index-db.js');
            return probeBaseIndexStoreNative(dbPath);
        },
        async () => {
            const { probeBaseIndexStoreWasm } = await import('./base-index-db-wasm.js');
            return probeBaseIndexStoreWasm(dbPath);
        }
    );
}
