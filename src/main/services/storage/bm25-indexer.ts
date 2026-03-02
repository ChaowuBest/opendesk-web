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
 */

import { Indexer, IndexerSearchOptions, IndexerSearchResult } from './indexer.js';
import { Item, FilterCondition, QueryOperator, BM25Query, ItemType, ColumnSchema } from './abstract-storage.js';
import { BM25Record, BM25SearchResult, IBM25IndexDB, createBM25IndexDB } from './bm25-index-db.js';
import { randomUUID } from 'crypto';

export class BM25Indexer extends Indexer {
    readonly name = 'BM25Indexer';
    readonly supportedFields = ['text'];
    readonly supportedOperators: QueryOperator[] = ['bm25_match'];
    private readonly columnName = 'text';

    private db: IBM25IndexDB | null = null;
    private readonly _dbPath: string;
    private readonly defaultTopK: number;
    private readonly schema: ColumnSchema;

    constructor(schema: ColumnSchema, dbPath: string, defaultTopK = 10) {
        super();
        this._dbPath = dbPath;
        this.defaultTopK = defaultTopK;
        this.schema = schema;
    }

    async initialize(): Promise<void> {
        if (!this.db) {
            this.db = await createBM25IndexDB(this.schema, this._dbPath);
        }
        await this.db.initialize();
    }

    private ensureDB(): IBM25IndexDB {
        if (!this.db) throw new Error('BM25Indexer not initialized. Call initialize() first.');
        return this.db;
    }

    private validateField(field: string): void {
        const indexers = this.schema.needIndexers?.[field];
        if (!indexers || !indexers.includes(this.name)) {
            throw new Error(
                `BM25Indexer does not support field: ${field}. ` +
                `Field must be listed in schema.needIndexers with BM25Indexer`
            );
        }
    }

    private validateOperator(operator: QueryOperator): void {
        if (!this.supportsOperator(operator)) {
            throw new Error(
                `BM25Indexer does not support operator: ${operator}. ` +
                `Supported operators: ${this.supportedOperators.join(', ')}`
            );
        }
    }

    private resultToItem(result: BM25SearchResult, metadata?: Partial<Item>): Item {
        const item: Item = {
            item_id: result.item_id,
            item_type: result.item_type as ItemType,
            text: result.text,
        };

        if (metadata) {
            for (const [key, value] of Object.entries(metadata)) {
                if (!(key in item) && value !== undefined) {
                    item[key] = value;
                }
            }
        }

        return item;
    }

    private itemToRecord(item: Item, colName: string, newId: string): BM25Record {
        const col = item.indexer_columns?.[this.name]?.find((c) => c.column === colName);
        const text = (col?.content as string) ?? '';

        return {
            bm25_id: newId,
            item_id: item.item_id,
            item_type: colName,
            text,
        };
    }

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
        const results = await this.ensureDB().search(bm25Query.query, {
            columnName: condition.field,
            topK: topK * 2,
        });

        if (results.length === 0) {
            return { items: [], totalCount: 0 };
        }

        const existingIds = options?.existingResults
            ? new Set(options.existingResults.map((r) => r.item_id))
            : null;

        const existingMap = new Map(options?.existingResults?.map((i) => [i.item_id, i]));

        const items: Item[] = [];
        const scores = new Map<string, number>();

        for (const result of results) {
            if (existingIds && !existingIds.has(result.item_id)) {
                continue;
            }

            const item = this.resultToItem(result, existingMap.get(result.item_id));
            items.push(item);
            scores.set(result.item_id, result.score);

            if (items.length >= topK) break;
        }

        let finalItems = items;
        if (options?.offset !== undefined) {
            finalItems = finalItems.slice(options.offset);
        }

        if (options?.limit !== undefined && options.limit < finalItems.length) {
            finalItems = finalItems.slice(0, options.limit);
        }

        return {
            items: finalItems,
            totalCount: finalItems.length,
            scores,
        };
    }

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

                records.push(this.itemToRecord(item, columnName, randomUUID()));
            }
        }

        if (records.length > 0) {
            await this.ensureDB().insert(records);
        }
    }

    async delete(itemIds: string[]): Promise<void> {
        await this.ensureDB().delete(itemIds);
    }

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

                records.push(this.itemToRecord(item, columnName, randomUUID()));
            }
        }

        if (records.length > 0) {
            await this.ensureDB().update(records);
        }
    }

    close(): void {
        this.db?.close();
    }

    async flush(): Promise<void> {
        await this.ensureDB().flush();
    }

    getDB(): IBM25IndexDB {
        return this.ensureDB();
    }

    async deleteAll(): Promise<void> {
        await this.ensureDB().deleteAll();
    }
}

export function createBM25Indexer(schema: ColumnSchema, dbPath: string, defaultTopK = 10): BM25Indexer {
    return new BM25Indexer(schema, dbPath, defaultTopK);
}

export default BM25Indexer;
