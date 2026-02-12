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
 * BM25IndexDB - 基于 search-index + nodejieba 的全文搜索数据库
 *
 * 封装 search-index 库的低阶操作，提供分词和 CRUD 功能。
 * 由 BM25Indexer 包装使用。
 */

// @ts-ignore - search-index 没有类型声明
import { SearchIndex } from 'search-index';
import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict';
import { Mutex } from 'async-mutex';
import { ColumnSchema } from './abstract-storage';
import path from 'path';
import fs from 'fs';

const jieba = Jieba.withDict(dict);

/**
 * 存储记录
 */
export interface BM25Record {
    bm25_id: string;
    item_id: string;
    item_type: string;
    text: string;
}

/**
 * 搜索结果
 */
export interface BM25SearchResult {
    item_id: string;
    item_type: string;
    text: string;
    score: number;
}

/**
 * 搜索选项
 */
export interface BM25SearchOptions {
    columnName: string;
    topK?: number;
}

/**
 * BM25 全文搜索数据库
 */
export class BM25IndexDB {
    private si: any = null;
    private dbPath: string;
    private schema: ColumnSchema;
    private mutex = new Mutex();

    constructor(schema: ColumnSchema, dbPath: string) {
        this.dbPath = dbPath;
        this.schema = schema;
    }

    /**
     * 初始化数据库
     */
    async initialize(): Promise<void> {
        if (this.si) return;

        // 确保目录存在
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // 创建 search-index 实例
        // @ts-ignore - search-index 没有类型声明
        const si = await import('search-index');
        const SearchIndexCtor = (si as any).SearchIndex as any;
        this.si = {};
        for (const [columnName, indexers] of Object.entries(this.schema.needIndexers)) {
            if (!indexers.includes('BM25Indexer')) continue;
            this.si[columnName] = await new SearchIndexCtor({
                name: `${this.dbPath}-${columnName}`,
            // 打印日志
            });
            console.info(`[BM25IndexDB] Initializing BM25 index for column: ${columnName}, dbPath: ${this.dbPath}-${columnName}`);
        }
    }

    /**
     * 使用 nodejieba 统一分词（支持中英文混合）
     */
    tokenize(text: string): string[] {
        if (!text) return [];

        // 使用 nodejieba 对整个文本进行分词
        const tokens = jieba.cut(text);

        // 过滤空白 token，并将所有 token 转为小写（提高英文匹配率）
        return tokens
            .map(t => t.toLowerCase())
            .filter(t => t.trim().length > 0);
    }

    /**
     * 搜索
     */
    async search(query: string, options?: BM25SearchOptions): Promise<BM25SearchResult[]> {
        if (!this.si) {
            // console.warn('[BM25IndexDB] search skipped: index not initialized');
            return [];
        }
        if (options?.columnName == undefined ||
            !(options?.columnName in this.schema.needIndexers)) {
            // console.warn(`[BM25IndexDB] search skipped: invalid columnName "${options?.columnName}"`);
            return [];
        }

        return await this.mutex.runExclusive(async () => {
            const tokens = this.tokenize(query);
            if (tokens.length === 0) {
                // console.warn('[BM25IndexDB] search skipped: empty tokens');
                return [];
            }

            const topK = options?.topK ?? 10;
            const queryTokens = tokens.map(token => `text:${token}`);

            try {
                const index = this.si[options?.columnName]!;
                // console.log(`[BM25IndexDB] search start: column=${options?.columnName}, topK=${topK}, tokens=${tokens.length}`);
                const results = await index.SEARCH(queryTokens, {
                    SCORE: { TYPE: 'TFIDF' },
                    PAGE: { SIZE: topK * 2 }
                });

                // 获取所有文档用于查找
                const allDocs = await index.ALL_DOCUMENTS();
                // console.log(`[BM25IndexDB] search results: hits=${results.RESULT?.length ?? 0}, docs=${allDocs.length}`);
                const docsMap = new Map<string, any>(allDocs.map((d: any) => [d._id, d._doc]));

                const searchResults: BM25SearchResult[] = [];

                for (const result of results.RESULT) {
                    const doc = docsMap.get(result._id);
                    if (!doc) continue;

                    searchResults.push({
                        item_id: doc.item_id,
                        // item_id: result._id,
                        item_type: doc.item_type ?? 'file',
                        text: Array.isArray(doc.text) ? doc.text.join(' ') : doc.text,
                        score: result._score ?? 0,
                    });
                }

                // console.log(`[BM25IndexDB] search mapped results: ${searchResults.length}`);
                return searchResults;
            } catch (error) {
                // 查询无结果时可能抛出异常
                // console.warn('[BM25IndexDB] search failed', error);
                return [];
            }
        });
    }

    /**
     * 插入记录
     */
    async insert(records: BM25Record[]): Promise<void> {
        if (records.length === 0 || !this.si) return;

        await this.mutex.runExclusive(async () => {
            const byType = new Map<string, BM25Record[]>();
            for (const record of records) {
                let list = byType.get(record.item_type);
                if (!list) {
                    list = [];
                    byType.set(record.item_type, list);
                }
                list.push(record);
            }

            for (const [itemType, list] of byType) {
                const index = (this.si as Record<string, any>)[itemType];
                if (!index) {
                    // console.warn(`[BM25IndexDB] Missing index for item_type: ${itemType}, skipped ${list.length} records`);
                    continue;
                }
                const docs = list.map(record => ({
                    _id: record.bm25_id,
                    item_id: record.item_id,
                    item_type: record.item_type,
                    text: this.tokenize(record.text).join(' '),
                }));
                await index.PUT(docs);
                // console.log(`[BM25IndexDB] Inserted ${docs.length} docs into index: ${itemType}`);
            }
        });
    }

    /**
     * 删除记录
     * 遍历所有索引，按 item_id 查找并删除对应文档
     */
    async delete(itemIds: string[]): Promise<void> {
        if (itemIds.length === 0 || !this.si) return;

        await this.mutex.runExclusive(async () => {
            for (const index of Object.values(this.si as Record<string, any>)) {
                for (const itemId of itemIds) {
                    try {
                        // 查找 item_id 对应的文档
                        const results = await index.SEARCH([`item_id:${itemId}`], { PAGE: { SIZE: 100 } });
                        if (results.RESULT && results.RESULT.length > 0) {
                            const docIds = results.RESULT.map((r: any) => r._id);
                            await index.DELETE(...docIds);
                        }
                    } catch {
                        // 忽略删除错误
                    }
                }
            }
        });
    }

    /**
     * 更新记录（upsert）
     */
    async update(records: BM25Record[]): Promise<void> {
        if (records.length === 0 || !this.si) return;

        await this.mutex.runExclusive(async () => {
            const byType = new Map<string, BM25Record[]>();
            for (const record of records) {
                let list = byType.get(record.item_type);
                if (!list) {
                    list = [];
                    byType.set(record.item_type, list);
                }
                list.push(record);
            }

            for (const [itemType, list] of byType) {
                const index = (this.si as Record<string, any>)[itemType];
                if (!index) continue;
                const docs = list.map(record => ({
                    _id: record.bm25_id,
                    item_id: record.item_id,
                    item_type: record.item_type,
                    text: this.tokenize(record.text).join(' '),
                }));
                await index.PUT(docs);
            }
        });
    }

    /**
     * 刷新索引到磁盘
     */
    async flush(): Promise<void> {
        if (this.si) {
            await this.si.FLUSH();
        }
    }

    /**
     * 关闭数据库
     */
    close(): void {
        if (this.si) {
            const si = this.si;
            this.si = null;
            for (const index of Object.values(si as Record<string, any>)) {
                index.FLUSH().catch(() => {});
            }
        }
    }

    /**
     * 删除所有数据库内容
     */
    async deleteAll(): Promise<void> {
        if (this.si) {
            for (const index of Object.values(this.si as Record<string, any>)) {
                await index.DELETE_ALL();
            }
        }
    }
}

export default BM25IndexDB;
