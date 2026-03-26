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
 * BaseIndexDBHm - 鸿蒙 OS 专用 Base 索引数据库
 *
 * 直接使用 hm_sqlite_addon.node 实现，与 BaseIndexDB（better-sqlite3 版）公开 API 一致。
 * 通过 BaseIndexer 使用。
 */

import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { ColumnSchema, validateColumnSchema } from './abstract-storage.js';
import type { BaseQueryCondition, BaseQueryOptions, BaseQueryOperator, IBaseIndexDB } from './base-indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const projectRoot = path.resolve(__dirname, '../../../../');
const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

// ── HM Addon 类型定义 ──────────────────────────────────────────────
type HmSqliteAddon = {
    open: (filename: string) => unknown;
    close: (db: unknown) => void;
    exec: (db: unknown, sql: string) => Promise<any[]>;
    beginTransaction: (db: unknown) => Promise<void>;
    commitTransaction: (db: unknown) => Promise<void>;
    rollbackTransaction: (db: unknown) => Promise<void>;
    prepare: (db: unknown, sql: string) => Promise<unknown>;
    run: (stmt: unknown, params: any[]) => Promise<void>;
};

const ARCH_CANDIDATES = [
    process.arch,
    process.arch === 'arm64' ? 'aarch64' : undefined,
    process.arch === 'x64' ? 'x86_64' : undefined
].filter(Boolean) as string[];

const ADDON_CANDIDATES = [
    process.env.HM_SQLITE_ADDON_PATH,
    ...(resourcesPath
        ? ARCH_CANDIDATES.map((arch) =>
              path.resolve(resourcesPath, 'native', 'openharmony', arch, 'hm_sqlite_addon.node')
          )
        : []),
    ...ARCH_CANDIDATES.map((arch) => path.resolve(projectRoot, 'native', 'openharmony', arch, 'hm_sqlite_addon.node'))
].filter(Boolean) as string[];

function loadAddon(): HmSqliteAddon {
    for (const addonPath of ADDON_CANDIDATES) {
        if (!fs.existsSync(addonPath)) continue;
        return require(addonPath) as HmSqliteAddon;
    }
    throw new Error(`hm_sqlite_addon not found. Tried: ${ADDON_CANDIDATES.join(', ')}`);
}

// ── SQL 绑定工具（鸿蒙 SELECT 不支持 prepared statement 参数，用字面量替换）──
function literal(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`Cannot bind non-finite number: ${value}`);
        return String(value);
    }
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
    throw new Error(`Unsupported SQL literal type: ${Object.prototype.toString.call(value)}`);
}

function bindSqlLiterals(sql: string, params: any[]): string {
    if (params.length === 0) return sql;
    let out = '',
        paramIndex = 0,
        inSingle = false,
        inDouble = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (ch === "'" && !inDouble) {
            const escaped = inSingle && i + 1 < sql.length && sql[i + 1] === "'";
            out += ch;
            if (escaped) {
                out += sql[i + 1];
                i += 1;
            } else inSingle = !inSingle;
            continue;
        }
        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            out += ch;
            continue;
        }
        if (ch === '?' && !inSingle && !inDouble) {
            out += literal(params[paramIndex++]);
            continue;
        }
        out += ch;
    }
    return out;
}

function isSelect(sql: string): boolean {
    return /^\s*(SELECT|WITH)\b/i.test(sql);
}

// ── BaseIndexDBHm 类 ──────────────────────────────────────────────
export class BaseIndexDBHm implements IBaseIndexDB {
    private readonly addon: HmSqliteAddon;
    private db: unknown = null;
    private readonly dbPath: string;
    private readonly tableName = 'base_index';
    private isInitialized = false;
    private readonly schema: ColumnSchema;
    private readonly validFields: string[];

    constructor(dbPath: string, schema: ColumnSchema) {
        validateColumnSchema(schema);
        this.schema = schema;
        this.validFields = Object.keys(schema.columns);
        this.dbPath = dbPath;
        this.addon = loadAddon();
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) return;
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this.db = this.addon.open(this.dbPath);
        await this.execSql(`PRAGMA journal_mode = WAL;`);
        await this.execSql(`PRAGMA busy_timeout = 5000;`);
        await this.initializeTable();
        this.isInitialized = true;
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.isInitialized) await this.initialize();
    }

    private ensureOpen(): unknown {
        if (!this.db) throw new Error(`Database is not opened: ${this.dbPath}`);
        return this.db;
    }

    private async execSql(sql: string): Promise<any[]> {
        return this.addon.exec(this.ensureOpen(), sql);
    }

    private async runSql(sql: string, params: any[] = []): Promise<void> {
        const stmt = await this.addon.prepare(this.ensureOpen(), sql);
        await this.addon.run(stmt, params);
    }

    /**
     * 统一 SQL 执行入口：
     * - SELECT：使用 exec()，其返回值是结果行数组。
     * - DML（INSERT/UPDATE/DELETE）：使用 prepare()+run() 执行参数化语句。
     *
     * 说明：当前 HM addon 对 SELECT 的参数绑定支持受限，因此 SELECT 带参数时先做字面量替换再 exec()；
     * DML 仍走参数化 runSql()。DML 不返回结果集，所以这里统一返回空数组。
     */
    private async queryAllSql(sql: string, params: any[] = []): Promise<any[]> {
        if (params.length === 0) return this.execSql(sql);
        if (!isSelect(sql)) {
            await this.runSql(sql, params);
            return [];
        }
        return this.execSql(bindSqlLiterals(sql, params));
    }

    private async queryOneSql(sql: string, params: any[] = []): Promise<any | undefined> {
        const rows = await this.queryAllSql(sql, params);
        return rows[0];
    }

    private async runTransaction<T>(fn: () => Promise<T>): Promise<T> {
        const db = this.ensureOpen();
        await this.addon.beginTransaction(db);
        try {
            const result = await fn();
            await this.addon.commitTransaction(db);
            return result;
        } catch (error) {
            try {
                await this.addon.rollbackTransaction(db);
            } catch {}
            throw error;
        }
    }

    private async initializeTable(): Promise<void> {
        const columnDefs: string[] = [];
        for (const columnName of Object.keys(this.schema.columns)) {
            const allowedDef = this.schema.columns[columnName];
            if (!allowedDef) continue;
            let colDef = `${columnName} ${allowedDef.type}`;
            if (columnName === 'item_id') {
                colDef += ' PRIMARY KEY';
            } else {
                if (!allowedDef.nullable) colDef += ' NOT NULL';
                if (allowedDef.defaultValue !== undefined && allowedDef.defaultValue !== null) {
                    const defaultVal =
                        typeof allowedDef.defaultValue === 'string'
                            ? `'${allowedDef.defaultValue.replace(/'/g, "''")}'`
                            : allowedDef.defaultValue;
                    colDef += ` DEFAULT ${defaultVal}`;
                }
            }
            columnDefs.push(colDef);
        }
        const createTableSQL = `CREATE TABLE IF NOT EXISTS ${this.tableName} (${columnDefs.join(', ')})`;
        await this.execSql(createTableSQL);
        const indexableColumns = this.validFields.filter((col) => col !== 'item_id');
        for (const column of indexableColumns) {
            try {
                await this.execSql(`CREATE INDEX IF NOT EXISTS idx_base_${column} ON ${this.tableName}(${column})`);
            } catch (error) {
                console.warn(`Failed to create index for ${column}:`, error);
            }
        }
    }

    private validateField(field: string): void {
        if (!this.validFields.includes(field))
            throw new Error(`Invalid field name: ${field}. Valid fields: ${this.validFields.join(', ')}`);
    }

    private getRecordColumns(record: Record<string, any>): string[] {
        return this.validFields.filter((col) => record[col] !== undefined);
    }

    private async loadExistingRows(itemIds: string[]): Promise<Map<string, Record<string, any>>> {
        const uniqueIds = [...new Set(itemIds)];
        if (uniqueIds.length === 0) return new Map();
        const placeholders = uniqueIds.map(() => '?').join(', ');
        const rows = (await this.queryAllSql(
            `SELECT * FROM ${this.tableName} WHERE item_id IN (${placeholders})`,
            uniqueIds
        )) as Record<string, any>[];
        return new Map(rows.filter((row) => row.item_id !== undefined).map((row) => [row.item_id, row]));
    }

    async insert(record: Record<string, any>): Promise<boolean> {
        await this.ensureInitialized();
        return (await this.insertMany([record])) > 0;
    }

    async insertMany(records: Record<string, any>[]): Promise<number> {
        await this.ensureInitialized();
        if (records.length === 0) return 0;
        const normalizedRecords = records.filter(
            (record) => record.item_id !== undefined && this.getRecordColumns(record).length > 0
        );
        if (normalizedRecords.length === 0) return 0;
        const existingRows = await this.loadExistingRows(normalizedRecords.map((record) => record.item_id));
        return this.runTransaction(async () => {
            let count = 0;
            const seenItemIds = new Set(existingRows.keys());
            for (const record of normalizedRecords) {
                const itemId = record.item_id;
                if (seenItemIds.has(itemId)) continue;
                seenItemIds.add(itemId);
                const columns = this.getRecordColumns(record);
                if (columns.length === 0) continue;
                const placeholders = columns.map(() => '?').join(', ');
                const values = columns.map((col) => record[col]);
                await this.runSql(
                    `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(item_id) DO NOTHING`,
                    values
                );
                count++;
            }
            return count;
        });
    }

    async upsert(record: Record<string, any>): Promise<boolean> {
        await this.ensureInitialized();
        return (await this.upsertMany([record])) > 0;
    }

    async upsertMany(records: Record<string, any>[]): Promise<number> {
        await this.ensureInitialized();
        if (records.length === 0) return 0;
        const normalizedRecords = records.filter(
            (record) => record.item_id !== undefined && this.getRecordColumns(record).length > 0
        );
        if (normalizedRecords.length === 0) return 0;
        const existingRows = await this.loadExistingRows(normalizedRecords.map((record) => record.item_id));
        return this.runTransaction(async () => {
            let count = 0;
            const currentRows = new Map(existingRows);
            for (const record of normalizedRecords) {
                const itemId = record.item_id;
                const columns = this.getRecordColumns(record);
                if (columns.length === 0) continue;
                const updateColumns = columns.filter((col) => col !== 'item_id');
                const existing = currentRows.get(itemId);
                if (!existing) {
                    const placeholders = columns.map(() => '?').join(', ');
                    const values = columns.map((col) => record[col]);
                    await this.runSql(
                        `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(item_id) DO NOTHING`,
                        values
                    );
                    count++;
                    currentRows.set(itemId, { ...record });
                    continue;
                }
                if (updateColumns.length === 0) continue;
                const hasChanges = updateColumns.some((col) => !Object.is(existing[col], record[col]));
                if (!hasChanges) continue;
                const setClause = updateColumns.map((col) => `${col} = ?`).join(', ');
                const values = [...updateColumns.map((col) => record[col]), itemId];
                await this.runSql(`UPDATE ${this.tableName} SET ${setClause} WHERE item_id = ?`, values);
                count++;
                currentRows.set(itemId, { ...existing, ...record });
            }
            return count;
        });
    }

    async delete(itemId: string): Promise<boolean> {
        await this.ensureInitialized();
        const existsBefore = await this.exists(itemId);
        if (!existsBefore) return false;
        await this.runSql(`DELETE FROM ${this.tableName} WHERE item_id = ?`, [itemId]);
        return true;
    }

    async deleteMany(itemIds: string[]): Promise<number> {
        await this.ensureInitialized();
        if (itemIds.length === 0) return 0;
        const placeholders = itemIds.map(() => '?').join(', ');
        const countBefore = await this.count([{ field: 'item_id', operator: 'in', value: itemIds }]);
        await this.runSql(`DELETE FROM ${this.tableName} WHERE item_id IN (${placeholders})`, itemIds);
        return countBefore;
    }

    async deleteByConditions(conditions: BaseQueryCondition[]): Promise<number> {
        await this.ensureInitialized();
        if (conditions.length === 0) throw new Error('At least one condition is required for deleteByConditions');
        const countBefore = await this.count(conditions);
        const { whereClause, params } = this.buildWhereClause(conditions);
        await this.runSql(`DELETE FROM ${this.tableName} WHERE ${whereClause}`, params);
        return countBefore;
    }

    async update(itemId: string, data: Record<string, any>): Promise<boolean> {
        await this.ensureInitialized();
        const fields = Object.keys(data).filter(
            (key) => this.validFields.includes(key) && key !== 'item_id' && data[key] !== undefined
        );
        if (fields.length === 0) throw new Error('No valid fields to update');
        const updated = await this.updateMany([{ ...data, item_id: itemId }]);
        return updated > 0;
    }

    async updateMany(records: Record<string, any>[]): Promise<number> {
        await this.ensureInitialized();
        if (records.length === 0) return 0;
        const normalizedRecords = records.filter(
            (record) => record.item_id !== undefined && this.getRecordColumns(record).some((col) => col !== 'item_id')
        );
        if (normalizedRecords.length === 0) return 0;
        const existingRows = await this.loadExistingRows(normalizedRecords.map((record) => record.item_id));
        return this.runTransaction(async () => {
            let count = 0;
            const currentRows = new Map(existingRows);
            for (const record of normalizedRecords) {
                const itemId = record.item_id;
                const columns = this.getRecordColumns(record).filter((col) => col !== 'item_id');
                if (columns.length === 0) continue;
                const existing = currentRows.get(itemId);
                if (!existing) continue;
                const hasChanges = columns.some((col) => !Object.is(existing[col], record[col]));
                if (!hasChanges) continue;
                const setClause = columns.map((field) => `${field} = ?`).join(', ');
                const values = [...columns.map((field) => record[field]), itemId];
                await this.runSql(`UPDATE ${this.tableName} SET ${setClause} WHERE item_id = ?`, values);
                count++;
                currentRows.set(itemId, { ...existing, ...record });
            }
            return count;
        });
    }

    async findById(itemId: string): Promise<Record<string, any> | undefined> {
        await this.ensureInitialized();
        return this.queryOneSql(`SELECT * FROM ${this.tableName} WHERE item_id = ?`, [itemId]) as Promise<
            Record<string, any> | undefined
        >;
    }

    async findByIds(itemIds: string[]): Promise<Record<string, any>[]> {
        await this.ensureInitialized();
        if (itemIds.length === 0) return [];
        const placeholders = itemIds.map(() => '?').join(', ');
        return this.queryAllSql(
            `SELECT * FROM ${this.tableName} WHERE item_id IN (${placeholders})`,
            itemIds
        ) as Promise<Record<string, any>[]>;
    }

    async findAll(options?: BaseQueryOptions): Promise<Record<string, any>[]> {
        await this.ensureInitialized();
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
        return this.queryAllSql(sql, params) as Promise<Record<string, any>[]>;
    }

    async search(
        conditions: BaseQueryCondition[],
        options?: Omit<BaseQueryOptions, 'conditions'>
    ): Promise<Record<string, any>[]> {
        return this.findAll({ ...options, conditions });
    }

    async count(conditions?: BaseQueryCondition[]): Promise<number> {
        await this.ensureInitialized();
        let sql = `SELECT COUNT(*) as count FROM ${this.tableName}`;
        const params: any[] = [];
        if (conditions && conditions.length > 0) {
            const { whereClause, params: whereParams } = this.buildWhereClause(conditions);
            sql += ` WHERE ${whereClause}`;
            params.push(...whereParams);
        }
        const row = (await this.queryOneSql(sql, params)) as { count?: number } | undefined;
        return row?.count ?? 0;
    }

    async exists(itemId: string): Promise<boolean> {
        await this.ensureInitialized();
        const row = await this.queryOneSql(`SELECT 1 AS present FROM ${this.tableName} WHERE item_id = ? LIMIT 1`, [
            itemId
        ]);
        return row !== undefined;
    }

    async clear(): Promise<number> {
        await this.ensureInitialized();
        const countBefore = await this.count();
        await this.runSql(`DELETE FROM ${this.tableName}`);
        return countBefore;
    }

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureInitialized();
        return this.runTransaction(fn);
    }

    close(): void {
        if (this.db) {
            this.addon.close(this.db);
            this.db = null;
        }
        this.isInitialized = false;
    }

    getSchema(): ColumnSchema {
        return this.schema;
    }
    getValidFields(): string[] {
        return [...this.validFields];
    }

    async getStats(): Promise<{ totalRecords: number; dbSize: number }> {
        await this.ensureInitialized();
        const totalRecords = await this.count();
        // hm_sqlite_addon 暂不提供 PRAGMA page_count/page_size，返回 0 作为占位
        return { totalRecords, dbSize: 0 };
    }

    private buildWhereClause(conditions: BaseQueryCondition[]): { whereClause: string; params: any[] } {
        const clauses: string[] = [];
        const params: any[] = [];
        for (const condition of conditions) {
            const { field, operator, value } = condition;
            const op = operator.toLowerCase() as BaseQueryOperator;
            this.validateField(field);
            if (op === 'in' || op === 'notin') {
                if (!Array.isArray(value)) throw new Error(`${operator} requires array`);
                if (value.length === 0) {
                    clauses.push(op === 'in' ? '1 = 0' : '1 = 1');
                } else {
                    const ph = value.map(() => '?').join(', ');
                    clauses.push(`${field} ${op === 'in' ? 'IN' : 'NOT IN'} (${ph})`);
                    params.push(...value);
                }
            } else if (op === 'between' || op === 'notbetween') {
                if (!Array.isArray(value) || value.length !== 2) throw new Error(`${operator} requires [min, max]`);
                clauses.push(`${field} ${op === 'between' ? 'BETWEEN' : 'NOT BETWEEN'} ? AND ?`);
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
        return { whereClause: clauses.length > 0 ? clauses.join(' AND ') : '1=1', params };
    }
}

export default BaseIndexDBHm;
