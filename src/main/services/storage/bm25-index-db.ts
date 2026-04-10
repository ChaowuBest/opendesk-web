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
import { ColumnSchema } from './abstract-storage.js';
import path from 'path';
import fs from 'fs';
import type { BM25Record, BM25SearchResult, BM25SearchOptions, IBM25IndexDB } from './bm25-indexer.js';

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
        if (this.si) return;

        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const si = await import('search-index');
        const SearchIndexCtor = (si as any).SearchIndex as any;
        this.si = {};

        for (const [columnName, indexers] of Object.entries(this.schema.needIndexers)) {
            if (!indexers.some((b) => b.indexer === 'BM25Indexer')) continue;
            this.si[columnName] = await new SearchIndexCtor({
                name: `${this.dbPath}-${columnName}`
            });
            this.documents.set(columnName, new Map());
            console.info(
                `[BM25IndexDB] Initializing BM25 index for column: ${columnName}, dbPath: ${this.dbPath}-${columnName}`
            );
        }
    }

    tokenize(text: string): string[] {
        if (!text) return [];

        return getJieba()
            .cut(text)
            .map((t) => t.toLowerCase())
            .filter((t) => t.trim().length > 0);
    }

    async search(query: string, options?: BM25SearchOptions): Promise<BM25SearchResult[]> {
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
                .sort((a, b) => b.score - a.score)
                .slice(0, topK);
            return searchResults;
        });
    }

    async insert(records: BM25Record[]): Promise<void> {
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
                    text: this.tokenize(record.text).join(' ')
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
        await this.flush();
    }

    async delete(itemIds: string[]): Promise<void> {
        if (itemIds.length === 0 || !this.si) return;

        await this.mutex.runExclusive(async () => {
            for (const index of Object.values(this.si!)) {
                for (const itemId of itemIds) {
                    const results = await index.SEARCH([`item_id:${itemId}`], { PAGE: { SIZE: 100 } });
                    if (results.RESULT && results.RESULT.length > 0) {
                        const docIds = results.RESULT.map((r: any) => r._id);
                        await index.DELETE(...docIds);
                    }
                }
            }
            for (const itemId of itemIds) {
                this.knownItemIds.delete(itemId);
                for (const docs of this.documents.values()) {
                    for (const [docId, doc] of docs.entries()) {
                        if (doc.item_id === itemId) docs.delete(docId);
                    }
                }
            }
        });
        await this.flush();
    }

    async update(records: BM25Record[]): Promise<void> {
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
                    text: this.tokenize(record.text).join(' ')
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
        await this.flush();
    }

    private async flush(): Promise<void> {
        if (!this.si) return;

        for (const index of Object.values(this.si)) {
            await index.FLUSH();
        }
    }

    async existingItemIds(ids: string[]): Promise<Set<string>> {
        return new Set(ids.filter((id) => this.knownItemIds.has(id)));
    }

    async deleteByKeys(keys: Array<{ item_id: string; item_type: string }>): Promise<void> {
        if (keys.length === 0 || !this.si) return;
        await this.mutex.runExclusive(async () => {
            for (const key of keys) {
                const index = this.si![key.item_type];
                if (!index) continue;
                await index.DELETE(`${key.item_id}_${key.item_type}`);
                this.documents.get(key.item_type)?.delete(`${key.item_id}_${key.item_type}`);
            }
        });
        await this.flush();
    }

    close(): void {
        if (!this.si) return;

        const si = this.si;
        this.si = null;
        for (const index of Object.values(si)) {
            index.FLUSH().catch((e: any) => console.warn('[BM25IndexDB] FLUSH failed on close:', e?.message));
        }
    }

    async clear(): Promise<void> {
        if (!this.si) return;

        for (const index of Object.values(this.si)) {
            await index.DELETE_ALL();
        }
        this.knownItemIds.clear();
        for (const docs of this.documents.values()) docs.clear();
    }

    async count(): Promise<number> {
        if (!this.si) return 0;
        let total = 0;
        for (const index of Object.values(this.si)) {
            total += await (index as any).DOCUMENT_COUNT();
        }
        return total;
    }
}

export default BM25IndexDB;
