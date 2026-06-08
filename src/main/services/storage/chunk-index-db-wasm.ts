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
import { createRequire } from 'module';
import { HnswAdapter, HnswPoint } from './hnsw-adapter.js';
import { DimMismatchError, SemanticWriteAvailability, SimilarityMetric } from './abstract-storage.js';
import type { ChunkIndexRecord, ChunkSearchOptions, ChunkSearchResult, IChunkIndexDB } from './chunk-indexer.js';

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
const HNSW_CHUNK_POINT_CAP = 20_000;

type ChunkRow = {
    chunk_pk: string;
    item_id: string;
    chunk_id: string;
    chunk_text: string;
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

export class ChunkIndexDBWasm implements IChunkIndexDB {
    private readonly db: InstanceType<(typeof sqlite3Wasm)['Database']>;
    private readonly dbPath: string;
    private readonly dimension: number;
    private readonly tableName = 'chunk_index_meta';
    private readonly hnswMetadataTableName = 'hnsw_metadata';
    private readonly snapshotPath: string;
    private readonly hnsw: HnswAdapter;
    private initPromise: Promise<void> | null = null;
    private writeQueue: Promise<void> = Promise.resolve();
    private closed = false;
    private activeChunkCount = 0;

    constructor(dbPath: string, dimension: number = 1024) {
        this.dbPath = dbPath;
        this.dimension = dimension;
        this.snapshotPath = `${dbPath}.hnsw.json`;

        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new sqlite3Wasm.Database(dbPath);
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
                    chunk_pk   TEXT PRIMARY KEY,
                    item_id    TEXT NOT NULL,
                    chunk_id   TEXT NOT NULL,
                    chunk_text TEXT NOT NULL,
                    active     INTEGER NOT NULL DEFAULT 1,
                    repr       BLOB NOT NULL
                )
            `);
            this.db.run(`
                CREATE TABLE IF NOT EXISTS ${this.hnswMetadataTableName} (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            `);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_chunk_item_id ON ${this.tableName}(item_id)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_chunk_active ON ${this.tableName}(active)`);
            this.db.run(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_chunk_active_item_chunk
                ON ${this.tableName}(item_id, chunk_id)
                WHERE active = 1
            `);
            this.refreshActiveCount();
            this.assertStoredDimension();

            const dirty = this.getState('hnsw_dirty') === '1';
            try {
                if (!dirty && fs.existsSync(this.snapshotPath)) {
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

    private refreshActiveCount(): void {
        const rows = this.db.all(`SELECT chunk_pk FROM ${this.tableName} WHERE active = 1`) as Array<{
            chunk_pk: string;
        }>;
        this.activeChunkCount = rows.length;
    }

    async getWriteState(): Promise<SemanticWriteAvailability> {
        await this.ensureInitialized();
        return this.activeChunkCount >= HNSW_CHUNK_POINT_CAP
            ? {
                  acceptingWrites: false,
                  reason: 'capacity_limit',
                  size: this.activeChunkCount,
                  cap: HNSW_CHUNK_POINT_CAP
              }
            : {
                  acceptingWrites: true,
                  size: this.activeChunkCount,
                  cap: HNSW_CHUNK_POINT_CAP
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

    private async rebuildIndexLocked(): Promise<void> {
        const rows = this.db.all(
            `SELECT chunk_pk, repr FROM ${this.tableName} WHERE active = 1 ORDER BY rowid ASC`
        ) as Array<{ chunk_pk: string; repr: Uint8Array }>;
        const points: HnswPoint[] = rows.map((row) => ({
            id: row.chunk_pk,
            vector: toVector(row.repr)
        }));
        await this.hnsw.rebuild(points);
        this.refreshActiveCount();
        this.setState('hnsw_dirty', '0');
    }

    private getRowsByChunkIds(chunkIds: string[]): ChunkRow[] {
        if (chunkIds.length === 0) return [];
        return this.db.all(
            `SELECT chunk_pk, item_id, chunk_id, chunk_text, repr
             FROM ${this.tableName}
             WHERE chunk_pk IN (${chunkIds.map(() => '?').join(', ')}) AND active = 1`,
            chunkIds
        ) as ChunkRow[];
    }

    private getRowsByItemIds(itemIds: string[]): ChunkRow[] {
        if (itemIds.length === 0) return [];
        return this.db.all(
            `SELECT chunk_pk, item_id, chunk_id, chunk_text, repr
             FROM ${this.tableName}
             WHERE item_id IN (${itemIds.map(() => '?').join(', ')}) AND active = 1`,
            itemIds
        ) as ChunkRow[];
    }

    private exactSearch(
        queryVector: Float32Array | number[],
        options?: ChunkSearchOptions,
        filterItemIds?: string[]
    ): ChunkSearchResult[] {
        const query = Array.from(queryVector);
        const metric = options?.metric ?? 'cosine';
        const topK = options?.topK ?? 10;
        const threshold = options?.threshold;
        const params: any[] = [];
        let sql = `SELECT chunk_pk, item_id, chunk_id, chunk_text, repr FROM ${this.tableName} WHERE active = 1`;
        if (filterItemIds && filterItemIds.length > 0) {
            sql += ` AND item_id IN (${filterItemIds.map(() => '?').join(', ')})`;
            params.push(...filterItemIds);
        }
        const rows = this.db.all(sql, params) as ChunkRow[];

        const results = rows
            .map((row) => {
                const scored = computeMetric(query, toVector(row.repr), metric);
                return {
                    item_id: row.item_id,
                    chunk_id: row.chunk_id,
                    chunk_text: row.chunk_text,
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
        options?: ChunkSearchOptions,
        filterItemIds?: string[]
    ): Promise<ChunkSearchResult[]> {
        await this.ensureInitialized();
        const metric = options?.metric ?? 'cosine';
        if (metric !== 'cosine' && metric !== 'dot_product') {
            return this.exactSearch(queryVector, options, filterItemIds);
        }

        const topK = options?.topK ?? 10;
        const threshold = options?.threshold;
        const total = this.activeChunkCount;
        if (total === 0) return [];

        const filterSet = filterItemIds ? new Set(filterItemIds) : null;
        let requestK = Math.min(total, Math.max(topK, topK * ANN_OVERFETCH_MULTIPLIER));
        const results: ChunkSearchResult[] = [];

        while (requestK <= total) {
            const hits = this.hnsw.searchKNN(Array.from(queryVector), requestK);
            if (hits.length === 0) break;

            const rows = this.getRowsByChunkIds(hits.map((hit) => hit.id));
            const rowMap = new Map(rows.map((row) => [row.chunk_pk, row]));
            results.length = 0;

            for (const hit of hits) {
                const row = rowMap.get(hit.id);
                if (!row) continue;
                if (filterSet && !filterSet.has(row.item_id)) continue;
                if (threshold !== undefined && hit.score < threshold) continue;

                results.push({
                    item_id: row.item_id,
                    chunk_id: row.chunk_id,
                    chunk_text: row.chunk_text,
                    similarity: hit.score,
                    distance: similarityToDistance(hit.score, metric)
                });
                if (results.length >= topK) break;
            }

            if (results.length >= topK || requestK === total) {
                return results.slice(0, topK);
            }
            requestK = Math.min(total, requestK * 2);
        }

        return results.slice(0, topK);
    }

    async getStoredDim(): Promise<number | null> {
        await this.ensureInitialized();
        return this.getStoredDimSync();
    }

    async existingItemIds(ids: string[]): Promise<Set<string>> {
        await this.ensureInitialized();
        if (ids.length === 0) return new Set();
        const rows = this.db.all(
            `SELECT DISTINCT item_id FROM ${this.tableName} WHERE item_id IN (${ids.map(() => '?').join(', ')})`,
            ids
        ) as Array<{ item_id: string }>;
        return new Set(rows.map((row) => row.item_id));
    }

    async insertMany(records: ChunkIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;
        return this.withDirtyWrite(async () => {
            const existing = new Set(
                this.getRowsByChunkIds(records.map((record) => record.chunk_pk)).map((row) => row.chunk_pk)
            );
            let newPointBudget = Math.max(0, HNSW_CHUNK_POINT_CAP - this.activeChunkCount);
            let count = 0;
            const toAdd: Array<{ chunkPk: string; vector: number[] }> = [];

            this.withDbTransaction(() => {
                for (const record of records) {
                    this.validateDimension(record.repr);
                    if (existing.has(record.chunk_pk)) continue;
                    if (newPointBudget <= 0) continue;

                    this.db.run(
                        `INSERT INTO ${this.tableName} (chunk_pk, item_id, chunk_id, chunk_text, active, repr)
                         VALUES (?, ?, ?, ?, 1, ?)`,
                        [record.chunk_pk, record.item_id, record.chunk_id, record.chunk_text, toBuffer(record.repr)]
                    );
                    existing.add(record.chunk_pk);
                    newPointBudget--;
                    toAdd.push({ chunkPk: record.chunk_pk, vector: Array.from(record.repr) });
                    count += 1;
                }
            });
            this.refreshActiveCount();

            for (const entry of toAdd) {
                await this.hnsw.addPoint(entry.chunkPk, entry.vector);
            }
            return count;
        });
    }

    async deleteByItemId(itemId: string): Promise<number> {
        return this.withDirtyWrite(async () => {
            const rows = this.getRowsByItemIds([itemId]);
            if (rows.length === 0) {
                return 0;
            }

            this.withDbTransaction(() => {
                this.db.run(`DELETE FROM ${this.tableName} WHERE item_id = ?`, [itemId]);
            });
            await this.rebuildIndexLocked();
            return rows.length;
        });
    }

    async deleteManyByItemId(itemIds: string[]): Promise<number> {
        if (itemIds.length === 0) return 0;
        return this.withDirtyWrite(async () => {
            const rows = this.getRowsByItemIds(itemIds);
            if (rows.length === 0) {
                return 0;
            }

            const itemSet = new Set(rows.map((row) => row.item_id));
            this.withDbTransaction(() => {
                this.db.run(
                    `DELETE FROM ${this.tableName} WHERE item_id IN (${itemIds.map(() => '?').join(', ')})`,
                    itemIds
                );
            });
            await this.rebuildIndexLocked();
            return itemSet.size;
        });
    }

    async search(
        queryVector: Float32Array | number[],
        options?: ChunkSearchOptions,
        filterItemIds?: string[]
    ): Promise<ChunkSearchResult[]> {
        this.validateDimension(queryVector);
        await this.ensureInitialized();
        if (filterItemIds && filterItemIds.length > 0 && filterItemIds.length <= SMALL_FILTER_THRESHOLD) {
            return this.exactSearch(queryVector, options, filterItemIds);
        }
        return this.annSearch(queryVector, options, filterItemIds);
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

    async count(): Promise<number> {
        await this.ensureInitialized();
        return this.activeChunkCount;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.db.close();
    }

    getDimension(): number {
        return this.dimension;
    }
}

export default ChunkIndexDBWasm;
