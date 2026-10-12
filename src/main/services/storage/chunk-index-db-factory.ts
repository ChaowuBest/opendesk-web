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
 * ChunkIndexDB 工厂：根据平台动态加载 ArkData / WASM / Node 原生实现
 */
import fs from 'fs';
import type { IChunkIndexDB } from './chunk-indexer.js';
import type { BaseIndexStoreProbeResult } from './base-indexer.js';
import { createWithNativeSqliteFallback, shouldUseArkData } from './platform.js';
import { removePathIfExists, removeSqliteStoreFiles } from './drop-utils.js';
import { toWasmDbPath } from './wasm-path.js';

export async function createChunkIndexDB(dbPath: string, dimension: number = 1024): Promise<IChunkIndexDB> {
    if (shouldUseArkData()) {
        const { ChunkIndexDBArkdata } = await import('./chunk-index-db-arkdata.js');
        return new ChunkIndexDBArkdata(dbPath, dimension);
    }
    return createWithNativeSqliteFallback(
        async () => {
            const { ChunkIndexDB } = await import('./chunk-index-db.js');
            return new ChunkIndexDB(dbPath, dimension);
        },
        async () => {
            const { ChunkIndexDBWasm } = await import('./chunk-index-db-wasm.js');
            return new ChunkIndexDBWasm(dbPath, dimension);
        }
    );
}

/** Raw ArkData deletion needs a retained connection; file backends delete without opening a DB. */
export async function createChunkIndexDBForDrop(dbPath: string, dimension: number): Promise<IChunkIndexDB | null> {
    if (!shouldUseArkData()) return null;
    return createChunkIndexDB(dbPath, dimension);
}

export async function probeChunkIndexStore(dbPath: string): Promise<BaseIndexStoreProbeResult> {
    if (shouldUseArkData()) {
        const { probeChunkIndexStoreArkdata } = await import('./chunk-index-db-arkdata.js');
        return probeChunkIndexStoreArkdata(dbPath);
    }
    return createWithNativeSqliteFallback(
        async () => {
            const { probeChunkIndexStoreNative } = await import('./chunk-index-db.js');
            return probeChunkIndexStoreNative(dbPath);
        },
        async () => {
            const { probeChunkIndexStoreWasm } = await import('./chunk-index-db-wasm.js');
            return probeChunkIndexStoreWasm(dbPath);
        }
    );
}

export async function dropChunkIndexStore(dbPath: string): Promise<void> {
    if (shouldUseArkData()) {
        const { dropChunkIndexStoreArkdata } = await import('./chunk-index-db-arkdata.js');
        await dropChunkIndexStoreArkdata(dbPath);
        return;
    }
    removeSqliteStoreFiles(dbPath, [`${dbPath}.hnsw.json`]);
    removePathIfExists(`${toWasmDbPath(dbPath)}.hnsw.json`);
    if (fs.existsSync(toWasmDbPath(dbPath))) {
        const { dropChunkIndexStoreWasm } = await import('./chunk-index-db-wasm.js');
        await dropChunkIndexStoreWasm(dbPath);
    }
}
