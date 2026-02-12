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
 * BM25Indexer - 基于 BM25IndexDB 的全文搜索索引器
 *
 * 包装 BM25IndexDB 实现 Indexer 接口。
 * 用于基于 BM25 算法的全文搜索。
 */

import { Indexer, IndexerSearchOptions, IndexerSearchResult } from './indexer.js';
import { Item, FilterCondition, QueryOperator, BM25Query, ItemType, ColumnSchema } from './abstract-storage.js';
import { BM25IndexDB, BM25Record, BM25SearchResult } from './bm25-index-db.js';
import { randomUUID } from 'crypto';

/**
 * BM25 全文搜索索引器
 *
 * 使用 search-index + nodejieba 实现 BM25 检索。
 * 支持中英文混合分词。
 */
export class BM25Indexer extends Indexer {
    readonly name = 'BM25Indexer';
    readonly supportedFields = ['text'];
    readonly supportedOperators: QueryOperator[] = ['bm25_match'];
    private readonly columnName = 'text';

    private db: BM25IndexDB;
    private defaultTopK: number;
    private schema: ColumnSchema;

    constructor(schema: ColumnSchema, dbPath: string, defaultTopK = 10) {
        super();
        this.db = new BM25IndexDB(schema, dbPath);
        this.defaultTopK = defaultTopK;
        this.schema = schema;
    }

    /**
     * 初始化索引器
     */
    async initialize(): Promise<void> {
        await this.db.initialize();
    }

    /**
     * 验证字段是否支持
     */
    private validateField(field: string): void {
        const indexers = this.schema.needIndexers?.[field];
        if (!indexers || !indexers.includes(this.name)) {
            throw new Error(
                `BM25Indexer does not support field: ${field}. ` +
                `Field must be listed in schema.needIndexers with BM25Indexer`
            );
        }
    }

    /**
     * 验证操作符是否支持
     */
    private validateOperator(operator: QueryOperator): void {
        if (!this.supportsOperator(operator)) {
            throw new Error(
                `BM25Indexer does not support operator: ${operator}. ` +
                `Supported operators: ${this.supportedOperators.join(', ')}`
            );
        }
    }

    /**
     * BM25SearchResult → Item 转换
     */
    private resultToItem(result: BM25SearchResult, metadata?: Partial<Item>): Item {
        const item: Item = {
            item_id: result.item_id,
            item_type: result.item_type as ItemType,
            text: result.text,
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
     * Item → BM25Record 转换
     */
    private itemToRecord(item: Item, colName: string, new_id: string): BM25Record {
        const col = item.indexer_columns?.[this.name]?.find(c => c.column === colName);
        const text = (col?.content as string) ?? '';

        return {
            bm25_id: new_id,
            item_id: item.item_id,
            item_type: colName,
            text: text,
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

        const condition = conditions[0];
        this.validateField(condition.field);
        this.validateOperator(condition.operator);

        const bm25Query = condition.value as BM25Query;
        if (!bm25Query || typeof bm25Query.query !== 'string') {
            throw new Error('bm25_match requires a BM25Query value with query string');
        }

        const topK = bm25Query.topK ?? options?.limit ?? this.defaultTopK;

        // 调用 DB 层搜索
        const results = await this.db.search(bm25Query.query, { columnName: condition.field, topK: topK * 2 });

        if (results.length === 0) {
            return { items: [], totalCount: 0 };
        }

        // 构建 existingResults 的 ID 集合（用于 join 过滤）
        const existingIds = options?.existingResults
            ? new Set(options.existingResults.map(r => r.item_id))
            : null;

        // 构建 existingResults 的元数据映射
        const existingMap = new Map(
            options?.existingResults?.map(i => [i.item_id, i])
        );

        const items: Item[] = [];
        const scores = new Map<string, number>();

        for (const result of results) {
            // Join 过滤
            if (existingIds && !existingIds.has(result.item_id)) {
                continue;
            }

            const item = this.resultToItem(result, existingMap.get(result.item_id));
            items.push(item);
            scores.set(result.item_id, result.score);

            if (items.length >= topK) break;
        }

        // 应用 offset
        let finalItems = items;
        if (options?.offset !== undefined) {
            finalItems = finalItems.slice(options.offset);
        }

        // 应用 limit
        if (options?.limit !== undefined && options.limit < finalItems.length) {
            finalItems = finalItems.slice(0, options.limit);
        }

        return {
            items: finalItems,
            totalCount: finalItems.length,
            scores,
        };
    }

    /**
     * 向索引中插入 Item
     */
    async insert(items: Item[]): Promise<void> {
        const records: BM25Record[] = [];
        for (const item of items) {
            const columns = item.indexer_columns?.[this.name] as Array<{ column: string; content: string }> | undefined;
            if (!columns || columns.length === 0) {
                console.error(`[BM25Indexer] Item ${item.item_id} does not contain indexer_columns for ${this.name}`);
                continue;
            }

            for (const col of columns) {
                const columnName = col.column;
                const text = col.content;
                if (typeof text !== 'string') {
                    console.error(`[BM25Indexer] Item ${item.item_id} does not contain a valid text for indexer ${this.name} (${columnName})`);
                    continue;
                }

                const record = this.itemToRecord(item, columnName, randomUUID());
                if (record) {
                    records.push(record);
                }
            }
        }
        if (records.length > 0) {
            await this.db.insert(records);
        }
    }

    /**
     * 从索引中删除 Item
     */
    async delete(itemIds: string[]): Promise<void> {
        await this.db.delete(itemIds);
    }

    /**
     * 更新索引中的 Item
     */
    async update(items: Item[]): Promise<void> {
        const records: BM25Record[] = [];
        for (const item of items) {
            const columns = item.indexer_columns?.[this.name] as Array<{ column: string; content: string }> | undefined;
            if (!columns || columns.length === 0) {
                console.error(`[BM25Indexer] Item ${item.item_id} does not contain indexer_columns for ${this.name}`);
                continue;
            }

            for (const col of columns) {
                const columnName = col.column;
                const text = col.content;
                if (typeof text !== 'string') {
                    console.error(`[BM25Indexer] Item ${item.item_id} does not contain a valid text for indexer ${this.name} (${columnName})`);
                    continue;
                }

                const record = this.itemToRecord(item, columnName, randomUUID());
                if (record) {
                    records.push(record);
                }
            }
        }
        if (records.length > 0) {
            await this.db.update(records);
        }
    }

    /**
     * 关闭索引器
     */
    close(): void {
        this.db.close();
    }

    /**
     * 刷新索引到磁盘
     */
    async flush(): Promise<void> {
        await this.db.flush();
    }

    /**
     * 获取底层 BM25IndexDB 实例（用于高级操作）
     */
    getDB(): BM25IndexDB {
        return this.db;
    }

    /**
     * 删除所有数据库内容
     */
    async deleteAll(): Promise<void> {
        if (this.db) {
            await this.db.deleteAll();
        } else {
            throw new Error('[BM25Indexer] BM25IndexDB deleteAll fails');
        }
    }
}

/**
 * 创建 BM25Indexer 实例的工厂函数
 */
export function createBM25Indexer(schema: ColumnSchema, dbPath: string, defaultTopK = 10): BM25Indexer {
    return new BM25Indexer(schema, dbPath, defaultTopK);
}

export default BM25Indexer;
