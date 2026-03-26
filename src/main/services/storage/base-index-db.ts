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
 * Base Index Database Management Library
 *
 * 使用 SQLite 实现动态 Schema 的基础索引表管理，支持并发安全的 CRUD 操作
 * 支持动态查询条件：'=', '!=', '>', '<', '>=', '<=', 'like', 'in', 'between'
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { ColumnSchema, validateColumnSchema } from './abstract-storage.js';
import type { BaseQueryCondition, BaseQueryOperator, BaseQueryOptions, IBaseIndexDB } from './base-indexer.js';

// 支持的操作符列表
const SUPPORTED_OPERATORS: BaseQueryOperator[] = [
    '=',
    '!=',
    '>',
    '<',
    '>=',
    '<=',
    'like',
    'notlike',
    'in',
    'notin',
    'between',
    'notbetween'
];

/**
 * Base 索引数据库管理类
 *
 * 使用 better-sqlite3 实现同步 API，天然支持并发安全
 * better-sqlite3 使用 SQLite 的 WAL 模式，支持多读单写
 *
 * 支持动态 Schema：根据传入的 ColumnSchema 动态创建表结构
 */
export class BaseIndexDB implements IBaseIndexDB {
    private db: Database.Database;
    private readonly tableName = 'base_index';
    private isInitialized = false;
    private schema: ColumnSchema;
    private validFields: string[];

    constructor(dbPath: string, schema: ColumnSchema) {
        // 验证 schema
        validateColumnSchema(schema);
        this.schema = schema;
        this.validFields = Object.keys(schema.columns);

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
     * 动态初始化数据库表结构
     */
    private initializeTable(): void {
        if (this.isInitialized) return;

        const columnDefs: string[] = [];

        for (const columnName of Object.keys(this.schema.columns)) {
            const allowedDef = this.schema.columns[columnName];
            if (!allowedDef) continue;

            let colDef = `${columnName} ${allowedDef.type}`;

            // 添加约束
            if (columnName === 'item_id') {
                colDef += ' PRIMARY KEY';
            } else {
                if (!allowedDef.nullable) {
                    colDef += ' NOT NULL';
                }
                if (allowedDef.defaultValue !== undefined && allowedDef.defaultValue !== null) {
                    const defaultVal =
                        typeof allowedDef.defaultValue === 'string'
                            ? `'${allowedDef.defaultValue}'`
                            : allowedDef.defaultValue;
                    colDef += ` DEFAULT ${defaultVal}`;
                }
            }

            columnDefs.push(colDef);
        }

        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                ${columnDefs.join(',\n                ')}
            )
        `;

        this.db.exec(createTableSQL);

        // 为常用查询字段创建索引
        this.createIndexes();

        this.isInitialized = true;
    }

    /**
     * 为 schema 中的列创建索引
     */
    private createIndexes(): void {
        const indexableColumns = this.validFields.filter((col) => col !== 'item_id');

        for (const column of indexableColumns) {
            const indexName = `idx_base_${column}`;
            try {
                this.db.exec(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${this.tableName}(${column})`);
            } catch (error) {
                // 忽略索引创建错误
                console.warn(`Failed to create index for ${column}:`, error);
            }
        }
    }

    /**
     * 获取支持的操作符列表
     */
    static getSupportedOperators(): BaseQueryOperator[] {
        return [...SUPPORTED_OPERATORS];
    }

    /**
     * 检查操作符是否支持
     */
    static isOperatorSupported(operator: string): operator is BaseQueryOperator {
        return SUPPORTED_OPERATORS.includes(operator.toLowerCase() as BaseQueryOperator);
    }

    /**
     * 验证字段是否有效
     */
    private validateField(field: string): void {
        if (!this.validFields.includes(field)) {
            throw new Error(`Invalid field name: ${field}. Valid fields: ${this.validFields.join(', ')}`);
        }
    }

    private getRecordColumns(record: Record<string, any>): string[] {
        return this.validFields.filter((col) => record[col] !== undefined);
    }

    /**
     * 插入单条记录（first-write-only）
     */
    async insert(record: Record<string, any>): Promise<boolean> {
        return (await this.insertMany([record])) > 0;
    }

    /**
     * 批量插入记录（first-write-only）
     */
    async insertMany(records: Record<string, any>[]): Promise<number> {
        if (records.length === 0) return 0;

        const insertAll = this.db.transaction((records: Record<string, any>[]) => {
            let count = 0;
            for (const record of records) {
                const columns = this.getRecordColumns(record);
                if (columns.length === 0) continue;
                const placeholders = columns.map(() => '?').join(', ');
                const values = columns.map((col) => record[col]);
                const insertStmt = this.db.prepare(`
                    INSERT INTO ${this.tableName} (${columns.join(', ')})
                    VALUES (${placeholders})
                    ON CONFLICT(item_id) DO NOTHING
                `);
                const result = insertStmt.run(...values);
                count += result.changes;
            }
            return count;
        });

        return insertAll(records);
    }

    /**
     * 插入或更新记录（sparse upsert）
     */
    async upsert(record: Record<string, any>): Promise<boolean> {
        return (await this.upsertMany([record])) > 0;
    }

    async upsertMany(records: Record<string, any>[]): Promise<number> {
        if (records.length === 0) return 0;

        const upsertAll = this.db.transaction((records: Record<string, any>[]) => {
            let count = 0;
            for (const record of records) {
                const columns = this.getRecordColumns(record);
                if (columns.length === 0) continue;

                const placeholders = columns.map(() => '?').join(', ');
                const values = columns.map((col) => record[col]);
                const updateColumns = columns.filter((c) => c !== 'item_id');
                const sql =
                    updateColumns.length === 0
                        ? `
                        INSERT INTO ${this.tableName} (${columns.join(', ')})
                        VALUES (${placeholders})
                        ON CONFLICT(item_id) DO NOTHING
                    `
                        : `
                        INSERT INTO ${this.tableName} (${columns.join(', ')})
                        VALUES (${placeholders})
                        ON CONFLICT(item_id) DO UPDATE SET ${updateColumns.map((col) => `${col} = excluded.${col}`).join(', ')}
                    `;

                const stmt = this.db.prepare(sql);
                const result = stmt.run(...values);
                count += result.changes;
            }
            return count;
        });

        return upsertAll(records);
    }

    async update(itemId: string, data: Record<string, any>): Promise<boolean> {
        const fields = Object.keys(data).filter(
            (key) => this.validFields.includes(key) && key !== 'item_id' && data[key] !== undefined
        );
        if (fields.length === 0) {
            throw new Error('No valid fields to update');
        }

        const updated = await this.updateMany([{ ...data, item_id: itemId }]);
        return updated > 0;
    }

    async updateMany(records: Record<string, any>[]): Promise<number> {
        if (records.length === 0) return 0;

        const updateAll = this.db.transaction((records: Record<string, any>[]) => {
            let count = 0;
            for (const record of records) {
                const itemId = record.item_id;
                if (itemId === undefined) continue;

                const columns = this.getRecordColumns(record).filter((col) => col !== 'item_id');
                if (columns.length === 0) continue;

                const setClause = columns.map((field) => `${field} = @${field}`).join(', ');
                const diffClause = columns.map((field) => `${field} IS NOT @${field}`).join(' OR ');
                const stmt = this.db.prepare(`
                    UPDATE ${this.tableName}
                    SET ${setClause}
                    WHERE item_id = @item_id
                      AND (${diffClause})
                `);

                const result = stmt.run({ ...record, item_id: itemId });
                count += result.changes;
            }
            return count;
        });

        return updateAll(records);
    }

    /**
     * 根据 item_id 删除记录
     */
    async delete(itemId: string): Promise<boolean> {
        const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE item_id = ?`);
        const result = stmt.run(itemId);
        return result.changes > 0;
    }

    /**
     * 批量删除记录
     */
    async deleteMany(itemIds: string[]): Promise<number> {
        if (itemIds.length === 0) return 0;

        const placeholders = itemIds.map(() => '?').join(', ');
        const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE item_id IN (${placeholders})`);
        const result = stmt.run(...itemIds);
        return result.changes;
    }

    /**
     * 根据条件删除记录
     */
    async deleteByConditions(conditions: BaseQueryCondition[]): Promise<number> {
        if (conditions.length === 0) {
            throw new Error('At least one condition is required for deleteByConditions');
        }

        const { whereClause, params } = this.buildWhereClause(conditions);
        const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE ${whereClause}`);
        const result = stmt.run(...params);
        return result.changes;
    }

    /**
     * 根据 item_id 查询单条记录
     */
    async findById(itemId: string): Promise<Record<string, any> | undefined> {
        const stmt = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE item_id = ?`);
        return stmt.get(itemId) as Record<string, any> | undefined;
    }

    /**
     * 批量查询记录
     */
    async findByIds(itemIds: string[]): Promise<Record<string, any>[]> {
        if (itemIds.length === 0) return [];

        const placeholders = itemIds.map(() => '?').join(', ');
        const stmt = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE item_id IN (${placeholders})`);
        return stmt.all(...itemIds) as Record<string, any>[];
    }

    /**
     * 查询所有记录
     */
    async findAll(options?: BaseQueryOptions): Promise<Record<string, any>[]> {
        let sql = `SELECT * FROM ${this.tableName}`;
        const params: any[] = [];

        if (options?.conditions && options.conditions.length > 0) {
            const { whereClause, params: whereParams } = this.buildWhereClause(options.conditions);
            sql += ` WHERE ${whereClause}`;
            params.push(...whereParams);
        }

        if (options?.orderBy) {
            this.validateField(options.orderBy.field);
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
        return stmt.all(...params) as Record<string, any>[];
    }

    /**
     * 根据条件查询记录
     */
    async search(
        conditions: BaseQueryCondition[],
        options?: Omit<BaseQueryOptions, 'conditions'>
    ): Promise<Record<string, any>[]> {
        return this.findAll({ ...options, conditions });
    }

    /**
     * 统计记录数
     */
    async count(conditions?: BaseQueryCondition[]): Promise<number> {
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
     */
    async exists(itemId: string): Promise<boolean> {
        const stmt = this.db.prepare(`SELECT 1 FROM ${this.tableName} WHERE item_id = ? LIMIT 1`);
        return stmt.get(itemId) !== undefined;
    }

    /**
     * 清空所有记录
     */
    async clear(): Promise<number> {
        const countBefore = await this.count();
        this.db.exec(`DELETE FROM ${this.tableName}`);
        return countBefore;
    }

    /**
     * 在事务中执行多个操作
     */
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        // better-sqlite3 是同步引擎，fn() 内部的 DB 调用虽然返回 Promise，
        // 但在 BaseIndexDB 实现中这些 Promise 会即时 resolve（无真正异步 I/O）
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
     */
    private buildWhereClause(conditions: BaseQueryCondition[]): { whereClause: string; params: any[] } {
        const clauses: string[] = [];
        const params: any[] = [];

        for (const condition of conditions) {
            const { field, operator, value } = condition;
            const op = operator.toLowerCase() as BaseQueryOperator;

            // 验证字段名
            this.validateField(field);

            // 验证操作符
            if (!BaseIndexDB.isOperatorSupported(op)) {
                throw new Error(
                    `Unsupported operator: ${operator}. Supported operators: ${SUPPORTED_OPERATORS.join(', ')}`
                );
            }

            if (op === 'in' || op === 'notin') {
                if (!Array.isArray(value)) {
                    throw new Error(`${operator} operator requires an array value`);
                }
                if (value.length === 0) {
                    // 空数组的 IN 条件永远为 false，NOT IN 永远为 true
                    clauses.push(op === 'in' ? '1 = 0' : '1 = 1');
                } else {
                    const placeholders = value.map(() => '?').join(', ');
                    const sqlOp = op === 'in' ? 'IN' : 'NOT IN';
                    clauses.push(`${field} ${sqlOp} (${placeholders})`);
                    params.push(...value);
                }
            } else if (op === 'between' || op === 'notbetween') {
                if (!Array.isArray(value) || value.length !== 2) {
                    throw new Error(`${operator} operator requires an array of two values [min, max]`);
                }
                const sqlOp = op === 'between' ? 'BETWEEN' : 'NOT BETWEEN';
                clauses.push(`${field} ${sqlOp} ? AND ?`);
                params.push(value[0], value[1]);
            } else if (op === '!=') {
                clauses.push(`${field} <> ?`);
                params.push(value);
            } else if (op === 'like') {
                clauses.push(`${field} LIKE ?`);
                params.push(value);
            } else if (op === 'notlike') {
                clauses.push(`${field} NOT LIKE ?`);
                params.push(value);
            } else {
                clauses.push(`${field} ${op} ?`);
                params.push(value);
            }
        }

        return {
            whereClause: clauses.length > 0 ? clauses.join(' AND ') : '1=1',
            params
        };
    }

    /**
     * 获取 Schema
     */
    getSchema(): ColumnSchema {
        return this.schema;
    }

    /**
     * 获取有效字段列表
     */
    getValidFields(): string[] {
        return [...this.validFields];
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

export default BaseIndexDB;

/**
 * 工厂函数：根据当前平台自动选择 BaseIndexDB 实现
 * 平台判断逻辑内聚在数据层， indexer 不感知平台
 */
export async function createBaseIndexDB(dbPath: string, schema: ColumnSchema): Promise<IBaseIndexDB> {
    if ((process.platform as string) === 'openharmony') {
        const { BaseIndexDBHm } = await import('./base-index-db-hm.js');
        return new BaseIndexDBHm(dbPath, schema);
    }
    return new BaseIndexDB(dbPath, schema);
}
