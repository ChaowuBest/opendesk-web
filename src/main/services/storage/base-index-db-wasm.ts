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
 * BaseIndexDBWasm
 *
 * node-sqlite3-wasm implementation of IBaseIndexDB with the same external
 * semantics as BaseIndexDB. The API is synchronous underneath, but exposed as
 * async methods to match the existing indexer contract.
 */

import { groupedCountSql, decodeCountGroups, type BaseCountGroup } from './grouped-count.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { ColumnSchema, validateColumnSchema, type ColumnConstraint } from './abstract-storage.js';
import { removeSqliteStoreFiles } from './drop-utils.js';
import { toWasmDbPath } from './wasm-path.js';
import { normalizePathDescendantOrSelfValues, pathDescendantOrSelfSqlValues } from './path-scope.js';
import { ensureWasmOpenableDb } from './wasm-wal-compat.js';
import {
    recordStorageInitializationFailure,
    recordStorageCleanupFailure,
    handoffStorageInitializationCleanup,
    type RetainStorageInitializationCleanup
} from './platform.js';

import {
    compileOrGroup,
    literalContainsPattern,
    type BaseIndexStoreProbeResult,
    type BaseQueryCondition,
    type BaseQueryOperator,
    type BaseQueryOptions,
    type IBaseIndexDB
} from './base-indexer.js';

const require = createRequire(import.meta.url);
const sqlite3Wasm = require('node-sqlite3-wasm') as {
    Database: new (dbPath: string) => {
        run(sql: string, params?: any[]): { changes?: number; lastInsertRowid?: number };
        get(sql: string, params?: any[]): Record<string, any> | undefined;
        all(sql: string, params?: any[]): Record<string, any>[];
        close(): void;
    };
};

const SUPPORTED_OPERATORS: BaseQueryOperator[] = [
    '=',
    '!=',
    '>',
    '<',
    '>=',
    '<=',
    'like',
    'contains_literal',
    'notlike',
    'in',
    'notin',
    'between',
    'notbetween',
    'path_descendant_or_self'
];

export function probeBaseIndexStoreWasm(dbPath: string): BaseIndexStoreProbeResult {
    const wasmDbPath = toWasmDbPath(dbPath);
    if (!fs.existsSync(wasmDbPath)) return 'missing';
    ensureWasmOpenableDb(wasmDbPath);
    let db: InstanceType<(typeof sqlite3Wasm)['Database']> | null = null;
    try {
        db = new sqlite3Wasm.Database(wasmDbPath);
        const table = db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", ['base_index']);
        if (!table) return 'missing';
        db.all('SELECT item_id FROM base_index LIMIT 1');
        return 'exists';
    } catch {
        return 'open_failed';
    } finally {
        db?.close();
    }
}

function quoteString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

export class BaseIndexDBWasm implements IBaseIndexDB {
    private db: InstanceType<(typeof sqlite3Wasm)['Database']>;
    private closed = false;
    private readonly tableName = 'base_index';
    private isInitialized = false;
    private readonly schema: ColumnSchema;
    private readonly validFields: string[];
    private readonly dbPath: string;
    private transactionDepth = 0;

    constructor(dbPath: string, schema: ColumnSchema, retainCleanup?: RetainStorageInitializationCleanup) {
        validateColumnSchema(schema);
        this.schema = schema;
        this.validFields = Object.keys(schema.columns);
        this.dbPath = toWasmDbPath(dbPath);

        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // 打开 WASM 独立库前执行 WAL 兼容检查。
        ensureWasmOpenableDb(this.dbPath);

        this.db = new sqlite3Wasm.Database(this.dbPath);
        try {
            this.db.run('PRAGMA journal_mode = WAL');
            this.db.run('PRAGMA busy_timeout = 5000');
            this.initializeTable();
        } catch (error) {
            // The caller cannot close a connection from a failed constructor.
            recordStorageInitializationFailure(error, { indexer: 'BaseIndexer', backend: 'wasm' });
            try {
                this.db.close();
            } catch (cleanupError) {
                recordStorageCleanupFailure(error, cleanupError, 'BaseIndexer');
                handoffStorageInitializationCleanup(error, () => this.close(), retainCleanup);
            }
            throw error;
        }
    }

    private initializeTable(): void {
        if (this.isInitialized) return;

        const columnDefs = Object.entries(this.schema.columns).map(([columnName, def]) =>
            this.buildColumnDef(columnName, def)
        );

        this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                ${columnDefs.join(',\n                ')}
            )
        `);

        this.ensureColumns();
        this.createIndexes();
        this.isInitialized = true;
    }

    private buildColumnDef(columnName: string, def: ColumnConstraint): string {
        let colDef = `${columnName} ${def.type}`;
        if (columnName === 'item_id') {
            colDef += ' PRIMARY KEY';
        } else {
            if (!def.nullable) {
                colDef += ' NOT NULL';
            }
            if (def.defaultValue !== undefined && def.defaultValue !== null) {
                colDef += ` DEFAULT ${typeof def.defaultValue === 'string' ? quoteString(def.defaultValue) : def.defaultValue}`;
            }
        }
        return colDef;
    }

    private ensureColumns(): void {
        const rows = this.db.all(`PRAGMA table_info(${this.tableName})`) as Array<{ name: string }>;
        const existing = new Set(rows.map((r) => r.name));
        for (const [colName, def] of Object.entries(this.schema.columns)) {
            if (existing.has(colName)) continue;
            this.db.run(`ALTER TABLE ${this.tableName} ADD COLUMN ${this.buildColumnDef(colName, def)}`);
        }
    }

    private createIndexes(): void {
        for (const column of this.validFields.filter((field) => field !== 'item_id')) {
            try {
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_base_${column} ON ${this.tableName}(${column})`);
            } catch (error) {
                console.warn(`Failed to create index for ${column}:`, error);
            }
        }
    }

    static getSupportedOperators(): BaseQueryOperator[] {
        return [...SUPPORTED_OPERATORS];
    }

    static isOperatorSupported(operator: string): operator is BaseQueryOperator {
        return SUPPORTED_OPERATORS.includes(operator.toLowerCase() as BaseQueryOperator);
    }

    private validateField(field: string): void {
        if (!this.validFields.includes(field)) {
            throw new Error(`Invalid field name: ${field}. Valid fields: ${this.validFields.join(', ')}`);
        }
    }

    private getRecordColumns(record: Record<string, any>): string[] {
        return this.validFields.filter((column) => record[column] !== undefined);
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

    private buildWhereClause(conditions: BaseQueryCondition[]): { whereClause: string; params: any[] } {
        const clauses: string[] = [];
        const params: any[] = [];

        for (const condition of conditions) {
            if ('or' in condition) {
                const group = compileOrGroup(condition.or, (child) => this.buildWhereClause([child]));
                clauses.push(group.whereClause);
                params.push(...group.params);
                continue;
            }
            const { field, operator, value } = condition;
            const op = operator.toLowerCase() as BaseQueryOperator;
            this.validateField(field);

            if (!BaseIndexDBWasm.isOperatorSupported(op)) {
                throw new Error(
                    `Unsupported operator: ${operator}. Supported operators: ${SUPPORTED_OPERATORS.join(', ')}`
                );
            }

            if (op === 'path_descendant_or_self') {
                const pathClauses = normalizePathDescendantOrSelfValues(value).map((pathValue) => {
                    const [normalizedPath, descendantPattern] = pathDescendantOrSelfSqlValues(pathValue);
                    params.push(normalizedPath, descendantPattern);
                    return `(${field} = ? OR ${field} LIKE ? ESCAPE '\\')`;
                });
                clauses.push(pathClauses.length === 1 ? pathClauses[0] : `(${pathClauses.join(' OR ')})`);
                continue;
            }

            if (op === 'in' || op === 'notin') {
                if (!Array.isArray(value)) {
                    throw new Error(`${operator} operator requires an array value`);
                }
                if (value.length === 0) {
                    clauses.push(op === 'in' ? '1 = 0' : '1 = 1');
                } else {
                    clauses.push(`${field} ${op === 'in' ? 'IN' : 'NOT IN'} (${value.map(() => '?').join(', ')})`);
                    params.push(...value);
                }
                continue;
            }

            if (op === 'between' || op === 'notbetween') {
                if (!Array.isArray(value) || value.length !== 2) {
                    throw new Error(`${operator} operator requires an array of two values [min, max]`);
                }
                clauses.push(`${field} ${op === 'between' ? 'BETWEEN' : 'NOT BETWEEN'} ? AND ?`);
                params.push(value[0], value[1]);
                continue;
            }

            if (op === '!=') {
                clauses.push(`${field} <> ?`);
                params.push(value);
                continue;
            }

            if (op === 'contains_literal') {
                clauses.push(`${field} LIKE ? ESCAPE '\\'`);
                params.push(literalContainsPattern(value));
                continue;
            }

            if (op === 'like') {
                clauses.push(`${field} LIKE ?`);
                params.push(value);
                continue;
            }

            if (op === 'notlike') {
                clauses.push(`${field} NOT LIKE ?`);
                params.push(value);
                continue;
            }

            clauses.push(`${field} ${op} ?`);
            params.push(value);
        }

        return {
            whereClause: clauses.length > 0 ? clauses.join(' AND ') : '1=1',
            params
        };
    }

    async insert(record: Record<string, any>): Promise<boolean> {
        return (await this.insertMany([record])) > 0;
    }

    async insertMany(records: Record<string, any>[]): Promise<number> {
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

    async upsert(record: Record<string, any>): Promise<boolean> {
        return (await this.upsertMany([record])) > 0;
    }

    async upsertMany(records: Record<string, any>[]): Promise<number> {
        if (records.length === 0) return 0;

        return this.withTransaction(() => {
            let count = 0;
            for (const record of records) {
                const columns = this.getRecordColumns(record);
                if (columns.length === 0) continue;
                const placeholders = columns.map(() => '?').join(', ');
                const values = columns.map((column) => record[column]);
                const updateColumns = columns.filter((column) => column !== 'item_id');
                const sql =
                    updateColumns.length === 0
                        ? `INSERT INTO ${this.tableName} (${columns.join(', ')})
                       VALUES (${placeholders})
                       ON CONFLICT(item_id) DO NOTHING`
                        : `INSERT INTO ${this.tableName} (${columns.join(', ')})
                       VALUES (${placeholders})
                       ON CONFLICT(item_id) DO UPDATE SET ${updateColumns.map((column) => `${column} = excluded.${column}`).join(', ')}`;
                const result = this.db.run(sql, values);
                count += result.changes ?? 0;
            }
            return count;
        });
    }

    async update(itemId: string, data: Record<string, any>): Promise<boolean> {
        const fields = Object.keys(data).filter(
            (key) => this.validFields.includes(key) && key !== 'item_id' && data[key] !== undefined
        );
        if (fields.length === 0) {
            throw new Error('No valid fields to update');
        }
        return (await this.updateMany([{ ...data, item_id: itemId }])) > 0;
    }

    async updateMany(records: Record<string, any>[]): Promise<number> {
        if (records.length === 0) return 0;

        return this.withTransaction(() => {
            let count = 0;
            for (const record of records) {
                const itemId = record.item_id;
                if (itemId === undefined) continue;

                const columns = this.getRecordColumns(record).filter((column) => column !== 'item_id');
                if (columns.length === 0) continue;

                const setClause = columns.map((field) => `${field} = ?`).join(', ');
                const diffClause = columns.map((field) => `${field} IS NOT ?`).join(' OR ');
                const values = columns.map((field) => record[field]);
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

    async updateWhere(field: string, value: any, conditions: BaseQueryCondition[]): Promise<number> {
        this.validateField(field);
        const { whereClause, params } = this.buildWhereClause(conditions);
        const result = this.db.run(`UPDATE ${this.tableName} SET ${field} = ? WHERE ${whereClause}`, [
            value,
            ...params
        ]);
        return result.changes ?? 0;
    }

    async delete(itemId: string): Promise<boolean> {
        const result = this.db.run(`DELETE FROM ${this.tableName} WHERE item_id = ?`, [itemId]);
        return (result.changes ?? 0) > 0;
    }

    async deleteMany(itemIds: string[]): Promise<number> {
        if (itemIds.length === 0) return 0;
        const placeholders = itemIds.map(() => '?').join(', ');
        const result = this.db.run(`DELETE FROM ${this.tableName} WHERE item_id IN (${placeholders})`, itemIds);
        return result.changes ?? 0;
    }

    async deleteByConditions(conditions: BaseQueryCondition[]): Promise<number> {
        if (conditions.length === 0) {
            throw new Error('At least one condition is required for deleteByConditions');
        }
        const { whereClause, params } = this.buildWhereClause(conditions);
        const result = this.db.run(`DELETE FROM ${this.tableName} WHERE ${whereClause}`, params);
        return result.changes ?? 0;
    }

    async findById(itemId: string): Promise<Record<string, any> | undefined> {
        return this.db.get(`SELECT * FROM ${this.tableName} WHERE item_id = ?`, [itemId]) ?? undefined;
    }

    async findByIds(itemIds: string[]): Promise<Record<string, any>[]> {
        if (itemIds.length === 0) return [];
        const placeholders = itemIds.map(() => '?').join(', ');
        return this.db.all(`SELECT * FROM ${this.tableName} WHERE item_id IN (${placeholders})`, itemIds);
    }

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
            sql += ' LIMIT ?';
            params.push(options.limit);
        }

        if (options?.offset !== undefined) {
            sql += ' OFFSET ?';
            params.push(options.offset);
        }

        return this.db.all(sql, params);
    }

    async search(
        conditions: BaseQueryCondition[],
        options?: Omit<BaseQueryOptions, 'conditions'>
    ): Promise<Record<string, any>[]> {
        return this.findAll({ ...options, conditions });
    }

    async countGrouped(fields: string[], conditions: BaseQueryCondition[] = []): Promise<BaseCountGroup[]> {
        const { whereClause, params } =
            conditions.length > 0 ? this.buildWhereClause(conditions) : { whereClause: '', params: [] };
        const sql = groupedCountSql(fields, this.validFields, whereClause);
        const rows = this.db.all(sql, params);
        return decodeCountGroups(fields, rows);
    }

    async count(conditions?: BaseQueryCondition[]): Promise<number> {
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
        if (this.closed) return;
        this.db.close();
        this.closed = true;
    }

    async dropStorage(): Promise<void> {
        this.close();
        removeSqliteStoreFiles(this.dbPath);
    }

    getSchema(): ColumnSchema {
        return this.schema;
    }

    getValidFields(): string[] {
        return [...this.validFields];
    }

    async getStats(): Promise<{ totalRecords: number; dbSize: number }> {
        const totalRecords = await this.count();
        const pageCountRow = this.db.get('PRAGMA page_count') as { page_count?: number } | undefined;
        const pageSizeRow = this.db.get('PRAGMA page_size') as { page_size?: number } | undefined;
        const dbSize = (pageCountRow?.page_count ?? 0) * (pageSizeRow?.page_size ?? 0);
        return { totalRecords, dbSize };
    }
}

export default BaseIndexDBWasm;
