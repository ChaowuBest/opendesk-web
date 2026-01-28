/**
 * BM25 Index Database Management Library
 *
 * 使用 SQLite 存储文档元数据，支持 BM25 索引重建。
 * 设计原则：持久化层只负责存储，BM25 计算由 Indexer 层处理。
 *
 * 特性：
 * - WAL 模式支持并发读写
 * - 事务支持批量操作
 * - 完整的 CRUD 接口
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ============================================================================
// 数据结构定义
// ============================================================================

/**
 * BM25 索引记录接口
 */
export interface BM25IndexRecord {
    item_id: string;
    item_type: string;
    text: string;
    created_at?: number;
    updated_at?: number;
}

/**
 * 查询选项接口
 */
export interface BM25DBQueryOptions {
    limit?: number;
    offset?: number;
    orderBy?: {
        field: keyof BM25IndexRecord;
        direction: 'ASC' | 'DESC';
    };
}

// ============================================================================
// BM25IndexDB 类
// ============================================================================

export class BM25IndexDB {
    private db: Database.Database;
    private readonly tableName = 'bm25_index';
    private isInitialized = false;

    constructor(dbPath: string) {
        // 确保目录存在
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // 创建数据库连接
        this.db = new Database(dbPath);

        // 启用 WAL 模式以支持并发
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');

        // 初始化表结构
        this.initializeTable();
    }

    /**
     * 初始化数据库表结构
     */
    private initializeTable(): void {
        if (this.isInitialized) return;

        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                item_id TEXT PRIMARY KEY,
                item_type TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at INTEGER,
                updated_at INTEGER
            )
        `;
        this.db.exec(createTableSQL);

        // 创建索引以加速查询
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_bm25_item_type ON ${this.tableName}(item_type)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_bm25_updated_at ON ${this.tableName}(updated_at)`);

        this.isInitialized = true;
    }

    // ==================== CRUD 操作 ====================

    /**
     * 插入单条记录
     */
    insert(record: BM25IndexRecord): boolean {
        const stmt = this.db.prepare(`
            INSERT INTO ${this.tableName} (item_id, item_type, text, created_at, updated_at)
            VALUES (@item_id, @item_type, @text, @created_at, @updated_at)
        `);

        try {
            const result = stmt.run(record);
            return result.changes > 0;
        } catch (error: any) {
            if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
                throw new Error(`Record with item_id '${record.item_id}' already exists`);
            }
            throw error;
        }
    }

    /**
     * 批量插入记录（事务）
     */
    insertMany(records: BM25IndexRecord[]): number {
        if (records.length === 0) return 0;

        const stmt = this.db.prepare(`
            INSERT INTO ${this.tableName} (item_id, item_type, text, created_at, updated_at)
            VALUES (@item_id, @item_type, @text, @created_at, @updated_at)
        `);

        const insertAll = this.db.transaction((records: BM25IndexRecord[]) => {
            let count = 0;
            for (const record of records) {
                try {
                    const result = stmt.run(record);
                    if (result.changes > 0) count++;
                } catch (error: any) {
                    // 忽略主键冲突，继续插入其他记录
                    if (error.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') {
                        throw error;
                    }
                }
            }
            return count;
        });

        return insertAll(records);
    }

    /**
     * Upsert 操作（插入或更新）
     */
    upsert(record: BM25IndexRecord): boolean {
        const stmt = this.db.prepare(`
            INSERT INTO ${this.tableName} (item_id, item_type, text, created_at, updated_at)
            VALUES (@item_id, @item_type, @text, @created_at, @updated_at)
            ON CONFLICT(item_id) DO UPDATE SET
                item_type = excluded.item_type,
                text = excluded.text,
                updated_at = excluded.updated_at
        `);

        const result = stmt.run(record);
        return result.changes > 0;
    }

    /**
     * 删除单条记录
     */
    delete(itemId: string): boolean {
        const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE item_id = ?`);
        const result = stmt.run(itemId);
        return result.changes > 0;
    }

    /**
     * 批量删除记录
     */
    deleteMany(itemIds: string[]): number {
        if (itemIds.length === 0) return 0;

        const placeholders = itemIds.map(() => '?').join(', ');
        const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE item_id IN (${placeholders})`);
        const result = stmt.run(...itemIds);
        return result.changes;
    }

    /**
     * 根据 ID 查询单条记录
     */
    findById(itemId: string): BM25IndexRecord | undefined {
        const stmt = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE item_id = ?`);
        return stmt.get(itemId) as BM25IndexRecord | undefined;
    }

    /**
     * 根据 ID 列表批量查询
     */
    findByIds(itemIds: string[]): BM25IndexRecord[] {
        if (itemIds.length === 0) return [];

        const placeholders = itemIds.map(() => '?').join(', ');
        const stmt = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE item_id IN (${placeholders})`);
        return stmt.all(...itemIds) as BM25IndexRecord[];
    }

    /**
     * 获取所有记录（用于重建 BM25 索引）
     */
    findAll(options?: BM25DBQueryOptions): BM25IndexRecord[] {
        let sql = `SELECT * FROM ${this.tableName}`;
        const params: any[] = [];

        if (options?.orderBy) {
            sql += ` ORDER BY ${options.orderBy.field} ${options.orderBy.direction}`;
        }

        if (options?.limit !== undefined) {
            sql += ` LIMIT ?`;
            params.push(options.limit);
        }

        if (options?.offset !== undefined) {
            sql += ` OFFSET ?`;
            params.push(options.offset);
        }

        const stmt = this.db.prepare(sql);
        return stmt.all(...params) as BM25IndexRecord[];
    }

    /**
     * 统计记录数
     */
    count(): number {
        const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM ${this.tableName}`);
        const result = stmt.get() as { count: number };
        return result.count;
    }

    /**
     * 检查记录是否存在
     */
    exists(itemId: string): boolean {
        const stmt = this.db.prepare(`SELECT 1 FROM ${this.tableName} WHERE item_id = ? LIMIT 1`);
        return stmt.get(itemId) !== undefined;
    }

    /**
     * 清空所有记录
     */
    clear(): number {
        const countBefore = this.count();
        this.db.exec(`DELETE FROM ${this.tableName}`);
        return countBefore;
    }

    /**
     * 事务执行
     */
    transaction<T>(fn: () => T): T {
        const transaction = this.db.transaction(fn);
        return transaction();
    }

    /**
     * 关闭数据库连接
     */
    close(): void {
        this.db.close();
    }

    /**
     * 获取数据库统计信息
     */
    getStats(): { totalRecords: number; dbSize: number } {
        const totalRecords = this.count();
        const pageCount = (this.db.pragma('page_count') as { page_count: number }[])[0].page_count;
        const pageSize = (this.db.pragma('page_size') as { page_size: number }[])[0].page_size;
        const dbSize = pageCount * pageSize;

        return { totalRecords, dbSize };
    }
}

/**
 * 创建 BM25IndexDB 实例的工厂函数
 */
export function createBM25IndexDB(dbPath: string): BM25IndexDB {
    return new BM25IndexDB(dbPath);
}

export default BM25IndexDB;
