/**
 * VectorIndexDB 工厂：根据平台动态加载 Node 原生或 WASM 实现
 */
import type { IVectorIndexDB } from './vector-indexer.js';
import { shouldUseWasm } from './platform.js';

export async function createVectorIndexDB(dbPath: string, dimension: number = 1024): Promise<IVectorIndexDB> {
    if (shouldUseWasm()) {
        const { VectorIndexDBWasm } = await import('./vector-index-db-wasm.js');
        return new VectorIndexDBWasm(dbPath, dimension);
    }
    const { VectorIndexDB } = await import('./vector-index-db.js');
    return new VectorIndexDB(dbPath, dimension);
}
