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

import { retryArkdataStoreReleases } from './arkdata-bridge.js';
import type { BaseCountGroup } from './grouped-count.js';
import path from 'path';
import { Indexer } from './indexer.js';
import { BM25Indexer } from './bm25-indexer.js';
import type { IVectorIndexDB } from './vector-indexer.js';
import { VectorIndexer } from './vector-indexer.js';
import { TagIndexer } from './tag-indexer.js';
import { BaseIndexer, type BaseIndexStoreProbeResult } from './base-indexer.js';
import { ChunkIndexer, type ChunkSearchResult, type IChunkIndexDB } from './chunk-indexer.js';

const DELETE_BATCH_SIZE = 500;
export const ARKDATA_SCOPED_SEARCH_BATCH_SIZE = 5000;

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
    | 'notbetween'
    | 'path_descendant_or_self';

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

export interface ScopedSearchRequest {
    preconditions: FilterCondition[];
    targetCondition: FilterCondition;
}

export interface ScopedSearchOptions {
    collectDiagnostics?: boolean;
}

export interface ScopedSearchDiagnostics {
    backend: 'native' | 'arkdata' | 'wasm';
    target: 'vector' | 'chunk';
    strategy: 'exact_temp' | 'exact_in' | 'ann_overfetch_filter';
    requestedK: number;
    topK: number;
    totalTargetRows: number;
    exactCandidateCount: number;
    exactBatchSize: number;
    exactBatchCount: number;
    basePrefilterLatencyMs: number;
    targetSearchLatencyMs: number;
    mergeLatencyMs: number;
    latencyMs: number;
    memoryBeforeRssBytes: number;
    memoryAfterRssBytes: number;
    memoryDeltaRssBytes: number;
}

export type SemanticIndexBackend = ScopedSearchDiagnostics['backend'];

export function validateSemanticIndexBackend(value: unknown, owner: string): SemanticIndexBackend {
    if (value === undefined || value === null || value === '') {
        throw new Error(`${owner} backend capability is missing`);
    }
    if (value !== 'native' && value !== 'arkdata' && value !== 'wasm') {
        throw new Error(`${owner} backend capability is invalid: ${String(value)}`);
    }
    return value;
}

export interface ScopedSearchResult {
    items: SearchItem[];
    totalCount: number;
    diagnostics?: ScopedSearchDiagnostics;
}

export class ScopedSearchValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ScopedSearchValidationError';
    }
}

export function splitScopedCandidateItems(items: Item[], batchSize: number): Item[][] {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw new RangeError('Scoped search batch size must be a positive integer');
    }
    const batches: Item[][] = [];
    for (let offset = 0; offset < items.length; offset += batchSize) {
        batches.push(items.slice(offset, offset + batchSize));
    }
    return batches;
}

export function mergeScopedVectorHits(
    batches: SearchItem[][],
    candidateMap: Map<string, Item>,
    topK: number
): SearchItem[] {
    const seen = new Set<string>();
    const hits: SearchItem[] = [];
    for (const hit of batches.flat()) {
        const id = hit.item.item_id;
        const candidate = candidateMap.get(id);
        if (!candidate) continue;
        if (!Number.isFinite(hit.VecScore)) {
            throw new Error(`Scoped search invariant violation: vector hit ${id} must have a finite VecScore`);
        }
        if (seen.has(id)) throw new Error(`Scoped search invariant violation: duplicate vector hit ${id}`);
        seen.add(id);
        hits.push({ ...hit, item: candidate, tags: candidate.tag });
    }
    return hits
        .sort(
            (left, right) =>
                (right.VecScore ?? -Infinity) - (left.VecScore ?? -Infinity) ||
                left.item.item_id.localeCompare(right.item.item_id)
        )
        .slice(0, topK);
}

export function mergeScopedChunkHits(
    batches: ChunkSearchResult[][],
    candidateMap: Map<string, Item>,
    topK: number
): SearchItem[] {
    const seen = new Set<string>();
    const hits: SearchItem[] = [];
    for (const hit of batches.flat()) {
        const candidate = candidateMap.get(hit.item_id);
        if (!candidate) continue;
        if (!Number.isFinite(hit.similarity)) {
            throw new Error(
                `Scoped search invariant violation: chunk hit ${hit.item_id}/${hit.chunk_id} must have a finite similarity`
            );
        }
        const key = `${hit.item_id}\u0000${hit.chunk_id}`;
        if (seen.has(key)) throw new Error(`Scoped search invariant violation: duplicate chunk hit ${key}`);
        seen.add(key);
        hits.push({
            item: candidate,
            tags: candidate.tag,
            ChunkScore: hit.similarity,
            chunk_id: hit.chunk_id,
            chunk_text: hit.chunk_text
        });
    }
    return hits
        .sort(
            (left, right) =>
                (right.ChunkScore ?? -Infinity) - (left.ChunkScore ?? -Infinity) ||
                left.item.item_id.localeCompare(right.item.item_id) ||
                String(left.chunk_id).localeCompare(String(right.chunk_id))
        )
        .slice(0, topK);
}

function validateScopedSearchRequest(request: ScopedSearchRequest): void {
    if (!request || !Array.isArray(request.preconditions) || request.preconditions.length === 0) {
        throw new ScopedSearchValidationError('Scoped search requires non-empty preconditions');
    }
    if (
        request.preconditions.some(
            (condition) =>
                condition === null ||
                typeof condition !== 'object' ||
                Array.isArray(condition) ||
                condition.indexer !== 'BaseIndexer'
        )
    ) {
        throw new ScopedSearchValidationError('Scoped search preconditions must contain BaseIndexer conditions only');
    }
    const target = request.targetCondition;
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
        throw new ScopedSearchValidationError('Scoped search target must be an object');
    }
    if (!['VectorIndexer', 'ChunkIndexer'].includes(target.indexer)) {
        throw new ScopedSearchValidationError('Scoped search target must be VectorIndexer or ChunkIndexer');
    }
    if (typeof target.field !== 'string' || target.field.trim().length === 0) {
        throw new ScopedSearchValidationError('Scoped search target field must be a non-empty string');
    }
    if (target.operator !== 'vector_near') {
        throw new ScopedSearchValidationError('Scoped search target operator must be vector_near');
    }
    const vector = target.value;
    const isNumberArray = Array.isArray(vector) && vector.every((value) => typeof value === 'number');
    const isFloat32Array = vector instanceof Float32Array;
    if ((!isNumberArray && !isFloat32Array) || vector.length === 0 || !Array.from(vector).every(Number.isFinite)) {
        throw new ScopedSearchValidationError('Scoped search target value must be a non-empty finite vector');
    }
    const vectorQuery = target.vectorQuery;
    if (
        vectorQuery !== undefined &&
        (vectorQuery === null || typeof vectorQuery !== 'object' || Array.isArray(vectorQuery))
    ) {
        throw new ScopedSearchValidationError('Scoped search vectorQuery must be an object');
    }
    if (vectorQuery?.topK !== undefined && (!Number.isInteger(vectorQuery.topK) || vectorQuery.topK <= 0)) {
        throw new ScopedSearchValidationError('Scoped search vectorQuery topK must be a positive integer');
    }
    if (
        vectorQuery?.metric !== undefined &&
        !(['cosine', 'euclidean', 'dot_product', 'manhattan'] as unknown[]).includes(vectorQuery.metric)
    ) {
        throw new ScopedSearchValidationError('Scoped search vectorQuery metric is invalid');
    }
    if (
        vectorQuery?.threshold !== undefined &&
        (!Number.isFinite(vectorQuery.threshold) || vectorQuery.threshold < 0 || vectorQuery.threshold > 1)
    ) {
        throw new ScopedSearchValidationError('Scoped search vectorQuery threshold must be finite and between 0 and 1');
    }
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
    private closeRequested = false;
    private initializationPromise: Promise<void> | null = null;
    private closingPromise: Promise<void> | null = null;

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
        if (this.initializationPromise) return this.initializationPromise;
        const initialization = this.initializeIndexers().finally(() => {
            if (this.initializationPromise === initialization) this.initializationPromise = null;
        });
        this.initializationPromise = initialization;
        return initialization;
    }

    private async initializeIndexers(): Promise<void> {
        // VectorIndexer first (may throw DimMismatchError — caller decides whether to wipe and reinit)
        try {
            // close() may complete while one initializer awaits. Never acquire
            // subsequent stores after the owning storage has been closed.
            for (const indexer of [
                this.vectorIndexer,
                this.baseIndexer,
                this.bm25Indexer,
                this.tagIndexer,
                this.chunkIndexer
            ]) {
                this.ensureUsable();
                if (indexer) await indexer.initialize();
            }
            this.ensureUsable();
        } catch (error) {
            // Await every release without masking the initialization error. Failed
            // indexers retain their holders so the caller can retry storage.close().
            await Promise.allSettled(
                [this.chunkIndexer, this.tagIndexer, this.bm25Indexer, this.baseIndexer, this.vectorIndexer].map(
                    async (indexer) => indexer?.close()
                )
            );
            throw error;
        }
    }

    /** Actual opened backends, including independent factory fallbacks.
     * Callers own cache/index compatibility decisions; storage owns selection.
     */
    getSemanticBackends(): { vector: IVectorIndexDB['backend'] | null; chunk: IChunkIndexDB['backend'] | null } {
        this.ensureUsable();
        return {
            vector: this.vectorIndexer?.getBackend() ?? null,
            chunk: this.chunkIndexer?.getBackend() ?? null
        };
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

    async countGrouped(fields: string[], conditions: FilterCondition[]): Promise<BaseCountGroup[]> {
        this.ensureUsable();
        return this.baseIndexer.countGrouped(fields, conditions);
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

    async searchScope(request: ScopedSearchRequest, options: ScopedSearchOptions = {}): Promise<ScopedSearchResult> {
        this.ensureUsable();
        validateScopedSearchRequest(request);

        const startedAt = Date.now();
        const memoryBefore = options.collectDiagnostics ? process.memoryUsage().rss : 0;
        const baseStartedAt = Date.now();
        const baseResult = await this.baseIndexer.search(request.preconditions);
        const basePrefilterLatencyMs = Date.now() - baseStartedAt;
        const candidateMap = new Map(baseResult.items.map((item) => [item.item_id, item]));
        const candidateItems = [...candidateMap.values()];
        const target = request.targetCondition.indexer === 'VectorIndexer' ? 'vector' : 'chunk';
        const targetIndexer = target === 'vector' ? this.vectorIndexer : this.chunkIndexer;
        if (!targetIndexer) throw new Error(`${request.targetCondition.indexer} not initialized for this schema`);
        if (typeof targetIndexer.getBackend !== 'function') {
            throw new Error(`${request.targetCondition.indexer} backend capability is missing`);
        }
        const backend = validateSemanticIndexBackend(targetIndexer.getBackend(), request.targetCondition.indexer);
        const requestedK = request.targetCondition.vectorQuery?.topK ?? 10;
        const batchSize = backend === 'arkdata' ? ARKDATA_SCOPED_SEARCH_BATCH_SIZE : candidateItems.length;
        const batches =
            candidateItems.length === 0
                ? []
                : backend === 'arkdata'
                  ? splitScopedCandidateItems(candidateItems, ARKDATA_SCOPED_SEARCH_BATCH_SIZE)
                  : [candidateItems];
        let totalTargetRows = 0;
        if (options.collectDiagnostics) {
            const info = await targetIndexer.getInfo();
            totalTargetRows = typeof info.size === 'number' ? info.size : 0;
        }

        const targetStartedAt = Date.now();
        const vectorBatches: SearchItem[][] = [];
        const chunkBatches: ChunkSearchResult[][] = [];
        for (const batch of batches) {
            if (target === 'vector') {
                if (!this.vectorIndexer) throw new Error('VectorIndexer not initialized for this schema');
                const result = await this.vectorIndexer.search([request.targetCondition], { existingResults: batch });
                vectorBatches.push(this.itemsToSearchItems(result.items, result.scores, 'VectorIndexer'));
            } else {
                if (!this.chunkIndexer) throw new Error('ChunkIndexer not initialized for this schema');
                chunkBatches.push(
                    await this.chunkIndexer.searchChunks(
                        request.targetCondition.value,
                        request.targetCondition.vectorQuery ?? { threshold: 0.5 },
                        batch.map((item) => item.item_id)
                    )
                );
            }
        }
        const targetSearchLatencyMs = batches.length === 0 ? 0 : Date.now() - targetStartedAt;
        const mergeStartedAt = Date.now();
        const items =
            target === 'vector'
                ? mergeScopedVectorHits(vectorBatches, candidateMap, requestedK)
                : mergeScopedChunkHits(chunkBatches, candidateMap, requestedK);
        const mergeLatencyMs = Date.now() - mergeStartedAt;
        const result: ScopedSearchResult = { items, totalCount: items.length };
        if (options.collectDiagnostics) {
            const memoryAfter = process.memoryUsage().rss;
            result.diagnostics = {
                backend,
                target,
                strategy:
                    backend === 'arkdata' ? 'exact_in' : backend === 'wasm' ? 'ann_overfetch_filter' : 'exact_temp',
                requestedK,
                topK: requestedK,
                totalTargetRows,
                exactCandidateCount: candidateItems.length,
                exactBatchSize: candidateItems.length === 0 ? 0 : batchSize,
                exactBatchCount: batches.length,
                basePrefilterLatencyMs,
                targetSearchLatencyMs,
                mergeLatencyMs,
                latencyMs: Date.now() - startedAt,
                memoryBeforeRssBytes: memoryBefore,
                memoryAfterRssBytes: memoryAfter,
                memoryDeltaRssBytes: memoryAfter - memoryBefore
            };
        }
        return result;
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
     * 关闭所有 indexer。调用方必须等待成功后才能丢弃实例；失败时保留
     * 此实例并重试 close()。开始关闭后不再接受新的数据库操作。
     */
    close(): Promise<void> {
        if (this.closingPromise) return this.closingPromise;
        this.closeRequested = true;
        const initialization = this.initializationPromise;
        const closing = (async () => {
            // A factory may not have assigned its DB yet. The owning storage
            // cannot finish close while that acquisition is still in flight.
            if (initialization) await initialization.catch(() => {});
            const results = await Promise.allSettled(
                [this.baseIndexer, this.bm25Indexer, this.vectorIndexer, this.tagIndexer, this.chunkIndexer].map(
                    async (indexer) => indexer?.close()
                )
            );
            // Probes/raw drops have no indexer holder. Their temporary owners
            // belong to these stores and must participate in the same close contract.
            const temporary = await Promise.allSettled([
                retryArkdataStoreReleases(
                    ['base-index.db', 'vector-index.db', 'chunk-index.db'].map((file) =>
                        path.join(this.dbBasePath, file)
                    )
                )
            ]);
            const failure = [...results, ...temporary].find((result) => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
        })().finally(() => {
            if (this.closingPromise === closing) this.closingPromise = null;
        });
        this.closingPromise = closing;
        return closing;
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
        if (this.closeRequested) throw new Error('BaseStorage is closing or closed. Construct a new BaseStorage.');
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
