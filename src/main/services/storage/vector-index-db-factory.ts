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
 * VectorIndexDB 工厂：根据平台动态加载 ArkData / WASM / Node 原生实现
 */
import fs from 'fs';
import type { IVectorIndexDB } from './vector-indexer.js';
import type { BaseIndexStoreProbeResult } from './base-indexer.js';
import { createWithNativeSqliteFallback, shouldUseArkData } from './platform.js';
import { removePathIfExists, removeSqliteStoreFiles } from './drop-utils.js';
import { toWasmDbPath } from './wasm-path.js';

export async function createVectorIndexDB(dbPath: string, dimension: number = 1024): Promise<IVectorIndexDB> {
    if (shouldUseArkData()) {
        const { VectorIndexDBArkdata } = await import('./vector-index-db-arkdata.js');
        return new VectorIndexDBArkdata(dbPath, dimension);
    }
    return createWithNativeSqliteFallback(
        async () => {
            const { VectorIndexDB } = await import('./vector-index-db.js');
            return new VectorIndexDB(dbPath, dimension);
        },
        async () => {
            const { VectorIndexDBWasm } = await import('./vector-index-db-wasm.js');
            return new VectorIndexDBWasm(dbPath, dimension);
        }
    );
}

export async function probeVectorIndexStore(dbPath: string): Promise<BaseIndexStoreProbeResult> {
    if (shouldUseArkData()) {
        const { probeVectorIndexStoreArkdata } = await import('./vector-index-db-arkdata.js');
        return probeVectorIndexStoreArkdata(dbPath);
    }
    return createWithNativeSqliteFallback(
        async () => {
            const { probeVectorIndexStoreNative } = await import('./vector-index-db.js');
            return probeVectorIndexStoreNative(dbPath);
        },
        async () => {
            const { probeVectorIndexStoreWasm } = await import('./vector-index-db-wasm.js');
            return probeVectorIndexStoreWasm(dbPath);
        }
    );
}

export async function dropVectorIndexStore(dbPath: string): Promise<void> {
    if (shouldUseArkData()) {
        const { dropVectorIndexStoreArkdata } = await import('./vector-index-db-arkdata.js');
        await dropVectorIndexStoreArkdata(dbPath);
        return;
    }
    removeSqliteStoreFiles(dbPath, [`${dbPath}.hnsw.json`]);
    removePathIfExists(`${toWasmDbPath(dbPath)}.hnsw.json`);
    if (fs.existsSync(toWasmDbPath(dbPath))) {
        const { dropVectorIndexStoreWasm } = await import('./vector-index-db-wasm.js');
        await dropVectorIndexStoreWasm(dbPath);
    }
}
