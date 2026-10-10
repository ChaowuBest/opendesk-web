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
import { createBM25IndexDB } from './bm25-index-db-factory.js';

export interface BM25Record {
    bm25_id: string;
    item_id: string;
    item_type: string;
    text: string;
}

export interface BM25SearchResult {
    item_id: string;
    item_type: string;
    text: string;
    score: number;
}

export interface BM25SearchOptions {
    columnName: string;
    topK?: number;
}

export interface IBM25IndexDB {
    initialize(): Promise<void>;
    search(query: string, options?: BM25SearchOptions): Promise<BM25SearchResult[]>;
    insert(records: BM25Record[]): Promise<void>;
    delete(itemIds: string[]): Promise<void>;
    update(records: BM25Record[]): Promise<void>;
    existingItemIds(ids: string[]): Promise<Set<string>>;
    deleteByKeys(keys: Array<{ item_id: string; item_type: string }>): Promise<void>;
    close(): void | Promise<void>;
    dropStorage(): Promise<void>;
    clear(): Promise<void>;
    count(): Promise<number>;
}

export class BM25Indexer extends Indexer {
    readonly name = 'BM25Indexer';
    readonly supportedFields = ['text'];
    readonly supportedOperators: QueryOperator[] = ['bm25_match'];
    private readonly columnName = 'text';

    private db: IBM25IndexDB | null = null;
    private readonly _dbPath: string;
    private readonly defaultTopK: number;
    private readonly schema: ColumnSchema;
    private isDropped = false;
    private closingPromise: Promise<void> | null = null;

    constructor(schema: ColumnSchema, dbPath: string, defaultTopK = 10) {
        super();
        this._dbPath = dbPath;
        this.defaultTopK = defaultTopK;
        this.schema = schema;
    }

    async initialize(): Promise<void> {
        if (this.isDropped) {
            throw new Error('BM25Indexer storage has been dropped. Construct a new BM25Indexer.');
        }
        if (!this.db) {
            this.db = await createBM25IndexDB(this.schema, this._dbPath);
        }
        await this.db.initialize();
    }

    private ensureDB(): IBM25IndexDB {
        if (this.isDropped) {
            throw new Error('BM25Indexer storage has been dropped. Construct a new BM25Indexer.');
        }
        if (!this.db) throw new Error('BM25Indexer not initialized. Call initialize() first.');
        return this.db;
    }

    private validateField(field: string): void {
        const indexers = this.schema.needIndexers?.[field];
        if (!indexers || !indexers.some((b) => b.indexer === this.name)) {
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
        const item = {
            item_id: result.item_id,
            item_type: result.item_type as ItemType,
            text: result.text
        } as Item;

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

    private buildRecords(items: Item[]): BM25Record[] {
        const records: BM25Record[] = [];
        for (const item of items) {
            const columns = item.indexer_columns?.[this.name] as Array<{ column: string; content: string }> | undefined;
            if (!columns || columns.length === 0) continue;
            for (const col of columns) {
                if (typeof col.content !== 'string') {
                    throw new Error(`[BM25Indexer] Item ${item.item_id} column ${col.column}: text must be string`);
                }
                records.push(this.itemToRecord(item, col.column, `${item.item_id}_${col.column}`));
            }
        }
        return records;
    }

    private itemToRecord(item: Item, colName: string, newId: string): BM25Record {
        const col = item.indexer_columns?.[this.name]?.find((c) => c.column === colName);
        const text = (col?.content as string) ?? '';

        return {
            bm25_id: newId,
            item_id: item.item_id,
            item_type: colName,
            text
        };
    }

    async search(conditions: FilterCondition[], options?: IndexerSearchOptions): Promise<IndexerSearchResult> {
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
            topK: topK * 2
        });

        if (results.length === 0) {
            return { items: [], totalCount: 0 };
        }

        const existingIds = options?.existingResults ? new Set(options.existingResults.map((r) => r.item_id)) : null;

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
            scores
        };
    }

    async insert(items: Item[]): Promise<void> {
        if (items.length === 0) return;
        const db = this.ensureDB();
        const existingIds = await db.existingItemIds(items.map((i) => i.item_id));
        const newItems = items.filter((i) => !existingIds.has(i.item_id));
        const records = this.buildRecords(newItems);
        if (records.length > 0) await db.insert(records);
    }

    async delete(itemIds: string[]): Promise<void> {
        await this.ensureDB().delete(itemIds);
    }

    async update(items: Item[]): Promise<void> {
        if (items.length === 0) return;
        const db = this.ensureDB();
        const existingIds = await db.existingItemIds(items.map((i) => i.item_id));
        const toUpdate = items.filter((i) => existingIds.has(i.item_id));
        const records = this.buildRecords(toUpdate);
        if (records.length > 0) await db.update(records);
    }

    async upsert(items: Item[]): Promise<void> {
        if (items.length === 0) return;
        const db = this.ensureDB();
        const records = this.buildRecords(items);
        await db.deleteByKeys(records.map((record) => ({ item_id: record.item_id, item_type: record.item_type })));
        if (records.length > 0) await db.insert(records);
    }

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
        await db.dropStorage();
        await db.close();
        if (this.db === db) this.db = null;
        this.isDropped = true;
    }

    async clear(): Promise<void> {
        await this.ensureDB().clear();
    }

    async getInfo(): Promise<Record<string, any>> {
        const size = await this.ensureDB().count();
        return { size };
    }
}

export function createBM25Indexer(schema: ColumnSchema, dbPath: string, defaultTopK = 10): BM25Indexer {
    return new BM25Indexer(schema, dbPath, defaultTopK);
}

export default BM25Indexer;
