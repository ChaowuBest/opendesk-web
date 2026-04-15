/**
 * BaseIndexDB 工厂：根据平台动态加载 Node 原生或 WASM 实现
 * 独立文件避免顶层 import 原生包（better-sqlite3），使 optional 依赖缺失时模块仍可加载
 */
import type { ColumnSchema } from './abstract-storage.js';
import type { IBaseIndexDB } from './base-indexer.js';
import { shouldUseWasm } from './platform.js';

export async function createBaseIndexDB(dbPath: string, schema: ColumnSchema): Promise<IBaseIndexDB> {
    if (shouldUseWasm()) {
        const { BaseIndexDBWasm } = await import('./base-index-db-wasm.js');
        return new BaseIndexDBWasm(dbPath, schema);
    }
    const { BaseIndexDB } = await import('./base-index-db.js');
    return new BaseIndexDB(dbPath, schema);
}
