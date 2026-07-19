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
 * BM25IndexDBHm - 鸿蒙平台 BM25 存储实现
 *
 * - 分词：自编译 jieba addon
 * - 存储：SQLite FTS5（hm_sqlite_addon.node）
 */

import path from 'path';
import fs from 'fs';
import { ColumnSchema } from './abstract-storage.js';
import { loadJiebaAddon, loadSqliteAddon, type HmSqliteAddon, type JiebaInstance } from './hm-addon-loader.js';
import type { BM25Record, BM25SearchOptions, BM25SearchResult, IBM25IndexDB } from './bm25-indexer.js';
import { removeSqliteStoreFiles } from './drop-utils.js';

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
            out += literal(params[paramIndex++]);
            continue;
        }

        out += ch;
    }

    return out;
}

export class BM25IndexDBHm implements IBM25IndexDB {
    private readonly addon: HmSqliteAddon;
    private readonly jieba: JiebaInstance;
    private db: unknown;
    private readonly dbPath: string;
    private readonly schema: ColumnSchema;
    private readonly tableName = 'bm25_index';
    private isInitialized = false;

    constructor(schema: ColumnSchema, dbPath: string) {
        this.schema = schema;
        this.dbPath = dbPath;
        this.addon = loadSqliteAddon();
        this.jieba = loadJiebaAddon();

        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this.db = this.addon.open(dbPath);
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

    private async querySql(sql: string, params: any[] = []): Promise<any[]> {
        if (params.length === 0) return this.execSql(sql);
        return this.execSql(bindSqlLiterals(sql, params));
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

    private tokenize(text: string): string[] {
        if (!text) return [];

        return this.jieba
            .cut(text, false)
            .map((t) => t.toLowerCase())
            .filter((t) => t.trim().length > 0);
    }

    private buildMatchExpression(query: string): string {
        const tokens = this.tokenize(query);
        if (tokens.length === 0) return '';

        return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ');
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) return;

        await this.execSql('PRAGMA journal_mode = WAL');
        await this.execSql('PRAGMA busy_timeout = 5000');
        await this.execSql(`
            CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName}
            USING fts5(
                bm25_id UNINDEXED,
                item_id UNINDEXED,
                item_type UNINDEXED,
                text,
                tokenize='unicode61'
            )
        `);

        this.isInitialized = true;
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.isInitialized) await this.initialize();
    }

    async search(query: string, options?: BM25SearchOptions): Promise<BM25SearchResult[]> {
        await this.ensureInitialized();

        const columnName = options?.columnName;
        if (!columnName || !(columnName in this.schema.needIndexers)) return [];

        const matchExpr = this.buildMatchExpression(query);
        if (!matchExpr) return [];

        const topK = Math.max(1, Math.trunc(Number(options?.topK)) || 10);
        const rows = (await this.querySql(
            `
            SELECT item_id, item_type, text, bm25(${this.tableName}) AS rank
            FROM ${this.tableName}
            WHERE item_type = ? AND text MATCH ?
            ORDER BY rank ASC
            LIMIT ?
            `,
            [columnName, matchExpr, topK * 2]
        )) as Array<{ item_id: string; item_type: string; text: string; rank: number }>;

        return rows.map((row) => ({
            item_id: row.item_id,
            item_type: row.item_type,
            text: row.text,
            score: -(row.rank ?? 0)
        }));
    }

    async insert(records: BM25Record[]): Promise<void> {
        await this.ensureInitialized();
        if (records.length === 0) return;

        await this.runTransaction(async () => {
            for (const record of records) {
                await this.runSql(`DELETE FROM ${this.tableName} WHERE item_id = ? AND item_type = ?`, [
                    record.item_id,
                    record.item_type
                ]);
                const tokenized = this.tokenize(record.text).join(' ');
                await this.runSql(
                    `INSERT INTO ${this.tableName}(bm25_id, item_id, item_type, text) VALUES (?, ?, ?, ?)`,
                    [record.bm25_id, record.item_id, record.item_type, tokenized]
                );
            }
        });
        await this.flush();
    }

    async delete(itemIds: string[]): Promise<void> {
        await this.ensureInitialized();
        if (itemIds.length === 0) return;

        await this.runTransaction(async () => {
            for (const itemId of itemIds) {
                await this.runSql(`DELETE FROM ${this.tableName} WHERE item_id = ?`, [itemId]);
            }
        });
        await this.flush();
    }

    async update(records: BM25Record[]): Promise<void> {
        await this.ensureInitialized();
        if (records.length === 0) return;

        await this.runTransaction(async () => {
            for (const record of records) {
                await this.runSql(`DELETE FROM ${this.tableName} WHERE item_id = ? AND item_type = ?`, [
                    record.item_id,
                    record.item_type
                ]);
                const tokenized = this.tokenize(record.text).join(' ');
                await this.runSql(
                    `INSERT INTO ${this.tableName}(bm25_id, item_id, item_type, text) VALUES (?, ?, ?, ?)`,
                    [record.bm25_id, record.item_id, record.item_type, tokenized]
                );
            }
        });
        await this.flush();
    }

    private async flush(): Promise<void> {
        await this.ensureInitialized();
    }

    async clear(): Promise<void> {
        await this.ensureInitialized();
        await this.runSql(`DELETE FROM ${this.tableName}`);
    }

    async existingItemIds(ids: string[]): Promise<Set<string>> {
        await this.ensureInitialized();
        if (ids.length === 0) return new Set();
        const rows = (await this.querySql(
            `SELECT DISTINCT item_id FROM ${this.tableName} WHERE item_id IN (${ids.map(() => '?').join(', ')})`,
            ids
        )) as { item_id: string }[];
        return new Set(rows.map((r) => r.item_id));
    }

    async deleteByKeys(keys: Array<{ item_id: string; item_type: string }>): Promise<void> {
        await this.ensureInitialized();
        if (keys.length === 0) return;
        await this.runTransaction(async () => {
            for (const key of keys) {
                await this.runSql(`DELETE FROM ${this.tableName} WHERE item_id = ? AND item_type = ?`, [
                    key.item_id,
                    key.item_type
                ]);
            }
        });
        await this.flush();
    }

    async count(): Promise<number> {
        await this.ensureInitialized();
        const rows = await this.execSql(`SELECT COUNT(*) as count FROM ${this.tableName}`);
        return (rows[0] as { count?: number })?.count ?? 0;
    }

    close(): void {
        if (this.db) {
            this.addon.close(this.db);
            this.db = null;
        }
        this.isInitialized = false;
    }

    async dropStorage(): Promise<void> {
        this.close();
        removeSqliteStoreFiles(this.dbPath);
    }
}

export default BM25IndexDBHm;
