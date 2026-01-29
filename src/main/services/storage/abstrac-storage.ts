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
import { Indexer, IndexerSearchOptions as BaseIndexerSearchOptions, IndexerSearchResult } from './indexer.js';
import { BM25Indexer } from './bm25-indexer.js';
import { VectorIndexer } from './vector-indexer.js';
import { TagIndexer } from './tag-indexer.js';
import {BaseIndexer} from './base-indexer.js';

export type ItemType = 'file' | 'mail' | 'memory';

export interface Item {
    item_id: string;
    item_type: ItemType;
    [key: string]: any;  // 支持动态字段，用于传递列名
    // key代表indexer，array的string代表列名，
    indexer_columns?: {
        [indexer: string]: Array<{ column: string; content: string | number[] }>;
    };
}

export interface SearchItem {
    item: Item;
    tags?: string;
    VecScore?: number;
    BM25Score?: number;
    ChunkScore?: number;
}

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
 * 允许的列定义白名单
 * 用户只能从这个列表中选择列名
 */
// export const ALLOWED_COLUMNS: Record<string, ColumnConstraint> = {
//     // === 核心字段（必需） ===
//     'item_id': { type: 'TEXT', nullable: false },
//     'item_type': { type: 'TEXT', nullable: false },

//     // === 文件场景 ===
//     'filename': { type: 'TEXT', nullable: true },
//     'file_path': { type: 'TEXT', nullable: true },
//     'file_ext': { type: 'TEXT', nullable: true },
//     'size': { type: 'INTEGER', nullable: true, defaultValue: 0 },
//     'owner': { type: 'TEXT', nullable: true },
//     'creator': { type: 'TEXT', nullable: true },
//     'modifier': { type: 'TEXT', nullable: true },

//     // === 邮件场景 ===
//     'mail_title': { type: 'TEXT', nullable: true },
//     'mail_ctx': { type: 'TEXT', nullable: true },
//     'mail_from': { type: 'TEXT', nullable: true },
//     'mail_to': { type: 'TEXT', nullable: true },
//     'mail_cc': { type: 'TEXT', nullable: true },
//     'mail_date': { type: 'INTEGER', nullable: true },
//     'attachment_title': { type: 'TEXT', nullable: true },
//     'attachment_ctx': { type: 'TEXT', nullable: true },
//     'sender': { type: 'TEXT', nullable: true },

//     // === 文档场景 ===
//     'doc_title': { type: 'TEXT', nullable: true },
//     'doc_ctx': { type: 'TEXT', nullable: true },
//     'doc_author': { type: 'TEXT', nullable: true },
//     'doc_version': { type: 'TEXT', nullable: true },

//     // === 通用元数据 ===
//     'created_at': { type: 'INTEGER', nullable: true },
//     'updated_at': { type: 'INTEGER', nullable: true },
//     'tag': { type: 'TEXT', nullable: true },
//     'tags': { type: 'TEXT', nullable: true },
//     'text': { type: 'TEXT', nullable: true },
//     'category': { type: 'TEXT', nullable: true },
//     'priority': { type: 'INTEGER', nullable: true },
//     'status': { type: 'TEXT', nullable: true },
//     'description': { type: 'TEXT', nullable: true },
//     'source': { type: 'TEXT', nullable: true },
//     'url': { type: 'TEXT', nullable: true },

//     // === 数值字段 ===
//     'score': { type: 'REAL', nullable: true },
//     'count': { type: 'INTEGER', nullable: true },
//     'weight': { type: 'REAL', nullable: true },
// };

/**
 * 必需的列（每个 schema 都必须包含）
 */
export const REQUIRED_COLUMNS = ['item_id', 'item_type'];

/**
 * ColumnSchema 接口
 */
export interface ColumnSchema {
    // 代表该Item的所有列名字，key是列名，value是约束/类型描述
    columns: {
        [column: string]: ColumnConstraint;
    };
    // 代表哪些列需要被怎样的indexer索引
    needIndexers: {
        [column: string]: string[];
    };
}

/**
 * Schema 验证错误
 */
export class SchemaValidationError extends Error {
    constructor(message: string, public invalidColumns?: string[]) {
        super(message);
        this.name = 'SchemaValidationError';
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
    const validIndexers = ['BaseIndexer', 'BM25Indexer', 'VectorIndexer', 'TagIndexer'];
    for (const [column, indexers] of Object.entries(schema.needIndexers)) {
        for (const indexer of indexers) {
            if (!validIndexers.includes(indexer)) {
                errors.push(`Invalid indexer "${indexer}" for column "${column}"`);
            }
        }
    }

    if (errors.length > 0) {
        throw new SchemaValidationError(
            `Schema validation failed:\n${errors.join('\n')}`,
            invalidColumns
        );
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
export type ScalarOperator = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'like' | 'notlike' | 'in' | 'notin' | 'between' | 'notbetween';

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


// ============================================================================
// BaseStorage - 多索引器协调存储
// ============================================================================

/**
 * BaseStorage - 协调多个 Indexer 的统一存储接口
 */
export class BaseStorage {
    private bm25Indexer: Indexer;
    private vectorIndexer: Indexer;
    private tagIndexer: Indexer;
    private baseIndexer: BaseIndexer;
    private name: string;
    private schema: ColumnSchema;
    private dbBasePath: string;

    constructor(name: string, schema: ColumnSchema, dbBasePath?: string) {
        // 验证 schema
        validateColumnSchema(schema);

        this.name = name;
        this.schema = schema;
        this.dbBasePath = dbBasePath || path.join(process.cwd(), 'data', name);

        // 初始化 BaseIndexer（使用动态 schema）
        this.baseIndexer = new BaseIndexer(schema, path.join(this.dbBasePath, 'base-index.db'));

        // 初始化其他 indexer
        this.bm25Indexer = new BM25Indexer(path.join(this.dbBasePath, 'bm25-index.db'));
        this.vectorIndexer = new VectorIndexer(path.join(this.dbBasePath, 'vector-index.db'));
        this.tagIndexer = new TagIndexer(path.join(this.dbBasePath, 'tag-index.db'));
    }

    /**
     * 初始化所有 indexer
     */
    async initialize(): Promise<void> {
        await Promise.all([
            this.baseIndexer.initialize(),
            this.bm25Indexer.initialize(),
            this.vectorIndexer.initialize(),
            this.tagIndexer.initialize(),
        ]);
    }

    /**
     * 搜索方法 - 返回 SearchItem[]
     */
    async search(_query: string[], filterConditions: FilterCondition[]): Promise<SearchItem[]> {
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
            const conditions = conditionsByIndexer[indexerName];
            if (!conditions || conditions.length === 0) continue;

            const indexer = this.getIndexerByName(indexerName);

            if (!hasInitialData) {
                // 第一个有条件的 indexer，获取初始数据
                const searchResult = await indexer.search(conditions);
                results = this.itemsToSearchItems(searchResult.items, searchResult.scores, indexerName);
                hasInitialData = true;
            } else {
                // 后续 indexer，基于已有结果进行 join
                const existingItems = results.map(r => r.item);
                const searchResult = await indexer.search(conditions, {
                    existingResults: existingItems,
                });
                results = this.mergeSearchResults(results, searchResult.items, searchResult.scores, indexerName);
            }

            // 提前退出：如果结果为空
            if (results.length === 0) {
                return [];
            }
        }

        return results;
    }

    /**
     * 插入数据
     */
    async insert(items: Item[]): Promise<void> {
        if (items.length === 0) return;


        // 检查 items 内的每个 item，其 key 是否对应 schema 中的定义，不对应时直接 return
        for (const item of items) {
            for (const [col, indexers] of Object.entries(this.schema.needIndexers)) {
            // 检查当前 item 的 indexer_columns 是否包含对应的 indexer 和 column
                for (const ind of indexers) {
                    if (!item.indexer_columns ||
                        !item.indexer_columns[ind] ||
                        !item.indexer_columns[ind].some(colObj => colObj.column === col)) {
                            console.error(`[BaseStorage] Item ${item.item_id} does not contain the required column ${col} for indexer ${ind}`);
                            return;
                        }
                }
            }
        }

        // 根据 schema.needIndexers 确定每个字段需要哪些 indexer
        const indexersToUse = new Set<string>();

        for (const column of Object.keys(this.schema.needIndexers)) {
            const indexers = this.schema.needIndexers[column];
            for (const indexer of indexers) {
                indexersToUse.add(indexer);
            }
        }

        // 并行插入到各个 indexer
        const insertPromises: Promise<void>[] = [];

        // BaseIndexer 总是需要插入
        insertPromises.push(this.baseIndexer.insert(items));

        for (const indexerName of indexersToUse) {
            if (indexerName === 'BaseIndexer') continue;
            insertPromises.push(this.getIndexerByName(indexerName).insert(items));
        }

        await Promise.all(insertPromises);
    }

    /**
     * 删除数据
     */
    async delete(items: Item[]): Promise<void> {
        if (items.length === 0) return;

        const itemIds = items.map(i => i.item_id);

        await Promise.all([
            this.baseIndexer.delete(itemIds),
            this.bm25Indexer.delete(itemIds),
            this.vectorIndexer.delete(itemIds),
            this.tagIndexer.delete(itemIds),
        ]);
    }

    /**
     * 更新数据
     */
    async update(items: Item[]): Promise<void> {
        if (items.length === 0) return;

        await Promise.all([
            this.baseIndexer.update(items),
            this.bm25Indexer.update(items),
            this.vectorIndexer.update(items),
            this.tagIndexer.update(items),
        ]);
    }

    /**
     * 关闭所有 indexer
     */
    close(): void {
        this.baseIndexer.close();
        this.bm25Indexer.close();
        this.vectorIndexer.close();
        this.tagIndexer.close();
    }

    /**
     * 获取 BaseIndexer 实例
     */
    getBaseIndexer(): BaseIndexer {
        return this.baseIndexer;
    }

    /**
     * 获取 Schema
     */
    getSchema(): ColumnSchema {
        return this.schema;
    }

    private getIndexerByName(name: string): Indexer {
        switch (name) {
            case 'BM25Indexer':
                return this.bm25Indexer;
            case 'VectorIndexer':
                return this.vectorIndexer;
            case 'TagIndexer':
                return this.tagIndexer;
            case 'BaseIndexer':
                return this.baseIndexer;
            default:
                throw new Error(`Indexer ${name} not found`);
        }
    }

    /**
     * 将 Item[] 转换为 SearchItem[]
     */
    private itemsToSearchItems(
        items: Item[],
        scores?: Map<string, number>,
        indexerName?: string
    ): SearchItem[] {
        return items.map(item => {
            const score = scores?.get(item.item_id);
            return {
                item,
                tags: item.tag,
                BM25Score: indexerName === 'BM25Indexer' ? score : undefined,
                VecScore: indexerName === 'VectorIndexer' ? score : undefined,
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
        const existingMap = new Map(existing.map(r => [r.item.item_id, r]));

        return newItems.map(item => {
            const existingResult = existingMap.get(item.item_id);
            const score = scores?.get(item.item_id);
            return {
                item,
                tags: existingResult?.tags ?? item.tag,
                BM25Score: indexerName === 'BM25Indexer'
                    ? score
                    : existingResult?.BM25Score,
                ChunkScore: existingResult?.ChunkScore,
                VecScore: indexerName === 'VectorIndexer'
                    ? score
                    : existingResult?.VecScore,
            };
        });
    }
}
