/**
 * Base Index Database Management Library
 *
 * 使用 SQLite 实现动态 Schema 的基础索引表管理，支持并发安全的 CRUD 操作
 * 支持动态查询条件：'=', '!=', '>', '<', '>=', '<=', 'like', 'in', 'between'
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { ColumnSchema, validateColumnSchema, ScalarOperator } from './abstrac-storage.js';

// BaseIndexDB 支持的操作符（从 object.ts 导入，保持类型别名以兼容）
export type BaseQueryOperator = ScalarOperator;

// 查询条件接口
export interface BaseQueryCondition {
    field: string;
    operator: BaseQueryOperator;
    value: string | string[] | number | number[] | [number, number] | [string, string];
}

// 查询选项接口
export interface BaseQueryOptions {
    conditions?: BaseQueryCondition[];
    orderBy?: {
        field: string;
        direction: 'ASC' | 'DESC';
    };
    limit?: number;
    offset?: number;
}

// 支持的操作符列表
const SUPPORTED_OPERATORS: BaseQueryOperator[] = [
    '=', '!=', '>', '<', '>=', '<=',
    'like', 'notlike', 'in', 'notin',
    'between', 'notbetween'
];

/**
 * Base 索引数据库管理类
 *
 * 使用 better-sqlite3 实现同步 API，天然支持并发安全
 * better-sqlite3 使用 SQLite 的 WAL 模式，支持多读单写
 *
 * 支持动态 Schema：根据传入的 ColumnSchema 动态创建表结构
 */
export class BaseIndexDB {
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
                    const defaultVal = typeof allowedDef.defaultValue === 'string'
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

        console.info(`[base-index-db] create table SQL:\n${createTableSQL}`);
        this.db.exec(createTableSQL);

        // 为常用查询字段创建索引
        this.createIndexes();

        this.isInitialized = true;
    }

    /**
     * 为 schema 中的列创建索引
     */
    private createIndexes(): void {
        const indexableColumns = this.validFields.filter(col => col !== 'item_id');

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

    /**
     * 插入单条记录
     */
    insert(record: Record<string, any>): boolean {
        const columns = this.validFields.filter(col => record[col] !== undefined);
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map(col => record[col]);

        const stmt = this.db.prepare(`
            INSERT INTO ${this.tableName} (${columns.join(', ')})
            VALUES (${placeholders})
        `);

        try {
            const result = stmt.run(...values);
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
     */
    insertMany(records: Record<string, any>[]): number {
        if (records.length === 0) return 0;

        const insertAll = this.db.transaction((records: Record<string, any>[]) => {
            let count = 0;
            for (const record of records) {
                try {
                    const columns = this.validFields.filter(col => record[col] !== undefined);
                    const placeholders = columns.map(() => '?').join(', ');
                    const values = columns.map(col => record[col]);

                    const insertStmt = this.db.prepare(`
                        INSERT INTO ${this.tableName} (${columns.join(', ')})
                        VALUES (${placeholders})
                    `);
                    const result = insertStmt.run(...values);
                    if (result.changes > 0) count++;
                } catch (error: any) {
                    // 跳过重复记录，继续插入其他记录
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
     * 插入或更新记录（upsert）
     */
    upsert(record: Record<string, any>): boolean {
        const columns = this.validFields.filter(col => record[col] !== undefined);
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map(col => record[col]);

        const updateColumns = columns.filter(c => c !== 'item_id');
        const updateClause = updateColumns.map(col => `${col} = excluded.${col}`).join(', ');

        const stmt = this.db.prepare(`
            INSERT INTO ${this.tableName} (${columns.join(', ')})
            VALUES (${placeholders})
            ON CONFLICT(item_id) DO UPDATE SET ${updateClause}
        `);

        const result = stmt.run(...values);
        return result.changes > 0;
    }

    /**
     * 根据 item_id 删除记录
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
     * 根据条件删除记录
     */
    deleteByConditions(conditions: BaseQueryCondition[]): number {
        if (conditions.length === 0) {
            throw new Error('At least one condition is required for deleteByConditions');
        }

        const { whereClause, params } = this.buildWhereClause(conditions);
        const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE ${whereClause}`);
        const result = stmt.run(...params);
        return result.changes;
    }

    /**
     * 更新记录
     */
    update(itemId: string, data: Record<string, any>): boolean {
        const fields = Object.keys(data).filter(key =>
            this.validFields.includes(key) && key !== 'item_id' && data[key] !== undefined
        );
        if (fields.length === 0) {
            throw new Error('No valid fields to update');
        }

        const setClause = fields.map(field => `${field} = @${field}`).join(', ');
        const stmt = this.db.prepare(`UPDATE ${this.tableName} SET ${setClause} WHERE item_id = @item_id`);

        const result = stmt.run({ ...data, item_id: itemId });
        return result.changes > 0;
    }

    /**
     * 根据 item_id 查询单条记录
     */
    findById(itemId: string): Record<string, any> | undefined {
        const stmt = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE item_id = ?`);
        return stmt.get(itemId) as Record<string, any> | undefined;
    }

    /**
     * 批量查询记录
     */
    findByIds(itemIds: string[]): Record<string, any>[] {
        if (itemIds.length === 0) return [];

        const placeholders = itemIds.map(() => '?').join(', ');
        const stmt = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE item_id IN (${placeholders})`);
        return stmt.all(...itemIds) as Record<string, any>[];
    }

    /**
     * 查询所有记录
     */
    findAll(options?: BaseQueryOptions): Record<string, any>[] {
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
    query(conditions: BaseQueryCondition[], options?: Omit<BaseQueryOptions, 'conditions'>): Record<string, any>[] {
        return this.findAll({ ...options, conditions });
    }

    /**
     * 统计记录数
     */
    count(conditions?: BaseQueryCondition[]): number {
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
     * 在事务中执行多个操作
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
                throw new Error(`Unsupported operator: ${operator}. Supported operators: ${SUPPORTED_OPERATORS.join(', ')}`);
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
    getStats(): { totalRecords: number; dbSize: number } {
        const totalRecords = this.count();
        const pageCount = (this.db.pragma('page_count') as { page_count: number }[])[0].page_count;
        const pageSize = (this.db.pragma('page_size') as { page_size: number }[])[0].page_size;
        const dbSize = pageCount * pageSize;

        return { totalRecords, dbSize };
    }
}

export default BaseIndexDB;
