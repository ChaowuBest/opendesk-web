/**
 * VectorIndexDB 工厂：根据平台动态加载 ArkData / WASM / Node 原生实现
 */
import type { IVectorIndexDB } from './vector-indexer.js';
import type { BaseIndexStoreProbeResult } from './base-indexer.js';
import { createWithNativeSqliteFallback, shouldUseArkData } from './platform.js';

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
