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
 * BM25IndexDBWasm
 *
 * HarmonyOS-friendly BM25 storage backed by node-sqlite3-wasm + FTS5.
 * FTS is used for candidate retrieval, while token overlap is used for
 * deterministic scoring to match the existing BM25IndexDB behavior.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { ColumnSchema } from './abstract-storage.js';
import type { BM25Record, BM25SearchOptions, BM25SearchResult, IBM25IndexDB } from './bm25-indexer.js';

const require = createRequire(import.meta.url);
const sqlite3Wasm = require('node-sqlite3-wasm') as {
    Database: new (dbPath: string) => {
        run(sql: string, params?: any[]): { changes?: number; lastInsertRowid?: number };
        get(sql: string, params?: any[]): Record<string, any> | undefined;
        all(sql: string, params?: any[]): Record<string, any>[];
        close(): void;
    };
};

type JiebaModule = {
    cut?: (text: string, hmm?: boolean) => string[];
    tokenize?: (text: string) => string[];
    with_dict?: () => { cut: (text: string, hmm?: boolean) => string[] };
};

type StoredDoc = {
    bm25_id: string;
    item_id: string;
    item_type: string;
    text: string;
    tokens: string[];
};

function normalizeText(text: string): string {
    return text.toLowerCase();
}

function buildMatchQuery(tokens: string[]): string {
    return tokens
        .map((token) => `"${token.replace(/"/g, '""')}"`)
        .join(' OR ');
}

export class BM25IndexDBWasm implements IBM25IndexDB {
    private db: InstanceType<(typeof sqlite3Wasm)['Database']>;
    private readonly dbPath: string;
    private readonly schema: ColumnSchema;
    private readonly tableName = 'bm25_index';
    private readonly supportedColumns: Set<string>;
    private isInitialized = false;
    private readonly jiebaCut: (text: string, hmm?: boolean) => string[];

    constructor(schema: ColumnSchema, dbPath: string) {
        this.schema = schema;
        this.dbPath = dbPath;
        this.supportedColumns = new Set(
            Object.entries(schema.needIndexers ?? {})
                .filter(([, indexers]) => indexers.some((item) => item.indexer === 'BM25Indexer'))
                .map(([columnName]) => columnName)
        );

        const jiebaMod = require('jieba-wasm') as JiebaModule;
        if (typeof jiebaMod.cut === 'function') {
            this.jiebaCut = jiebaMod.cut;
        } else if (typeof jiebaMod.tokenize === 'function') {
            this.jiebaCut = (text: string) => jiebaMod.tokenize!(text);
        } else if (typeof jiebaMod.with_dict === 'function') {
            this.jiebaCut = jiebaMod.with_dict().cut;
        } else {
            throw new Error('jieba-wasm does not expose a supported tokenization API');
        }

        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new sqlite3Wasm.Database(dbPath);
    }

    private ensureInitialized(): void {
        if (this.isInitialized) return;

        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA busy_timeout = 5000');
        this.db.run(`
            CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName}
            USING fts5(
                bm25_id UNINDEXED,
                item_id UNINDEXED,
                item_type UNINDEXED,
                text UNINDEXED,
                tokens,
                tokenize='unicode61'
            )
        `);

        this.isInitialized = true;
    }

    async initialize(): Promise<void> {
        this.ensureInitialized();
    }

    private tokenize(text: string): string[] {
        if (!text) return [];
        const tokens = this.jiebaCut(text, true);
        return tokens.map((token) => normalizeText(token)).filter((token) => token.trim().length > 0);
    }

    private rowToDoc(row: Record<string, any>): StoredDoc {
        const text = String(row.text ?? '');
        return {
            bm25_id: String(row.bm25_id ?? ''),
            item_id: String(row.item_id ?? ''),
            item_type: String(row.item_type ?? ''),
            text,
            tokens: this.tokenize(text),
        };
    }

    private upsertDoc(doc: StoredDoc): void {
        this.db.run(
            `DELETE FROM ${this.tableName} WHERE bm25_id = ?`,
            [doc.bm25_id]
        );
        this.db.run(
            `INSERT INTO ${this.tableName} (bm25_id, item_id, item_type, text, tokens)
             VALUES (?, ?, ?, ?, ?)`,
            [doc.bm25_id, doc.item_id, doc.item_type, doc.text, doc.tokens.join(' ')]
        );
    }

    async search(query: string, options?: BM25SearchOptions): Promise<BM25SearchResult[]> {
        this.ensureInitialized();
        if (!options?.columnName || (this.supportedColumns.size > 0 && !this.supportedColumns.has(options.columnName))) {
            return [];
        }

        const queryTokens = this.tokenize(query);
        if (queryTokens.length === 0) return [];

        const matchQuery = buildMatchQuery(queryTokens);
        const rows = this.db.all(
            `SELECT bm25_id, item_id, item_type, text
             FROM ${this.tableName}
             WHERE item_type = ? AND ${this.tableName} MATCH ?`,
            [options.columnName, matchQuery]
        );

        const topK = options.topK ?? 10;
        const results = rows
            .map((row) => {
                const doc = this.rowToDoc(row);
                const hitCount = queryTokens.filter((token) => doc.tokens.includes(token)).length;
                return {
                    item_id: doc.item_id,
                    item_type: doc.item_type,
                    text: doc.text,
                    score: hitCount,
                };
            })
            .filter((row) => row.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);

        return results;
    }

    async insert(records: BM25Record[]): Promise<void> {
        this.ensureInitialized();
        if (records.length === 0) return;

        this.db.run('BEGIN');
        try {
            for (const record of records) {
                const doc: StoredDoc = {
                    bm25_id: record.bm25_id,
                    item_id: record.item_id,
                    item_type: record.item_type,
                    text: record.text,
                    tokens: this.tokenize(record.text),
                };
                this.upsertDoc(doc);
            }
            this.db.run('COMMIT');
        } catch (error) {
            try {
                this.db.run('ROLLBACK');
            } catch {}
            throw error;
        }
    }

    async delete(itemIds: string[]): Promise<void> {
        this.ensureInitialized();
        if (itemIds.length === 0) return;

        this.db.run('BEGIN');
        try {
            for (const itemId of itemIds) {
                this.db.run(`DELETE FROM ${this.tableName} WHERE item_id = ?`, [itemId]);
            }
            this.db.run('COMMIT');
        } catch (error) {
            try {
                this.db.run('ROLLBACK');
            } catch {}
            throw error;
        }
    }

    async update(records: BM25Record[]): Promise<void> {
        this.ensureInitialized();
        if (records.length === 0) return;

        this.db.run('BEGIN');
        try {
            for (const record of records) {
                const doc: StoredDoc = {
                    bm25_id: record.bm25_id,
                    item_id: record.item_id,
                    item_type: record.item_type,
                    text: record.text,
                    tokens: this.tokenize(record.text),
                };
                this.upsertDoc(doc);
            }
            this.db.run('COMMIT');
        } catch (error) {
            try {
                this.db.run('ROLLBACK');
            } catch {}
            throw error;
        }
    }

    async existingItemIds(ids: string[]): Promise<Set<string>> {
        this.ensureInitialized();
        if (ids.length === 0) return new Set();
        const rows = this.db.all(
            `SELECT DISTINCT item_id FROM ${this.tableName} WHERE item_id IN (${ids.map(() => '?').join(', ')})`,
            ids
        ) as Array<{ item_id: string }>;
        return new Set(rows.map((row) => row.item_id));
    }

    async deleteByKeys(keys: Array<{ item_id: string; item_type: string }>): Promise<void> {
        this.ensureInitialized();
        if (keys.length === 0) return;

        this.db.run('BEGIN');
        try {
            for (const key of keys) {
                this.db.run(
                    `DELETE FROM ${this.tableName} WHERE item_id = ? AND item_type = ?`,
                    [key.item_id, key.item_type]
                );
            }
            this.db.run('COMMIT');
        } catch (error) {
            try {
                this.db.run('ROLLBACK');
            } catch {}
            throw error;
        }
    }

    close(): void {
        this.db.close();
    }

    async clear(): Promise<void> {
        this.ensureInitialized();
        this.db.run(`DELETE FROM ${this.tableName}`);
    }

    async count(): Promise<number> {
        this.ensureInitialized();
        const row = this.db.get(`SELECT COUNT(*) AS count FROM ${this.tableName}`) as { count?: number } | undefined;
        return row?.count ?? 0;
    }
}

export default BM25IndexDBWasm;
