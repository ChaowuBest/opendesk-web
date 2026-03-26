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
 * ChunkIndexDBHm — 鸿蒙 OS 专用分块向量索引数据库
 *
 * 直接使用 hm_sqlite_addon.node 实现，公开方法与 ChunkIndexDB 一一对应。
 * 鸿蒙内置 vec0 支持，不需要 sqlite-vec 扩展。
 * 向量数据（Float32Array）需转为 X'hex' 字面量内联到 SQL 中（addon 不支持 blob 绑定）。
 */

import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import type { ChunkIndexRecord, ChunkSearchResult, ChunkSearchOptions, IChunkIndexDB } from './chunk-indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const projectRoot = path.resolve(__dirname, '../../../../');
const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

// ── HM Addon 类型定义 ─────────────────────────────────────────────
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
  process.arch === 'x64' ? 'x86_64' : undefined,
].filter(Boolean) as string[];

const ADDON_CANDIDATES = [
  process.env.HM_SQLITE_ADDON_PATH,
  ...(resourcesPath
    ? ARCH_CANDIDATES.map((arch) =>
        path.resolve(resourcesPath, 'native', 'openharmony', arch, 'hm_sqlite_addon.node')
      )
    : []),
  ...ARCH_CANDIDATES.map((arch) =>
    path.resolve(projectRoot, 'native', 'openharmony', arch, 'hm_sqlite_addon.node')
  ),
].filter(Boolean) as string[];

function loadAddon(): HmSqliteAddon {
  for (const addonPath of ADDON_CANDIDATES) {
    if (!fs.existsSync(addonPath)) continue;
    return require(addonPath) as HmSqliteAddon;
  }
  throw new Error(`hm_sqlite_addon not found. Tried: ${ADDON_CANDIDATES.join(', ')}`);
}

// ── Float32Array → X'hex' 字面量（用于 vec0 虚拟表内联）────────────
function float32ToHexLiteral(arr: Float32Array | number[]): string {
    const fa = arr instanceof Float32Array ? arr : new Float32Array(arr);
    const buf = Buffer.from(fa.buffer, fa.byteOffset, fa.byteLength);
    return `X'${buf.toString('hex')}'`;
}

// ── SQL 字符串转义（防止注入）──────────────────────────────────────
function escapeStr(s: string): string {
    return s.replace(/'/g, "''");
}

export class ChunkIndexDBHm implements IChunkIndexDB {
    private readonly addon: HmSqliteAddon;
    private db: unknown;
    private readonly dbPath: string;
    private readonly metaTableName = 'chunk_index_meta';
    private readonly vecTableName = 'chunk_index_vec';
    private readonly dimension: number;
    private isInitialized = false;

    constructor(dbPath: string, dimension: number = 1024) {
        this.dimension = dimension;
        this.dbPath = dbPath;
        this.addon = loadAddon();
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

    private async runTransaction<T>(fn: () => Promise<T>): Promise<T> {
        const db = this.ensureOpen();
        await this.addon.beginTransaction(db);
        try {
            const result = await fn();
            await this.addon.commitTransaction(db);
            return result;
        } catch (error) {
            try { await this.addon.rollbackTransaction(db); } catch {}
            throw error;
        }
    }

    private async ensureInitialized(): Promise<void> {
        if (this.isInitialized) return;
        await this.execSql(`PRAGMA journal_mode = WAL`);
        await this.execSql(`PRAGMA busy_timeout = 5000`);
        await this.execSql(`
            CREATE TABLE IF NOT EXISTS ${this.metaTableName} (
                chunk_pk   TEXT PRIMARY KEY,
                item_id    TEXT NOT NULL,
                chunk_id   TEXT NOT NULL,
                chunk_text TEXT NOT NULL
            )
        `);
        await this.execSql(`
            CREATE INDEX IF NOT EXISTS idx_chunk_item_id
            ON ${this.metaTableName}(item_id)
        `);
        await this.execSql(`
            CREATE VIRTUAL TABLE IF NOT EXISTS ${this.vecTableName} USING vec0(
                chunk_pk TEXT PRIMARY KEY,
                repr float[${this.dimension}]
            )
        `);
        this.isInitialized = true;
    }

    private validateDimension(repr: Float32Array | number[]): void {
        if (repr.length !== this.dimension) {
            throw new Error(`Vector dimension mismatch: expected ${this.dimension}, got ${repr.length}`);
        }
    }

    async getStoredDim(): Promise<number | null> {
        await this.ensureInitialized();
        const rows = await this.execSql(
            `SELECT vec_length(repr) as dim FROM ${this.vecTableName} LIMIT 1`
        ) as Array<{ dim: number }>;
        return rows[0]?.dim ?? null;
    }

    async existingItemIds(ids: string[]): Promise<Set<string>> {
        if (ids.length === 0) return new Set();
        await this.ensureInitialized();
        const idList = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
        const rows = await this.execSql(
            `SELECT DISTINCT item_id FROM ${this.metaTableName} WHERE item_id IN (${idList})`
        ) as { item_id: string }[];
        return new Set(rows.map(row => row.item_id));
    }

    async insertMany(records: ChunkIndexRecord[]): Promise<number> {
        await this.ensureInitialized();
        if (records.length === 0) return 0;
        const pkList = records.map(record => `'${record.chunk_pk.replace(/'/g, "''")}'`).join(', ');
        const existingRows = await this.execSql(
            `SELECT chunk_pk FROM ${this.metaTableName} WHERE chunk_pk IN (${pkList})`
        ) as { chunk_pk: string }[];
        const existingSet = new Set(existingRows.map(row => row.chunk_pk));
        const toInsert = records.filter(record => !existingSet.has(record.chunk_pk));
        if (toInsert.length === 0) return 0;
        return this.runTransaction(async () => {
            let count = 0;
            for (const record of toInsert) {
                this.validateDimension(record.repr);
                const hexRepr = float32ToHexLiteral(record.repr);
                await this.runSql(
                    `INSERT OR IGNORE INTO ${this.metaTableName} (chunk_pk, item_id, chunk_id, chunk_text) VALUES (?, ?, ?, ?)`,
                    [record.chunk_pk, record.item_id, record.chunk_id, record.chunk_text]
                );
                await this.execSql(`DELETE FROM ${this.vecTableName} WHERE chunk_pk = '${escapeStr(record.chunk_pk)}'`);
                await this.execSql(`
                    INSERT INTO ${this.vecTableName} (chunk_pk, repr)
                    VALUES ('${escapeStr(record.chunk_pk)}', ${hexRepr})
                `);
                count++;
            }
            return count;
        });
    }

    async deleteByItemId(itemId: string): Promise<number> {
        await this.ensureInitialized();
        return this.runTransaction(async () => {
            const rows = await this.execSql(
                `SELECT chunk_pk FROM ${this.metaTableName} WHERE item_id = '${escapeStr(itemId)}'`
            ) as Array<{ chunk_pk: string }>;
            for (const row of rows) {
                await this.execSql(`DELETE FROM ${this.vecTableName} WHERE chunk_pk = '${escapeStr(row.chunk_pk)}'`);
            }
            await this.runSql(`DELETE FROM ${this.metaTableName} WHERE item_id = ?`, [itemId]);
            return rows.length;
        });
    }

    async deleteManyByItemId(itemIds: string[]): Promise<number> {
        if (itemIds.length === 0) return 0;
        let total = 0;
        for (const id of itemIds) {
            total += await this.deleteByItemId(id);
        }
        return total;
    }

    async search(
        queryVector: Float32Array | number[],
        options?: ChunkSearchOptions,
        filterItemIds?: string[]
    ): Promise<ChunkSearchResult[]> {
        await this.ensureInitialized();
        this.validateDimension(queryVector);
        const hexVec = float32ToHexLiteral(queryVector);
        const metric = options?.metric || 'cosine';
        const distanceFunc = (() => {
            switch (metric) {
                case 'cosine':
                case 'dot_product': return 'vec_distance_cosine';
                case 'euclidean':   return 'vec_distance_L2';
                case 'manhattan':   return 'vec_distance_L1';
                default:            return 'vec_distance_cosine';
            }
        })();
        const topK = Math.max(1, Math.trunc(Number(options?.topK)) || 10);

        let sql: string;
        if (filterItemIds && filterItemIds.length > 0) {
            const idList = filterItemIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
            sql = `
                SELECT m.item_id, m.chunk_id, m.chunk_text,
                       ${distanceFunc}(v.repr, ${hexVec}) AS distance
                FROM ${this.metaTableName} m
                JOIN ${this.vecTableName} v ON v.chunk_pk = m.chunk_pk
                WHERE m.item_id IN (${idList})
                ORDER BY distance ASC
                LIMIT ${topK}
            `;
        } else {
            sql = `
                SELECT m.item_id, m.chunk_id, m.chunk_text,
                       ${distanceFunc}(v.repr, ${hexVec}) AS distance
                FROM ${this.metaTableName} m
                JOIN ${this.vecTableName} v ON v.chunk_pk = m.chunk_pk
                ORDER BY distance ASC
                LIMIT ${topK}
            `;
        }

        const rows = await this.execSql(sql) as Array<{
            item_id: string; chunk_id: string; chunk_text: string; distance: number;
        }>;

        const results: ChunkSearchResult[] = rows.map(row => ({
            item_id: row.item_id,
            chunk_id: row.chunk_id,
            chunk_text: row.chunk_text,
            distance: row.distance,
            similarity: (() => {
                switch (metric) {
                    case 'cosine':
                    case 'dot_product': return Math.max(0, Math.min(1, 1 - row.distance / 2));
                    case 'euclidean':
                    case 'manhattan':   return 1 / (1 + row.distance);
                    default:            return 1 - row.distance;
                }
            })(),
        }));

        if (options?.threshold !== undefined) {
            return results.filter(r => r.similarity >= options.threshold!);
        }
        return results;
    }

    close(): void {
        if (this.db) { this.addon.close(this.db); this.db = null; }
        this.isInitialized = false;
    }

    async count(): Promise<number> {
        await this.ensureInitialized();
        const rows = await this.execSql(`SELECT COUNT(*) as count FROM ${this.metaTableName}`);
        return (rows[0] as { count?: number })?.count ?? 0;
    }

    async clear(): Promise<number> {
        await this.ensureInitialized();
        const countBefore = await this.count();
        await this.execSql(`DELETE FROM ${this.metaTableName}`);
        await this.execSql(`DELETE FROM ${this.vecTableName}`);
        return countBefore;
    }

    getDimension(): number {
        return this.dimension;
    }
}

export default ChunkIndexDBHm;
