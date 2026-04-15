/**
 * ChunkIndexDB 工厂：根据平台动态加载 Node 原生或 WASM 实现
 */
import type { IChunkIndexDB } from './chunk-indexer.js';
import { shouldUseWasm } from './platform.js';

export async function createChunkIndexDB(dbPath: string, dimension: number = 1024): Promise<IChunkIndexDB> {
    if (shouldUseWasm()) {
        const { ChunkIndexDBWasm } = await import('./chunk-index-db-wasm.js');
        return new ChunkIndexDBWasm(dbPath, dimension);
    }
    const { ChunkIndexDB } = await import('./chunk-index-db.js');
    return new ChunkIndexDB(dbPath, dimension);
}
