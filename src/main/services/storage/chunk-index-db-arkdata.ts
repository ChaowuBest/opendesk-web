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

import type { BaseIndexStoreProbeResult } from './base-indexer.js';
import type { ChunkIndexRecord, ChunkSearchResult, ChunkSearchOptions, IChunkIndexDB } from './chunk-indexer.js';
import type {
    ArkDataBatchOptions,
    DatabaseKit,
    ArkDataRow,
    ArkDataValueType
} from '../../../platforms/bridges/common.js';
import { ArkDataStoreSession, getArkdataDatabaseKit, retryArkdataStoreReleases } from './arkdata-bridge.js';
import { logger } from '../../utils/logger.js';
import { recordStorageInitializationFailure, recordStorageCleanupFailure } from './platform.js';
import { pickArkdataVectorOperator, simFromArkdataDistance } from './arkdata-vector-metric.js';
import { createArkDataStoreId, toArkDataDbPath } from './arkdata-path.js';
import { normalizeArkDataResultLimit } from './arkdata-result-limit.js';

function arkDataProbeError(error: unknown): Record<string, any> {
    const err = error as any;
    return {
        message: err?.message ?? String(error),
        code: err?.code,
        category: err?.category,
        details: err?.details ?? null
    };
}

function isMissingArkDataTableError(error: unknown): boolean {
    const err = error as any;
    const text = [
        err?.message,
        err?.code,
        err?.category,
        err?.details?.sdkMessage,
        err?.details?.message,
        err?.details ? JSON.stringify(err.details) : ''
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return text.includes('no such table') || text.includes('does not exist') || text.includes('not exist');
}

export async function probeChunkIndexStoreArkdata(dbPath: string): Promise<BaseIndexStoreProbeResult> {
    const formalDbPath = toArkDataDbPath(dbPath);
    const storeId = createArkDataStoreId('arkdata-chunk', formalDbPath);
    const dbKit = getArkdataDatabaseKit();
    const session = new ArkDataStoreSession(dbKit, storeId, { path: formalDbPath, vector: true }, true);
    logger.info(`[arkdata-probe] chunk start logicalDbPath=${dbPath} formalDbPath=${formalDbPath} storeId=${storeId}`);
    try {
        await session.open();
        try {
            await dbKit.querySqlShort(storeId, 'SELECT item_id FROM chunk_index LIMIT 1');
            logger.info(`[arkdata-probe] chunk exists storeId=${storeId}`);
            return 'exists';
        } catch (error) {
            if (isMissingArkDataTableError(error)) {
                logger.info(`[arkdata-probe] chunk missing storeId=${storeId} reason=missing_table`);
                return 'missing';
            }
            logger.warn(`[arkdata-probe] chunk open_failed storeId=${storeId}`, arkDataProbeError(error));
            return 'open_failed';
        }
    } catch (error) {
        logger.warn(`[arkdata-probe] chunk open_failed storeId=${storeId}`, arkDataProbeError(error));
        return 'open_failed';
    } finally {
        await session
            .close()
            .catch((error) =>
                logger.warn(`[arkdata-probe] chunk close failed storeId=${storeId}`, arkDataProbeError(error))
            );
    }
}

export async function dropChunkIndexStoreArkdata(dbPath: string): Promise<void> {
    const formalDbPath = toArkDataDbPath(dbPath);
    const storeId = createArkDataStoreId('arkdata-chunk', formalDbPath);
    await retryArkdataStoreReleases([formalDbPath]);
    try {
        await getArkdataDatabaseKit().deleteStore(storeId, { path: formalDbPath, vector: true });
    } catch (error) {
        recordStorageInitializationFailure(error, { indexer: 'ChunkIndexer', backend: 'arkdata', operation: 'delete' });
        throw error;
    }
}

export class ChunkIndexDBArkdata implements IChunkIndexDB {
    readonly backend = 'arkdata' as const;
    private readonly dbPath: string;
    private readonly dimension: number;
    private readonly tableName = 'chunk_index';
    private readonly schemaMetaTableName = '__schema_meta_safe';
    private readonly storeId: string;

    private dbKit: DatabaseKit | null = null;
    private isInitialized = false;
    private initializationPromise: Promise<void> | null = null;
    private closingPromise: Promise<void> | null = null;
    private storeSession: ArkDataStoreSession | null = null;
    private initializationGeneration = 0;

    constructor(dbPath: string, dimension: number = 1024) {
        this.dbPath = toArkDataDbPath(dbPath);
        this.dimension = dimension;
        this.storeId = createArkDataStoreId('arkdata-chunk', this.dbPath);
    }

    private async ensureInitialized(initializeTables = true): Promise<void> {
        if (this.closingPromise) await this.closingPromise;
        if (this.isInitialized) return;
        const generation = this.initializationGeneration;
        const initialization = this.initializationPromise ?? this.initializeStore(generation, initializeTables);
        this.initializationPromise = initialization;
        try {
            await initialization;
            this.assertInitializationActive(generation);
        } finally {
            if (this.initializationPromise === initialization) this.initializationPromise = null;
        }
    }

    private async initializeStore(generation: number, initializeTables: boolean): Promise<void> {
        let operation: 'initialize' | 'close' = 'close';
        try {
            if (this.storeSession?.needsReplacement()) await this.releaseStoreReference();
            operation = 'initialize';
            if (!this.storeSession) {
                this.dbKit = getArkdataDatabaseKit();
                // Retain the acquisition identity before awaiting a possibly late result.
                this.storeSession = new ArkDataStoreSession(this.dbKit, this.storeId, {
                    path: this.dbPath,
                    vector: true
                });
            }
            await this.storeSession.open();
            this.assertInitializationActive(generation);
            if (initializeTables) await this.initializeTable();
            this.assertInitializationActive(generation);
            this.isInitialized = initializeTables;
        } catch (error) {
            recordStorageInitializationFailure(error, { indexer: 'ChunkIndexer', backend: 'arkdata', operation });
            if (this.storeSession) {
                await this.releaseStoreReference().catch((e) => {
                    recordStorageCleanupFailure(error, e, 'ChunkIndexer');
                    logger.warn('closeStore failed', e);
                });
            } else {
                this.dbKit = null;
            }
            throw error;
        }
    }

    private assertInitializationActive(generation: number): void {
        if (generation !== this.initializationGeneration) {
            throw new Error('ChunkIndexDBArkdata closed during initialization');
        }
    }

    private async releaseStoreReference(): Promise<void> {
        if (!this.storeSession) return;
        await this.storeSession.close();
        this.storeSession = null;
        this.dbKit = null;
    }

    private async initializeTable(): Promise<void> {
        const dbKit = this.kit();
        await dbKit.execSql(
            this.storeId,
            `CREATE TABLE IF NOT EXISTS ${this.tableName} (
                chunk_pk   TEXT PRIMARY KEY,
                item_id    TEXT NOT NULL,
                chunk_id   TEXT NOT NULL,
                chunk_text TEXT NOT NULL,
                repr       floatvector(${this.dimension})
            )`
        );
        await dbKit.execSql(this.storeId, `CREATE INDEX IF NOT EXISTS idx_chunk_item_id ON ${this.tableName}(item_id)`);
        await dbKit.execSql(
            this.storeId,
            `CREATE TABLE IF NOT EXISTS ${this.schemaMetaTableName} (
                meta_name  TEXT PRIMARY KEY,
                meta_value TEXT NOT NULL
            )`
        );
    }

    private kit(): DatabaseKit {
        if (!this.dbKit) throw new Error('ChunkIndexDBArkdata not initialized');
        return this.dbKit;
    }

    private manyOpts(): ArkDataBatchOptions {
        return { maxRows: 500 };
    }

    private scalar(v: string | number | null): ArkDataValueType {
        return { t: 'scalar', v };
    }

    private vector(v: Float32Array | number[]): ArkDataValueType {
        return { t: 'vector', v: v instanceof Float32Array ? Array.from(v) : v };
    }

    private validateDimension(repr: Float32Array | number[]): void {
        if (repr.length !== this.dimension) {
            throw new Error(`Vector dimension mismatch: expected ${this.dimension}, got ${repr.length}`);
        }
    }

    private async runSelect(sql: string, params?: ArkDataValueType[]): Promise<ArkDataRow[]> {
        return await this.kit().queryPrepared(this.storeId, sql, params ?? []);
    }

    private async runExec(sql: string, params?: ArkDataValueType[]): Promise<number> {
        if (!params || params.length === 0) {
            await this.kit().execSql(this.storeId, sql);
            return 0;
        }
        const res = await this.kit().executePrepared(this.storeId, sql, params);
        return res.affectedRows ?? 0;
    }

    /**
     * Lock the configured dimension into schema metadata on the first real write.
     * INSERT OR IGNORE means the first writer wins; later initializations with a
     * different dimension cannot overwrite it, so ChunkIndexer can detect and
     * report DimMismatchError.
     */
    private async lockDimensionMeta(): Promise<void> {
        await this.kit().executePrepared(
            this.storeId,
            `INSERT OR IGNORE INTO ${this.schemaMetaTableName} (meta_name, meta_value) VALUES (?, ?)`,
            [this.scalar('dim'), this.scalar(String(this.dimension))]
        );
    }

    async insertMany(records: ChunkIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;
        await this.ensureInitialized();
        const existing = await this.existingChunkPks(records.map((r) => r.chunk_pk));
        const fresh = records.filter((r) => !existing.has(r.chunk_pk));
        if (fresh.length === 0) return 0;
        const rowsParams = fresh.map((r) => {
            this.validateDimension(r.repr);
            return [
                this.scalar(r.chunk_pk),
                this.scalar(r.item_id),
                this.scalar(r.chunk_id),
                this.scalar(r.chunk_text),
                this.vector(r.repr)
            ];
        });
        await this.lockDimensionMeta();
        const res = await this.kit().executePreparedManyBatched(
            this.storeId,
            `INSERT OR IGNORE INTO ${this.tableName} (chunk_pk, item_id, chunk_id, chunk_text, repr) VALUES (?, ?, ?, ?, ?)`,
            rowsParams,
            this.manyOpts()
        );
        return res.affectedRows ?? fresh.length;
    }

    async deleteByItemId(itemId: string): Promise<number> {
        await this.ensureInitialized();
        return await this.runExec(`DELETE FROM ${this.tableName} WHERE item_id = ?`, [this.scalar(itemId)]);
    }

    async deleteManyByItemId(itemIds: string[]): Promise<number> {
        if (itemIds.length === 0) return 0;
        await this.ensureInitialized();
        const rowsParams = itemIds.map((id) => [this.scalar(id)]);
        const res = await this.kit().executePreparedManyBatched(
            this.storeId,
            `DELETE FROM ${this.tableName} WHERE item_id = ?`,
            rowsParams,
            this.manyOpts()
        );
        return res.affectedRows ?? 0;
    }

    async search(
        queryVector: Float32Array | number[],
        options?: ChunkSearchOptions,
        filterItemIds?: string[]
    ): Promise<ChunkSearchResult[]> {
        await this.ensureInitialized();
        this.validateDimension(queryVector);
        const topK = normalizeArkDataResultLimit('topK', options?.topK, 10, 'ChunkIndexDBArkdata.search');
        const threshold = options?.threshold;
        const metric = options?.metric ?? 'cosine';
        const OP = pickArkdataVectorOperator(metric);

        const wherePart = filterItemIds?.length ? `WHERE item_id IN (${filterItemIds.map(() => '?').join(',')})` : '';
        const sql = `
            SELECT chunk_pk, item_id, chunk_id, chunk_text, repr ${OP} ? AS distance
            FROM ${this.tableName}
            ${wherePart}
            ORDER BY repr ${OP} ?
            LIMIT ${topK}
        `;
        const params: ArkDataValueType[] = [
            this.vector(queryVector),
            ...(filterItemIds ?? []).map((id) => this.scalar(id)),
            this.vector(queryVector)
        ];
        const rows = await this.runSelect(sql, params);

        const out: ChunkSearchResult[] = [];
        for (const row of rows) {
            const raw = row.distance;
            if (raw === null || raw === undefined) {
                throw new Error(
                    `ChunkIndexDBArkdata.search: adapter returned null distance ` +
                        `(SDK ORDER-BY-alias bug or NULL in vector column); raw row=${JSON.stringify(row)}`
                );
            }
            const distance = Number(raw);
            const similarity = simFromArkdataDistance(distance, metric, 'ChunkIndexDBArkdata.search');
            if (threshold !== undefined && similarity < threshold) continue;
            out.push({
                item_id: String(row.item_id),
                chunk_id: String(row.chunk_id),
                chunk_text: String(row.chunk_text),
                similarity,
                distance
            });
        }
        return out;
    }

    async clear(): Promise<number> {
        await this.ensureInitialized();
        const before = await this.count();
        // schema metadata dim is committed for the life of this DB file. To reset
        // dimension, delete the DB file instead of clearing the business table.
        await this.runExec(`DELETE FROM ${this.tableName}`);
        return before;
    }

    async dropStorage(): Promise<void> {
        await this.close();
        await dropChunkIndexStoreArkdata(this.dbPath);
    }

    async count(): Promise<number> {
        await this.ensureInitialized();
        const rows = await this.runSelect(`SELECT COUNT(*) AS count FROM ${this.tableName}`);
        return Number(rows[0]?.count ?? 0);
    }

    close(): Promise<void> {
        if (this.closingPromise) return this.closingPromise;
        this.initializationGeneration++;
        this.isInitialized = false;
        const initialization = this.initializationPromise;
        if (!initialization && !this.storeSession) {
            this.dbKit = null;
            return Promise.resolve();
        }
        // Let an in-flight open finish before releasing this object's reference.
        const closing = (async () => {
            if (initialization) await initialization.catch(() => {});
            await this.releaseStoreReference();
        })().finally(() => {
            this.isInitialized = false;
            if (this.closingPromise === closing) this.closingPromise = null;
        });
        this.closingPromise = closing;
        return closing;
    }

    getDimension(): number {
        return this.dimension;
    }

    async getStoredDim(): Promise<number | null> {
        await this.ensureInitialized();
        // schema metadata dim is the authoritative dimension lock. The business
        // table may be empty after clear(), but the DB file dimension still holds.
        const metaRows = await this.runSelect(
            `SELECT meta_value FROM ${this.schemaMetaTableName} WHERE meta_name = ? LIMIT 1`,
            [this.scalar('dim')]
        );
        if (metaRows.length > 0) {
            const parsed = Number(metaRows[0].meta_value);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                throw new Error(
                    `ChunkIndexDBArkdata.getStoredDim: schema metadata dim is not a positive number: ${String(metaRows[0].meta_value)}`
                );
            }
            return parsed;
        }

        const dataRows = await this.runSelect(`SELECT 1 AS present FROM ${this.tableName} LIMIT 1`);
        if (dataRows.length === 0) return null;

        throw new Error(
            `ChunkIndexDBArkdata.getStoredDim: chunk_index has rows but schema metadata dim is missing; ` +
                `DB is corrupt or predates the schema-meta migration (path=${this.dbPath})`
        );
    }

    async existingItemIds(ids: string[]): Promise<Set<string>> {
        if (ids.length === 0) return new Set();
        await this.ensureInitialized();
        const placeholders = ids.map(() => '?').join(',');
        const rows = await this.runSelect(
            `SELECT DISTINCT item_id FROM ${this.tableName} WHERE item_id IN (${placeholders})`,
            ids.map((id) => this.scalar(id))
        );
        return new Set(rows.map((r) => String(r.item_id)));
    }

    private async existingChunkPks(ids: string[]): Promise<Set<string>> {
        if (ids.length === 0) return new Set();
        const placeholders = ids.map(() => '?').join(',');
        const rows = await this.runSelect(
            `SELECT chunk_pk FROM ${this.tableName} WHERE chunk_pk IN (${placeholders})`,
            ids.map((id) => this.scalar(id))
        );
        return new Set(rows.map((r) => String(r.chunk_pk)));
    }
}
