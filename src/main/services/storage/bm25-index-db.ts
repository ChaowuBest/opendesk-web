/**
 * BM25IndexDB - 基于 search-index + nodejieba 的全文搜索数据库
 *
 * 封装 search-index 库的低阶操作，提供分词和 CRUD 功能。
 * 由 BM25Indexer 包装使用。
 */

// @ts-ignore - search-index 没有类型声明
import { SearchIndex } from 'search-index';
import nodejieba from 'nodejieba';
import { Mutex } from 'async-mutex';
import path from 'path';
import fs from 'fs';

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
    private si: SearchIndex | null = null;
    private dbPath: string;
    private mutex = new Mutex();

    constructor(dbPath: string) {
        this.dbPath = dbPath;
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
        this.si = await new si.SearchIndex({
            name: this.dbPath,
        });
    }

    /**
     * 使用 nodejieba 统一分词（支持中英文混合）
     */
    tokenize(text: string): string[] {
        if (!text) return [];

        // 使用 nodejieba 对整个文本进行分词
        const tokens = nodejieba.cutForSearch(text);

        // 过滤空白 token，并将所有 token 转为小写（提高英文匹配率）
        return tokens
            .map(t => t.toLowerCase())
            .filter(t => t.trim().length > 0);
    }

    /**
     * 搜索
     */
    async search(query: string, options?: BM25SearchOptions): Promise<BM25SearchResult[]> {
        if (!this.si) return [];

        return await this.mutex.runExclusive(async () => {
            const tokens = this.tokenize(query);
            if (tokens.length === 0) return [];

            const topK = options?.topK ?? 10;
            const queryTokens = tokens.map(token => `text:${token}`);

            try {
                const results = await this.si!.SEARCH(queryTokens, {
                    SCORE: { TYPE: 'TFIDF' },
                    PAGE: { SIZE: topK * 2 }
                });

                // 获取所有文档用于查找
                const allDocs = await this.si!.ALL_DOCUMENTS();
                const docsMap = new Map<string, any>(allDocs.map((d: any) => [d._id, d._doc]));

                const searchResults: BM25SearchResult[] = [];

                for (const result of results.RESULT) {
                    const doc = docsMap.get(result._id);
                    if (!doc) continue;

                    searchResults.push({
                        item_id: result._id,
                        item_type: doc.item_type ?? 'file',
                        text: Array.isArray(doc.text) ? doc.text.join(' ') : doc.text,
                        score: result._score ?? 0,
                    });
                }

                return searchResults;
            } catch (error) {
                // 查询无结果时可能抛出异常
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
            const docs = records.map(record => ({
                _id: record.item_id,
                item_type: record.item_type,
                text: this.tokenize(record.text),
            }));

            await this.si!.PUT(docs);
        });
    }

    /**
     * 删除记录
     */
    async delete(itemIds: string[]): Promise<void> {
        if (itemIds.length === 0 || !this.si) return;

        await this.mutex.runExclusive(async () => {
            await this.si!.DELETE(...itemIds);
        });
    }

    /**
     * 更新记录（upsert）
     */
    async update(records: BM25Record[]): Promise<void> {
        if (records.length === 0 || !this.si) return;

        await this.mutex.runExclusive(async () => {
            const docs = records.map(record => ({
                _id: record.item_id,
                item_type: record.item_type,
                text: this.tokenize(record.text),
            }));

            await this.si!.PUT(docs);
        });
    }

    /**
     * 获取所有文档
     */
    async getAllDocuments(): Promise<Map<string, any>> {
        if (!this.si) return new Map();

        const allDocs = await this.si.ALL_DOCUMENTS();
        return new Map<string, any>(allDocs.map((d: any) => [d._id, d._doc]));
    }

    /**
     * 获取文档数量
     */
    async getDocumentCount(): Promise<number> {
        if (!this.si) return 0;
        try {
            const allDocs = await this.si.ALL_DOCUMENTS();
            return allDocs.length;
        } catch {
            return 0;
        }
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
            si.FLUSH().catch(() => {});
        }
    }
}

export default BM25IndexDB;
