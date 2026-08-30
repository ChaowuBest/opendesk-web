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
 * Vector Index Database Management Library
 *
 * 使用 SQLite + sqlite-vec 实现向量索引表的管理，支持并发安全的 CRUD 操作
 * 支持向量相似度搜索：cosine, euclidean, manhattan
 */

import type DatabaseType from 'better-sqlite3';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { SimilarityMetric } from './abstract-storage.js';
import type { BaseIndexStoreProbeResult } from './base-indexer.js';
import type { VectorIndexRecord, VectorSearchResult, VectorSearchOptions, IVectorIndexDB } from './vector-indexer.js';
import { removeSqliteStoreFiles } from './drop-utils.js';

// createRequire keeps resolution lazy — see base-index-db.ts for context.
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;
const sqliteVec = require('sqlite-vec') as typeof import('sqlite-vec');

export function probeVectorIndexStoreNative(dbPath: string): BaseIndexStoreProbeResult {
    if (!fs.existsSync(dbPath)) return 'missing';
    let db: DatabaseType.Database | null = null;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const table = db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get('vector_index_meta');
        if (!table) return 'missing';
        db.prepare('SELECT item_id FROM vector_index_meta LIMIT 1').all();
        return 'exists';
    } catch {
        return 'open_failed';
    } finally {
        db?.close();
    }
}

/**
 * 向量索引数据库管理类
 *
 * 使用 better-sqlite3 + sqlite-vec 实现同步 API
 * better-sqlite3 使用 SQLite 的 WAL 模式，支持多读单写
 */
export class VectorIndexDB implements IVectorIndexDB {
    readonly backend = 'native' as const;
    private db: Database.Database;
    private readonly metaTableName = 'vector_index_meta';
    private readonly vecTableName = 'vector_index_vec';
    private readonly dimension: number;
    private isInitialized = false;
    private readonly dbPath: string;

    constructor(dbPath: string, dimension: number = 1024) {
        this.dimension = dimension;
        this.dbPath = dbPath;

        // 确保目录存在
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // 创建数据库连接
        this.db = new Database(dbPath);

        // 加载 sqlite-vec 扩展
        sqliteVec.load(this.db);

        // 启用 WAL 模式以提高并发性能
        this.db.pragma('journal_mode = WAL');

        // 设置忙等待超时（毫秒）
        this.db.pragma('busy_timeout = 5000');

        // 初始化表结构
        this.initializeTable();
    }

    /**
     * 初始化数据库表结构
     */
    private initializeTable(): void {
        if (this.isInitialized) return;

        // 创建元数据表
        const createMetaTableSQL = `
            CREATE TABLE IF NOT EXISTS ${this.metaTableName} (
                vector_id TEXT PRIMARY KEY,
                item_id TEXT,
                item_type TEXT NOT NULL
            )
        `;
        this.db.exec(createMetaTableSQL);

        // 创建向量虚拟表
        const createVecTableSQL = `
            CREATE VIRTUAL TABLE IF NOT EXISTS ${this.vecTableName} USING vec0(
                vector_id TEXT PRIMARY KEY,
                repr float[${this.dimension}]
            )
        `;
        this.db.exec(createVecTableSQL);

        // 创建元数据表索引
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_vector_item_type ON ${this.metaTableName}(item_type)`);

        this.isInitialized = true;
    }

    /**
     * 将向量转换为 Float32Array
     */
    private toFloat32Array(repr: Float32Array | number[]): Float32Array {
        if (repr instanceof Float32Array) {
            return repr;
        }
        return new Float32Array(repr);
    }

    /**
     * 验证向量维度
     */
    private validateDimension(repr: Float32Array | number[]): void {
        const length = repr instanceof Float32Array ? repr.length : repr.length;
        if (length !== this.dimension) {
            throw new Error(`Vector dimension mismatch: expected ${this.dimension}, got ${length}`);
        }
    }

    /**
     * 距离转换为相似度
     */
    private distanceToSimilarity(distance: number, metric: SimilarityMetric): number {
        switch (metric) {
            case 'cosine':
                // cosine distance 范围 [0, 2]，相似度 = 1 - distance/2
                return Math.max(0, Math.min(1, 1 - distance / 2));
            case 'euclidean':
                // euclidean: similarity = 1 / (1 + distance)
                return 1 / (1 + distance);
            case 'manhattan':
                // manhattan: similarity = 1 / (1 + distance)
                return 1 / (1 + distance);
            case 'dot_product':
                // dot_product: 对于归一化向量，等同于 cosine
                return Math.max(0, Math.min(1, 1 - distance / 2));
            default:
                return 1 - distance;
        }
    }

    /**
     * 获取 sqlite-vec 距离函数名
     */
    private getDistanceFunction(metric: SimilarityMetric): string {
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
    }

    /**
     * 插入单条记录
     * @param record 要插入的记录
     * @returns 是否插入成功
     */
    async insert(record: VectorIndexRecord): Promise<boolean> {
        this.validateDimension(record.repr);
        const vecData = this.toFloat32Array(record.repr);

        const insertMeta = this.db.prepare(`
            INSERT OR REPLACE INTO ${this.metaTableName} (vector_id, item_id, item_type)
            VALUES (?, ?, ?)
        `);

        const deleteVec = this.db.prepare(`
            DELETE FROM ${this.vecTableName} WHERE vector_id = ?
        `);

        const insertVec = this.db.prepare(`
            INSERT INTO ${this.vecTableName} (vector_id, repr)
            VALUES (?, ?)
        `);

        const transaction = this.db.transaction(() => {
            insertMeta.run(record.vector_id, record.item_id, record.item_type);
            deleteVec.run(record.vector_id);
            insertVec.run(record.vector_id, vecData);
            return true;
        });

        return transaction();
    }

    /**
     * 批量插入记录（使用事务确保原子性）
     * @param records 要插入的记录数组
     * @returns 成功插入的记录数
     */
    async insertMany(records: VectorIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;

        const insertMeta = this.db.prepare(`
            INSERT OR IGNORE INTO ${this.metaTableName} (vector_id, item_id, item_type)
            VALUES (?, ?, ?)
        `);

        const deleteVec = this.db.prepare(`
            DELETE FROM ${this.vecTableName} WHERE vector_id = ?
        `);

        const insertVec = this.db.prepare(`
            INSERT INTO ${this.vecTableName} (vector_id, repr)
            VALUES (?, ?)
        `);

        const insertAll = this.db.transaction((records: VectorIndexRecord[]) => {
            let count = 0;
            for (const record of records) {
                this.validateDimension(record.repr);
                const vecData = this.toFloat32Array(record.repr);
                const metaResult = insertMeta.run(record.vector_id, record.item_id, record.item_type);
                if (metaResult.changes > 0) {
                    deleteVec.run(record.vector_id);
                    insertVec.run(record.vector_id, vecData);
                    count++;
                }
            }
            return count;
        });

        return insertAll(records);
    }

    /**
     * 插入或更新记录（upsert）
     * @param record 要插入或更新的记录
     * @returns 是否操作成功
     */
    async upsert(record: VectorIndexRecord): Promise<boolean> {
        return (await this.upsertMany([record])) > 0;
    }

    async upsertMany(records: VectorIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;
        const vectorIds = records.map((record) => record.vector_id);
        const placeholders = vectorIds.map(() => '?').join(', ');
        this.db.prepare(`DELETE FROM ${this.metaTableName} WHERE vector_id IN (${placeholders})`).run(vectorIds);
        this.db.prepare(`DELETE FROM ${this.vecTableName} WHERE vector_id IN (${placeholders})`).run(vectorIds);
        return this.insertMany(records);
    }

    async updateMany(records: VectorIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;
        const vectorIds = records.map((record) => record.vector_id);
        const placeholders = vectorIds.map(() => '?').join(', ');
        const existingRows = this.db
            .prepare(`SELECT vector_id FROM ${this.metaTableName} WHERE vector_id IN (${placeholders})`)
            .all(vectorIds) as { vector_id: string }[];
        const existingSet = new Set(existingRows.map((row) => row.vector_id));
        const toUpdate = records.filter((record) => existingSet.has(record.vector_id));
        if (toUpdate.length === 0) return 0;
        const updateIds = toUpdate.map((record) => record.vector_id);
        const updatePlaceholders = updateIds.map(() => '?').join(', ');
        this.db.prepare(`DELETE FROM ${this.metaTableName} WHERE vector_id IN (${updatePlaceholders})`).run(updateIds);
        this.db.prepare(`DELETE FROM ${this.vecTableName} WHERE vector_id IN (${updatePlaceholders})`).run(updateIds);
        return this.insertMany(toUpdate);
    }

    /**
     * 根据 item_id 删除记录
     * @param itemId 要删除的记录 ID
     * @returns 是否删除成功
     */
    async delete(itemId: string): Promise<boolean> {
        const selectVectorIds = this.db.prepare(`SELECT vector_id FROM ${this.metaTableName} WHERE item_id = ?`);
        const deleteMeta = this.db.prepare(`DELETE FROM ${this.metaTableName} WHERE item_id = ?`);
        const deleteVec = this.db.prepare(`DELETE FROM ${this.vecTableName} WHERE vector_id = ?`);

        const transaction = this.db.transaction(() => {
            const rows = selectVectorIds.all(itemId) as { vector_id: string }[];
            for (const row of rows) {
                deleteVec.run(row.vector_id);
            }
            const metaResult = deleteMeta.run(itemId);
            return metaResult.changes > 0;
        });

        return transaction();
    }

    /**
     * 批量删除记录
     * @param itemIds 要删除的记录 ID 数组
     * @returns 删除的记录数
     */
    async deleteMany(itemIds: string[]): Promise<number> {
        if (itemIds.length === 0) return 0;

        const selectVectorIds = this.db.prepare(`SELECT vector_id FROM ${this.metaTableName} WHERE item_id = ?`);
        const deleteMeta = this.db.prepare(`DELETE FROM ${this.metaTableName} WHERE item_id = ?`);
        const deleteVec = this.db.prepare(`DELETE FROM ${this.vecTableName} WHERE vector_id = ?`);

        const deleteAll = this.db.transaction((ids: string[]) => {
            let count = 0;
            for (const id of ids) {
                // 先查找对应的 vector_id
                const rows = selectVectorIds.all(id) as { vector_id: string }[];
                // 删除 vec 表中的记录
                for (const row of rows) {
                    deleteVec.run(row.vector_id);
                }
                // 删除 meta 表中的记录
                const result = deleteMeta.run(id);
                if (result.changes > 0) count++;
            }
            return count;
        });

        return deleteAll(itemIds);
    }

    /**
     * 向量相似度搜索
     * @param queryVector 查询向量
     * @param options 搜索选项
     * @param filterItemIds 可选的 item_id 过滤列表（用于 join）
     * @returns 搜索结果数组
     */
    async search(
        queryVector: Float32Array | number[],
        options?: VectorSearchOptions,
        filterItemIds?: string[]
    ): Promise<VectorSearchResult[]> {
        this.validateDimension(queryVector);
        const vecData = this.toFloat32Array(queryVector);
        const metric = options?.metric || 'cosine';
        const distanceFunc = this.getDistanceFunction(metric);
        const columnName = options?.columnName || '';
        const topK = options?.topK || 100;
        const threshold = options?.threshold;

        let sql: string;
        const params: any[] = [vecData, columnName, topK];
        let tempTableName: string | undefined;

        try {
            if (filterItemIds && filterItemIds.length > 0) {
                // 带过滤的搜索：使用临时表避免拼接 IN 列表
                tempTableName = `temp_filter_ids_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
                this.db.exec(`CREATE TEMP TABLE ${tempTableName} (item_id TEXT PRIMARY KEY)`);

                const insertTemp = this.db.prepare(`INSERT INTO ${tempTableName} (item_id) VALUES (?)`);
                const insertAll = this.db.transaction((ids: string[]) => {
                    for (const id of ids) {
                        insertTemp.run(id);
                    }
                });
                insertAll(filterItemIds);

                sql = `
                    SELECT
                        t.item_id,
                        m.item_type,
                        ${distanceFunc}(v.repr, ?) as distance
                    FROM ${tempTableName} t
                    JOIN ${this.metaTableName} m ON t.item_id = m.item_id
                    JOIN ${this.vecTableName} v ON v.vector_id = m.vector_id
                    WHERE m.item_type = ?
                    ORDER BY distance ASC
                    LIMIT ?
                `;
            } else {
                // 全量搜索
                sql = `
                    SELECT
                        v.vector_id,
                        m.item_id,
                        m.item_type,
                        ${distanceFunc}(v.repr, ?) as distance
                    FROM ${this.metaTableName} m
                    JOIN ${this.vecTableName} v ON v.vector_id = m.vector_id
                    WHERE m.item_type = ?
                    ORDER BY distance ASC
                    LIMIT ?
                `;
            }

            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...params) as Array<{ item_id: string; item_type: string; distance: number }>;

            // 转换为搜索结果
            const results: VectorSearchResult[] = rows.map((row) => ({
                item_id: row.item_id,
                item_type: row.item_type,
                distance: row.distance,
                similarity: this.distanceToSimilarity(row.distance, metric)
            }));

            // 应用相似度阈值过滤
            if (threshold !== undefined) {
                return results.filter((r) => r.similarity >= threshold);
            }

            return results;
        } finally {
            if (tempTableName) {
                this.db.exec(`DROP TABLE IF EXISTS ${tempTableName}`);
            }
        }
    }

    /**
     * 统计记录数
     * @returns 记录数
     */
    async count(): Promise<number> {
        const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM ${this.metaTableName}`);
        const result = stmt.get() as { count: number };
        return result.count;
    }

    /**
     * 检查记录是否存在
     * @param itemId 记录 ID
     * @returns 是否存在
     */
    async exists(itemId: string): Promise<boolean> {
        const stmt = this.db.prepare(`SELECT 1 FROM ${this.metaTableName} WHERE item_id = ? LIMIT 1`);
        return stmt.get(itemId) !== undefined;
    }

    /**
     * 清空所有记录
     * @returns 删除的记录数
     */
    async clear(): Promise<number> {
        const countBefore = await this.count();
        this.db.exec(`DELETE FROM ${this.metaTableName}`);
        this.db.exec(`DELETE FROM ${this.vecTableName}`);
        return countBefore;
    }

    async searchMeta(
        conditions?: import('./vector-indexer.js').VectorMetaCondition[]
    ): Promise<Array<{ item_id: string; item_type: string }>> {
        let sql = `SELECT DISTINCT item_id, item_type FROM ${this.metaTableName}`;
        const params: string[] = [];
        if (conditions && conditions.length > 0) {
            const clauses = conditions.map((c) => {
                if (c.operator === '=') {
                    params.push(c.value as string);
                    return `${c.field} = ?`;
                }
                const vals = Array.isArray(c.value) ? c.value : [c.value as string];
                vals.forEach((v) => params.push(v));
                return `${c.field} IN (${vals.map(() => '?').join(', ')})`;
            });
            sql += ` WHERE ${clauses.join(' AND ')}`;
        }
        return this.db.prepare(sql).all(...params) as { item_id: string; item_type: string }[];
    }

    /**
     * 在事务中执行多个操作
     * @param fn 要在事务中执行的函数
     * @returns 函数的返回值
     */
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        const transact = this.db.transaction(() => fn());
        return transact() as Promise<T>;
    }

    /**
     * 关闭数据库连接
     */
    close(): void {
        this.db.close();
    }

    async dropStorage(): Promise<void> {
        this.close();
        removeSqliteStoreFiles(this.dbPath);
        this.isInitialized = false;
    }

    /**
     * 获取向量维度
     */
    getDimension(): number {
        return this.dimension;
    }

    async getStoredDim(): Promise<number | null> {
        const stmt = this.db.prepare(`
            SELECT vec_length(repr) as dim FROM ${this.vecTableName} LIMIT 1
        `);
        const row = stmt.get() as { dim: number } | undefined;
        return row?.dim ?? null;
    }

    /**
     * 获取数据库统计信息
     */
    async getStats(): Promise<{ totalRecords: number; dimension: number; dbSize: number }> {
        const totalRecords = await this.count();
        const pageCount = (this.db.pragma('page_count') as { page_count: number }[])[0].page_count;
        const pageSize = (this.db.pragma('page_size') as { page_size: number }[])[0].page_size;
        const dbSize = pageCount * pageSize;

        return { totalRecords, dimension: this.dimension, dbSize };
    }
}

export default VectorIndexDB;
