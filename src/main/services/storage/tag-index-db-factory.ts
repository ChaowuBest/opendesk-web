/**
 * TagIndexDB 工厂：根据平台动态加载 Node 原生或 WASM 实现
 */
import type { ITagIndexDB } from './tag-indexer.js';
import { shouldUseWasm } from './platform.js';

export async function createTagIndexDB(dbPath: string): Promise<ITagIndexDB> {
    if (shouldUseWasm()) {
        const { TagIndexDBWasm } = await import('./tag-index-db-wasm.js');
        return new TagIndexDBWasm(dbPath);
    }
    const { TagIndexDB } = await import('./tag-index-db.js');
    return new TagIndexDB(dbPath);
}
