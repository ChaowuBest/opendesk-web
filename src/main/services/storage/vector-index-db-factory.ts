/**
 * VectorIndexDB 工厂：根据平台动态加载 Node 原生或 WASM 实现
 */
import type { IVectorIndexDB } from './vector-indexer.js';
import { createWithNativeSqliteFallback } from './platform.js';

export async function createVectorIndexDB(dbPath: string, dimension: number = 1024): Promise<IVectorIndexDB> {
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
