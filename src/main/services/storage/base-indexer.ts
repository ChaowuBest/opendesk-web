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

import path from 'path';
import type { BaseCountGroup } from './grouped-count.js';
import { Indexer, IndexerSearchOptions as BaseIndexerSearchOptions, IndexerSearchResult } from './indexer.js';
import { createBaseIndexDB, probeBaseIndexStore } from './base-index-db-factory.js';
import {
    ColumnSchema,
    validateColumnSchema,
    QueryOperator,
    FilterCondition,
    Item,
    ItemType,
    ScalarOperator
} from './abstract-storage.js';
import { normalizePathDescendantOrSelfValues } from './path-scope.js';

// BaseIndexDB 支持的操作符（从 abstract-storage 导入，保持类型别名以兼容）
export type BaseQueryOperator = ScalarOperator;

// 查询条件接口
export interface BaseQueryCondition {
    field: string;
    operator: BaseQueryOperator;
    value: string | string[] | number | number[] | [number, number] | [string, string];
}

// 查询选项接口
export interface BaseQueryOptions {
    conditions?: BaseQueryCondition[];
    orderBy?: {
        field: string;
        direction: 'ASC' | 'DESC';
    };
    limit?: number;
    offset?: number;
}

export type BaseIndexStoreProbeResult = 'exists' | 'missing' | 'open_failed';

// ============================================================================
// IBaseIndexDB - 统一异步接口（BaseIndexDB 和 BaseIndexDBHm 共同实现）
// ============================================================================
export interface IBaseIndexDB {
    insert(record: Record<string, any>): Promise<boolean>;
    insertMany(records: Record<string, any>[]): Promise<number>;
    upsert(record: Record<string, any>): Promise<boolean>;
    upsertMany(records: Record<string, any>[]): Promise<number>;
    delete(itemId: string): Promise<boolean>;
    deleteMany(itemIds: string[]): Promise<number>;
    deleteByConditions(conditions: BaseQueryCondition[]): Promise<number>;
    update(itemId: string, data: Record<string, any>): Promise<boolean>;
    updateMany(records: Record<string, any>[]): Promise<number>;
    updateWhere(field: string, value: any, conditions: BaseQueryCondition[]): Promise<number>;
    findById(itemId: string): Promise<Record<string, any> | undefined>;
    findByIds(itemIds: string[]): Promise<Record<string, any>[]>;
    findAll(options?: BaseQueryOptions): Promise<Record<string, any>[]>;
    search(
        conditions: BaseQueryCondition[],
        options?: Omit<BaseQueryOptions, 'conditions'>
    ): Promise<Record<string, any>[]>;
    count(conditions?: BaseQueryCondition[]): Promise<number>;
    countGrouped(fields: string[], conditions?: BaseQueryCondition[]): Promise<BaseCountGroup[]>;
    exists(itemId: string): Promise<boolean>;
    clear(): Promise<number>;
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    close(): void | Promise<void>;
    dropStorage(): Promise<void>;
    getSchema(): ColumnSchema;
    getValidFields(): string[];
}
// ============================================================================
// BaseIndexer - 动态 Schema 的 SQLite 索引器
// ============================================================================

/**
 * BaseIndexer - 支持动态 Schema 的 SQLite 索引器
 *
 * 特性：
 * - 根据 ColumnSchema 动态创建表结构
 * - 支持所有标量操作符
 * - 使用 WAL 模式确保并发安全（SQLite 层面处理）
 * - 自动创建索引提高查询性能
 */
export class BaseIndexer extends Indexer {
    readonly name = 'BaseIndexer';
    readonly supportedOperators: QueryOperator[] = [
        '=',
        '!=',
        '>',
        '<',
        '>=',
        '<=',
        'like',
        'notlike',
        'in',
        'notin',
        'between',
        'notbetween',
        'path_descendant_or_self'
    ];

    private _supportedFields: string[] = [];
    private db: IBaseIndexDB | null = null;
    private schema: ColumnSchema;
    private readonly _dbPath: string;
    private isInitialized = false;
    private isDropped = false;
    private closingPromise: Promise<void> | null = null;

    constructor(schema: ColumnSchema, dbPath: string) {
        super();
        validateColumnSchema(schema);
        this.schema = schema;
        this._supportedFields = Object.keys(schema.columns);
        this._dbPath = dbPath;
    }

    get supportedFields(): string[] {
        return this._supportedFields;
    }

    /**
     * 初始化索引器
     */
    async initialize(): Promise<void> {
        if (this.isDropped) {
            throw new Error('BaseIndexer storage has been dropped. Construct a new BaseIndexer.');
        }
        if (!this.db) {
            this.db = await createBaseIndexDB(this._dbPath, this.schema);
        }
        this.isInitialized = true;
    }

    async probeStore(): Promise<BaseIndexStoreProbeResult> {
        return probeBaseIndexStore(this._dbPath);
    }

    private ensureDB(): IBaseIndexDB {
        if (this.isDropped) {
            throw new Error('BaseIndexer storage has been dropped. Construct a new BaseIndexer.');
        }
        if (!this.db) throw new Error('BaseIndexer not initialized. Call initialize() first.');
        return this.db;
    }

    private buildRecords(items: Item[]): Record<string, any>[] {
        return items.map((item) => {
            const record: Record<string, any> = {};
            for (const field of this._supportedFields) {
                if (item[field] !== undefined) {
                    record[field] = item[field];
                }
            }
            return record;
        });
    }

    /**
     * 验证字段是否支持
     */
    private validateField(field: string): void {
        if (!this._supportedFields.includes(field)) {
            throw new Error(
                `BaseIndexer does not support field: ${field}. ` +
                    `Supported fields: ${this._supportedFields.join(', ')}`
            );
        }
    }

    /**
     * 验证操作符是否支持
     */
    private validateOperator(operator: QueryOperator): void {
        if (!this.supportsOperator(operator)) {
            throw new Error(
                `BaseIndexer does not support operator: ${operator}. ` +
                    `Supported operators: ${this.supportedOperators.join(', ')}`
            );
        }
    }

    /**
     * 转换 FilterCondition 为 BaseQueryCondition
     */
    private toQueryCondition(cond: FilterCondition): BaseQueryCondition {
        this.validateField(cond.field);
        this.validateOperator(cond.operator);
        if (cond.operator === 'path_descendant_or_self') {
            normalizePathDescendantOrSelfValues(cond.value);
        }

        return {
            field: cond.field,
            operator: cond.operator as BaseQueryOperator,
            value: cond.value
        };
    }

    /**
     * 搜索匹配条件的 Item
     */
    async search(conditions: FilterCondition[], options?: BaseIndexerSearchOptions): Promise<IndexerSearchResult> {
        // 转换条件
        const queryConditions = conditions
            .filter((c) => c.indexer === 'BaseIndexer')
            .map((c) => this.toQueryCondition(c));

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
                      field: options.orderBy.field,
                      direction: options.orderBy.direction
                  }
                : undefined
        });

        // 如果有 existingResults，从中获取完整的元数据
        const existingMap = new Map(options?.existingResults?.map((r) => [r.item_id, r]));

        // 转换记录为 Item
        const items: Item[] = records.map((record) => {
            const existing = existingMap.get(record.item_id);
            const item: Item = {
                item_id: record.item_id,
                item_type: record.item_type as ItemType
            };

            // 动态复制 schema 中定义的字段
            for (const field of this._supportedFields) {
                if (field === 'item_id' || field === 'item_type') continue;
                if (record[field] !== undefined) {
                    item[field] = record[field];
                } else if (existing?.[field] !== undefined) {
                    item[field] = existing[field];
                }
            }
            return item;
        });

        // 获取总数
        const totalCount = await this.ensureDB().count(queryConditions);

        return { items, totalCount };
    }

    async countGrouped(fields: string[], conditions: FilterCondition[]): Promise<BaseCountGroup[]> {
        if (conditions.some((condition) => condition.indexer !== 'BaseIndexer')) {
            throw new Error('Grouped counts only support BaseIndexer conditions');
        }
        return this.ensureDB().countGrouped(
            fields,
            conditions.map((condition) => this.toQueryCondition(condition))
        );
    }

    async count(conditions: FilterCondition[]): Promise<number> {
        const queryConditions = conditions
            .filter((c) => c.indexer === 'BaseIndexer')
            .map((c) => this.toQueryCondition(c));
        return this.ensureDB().count(queryConditions);
    }

    /**
     * 插入 Item
     */
    async insert(items: Item[]): Promise<void> {
        if (items.length === 0) return;
        await this.ensureDB().insertMany(this.buildRecords(items));
    }

    /**
     * 删除 Item
     */
    async delete(itemIds: string[]): Promise<void> {
        if (itemIds.length === 0) return;

        await this.ensureDB().deleteMany(itemIds);
    }

    /**
     * 更新 Item
     */
    async update(items: Item[]): Promise<void> {
        if (items.length === 0) return;
        await this.ensureDB().updateMany(this.buildRecords(items));
    }

    async upsert(items: Item[]): Promise<void> {
        if (items.length === 0) return;
        await this.ensureDB().upsertMany(this.buildRecords(items));
    }

    async resetField(field: string, value: any, conditions: FilterCondition[]): Promise<number> {
        this.validateField(field);
        const queryConditions = conditions
            .filter((c) => c.indexer === 'BaseIndexer')
            .map((c) => this.toQueryCondition(c));
        return this.ensureDB().updateWhere(field, value, queryConditions);
    }

    /**
     * 关闭索引器
     */
    close(): Promise<void> {
        if (this.closingPromise) return this.closingPromise;
        const db = this.db;
        if (!db) return Promise.resolve();
        // Keep the holder reachable until its reference has actually been released.
        const closing = (async () => {
            await db.close();
            if (this.db === db) this.db = null;
        })().finally(() => {
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

        this.isDropped = true;
        this.isInitialized = false;
        try {
            await this.close();
        } catch (error) {
            if (!failed) failure = error;
            failed = true;
        }
        if (failed) throw failure;
    }

    async clear(): Promise<void> {
        await this.ensureDB().clear();
    }

    async getInfo(): Promise<Record<string, any>> {
        const size = await this.ensureDB().count();
        return { size };
    }

    /**
     * 获取记录数
     */
    async getCount(): Promise<number> {
        return this.ensureDB().count();
    }

    /**
     * 获取 schema
     */
    getSchema(): ColumnSchema {
        return this.schema;
    }
}
