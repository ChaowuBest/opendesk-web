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
 * VectorIndexDBHm - 鸿蒙 OS 专用向量索引数据库
 *
 * 直接使用 hm_sqlite_addon.node 实现，公开方法与 VectorIndexDB 一一对应（除同步/异步外）。
 * 鸿蒙内置 vec0 支持，不需要 sqlite-vec 扩展。
 * 向量数据（Float32Array）需转为 X'hex' 字面量内联到 SQL 中（addon 不支持 blob 绑定）。
 * Indexer 层通过 await Promise.resolve() 统一调用两者。
 */

import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import type { VectorIndexRecord, VectorSearchResult, VectorSearchOptions, IVectorIndexDB } from './vector-indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const projectRoot = path.resolve(__dirname, '../../../../');
const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

// ── HM Addon 类型定义 ─────────────────────────────────────────────
type HmSqliteAddon = {
    open: (filename: string) => unknown;
    close: (db: unknown) => void;
    exec: (db: unknown, sql: string) => Promise<any[]>;
    beginTransaction: (db: unknown) => Promise<void>;
    commitTransaction: (db: unknown) => Promise<void>;
    rollbackTransaction: (db: unknown) => Promise<void>;
    prepare: (db: unknown, sql: string) => Promise<unknown>;
    run: (stmt: unknown, params: any[]) => Promise<void>;
};

const ARCH_CANDIDATES = [
    process.arch,
    process.arch === 'arm64' ? 'aarch64' : undefined,
    process.arch === 'x64' ? 'x86_64' : undefined
].filter(Boolean) as string[];

const ADDON_CANDIDATES = [
    process.env.HM_SQLITE_ADDON_PATH,
    ...(resourcesPath
        ? ARCH_CANDIDATES.map((arch) =>
              path.resolve(resourcesPath, 'native', 'openharmony', arch, 'hm_sqlite_addon.node')
          )
        : []),
    ...ARCH_CANDIDATES.map((arch) => path.resolve(projectRoot, 'native', 'openharmony', arch, 'hm_sqlite_addon.node'))
].filter(Boolean) as string[];

function loadAddon(): HmSqliteAddon {
    for (const addonPath of ADDON_CANDIDATES) {
        if (!fs.existsSync(addonPath)) continue;
        return require(addonPath) as HmSqliteAddon;
    }
    throw new Error(`hm_sqlite_addon not found. Tried: ${ADDON_CANDIDATES.join(', ')}`);
}

// ── Float32Array → X'hex' 字面量（用于 vec0 虚拟表内联）────────────
function float32ToHexLiteral(arr: Float32Array | number[]): string {
    const fa = arr instanceof Float32Array ? arr : new Float32Array(arr);
    const buf = Buffer.from(fa.buffer, fa.byteOffset, fa.byteLength);
    return `X'${buf.toString('hex')}'`;
}

// ── SQL 字符串转义（防止注入）──────────────────────────────────────
function escapeStr(s: string): string {
    return s.replace(/'/g, "''");
}

// ── VectorIndexDBHm ───────────────────────────────────────────────
export class VectorIndexDBHm implements IVectorIndexDB {
    private readonly addon: HmSqliteAddon;
    private db: unknown;
    private readonly dbPath: string;
    private readonly metaTableName = 'vector_index_meta';
    private readonly vecTableName = 'vector_index_vec';
    private readonly dimension: number;
    private isInitialized = false;

    constructor(dbPath: string, dimension: number = 1024) {
        this.dimension = dimension;
        this.dbPath = dbPath;
        this.addon = loadAddon();
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this.db = this.addon.open(dbPath);
    }

    private ensureOpen(): unknown {
        if (!this.db) throw new Error(`Database is not opened: ${this.dbPath}`);
        return this.db;
    }

    // DDL 或无参 SELECT / vec0 虚拟表写操作（需内联字面量）
    private async execSql(sql: string): Promise<any[]> {
        return this.addon.exec(this.ensureOpen(), sql);
    }

    // 普通表写操作：INSERT / UPDATE / DELETE（参数通过 prepare + run 绑定）
    private async runSql(sql: string, params: any[] = []): Promise<void> {
        const stmt = await this.addon.prepare(this.ensureOpen(), sql);
        await this.addon.run(stmt, params);
    }

    private async runTransaction<T>(fn: () => Promise<T>): Promise<T> {
        const db = this.ensureOpen();
        await this.addon.beginTransaction(db);
        try {
            const result = await fn();
            await this.addon.commitTransaction(db);
            return result;
        } catch (error) {
            try {
                await this.addon.rollbackTransaction(db);
            } catch {}
            throw error;
        }
    }

    private async ensureInitialized(): Promise<void> {
        if (this.isInitialized) return;
        await this.execSql(`PRAGMA journal_mode = WAL`);
        await this.execSql(`PRAGMA busy_timeout = 5000`);
        // 元数据表
        await this.execSql(`
            CREATE TABLE IF NOT EXISTS ${this.metaTableName} (
                vector_id TEXT PRIMARY KEY,
                item_id   TEXT NOT NULL,
                item_type TEXT NOT NULL
            )
        `);
        // 向量虚拟表（HM 内置 vec0，与 sqlite-vec 接口兼容）
        await this.execSql(`
            CREATE VIRTUAL TABLE IF NOT EXISTS ${this.vecTableName} USING vec0(
                vector_id TEXT PRIMARY KEY,
                repr float[${this.dimension}]
            )
        `);
        await this.execSql(`CREATE INDEX IF NOT EXISTS idx_vec_item_id  ON ${this.metaTableName}(item_id)`);
        await this.execSql(`CREATE INDEX IF NOT EXISTS idx_vec_item_type ON ${this.metaTableName}(item_type)`);
        this.isInitialized = true;
    }

    private validateDimension(repr: Float32Array | number[]): void {
        if (repr.length !== this.dimension) {
            throw new Error(`Vector dimension mismatch: expected ${this.dimension}, got ${repr.length}`);
        }
    }

    async insert(record: VectorIndexRecord): Promise<boolean> {
        await this.ensureInitialized();
        this.validateDimension(record.repr);
        const hexRepr = float32ToHexLiteral(record.repr);
        try {
            await this.runTransaction(async () => {
                await this.runSql(
                    `INSERT INTO ${this.metaTableName} (vector_id, item_id, item_type) VALUES (?, ?, ?)`,
                    [record.vector_id, record.item_id, record.item_type]
                );
                await this.execSql(`
                    INSERT INTO ${this.vecTableName} (vector_id, repr)
                    VALUES ('${escapeStr(record.vector_id)}', ${hexRepr})
                `);
            });
            return true;
        } catch (error: any) {
            const msg = error?.message || String(error);
            if (msg.includes('UNIQUE constraint failed') || msg.includes('PRIMARYKEY'))
                throw new Error(`Record with item_id '${record.item_id}' already exists`);
            throw error;
        }
    }

    async insertMany(records: VectorIndexRecord[]): Promise<number> {
        await this.ensureInitialized();
        if (records.length === 0) return 0;
        return this.runTransaction(async () => {
            let count = 0;
            for (const record of records) {
                try {
                    this.validateDimension(record.repr);
                    const hexRepr = float32ToHexLiteral(record.repr);
                    await this.runSql(
                        `INSERT INTO ${this.metaTableName} (vector_id, item_id, item_type) VALUES (?, ?, ?)`,
                        [record.vector_id, record.item_id, record.item_type]
                    );
                    await this.execSql(`
                        INSERT INTO ${this.vecTableName} (vector_id, repr)
                        VALUES ('${escapeStr(record.vector_id)}', ${hexRepr})
                    `);
                    count++;
                } catch (error: any) {
                    const msg = error?.message || String(error);
                    if (
                        !msg.includes('UNIQUE constraint failed') &&
                        !msg.includes('PRIMARYKEY') &&
                        !msg.includes('already exists')
                    )
                        throw error;
                }
            }
            return count;
        });
    }

    async upsert(record: VectorIndexRecord): Promise<boolean> {
        await this.ensureInitialized();
        this.validateDimension(record.repr);
        const hexRepr = float32ToHexLiteral(record.repr);
        await this.runTransaction(async () => {
            // 查询 item_id + item_type 对应的旧 vector_id（只替换同列向量）
            const oldRows = (await this.execSql(
                `SELECT vector_id FROM ${this.metaTableName} WHERE item_id = '${escapeStr(record.item_id)}' AND item_type = '${escapeStr(record.item_type)}'`
            )) as Array<{ vector_id: string }>;
            // 删除旧 vec 条目
            for (const row of oldRows) {
                await this.execSql(`DELETE FROM ${this.vecTableName} WHERE vector_id = '${escapeStr(row.vector_id)}'`);
            }
            // 删除旧 meta 条目
            await this.runSql(`DELETE FROM ${this.metaTableName} WHERE item_id = ? AND item_type = ?`, [
                record.item_id,
                record.item_type
            ]);
            // 插入新 meta 条目
            await this.runSql(`INSERT INTO ${this.metaTableName} (vector_id, item_id, item_type) VALUES (?, ?, ?)`, [
                record.vector_id,
                record.item_id,
                record.item_type
            ]);
            // 插入新 vec 条目（repr 字段用 X'hex' 字面量，vec0 不支持参数化写入）
            await this.execSql(`
                INSERT INTO ${this.vecTableName} (vector_id, repr)
                VALUES ('${escapeStr(record.vector_id)}', ${hexRepr})
            `);
        });
        return true;
    }

    async delete(itemId: string): Promise<boolean> {
        await this.ensureInitialized();
        if (!(await this.exists(itemId))) return false;
        await this.runTransaction(async () => {
            const rows = (await this.execSql(
                `SELECT vector_id FROM ${this.metaTableName} WHERE item_id = '${escapeStr(itemId)}'`
            )) as Array<{ vector_id: string }>;
            for (const row of rows) {
                await this.execSql(`DELETE FROM ${this.vecTableName} WHERE vector_id = '${escapeStr(row.vector_id)}'`);
            }
            await this.runSql(`DELETE FROM ${this.metaTableName} WHERE item_id = ?`, [itemId]);
        });
        return true;
    }

    async deleteMany(itemIds: string[]): Promise<number> {
        await this.ensureInitialized();
        if (itemIds.length === 0) return 0;
        let count = 0;
        await this.runTransaction(async () => {
            for (const id of itemIds) {
                const rows = (await this.execSql(
                    `SELECT vector_id FROM ${this.metaTableName} WHERE item_id = '${escapeStr(id)}'`
                )) as Array<{ vector_id: string }>;
                for (const row of rows) {
                    await this.execSql(
                        `DELETE FROM ${this.vecTableName} WHERE vector_id = '${escapeStr(row.vector_id)}'`
                    );
                }
                await this.runSql(`DELETE FROM ${this.metaTableName} WHERE item_id = ?`, [id]);
                if (rows.length > 0) count++;
            }
        });
        return count;
    }

    async search(
        queryVector: Float32Array | number[],
        options?: VectorSearchOptions,
        filterItemIds?: string[]
    ): Promise<VectorSearchResult[]> {
        await this.ensureInitialized();
        const hexVec = float32ToHexLiteral(queryVector);
        const metric = options?.metric || 'cosine';
        const distanceFunc = (() => {
            switch (metric) {
                case 'cosine':
                case 'dot_product':
                    return 'vec_distance_cosine';
                case 'euclidean':
                    return 'vec_distance_L2';
                case 'manhattan':
                    return 'vec_distance_L1';
                default:
                    return 'vec_distance_cosine';
            }
        })();
        const columnName = options?.columnName || '';
        const topK = Math.max(1, Math.trunc(Number(options?.topK)) || 100);
        if (!Number.isFinite(topK)) throw new Error(`Invalid topK value: ${options?.topK}`);

        let sql: string;
        if (filterItemIds && filterItemIds.length > 0) {
            // 带过滤的搜索：用 IN 子句（字面量内联）
            const idList = filterItemIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
            sql = `
                SELECT m.item_id, m.item_type,
                       ${distanceFunc}(v.repr, ${hexVec}) as distance
                FROM ${this.metaTableName} m
                JOIN ${this.vecTableName} v ON v.vector_id = m.vector_id
                WHERE m.item_type = '${escapeStr(columnName)}'
                  AND m.item_id IN (${idList})
                ORDER BY distance ASC
                LIMIT ${topK}
            `;
        } else {
            sql = `
                SELECT m.item_id, m.item_type,
                       ${distanceFunc}(v.repr, ${hexVec}) as distance
                FROM ${this.metaTableName} m
                JOIN ${this.vecTableName} v ON v.vector_id = m.vector_id
                WHERE m.item_type = '${escapeStr(columnName)}'
                ORDER BY distance ASC
                LIMIT ${topK}
            `;
        }

        const rows = (await this.execSql(sql)) as Array<{
            item_id: string;
            item_type: string;
            distance: number;
        }>;

        const results: VectorSearchResult[] = rows.map((row) => ({
            item_id: row.item_id,
            item_type: row.item_type,
            distance: row.distance,
            similarity: (() => {
                switch (metric) {
                    case 'cosine':
                    case 'dot_product':
                        return Math.max(0, Math.min(1, 1 - row.distance / 2));
                    case 'euclidean':
                    case 'manhattan':
                        return 1 / (1 + row.distance);
                    default:
                        return 1 - row.distance;
                }
            })()
        }));

        if (options?.threshold !== undefined) {
            return results.filter((r) => r.similarity >= options.threshold!);
        }
        return results;
    }

    async count(): Promise<number> {
        await this.ensureInitialized();
        const rows = await this.execSql(`SELECT COUNT(*) as count FROM ${this.metaTableName}`);
        return (rows[0] as { count?: number })?.count ?? 0;
    }

    async exists(itemId: string): Promise<boolean> {
        await this.ensureInitialized();
        const rows = await this.execSql(
            `SELECT 1 AS present FROM ${this.metaTableName} WHERE item_id = '${escapeStr(itemId)}' LIMIT 1`
        );
        return rows.length > 0;
    }

    async clear(): Promise<number> {
        await this.ensureInitialized();
        const countBefore = await this.count();
        await this.execSql(`DELETE FROM ${this.metaTableName}`);
        await this.execSql(`DELETE FROM ${this.vecTableName}`);
        return countBefore;
    }

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureInitialized();
        return this.runTransaction(fn);
    }

    close(): void {
        if (this.db) {
            this.addon.close(this.db);
            this.db = null;
        }
        this.isInitialized = false;
    }

    getDimension(): number {
        return this.dimension;
    }

    async getStats(): Promise<{ totalRecords: number; dimension: number; dbSize: number }> {
        await this.ensureInitialized();
        const totalRecords = await this.count();
        // hm_sqlite_addon 暂不提供 PRAGMA page_count/page_size，返回 0 作为占位
        return { totalRecords, dimension: this.dimension, dbSize: 0 };
    }
}

export default VectorIndexDBHm;
