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
 * TagIndexDBWasm
 *
 * node-sqlite3-wasm implementation of ITagIndexDB with the same external
 * semantics as TagIndexDB.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import type {
    TagIndexRecord,
    QueryCondition,
    QueryOptions,
    UpdateData,
    ITagIndexDB,
    TagQueryOperator
} from './tag-indexer.js';
import { removeSqliteStoreFiles } from './drop-utils.js';

const require = createRequire(import.meta.url);
const sqlite3Wasm = require('node-sqlite3-wasm') as {
    Database: new (dbPath: string) => {
        run(sql: string, params?: any[]): { changes?: number; lastInsertRowid?: number };
        get(sql: string, params?: any[]): Record<string, any> | undefined;
        all(sql: string, params?: any[]): Record<string, any>[];
        close(): void;
    };
};

const SUPPORTED_OPERATORS: TagQueryOperator[] = ['=', '!=', '>', '<', '>=', '<=', 'like', 'in'];

function quoteString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function buildLiteral(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`Cannot bind non-finite number: ${value}`);
        return String(value);
    }
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'string') return quoteString(value);
    throw new Error(`Unsupported SQL literal type: ${Object.prototype.toString.call(value)}`);
}

function bindParams(sql: string, params: any[]): string {
    if (params.length === 0) return sql;

    let out = '';
    let paramIndex = 0;
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];

        if (ch === "'" && !inDouble) {
            const escaped = inSingle && i + 1 < sql.length && sql[i + 1] === "'";
            out += ch;
            if (escaped) {
                out += sql[i + 1];
                i += 1;
            } else {
                inSingle = !inSingle;
            }
            continue;
        }

        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            out += ch;
            continue;
        }

        if (ch === '?' && !inSingle && !inDouble) {
            if (paramIndex >= params.length) throw new Error('Not enough SQL params');
            out += buildLiteral(params[paramIndex++]);
            continue;
        }

        out += ch;
    }

    return out;
}

export class TagIndexDBWasm implements ITagIndexDB {
    private readonly db: InstanceType<(typeof sqlite3Wasm)['Database']>;
    private readonly dbPath: string;
    private readonly tableName = 'tag_index';
    private isInitialized = false;
    private transactionDepth = 0;

    constructor(dbPath: string) {
        this.dbPath = dbPath;
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new sqlite3Wasm.Database(dbPath);
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA busy_timeout = 5000');
        this.initializeTable();
    }

    private initializeTable(): void {
        if (this.isInitialized) return;

        this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                item_id TEXT PRIMARY KEY,
                item_type TEXT,
                tag TEXT
            )
        `);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_item_type ON ${this.tableName}(item_type)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_tag ON ${this.tableName}(tag)`);
        this.isInitialized = true;
    }

    static getSupportedOperators(): TagQueryOperator[] {
        return [...SUPPORTED_OPERATORS];
    }

    static isOperatorSupported(operator: string): operator is TagQueryOperator {
        return SUPPORTED_OPERATORS.includes(operator as TagQueryOperator);
    }

    private validateField(field: string): void {
        if (field !== 'item_id' && field !== 'item_type' && field !== 'tag') {
            throw new Error(`Invalid field name: ${field}. Valid fields: item_id, item_type, tag`);
        }
    }

    private assertOperatorSupported(operator: string): asserts operator is TagQueryOperator {
        if (!TagIndexDBWasm.isOperatorSupported(operator)) {
            throw new Error(
                `Unsupported operator: ${operator}. Supported operators: ${SUPPORTED_OPERATORS.join(', ')}`
            );
        }
    }

    private getRecordColumns(record: Record<string, any>): string[] {
        return ['item_id', 'item_type', 'tag'].filter((column) => record[column] !== undefined);
    }

    private buildWhereClause(conditions: QueryCondition[]): { whereClause: string; params: any[] } {
        const clauses: string[] = [];
        const params: any[] = [];

        for (const condition of conditions) {
            const { field, operator, value } = condition;
            this.validateField(field);
            this.assertOperatorSupported(operator);

            if (operator === 'in') {
                if (!Array.isArray(value)) {
                    throw new Error('in operator requires an array value');
                }
                if (value.length === 0) {
                    clauses.push('1 = 0');
                } else {
                    clauses.push(`${field} IN (${value.map(() => '?').join(', ')})`);
                    params.push(...value);
                }
                continue;
            }

            if (operator === '!=') {
                clauses.push(`${field} <> ?`);
                params.push(value);
                continue;
            }

            if (operator === 'like') {
                clauses.push(`${field} LIKE ?`);
                params.push(value);
                continue;
            }

            clauses.push(`${field} ${operator} ?`);
            params.push(value);
        }

        return {
            whereClause: clauses.length > 0 ? clauses.join(' AND ') : '1=1',
            params
        };
    }

    private async withTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
        if (this.transactionDepth > 0) {
            return await fn();
        }

        this.transactionDepth += 1;
        this.db.run('BEGIN');
        try {
            const result = await fn();
            this.db.run('COMMIT');
            return result;
        } catch (error) {
            try {
                this.db.run('ROLLBACK');
            } catch {}
            throw error;
        } finally {
            this.transactionDepth -= 1;
        }
    }

    private buildUpdateSql(data: UpdateData): { setClause: string; values: any[] } {
        const fields = Object.keys(data).filter(
            (key) => (key === 'item_type' || key === 'tag') && data[key as keyof UpdateData] !== undefined
        );
        if (fields.length === 0) {
            throw new Error('No fields to update');
        }

        return {
            setClause: fields.map((field) => `${field} = ?`).join(', '),
            values: fields.map((field) => data[field as keyof UpdateData])
        };
    }

    async insert(record: TagIndexRecord): Promise<boolean> {
        const columns = this.getRecordColumns(record);
        if (columns.length === 0) return false;
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map((column) => record[column]);
        const result = this.db.run(
            `INSERT INTO ${this.tableName} (${columns.join(', ')})
             VALUES (${placeholders})`,
            values
        );
        return (result.changes ?? 0) > 0;
    }

    async insertMany(records: TagIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;

        return this.withTransaction(() => {
            let count = 0;
            for (const record of records) {
                const columns = this.getRecordColumns(record);
                if (columns.length === 0) continue;
                const placeholders = columns.map(() => '?').join(', ');
                const values = columns.map((column) => record[column]);
                const result = this.db.run(
                    `INSERT INTO ${this.tableName} (${columns.join(', ')})
                     VALUES (${placeholders})
                     ON CONFLICT(item_id) DO NOTHING`,
                    values
                );
                count += result.changes ?? 0;
            }
            return count;
        });
    }

    async upsert(record: TagIndexRecord): Promise<boolean> {
        return (await this.upsertMany([record])) > 0;
    }

    async upsertMany(records: TagIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;

        return this.withTransaction(() => {
            let count = 0;
            for (const record of records) {
                const columns = this.getRecordColumns(record);
                if (columns.length === 0) continue;
                const placeholders = columns.map(() => '?').join(', ');
                const values = columns.map((column) => record[column]);
                const result = this.db.run(
                    `INSERT INTO ${this.tableName} (${columns.join(', ')})
                     VALUES (${placeholders})
                     ON CONFLICT(item_id) DO UPDATE SET
                         item_type = excluded.item_type,
                         tag = excluded.tag`,
                    values
                );
                count += result.changes ?? 0;
            }
            return count;
        });
    }

    async delete(itemId: string): Promise<boolean> {
        const result = this.db.run(`DELETE FROM ${this.tableName} WHERE item_id = ?`, [itemId]);
        return (result.changes ?? 0) > 0;
    }

    async deleteByConditions(conditions: QueryCondition[]): Promise<number> {
        if (conditions.length === 0) {
            throw new Error('At least one condition is required for deleteByConditions');
        }

        const { whereClause, params } = this.buildWhereClause(conditions);
        const result = this.db.run(`DELETE FROM ${this.tableName} WHERE ${whereClause}`, params);
        return result.changes ?? 0;
    }

    async deleteMany(itemIds: string[]): Promise<number> {
        if (itemIds.length === 0) return 0;
        const placeholders = itemIds.map(() => '?').join(', ');
        const result = this.db.run(`DELETE FROM ${this.tableName} WHERE item_id IN (${placeholders})`, itemIds);
        return result.changes ?? 0;
    }

    async update(itemId: string, data: UpdateData): Promise<boolean> {
        return (await this.updateMany([{ ...data, item_id: itemId } as TagIndexRecord])) > 0;
    }

    async updateMany(records: TagIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;

        return this.withTransaction(() => {
            let count = 0;
            for (const record of records) {
                const itemId = record.item_id;
                if (itemId === undefined) continue;

                const fields = ['item_type', 'tag'].filter((field) => record[field] !== undefined);
                if (fields.length === 0) continue;

                const setClause = fields.map((field) => `${field} = ?`).join(', ');
                const diffClause = fields.map((field) => `${field} IS NOT ?`).join(' OR ');
                const values = fields.map((field) => record[field]);
                const result = this.db.run(
                    `UPDATE ${this.tableName}
                     SET ${setClause}
                     WHERE item_id = ?
                       AND (${diffClause})`,
                    [...values, itemId, ...values]
                );
                count += result.changes ?? 0;
            }
            return count;
        });
    }

    async updateByConditions(conditions: QueryCondition[], data: UpdateData): Promise<number> {
        if (conditions.length === 0) {
            throw new Error('At least one condition is required for updateByConditions');
        }

        const { whereClause, params } = this.buildWhereClause(conditions);
        const { setClause, values } = this.buildUpdateSql(data);
        const result = this.db.run(
            `UPDATE ${this.tableName}
             SET ${setClause}
             WHERE ${whereClause}`,
            [...values, ...params]
        );
        return result.changes ?? 0;
    }

    async findById(itemId: string): Promise<TagIndexRecord | undefined> {
        return this.db.get(`SELECT * FROM ${this.tableName} WHERE item_id = ?`, [itemId]) as TagIndexRecord | undefined;
    }

    async findAll(options?: QueryOptions): Promise<TagIndexRecord[]> {
        let sql = `SELECT * FROM ${this.tableName}`;
        const params: any[] = [];

        if (options?.conditions && options.conditions.length > 0) {
            const { whereClause, params: whereParams } = this.buildWhereClause(options.conditions);
            sql += ` WHERE ${whereClause}`;
            params.push(...whereParams);
        }

        if (options?.orderBy) {
            this.validateField(options.orderBy.field as string);
            sql += ` ORDER BY ${options.orderBy.field} ${options.orderBy.direction}`;
        }

        if (options?.limit !== undefined) {
            sql += ' LIMIT ?';
            params.push(options.limit);
        }

        if (options?.offset !== undefined) {
            if (options?.limit === undefined) {
                sql += ' LIMIT -1';
            }
            sql += ' OFFSET ?';
            params.push(options.offset);
        }

        return this.db.all(sql, params) as TagIndexRecord[];
    }

    async search(conditions: QueryCondition[], options?: Omit<QueryOptions, 'conditions'>): Promise<TagIndexRecord[]> {
        return this.findAll({ ...options, conditions });
    }

    async count(conditions?: QueryCondition[]): Promise<number> {
        let sql = `SELECT COUNT(*) as count FROM ${this.tableName}`;
        const params: any[] = [];

        if (conditions && conditions.length > 0) {
            const { whereClause, params: whereParams } = this.buildWhereClause(conditions);
            sql += ` WHERE ${whereClause}`;
            params.push(...whereParams);
        }

        const row = this.db.get(sql, params) as { count?: number } | undefined;
        return row?.count ?? 0;
    }

    async exists(itemId: string): Promise<boolean> {
        return this.db.get(`SELECT 1 FROM ${this.tableName} WHERE item_id = ? LIMIT 1`, [itemId]) != null;
    }

    async clear(): Promise<number> {
        const countBefore = await this.count();
        this.db.run(`DELETE FROM ${this.tableName}`);
        return countBefore;
    }

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        return this.withTransaction(fn);
    }

    close(): void {
        this.db.close();
    }

    async dropStorage(): Promise<void> {
        this.close();
        removeSqliteStoreFiles(this.dbPath);
        this.isInitialized = false;
    }
}

export default TagIndexDBWasm;
