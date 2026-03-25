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
 * ChunkIndexer - 分块向量索引器
 *
 * 支持 RAG 场景：一个 item 对应多条 chunk 记录（1:N）。
 * insert = upsert 语义：已存在则先删除再写入，与 update() 保持相同模式。
 * update = 全量替换：先 deleteByItemId，再 insertMany。
 * 只能和 BaseIndexer 联合搜索（searchWithChunkIndexer 路径），
 * 直接调用 search() 方法会抛出错误。
 */

import { Indexer, IndexerSearchOptions, IndexerSearchResult } from './indexer.js';
import { Item, FilterCondition, QueryOperator, ColumnSchema, SimilarityMetric } from './abstract-storage.js';
import { randomUUID } from 'crypto';

// ── Chunk 存储记录 ─────────────────────────────────────────────────
export interface ChunkIndexRecord {
    chunk_pk: string;        // 内部主键，UUID，由 ChunkIndexer 生成
    item_id: string;         // 父文件 ID
    chunk_id: string;        // 调用方提供的 chunk 标识符
    chunk_text: string;      // chunk 原文
    repr: Float32Array | number[];  // chunk embedding 向量
}

// ── Chunk 搜索结果（searchChunks 返回）────────────────────────────
export interface ChunkSearchResult {
    item_id: string;
    chunk_id: string;
    chunk_text: string;
    similarity: number;   // 0-1，越高越相似
    distance: number;     // 原始距离
}

// ── ChunkIndexDB 搜索选项 ──────────────────────────────────────────
export interface ChunkSearchOptions {
    metric?: SimilarityMetric;
    topK?: number;
    threshold?: number;
}

// ============================================================================
// IChunkIndexDB — 统一异步接口（ChunkIndexDB 和 ChunkIndexDBHm 共同实现）
// ============================================================================
export interface IChunkIndexDB {
    /** 批量插入 chunk 记录（事务保证原子性） */
    insertMany(records: ChunkIndexRecord[]): Promise<number>;
    /** 按 item_id 删除所有 chunk，无 chunk 时删 0 行，无副作用 */
    deleteByItemId(itemId: string): Promise<number>;
    /** 按多个 item_id 批量删除 */
    deleteManyByItemId(itemIds: string[]): Promise<number>;
    /**
     * 向量相似度搜索
     * @param queryVector 查询向量
     * @param options 搜索选项（metric, topK, threshold）
     * @param filterItemIds 保留接口扩展位，当前路径未使用。
     *   当前搜索顺序是：ChunkIndexer 先全量召回 topK 候选，再由 BaseStorage 用 BaseIndexer 做元数据过滤。
     *   此参数不用于"BaseIndexer 预过滤后再搜 Chunk"的路径。
     * @returns 匹配的 chunk 结果列表，按相似度降序排列
     */
    search(
        queryVector: Float32Array | number[],
        options?: ChunkSearchOptions,
        filterItemIds?: string[]
    ): Promise<ChunkSearchResult[]>;
    clear(): Promise<number>;
    count(): Promise<number>;
    close(): void;
    getDimension(): number;
}

// ============================================================================
// ChunkIndexer — 分块向量索引器（继承 Indexer）
// ============================================================================

export class ChunkIndexer extends Indexer {
    readonly name = 'ChunkIndexer';
    readonly supportedFields = ['chunk_text'];
    readonly supportedOperators: QueryOperator[] = [
        'vector_similarity',
        'vector_near',
        'vector_not_similar',
        'vector_range',
    ];

    private db: IChunkIndexDB | null = null;
    private readonly _dbPath: string;
    private readonly dimension: number;
    private readonly schema: ColumnSchema;

    constructor(schema: ColumnSchema, dbPath: string, options?: Record<string, any>) {
        super();
        const validKeys = ['dim'];
        const unknown = Object.keys(options ?? {}).filter(k => !validKeys.includes(k));
        if (unknown.length > 0) {
            throw new Error(`ChunkIndexer: unknown options: ${unknown}`);
        }
        this.schema = schema;
        this._dbPath = dbPath;
        this.dimension = typeof options?.dim === 'number' ? options.dim : 1024;
    }

    /**
     * 初始化：懒加载 ChunkIndexDB
     */
    async initialize(): Promise<void> {
        if (!this.db) {
            this.db = await createChunkIndexDB(this._dbPath, this.dimension);
        }
    }

    private ensureDB(): IChunkIndexDB {
        if (!this.db) throw new Error('ChunkIndexer not initialized. Call initialize() first.');
        return this.db;
    }

    /**
     * insert — upsert 语义（已存在则先删除再写入）
     *
     * 规则：
     * 1. 跳过没有 indexer_columns.ChunkIndexer 的 item（合法：文件无 chunk）
     * 2. 对有 ChunkIndexer entries 的 item：校验 id/text/content 均存在，缺一报错
     * 3. 无条件调用 deleteByItemId 删除旧记录（与 update() 保持相同模式）
     * 4. 调用 insertMany 批量写入
     */
    async insert(items: Item[]): Promise<void> {
        const db = this.ensureDB();
        for (const item of items) {
            const entries = item.indexer_columns?.['ChunkIndexer'];
            if (!entries || entries.length === 0) {
                // 合法：文件无 chunk，跳过
                continue;
            }

            // 校验每条 entry 的必填字段
            for (const entry of entries) {
                if (!entry.id) {
                    throw new Error(
                        `[ChunkIndexer] Item ${item.item_id}: entry missing 'id' (chunk_id). ` +
                        `ChunkIndexer requires id, text, and content for each entry.`
                    );
                }
                if (entry.text === undefined || entry.text === null) {
                    throw new Error(
                        `[ChunkIndexer] Item ${item.item_id}: entry missing 'text' (chunk_text). ` +
                        `ChunkIndexer requires id, text, and content for each entry.`
                    );
                }
                if (!entry.content || !Array.isArray(entry.content) || entry.content.length === 0) {
                    throw new Error(
                        `[ChunkIndexer] Item ${item.item_id}: entry missing or invalid 'content' (embedding vector). ` +
                        `ChunkIndexer requires id, text, and content for each entry.`
                    );
                }
            }

            // 无条件删除旧记录（upsert 语义，与 update() 保持相同模式）
            await db.deleteByItemId(item.item_id);

            // 构建 ChunkIndexRecord[]
            const records: ChunkIndexRecord[] = entries.map(entry => ({
                chunk_pk: randomUUID(),
                item_id: item.item_id,
                chunk_id: entry.id!,
                chunk_text: entry.text!,
                repr: entry.content as number[],
            }));

            await db.insertMany(records);
        }
    }

    /**
     * delete — 无条件删除 item 的所有 chunk
     * 文件无 chunk 时删 0 行，无副作用
     */
    async delete(itemIds: string[]): Promise<void> {
        await this.ensureDB().deleteManyByItemId(itemIds);
    }

    /**
     * update — 全量替换语义
     *
     * 1. 跳过没有 indexer_columns.ChunkIndexer 的 item（BaseStorage 层已过滤，双重保护）
     * 2. 对有 ChunkIndexer entries 的 item：
     *    a. deleteByItemId 删除所有旧 chunk
     *    b. 校验 entry 字段（同 insert）
     *    c. insertMany 写入新 chunk 集
     */
    async update(items: Item[]): Promise<void> {
        const db = this.ensureDB();
        for (const item of items) {
            const entries = item.indexer_columns?.['ChunkIndexer'];
            if (!entries || entries.length === 0) {
                continue;
            }

            // 校验必填字段
            for (const entry of entries) {
                if (!entry.id) {
                    throw new Error(
                        `[ChunkIndexer] Item ${item.item_id}: update entry missing 'id'.`
                    );
                }
                if (entry.text === undefined || entry.text === null) {
                    throw new Error(
                        `[ChunkIndexer] Item ${item.item_id}: update entry missing 'text'.`
                    );
                }
                if (!entry.content || !Array.isArray(entry.content) || entry.content.length === 0) {
                    throw new Error(
                        `[ChunkIndexer] Item ${item.item_id}: update entry missing or invalid 'content'.`
                    );
                }
            }

            // 全量替换：先删除所有旧 chunk
            await db.deleteByItemId(item.item_id);

            // 再插入新 chunk 集
            const records: ChunkIndexRecord[] = entries.map(entry => ({
                chunk_pk: randomUUID(),
                item_id: item.item_id,
                chunk_id: entry.id!,
                chunk_text: entry.text!,
                repr: entry.content as number[],
            }));

            await db.insertMany(records);
        }
    }

    /**
     * searchChunks — 向量相似度搜索，供 BaseStorage.searchWithChunkIndexer() 调用
     *
     * 搜索顺序：ChunkIndexer 先按 embedding 全量召回 topK 候选，
     * BaseStorage 再用 BaseIndexer 对候选的 item_id 子集做元数据过滤。
     * filterItemIds 参数保留接口扩展位，当前路径不传（searchWithChunkIndexer Step 2 不预过滤）。
     *
     * @param queryVector 查询向量
     * @param vectorQuery 向量查询参数（topK, metric, threshold）
     * @param filterItemIds 保留接口扩展位，当前路径未使用，调用时不传
     * @returns ChunkSearchResult[]，按 similarity 降序
     */
    async searchChunks(
        queryVector: Float32Array | number[],
        vectorQuery: { topK?: number; metric?: SimilarityMetric; threshold?: number },
        filterItemIds?: string[]
    ): Promise<ChunkSearchResult[]> {
        const options: ChunkSearchOptions = {
            metric: vectorQuery.metric || 'cosine',
            topK: vectorQuery.topK || 10,
            threshold: vectorQuery.threshold,
        };
        return this.ensureDB().search(queryVector, options, filterItemIds);
    }

    /**
     * search — 实现 Indexer 接口要求，但 ChunkIndexer 不支持此路径
     *
     * ChunkIndexer 必须通过 BaseStorage.searchWithChunkIndexer() 调用，
     * 直接调用此方法说明存在代码路径错误。
     */
    async search(
        conditions: FilterCondition[],
        options?: IndexerSearchOptions
    ): Promise<IndexerSearchResult> {
        throw new Error(
            '[ChunkIndexer] search() should not be called directly. ' +
            'ChunkIndexer conditions are handled by BaseStorage.searchWithChunkIndexer().'
        );
    }

    close(): void {
        this.db?.close();
        this.db = null;
    }

    async clear(): Promise<void> {
        await this.ensureDB().clear();
    }

    async getInfo(): Promise<Record<string, any>> {
        const db = this.ensureDB();
        return {
            size: await db.count(),
            dim: db.getDimension(),
        };
    }

    getDimension(): number {
        return this.dimension;
    }
}

/**
 * 工厂函数：根据平台自动选择 ChunkIndexDB 实现
 */
export async function createChunkIndexDB(dbPath: string, dimension: number = 1024): Promise<IChunkIndexDB> {
    if ((process.platform as string) === 'openharmony') {
        const { ChunkIndexDBHm } = await import('./chunk-index-db-hm.js');
        return new ChunkIndexDBHm(dbPath, dimension);
    }
    const { ChunkIndexDB } = await import('./chunk-index-db.js');
    return new ChunkIndexDB(dbPath, dimension);
}

export default ChunkIndexer;
