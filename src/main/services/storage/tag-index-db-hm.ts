/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * TagIndexDBHm - 鸿蒙 OS 专用标签索引数据库
 *
 * 直接使用 hm_sqlite_addon.node 实现，公开方法与 TagIndexDB 一一对应（除同步/异步外）。
 * Indexer 层通过 await Promise.resolve() 统一调用两者。
 */

import path from 'path';
import fs from 'fs';
import { loadSqliteAddon, type HmSqliteAddon } from './hm-addon-loader.js';
import type {
    TagIndexRecord,
    QueryCondition,
    QueryOptions,
    UpdateData,
    TagQueryOperator,
    ITagIndexDB
} from './tag-indexer.js';

// ── SQL 工具（SELECT 需内联参数，addon 不支持 SELECT 的 ? 绑定）────
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
                i++;
            } else inSingle = !inSingle;
            continue;
        }
        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            out += ch;
            continue;
        }
        if (ch === '?' && !inSingle && !inDouble) {
            if (paramIndex >= params.length) throw new Error('Not enough SQL params');
            out += literal(params[paramIndex++]);
            continue;
        }
        out += ch;
    }
    return out;
}

const SUPPORTED_OPERATORS: TagQueryOperator[] = ['=', '!=', '>', '<', '>=', '<=', 'like', 'in'];

// ── TagIndexDBHm ──────────────────────────────────────────────────
export class TagIndexDBHm implements ITagIndexDB {
    private readonly addon: HmSqliteAddon;
    private db: unknown;
    private readonly dbPath: string;
    private readonly tableName = 'tag_index';
    private isInitialized = false;

    constructor(dbPath: string) {
        this.dbPath = dbPath;
        this.addon = loadSqliteAddon();
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this.db = this.addon.open(dbPath); // open 是同步的
    }

    private ensureOpen(): unknown {
        if (!this.db) throw new Error(`Database is not opened: ${this.dbPath}`);
        return this.db;
    }

    // SELECT（无参）或 DDL
    private async execSql(sql: string): Promise<any[]> {
        return this.addon.exec(this.ensureOpen(), sql);
    }

    // 写操作：INSERT / UPDATE / DELETE
    private async runSql(sql: string, params: any[] = []): Promise<void> {
        const stmt = await this.addon.prepare(this.ensureOpen(), sql);
        await this.addon.run(stmt, params);
    }

    // SELECT + 参数：内联字面量后调用 exec
    private async querySql(sql: string, params: any[] = []): Promise<any[]> {
        if (params.length === 0) return this.execSql(sql);
        return this.execSql(bindSqlLiterals(sql, params));
    }

    private async fetchExistingRecords(itemIds: string[]): Promise<Map<string, TagIndexRecord>> {
        const uniqueIds = Array.from(new Set(itemIds));
        if (uniqueIds.length === 0) return new Map();
        const placeholders = uniqueIds.map(() => '?').join(', ');
        const rows = await this.querySql(
            `SELECT item_id, item_type, tag FROM ${this.tableName} WHERE item_id IN (${placeholders})`,
            uniqueIds
        );
        return new Map((rows as TagIndexRecord[]).map((row) => [row.item_id, row]));
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

    // 懒加载建表（第一次调用时触发）
    private async ensureInitialized(): Promise<void> {
        if (this.isInitialized) return;
        await this.execSql(`PRAGMA journal_mode = WAL`);
        await this.execSql(`PRAGMA busy_timeout = 5000`);
        await this.execSql(`
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                item_id   TEXT PRIMARY KEY,
                item_type TEXT NOT NULL,
                tag       TEXT NOT NULL
            )
        `);
        await this.execSql(`CREATE INDEX IF NOT EXISTS idx_tag_item_type ON ${this.tableName}(item_type)`);
        await this.execSql(`CREATE INDEX IF NOT EXISTS idx_tag_tag ON ${this.tableName}(tag)`);
        this.isInitialized = true;
    }

    private buildWhereClause(conditions: QueryCondition[]): { sql: string; params: any[] } {
        const clauses: string[] = [];
        const params: any[] = [];
        for (const { field, operator, value } of conditions) {
            // 验证字段名，防止 SQL 注入
            if (!['item_id', 'item_type', 'tag'].includes(field)) {
                throw new Error(`Invalid field name: ${field}`);
            }
            const op = operator.toLowerCase() as TagQueryOperator;
            if (!SUPPORTED_OPERATORS.includes(op)) throw new Error(`Unsupported operator: ${operator}`);
            if (op === 'in') {
                if (!Array.isArray(value)) throw new Error('in operator requires array');
                if (value.length === 0) {
                    clauses.push('1 = 0');
                    continue;
                }
                const ph = value.map(() => '?').join(', ');
                clauses.push(`${field} IN (${ph})`);
                params.push(...value);
            } else if (op === '!=') {
                clauses.push(`${field} <> ?`);
                params.push(value);
            } else if (op === 'like') {
                clauses.push(`${field} LIKE ?`);
                params.push(value);
            } else {
                clauses.push(`${field} ${op} ?`);
                params.push(value);
            }
        }
        return { sql: clauses.join(' AND ') || '1=1', params };
    }

    async insert(record: TagIndexRecord): Promise<boolean> {
        await this.ensureInitialized();
        try {
            await this.runSql(`INSERT INTO ${this.tableName} (item_id, item_type, tag) VALUES (?, ?, ?)`, [
                record.item_id,
                record.item_type,
                record.tag
            ]);
            return true;
        } catch (error: any) {
            const msg = error?.message || String(error);
            if (msg.includes('UNIQUE constraint failed') || msg.includes('PRIMARYKEY'))
                throw new Error(`Record with item_id '${record.item_id}' already exists`);
            throw error;
        }
    }

    async insertMany(records: TagIndexRecord[]): Promise<number> {
        await this.ensureInitialized();
        if (records.length === 0) return 0;
        const existingRecords = await this.fetchExistingRecords(records.map((record) => record.item_id));
        return this.runTransaction(async () => {
            let count = 0;
            const seen = new Set(existingRecords.keys());
            for (const record of records) {
                if (seen.has(record.item_id)) continue;
                await this.runSql(`INSERT INTO ${this.tableName} (item_id, item_type, tag) VALUES (?, ?, ?)`, [
                    record.item_id,
                    record.item_type,
                    record.tag
                ]);
                seen.add(record.item_id);
                count++;
            }
            return count;
        });
    }

    async upsert(record: TagIndexRecord): Promise<boolean> {
        await this.ensureInitialized();
        await this.runSql(
            `INSERT INTO ${this.tableName} (item_id, item_type, tag) VALUES (?, ?, ?)
             ON CONFLICT(item_id) DO UPDATE SET item_type = excluded.item_type, tag = excluded.tag`,
            [record.item_id, record.item_type, record.tag]
        );
        return true;
    }

    async upsertMany(records: TagIndexRecord[]): Promise<number> {
        await this.ensureInitialized();
        if (records.length === 0) return 0;
        return this.runTransaction(async () => {
            let count = 0;
            for (const record of records) {
                await this.runSql(
                    `INSERT INTO ${this.tableName} (item_id, item_type, tag) VALUES (?, ?, ?)
                     ON CONFLICT(item_id) DO UPDATE SET item_type = excluded.item_type, tag = excluded.tag`,
                    [record.item_id, record.item_type, record.tag]
                );
                count++;
            }
            return count;
        });
    }

    async delete(itemId: string): Promise<boolean> {
        await this.ensureInitialized();
        if (!(await this.exists(itemId))) return false;
        await this.runSql(`DELETE FROM ${this.tableName} WHERE item_id = ?`, [itemId]);
        return true;
    }

    async deleteByConditions(conditions: QueryCondition[]): Promise<number> {
        await this.ensureInitialized();
        if (conditions.length === 0) throw new Error('At least one condition required');
        const countBefore = await this.count(conditions);
        const { sql, params } = this.buildWhereClause(conditions);
        await this.runSql(`DELETE FROM ${this.tableName} WHERE ${sql}`, params);
        return countBefore;
    }

    async deleteMany(itemIds: string[]): Promise<number> {
        await this.ensureInitialized();
        if (itemIds.length === 0) return 0;
        const countBefore = await this.count([{ field: 'item_id', operator: 'in', value: itemIds }]);
        const ph = itemIds.map(() => '?').join(', ');
        await this.runSql(`DELETE FROM ${this.tableName} WHERE item_id IN (${ph})`, itemIds);
        return countBefore;
    }

    async update(itemId: string, data: UpdateData): Promise<boolean> {
        await this.ensureInitialized();
        const fields = Object.keys(data).filter((key) => data[key as keyof UpdateData] !== undefined) as Array<
            keyof UpdateData
        >;
        if (fields.length === 0) throw new Error('No valid fields to update');
        if (!(await this.exists(itemId))) return false;
        const setClause = fields.map((f) => `${f} = ?`).join(', ');
        const params = [...fields.map((f) => data[f]), itemId];
        await this.runSql(`UPDATE ${this.tableName} SET ${setClause} WHERE item_id = ?`, params);
        return true;
    }

    async updateMany(records: TagIndexRecord[]): Promise<number> {
        await this.ensureInitialized();
        if (records.length === 0) return 0;
        const existingRecords = await this.fetchExistingRecords(records.map((record) => record.item_id));
        return this.runTransaction(async () => {
            let count = 0;
            const currentRecords = new Map(existingRecords);
            for (const record of records) {
                const existing = currentRecords.get(record.item_id);
                if (!existing) continue;
                if (existing.item_type === record.item_type && existing.tag === record.tag) continue;
                await this.runSql(`UPDATE ${this.tableName} SET item_type = ?, tag = ? WHERE item_id = ?`, [
                    record.item_type,
                    record.tag,
                    record.item_id
                ]);
                currentRecords.set(record.item_id, record);
                count++;
            }
            return count;
        });
    }

    async updateByConditions(conditions: QueryCondition[], data: UpdateData): Promise<number> {
        await this.ensureInitialized();
        const fields = Object.keys(data).filter((key) => data[key as keyof UpdateData] !== undefined) as Array<
            keyof UpdateData
        >;
        if (fields.length === 0) throw new Error('No valid fields to update');
        const countBefore = await this.count(conditions);
        const { sql: whereSql, params: whereParams } = this.buildWhereClause(conditions);
        const setClause = fields.map((f) => `${f} = ?`).join(', ');
        const params = [...fields.map((f) => data[f]), ...whereParams];
        await this.runSql(`UPDATE ${this.tableName} SET ${setClause} WHERE ${whereSql}`, params);
        return countBefore;
    }

    async findById(itemId: string): Promise<TagIndexRecord | undefined> {
        await this.ensureInitialized();
        const rows = await this.querySql(`SELECT * FROM ${this.tableName} WHERE item_id = ?`, [itemId]);
        return rows[0] as TagIndexRecord | undefined;
    }

    async findAll(options?: QueryOptions): Promise<TagIndexRecord[]> {
        await this.ensureInitialized();
        let sql = `SELECT * FROM ${this.tableName}`;
        const params: any[] = [];
        if (options?.conditions && options.conditions.length > 0) {
            const { sql: w, params: wp } = this.buildWhereClause(options.conditions);
            sql += ` WHERE ${w}`;
            params.push(...wp);
        }
        if (options?.orderBy) sql += ` ORDER BY ${options.orderBy.field} ${options.orderBy.direction}`;
        if (options?.limit !== undefined) {
            const limit = Math.trunc(Number(options.limit));
            if (!Number.isFinite(limit) || limit < 0) throw new Error(`Invalid limit value: ${options.limit}`);
            sql += ` LIMIT ${limit}`;
        }
        if (options?.offset !== undefined) {
            const offset = Math.trunc(Number(options.offset));
            if (!Number.isFinite(offset) || offset < 0) throw new Error(`Invalid offset value: ${options.offset}`);
            sql += ` OFFSET ${offset}`;
        }
        return this.querySql(sql, params) as Promise<TagIndexRecord[]>;
    }

    async search(conditions: QueryCondition[], options?: Omit<QueryOptions, 'conditions'>): Promise<TagIndexRecord[]> {
        return this.findAll({ ...options, conditions });
    }

    async count(conditions?: QueryCondition[]): Promise<number> {
        await this.ensureInitialized();
        let sql = `SELECT COUNT(*) as count FROM ${this.tableName}`;
        const params: any[] = [];
        if (conditions && conditions.length > 0) {
            const { sql: w, params: wp } = this.buildWhereClause(conditions);
            sql += ` WHERE ${w}`;
            params.push(...wp);
        }
        const rows = await this.querySql(sql, params);
        return (rows[0] as { count?: number })?.count ?? 0;
    }

    async exists(itemId: string): Promise<boolean> {
        await this.ensureInitialized();
        const rows = await this.querySql(`SELECT 1 AS present FROM ${this.tableName} WHERE item_id = ? LIMIT 1`, [
            itemId
        ]);
        return rows.length > 0;
    }

    async clear(): Promise<number> {
        await this.ensureInitialized();
        const countBefore = await this.count();
        await this.runSql(`DELETE FROM ${this.tableName}`);
        return countBefore;
    }

    async getStats(): Promise<{ totalRecords: number; dbSize: number }> {
        await this.ensureInitialized();
        const totalRecords = await this.count();
        // hm_sqlite_addon 暂不提供 PRAGMA page_count/page_size，返回 0 作为占位
        return { totalRecords, dbSize: 0 };
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
}

export default TagIndexDBHm;
