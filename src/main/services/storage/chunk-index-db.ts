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
 * ChunkIndexDB — 分块向量索引数据库（Node.js 平台）
 *
 * 使用 better-sqlite3 + sqlite-vec 实现。
 * 双表架构：
 *   - chunk_index_meta: chunk_pk(PK), item_id(indexed), chunk_id, chunk_text
 *   - chunk_index_vec:  chunk_pk(PK), repr float[N]（vec0 虚拟表）
 */

import type DatabaseType from 'better-sqlite3';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { SimilarityMetric } from './abstract-storage.js';
import type { BaseIndexStoreProbeResult } from './base-indexer.js';
import type { ChunkIndexRecord, ChunkSearchResult, ChunkSearchOptions, IChunkIndexDB } from './chunk-indexer.js';
import { removeSqliteStoreFiles } from './drop-utils.js';
import {
    loadSqliteVec,
    recordStorageInitializationFailure,
    recordStorageCleanupFailure,
    handoffStorageInitializationCleanup,
    type RetainStorageInitializationCleanup
} from './platform.js';

// createRequire keeps resolution lazy — see base-index-db.ts for context.
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

export function probeChunkIndexStoreNative(dbPath: string): BaseIndexStoreProbeResult {
    if (!fs.existsSync(dbPath)) return 'missing';
    let db: DatabaseType.Database | null = null;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const table = db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get('chunk_index_meta');
        if (!table) return 'missing';
        db.prepare('SELECT item_id FROM chunk_index_meta LIMIT 1').all();
        return 'exists';
    } catch {
        return 'open_failed';
    } finally {
        db?.close();
    }
}

export class ChunkIndexDB implements IChunkIndexDB {
    readonly backend = 'native' as const;
    private db: DatabaseType.Database;
    private readonly metaTableName = 'chunk_index_meta';
    private readonly vecTableName = 'chunk_index_vec';
    private readonly dimension: number;
    private isInitialized = false;
    private readonly dbPath: string;

    constructor(dbPath: string, dimension: number = 1024, retainCleanup?: RetainStorageInitializationCleanup) {
        this.dimension = dimension;
        this.dbPath = dbPath;

        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(dbPath);
        try {
            loadSqliteVec(this.db);
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('busy_timeout = 5000');
            this.initializeTable();
        } catch (error) {
            recordStorageInitializationFailure(error, { indexer: 'ChunkIndexer', backend: 'native' });
            try {
                this.db.close();
            } catch (cleanupError) {
                // Preserve the initialization error if cleanup also fails.
                recordStorageCleanupFailure(error, cleanupError, 'ChunkIndexer');
                handoffStorageInitializationCleanup(error, () => this.close(), retainCleanup);
            }
            throw error;
        }
    }

    private initializeTable(): void {
        if (this.isInitialized) return;

        // 元数据表：存储 chunk 标识符和原文
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ${this.metaTableName} (
                chunk_pk   TEXT PRIMARY KEY,
                item_id    TEXT NOT NULL,
                chunk_id   TEXT NOT NULL,
                chunk_text TEXT NOT NULL
            )
        `);

        // item_id 建索引：用于按文件批量删除 chunk
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_chunk_item_id
            ON ${this.metaTableName}(item_id)
        `);

        // vec0 虚拟表：存储 chunk 向量
        this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS ${this.vecTableName} USING vec0(
                chunk_pk TEXT PRIMARY KEY,
                repr float[${this.dimension}]
            )
        `);

        this.isInitialized = true;
    }

    private toFloat32Array(repr: Float32Array | number[]): Float32Array {
        return repr instanceof Float32Array ? repr : new Float32Array(repr);
    }

    private validateDimension(repr: Float32Array | number[]): void {
        if (repr.length !== this.dimension) {
            throw new Error(`Vector dimension mismatch: expected ${this.dimension}, got ${repr.length}`);
        }
    }

    private distanceToSimilarity(distance: number, metric: SimilarityMetric): number {
        switch (metric) {
            case 'cosine':
            case 'dot_product':
                return Math.max(0, Math.min(1, 1 - distance / 2));
            case 'euclidean':
            case 'manhattan':
                return 1 / (1 + distance);
            default:
                return 1 - distance;
        }
    }

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

    async getStoredDim(): Promise<number | null> {
        const stmt = this.db.prepare(`SELECT vec_length(repr) as dim FROM ${this.vecTableName} LIMIT 1`);
        const row = stmt.get() as { dim: number } | undefined;
        return row?.dim ?? null;
    }

    existingItemIds(ids: string[]): Promise<Set<string>> {
        if (ids.length === 0) return Promise.resolve(new Set());
        const placeholders = ids.map(() => '?').join(', ');
        const rows = this.db
            .prepare(`SELECT DISTINCT item_id FROM ${this.metaTableName} WHERE item_id IN (${placeholders})`)
            .all(ids) as { item_id: string }[];
        return Promise.resolve(new Set(rows.map((row) => row.item_id)));
    }

    /**
     * 批量插入 chunk 记录（事务保证原子性）
     */
    async insertMany(records: ChunkIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;

        const insertMeta = this.db.prepare(`
            INSERT OR IGNORE INTO ${this.metaTableName} (chunk_pk, item_id, chunk_id, chunk_text)
            VALUES (?, ?, ?, ?)
        `);
        const deleteVec = this.db.prepare(`
            DELETE FROM ${this.vecTableName} WHERE chunk_pk = ?
        `);
        const insertVec = this.db.prepare(`
            INSERT INTO ${this.vecTableName} (chunk_pk, repr)
            VALUES (?, ?)
        `);

        const insertAll = this.db.transaction((records: ChunkIndexRecord[]) => {
            let count = 0;
            for (const record of records) {
                this.validateDimension(record.repr);
                const vecData = this.toFloat32Array(record.repr);
                const metaResult = insertMeta.run(record.chunk_pk, record.item_id, record.chunk_id, record.chunk_text);
                if (metaResult.changes > 0) {
                    deleteVec.run(record.chunk_pk);
                    insertVec.run(record.chunk_pk, vecData);
                    count++;
                }
            }
            return count;
        });

        return insertAll(records);
    }

    /**
     * 按 item_id 删除所有 chunk（含 vec 表）
     * 文件无 chunk 时删 0 行，无副作用
     */
    async deleteByItemId(itemId: string): Promise<number> {
        const selectChunkPks = this.db.prepare(`
            SELECT chunk_pk FROM ${this.metaTableName} WHERE item_id = ?
        `);
        const deleteMeta = this.db.prepare(`
            DELETE FROM ${this.metaTableName} WHERE item_id = ?
        `);
        const deleteVec = this.db.prepare(`
            DELETE FROM ${this.vecTableName} WHERE chunk_pk = ?
        `);

        const transaction = this.db.transaction(() => {
            // 先查出所有 chunk_pk，逐条删除 vec 表（vec0 虚拟表不支持 WHERE item_id）
            const rows = selectChunkPks.all(itemId) as { chunk_pk: string }[];
            for (const row of rows) {
                deleteVec.run(row.chunk_pk);
            }
            const result = deleteMeta.run(itemId);
            return result.changes;
        });

        return transaction();
    }

    /**
     * 批量按 item_id 删除（供 ChunkIndexer.delete() 使用）
     */
    async deleteManyByItemId(itemIds: string[]): Promise<number> {
        if (itemIds.length === 0) return 0;
        let total = 0;
        for (const id of itemIds) {
            total += await this.deleteByItemId(id);
        }
        return total;
    }

    /**
     * 向量相似度搜索
     */
    async search(
        queryVector: Float32Array | number[],
        options?: ChunkSearchOptions,
        filterItemIds?: string[]
    ): Promise<ChunkSearchResult[]> {
        this.validateDimension(queryVector);
        const vecData = this.toFloat32Array(queryVector);
        const metric = options?.metric || 'cosine';
        const distanceFunc = this.getDistanceFunction(metric);
        const topK = options?.topK || 10;
        const threshold = options?.threshold;

        let sql: string;
        let params: any[];
        let tempTableName: string | undefined;

        try {
            if (filterItemIds && filterItemIds.length > 0) {
                // 带 item_id 子集过滤：临时表避免 IN 列表字符串拼接
                tempTableName = `temp_chunk_filter_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
                this.db.exec(`CREATE TEMP TABLE ${tempTableName} (item_id TEXT PRIMARY KEY)`);
                const insertTemp = this.db.prepare(`INSERT INTO ${tempTableName} (item_id) VALUES (?)`);
                const insertAll = this.db.transaction((ids: string[]) => {
                    for (const id of ids) insertTemp.run(id);
                });
                insertAll(filterItemIds);

                sql = `
                    SELECT
                        m.item_id,
                        m.chunk_id,
                        m.chunk_text,
                        ${distanceFunc}(v.repr, ?) AS distance
                    FROM ${tempTableName} t
                    JOIN ${this.metaTableName} m ON t.item_id = m.item_id
                    JOIN ${this.vecTableName} v ON v.chunk_pk = m.chunk_pk
                    ORDER BY distance ASC
                    LIMIT ?
                `;
                params = [vecData, topK];
            } else {
                // 全表搜索
                sql = `
                    SELECT
                        m.item_id,
                        m.chunk_id,
                        m.chunk_text,
                        ${distanceFunc}(v.repr, ?) AS distance
                    FROM ${this.metaTableName} m
                    JOIN ${this.vecTableName} v ON v.chunk_pk = m.chunk_pk
                    ORDER BY distance ASC
                    LIMIT ?
                `;
                params = [vecData, topK];
            }

            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...params) as Array<{
                item_id: string;
                chunk_id: string;
                chunk_text: string;
                distance: number;
            }>;

            const results: ChunkSearchResult[] = rows.map((row) => ({
                item_id: row.item_id,
                chunk_id: row.chunk_id,
                chunk_text: row.chunk_text,
                distance: row.distance,
                similarity: this.distanceToSimilarity(row.distance, metric)
            }));

            // 应用相似度阈值过滤（>= threshold，与 VectorIndexer 语义一致）
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

    close(): void {
        this.db.close();
    }

    async dropStorage(): Promise<void> {
        this.close();
        removeSqliteStoreFiles(this.dbPath);
        this.isInitialized = false;
    }

    async count(): Promise<number> {
        const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM ${this.metaTableName}`);
        const row = stmt.get() as { count?: number } | undefined;
        return row?.count ?? 0;
    }

    async clear(): Promise<number> {
        const countBefore = await this.count();
        this.db.exec(`DELETE FROM ${this.metaTableName}`);
        this.db.exec(`DELETE FROM ${this.vecTableName}`);
        return countBefore;
    }

    getDimension(): number {
        return this.dimension;
    }
}

export default ChunkIndexDB;
