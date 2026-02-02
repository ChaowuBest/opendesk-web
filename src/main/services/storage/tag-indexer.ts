/**
 * TagIndexer - SQLite 标签索引器
 *
 * 包装 TagIndexDB 实现 Indexer 接口。
 * 用于基于标签的文件索引和查询。
 */

import { Indexer, IndexerSearchOptions, IndexerSearchResult } from './indexer.js';
import { Item, FilterCondition, ScalarOperator, QueryOperator, ItemType, ColumnSchema } from './abstract-storage.js';
import { TagIndexDB, TagIndexRecord, QueryCondition } from './tag-index-db.js';

/**
 * 文件标签索引器
 *
 * 使用 SQLite 存储文件标签索引，支持标量查询操作。
 * 不支持向量操作符。
 */
export class TagIndexer extends Indexer {
    readonly name = 'TagIndexer';
    readonly supportedFields = ['item_id', 'item_type', 'tag'];
    readonly supportedOperators: QueryOperator[] = [
        '=', '!=', '>', '<', '>=', '<=', 'like', 'in'
    ];
    private columnName;

    private db: TagIndexDB;
    private isInitialized = false;

    constructor(schema: ColumnSchema, dbPath: string) {
        super();
        this.columnName = Object.keys(schema.needIndexers).find(
            key => schema.needIndexers[key].includes(this.name)
        );
        this.db = new TagIndexDB(dbPath);
    }

    /**
     * 初始化索引器
     */
    async initialize(): Promise<void> {
        // TagIndexDB 在构造函数中已初始化
        this.isInitialized = true;
    }

    /**
     * 验证操作符是否支持
     */
    private validateOperator(operator: QueryOperator): void {
        if (!this.supportsOperator(operator)) {
            throw new Error(
                `TagIndexer does not support operator: ${operator}. ` +
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
                `TagIndexer does not support field: ${field}. ` +
                `Supported fields: ${this.supportedFields.join(', ')}`
            );
        }
    }

    /**
     * 转换 FilterCondition 为 TagIndexDB 的 QueryCondition
     * 操作符已统一，无需映射
     */
    private toQueryCondition(cond: FilterCondition): QueryCondition {
        this.validateField(cond.field);
        this.validateOperator(cond.operator);

        return {
            field: cond.field as keyof TagIndexRecord,
            operator: cond.operator as ScalarOperator,
            value: cond.value,
        };
    }

    /**
     * TagIndexRecord → Item 转换
     *
     * 注意：TagIndexRecord 不包含 created_at/updated_at 字段
     * 如果有 existingResults，从中获取完整元数据
     */
    private recordToItem(record: TagIndexRecord, metadata?: Partial<Item>): Item {
        const item: Item = {
            item_id: record.item_id,
            item_type: record.item_type as ItemType,
            tag: record.tag,
        };
        // 从 metadata 复制额外字段
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
     * Item → TagIndexRecord 转换
     */
    private itemToRecord(item: Item, tag: string): TagIndexRecord {
        return {
            item_id: item.item_id,
            item_type: item.item_type,
            tag: tag,
        };
    }

    /**
     * 搜索匹配条件的 Item
     */
    async search(
        conditions: FilterCondition[],
        options?: IndexerSearchOptions
    ): Promise<IndexerSearchResult> {
        // 转换条件
        const queryConditions = conditions.map(c => this.toQueryCondition(c));

        // Join 过滤：限制在已有结果集的 item_id 范围内
        if (options?.existingResults && options.existingResults.length > 0) {
            queryConditions.push({
                field: 'item_id',
                operator: 'in',
                value: options.existingResults.map(r => r.item_id),
            });
        }

        // 执行查询
        const records = this.db.query(queryConditions, {
            limit: options?.limit,
            offset: options?.offset,
            orderBy: options?.orderBy ? {
                field: options.orderBy.field as keyof TagIndexRecord,
                direction: options.orderBy.direction,
            } : undefined,
        });

        // 如果有 existingResults，从中获取完整的 Item 元数据
        const existingMap = new Map(
            options?.existingResults?.map(i => [i.item_id, i])
        );

        // 转换记录为 Item
        const items = records.map(r => this.recordToItem(r, existingMap.get(r.item_id)));

        // 获取总数
        const totalCount = this.db.count(queryConditions);

        return { items, totalCount };
    }

    /**
     * 向索引中插入 Item
     */
    async insert(items: Item[]): Promise<void> {
        const records: TagIndexRecord[] = [];

        for (const item of items) {
            const col = item.indexer_columns?.[this.name]?.find(c => c.column === this.columnName);
            const record = this.itemToRecord(item, col?.content as string);
            if (record) {
                records.push(record);
            }
        }

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
     */
    async update(items: Item[]): Promise<void> {
        for (const item of items) {
            const col = item.indexer_columns?.[this.name]?.find(c => c.column === this.columnName);
            const record = this.itemToRecord(item, col?.content as string);
            this.db.upsert(record);
        }
    }

    /**
     * 关闭索引器
     */
    close(): void {
        this.db.close();
    }

    /**
     * 获取底层 TagIndexDB 实例（用于高级操作）
     */
    getDB(): TagIndexDB {
        return this.db;
    }
}

/**
 * 创建 TagIndexer 实例的工厂函数
 */
export function createTagIndexer(schema: ColumnSchema, dbPath: string): TagIndexer {
    return new TagIndexer(schema, dbPath);
}

export default TagIndexer;
