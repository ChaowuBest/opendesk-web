/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * BM25IndexDBHm - 鸿蒙平台 BM25 存储实现
 *
 * - 分词：自编译 jieba addon
 * - 存储：SQLite FTS5（hm_sqlite_addon.node）
 */

import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { ColumnSchema } from './abstract-storage.js';
import type { BM25Record, BM25SearchOptions, BM25SearchResult, IBM25IndexDB } from './bm25-indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const projectRoot = path.resolve(__dirname, '../../../../');
const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

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

type JiebaInstance = {
    cut: (text: string, hmm?: boolean) => string[];
};

type JiebaAddon = {
    Jieba: {
        withEmbeddedDict?: () => JiebaInstance;
    };
};

const ARCH_CANDIDATES = [
    process.arch,
    process.arch === 'arm64' ? 'aarch64' : undefined,
    process.arch === 'x64' ? 'x86_64' : undefined
].filter(Boolean) as string[];

const SQLITE_ADDON_CANDIDATES = [
    process.env.HM_SQLITE_ADDON_PATH,
    ...(resourcesPath
        ? ARCH_CANDIDATES.map((arch) =>
              path.resolve(resourcesPath, 'native', 'openharmony', arch, 'hm_sqlite_addon.node')
          )
        : []),
    ...ARCH_CANDIDATES.map((arch) => path.resolve(projectRoot, 'native', 'openharmony', arch, 'hm_sqlite_addon.node'))
].filter(Boolean) as string[];

function unique(items: string[]): string[] {
    return [...new Set(items)];
}

function loadSqliteAddon(): HmSqliteAddon {
    for (const addonPath of unique(SQLITE_ADDON_CANDIDATES)) {
        if (!fs.existsSync(addonPath)) continue;
        return require(addonPath) as HmSqliteAddon;
    }
    throw new Error(`hm_sqlite_addon not found. Tried: ${SQLITE_ADDON_CANDIDATES.join(', ')}`);
}

function loadJieba(): JiebaInstance {
    const jiebaEnvPath = process.env.HM_JIEBA_ADDON_PATH;

    const jiebaNameCandidates = ARCH_CANDIDATES.flatMap((arch) => [
        `jieba.${arch}-unknown-linux-musl.node`,
        `jieba.${arch}.node`
    ]).concat(['hm_jieba_addon.node', 'jieba.node']);

    const baseDirs = [
        ...(resourcesPath
            ? ARCH_CANDIDATES.map((arch) => path.resolve(resourcesPath, 'native', 'openharmony', arch))
            : []),
        ...ARCH_CANDIDATES.map((arch) => path.resolve(projectRoot, 'native', 'openharmony', arch))
    ];

    const jiebaCandidates = [
        jiebaEnvPath,
        ...baseDirs.flatMap((dir) => jiebaNameCandidates.map((name) => path.resolve(dir, name)))
    ].filter(Boolean) as string[];

    let jiebaAddon: JiebaAddon | null = null;
    for (const addonPath of unique(jiebaCandidates)) {
        if (!fs.existsSync(addonPath)) continue;
        jiebaAddon = require(addonPath) as JiebaAddon;
        break;
    }

    if (!jiebaAddon) {
        throw new Error(`hm jieba addon not found. Tried: ${jiebaCandidates.join(', ')}`);
    }

    if (!jiebaAddon.Jieba?.withEmbeddedDict) {
        throw new Error(
            'hm jieba addon does not support Jieba.withEmbeddedDict(). ' +
                'Please rebuild native addon with embedded dict.'
        );
    }

    return jiebaAddon.Jieba.withEmbeddedDict();
}

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
        this.jieba = loadJieba();

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
                await this.runSql(
                    `DELETE FROM ${this.tableName} WHERE item_id = ? AND item_type = ?`,
                    [record.item_id, record.item_type]
                );
                const tokenized = this.tokenize(record.text).join(' ');
                await this.runSql(
                    `INSERT INTO ${this.tableName}(bm25_id, item_id, item_type, text) VALUES (?, ?, ?, ?)`,
                    [record.bm25_id, record.item_id, record.item_type, tokenized]
                );
            }
        });
    }

    async delete(itemIds: string[]): Promise<void> {
        await this.ensureInitialized();
        if (itemIds.length === 0) return;

        await this.runTransaction(async () => {
            for (const itemId of itemIds) {
                await this.runSql(`DELETE FROM ${this.tableName} WHERE item_id = ?`, [itemId]);
            }
        });
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
    }

    async flush(): Promise<void> {
        await this.ensureInitialized();
    }

    async deleteAll(): Promise<void> {
        await this.ensureInitialized();
        await this.runSql(`DELETE FROM ${this.tableName}`);
    }

    async count(): Promise<number> {
        await this.ensureInitialized();
        const rows = await this.execSql(
            `SELECT COUNT(*) as count FROM ${this.tableName}`
        );
        return (rows[0] as { count?: number })?.count ?? 0;
    }

    close(): void {
        if (this.db) {
            this.addon.close(this.db);
            this.db = null;
        }
        this.isInitialized = false;
    }
}

export default BM25IndexDBHm;
