/**
 * TagIndexDB 工厂：根据平台动态加载 Node 原生或 WASM 实现
 */
import type { ITagIndexDB } from './tag-indexer.js';
import { createWithNativeSqliteFallback } from './platform.js';

export async function createTagIndexDB(dbPath: string): Promise<ITagIndexDB> {
    return createWithNativeSqliteFallback(
        async () => {
            const { TagIndexDB } = await import('./tag-index-db.js');
            return new TagIndexDB(dbPath);
        },
        async () => {
            const { TagIndexDBWasm } = await import('./tag-index-db-wasm.js');
            return new TagIndexDBWasm(dbPath);
        }
    );
}
