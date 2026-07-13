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

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { HnswAdapter, HnswPoint } from './hnsw-adapter.js';
import { DimMismatchError, SemanticWriteAvailability, SimilarityMetric } from './abstract-storage.js';
import type { BaseIndexStoreProbeResult } from './base-indexer.js';
import type { IVectorIndexDB, VectorIndexRecord, VectorSearchOptions, VectorSearchResult } from './vector-indexer.js';
import { removeSqliteStoreFiles } from './drop-utils.js';
import { HNSW_SAFE_TOTAL_BUDGET, shouldSkipLoadSnapshot } from './hnsw-snapshot-guard.js';
import { toWasmDbPath } from './wasm-path.js';

const require = createRequire(import.meta.url);
const sqlite3Wasm = require('node-sqlite3-wasm') as {
    Database: new (dbPath: string) => {
        run(sql: string, params?: any[]): { changes?: number; lastInsertRowid?: number };
        get(sql: string, params?: any[]): Record<string, any> | undefined;
        all(sql: string, params?: any[]): Record<string, any>[];
        close(): void;
    };
};

const SMALL_FILTER_THRESHOLD = 64;
const ANN_OVERFETCH_MULTIPLIER = 8;
const STALE_COMPACT_RATIO = 0.2;

export function probeVectorIndexStoreWasm(dbPath: string): BaseIndexStoreProbeResult {
    const wasmDbPath = toWasmDbPath(dbPath);
    if (!fs.existsSync(wasmDbPath)) return 'missing';
    let db: InstanceType<(typeof sqlite3Wasm)['Database']> | null = null;
    try {
        db = new sqlite3Wasm.Database(wasmDbPath);
        const table = db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", ['vector_index_meta']);
        if (!table) return 'missing';
        db.all('SELECT item_id FROM vector_index_meta LIMIT 1');
        return 'exists';
    } catch {
        return 'open_failed';
    } finally {
        db?.close();
    }
}

export async function dropVectorIndexStoreWasm(dbPath: string): Promise<void> {
    const wasmDbPath = toWasmDbPath(dbPath);
    removeSqliteStoreFiles(wasmDbPath, [`${wasmDbPath}.hnsw.json`]);
}

type VectorRow = {
    point_id: string;
    vector_id: string;
    item_id: string;
    item_type: string;
    active: number;
    repr: Uint8Array;
};

function toBuffer(repr: Float32Array | number[]): Buffer {
    const arr = repr instanceof Float32Array ? repr : new Float32Array(repr);
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function toVector(blob: Uint8Array): number[] {
    const buffer = Buffer.from(blob);
    const view = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        Math.floor(buffer.byteLength / Float32Array.BYTES_PER_ELEMENT)
    );
    return Array.from(view);
}

function similarityToDistance(similarity: number, metric: SimilarityMetric): number {
    switch (metric) {
        case 'cosine':
        case 'dot_product':
            return 1 - similarity;
        case 'euclidean':
        case 'manhattan':
            return Math.max(0, 1 / Math.max(similarity, Number.EPSILON) - 1);
        default:
            return 1 - similarity;
    }
}

function computeMetric(
    query: number[],
    candidate: number[],
    metric: SimilarityMetric
): { similarity: number; distance: number } {
    if (query.length !== candidate.length) {
        throw new Error(`Vector dimension mismatch: expected ${query.length}, got ${candidate.length}`);
    }

    switch (metric) {
        case 'euclidean': {
            let sum = 0;
            for (let i = 0; i < query.length; i++) {
                const delta = query[i] - candidate[i];
                sum += delta * delta;
            }
            const distance = Math.sqrt(sum);
            return { distance, similarity: 1 / (1 + distance) };
        }
        case 'manhattan': {
            let distance = 0;
            for (let i = 0; i < query.length; i++) {
                distance += Math.abs(query[i] - candidate[i]);
            }
            return { distance, similarity: 1 / (1 + distance) };
        }
        case 'dot_product': {
            let similarity = 0;
            for (let i = 0; i < query.length; i++) {
                similarity += query[i] * candidate[i];
            }
            return { similarity, distance: similarityToDistance(similarity, metric) };
        }
        case 'cosine':
        default: {
            let dot = 0;
            let normQuery = 0;
            let normCandidate = 0;
            for (let i = 0; i < query.length; i++) {
                dot += query[i] * candidate[i];
                normQuery += query[i] * query[i];
                normCandidate += candidate[i] * candidate[i];
            }
            const denom = Math.sqrt(normQuery) * Math.sqrt(normCandidate);
            const similarity = denom === 0 ? 0 : dot / denom;
            return { similarity, distance: 1 - similarity };
        }
    }
}

export class VectorIndexDBWasm implements IVectorIndexDB {
    readonly backend = 'wasm' as const;
    private readonly db: InstanceType<(typeof sqlite3Wasm)['Database']>;
    private readonly dbPath: string;
    private readonly dimension: number;
    private readonly tableName = 'vector_index_meta';
    private readonly hnswMetadataTableName = 'hnsw_metadata';
    private readonly snapshotPath: string;
    private readonly hnsw: HnswAdapter;
    private initPromise: Promise<void> | null = null;
    private writeQueue: Promise<void> = Promise.resolve();
    private closed = false;
    private activeCount = 0;
    private activeCountByItemType = new Map<string, number>();
    private pointCap = 0;

    constructor(dbPath: string, dimension: number = 1024) {
        this.dbPath = toWasmDbPath(dbPath);
        this.dimension = dimension;
        this.pointCap = Math.floor(HNSW_SAFE_TOTAL_BUDGET / this.dimension);
        this.snapshotPath = `${this.dbPath}.hnsw.json`;

        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new sqlite3Wasm.Database(this.dbPath);
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA busy_timeout = 5000');
        this.hnsw = new HnswAdapter(this.dimension, this.snapshotPath, { metric: 'cosine' });
        this.initPromise = this.initializeInternal();
    }

    private validateOpen(): void {
        if (this.closed) {
            throw new Error(`Database is closed: ${this.dbPath}`);
        }
    }

    private async ensureInitialized(): Promise<void> {
        this.validateOpen();
        if (!this.initPromise) {
            this.initPromise = this.initializeInternal();
        }
        await this.initPromise;
    }

    private initializeInternal(): Promise<void> {
        return Promise.resolve().then(async () => {
            this.db.run(`
                CREATE TABLE IF NOT EXISTS ${this.tableName} (
                    point_id   TEXT PRIMARY KEY,
                    vector_id  TEXT NOT NULL,
                    item_id    TEXT NOT NULL,
                    item_type  TEXT NOT NULL,
                    active     INTEGER NOT NULL DEFAULT 1,
                    repr       BLOB NOT NULL,
                    created_at INTEGER NOT NULL
                )
            `);
            this.db.run(`
                CREATE TABLE IF NOT EXISTS ${this.hnswMetadataTableName} (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            `);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_vector_vector_id ON ${this.tableName}(vector_id)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_vector_item_id ON ${this.tableName}(item_id)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_vector_item_type ON ${this.tableName}(item_type)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_vector_active ON ${this.tableName}(active)`);
            this.db.run(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_vector_active_vector_id
                ON ${this.tableName}(vector_id)
                WHERE active = 1
            `);
            this.refreshActiveCounts();
            this.assertStoredDimension();

            try {
                const dirty = this.getState('hnsw_dirty') === '1';
                const snapshotExists = fs.existsSync(this.snapshotPath);
                const snapshotSizeBytes = snapshotExists ? fs.statSync(this.snapshotPath).size : 0;
                const skipLoad = shouldSkipLoadSnapshot({
                    activeCount: this.activeCount,
                    pointCap: this.pointCap,
                    dirty,
                    snapshotSizeBytes
                });
                if (!skipLoad && snapshotExists) {
                    await this.hnsw.loadSnapshot();
                } else {
                    await this.rebuildIndexLocked();
                }
            } catch {
                await this.rebuildIndexLocked();
            }
        });
    }

    private getState(key: string): string | null {
        const row = this.db.get(`SELECT value FROM ${this.hnswMetadataTableName} WHERE key = ?`, [key]) as
            | { value?: string }
            | undefined;
        return row?.value ?? null;
    }

    private setState(key: string, value: string): void {
        this.db.run(
            `INSERT INTO ${this.hnswMetadataTableName} (key, value)
             VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [key, value]
        );
    }

    private refreshActiveCounts(): void {
        const rows = this.db.all(
            `SELECT item_type, COUNT(*) as cnt
             FROM ${this.tableName}
             WHERE active = 1
             GROUP BY item_type`
        ) as Array<{ item_type: string; cnt: number }>;
        this.activeCountByItemType = new Map();
        this.activeCount = 0;
        for (const row of rows) {
            this.activeCountByItemType.set(row.item_type, row.cnt);
            this.activeCount += row.cnt;
        }
    }

    async getWriteState(): Promise<SemanticWriteAvailability> {
        await this.ensureInitialized();
        return this.activeCount >= this.pointCap
            ? {
                  acceptingWrites: false,
                  reason: 'capacity_limit',
                  size: this.activeCount,
                  cap: this.pointCap
              }
            : {
                  acceptingWrites: true,
                  size: this.activeCount,
                  cap: this.pointCap
              };
    }

    private getStoredDimSync(): number | null {
        const row = this.db.get(`SELECT repr FROM ${this.tableName} WHERE active = 1 LIMIT 1`) as
            | { repr?: Uint8Array }
            | undefined;
        if (!row?.repr) return null;
        return Math.floor(Buffer.from(row.repr).byteLength / Float32Array.BYTES_PER_ELEMENT);
    }

    private assertStoredDimension(): void {
        const storedDim = this.getStoredDimSync();
        if (storedDim !== null && storedDim !== this.dimension) {
            throw new DimMismatchError(storedDim, this.dimension);
        }
    }

    private validateDimension(repr: Float32Array | number[]): void {
        if (repr.length !== this.dimension) {
            throw new Error(`Vector dimension mismatch: expected ${this.dimension}, got ${repr.length}`);
        }
    }

    private withDbTransaction<T>(fn: () => T): T {
        this.db.run('BEGIN');
        try {
            const result = fn();
            this.db.run('COMMIT');
            return result;
        } catch (error) {
            try {
                this.db.run('ROLLBACK');
            } catch {}
            throw error;
        }
    }

    private async enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureInitialized();
        let resolveNext: (() => void) | null = null;
        const next = new Promise<void>((resolve) => {
            resolveNext = resolve;
        });
        const previous = this.writeQueue;
        this.writeQueue = previous.then(() => next).catch(() => next);
        await previous;

        try {
            return await fn();
        } finally {
            resolveNext?.();
        }
    }

    private async withDirtyWrite<T>(fn: () => Promise<T>): Promise<T> {
        return this.enqueueWrite(async () => {
            this.setState('hnsw_dirty', '1');
            try {
                const result = await fn();
                await this.hnsw.saveSnapshot();
                this.setState('hnsw_dirty', '0');
                return result;
            } catch (error) {
                await this.rebuildIndexLocked();
                throw error;
            }
        });
    }

    private getRowsByVectorIds(vectorIds: string[], activeOnly = false): VectorRow[] {
        if (vectorIds.length === 0) return [];
        const placeholders = vectorIds.map(() => '?').join(', ');
        const sql = `
            SELECT point_id, vector_id, item_id, item_type, active, repr
            FROM ${this.tableName}
            WHERE vector_id IN (${placeholders})
            ${activeOnly ? 'AND active = 1' : ''}
        `;
        return this.db.all(sql, vectorIds) as VectorRow[];
    }

    private getActiveRowsByItemIds(itemIds: string[]): VectorRow[] {
        if (itemIds.length === 0) return [];
        const placeholders = itemIds.map(() => '?').join(', ');
        return this.db.all(
            `SELECT point_id, vector_id, item_id, item_type, active, repr
             FROM ${this.tableName}
             WHERE item_id IN (${placeholders}) AND active = 1`,
            itemIds
        ) as VectorRow[];
    }

    private getActiveRowsByConditions(columnName: string, filterItemIds?: string[]): VectorRow[] {
        const params: any[] = [columnName];
        let sql = `
            SELECT point_id, vector_id, item_id, item_type, active, repr
            FROM ${this.tableName}
            WHERE active = 1 AND item_type = ?
        `;
        if (filterItemIds && filterItemIds.length > 0) {
            sql += ` AND item_id IN (${filterItemIds.map(() => '?').join(', ')})`;
            params.push(...filterItemIds);
        }
        return this.db.all(sql, params) as VectorRow[];
    }

    private getActiveCount(columnName?: string, filterItemIds?: string[]): number {
        const total = columnName ? (this.activeCountByItemType.get(columnName) ?? 0) : this.activeCount;
        if (!filterItemIds || filterItemIds.length === 0) {
            return total;
        }
        return Math.min(total, filterItemIds.length);
    }

    private async rebuildIndexLocked(): Promise<void> {
        this.refreshActiveCounts();
        if (this.activeCount > this.pointCap) {
            this.withDbTransaction(() => {
                this.db.run(
                    `UPDATE ${this.tableName}
                     SET active = 0
                     WHERE active = 1 AND point_id NOT IN (
                         SELECT point_id FROM ${this.tableName} WHERE active = 1 ORDER BY created_at DESC, rowid DESC LIMIT ?
                     )`,
                    [this.pointCap]
                );
            });
        }

        const rows = this.db.all(
            `SELECT point_id, repr FROM ${this.tableName} WHERE active = 1 ORDER BY created_at ASC, rowid ASC`
        ) as Array<{ point_id: string; repr: Uint8Array }>;
        const points: HnswPoint[] = rows.map((row) => ({
            id: row.point_id,
            vector: toVector(row.repr)
        }));
        await this.hnsw.rebuild(points);
        this.refreshActiveCounts();
        this.setState('hnsw_dirty', '0');
    }

    private maybeCompactLocked(): Promise<void> {
        const row = this.db.get(
            `SELECT
                COUNT(*) as total_count,
                SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) as stale_count
             FROM ${this.tableName}`
        ) as { total_count?: number; stale_count?: number } | undefined;
        const totalCount = row?.total_count ?? 0;
        const staleCount = row?.stale_count ?? 0;
        if (totalCount === 0 || staleCount === 0 || staleCount / totalCount <= STALE_COMPACT_RATIO) {
            return Promise.resolve();
        }

        return Promise.resolve().then(async () => {
            this.withDbTransaction(() => {
                this.db.run(`DELETE FROM ${this.tableName} WHERE active = 0`);
            });
            await this.rebuildIndexLocked();
        });
    }

    private exactSearch(
        queryVector: Float32Array | number[],
        options?: VectorSearchOptions,
        filterItemIds?: string[]
    ): VectorSearchResult[] {
        const query = Array.from(queryVector);
        const metric = options?.metric ?? 'cosine';
        const topK = options?.topK ?? 10;
        const threshold = options?.threshold;
        const columnName = options?.columnName ?? '';
        const rows = this.getActiveRowsByConditions(columnName, filterItemIds);

        const results = rows
            .map((row) => {
                const scored = computeMetric(query, toVector(row.repr), metric);
                return {
                    item_id: row.item_id,
                    item_type: row.item_type,
                    similarity: scored.similarity,
                    distance: scored.distance
                };
            })
            .sort((a, b) => b.similarity - a.similarity);

        const filtered = threshold === undefined ? results : results.filter((item) => item.similarity >= threshold);

        return filtered.slice(0, topK);
    }

    private async annSearch(
        queryVector: Float32Array | number[],
        options?: VectorSearchOptions,
        filterItemIds?: string[]
    ): Promise<VectorSearchResult[]> {
        await this.ensureInitialized();
        const metric = options?.metric ?? 'cosine';
        if (metric !== 'cosine' && metric !== 'dot_product') {
            return this.exactSearch(queryVector, options, filterItemIds);
        }

        const topK = options?.topK ?? 10;
        const threshold = options?.threshold;
        const columnName = options?.columnName ?? '';
        const totalActive = this.getActiveCount(columnName);
        if (totalActive === 0) return [];

        const filterSet = filterItemIds ? new Set(filterItemIds) : null;
        let requestK = Math.min(totalActive, Math.max(topK, topK * ANN_OVERFETCH_MULTIPLIER));
        const results: VectorSearchResult[] = [];

        while (requestK <= totalActive) {
            const hits = this.hnsw.searchKNN(Array.from(queryVector), requestK);
            if (hits.length === 0) break;

            const pointIds = hits.map((hit) => hit.id);
            const rows =
                pointIds.length === 0
                    ? []
                    : (this.db.all(
                          `SELECT point_id, item_id, item_type, active
                     FROM ${this.tableName}
                     WHERE point_id IN (${pointIds.map(() => '?').join(', ')})`,
                          pointIds
                      ) as Array<{ point_id: string; item_id: string; item_type: string; active: number }>);
            const rowMap = new Map(rows.map((row) => [row.point_id, row]));

            results.length = 0;
            for (const hit of hits) {
                const row = rowMap.get(hit.id);
                if (!row || row.active !== 1 || row.item_type !== columnName) continue;
                if (filterSet && !filterSet.has(row.item_id)) continue;

                const similarity = hit.score;
                if (threshold !== undefined && similarity < threshold) continue;

                results.push({
                    item_id: row.item_id,
                    item_type: row.item_type,
                    similarity,
                    distance: similarityToDistance(similarity, metric)
                });
                if (results.length >= topK) break;
            }

            if (results.length >= topK || requestK === totalActive) {
                return results.slice(0, topK);
            }

            requestK = Math.min(totalActive, requestK * 2);
        }

        return results.slice(0, topK);
    }

    async insert(record: VectorIndexRecord): Promise<boolean> {
        return (await this.insertMany([record])) > 0;
    }

    async insertMany(records: VectorIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;
        return this.withDirtyWrite(async () => {
            const existing = new Set(
                this.getRowsByVectorIds(
                    records.map((record) => record.vector_id),
                    true
                ).map((row) => row.vector_id)
            );
            let newPointBudget = Math.max(0, this.pointCap - this.activeCount);
            let count = 0;
            const toAdd: Array<{ pointId: string; vector: number[] }> = [];

            this.withDbTransaction(() => {
                for (const record of records) {
                    this.validateDimension(record.repr);
                    if (existing.has(record.vector_id)) continue;
                    if (newPointBudget <= 0) continue;

                    const pointId = `${record.vector_id}:${randomUUID()}`;
                    this.db.run(
                        `INSERT INTO ${this.tableName} (point_id, vector_id, item_id, item_type, active, repr, created_at)
                         VALUES (?, ?, ?, ?, 1, ?, ?)`,
                        [pointId, record.vector_id, record.item_id, record.item_type, toBuffer(record.repr), Date.now()]
                    );
                    existing.add(record.vector_id);
                    newPointBudget--;
                    toAdd.push({ pointId, vector: Array.from(record.repr) });
                    count += 1;
                }
            });
            this.refreshActiveCounts();

            for (const entry of toAdd) {
                await this.hnsw.addPoint(entry.pointId, entry.vector);
            }
            return count;
        });
    }

    async upsert(record: VectorIndexRecord): Promise<boolean> {
        return (await this.upsertMany([record])) > 0;
    }

    async upsertMany(records: VectorIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;
        return this.withDirtyWrite(async () => {
            let count = 0;
            const toAdd: Array<{ pointId: string; vector: number[] }> = [];
            const replacing = new Set(
                this.getRowsByVectorIds(
                    records.map((record) => record.vector_id),
                    true
                ).map((row) => row.vector_id)
            );
            let newPointBudget = Math.max(0, this.pointCap - this.activeCount);

            this.withDbTransaction(() => {
                for (const record of records) {
                    this.validateDimension(record.repr);
                    const isReplacing = replacing.has(record.vector_id);
                    if (!isReplacing && newPointBudget <= 0) continue;
                    this.db.run(
                        `UPDATE ${this.tableName}
                         SET active = 0
                         WHERE vector_id = ? AND active = 1`,
                        [record.vector_id]
                    );
                    const pointId = `${record.vector_id}:${randomUUID()}`;
                    this.db.run(
                        `INSERT INTO ${this.tableName} (point_id, vector_id, item_id, item_type, active, repr, created_at)
                         VALUES (?, ?, ?, ?, 1, ?, ?)`,
                        [pointId, record.vector_id, record.item_id, record.item_type, toBuffer(record.repr), Date.now()]
                    );
                    toAdd.push({ pointId, vector: Array.from(record.repr) });
                    if (!isReplacing) newPointBudget--;
                    count += 1;
                }
            });
            this.refreshActiveCounts();

            for (const entry of toAdd) {
                await this.hnsw.addPoint(entry.pointId, entry.vector);
            }
            await this.maybeCompactLocked();
            return count;
        });
    }

    async updateMany(records: VectorIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;
        return this.withDirtyWrite(async () => {
            const existing = new Set(
                this.getRowsByVectorIds(
                    records.map((record) => record.vector_id),
                    true
                ).map((row) => row.vector_id)
            );
            let count = 0;
            const toAdd: Array<{ pointId: string; vector: number[] }> = [];

            this.withDbTransaction(() => {
                for (const record of records) {
                    this.validateDimension(record.repr);
                    if (!existing.has(record.vector_id)) continue;

                    this.db.run(
                        `UPDATE ${this.tableName}
                         SET active = 0
                         WHERE vector_id = ? AND active = 1`,
                        [record.vector_id]
                    );
                    const pointId = `${record.vector_id}:${randomUUID()}`;
                    this.db.run(
                        `INSERT INTO ${this.tableName} (point_id, vector_id, item_id, item_type, active, repr, created_at)
                         VALUES (?, ?, ?, ?, 1, ?, ?)`,
                        [pointId, record.vector_id, record.item_id, record.item_type, toBuffer(record.repr), Date.now()]
                    );
                    toAdd.push({ pointId, vector: Array.from(record.repr) });
                    count += 1;
                }
            });
            this.refreshActiveCounts();

            for (const entry of toAdd) {
                await this.hnsw.addPoint(entry.pointId, entry.vector);
            }
            await this.maybeCompactLocked();
            return count;
        });
    }

    async delete(itemId: string): Promise<boolean> {
        return (await this.deleteMany([itemId])) > 0;
    }

    async deleteMany(itemIds: string[]): Promise<number> {
        if (itemIds.length === 0) return 0;
        return this.withDirtyWrite(async () => {
            const rows = this.getActiveRowsByItemIds(itemIds);
            const itemSet = new Set(rows.map((row) => row.item_id));
            if (itemSet.size === 0) {
                return 0;
            }

            this.withDbTransaction(() => {
                const placeholders = itemIds.map(() => '?').join(', ');
                this.db.run(`DELETE FROM ${this.tableName} WHERE item_id IN (${placeholders})`, itemIds);
            });

            await this.rebuildIndexLocked();
            return itemSet.size;
        });
    }

    async search(
        queryVector: Float32Array | number[],
        options?: VectorSearchOptions,
        filterItemIds?: string[]
    ): Promise<VectorSearchResult[]> {
        this.validateDimension(queryVector);
        const columnName = options?.columnName ?? '';
        if (!columnName) return [];

        await this.ensureInitialized();
        if (filterItemIds && filterItemIds.length > 0 && filterItemIds.length <= SMALL_FILTER_THRESHOLD) {
            return this.exactSearch(queryVector, options, filterItemIds);
        }
        return this.annSearch(queryVector, options, filterItemIds);
    }

    async count(): Promise<number> {
        await this.ensureInitialized();
        return this.activeCount;
    }

    async exists(itemId: string): Promise<boolean> {
        await this.ensureInitialized();
        const row = this.db.get(`SELECT 1 FROM ${this.tableName} WHERE item_id = ? AND active = 1 LIMIT 1`, [itemId]);
        return row != null;
    }

    async clear(): Promise<number> {
        return this.withDirtyWrite(async () => {
            const countBefore = await this.count();
            this.withDbTransaction(() => {
                this.db.run(`DELETE FROM ${this.tableName}`);
            });
            await this.rebuildIndexLocked();
            return countBefore;
        });
    }

    async searchMeta(
        conditions?: import('./vector-indexer.js').VectorMetaCondition[]
    ): Promise<Array<{ item_id: string; item_type: string }>> {
        await this.ensureInitialized();
        const clauses: string[] = ['active = 1'];
        const params: string[] = [];
        if (conditions && conditions.length > 0) {
            for (const c of conditions) {
                if (c.operator === '=') {
                    params.push(c.value as string);
                    clauses.push(`${c.field} = ?`);
                } else {
                    const vals = Array.isArray(c.value) ? c.value : [c.value as string];
                    vals.forEach((v) => params.push(v));
                    clauses.push(`${c.field} IN (${vals.map(() => '?').join(', ')})`);
                }
            }
        }
        const sql = `SELECT DISTINCT item_id, item_type FROM ${this.tableName} WHERE ${clauses.join(' AND ')}`;
        return this.db.all(sql, params) as { item_id: string; item_type: string }[];
    }

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        return this.enqueueWrite(fn);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.db.close();
    }

    async dropStorage(): Promise<void> {
        this.close();
        removeSqliteStoreFiles(this.dbPath, [this.snapshotPath]);
    }

    getDimension(): number {
        return this.dimension;
    }

    async getStoredDim(): Promise<number | null> {
        await this.ensureInitialized();
        return this.getStoredDimSync();
    }
}

export default VectorIndexDBWasm;
