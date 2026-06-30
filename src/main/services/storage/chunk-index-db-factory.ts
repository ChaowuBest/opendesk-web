/**
 * ChunkIndexDB 工厂：根据平台动态加载 ArkData / WASM / Node 原生实现
 */
import type { IChunkIndexDB } from './chunk-indexer.js';
import type { BaseIndexStoreProbeResult } from './base-indexer.js';
import { createWithNativeSqliteFallback, shouldUseArkData } from './platform.js';
import { removeSqliteStoreFiles } from './drop-utils.js';

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
}
