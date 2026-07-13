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
 * VectorIndexer - SQLite-vec 向量索引器
 *
 * 包装 VectorIndexDB 实现 Indexer 接口。
 * 用于基于向量相似度的文件索引和查询。
 */

import { Indexer, IndexerSearchOptions, IndexerSearchResult } from './indexer.js';
import {
    Item,
    FilterCondition,
    VectorOperator,
    QueryOperator,
    VectorQuery,
    ItemType,
    ColumnSchema,
    SimilarityMetric,
    DimMismatchError,
    ACCEPTING_SEMANTIC_WRITES,
    SemanticWriteAvailability
} from './abstract-storage.js';
import type { BaseIndexStoreProbeResult } from './base-indexer.js';
import { createVectorIndexDB, dropVectorIndexStore, probeVectorIndexStore } from './vector-index-db-factory.js';

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
    similarity: number; // 0-1，越高越相似
    distance: number; // 原始距离值
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

export interface VectorMetaCondition {
    field: 'item_id' | 'item_type';
    operator: '=' | 'in';
    value: string | string[];
}

// ============================================================================
// IVectorIndexDB - 统一异步接口（VectorIndexDB 和 VectorIndexDBHm 共同实现）
// ============================================================================
export interface IVectorIndexDB {
    readonly backend: 'native' | 'arkdata' | 'wasm';
    insert(record: VectorIndexRecord): Promise<boolean>;
    insertMany(records: VectorIndexRecord[]): Promise<number>;
    upsert(record: VectorIndexRecord): Promise<boolean>;
    upsertMany(records: VectorIndexRecord[]): Promise<number>;
    updateMany(records: VectorIndexRecord[]): Promise<number>;
    delete(itemId: string): Promise<boolean>;
    deleteMany(itemIds: string[]): Promise<number>;
    search(
        queryVector: Float32Array | number[],
        options?: VectorSearchOptions,
        filterItemIds?: string[]
    ): Promise<VectorSearchResult[]>;
    count(): Promise<number>;
    exists(itemId: string): Promise<boolean>;
    clear(): Promise<number>;
    searchMeta(conditions?: VectorMetaCondition[]): Promise<Array<{ item_id: string; item_type: string }>>;
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    close(): void;
    dropStorage(): Promise<void>;
    getDimension(): number;
    getStoredDim(): Promise<number | null>;
    getWriteState?(): Promise<SemanticWriteAvailability>;
}

/**
 * 向量索引器
 *
 * 使用 SQLite + sqlite-vec 存储向量索引，支持向量相似度查询。
 * 不支持标量操作符。
 */

// VectorIndexer 层负责分别插入多个向量

export class VectorIndexer extends Indexer {
    readonly name = 'VectorIndexer';
    readonly supportedFields = ['repr'];
    readonly supportedOperators: QueryOperator[] = [
        'vector_similarity',
        'vector_near',
        'vector_not_similar',
        'vector_range'
    ];
    private readonly columnName = 'repr';

    private db: IVectorIndexDB | null = null;
    private readonly _dbPath: string;
    private readonly dimension: number;
    private schema: ColumnSchema;
    private isDropped = false;

    constructor(schema: ColumnSchema, dbPath: string, options?: Record<string, any>) {
        super();
        const validKeys = ['dim'];
        const unknown = Object.keys(options ?? {}).filter((k) => !validKeys.includes(k));
        if (unknown.length > 0) throw new Error(`VectorIndexer: unknown options: ${unknown}`);
        this.dimension = typeof options?.dim === 'number' ? options.dim : 1024;
        this.schema = schema;
        this._dbPath = dbPath;
    }

    /**
     * 初始化索引器
     */
    async initialize(): Promise<void> {
        if (this.isDropped) {
            throw new Error('VectorIndexer storage has been dropped. Construct a new VectorIndexer.');
        }
        if (!this.db) {
            this.db = await createVectorIndexDB(this._dbPath, this.dimension);
        }
        // Check stored dim matches configured dim
        const storedDim = await this.db.getStoredDim();
        if (storedDim !== null && storedDim !== this.dimension) {
            throw new DimMismatchError(storedDim, this.dimension);
        }
    }

    async probeStore(): Promise<BaseIndexStoreProbeResult> {
        return probeVectorIndexStore(this._dbPath);
    }

    private ensureDB(): IVectorIndexDB {
        if (this.isDropped) {
            throw new Error('VectorIndexer storage has been dropped. Construct a new VectorIndexer.');
        }
        if (!this.db) throw new Error('VectorIndexer not initialized. Call initialize() first.');
        return this.db;
    }

    getBackend(): IVectorIndexDB['backend'] {
        return this.ensureDB().backend;
    }

    /**
     * 验证操作符是否支持
     */
    private validateOperator(operator: QueryOperator): void {
        if (!this.supportsOperator(operator)) {
            throw new Error(
                `VectorIndexer does not support operator: ${operator}. ` +
                    `Supported operators: ${this.supportedOperators.join(', ')}`
            );
        }
    }

    /**
     * 验证字段是否支持
     */
    private validateField(field: string): void {
        const indexers = this.schema.needIndexers?.[field];
        if (!indexers || !indexers.some((b) => b.indexer === this.name)) {
            throw new Error(
                `VectorIndexer does not support field: ${field}. ` +
                    `Field must be listed in schema.needIndexers with VectorIndexer`
            );
        }
    }

    /**
     * 从条件中提取查询向量
     */
    private extractQueryVector(value: any): Float32Array | number[] {
        if (value instanceof Float32Array) {
            return value;
        }
        if (Array.isArray(value)) {
            return value;
        }
        throw new Error('Vector query value must be Float32Array or number[]');
    }

    /**
     * VectorSearchResult → Item 转换
     *
     * 注意：VectorIndexRecord 不包含 text, tag, created_at, updated_at 字段
     * 如果有 existingResults，从中获取完整元数据
     */
    private resultToItem(result: { item_id: string; item_type: string }, metadata?: Partial<Item>): Item {
        const item = {
            item_id: result.item_id
        } as Item;
        // 从 metadata 复制所有额外字段
        if (metadata) {
            for (const [key, value] of Object.entries(metadata)) {
                if (!(key in item) && value !== undefined) {
                    item[key] = value;
                }
            }
            if (metadata.item_type !== undefined) {
                item.item_type = metadata.item_type;
            }
        }
        return item;
    }

    private buildRecords(items: Item[]): VectorIndexRecord[] {
        const records: VectorIndexRecord[] = [];
        for (const item of items) {
            const columns = item.indexer_columns?.[this.name] as
                | Array<{ column: string; content: string | number[] }>
                | undefined;
            if (!columns || columns.length === 0) continue;
            for (const col of columns) {
                const repr = col.content;
                const validRepr =
                    Array.isArray(repr) && repr.length === this.dimension && repr.every((v) => typeof v === 'number');
                if (!validRepr) {
                    throw new Error(
                        `[VectorIndexer] Item ${item.item_id} has invalid repr for column ${col.column}: expected number[] of length ${this.dimension}`
                    );
                }
                const stableId = `${item.item_id}_${col.column}`;
                const record = this.itemToRecord(item, col.column, repr as number[], stableId);
                if (record) records.push(record);
            }
        }
        return records;
    }

    /**
     * Item → VectorIndexRecord 转换
     * 注意：需要 Item 附带 repr 属性
     */
    private itemToRecord(
        item: Item,
        colName: string,
        repr: Float32Array | number[],
        new_id: string
    ): VectorIndexRecord | null {
        return {
            vector_id: new_id,
            item_id: item.item_id,
            item_type: colName,
            repr: repr
        };
    }

    /**
     * 搜索匹配条件的 Item
     */
    async search(conditions: FilterCondition[], options?: IndexerSearchOptions): Promise<IndexerSearchResult> {
        if (conditions.length === 0) {
            return { items: [], totalCount: 0 };
        }

        // 只处理第一个向量条件（向量搜索通常只有一个条件）
        const condition = conditions[0];
        this.validateField(condition.field);
        this.validateOperator(condition.operator);

        // 提取查询向量
        const queryVector = this.extractQueryVector(condition.value);
        const vectorQuery = condition.vectorQuery || { threshold: 0.5 };
        const operator = condition.operator as VectorOperator;

        // 从 existingResults 获取 filterItemIds（用于 join）
        const filterItemIds = options?.existingResults?.map((r) => r.item_id);

        // 构建搜索选项
        const searchOptions: VectorSearchOptions = {
            columnName: condition.field,
            metric: vectorQuery.metric || 'cosine'
        };

        // 根据操作符设置搜索参数
        switch (operator) {
            case 'vector_similarity':
                // 相似度 >= 阈值
                searchOptions.threshold = vectorQuery.threshold;
                searchOptions.topK = vectorQuery.topK || 1000;
                break;

            case 'vector_near':
                // Top-K 最近邻
                searchOptions.topK = vectorQuery.topK || 10;
                break;

            case 'vector_not_similar':
                // 相似度 < 阈值（先获取所有，再过滤）
                searchOptions.topK = vectorQuery.topK || 1000;
                break;

            case 'vector_range':
                // 范围查询（需要 min/max threshold）
                searchOptions.topK = vectorQuery.topK || 1000;
                break;
        }

        // 执行向量搜索
        const results = await this.ensureDB().search(queryVector, searchOptions, filterItemIds);

        // 根据操作符过滤结果
        let filteredResults = results;
        switch (operator) {
            case 'vector_similarity':
                filteredResults = results.filter((r) => r.similarity >= vectorQuery.threshold);
                break;

            case 'vector_not_similar':
                filteredResults = results.filter((r) => r.similarity < vectorQuery.threshold);
                break;

            case 'vector_range':
                // 假设 threshold 是最小值，可以扩展支持 min/max
                const minThreshold = vectorQuery.threshold;
                const maxThreshold = (vectorQuery as any).maxThreshold ?? 1.0;
                filteredResults = results.filter((r) => r.similarity >= minThreshold && r.similarity <= maxThreshold);
                break;
        }

        // 构建 scores Map（用于排序）
        const scores = new Map<string, number>();
        filteredResults.forEach((r) => scores.set(r.item_id, r.similarity));

        // 如果有 existingResults，从中获取完整的 Item 元数据
        const existingMap = new Map(options?.existingResults?.map((i) => [i.item_id, i]));

        // 转换为 Item
        const items = filteredResults.map((r) => this.resultToItem(r, existingMap.get(r.item_id)));

        // 应用 limit 和 offset
        let finalItems = items;
        if (options?.offset !== undefined) {
            finalItems = finalItems.slice(options.offset);
        }
        if (options?.limit !== undefined) {
            finalItems = finalItems.slice(0, options.limit);
        }

        return {
            items: finalItems,
            totalCount: filteredResults.length,
            scores
        };
    }

    /**
     * 向索引中插入 Item
     */
    async insert(items: Item[]): Promise<void> {
        const records = this.buildRecords(items);
        if (records.length > 0) {
            await this.ensureDB().insertMany(records);
        }
    }

    /**
     * 从索引中删除 Item
     */
    async delete(itemIds: string[]): Promise<void> {
        await this.ensureDB().deleteMany(itemIds);
    }

    /**
     * 更新索引中的 Item
     */
    async update(items: Item[]): Promise<void> {
        const records = this.buildRecords(items);
        if (records.length > 0) await this.ensureDB().updateMany(records);
    }

    async upsert(items: Item[]): Promise<void> {
        const records = this.buildRecords(items);
        if (records.length > 0) await this.ensureDB().upsertMany(records);
    }

    /**
     * 关闭索引器
     */
    close(): void {
        this.db?.close();
        this.db = null;
    }

    async dropStorage(): Promise<void> {
        if (this.isDropped) return;
        const db = this.db;
        try {
            if (db) {
                await db.dropStorage();
            } else {
                await dropVectorIndexStore(this._dbPath);
            }
        } finally {
            try {
                db?.close();
            } catch {}
            this.db = null;
            this.isDropped = true;
        }
    }

    /**
     * 获取向量维度
     */
    getDimension(): number {
        return this.dimension;
    }

    async clear(): Promise<void> {
        await this.ensureDB().clear();
    }

    async searchMeta(conditions?: VectorMetaCondition[]): Promise<Array<{ item_id: string; item_type: string }>> {
        return this.ensureDB().searchMeta(conditions);
    }

    async getInfo(): Promise<Record<string, any>> {
        const size = await this.ensureDB().count();
        return { size, dim: this.dimension, semantic_write_state: await this.getWriteState() };
    }

    async getWriteState(): Promise<SemanticWriteAvailability> {
        return (await this.ensureDB().getWriteState?.()) ?? ACCEPTING_SEMANTIC_WRITES;
    }
}

/**
 * 创建 VectorIndexer 实例的工厂函数
 */
export function createVectorIndexer(
    schema: ColumnSchema,
    dbPath: string,
    options?: Record<string, any>
): VectorIndexer {
    return new VectorIndexer(schema, dbPath, options);
}

export default VectorIndexer;
