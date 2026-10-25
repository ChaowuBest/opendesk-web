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
 * BM25IndexDB - 非鸿蒙平台：search-index + @node-rs/jieba
 * BM25IndexDBHm - 鸿蒙平台：SQLite FTS5 + 自编译 jieba addon（见 bm25-index-db-hm.ts）
 */

import { createRequire } from 'module';
import { Mutex } from 'async-mutex';
import { once } from 'node:events';
import { ColumnSchema } from './abstract-storage.js';
import path from 'path';
import fs from 'fs';
import type { BM25Record, BM25SearchResult, BM25SearchOptions, IBM25IndexDB } from './bm25-indexer.js';
import { removePathIfExists } from './drop-utils.js';

const require = createRequire(import.meta.url);

type JiebaLike = {
    cut: (text: string) => string[];
};

let jieba: JiebaLike | null = null;

function getJieba(): JiebaLike {
    if (jieba) return jieba;

    if ((process.platform as string) === 'openharmony') {
        throw new Error('BM25IndexDB(non-HM) should not load @node-rs/jieba on openharmony');
    }

    const { Jieba } = require('@node-rs/jieba') as {
        Jieba: { withDict: (dictData: unknown) => JiebaLike };
    };
    const { dict } = require('@node-rs/jieba/dict') as { dict: unknown };
    jieba = Jieba.withDict(dict);
    return jieba;
}

export class BM25IndexDB implements IBM25IndexDB {
    private si: Record<string, any> | null = null;
    private initializationPromise: Promise<void> | null = null;
    private closingPromise: Promise<void> | null = null;
    private initialized = false;
    private closeRequested = false;
    private readonly dbPath: string;
    private readonly schema: ColumnSchema;
    private readonly mutex = new Mutex();
    private readonly knownItemIds = new Set<string>();
    private readonly documents = new Map<
        string,
        Map<string, { item_id: string; item_type: string; text: string; tokens: string[] }>
    >();

    constructor(schema: ColumnSchema, dbPath: string) {
        this.dbPath = dbPath;
        this.schema = schema;
    }

    async initialize(): Promise<void> {
        this.ensureUsable();
        if (this.initialized) return;
        const initialization = this.initializationPromise ?? this.initializeStores();
        this.initializationPromise = initialization;
        try {
            await initialization;
            this.ensureUsable();
            this.initialized = true;
        } finally {
            if (this.initializationPromise === initialization) this.initializationPromise = null;
        }
    }

    private async initializeStores(): Promise<void> {
        const dir = path.dirname(this.dbPath);
        fs.mkdirSync(dir, { recursive: true });
        const si = await import('search-index');
        const SearchIndexCtor = (si as any).SearchIndex as any;
        this.si ??= {};
        for (const [columnName, indexers] of Object.entries(this.schema.needIndexers)) {
            this.ensureUsable();
            if (!indexers.some((b) => b.indexer === 'BM25Indexer') || this.documents.has(columnName)) continue;
            let index = this.si[columnName];
            let ready: Promise<unknown> | undefined;
            if (!index) {
                index = new SearchIndexCtor({ name: `${this.dbPath}-${columnName}`, skipFields: ['raw_text'] });
                this.si[columnName] = index;
                // Attach before awaiting: closing also waits for LevelDB setup.
                ready = once(index.EVENTS, 'ready');
            }
            await Promise.all([index.VERSION_VALIDATED, index.INDEX.STORE.open(), ready]);
            this.ensureUsable();
            // Search and update use these caches, not search-index's token index.
            // A failed read leaves this column eligible for initialization retry.
            const documents = new Map<string, { item_id: string; item_type: string; text: string; tokens: string[] }>();
            for (const { _id, _doc: doc } of await index.ALL_DOCUMENTS()) {
                if (
                    typeof _id !== 'string' ||
                    typeof doc?.item_id !== 'string' ||
                    typeof doc?.item_type !== 'string' ||
                    typeof doc?.text !== 'string'
                ) {
                    throw new Error(`Invalid persisted BM25 document in column: ${columnName}`);
                }
                const hasRawText = typeof doc.raw_text === 'string';
                documents.set(_id, {
                    item_id: doc.item_id,
                    item_type: doc.item_type,
                    text: hasRawText ? doc.raw_text : doc.text,
                    // Old documents only retain the already normalized tokens.
                    // Their original punctuation/spacing cannot be reconstructed.
                    tokens: hasRawText ? this.tokenize(doc.raw_text) : doc.text.split(' ').filter(Boolean)
                });
            }
            this.documents.set(columnName, documents);
            for (const doc of documents.values()) this.knownItemIds.add(doc.item_id);
            console.info(
                `[BM25IndexDB] Initializing BM25 index for column: ${columnName}, dbPath: ${this.dbPath}-${columnName}`
            );
        }
    }

    private ensureUsable(): void {
        if (this.closeRequested) throw new Error('BM25IndexDB is closing or closed');
    }

    tokenize(text: string): string[] {
        if (!text) return [];

        return getJieba()
            .cut(text)
            .map((t) => t.toLowerCase())
            .filter((t) => t.trim().length > 0);
    }

    async search(query: string, options?: BM25SearchOptions): Promise<BM25SearchResult[]> {
        this.ensureUsable();
        if (!this.si) return [];
        if (!options?.columnName || !(options.columnName in this.schema.needIndexers)) return [];

        return this.mutex.runExclusive(async () => {
            const tokens = this.tokenize(query);
            if (tokens.length === 0) return [];

            const topK = options?.topK ?? 10;
            const queryTokens = tokens;

            const docs = [...(this.documents.get(options.columnName)?.values() ?? [])];
            const searchResults = docs
                .map((doc) => {
                    const hitCount = queryTokens.filter((token) => doc.tokens.includes(token)).length;
                    return {
                        item_id: doc.item_id,
                        item_type: doc.item_type,
                        text: doc.text,
                        score: hitCount
                    };
                })
                .filter((doc) => doc.score > 0)
                .sort((a, b) => b.score - a.score || a.item_id.localeCompare(b.item_id))
                .slice(0, topK);
            return searchResults;
        });
    }

    async insert(records: BM25Record[]): Promise<void> {
        this.ensureUsable();
        if (records.length === 0 || !this.si) return;

        await this.mutex.runExclusive(async () => {
            const byType = new Map<string, BM25Record[]>();
            for (const record of records) {
                const list = byType.get(record.item_type) ?? [];
                list.push(record);
                byType.set(record.item_type, list);
            }

            for (const [itemType, list] of byType) {
                const index = this.si![itemType];
                if (!index) continue;

                const docs = list.map((record) => ({
                    _id: record.bm25_id,
                    item_id: record.item_id,
                    item_type: record.item_type,
                    text: this.tokenize(record.text).join(' '),
                    raw_text: record.text
                }));
                await index.PUT(docs);
                for (const record of list) {
                    this.knownItemIds.add(record.item_id);
                    this.documents.get(itemType)?.set(record.bm25_id, {
                        item_id: record.item_id,
                        item_type: record.item_type,
                        text: record.text,
                        tokens: this.tokenize(record.text)
                    });
                }
            }
        });
    }

    async delete(itemIds: string[]): Promise<void> {
        this.ensureUsable();
        if (itemIds.length === 0 || !this.si) return;

        await this.mutex.runExclusive(async () => {
            const ids = new Set(itemIds);
            for (const [column, index] of Object.entries(this.si!)) {
                const documents = this.documents.get(column)!;
                const docIds = [...documents].filter(([, doc]) => ids.has(doc.item_id)).map(([id]) => id);
                // Exact restored identities also cover IDs containing query syntax.
                for (let start = 0; start < docIds.length; start += 500) {
                    const batch = docIds.slice(start, start + 500);
                    await index.DELETE(...batch);
                    for (const id of batch) documents.delete(id);
                }
            }
            for (const itemId of itemIds) {
                this.knownItemIds.delete(itemId);
            }
        });
    }

    async update(records: BM25Record[]): Promise<void> {
        this.ensureUsable();
        if (records.length === 0 || !this.si) return;

        await this.mutex.runExclusive(async () => {
            const byType = new Map<string, BM25Record[]>();
            for (const record of records) {
                const list = byType.get(record.item_type) ?? [];
                list.push(record);
                byType.set(record.item_type, list);
            }

            for (const [itemType, list] of byType) {
                const index = this.si![itemType];
                if (!index) continue;

                const docs = list.map((record) => ({
                    _id: record.bm25_id,
                    item_id: record.item_id,
                    item_type: record.item_type,
                    text: this.tokenize(record.text).join(' '),
                    raw_text: record.text
                }));
                await index.PUT(docs);
                for (const record of list) {
                    this.knownItemIds.add(record.item_id);
                    this.documents.get(itemType)?.set(record.bm25_id, {
                        item_id: record.item_id,
                        item_type: record.item_type,
                        text: record.text,
                        tokens: this.tokenize(record.text)
                    });
                }
            }
        });
    }

    async existingItemIds(ids: string[]): Promise<Set<string>> {
        this.ensureUsable();
        return new Set(ids.filter((id) => this.knownItemIds.has(id)));
    }

    async deleteByKeys(keys: Array<{ item_id: string; item_type: string }>): Promise<void> {
        this.ensureUsable();
        if (keys.length === 0 || !this.si) return;
        await this.mutex.runExclusive(async () => {
            for (const key of keys) {
                const index = this.si![key.item_type];
                if (!index) continue;
                await index.DELETE(`${key.item_id}_${key.item_type}`);
                this.documents.get(key.item_type)?.delete(`${key.item_id}_${key.item_type}`);
            }
        });
    }

    close(): Promise<void> {
        this.closeRequested = true;
        if (this.closingPromise) return this.closingPromise;
        const initialization = this.initializationPromise;
        const closing = (async () => {
            if (initialization) await initialization.catch(() => {});
            await this.mutex.runExclusive(async () => {
                // 先取一次 si 快照：下方 delete 会改写同一个对象，
                // 快照只用于让类型收窄（this.si 可能在关闭过程中被置为 null）
                const stores = this.si;
                const entries = Object.entries(stores ?? {});
                const results = await Promise.allSettled(
                    entries.map(async ([column, index]) => {
                        // search-index FLUSH clears data; awaited writes already commit
                        // through LevelDB. Ordinary release closes the actual store.
                        await index.INDEX.STORE.close();
                        if (stores && stores[column] === index) delete stores[column];
                    })
                );
                const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
                if (failed) throw failed.reason;
                this.si = null;
                this.initialized = false;
            });
        })().finally(() => {
            if (this.closingPromise === closing) this.closingPromise = null;
        });
        this.closingPromise = closing;
        return closing;
    }

    async dropStorage(): Promise<void> {
        await this.close();
        for (const columnName of Object.keys(this.schema.needIndexers)) {
            if (!this.schema.needIndexers[columnName].some((binding) => binding.indexer === 'BM25Indexer')) continue;
            removePathIfExists(`${this.dbPath}-${columnName}`);
        }
        removePathIfExists(this.dbPath);
        this.knownItemIds.clear();
        for (const docs of this.documents.values()) docs.clear();
    }

    async clear(): Promise<void> {
        this.ensureUsable();
        if (!this.si) return;
        await this.mutex.runExclusive(async () => {
            for (const index of Object.values(this.si!)) await index.DELETE_ALL();
            this.knownItemIds.clear();
            for (const docs of this.documents.values()) docs.clear();
        });
    }

    async count(): Promise<number> {
        this.ensureUsable();
        if (!this.si) return 0;
        return this.mutex.runExclusive(async () => {
            let total = 0;
            for (const index of Object.values(this.si!)) total += await index.DOCUMENT_COUNT();
            return total;
        });
    }
}

export default BM25IndexDB;
