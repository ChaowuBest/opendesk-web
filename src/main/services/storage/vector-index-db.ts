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

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { SimilarityMetric } from './abstract-storage.js';

// 向量索引记录接口 - 保持语义最小化
export interface VectorIndexRecord {
    vector_id: string;
    item_id: string;
    item_type: string;
    repr: Float32Array | number[];
}

// 向量搜索结果
export interface VectorSearchResult {
    item_id: string;
    item_type: string;
    similarity: number;  // 0-1，越高越相似
    distance: number;    // 原始距离值
}

// 向量搜索选项
export interface VectorSearchOptions {
    columnName: string;
    /** 相似度计算方法，默认为 cosine */
    metric?: SimilarityMetric;
    /** 相似度阈值（0-1之间，值越大要求越相似） */
    threshold?: number;
    /** 返回最相似的 K 个结果 */
    topK?: number;
}

/**
 * 向量索引数据库管理类
 *
 * 使用 better-sqlite3 + sqlite-vec 实现同步 API
 * better-sqlite3 使用 SQLite 的 WAL 模式，支持多读单写
 */
export class VectorIndexDB {
    private db: Database.Database;
    private readonly metaTableName = 'vector_index_meta';
    private readonly vecTableName = 'vector_index_vec';
    private readonly dimension: number;
    private isInitialized = false;

    constructor(dbPath: string, dimension: number = 1024) {
        this.dimension = dimension;

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
    insert(record: VectorIndexRecord): boolean {
        this.validateDimension(record.repr);
        const vecData = this.toFloat32Array(record.repr);

        const insertMeta = this.db.prepare(`
            INSERT INTO ${this.metaTableName} (vector_id, item_id, item_type)
            VALUES (?, ?)
        `);

        const insertVec = this.db.prepare(`
            INSERT INTO ${this.vecTableName} (vector_id, repr)
            VALUES (?, ?)
        `);

        const transaction = this.db.transaction(() => {
            try {
                insertMeta.run(record.vector_id, record.item_id, record.item_type);
                insertVec.run(record.vector_id, vecData);
                return true;
            } catch (error: any) {
                if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
                    error.code === 'SQLITE_CONSTRAINT') {
                    throw new Error(`Record with item_id '${record.item_id}' already exists`);
                }
                throw error;
            }
        });

        return transaction();
    }

    /**
     * 批量插入记录（使用事务确保原子性）
     * @param records 要插入的记录数组
     * @returns 成功插入的记录数
     */
    insertMany(records: VectorIndexRecord[]): number {
        if (records.length === 0) return 0;

        const insertMeta = this.db.prepare(`
            INSERT INTO ${this.metaTableName} (vector_id, item_id, item_type)
            VALUES (?, ?, ?)
        `);

        const insertVec = this.db.prepare(`
            INSERT INTO ${this.vecTableName} (vector_id, repr)
            VALUES (?, ?)
        `);

        const insertAll = this.db.transaction((records: VectorIndexRecord[]) => {
            let count = 0;
            for (const record of records) {
                try {
                    this.validateDimension(record.repr);
                    const vecData = this.toFloat32Array(record.repr);
                    insertMeta.run(record.vector_id, record.item_id, record.item_type);
                    insertVec.run(record.vector_id, vecData);
                    count++;
                } catch (error: any) {
                    // 跳过重复记录，继续插入其他记录
                    if (error.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' &&
                        error.code !== 'SQLITE_CONSTRAINT' &&
                        !error.message?.includes('already exists')) {
                        throw error;
                    }
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
    upsert(record: VectorIndexRecord): boolean {
        this.validateDimension(record.repr);
        const vecData = this.toFloat32Array(record.repr);

        const upsertMeta = this.db.prepare(`
            INSERT INTO ${this.metaTableName} (vector_id, item_id, item_type)
            VALUES (?, ?, ?)
            ON CONFLICT(vector_id) DO UPDATE SET
                item_type = excluded.item_type
        `);

        const selectVectorIds = this.db.prepare(`
            SELECT vector_id FROM ${this.metaTableName} WHERE item_id = ?
        `);

        const insertVec = this.db.prepare(`
            INSERT INTO ${this.vecTableName} (vector_id, repr)
            VALUES (?, ?)
        `);

        let tempTableName = `temp_vector_ids_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

        const transaction = this.db.transaction(() => {
            // 1. 插入/更新 meta 表
            upsertMeta.run(record.vector_id, record.item_id, record.item_type);

            // 2. 查询 item_id 对应的所有 vector_id
            const vectorRows = selectVectorIds.all(record.item_id) as Array<{ vector_id: string }>;

            // 3. 构建临时表并删除所有旧 vector_id
            this.db.exec(`CREATE TEMP TABLE ${tempTableName} (vector_id TEXT PRIMARY KEY)`);
            const insertTemp = this.db.prepare(`INSERT INTO ${tempTableName} (vector_id) VALUES (?)`);
            for (const row of vectorRows) {
                insertTemp.run(row.vector_id);
            }
            this.db.prepare(`
                DELETE FROM ${this.vecTableName}
                WHERE vector_id IN (SELECT vector_id FROM ${tempTableName})
            `).run();

            // 4. 插入对应 vector_id 的向量
            insertVec.run(record.vector_id, vecData);
            return true;
        });

        try {
            return transaction();
        } finally {
            this.db.exec(`DROP TABLE IF EXISTS ${tempTableName}`);
        }
    }

    /**
     * 根据 item_id 删除记录
     * @param itemId 要删除的记录 ID
     * @returns 是否删除成功
     */
    delete(itemId: string): boolean {
        const deleteMeta = this.db.prepare(`DELETE FROM ${this.metaTableName} WHERE item_id = ?`);
        const deleteVec = this.db.prepare(`DELETE FROM ${this.vecTableName} WHERE item_id = ?`);

        const transaction = this.db.transaction(() => {
            const metaResult = deleteMeta.run(itemId);
            deleteVec.run(itemId);
            return metaResult.changes > 0;
        });

        return transaction();
    }

    /**
     * 批量删除记录
     * @param itemIds 要删除的记录 ID 数组
     * @returns 删除的记录数
     */
    deleteMany(itemIds: string[]): number {
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
    search(
        queryVector: Float32Array | number[],
        options?: VectorSearchOptions,
        filterItemIds?: string[]
    ): VectorSearchResult[] {
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
                        v.vector_id,
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
            const results: VectorSearchResult[] = rows.map(row => ({
                item_id: row.item_id,
                item_type: row.item_type,
                distance: row.distance,
                similarity: this.distanceToSimilarity(row.distance, metric),
            }));

            // 应用相似度阈值过滤
            if (threshold !== undefined) {
                return results.filter(r => r.similarity >= threshold);
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
    count(): number {
        const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM ${this.metaTableName}`);
        const result = stmt.get() as { count: number };
        return result.count;
    }

    /**
     * 检查记录是否存在
     * @param itemId 记录 ID
     * @returns 是否存在
     */
    exists(itemId: string): boolean {
        const stmt = this.db.prepare(`SELECT 1 FROM ${this.metaTableName} WHERE item_id = ? LIMIT 1`);
        return stmt.get(itemId) !== undefined;
    }

    /**
     * 清空所有记录
     * @returns 删除的记录数
     */
    clear(): number {
        const countBefore = this.count();
        this.db.exec(`DELETE FROM ${this.metaTableName}`);
        this.db.exec(`DELETE FROM ${this.vecTableName}`);
        return countBefore;
    }

    /**
     * 在事务中执行多个操作
     * @param fn 要在事务中执行的函数
     * @returns 函数的返回值
     */
    transaction<T>(fn: () => T): T {
        const transaction = this.db.transaction(fn);
        return transaction();
    }

    /**
     * 关闭数据库连接
     */
    close(): void {
        this.db.close();
    }

    /**
     * 获取向量维度
     */
    getDimension(): number {
        return this.dimension;
    }

    /**
     * 获取数据库统计信息
     */
    getStats(): { totalRecords: number; dimension: number; dbSize: number } {
        const totalRecords = this.count();
        const pageCount = (this.db.pragma('page_count') as { page_count: number }[])[0].page_count;
        const pageSize = (this.db.pragma('page_size') as { page_size: number }[])[0].page_size;
        const dbSize = pageCount * pageSize;

        return { totalRecords, dimension: this.dimension, dbSize };
    }
}

/**
 * 创建 VectorIndexDB 实例的工厂函数
 * @param dbPath 数据库文件路径
 * @param dimension 向量维度，默认 1024
 * @returns VectorIndexDB 实例
 */
export function createVectorIndexDB(dbPath: string, dimension: number = 1024): VectorIndexDB {
    return new VectorIndexDB(dbPath, dimension);
}

export default VectorIndexDB;
