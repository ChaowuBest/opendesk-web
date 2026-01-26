/**
 * VectorIndexer - SQLite-vec 向量索引器
 *
 * 包装 VectorIndexDB 实现 Indexer 接口。
 * 用于基于向量相似度的文件索引和查询。
 */

import { Indexer, IndexerSearchOptions, IndexerSearchResult } from './indexer.js';
import { Item, FilterCondition, VectorOperator, QueryOperator, VectorQuery } from './object.js';
import { VectorIndexDB, VectorIndexRecord, VectorSearchOptions } from './vector-index-db.js';

/**
 * 向量索引器
 *
 * 使用 SQLite + sqlite-vec 存储向量索引，支持向量相似度查询。
 * 不支持标量操作符。
 */
export class VectorIndexer extends Indexer {
    readonly name = 'VectorIndexer';
    readonly supportedFields = ['repr'];
    readonly supportedOperators: QueryOperator[] = [
        'vector_similarity',
        'vector_near',
        'vector_not_similar',
        'vector_range'
    ];

    private db: VectorIndexDB;
    private readonly dimension: number;
    private isInitialized = false;

    constructor(dbPath: string, dimension: number = 1024) {
        super();
        this.dimension = dimension;
        this.db = new VectorIndexDB(dbPath, dimension);
    }

    /**
     * 初始化索引器
     */
    async initialize(): Promise<void> {
        // VectorIndexDB 在构造函数中已初始化
        this.isInitialized = true;
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
        if (!this.supportsField(field)) {
            throw new Error(
                `VectorIndexer does not support field: ${field}. ` +
                `Supported fields: ${this.supportedFields.join(', ')}`
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
    private resultToItem(
        result: { item_id: string; item_type: string },
        metadata?: Partial<Item>
    ): Item {
        const item: Item = {
            item_id: result.item_id,
            item_type: result.item_type,
        };
        // 从 metadata 复制所有额外字段
        if (metadata) {
            for (const [key, value] of Object.entries(metadata)) {
                if (!(key in item) && value !== undefined) {
                    item[key] = value;
                }
            }
        }
        return item;
    }

    /**
     * Item → VectorIndexRecord 转换
     * 注意：需要 Item 附带 repr 属性
     */
    private itemToRecord(item: Item & { repr?: Float32Array | number[] }): VectorIndexRecord | null {
        if (!item.repr) {
            return null;
        }
        return {
            item_id: item.item_id,
            item_type: item.item_type,
            repr: item.repr,
        };
    }

    /**
     * 搜索匹配条件的 Item
     */
    async search(
        conditions: FilterCondition[],
        options?: IndexerSearchOptions
    ): Promise<IndexerSearchResult> {
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
        const filterItemIds = options?.existingResults?.map(r => r.item_id);

        // 构建搜索选项
        const searchOptions: VectorSearchOptions = {
            metric: vectorQuery.metric || 'cosine',
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
        const results = this.db.search(queryVector, searchOptions, filterItemIds);

        // 根据操作符过滤结果
        let filteredResults = results;
        switch (operator) {
            case 'vector_similarity':
                filteredResults = results.filter(r => r.similarity >= vectorQuery.threshold);
                break;

            case 'vector_not_similar':
                filteredResults = results.filter(r => r.similarity < vectorQuery.threshold);
                break;

            case 'vector_range':
                // 假设 threshold 是最小值，可以扩展支持 min/max
                const minThreshold = vectorQuery.threshold;
                const maxThreshold = (vectorQuery as any).maxThreshold ?? 1.0;
                filteredResults = results.filter(
                    r => r.similarity >= minThreshold && r.similarity <= maxThreshold
                );
                break;
        }

        // 构建 scores Map（用于排序）
        const scores = new Map<string, number>();
        filteredResults.forEach(r => scores.set(r.item_id, r.similarity));

        // 如果有 existingResults，从中获取完整的 Item 元数据
        const existingMap = new Map(
            options?.existingResults?.map(i => [i.item_id, i])
        );

        // 转换为 Item
        const items = filteredResults.map(r =>
            this.resultToItem(r, existingMap.get(r.item_id))
        );

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
            scores,
        };
    }

    /**
     * 向索引中插入 Item
     * 注意：Item 需要附带 repr 属性
     */
    async insert(items: Item[]): Promise<void> {
        const records: VectorIndexRecord[] = [];
        for (const item of items) {
            const record = this.itemToRecord(item as Item & { repr?: Float32Array | number[] });
            if (record) {
                records.push(record);
            }
        }
        if (records.length > 0) {
            this.db.insertMany(records);
        }
    }

    /**
     * 带向量的插入（类型安全）
     */
    async insertWithVectors(
        items: Array<Item & { repr: Float32Array | number[] }>
    ): Promise<void> {
        const records = items.map(item => ({
            item_id: item.item_id,
            item_type: item.item_type,
            repr: item.repr,
        }));
        this.db.insertMany(records);
    }

    /**
     * 从索引中删除 Item
     */
    async delete(itemIds: string[]): Promise<void> {
        this.db.deleteMany(itemIds);
    }

    /**
     * 更新索引中的 Item
     * 注意：Item 需要附带 repr 属性
     */
    async update(items: Item[]): Promise<void> {
        for (const item of items) {
            const record = this.itemToRecord(item as Item & { repr?: Float32Array | number[] });
            if (record) {
                this.db.upsert(record);
            }
        }
    }

    /**
     * 带向量的更新（类型安全）
     */
    async updateWithVectors(
        items: Array<Item & { repr: Float32Array | number[] }>
    ): Promise<void> {
        for (const item of items) {
            this.db.upsert({
                item_id: item.item_id,
                item_type: item.item_type,
                repr: item.repr,
            });
        }
    }

    /**
     * 关闭索引器
     */
    close(): void {
        this.db.close();
    }

    /**
     * 获取底层 VectorIndexDB 实例（用于高级操作）
     */
    getDB(): VectorIndexDB {
        return this.db;
    }

    /**
     * 获取向量维度
     */
    getDimension(): number {
        return this.dimension;
    }
}

/**
 * 创建 VectorIndexer 实例的工厂函数
 */
export function createVectorIndexer(dbPath: string, dimension: number = 1024): VectorIndexer {
    return new VectorIndexer(dbPath, dimension);
}

export default VectorIndexer;
