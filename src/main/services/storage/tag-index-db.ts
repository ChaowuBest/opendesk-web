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
 * Tag Index Database Management Library
 *
 * 使用 SQLite 实现文件 tag 索引表的管理，支持并发安全的 CRUD 操作
 * 支持动态查询条件：'=', '!=', '>', '<', '>=', '<=', 'like', 'in'
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
    TagQueryOperator,
    TagIndexRecord,
    QueryCondition,
    QueryOptions,
    UpdateData,
    ITagIndexDB
} from './tag-indexer.js';

// 支持的操作符列表
const SUPPORTED_OPERATORS: TagQueryOperator[] = ['=', '!=', '>', '<', '>=', '<=', 'like', 'in'];

/**
 * Tag 索引数据库管理类
 *
 * 使用 better-sqlite3 实现同步 API，天然支持并发安全
 * better-sqlite3 使用 SQLite 的 WAL 模式，支持多读单写
 */
export class TagIndexDB implements ITagIndexDB {
    private db: Database.Database;
    private readonly tableName = 'tag_index';
    private isInitialized = false;

    constructor(dbPath: string) {
        // 确保目录存在
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // 创建数据库连接
        this.db = new Database(dbPath);

        // 启用 WAL 模式以提高并发性能
        this.db.pragma('journal_mode = WAL');

        // 设置忙等待超时（毫秒）
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
                item_type TEXT,
                tag TEXT
            )
        `;

        this.db.exec(createTableSQL);

        // 创建索引以提高查询性能
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_item_type ON ${this.tableName}(item_type)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tag ON ${this.tableName}(tag)`);

        this.isInitialized = true;
    }

    /**
     * 获取支持的操作符列表
     */
    static getSupportedOperators(): TagQueryOperator[] {
        return [...SUPPORTED_OPERATORS];
    }

    /**
     * 检查操作符是否支持
     */
    static isOperatorSupported(operator: string): operator is TagQueryOperator {
        return SUPPORTED_OPERATORS.includes(operator as TagQueryOperator);
    }

    /**
     * 插入单条记录
     * @param record 要插入的记录
     * @returns 是否插入成功
     */
    async insert(record: TagIndexRecord): Promise<boolean> {
        const stmt = this.db.prepare(`
            INSERT INTO ${this.tableName} (item_id, item_type, tag)
            VALUES (@item_id, @item_type, @tag)
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
     * 批量插入记录（使用事务确保原子性）
     * @param records 要插入的记录数组
     * @returns 成功插入的记录数
     */
    async insertMany(records: TagIndexRecord[]): Promise<number> {
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO ${this.tableName} (item_id, item_type, tag)
            VALUES (@item_id, @item_type, @tag)
        `);

        const insertAll = this.db.transaction((records: TagIndexRecord[]) => {
            let count = 0;
            for (const record of records) {
                const result = stmt.run(record);
                count += result.changes;
            }
            return count;
        });

        return insertAll(records);
    }

    /**
     * 插入或更新记录（upsert）
     * @param record 要插入或更新的记录
     * @returns 是否操作成功
     */
    async upsert(record: TagIndexRecord): Promise<boolean> {
        const stmt = this.db.prepare(`
            INSERT INTO ${this.tableName} (item_id, item_type, tag)
            VALUES (@item_id, @item_type, @tag)
            ON CONFLICT(item_id) DO UPDATE SET
                item_type = excluded.item_type,
                tag = excluded.tag
        `);

        const result = stmt.run(record);
        return result.changes > 0;
    }

    /**
     * 批量插入或更新记录
     * @param records 要插入或更新的记录数组
     * @returns 成功处理的记录数
     */
    async upsertMany(records: TagIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;

        const stmt = this.db.prepare(`
            INSERT INTO ${this.tableName} (item_id, item_type, tag)
            VALUES (@item_id, @item_type, @tag)
            ON CONFLICT(item_id) DO UPDATE SET
                item_type = excluded.item_type,
                tag = excluded.tag
        `);

        const upsertAll = this.db.transaction((batch: TagIndexRecord[]) => {
            let count = 0;
            for (const record of batch) {
                const result = stmt.run(record);
                count += result.changes;
            }
            return count;
        });

        return upsertAll(records);
    }

    /**
     * 根据 item_id 删除记录
     * @param itemId 要删除的记录 ID
     * @returns 是否删除成功
     */
    async delete(itemId: string): Promise<boolean> {
        const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE item_id = ?`);
        const result = stmt.run(itemId);
        return result.changes > 0;
    }

    /**
     * 根据条件删除记录
     * @param conditions 删除条件
     * @returns 删除的记录数
     */
    async deleteByConditions(conditions: QueryCondition[]): Promise<number> {
        if (conditions.length === 0) {
            throw new Error('At least one condition is required for deleteByConditions');
        }

        const { whereClause, params } = this.buildWhereClause(conditions);
        const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE ${whereClause}`);
        const result = stmt.run(...params);
        return result.changes;
    }

    /**
     * 批量删除记录
     * @param itemIds 要删除的记录 ID 数组
     * @returns 删除的记录数
     */
    async deleteMany(itemIds: string[]): Promise<number> {
        if (itemIds.length === 0) return 0;

        const placeholders = itemIds.map(() => '?').join(', ');
        const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE item_id IN (${placeholders})`);
        const result = stmt.run(...itemIds);
        return result.changes;
    }

    /**
     * 更新记录
     * @param itemId 要更新的记录 ID
     * @param data 要更新的数据
     * @returns 是否更新成功
     */
    async update(itemId: string, data: UpdateData): Promise<boolean> {
        const fields = Object.keys(data).filter((key) => data[key as keyof UpdateData] !== undefined);
        if (fields.length === 0) {
            throw new Error('No fields to update');
        }

        const setClause = fields.map((field) => `${field} = @${field}`).join(', ');
        const stmt = this.db.prepare(`UPDATE ${this.tableName} SET ${setClause} WHERE item_id = @item_id`);

        const result = stmt.run({ ...data, item_id: itemId });
        return result.changes > 0;
    }

    /**
     * 批量更新记录
     * @param records 要更新的记录数组
     * @returns 实际发生变化的记录数
     */
    async updateMany(records: TagIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;

        const stmt = this.db.prepare(`
            UPDATE ${this.tableName}
            SET item_type = ?, tag = ?
            WHERE item_id = ? AND (item_type <> ? OR tag <> ?)
        `);

        const updateAll = this.db.transaction((batch: TagIndexRecord[]) => {
            let count = 0;
            for (const record of batch) {
                const result = stmt.run(
                    record.item_type,
                    record.tag,
                    record.item_id,
                    record.item_type,
                    record.tag
                );
                count += result.changes;
            }
            return count;
        });

        return updateAll(records);
    }

    /**
     * 根据条件更新记录
     * @param conditions 更新条件
     * @param data 要更新的数据
     * @returns 更新的记录数
     */
    async updateByConditions(conditions: QueryCondition[], data: UpdateData): Promise<number> {
        if (conditions.length === 0) {
            throw new Error('At least one condition is required for updateByConditions');
        }

        const fields = Object.keys(data).filter((key) => data[key as keyof UpdateData] !== undefined);
        if (fields.length === 0) {
            throw new Error('No fields to update');
        }

        const { whereClause, params: whereParams } = this.buildWhereClause(conditions);
        const setClause = fields.map((field) => `${field} = ?`).join(', ');
        const setParams = fields.map((field) => data[field as keyof UpdateData]);

        const stmt = this.db.prepare(`UPDATE ${this.tableName} SET ${setClause} WHERE ${whereClause}`);
        const result = stmt.run(...setParams, ...whereParams);
        return result.changes;
    }

    /**
     * 根据 item_id 查询单条记录
     * @param itemId 记录 ID
     * @returns 查询到的记录或 undefined
     */
    async findById(itemId: string): Promise<TagIndexRecord | undefined> {
        const stmt = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE item_id = ?`);
        return stmt.get(itemId) as TagIndexRecord | undefined;
    }

    /**
     * 查询所有记录
     * @param options 查询选项
     * @returns 查询到的记录数组
     */
    async findAll(options?: QueryOptions): Promise<TagIndexRecord[]> {
        let sql = `SELECT * FROM ${this.tableName}`;
        const params: any[] = [];

        if (options?.conditions && options.conditions.length > 0) {
            const { whereClause, params: whereParams } = this.buildWhereClause(options.conditions);
            sql += ` WHERE ${whereClause}`;
            params.push(...whereParams);
        }

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
        return stmt.all(...params) as TagIndexRecord[];
    }

    /**
     * 根据条件查询记录
     * @param conditions 查询条件数组
     * @param options 额外的查询选项
     * @returns 查询到的记录数组
     */
    async search(conditions: QueryCondition[], options?: Omit<QueryOptions, 'conditions'>): Promise<TagIndexRecord[]> {
        return this.findAll({ ...options, conditions });
    }

    /**
     * 统计记录数
     * @param conditions 可选的查询条件
     * @returns 记录数
     */
    async count(conditions?: QueryCondition[]): Promise<number> {
        let sql = `SELECT COUNT(*) as count FROM ${this.tableName}`;
        const params: any[] = [];

        if (conditions && conditions.length > 0) {
            const { whereClause, params: whereParams } = this.buildWhereClause(conditions);
            sql += ` WHERE ${whereClause}`;
            params.push(...whereParams);
        }

        const stmt = this.db.prepare(sql);
        const result = stmt.get(...params) as { count: number };
        return result.count;
    }

    /**
     * 检查记录是否存在
     * @param itemId 记录 ID
     * @returns 是否存在
     */
    async exists(itemId: string): Promise<boolean> {
        const stmt = this.db.prepare(`SELECT 1 FROM ${this.tableName} WHERE item_id = ? LIMIT 1`);
        return stmt.get(itemId) !== undefined;
    }

    /**
     * 清空所有记录
     * @returns 删除的记录数
     */
    async clear(): Promise<number> {
        const countBefore = await this.count();
        this.db.exec(`DELETE FROM ${this.tableName}`);
        return countBefore;
    }

    /**
     * 在事务中执行多个操作
     * @param fn 要在事务中执行的函数
     * @returns 函数的返回值
     */
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        const transact = this.db.transaction(() => fn());
        return transact() as Promise<T>;
    }

    /**
     * 关闭数据库连接
     */
    close(): void {
        this.db.close();
    }

    /**
     * 构建 WHERE 子句
     * @param conditions 查询条件数组
     * @returns WHERE 子句和参数
     */
    private buildWhereClause(conditions: QueryCondition[]): { whereClause: string; params: any[] } {
        const clauses: string[] = [];
        const params: any[] = [];

        for (const condition of conditions) {
            const { field, operator, value } = condition;

            // 验证字段名，防止 SQL 注入
            if (!['item_id', 'item_type', 'tag'].includes(field)) {
                throw new Error(`Invalid field name: ${field}`);
            }

            // 验证操作符
            if (!TagIndexDB.isOperatorSupported(operator)) {
                throw new Error(
                    `Unsupported operator: ${operator}. Supported operators: ${SUPPORTED_OPERATORS.join(', ')}`
                );
            }

            if (operator === 'in') {
                if (!Array.isArray(value)) {
                    throw new Error('in operator requires an array value');
                }
                if (value.length === 0) {
                    // 空数组的 IN 条件永远为 false
                    clauses.push('1 = 0');
                } else {
                    const placeholders = value.map(() => '?').join(', ');
                    clauses.push(`${field} IN (${placeholders})`);
                    params.push(...value);
                }
            } else if (operator === '!=') {
                clauses.push(`${field} <> ?`);
                params.push(value);
            } else {
                clauses.push(`${field} ${operator} ?`);
                params.push(value);
            }
        }

        return {
            whereClause: clauses.join(' AND '),
            params
        };
    }

    /**
     * 获取数据库统计信息
     */
    async getStats(): Promise<{ totalRecords: number; dbSize: number }> {
        const totalRecords = await this.count();
        const pageCount = (this.db.pragma('page_count') as { page_count: number }[])[0].page_count;
        const pageSize = (this.db.pragma('page_size') as { page_size: number }[])[0].page_size;
        const dbSize = pageCount * pageSize;

        return { totalRecords, dbSize };
    }
}

/**
export default TagIndexDB;

/**
 * 工厂函数：根据当前平台自动选择 TagIndexDB 实现
 * 平台判断逻辑内聚在数据层， indexer 不感知平台
 */
export async function createTagIndexDB(dbPath: string): Promise<ITagIndexDB> {
    if ((process.platform as string) === 'openharmony') {
        const { TagIndexDBWasm } = await import('./tag-index-db-wasm.js');
        return new TagIndexDBWasm(dbPath);
    }
    return new TagIndexDB(dbPath);
}
