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
            if (!indexers.includes('BM25Indexer')) continue;
            this.si[columnName] = await new SearchIndexCtor({
                name: `${this.dbPath}-${columnName}`
            });
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
            const queryTokens = tokens.map((token) => `text:${token}`);

            try {
                const index = this.si![options.columnName]!;
                const results = await index.SEARCH(queryTokens, {
                    SCORE: { TYPE: 'TFIDF' },
                    PAGE: { SIZE: topK * 2 }
                });

                const allDocs = await index.ALL_DOCUMENTS();
                const docsMap = new Map<string, any>(allDocs.map((d: any) => [d._id, d._doc]));

                const searchResults: BM25SearchResult[] = [];
                for (const result of results.RESULT) {
                    const doc = docsMap.get(result._id);
                    if (!doc) continue;

                    searchResults.push({
                        item_id: doc.item_id,
                        item_type: doc.item_type ?? 'file',
                        text: Array.isArray(doc.text) ? doc.text.join(' ') : doc.text,
                        score: result._score ?? 0
                    });
                }

                return searchResults;
            } catch {
                return [];
            }
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
            }
        });
    }

    async delete(itemIds: string[]): Promise<void> {
        if (itemIds.length === 0 || !this.si) return;

        await this.mutex.runExclusive(async () => {
            for (const index of Object.values(this.si!)) {
                for (const itemId of itemIds) {
                    try {
                        const results = await index.SEARCH([`item_id:${itemId}`], {
                            PAGE: { SIZE: 100 }
                        });
                        if (results.RESULT && results.RESULT.length > 0) {
                            const docIds = results.RESULT.map((r: any) => r._id);
                            await index.DELETE(...docIds);
                        }
                    } catch {
                        // ignore delete errors
                    }
                }
            }
        });
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
            }
        });
    }

    async flush(): Promise<void> {
        if (!this.si) return;

        for (const index of Object.values(this.si)) {
            await index.FLUSH();
        }
    }

    close(): void {
        if (!this.si) return;

        const si = this.si;
        this.si = null;
        for (const index of Object.values(si)) {
            index.FLUSH().catch(() => {});
        }
    }

    async deleteAll(): Promise<void> {
        if (!this.si) return;

        for (const index of Object.values(this.si)) {
            await index.DELETE_ALL();
        }
    }
}

/**
 * 工厂函数：根据当前平台自动选择 BM25 实现
 */
export async function createBM25IndexDB(schema: ColumnSchema, dbPath: string): Promise<IBM25IndexDB> {
    if ((process.platform as string) === 'openharmony') {
        const { BM25IndexDBHm } = await import('./bm25-index-db-hm.js');
        return new BM25IndexDBHm(schema, dbPath);
    }
    return new BM25IndexDB(schema, dbPath);
}

export default BM25IndexDB;
