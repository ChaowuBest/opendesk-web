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
 * Object Storage with Multi-Indexer Search Support
 *
 * 本模块提供统一的存储接口，支持多种索引策略（BM25、向量、分块、文件标签等）。
 *
 * 架构说明：
 * - BaseStorage 管理多个 Indexer 实例
 * - 每个 Indexer 处理特定类型的搜索（文本、向量、标签等）
 * - search() 方法使用 AND 逻辑协调跨索引器的查询
 *
 * HOW TO ADD A NEW INDEXER:
 *
 * 1. 创建新类继承 Indexer 抽象类（见 indexer.ts）
 *    - 设置 name: 唯一标识符
 *    - 设置 supportedFields: 支持查询的字段列表
 *    - 设置 supportedOperators: 支持的操作符（从 QueryOperator 中选择）
 *
 * 2. 实现抽象方法
 *    - initialize(): 初始化资源（数据库连接、模型加载等）
 *    - search(): 执行查询，注意处理 existingResults 进行 join
 *    - insert/delete/update(): CRUD 操作
 *    - close(): 释放资源
 *
 * 3. 注册到 BaseStorage
 *    storage.registerIndexer(new YourIndexer(config));
 *
 * 4. 使用统一操作符
 *    - 标量查询使用 ScalarOperator
 *    - 向量查询使用 VectorOperator + vectorQuery 参数
 */

import path from 'path';
import { Indexer } from './indexer.js';
import { BM25Indexer } from './bm25-indexer.js';
import { VectorIndexer } from './vector-indexer.js';
import { TagIndexer } from './tag-indexer.js';
import { BaseIndexer, type BaseIndexStoreProbeResult } from './base-indexer.js';
import { ChunkIndexer } from './chunk-indexer.js';

const DELETE_BATCH_SIZE = 500;

export type ItemType = 'file' | 'mail' | 'memory';

export interface Item {
    item_id: string;
    item_type: ItemType;
    [key: string]: any; // 支持动态字段，用于传递列名
    // key代表indexer，array的string代表列名，
    indexer_columns?: {
        [indexer: string]: Array<{ column: string; content: string | number[]; id?: string; text?: string }>;
    };
}

export interface SearchItem {
    item: Item;
    tags?: string;
    VecScore?: number;
    BM25Score?: number;
    ChunkScore?: number;
    chunk_id?: string; // 新增：匹配的 chunk 标识符
    chunk_text?: string; // 新增：匹配的 chunk 原文
}

export interface SemanticWriteAvailability {
    acceptingWrites: boolean;
    reason?: 'capacity_limit';
    size?: number;
    cap?: number;
}

export interface SemanticWriteState {
    vector: SemanticWriteAvailability;
    chunk: SemanticWriteAvailability;
}

export const ACCEPTING_SEMANTIC_WRITES: SemanticWriteAvailability = Object.freeze({
    acceptingWrites: true
});

/**
 * SQLite 支持的列类型
 */
export type SQLiteColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';

/**
 * 列约束选项
 */
export interface ColumnConstraint {
    type: SQLiteColumnType;
    nullable?: boolean;
    defaultValue?: string | number | null;
}

/**
 * 必需的列（每个 schema 都必须包含）
 */
export const REQUIRED_COLUMNS = ['item_id', 'item_type'];

export interface IndexerBinding {
    indexer: string; // 'BaseIndexer' | 'BM25Indexer' | 'VectorIndexer' | 'TagIndexer'
    options?: Record<string, any>;
}

/**
 * ColumnSchema 接口
 */
export interface ColumnSchema {
    // 代表该Item的所有列名字，key是列名，value是约束/类型描述
    columns: {
        [column: string]: ColumnConstraint;
    };
    // column 代表列名，value代表索引
    needIndexers: {
        [column: string]: IndexerBinding[];
    };
}

/**
 * Schema 验证错误
 */
export class SchemaValidationError extends Error {
    constructor(
        message: string,
        public invalidColumns?: string[]
    ) {
        super(message);
        this.name = 'SchemaValidationError';
    }
}

export class DimMismatchError extends Error {
    constructor(
        public readonly storedDim: number,
        public readonly configuredDim: number
    ) {
        super(`Vector dimension mismatch: stored=${storedDim}, configured=${configuredDim}`);
        this.name = 'DimMismatchError';
    }
}

/**
 * 验证用户传入的 ColumnSchema
 */
export function validateColumnSchema(schema: ColumnSchema): void {
    const errors: string[] = [];
    const invalidColumns: string[] = [];

    // 1. 检查必需列
    for (const required of REQUIRED_COLUMNS) {
        if (!(required in schema.columns)) {
            errors.push(`Missing required column: ${required}`);
        }
    }

    // 3. 检查 needIndexers 中的列是否都在 columns 中定义
    for (const columnName of Object.keys(schema.needIndexers)) {
        if (!(columnName in schema.columns)) {
            errors.push(`needIndexers references undefined column: ${columnName}`);
        }
    }

    // 4. 检查 indexer 名称是否有效
    const validIndexers = ['BaseIndexer', 'BM25Indexer', 'VectorIndexer', 'TagIndexer', 'ChunkIndexer'];
    for (const [column, bindings] of Object.entries(schema.needIndexers)) {
        for (const binding of bindings) {
            if (!validIndexers.includes(binding.indexer)) {
                errors.push(`Invalid indexer "${binding.indexer}" for column "${column}"`);
            }
        }
    }

    // 5. 检查所有 VectorIndexer 绑定的 dim 是否全局一致（隐式 dim 视为默认值 1024）
    const allVecBindings = Object.values(schema.needIndexers)
        .flat()
        .filter((b) => b.indexer === 'VectorIndexer');
    if (allVecBindings.length > 1) {
        const dims = allVecBindings.map((b) => (typeof b.options?.dim === 'number' ? b.options.dim : 1024));
        if (!dims.every((d) => d === dims[0])) {
            errors.push(
                `VectorIndexer dim must be consistent across all columns, got: [${[...new Set(dims)].join(', ')}]`
            );
        }
    }

    // 6. 检查所有 ChunkIndexer 绑定的 dim 是否全局一致（隐式 dim 视为默认值 1024）
    const allChunkBindings = Object.values(schema.needIndexers)
        .flat()
        .filter((b) => b.indexer === 'ChunkIndexer');
    if (allChunkBindings.length > 1) {
        const dims = allChunkBindings.map((b) => (typeof b.options?.dim === 'number' ? b.options.dim : 1024));
        if (!dims.every((d) => d === dims[0])) {
            errors.push(
                `ChunkIndexer dim must be consistent across all columns, got: [${[...new Set(dims)].join(', ')}]`
            );
        }
    }

    if (errors.length > 0) {
        throw new SchemaValidationError(`Schema validation failed:\n${errors.join('\n')}`, invalidColumns);
    }
}

// ============================================================================
// 查询相关类型
// ============================================================================

export interface IndexerSearchOptions {
    /** 已有结果集，用于 join 过滤 */
    existingResults?: SearchItem[];
    /** 返回结果数量限制 */
    limit?: number;
    /** 跳过的结果数量 */
    offset?: number;
    /** 排序选项 */
    orderBy?: {
        field: string;
        direction: 'ASC' | 'DESC';
    };
}

/**
 * 相似度计算方法
 */
export type SimilarityMetric = 'cosine' | 'euclidean' | 'dot_product' | 'manhattan';

export interface VectorQuery {
    /** 相似度阈值（0-1之间，值越大要求越相似） */
    threshold: number;
    /** 相似度计算方法，默认为 cosine */
    metric?: SimilarityMetric;
    topK?: number;
}

// 标量操作符
export type ScalarOperator =
    | '='
    | '!='
    | '>'
    | '<'
    | '>='
    | '<='
    | 'like'
    | 'notlike'
    | 'in'
    | 'notin'
    | 'between'
    | 'notbetween';

// 向量操作符
export type VectorOperator = 'vector_similarity' | 'vector_near' | 'vector_not_similar' | 'vector_range';

// BM25 操作符
export type BM25Operator = 'bm25_match';

// BM25 查询参数
export interface BM25Query {
    query: string;
    topK?: number;
}

// 所有操作符
export type QueryOperator = ScalarOperator | VectorOperator | BM25Operator;

export interface FilterCondition {
    indexer: string;
    field: string;
    operator: QueryOperator;
    value: any;
    vectorQuery?: VectorQuery;
}

export interface UpsertOptions {
    indexers?: string[];
}

export type DropIndexName = 'BaseIndexer' | 'BM25Indexer' | 'TagIndexer' | 'VectorIndexer' | 'ChunkIndexer';

// ============================================================================
// BaseStorage - 多索引器协调存储
// ============================================================================

/**
 * BaseStorage - 协调多个 Indexer 的统一存储接口
 */
export class BaseStorage {
    private bm25Indexer: Indexer | null = null;
    private vectorIndexer: Indexer | null = null;
    private tagIndexer: Indexer | null = null;
    private chunkIndexer: ChunkIndexer | null = null;
    private baseIndexer: BaseIndexer;
    private name: string;
    private schema: ColumnSchema;
    private dbBasePath: string;
    private droppedInPartialFailure = false;

    constructor(name: string, schema: ColumnSchema, dbBasePath?: string) {
        // 验证 schema
        validateColumnSchema(schema);

        this.name = name;
        this.schema = schema;
        this.dbBasePath = dbBasePath || path.join(process.cwd(), 'data', name);

        // 初始化 BaseIndexer（使用动态 schema）
        this.baseIndexer = new BaseIndexer(schema, path.join(this.dbBasePath, 'base-index.db'));

        // 按需初始化其他 indexer
        const allBindings = Object.values(schema.needIndexers).flat();

        if (allBindings.some((b) => b.indexer === 'BM25Indexer')) {
            this.bm25Indexer = new BM25Indexer(schema, path.join(this.dbBasePath, 'bm25-index.db'));
        }
        if (allBindings.some((b) => b.indexer === 'VectorIndexer')) {
            const vecBinding = allBindings.find((b) => b.indexer === 'VectorIndexer');
            this.vectorIndexer = new VectorIndexer(
                schema,
                path.join(this.dbBasePath, 'vector-index.db'),
                vecBinding?.options
            );
        }
        if (allBindings.some((b) => b.indexer === 'TagIndexer')) {
            this.tagIndexer = new TagIndexer(schema, path.join(this.dbBasePath, 'tag-index.db'));
        }
        if (allBindings.some((b) => b.indexer === 'ChunkIndexer')) {
            const chunkBinding = allBindings.find((b) => b.indexer === 'ChunkIndexer');
            this.chunkIndexer = new ChunkIndexer(
                schema,
                path.join(this.dbBasePath, 'chunk-index.db'),
                chunkBinding?.options
            );
        }
    }

    /**
     * 初始化所有 indexer
     */
    async initialize(): Promise<void> {
        this.ensureUsable();
        // VectorIndexer first (may throw DimMismatchError — caller decides whether to wipe and reinit)
        if (this.vectorIndexer) await this.vectorIndexer.initialize();
        await this.baseIndexer.initialize();
        if (this.bm25Indexer) await this.bm25Indexer.initialize();
        if (this.tagIndexer) await this.tagIndexer.initialize();
        if (this.chunkIndexer) await this.chunkIndexer.initialize();
    }

    async probeBaseIndexStore(): Promise<BaseIndexStoreProbeResult> {
        this.ensureUsable();
        return this.baseIndexer.probeStore();
    }

    async probeIndexers(
        indexers: Array<'VectorIndexer' | 'ChunkIndexer'>
    ): Promise<Partial<Record<'VectorIndexer' | 'ChunkIndexer', BaseIndexStoreProbeResult>>> {
        this.ensureUsable();
        const result: Partial<Record<'VectorIndexer' | 'ChunkIndexer', BaseIndexStoreProbeResult>> = {};
        for (const indexer of indexers) {
            if (indexer === 'VectorIndexer') {
                result.VectorIndexer = this.vectorIndexer ? await this.vectorIndexer.probeStore() : 'missing';
            }
            if (indexer === 'ChunkIndexer') {
                result.ChunkIndexer = this.chunkIndexer ? await this.chunkIndexer.probeStore() : 'missing';
            }
        }
        return result;
    }

    private async getExistingItemIds(itemIds: string[]): Promise<Set<string>> {
        this.ensureUsable();
        if (itemIds.length === 0) return new Set();
        const result = await this.baseIndexer.search([
            {
                indexer: 'BaseIndexer',
                field: 'item_id',
                operator: 'in',
                value: itemIds
            }
        ]);
        return new Set(result.items.map((item) => item.item_id));
    }

    /**
     * Fan-out write helper used by insert/delete/update/upsert/clear.
     *
     * Semantic switch vs Promise.all: Promise.all rejects at the moment the first
     * sibling rejects, but leaves the other siblings running. Callers typically
     * react to that rejection by close()ing all indexers, which then collides with
     * still-in-flight sibling transactions.
     *
     * This still starts all ops concurrently, but waits for every sibling to
     * settle before propagating an error. The thrown error is the first rejection
     * in array order, not the first in time.
     */
    private async runIndexerFanout(operations: Array<() => Promise<void>>): Promise<void> {
        this.ensureUsable();
        const results = await Promise.allSettled(operations.map((op) => Promise.resolve().then(op)));
        const firstRejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (firstRejected) throw firstRejected.reason;
    }

    /**
     * 搜索方法 - 返回 { items, totalCount }
     */
    async search(
        filterConditions: FilterCondition[],
        options: Omit<IndexerSearchOptions, 'existingResults'> = {}
    ): Promise<{ items: SearchItem[]; totalCount: number }> {
        this.ensureUsable();
        // 检测是否包含 ChunkIndexer 条件，走专用路径
        const hasChunkCondition = filterConditions.some((c) => c.indexer === 'ChunkIndexer');
        if (hasChunkCondition) {
            return this.searchWithChunkIndexer(filterConditions);
        }

        let results: SearchItem[] = [];
        let hasInitialData = false;

        // 按 indexer 分组条件
        const conditionsByIndexer: Record<string, FilterCondition[]> = {};
        for (const cond of filterConditions) {
            if (!conditionsByIndexer[cond.indexer]) {
                conditionsByIndexer[cond.indexer] = [];
            }
            conditionsByIndexer[cond.indexer].push(cond);
        }

        // 处理顺序：TagIndexer -> BM25Indexer -> VectorIndexer -> BaseIndexer
        const indexerOrder = ['TagIndexer', 'BM25Indexer', 'VectorIndexer', 'BaseIndexer'];

        for (const indexerName of indexerOrder) {
            let conditions = conditionsByIndexer[indexerName];
            if ((!conditions || conditions.length === 0) && indexerName != 'BaseIndexer') continue;
            if (typeof conditions === 'undefined') {
                conditions = [];
            }

            const indexer = this.getIndexerByName(indexerName);

            if (!hasInitialData) {
                // 第一个有条件的 indexer，获取初始数据
                const searchResult = await indexer.search(conditions, options);
                results = this.itemsToSearchItems(searchResult.items, searchResult.scores, indexerName);
                hasInitialData = true;
            } else {
                // 后续 indexer，基于已有结果进行 join
                const existingItems = results.map((r) => r.item);
                const searchResult = await indexer.search(conditions, {
                    existingResults: existingItems
                });
                results = this.mergeSearchResults(results, searchResult.items, searchResult.scores, indexerName);
            }

            // 提前退出：如果结果为空
            if (results.length === 0) {
                return { items: [], totalCount: 0 };
            }
        }

        return {
            items: results,
            totalCount: results.length
        };
    }

    async searchVectorMeta(
        conditions?: import('./vector-indexer.js').VectorMetaCondition[]
    ): Promise<Array<{ item_id: string; item_type: string }>> {
        this.ensureUsable();
        if (!this.vectorIndexer) return [];
        return (this.vectorIndexer as VectorIndexer).searchMeta(conditions);
    }

    /**
     * 插入数据
     */
    async insert(items: Item[]): Promise<void> {
        this.ensureUsable();
        if (items.length === 0) return;
        const existingIds = await this.getExistingItemIds(items.map((item) => item.item_id));
        const newItems = items.filter((item) => !existingIds.has(item.item_id));
        if (newItems.length === 0) return;

        await this.runIndexerFanout([
            () => this.baseIndexer.insert(newItems),
            () => (this.bm25Indexer ? this.bm25Indexer.insert(newItems) : Promise.resolve()),
            () => (this.vectorIndexer ? this.vectorIndexer.insert(newItems) : Promise.resolve()),
            () => (this.tagIndexer ? this.tagIndexer.insert(newItems) : Promise.resolve()),
            () => (this.chunkIndexer ? this.chunkIndexer.insert(newItems) : Promise.resolve())
        ]);
    }

    /**
     * 删除数据
     */
    async delete(itemsOrIds: Item[] | string[]): Promise<void> {
        this.ensureUsable();
        if (itemsOrIds.length === 0) return;
        const itemIds =
            typeof itemsOrIds[0] === 'string' ? (itemsOrIds as string[]) : (itemsOrIds as Item[]).map((i) => i.item_id);

        for (let i = 0; i < itemIds.length; i += DELETE_BATCH_SIZE) {
            const batch = itemIds.slice(i, i + DELETE_BATCH_SIZE);
            await this.runIndexerFanout([
                () => this.baseIndexer.delete(batch),
                () => (this.bm25Indexer ? this.bm25Indexer.delete(batch) : Promise.resolve()),
                () => (this.vectorIndexer ? this.vectorIndexer.delete(batch) : Promise.resolve()),
                () => (this.tagIndexer ? this.tagIndexer.delete(batch) : Promise.resolve()),
                () => (this.chunkIndexer ? this.chunkIndexer.delete(batch) : Promise.resolve())
            ]);
        }
    }

    /**
     * 更新数据
     */
    async update(items: Item[], options?: UpsertOptions): Promise<void> {
        this.ensureUsable();
        if (items.length === 0) return;
        const should = (name: string) => !options?.indexers || options.indexers.includes(name);

        await this.runIndexerFanout([
            () => (should('BaseIndexer') ? this.baseIndexer.update(items) : Promise.resolve()),
            () => (should('BM25Indexer') && this.bm25Indexer ? this.bm25Indexer.update(items) : Promise.resolve()),
            () =>
                should('VectorIndexer') && this.vectorIndexer ? this.vectorIndexer.update(items) : Promise.resolve(),
            () => (should('TagIndexer') && this.tagIndexer ? this.tagIndexer.update(items) : Promise.resolve()),
            () => (should('ChunkIndexer') && this.chunkIndexer ? this.chunkIndexer.update(items) : Promise.resolve())
        ]);
    }

    /**
     * Insert or update items. `options.indexers` restricts the write to listed
     * indexers (e.g. ['BaseIndexer']). Promise.all is NOT cross-indexer atomic;
     * callers relying on partial-write semantics MUST use a separate marker column
     * for eventual consistency (filemgr uses `embedded`).
     *
     * See spec §"部分写入失败的语义与不变式".
     */
    async upsert(items: Item[], options?: UpsertOptions): Promise<void> {
        this.ensureUsable();
        if (items.length === 0) return;
        const should = (name: string) => !options?.indexers || options.indexers.includes(name);

        await this.runIndexerFanout([
            () => (should('BaseIndexer') ? this.baseIndexer.upsert(items) : Promise.resolve()),
            () => (should('BM25Indexer') && this.bm25Indexer ? this.bm25Indexer.upsert(items) : Promise.resolve()),
            () =>
                should('VectorIndexer') && this.vectorIndexer ? this.vectorIndexer.upsert(items) : Promise.resolve(),
            () => (should('TagIndexer') && this.tagIndexer ? this.tagIndexer.upsert(items) : Promise.resolve()),
            () => (should('ChunkIndexer') && this.chunkIndexer ? this.chunkIndexer.upsert(items) : Promise.resolve())
        ]);
    }

    /**
     * 清空所有 indexer 数据
     */
    async clear(): Promise<void> {
        this.ensureUsable();
        await this.runIndexerFanout([
            () => this.baseIndexer.clear(),
            () => (this.bm25Indexer ? this.bm25Indexer.clear() : Promise.resolve()),
            () => (this.vectorIndexer ? this.vectorIndexer.clear() : Promise.resolve()),
            () => (this.tagIndexer ? this.tagIndexer.clear() : Promise.resolve()),
            () => (this.chunkIndexer ? this.chunkIndexer.clear() : Promise.resolve())
        ]);
    }

    /**
     * Clear data for a specific item in a specific indexer, leaving all other indexers untouched.
     *
     * @param itemId - The item_id to clear
     * @param indexerName - Which indexer to clear ('ChunkIndexer' | 'VectorIndexer' | 'BM25Indexer' | 'TagIndexer')
     * @throws Error if indexerName is 'BaseIndexer' or if the indexer is not initialized
     */
    async clearIndexerForItem(itemId: string, indexerName: string): Promise<void> {
        this.ensureUsable();
        if (indexerName === 'BaseIndexer') {
            throw new Error('Cannot clear BaseIndexer for a single item — use delete() to remove the entire item');
        }

        const indexer = this.getIndexerByName(indexerName);
        await indexer.delete([itemId]);
    }

    /**
     * 获取所有 indexer 状态信息
     */
    async getStatus(): Promise<Record<string, Record<string, any>>> {
        this.ensureUsable();
        const [baseInfo, bm25Info, vectorInfo, tagInfo, chunkInfo] = await Promise.all([
            this.baseIndexer.getInfo(),
            this.bm25Indexer ? this.bm25Indexer.getInfo() : Promise.resolve({}),
            this.vectorIndexer ? this.vectorIndexer.getInfo() : Promise.resolve({}),
            this.tagIndexer ? this.tagIndexer.getInfo() : Promise.resolve({}),
            this.chunkIndexer ? this.chunkIndexer.getInfo() : Promise.resolve({})
        ]);
        return {
            BaseIndexer: baseInfo,
            ...(this.bm25Indexer && { BM25Indexer: bm25Info }),
            ...(this.vectorIndexer && { VectorIndexer: vectorInfo }),
            ...(this.tagIndexer && { TagIndexer: tagInfo }),
            ...(this.chunkIndexer && { ChunkIndexer: chunkInfo })
        };
    }

    async getSemanticWriteState(): Promise<SemanticWriteState> {
        this.ensureUsable();
        const [vector, chunk] = await Promise.all([
            this.vectorIndexer ? this.vectorIndexer.getWriteState() : Promise.resolve(ACCEPTING_SEMANTIC_WRITES),
            this.chunkIndexer ? this.chunkIndexer.getWriteState() : Promise.resolve(ACCEPTING_SEMANTIC_WRITES)
        ]);
        return { vector, chunk };
    }

    /**
     * 关闭所有 indexer
     */
    close(): void {
        this.baseIndexer.close();
        this.bm25Indexer?.close();
        this.vectorIndexer?.close();
        this.tagIndexer?.close();
        this.chunkIndexer?.close();
    }

    /**
     * 获取 Schema
     */
    getSchema(): ColumnSchema {
        this.ensureUsable();
        return this.schema;
    }

    /**
     * Drops the named indexers' persistent storage sequentially.
     *
     * Failure semantics: sequential, fail-fast, no rollback. If a drop in the
     * middle throws, earlier indexers may already be deleted; the storage
     * instance is poisoned and must be discarded.
     */
    async dropIndexers(indexerNames: DropIndexName[]): Promise<void> {
        this.ensureUsable();
        let droppedAny = false;
        try {
            for (const indexerName of indexerNames) {
                switch (indexerName) {
                    case 'BaseIndexer':
                        await this.baseIndexer.dropStorage();
                        break;
                    case 'BM25Indexer':
                        if (!this.bm25Indexer) throw new Error('BM25Indexer not initialized for this schema');
                        await (this.bm25Indexer as BM25Indexer).dropStorage();
                        break;
                    case 'TagIndexer':
                        if (!this.tagIndexer) throw new Error('TagIndexer not initialized for this schema');
                        await (this.tagIndexer as TagIndexer).dropStorage();
                        break;
                    case 'VectorIndexer':
                        if (!this.vectorIndexer) throw new Error('VectorIndexer not initialized for this schema');
                        await (this.vectorIndexer as VectorIndexer).dropStorage();
                        break;
                    case 'ChunkIndexer':
                        if (!this.chunkIndexer) throw new Error('ChunkIndexer not initialized for this schema');
                        await this.chunkIndexer.dropStorage();
                        break;
                }
                droppedAny = true;
            }
        } catch (error) {
            if (droppedAny) this.droppedInPartialFailure = true;
            throw error;
        }
    }

    private ensureUsable(): void {
        if (this.droppedInPartialFailure) {
            throw new Error('BaseStorage is in a partially-dropped state. Construct a new BaseStorage.');
        }
    }

    private getIndexerByName(name: string): Indexer {
        this.ensureUsable();
        switch (name) {
            case 'BM25Indexer':
                if (!this.bm25Indexer) throw new Error('BM25Indexer not initialized for this schema');
                return this.bm25Indexer;
            case 'VectorIndexer':
                if (!this.vectorIndexer) throw new Error('VectorIndexer not initialized for this schema');
                return this.vectorIndexer;
            case 'TagIndexer':
                if (!this.tagIndexer) throw new Error('TagIndexer not initialized for this schema');
                return this.tagIndexer;
            case 'BaseIndexer':
                return this.baseIndexer;
            case 'ChunkIndexer':
                if (!this.chunkIndexer) throw new Error('ChunkIndexer not initialized for this schema');
                return this.chunkIndexer;
            default:
                throw new Error(`Indexer ${name} not found`);
        }
    }

    /**
     * ChunkIndexer 专用搜索路径：
     * 1. 仅允许 ChunkIndexer + BaseIndexer 条件组合
     * 2. 先做 chunk 向量召回
     * 3. 再用 BaseIndexer 在命中的 item_id 子集上做元数据过滤
     * 4. 按 chunk 命中展开结果，不去重 item_id
     */
    private async searchWithChunkIndexer(
        filterConditions: FilterCondition[]
    ): Promise<{ items: SearchItem[]; totalCount: number }> {
        if (!this.chunkIndexer) {
            throw new Error('ChunkIndexer not initialized for this schema');
        }

        const chunkConditions = filterConditions.filter((c) => c.indexer === 'ChunkIndexer');
        const baseConditions = filterConditions.filter((c) => c.indexer === 'BaseIndexer');
        const invalidConditions = filterConditions.filter(
            (c) => c.indexer !== 'ChunkIndexer' && c.indexer !== 'BaseIndexer'
        );

        if (invalidConditions.length > 0) {
            const invalidIndexers = [...new Set(invalidConditions.map((c) => c.indexer))];
            throw new Error(
                `ChunkIndexer search only supports BaseIndexer filters; got incompatible indexers: ${invalidIndexers.join(', ')}`
            );
        }

        if (chunkConditions.length !== 1) {
            throw new Error(
                `ChunkIndexer search requires exactly one ChunkIndexer condition, got ${chunkConditions.length}`
            );
        }

        const chunkCondition = chunkConditions[0];
        const chunkResults = await this.chunkIndexer.searchChunks(
            chunkCondition.value,
            chunkCondition.vectorQuery || { threshold: 0.5 }
        );

        if (chunkResults.length === 0) {
            return { items: [], totalCount: 0 };
        }

        const existingItems: Item[] = chunkResults.map((result) => ({
            item_id: result.item_id,
            item_type: 'file'
        }));

        const baseResult = await this.baseIndexer.search(baseConditions, {
            existingResults: existingItems
        });
        const baseItemsById = new Map(baseResult.items.map((item) => [item.item_id, item]));

        const expandedResults: SearchItem[] = [];
        for (const chunkResult of chunkResults) {
            const baseItem = baseItemsById.get(chunkResult.item_id);
            if (!baseItem) continue;
            expandedResults.push({
                item: baseItem,
                tags: baseItem.tag,
                ChunkScore: chunkResult.similarity,
                chunk_id: chunkResult.chunk_id,
                chunk_text: chunkResult.chunk_text
            });
        }

        return {
            items: expandedResults,
            totalCount: expandedResults.length
        };
    }

    /**
     * 将 Item[] 转换为 SearchItem[]
     */
    private itemsToSearchItems(items: Item[], scores?: Map<string, number>, indexerName?: string): SearchItem[] {
        return items.map((item) => {
            const score = scores?.get(item.item_id);
            return {
                item,
                tags: item.tag,
                BM25Score: indexerName === 'BM25Indexer' ? score : undefined,
                VecScore: indexerName === 'VectorIndexer' ? score : undefined
            };
        });
    }

    /**
     * 合并搜索结果
     */
    private mergeSearchResults(
        existing: SearchItem[],
        newItems: Item[],
        scores?: Map<string, number>,
        indexerName?: string
    ): SearchItem[] {
        const existingMap = new Map(existing.map((r) => [r.item.item_id, r]));

        return newItems.map((item) => {
            const existingResult = existingMap.get(item.item_id);
            const score = scores?.get(item.item_id);
            return {
                item,
                tags: existingResult?.tags ?? item.tag,
                BM25Score: indexerName === 'BM25Indexer' ? score : existingResult?.BM25Score,
                ChunkScore: existingResult?.ChunkScore,
                VecScore: indexerName === 'VectorIndexer' ? score : existingResult?.VecScore
            };
        });
    }
}
