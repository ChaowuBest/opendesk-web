/**
 * BM25Indexer - BM25 全文搜索索引器
 *
 * 包装 BM25IndexDB 和 LangChain BM25Retriever 实现 Indexer 接口。
 *
 * 设计要点：
 * 1. 启动时从 SQLite 加载所有文档重建 BM25 内存索引
 * 2. 使用读写锁保证并发安全（保护内存中的 BM25 索引）
 * 3. 增量更新时重建整个 BM25 索引（LangChain BM25 限制）
 *
 * 特性：
 * - SQLite 持久化存储
 * - LangChain BM25 内存索引
 * - 读写锁并发控制
 * - 支持与其他 Indexer 的 join 操作
 */

import { Indexer, IndexerSearchOptions, IndexerSearchResult } from './indexer.js';
import { Item, FilterCondition, QueryOperator } from './object.js';
import { BM25IndexDB, BM25IndexRecord } from './bm25-index-db.js';
import { BM25Retriever } from '@langchain/community/retrievers/bm25';
import { Document } from '@langchain/core/documents';

// ============================================================================
// BM25Indexer 类
// ============================================================================

/**
 * BM25Indexer 配置选项
 */
export interface BM25IndexerOptions {
    /** 默认返回结果数量，默认 10 */
    defaultTopK?: number;
}

class ReadWriteLock {
    private readers = 0;
    private writer = false;
    private writeQueue: Array<() => void> = [];
    private readQueue: Array<() => void> = [];

    async acquireRead(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.writer && this.writeQueue.length === 0) {
                this.readers++;
                resolve();
            } else {
                this.readQueue.push(() => {
                    this.readers++;
                    resolve();
                });
            }
        });
    }

    releaseRead(): void {
        this.readers--;
        this.processQueue();
    }

    async acquireWrite(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.writer && this.readers === 0) {
                this.writer = true;
                resolve();
            } else {
                this.writeQueue.push(() => {
                    this.writer = true;
                    resolve();
                });
            }
        });
    }

    releaseWrite(): void {
        this.writer = false;
        this.processQueue();
    }

    private processQueue(): void {
        if (this.writeQueue.length > 0 && this.readers === 0 && !this.writer) {
            const next = this.writeQueue.shift();
            next?.();
        } else if (this.readQueue.length > 0 && !this.writer && this.writeQueue.length === 0) {
            while (this.readQueue.length > 0) {
                const next = this.readQueue.shift();
                next?.();
            }
        }
    }
}

export class BM25Indexer extends Indexer {
    readonly name = 'BM25Indexer';
    readonly supportedFields = ['text'];
    readonly supportedOperators: QueryOperator[] = ['bm25_match'];

    private db: BM25IndexDB;
    private retriever: BM25Retriever | null = null;
    private documents: Map<string, Document> = new Map();
    private lock = new ReadWriteLock();
    private isInitialized = false;
    private defaultTopK: number;

    constructor(dbPath: string, options?: BM25IndexerOptions) {
        super();
        this.db = new BM25IndexDB(dbPath);
        this.defaultTopK = options?.defaultTopK ?? 10;
    }

    /**
     * 初始化索引器
     * 从 SQLite 加载所有文档并构建 BM25 索引
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) return;

        await this.lock.acquireWrite();
        try {
            await this.rebuildIndex();
            this.isInitialized = true;
        } finally {
            this.lock.releaseWrite();
        }
    }

    /**
     * 重建 BM25 索引
     * 从 SQLite 加载所有文档，创建新的 BM25Retriever
     */
    private async rebuildIndex(): Promise<void> {
        // 从数据库加载所有记录
        const records = this.db.findAll();

        // 清空并重建文档映射
        this.documents.clear();

        const docs: Document[] = [];
        for (const record of records) {
            const doc = new Document({
                pageContent: record.text,
                metadata: {
                    item_id: record.item_id,
                    item_type: record.item_type,
                    tag: record.tag,
                    created_at: record.created_at,
                    updated_at: record.updated_at,
                }
            });
            docs.push(doc);
            this.documents.set(record.item_id, doc);
        }

        // 创建 BM25Retriever
        if (docs.length > 0) {
            this.retriever = BM25Retriever.fromDocuments(docs, { k: this.defaultTopK });
        } else {
            this.retriever = null;
        }
    }

    /**
     * 验证操作符
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
     * 验证字段
     */
    private validateField(field: string): void {
        if (!this.supportsField(field)) {
            throw new Error(
                `BM25Indexer does not support field: ${field}. ` +
                `Supported fields: ${this.supportedFields.join(', ')}`
            );
        }
    }

    /**
     * Document -> Item 转换
     */
    private documentToItem(doc: Document, existingMetadata?: Partial<Item>): Item {
        const metadata = doc.metadata;
        return {
            item_id: metadata.item_id,
            item_type: metadata.item_type,
            tag: existingMetadata?.tag ?? metadata.tag ?? '',
            text: doc.pageContent,
            created_at: existingMetadata?.created_at ?? metadata.created_at ?? 0,
            updated_at: existingMetadata?.updated_at ?? metadata.updated_at ?? 0,
        };
    }

    /**
     * Item -> BM25IndexRecord 转换
     */
    private itemToRecord(item: Item): BM25IndexRecord {
        return {
            item_id: item.item_id,
            item_type: item.item_type,
            tag: item.tag ?? '',
            text: item.text ?? '',
            created_at: item.created_at ?? 0,
            updated_at: item.updated_at ?? 0,
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

        // 获取读锁
        await this.lock.acquireRead();
        try {
            // 只处理第一个 BM25 条件
            const condition = conditions[0];
            this.validateField(condition.field);
            this.validateOperator(condition.operator);

            // 提取 BM25 查询参数
            const bm25Query = condition.value as BM25Query;
            if (!bm25Query || typeof bm25Query.query !== 'string') {
                throw new Error('bm25_match requires a BM25Query value with query string');
            }

            // 如果没有索引或索引为空，返回空结果
            if (!this.retriever || this.documents.size === 0) {
                return { items: [], totalCount: 0 };
            }

            // 设置 topK
            const topK = bm25Query.topK ?? options?.limit ?? this.defaultTopK;
            this.retriever.k = topK;

            // 执行 BM25 搜索
            const results = await this.retriever.invoke(bm25Query.query);

            // 构建 existingResults 的 ID 集合（用于 join 过滤）
            const existingIds = options?.existingResults
                ? new Set(options.existingResults.map(r => r.item_id))
                : null;

            // 构建 existingResults 的元数据映射
            const existingMap = new Map(
                options?.existingResults?.map(i => [i.item_id, i])
            );

            // 过滤和转换结果
            const items: Item[] = [];
            const scores = new Map<string, number>();

            for (let i = 0; i < results.length; i++) {
                const doc = results[i];
                const itemId = doc.metadata.item_id;

                // Join 过滤
                if (existingIds && !existingIds.has(itemId)) {
                    continue;
                }

                // 转换为 Item
                const item = this.documentToItem(doc, existingMap.get(itemId));
                items.push(item);

                // BM25 分数（使用排名作为相对分数，越靠前分数越高）
                scores.set(itemId, 1 - (i / results.length));
            }

            // 应用 offset
            let finalItems = items;
            if (options?.offset !== undefined) {
                finalItems = finalItems.slice(options.offset);
            }

            // 应用 limit（如果与 topK 不同）
            if (options?.limit !== undefined && options.limit < finalItems.length) {
                finalItems = finalItems.slice(0, options.limit);
            }

            return {
                items: finalItems,
                totalCount: finalItems.length,
                scores,
            };
        } finally {
            this.lock.releaseRead();
        }
    }

    /**
     * 插入 Item
     * 插入后需要重建 BM25 索引
     */
    async insert(items: Item[]): Promise<void> {
        if (items.length === 0) return;

        await this.lock.acquireWrite();
        try {
            // 插入到 SQLite
            const records = items.map(item => this.itemToRecord(item));
            this.db.insertMany(records);

            // 重建 BM25 索引
            await this.rebuildIndex();
        } finally {
            this.lock.releaseWrite();
        }
    }

    /**
     * 删除 Item
     * 删除后需要重建 BM25 索引
     */
    async delete(itemIds: string[]): Promise<void> {
        if (itemIds.length === 0) return;

        await this.lock.acquireWrite();
        try {
            // 从 SQLite 删除
            this.db.deleteMany(itemIds);

            // 重建 BM25 索引
            await this.rebuildIndex();
        } finally {
            this.lock.releaseWrite();
        }
    }

    /**
     * 更新 Item
     * 更新后需要重建 BM25 索引
     */
    async update(items: Item[]): Promise<void> {
        if (items.length === 0) return;

        await this.lock.acquireWrite();
        try {
            // 更新 SQLite
            for (const item of items) {
                this.db.upsert(this.itemToRecord(item));
            }

            // 重建 BM25 索引
            await this.rebuildIndex();
        } finally {
            this.lock.releaseWrite();
        }
    }

    /**
     * 关闭索引器
     */
    close(): void {
        this.db.close();
        this.retriever = null;
        this.documents.clear();
    }

    /**
     * 获取底层 BM25IndexDB 实例
     */
    getDB(): BM25IndexDB {
        return this.db;
    }

    /**
     * 获取当前索引的文档数量
     */
    getDocumentCount(): number {
        return this.documents.size;
    }

    /**
     * 强制重建索引（用于外部触发）
     */
    async forceRebuild(): Promise<void> {
        await this.lock.acquireWrite();
        try {
            await this.rebuildIndex();
        } finally {
            this.lock.releaseWrite();
        }
    }
}

/**
 * 创建 BM25Indexer 实例的工厂函数
 */
export function createBM25Indexer(dbPath: string, options?: BM25IndexerOptions): BM25Indexer {
    return new BM25Indexer(dbPath, options);
}

export default BM25Indexer;
