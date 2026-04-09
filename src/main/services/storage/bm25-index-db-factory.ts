/**
 * BM25IndexDB 工厂：根据平台动态加载 Node 原生或 WASM 实现
 */
import type { ColumnSchema } from './abstract-storage.js';
import type { IBM25IndexDB } from './bm25-indexer.js';
import { shouldUseWasm } from './platform.js';

export async function createBM25IndexDB(schema: ColumnSchema, dbPath: string): Promise<IBM25IndexDB> {
    if (shouldUseWasm()) {
        const { BM25IndexDBWasm } = await import('./bm25-index-db-wasm.js');
        return new BM25IndexDBWasm(schema, dbPath);
    }
    const { BM25IndexDB } = await import('./bm25-index-db.js');
    return new BM25IndexDB(schema, dbPath);
}
