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
 * TagIndexer - SQLite 标签索引器
 *
 * 包装 TagIndexDB 实现 Indexer 接口。
 * 用于基于标签的文件索引和查询。
 */

import { Indexer, IndexerSearchOptions, IndexerSearchResult } from './indexer.js';
import { Item, FilterCondition, ScalarOperator, QueryOperator, ItemType, ColumnSchema } from './abstract-storage.js';
import { createTagIndexDB } from './tag-index-db-factory.js';

// TagIndexDB 支持的操作符（从 abstract-storage 导入，保持类型别名以兼容）
export type TagQueryOperator = ScalarOperator;

// Tag 索引记录接口 - 保持语义最小化
export interface TagIndexRecord {
    item_id: string;
    item_type: string;
    tag: string;
}

// 查询条件接口
export interface QueryCondition {
    field: keyof TagIndexRecord;
    operator: ScalarOperator;
    value: string | string[] | number;
}

// 查询选项接口
export interface QueryOptions {
    conditions?: QueryCondition[];
    orderBy?: {
        field: keyof TagIndexRecord;
        direction: 'ASC' | 'DESC';
    };
    limit?: number;
    offset?: number;
}

// 更新数据接口
export interface UpdateData {
    item_type?: string;
    tag?: string;
}

// ============================================================================
// ITagIndexDB - 统一异步接口（TagIndexDB 和 TagIndexDBHm 共同实现）
// ============================================================================
export interface ITagIndexDB {
    insert(record: TagIndexRecord): Promise<boolean>;
    insertMany(records: TagIndexRecord[]): Promise<number>;
    upsert(record: TagIndexRecord): Promise<boolean>;
    upsertMany(records: TagIndexRecord[]): Promise<number>;
    delete(itemId: string): Promise<boolean>;
    deleteByConditions(conditions: QueryCondition[]): Promise<number>;
    deleteMany(itemIds: string[]): Promise<number>;
    update(itemId: string, data: UpdateData): Promise<boolean>;
    updateMany(records: TagIndexRecord[]): Promise<number>;
    updateByConditions(conditions: QueryCondition[], data: UpdateData): Promise<number>;
    findById(itemId: string): Promise<TagIndexRecord | undefined>;
    findAll(options?: QueryOptions): Promise<TagIndexRecord[]>;
    search(conditions: QueryCondition[], options?: Omit<QueryOptions, 'conditions'>): Promise<TagIndexRecord[]>;
    count(conditions?: QueryCondition[]): Promise<number>;
    exists(itemId: string): Promise<boolean>;
    clear(): Promise<number>;
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    close(): void | Promise<void>;
    dropStorage(): Promise<void>;
}

/**
 * 文件标签索引器
 *
 * 使用 SQLite 存储文件标签索引，支持标量查询操作。
 * 不支持向量操作符。
 */
export class TagIndexer extends Indexer {
    readonly name = 'TagIndexer';
    readonly supportedFields = ['item_id', 'item_type', 'tag'];
    readonly supportedOperators: QueryOperator[] = ['=', '!=', '>', '<', '>=', '<=', 'like', 'in'];
    private columnName;

    private db: ITagIndexDB | null = null;
    private readonly _dbPath: string;
    private isInitialized = false;
    private isDropped = false;
    private closingPromise: Promise<void> | null = null;

    constructor(schema: ColumnSchema, dbPath: string) {
        super();
        this.columnName = Object.keys(schema.needIndexers).find((key) =>
            schema.needIndexers[key].some((b) => b.indexer === this.name)
        );
        this._dbPath = dbPath;
    }

    /**
     * 初始化索引器
     */
    async initialize(): Promise<void> {
        if (this.isDropped) {
            throw new Error('TagIndexer storage has been dropped. Construct a new TagIndexer.');
        }
        if (!this.db) {
            this.db = await createTagIndexDB(this._dbPath);
        }
        this.isInitialized = true;
    }

    private ensureDB(): ITagIndexDB {
        if (this.isDropped) {
            throw new Error('TagIndexer storage has been dropped. Construct a new TagIndexer.');
        }
        if (!this.db) throw new Error('TagIndexer not initialized. Call initialize() first.');
        return this.db;
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
                `TagIndexer does not support field: ${field}. ` + `Supported fields: ${this.supportedFields.join(', ')}`
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
            value: cond.value
        };
    }

    /**
     * TagIndexRecord → Item 转换
     *
     * 注意：TagIndexRecord 不包含 created_at/updated_at 字段
     * 如果有 existingResults，从中获取完整元数据
     */
    private recordToItem(record: TagIndexRecord, metadata?: Partial<Item>): Item {
        const item = {
            item_id: record.item_id,
            item_type: record.item_type as ItemType,
            tag: record.tag
        } as Item;
        // 从 metadata 复制额外字段
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

    private buildRecords(items: Item[]): TagIndexRecord[] {
        const records: TagIndexRecord[] = [];
        for (const item of items) {
            const col = item.indexer_columns?.[this.name]?.find((c) => c.column === this.columnName);
            if (!col) continue;
            if (typeof col.content !== 'string') {
                throw new Error(`[TagIndexer] Item ${item.item_id} tag content must be string`);
            }
            records.push(this.itemToRecord(item, col.content));
        }
        return records;
    }

    /**
     * Item → TagIndexRecord 转换
     */
    private itemToRecord(item: Item, tag: string): TagIndexRecord {
        return {
            item_id: item.item_id,
            item_type: this.columnName ?? '',
            tag: tag
        };
    }

    /**
     * 搜索匹配条件的 Item
     */
    async search(conditions: FilterCondition[], options?: IndexerSearchOptions): Promise<IndexerSearchResult> {
        // 转换条件
        const queryConditions = conditions.map((c) => this.toQueryCondition(c));

        // Join 过滤：限制在已有结果集的 item_id 范围内
        if (options?.existingResults && options.existingResults.length > 0) {
            queryConditions.push({
                field: 'item_id',
                operator: 'in',
                value: options.existingResults.map((r) => r.item_id)
            });
        }

        // 执行查询
        const records = await this.ensureDB().search(queryConditions, {
            limit: options?.limit,
            offset: options?.offset,
            orderBy: options?.orderBy
                ? {
                      field: options.orderBy.field as keyof TagIndexRecord,
                      direction: options.orderBy.direction
                  }
                : undefined
        });

        // 如果有 existingResults，从中获取完整的 Item 元数据
        const existingMap = new Map(options?.existingResults?.map((i) => [i.item_id, i]));

        // 转换记录为 Item
        const items = records.map((r) => this.recordToItem(r, existingMap.get(r.item_id)));

        // 获取总数
        const totalCount = await this.ensureDB().count(queryConditions);

        return { items, totalCount };
    }

    /**
     * 向索引中插入 Item
     */
    async insert(items: Item[]): Promise<void> {
        const records = this.buildRecords(items);
        if (records.length > 0) await this.ensureDB().insertMany(records);
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
    close(): Promise<void> {
        if (this.closingPromise) return this.closingPromise;
        const db = this.db;
        if (!db) return Promise.resolve();
        const closing = Promise.resolve()
            .then(() => db.close())
            .then(() => {
                if (this.db === db) this.db = null;
            })
            .finally(() => {
                if (this.closingPromise === closing) this.closingPromise = null;
            });
        this.closingPromise = closing;
        return closing;
    }

    async dropStorage(): Promise<void> {
        const db = this.ensureDB();
        let failure: unknown;
        let failed = false;
        try {
            await db.dropStorage();
        } catch (error) {
            failure = error;
            failed = true;
        }
        try {
            await this.close();
        } catch (error) {
            if (!failed) failure = error;
            failed = true;
        }
        this.isDropped = true;
        this.isInitialized = false;
        // Preserve the original drop error and the holder of a failed release.
        if (failed) throw failure;
    }

    async clear(): Promise<void> {
        await this.ensureDB().clear();
    }

    async getInfo(): Promise<Record<string, any>> {
        const size = await this.ensureDB().count();
        return { size };
    }
}

/**
 * 创建 TagIndexer 实例的工厂函数
 */
export function createTagIndexer(schema: ColumnSchema, dbPath: string): TagIndexer {
    return new TagIndexer(schema, dbPath);
}

export default TagIndexer;
