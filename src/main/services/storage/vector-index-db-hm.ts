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
import { loadSqliteAddon, type HmSqliteAddon } from './hm-addon-loader.js';
import type { VectorIndexRecord, VectorSearchResult, VectorSearchOptions, IVectorIndexDB } from './vector-indexer.js';

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
        this.addon = loadSqliteAddon();
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

    private async existingVectorIds(vectorIds: string[]): Promise<Set<string>> {
        if (vectorIds.length === 0) return new Set();
        const idList = vectorIds.map((id) => `'${escapeStr(id)}'`).join(', ');
        const rows = (await this.execSql(
            `SELECT vector_id FROM ${this.metaTableName} WHERE vector_id IN (${idList})`
        )) as { vector_id: string }[];
        return new Set(rows.map((row) => row.vector_id));
    }

    async insert(record: VectorIndexRecord): Promise<boolean> {
        await this.ensureInitialized();
        this.validateDimension(record.repr);
        const hexRepr = float32ToHexLiteral(record.repr);
        await this.runTransaction(async () => {
            await this.runSql(
                `INSERT OR REPLACE INTO ${this.metaTableName} (vector_id, item_id, item_type) VALUES (?, ?, ?)`,
                [record.vector_id, record.item_id, record.item_type]
            );
            await this.execSql(`DELETE FROM ${this.vecTableName} WHERE vector_id = '${escapeStr(record.vector_id)}'`);
            await this.execSql(`
                INSERT INTO ${this.vecTableName} (vector_id, repr)
                VALUES ('${escapeStr(record.vector_id)}', ${hexRepr})
            `);
        });
        return true;
    }

    async insertMany(records: VectorIndexRecord[]): Promise<number> {
        await this.ensureInitialized();
        if (records.length === 0) return 0;
        const existingSet = await this.existingVectorIds(records.map((record) => record.vector_id));
        const toInsert = records.filter((record) => !existingSet.has(record.vector_id));
        if (toInsert.length === 0) return 0;
        return this.runTransaction(async () => {
            let count = 0;
            for (const record of toInsert) {
                this.validateDimension(record.repr);
                const hexRepr = float32ToHexLiteral(record.repr);
                await this.runSql(
                    `INSERT OR IGNORE INTO ${this.metaTableName} (vector_id, item_id, item_type) VALUES (?, ?, ?)`,
                    [record.vector_id, record.item_id, record.item_type]
                );
                await this.execSql(
                    `DELETE FROM ${this.vecTableName} WHERE vector_id = '${escapeStr(record.vector_id)}'`
                );
                await this.execSql(`
                    INSERT INTO ${this.vecTableName} (vector_id, repr)
                    VALUES ('${escapeStr(record.vector_id)}', ${hexRepr})
                `);
                count++;
            }
            return count;
        });
    }

    async upsert(record: VectorIndexRecord): Promise<boolean> {
        return (await this.upsertMany([record])) > 0;
    }

    async upsertMany(records: VectorIndexRecord[]): Promise<number> {
        await this.ensureInitialized();
        if (records.length === 0) return 0;
        const idList = records.map((record) => `'${escapeStr(record.vector_id)}'`).join(', ');
        await this.execSql(`DELETE FROM ${this.metaTableName} WHERE vector_id IN (${idList})`);
        await this.execSql(`DELETE FROM ${this.vecTableName} WHERE vector_id IN (${idList})`);
        return this.insertMany(records);
    }

    async updateMany(records: VectorIndexRecord[]): Promise<number> {
        await this.ensureInitialized();
        if (records.length === 0) return 0;
        const existingSet = await this.existingVectorIds(records.map((record) => record.vector_id));
        const toUpdate = records.filter((record) => existingSet.has(record.vector_id));
        if (toUpdate.length === 0) return 0;
        const idList = toUpdate.map((record) => `'${escapeStr(record.vector_id)}'`).join(', ');
        await this.execSql(`DELETE FROM ${this.metaTableName} WHERE vector_id IN (${idList})`);
        await this.execSql(`DELETE FROM ${this.vecTableName} WHERE vector_id IN (${idList})`);
        return this.insertMany(toUpdate);
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

    async searchMeta(
        conditions?: import('./vector-indexer.js').VectorMetaCondition[]
    ): Promise<Array<{ item_id: string; item_type: string }>> {
        await this.ensureInitialized();
        let sql = `SELECT DISTINCT item_id, item_type FROM ${this.metaTableName}`;
        if (conditions && conditions.length > 0) {
            const clauses = conditions.map((c) => {
                if (c.operator === '=') {
                    return `${c.field} = '${escapeStr(c.value as string)}'`;
                }
                const vals = Array.isArray(c.value) ? c.value : [c.value as string];
                return `${c.field} IN (${vals.map((v) => `'${escapeStr(v)}'`).join(', ')})`;
            });
            sql += ` WHERE ${clauses.join(' AND ')}`;
        }
        return (await this.execSql(sql)) as { item_id: string; item_type: string }[];
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

    async getStoredDim(): Promise<number | null> {
        await this.ensureInitialized();
        const rows = (await this.execSql(`SELECT vec_length(repr) as dim FROM ${this.vecTableName} LIMIT 1`)) as Array<{
            dim: number;
        }>;
        return rows[0]?.dim ?? null;
    }

    async getStats(): Promise<{ totalRecords: number; dimension: number; dbSize: number }> {
        await this.ensureInitialized();
        const totalRecords = await this.count();
        // hm_sqlite_addon 暂不提供 PRAGMA page_count/page_size，返回 0 作为占位
        return { totalRecords, dimension: this.dimension, dbSize: 0 };
    }
}

export default VectorIndexDBHm;
