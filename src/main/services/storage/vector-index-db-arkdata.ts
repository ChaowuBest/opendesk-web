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
import type {
    VectorIndexRecord,
    VectorSearchResult,
    VectorSearchOptions,
    VectorMetaCondition,
    IVectorIndexDB
} from './vector-indexer.js';
import type {
    ArkDataBatchOptions,
    DatabaseKit,
    ArkDataExecOptions,
    ArkDataRow,
    ArkDataValueType
} from '../../../platforms/bridges/common.js';
import { getArkdataDatabaseKit } from './arkdata-bridge.js';
import { logger } from '../../utils/logger.js';
import { pickArkdataVectorOperator, simFromArkdataDistance } from './arkdata-vector-metric.js';
import { createArkDataStoreId, toArkDataDbPath } from './arkdata-path.js';
import { getArkDataTxId, hasArkDataTx, runWithArkDataTx } from './arkdata-tx-context.js';
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

export async function probeVectorIndexStoreArkdata(dbPath: string): Promise<BaseIndexStoreProbeResult> {
    const formalDbPath = toArkDataDbPath(dbPath);
    const storeId = createArkDataStoreId('arkdata-vector', formalDbPath);
    const dbKit = getArkdataDatabaseKit();
    logger.info(`[arkdata-probe] vector start logicalDbPath=${dbPath} formalDbPath=${formalDbPath} storeId=${storeId}`);
    try {
        await dbKit.openStore(storeId, { path: formalDbPath, vector: true });
        try {
            await dbKit.querySqlShort(storeId, 'SELECT item_id FROM vector_index LIMIT 1');
            logger.info(`[arkdata-probe] vector exists storeId=${storeId}`);
            return 'exists';
        } catch (error) {
            if (isMissingArkDataTableError(error)) {
                logger.info(`[arkdata-probe] vector missing storeId=${storeId} reason=missing_table`);
                return 'missing';
            }
            logger.warn(`[arkdata-probe] vector open_failed storeId=${storeId}`, arkDataProbeError(error));
            return 'open_failed';
        }
    } catch (error) {
        logger.warn(`[arkdata-probe] vector open_failed storeId=${storeId}`, arkDataProbeError(error));
        return 'open_failed';
    } finally {
        await dbKit
            .closeStore(storeId)
            .catch((error) =>
                logger.warn(`[arkdata-probe] vector close failed storeId=${storeId}`, arkDataProbeError(error))
            );
    }
}

export async function dropVectorIndexStoreArkdata(dbPath: string): Promise<void> {
    const formalDbPath = toArkDataDbPath(dbPath);
    const storeId = createArkDataStoreId('arkdata-vector', formalDbPath);
    const dbKit = getArkdataDatabaseKit();
    await dbKit.openStore(storeId, { path: formalDbPath, vector: true });
    try {
        await dbKit.execSql(storeId, 'DROP TABLE IF EXISTS vector_index');
        await dbKit.execSql(storeId, 'DROP TABLE IF EXISTS __schema_meta_safe');
    } finally {
        await dbKit
            .closeStore(storeId)
            .catch((error) =>
                logger.warn(`[arkdata-drop] vector close failed storeId=${storeId}`, arkDataProbeError(error))
            );
    }
}

export class VectorIndexDBArkdata implements IVectorIndexDB {
    readonly backend = 'arkdata' as const;
    private readonly dbPath: string;
    private readonly dimension: number;
    private readonly tableName = 'vector_index';
    private readonly schemaMetaTableName = '__schema_meta_safe';
    private readonly storeId: string;

    private dbKit: DatabaseKit | null = null;
    private isInitialized = false;

    constructor(dbPath: string, dimension: number = 1024) {
        this.dbPath = toArkDataDbPath(dbPath);
        this.dimension = dimension;
        this.storeId = createArkDataStoreId('arkdata-vector', this.dbPath);
    }

    private async ensureInitialized(): Promise<void> {
        if (this.isInitialized) return;
        this.dbKit = getArkdataDatabaseKit();
        await this.dbKit.openStore(this.storeId, { path: this.dbPath, vector: true });
        await this.dbKit.execSql(
            this.storeId,
            `CREATE TABLE IF NOT EXISTS ${this.tableName} (
                vector_id TEXT PRIMARY KEY,
                item_id   TEXT NOT NULL,
                item_type TEXT NOT NULL,
                repr      floatvector(${this.dimension})
            )`
        );
        await this.dbKit.execSql(
            this.storeId,
            `CREATE INDEX IF NOT EXISTS idx_vec_item_id ON ${this.tableName}(item_id)`
        );
        await this.dbKit.execSql(
            this.storeId,
            `CREATE INDEX IF NOT EXISTS idx_vec_item_type ON ${this.tableName}(item_type)`
        );
        await this.dbKit.execSql(
            this.storeId,
            `CREATE TABLE IF NOT EXISTS ${this.schemaMetaTableName} (
                meta_name  TEXT PRIMARY KEY,
                meta_value TEXT NOT NULL
            )`
        );
        this.isInitialized = true;
    }

    private kit(): DatabaseKit {
        if (!this.dbKit) throw new Error('VectorIndexDBArkdata not initialized');
        return this.dbKit;
    }

    private opts(): ArkDataExecOptions | undefined {
        const txId = getArkDataTxId(this.storeId);
        return txId ? { txId } : undefined;
    }

    private manyOpts(): ArkDataBatchOptions {
        return { ...this.opts(), maxRows: 500 };
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
        if (getArkDataTxId(this.storeId) !== null) {
            const res = await this.kit().executePrepared(this.storeId, sql, params ?? [], this.opts());
            return res.affectedRows ?? 0;
        }
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
     * different dimension cannot overwrite it, so VectorIndexer can detect and
     * report DimMismatchError.
     */
    private async lockDimensionMeta(): Promise<void> {
        await this.kit().executePrepared(
            this.storeId,
            `INSERT OR IGNORE INTO ${this.schemaMetaTableName} (meta_name, meta_value) VALUES (?, ?)`,
            [this.scalar('dim'), this.scalar(String(this.dimension))],
            this.opts()
        );
    }

    async insert(record: VectorIndexRecord): Promise<boolean> {
        await this.ensureInitialized();
        this.validateDimension(record.repr);
        await this.lockDimensionMeta();
        const res = await this.kit().executePrepared(
            this.storeId,
            `INSERT OR REPLACE INTO ${this.tableName} (vector_id, item_id, item_type, repr) VALUES (?, ?, ?, ?)`,
            [
                this.scalar(record.vector_id),
                this.scalar(record.item_id),
                this.scalar(record.item_type),
                this.vector(record.repr)
            ],
            this.opts()
        );
        return (res.affectedRows ?? 0) > 0;
    }

    async insertMany(records: VectorIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;
        await this.ensureInitialized();
        const existing = await this.existingVectorIds(records.map((r) => r.vector_id));
        const fresh = records.filter((r) => !existing.has(r.vector_id));
        if (fresh.length === 0) return 0;
        const rowsParams = fresh.map((r) => {
            this.validateDimension(r.repr);
            return [this.scalar(r.vector_id), this.scalar(r.item_id), this.scalar(r.item_type), this.vector(r.repr)];
        });
        await this.lockDimensionMeta();
        const res = await this.kit().executePreparedManyBatched(
            this.storeId,
            `INSERT OR IGNORE INTO ${this.tableName} (vector_id, item_id, item_type, repr) VALUES (?, ?, ?, ?)`,
            rowsParams,
            this.manyOpts()
        );
        return res.affectedRows ?? fresh.length;
    }

    async upsert(record: VectorIndexRecord): Promise<boolean> {
        return (await this.upsertMany([record])) > 0;
    }

    async upsertMany(records: VectorIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;
        await this.ensureInitialized();
        const rowsParams = records.map((r) => {
            this.validateDimension(r.repr);
            return [this.scalar(r.vector_id), this.scalar(r.item_id), this.scalar(r.item_type), this.vector(r.repr)];
        });
        await this.lockDimensionMeta();
        const idsRows = records.map((r) => [this.scalar(r.vector_id)]);
        await this.kit().executePreparedManyBatched(
            this.storeId,
            `DELETE FROM ${this.tableName} WHERE vector_id = ?`,
            idsRows,
            this.manyOpts()
        );
        const res = await this.kit().executePreparedManyBatched(
            this.storeId,
            `INSERT INTO ${this.tableName} (vector_id, item_id, item_type, repr) VALUES (?, ?, ?, ?)`,
            rowsParams,
            this.manyOpts()
        );
        return res.affectedRows ?? records.length;
    }

    async updateMany(records: VectorIndexRecord[]): Promise<number> {
        if (records.length === 0) return 0;
        await this.ensureInitialized();
        const existing = await this.existingVectorIds(records.map((r) => r.vector_id));
        const live = records.filter((r) => existing.has(r.vector_id));
        if (live.length === 0) return 0;
        const rowsParams = live.map((r) => {
            this.validateDimension(r.repr);
            return [this.scalar(r.vector_id), this.scalar(r.item_id), this.scalar(r.item_type), this.vector(r.repr)];
        });
        await this.lockDimensionMeta();
        const idsRows = live.map((r) => [this.scalar(r.vector_id)]);
        await this.kit().executePreparedManyBatched(
            this.storeId,
            `DELETE FROM ${this.tableName} WHERE vector_id = ?`,
            idsRows,
            this.manyOpts()
        );
        const res = await this.kit().executePreparedManyBatched(
            this.storeId,
            `INSERT INTO ${this.tableName} (vector_id, item_id, item_type, repr) VALUES (?, ?, ?, ?)`,
            rowsParams,
            this.manyOpts()
        );
        return res.affectedRows ?? live.length;
    }

    async delete(itemId: string): Promise<boolean> {
        await this.ensureInitialized();
        const res = await this.kit().executePrepared(
            this.storeId,
            `DELETE FROM ${this.tableName} WHERE item_id = ?`,
            [this.scalar(itemId)],
            this.opts()
        );
        return (res.affectedRows ?? 0) > 0;
    }

    async deleteMany(itemIds: string[]): Promise<number> {
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
        options?: VectorSearchOptions,
        filterItemIds?: string[]
    ): Promise<VectorSearchResult[]> {
        await this.ensureInitialized();
        this.validateDimension(queryVector);
        const topK = normalizeArkDataResultLimit('topK', options?.topK, 10, 'VectorIndexDBArkdata.search');
        const threshold = options?.threshold;
        const metric = options?.metric ?? 'cosine';
        const OP = pickArkdataVectorOperator(metric);

        const wherePieces: string[] = [];
        const params: ArkDataValueType[] = [this.vector(queryVector)];
        if (options?.columnName) {
            wherePieces.push('item_type = ?');
            params.push(this.scalar(options.columnName));
        }
        if (filterItemIds?.length) {
            wherePieces.push(`item_id IN (${filterItemIds.map(() => '?').join(',')})`);
            for (const id of filterItemIds) {
                params.push(this.scalar(id));
            }
        }
        const wherePart = wherePieces.length ? `WHERE ${wherePieces.join(' AND ')}` : '';
        const sql = `
            SELECT vector_id, item_id, item_type, repr ${OP} ? AS distance
            FROM ${this.tableName}
            ${wherePart}
            ORDER BY repr ${OP} ?
            LIMIT ${topK}
        `;
        params.push(this.vector(queryVector));
        const rows = await this.runSelect(sql, params);

        const out: VectorSearchResult[] = [];
        for (const row of rows) {
            const raw = row.distance;
            if (raw === null || raw === undefined) {
                throw new Error(
                    `VectorIndexDBArkdata.search: adapter returned null distance ` +
                        `(SDK ORDER-BY-alias bug or NULL in vector column); raw row=${JSON.stringify(row)}`
                );
            }
            const distance = Number(raw);
            const similarity = simFromArkdataDistance(distance, metric, 'VectorIndexDBArkdata.search');
            if (threshold !== undefined && similarity < threshold) continue;
            out.push({
                item_id: String(row.item_id),
                item_type: String(row.item_type),
                similarity,
                distance
            });
        }
        return out;
    }

    async count(): Promise<number> {
        await this.ensureInitialized();
        const rows = await this.runSelect(`SELECT COUNT(*) AS count FROM ${this.tableName}`);
        return Number(rows[0]?.count ?? 0);
    }

    async exists(itemId: string): Promise<boolean> {
        await this.ensureInitialized();
        const rows = await this.runSelect(`SELECT 1 AS present FROM ${this.tableName} WHERE item_id = ? LIMIT 1`, [
            this.scalar(itemId)
        ]);
        return rows.length > 0;
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
        await this.ensureInitialized();
        await this.kit().execSql(this.storeId, `DROP TABLE IF EXISTS ${this.tableName}`);
        await this.kit().execSql(this.storeId, `DROP TABLE IF EXISTS ${this.schemaMetaTableName}`);
        this.close();
    }

    async searchMeta(conditions?: VectorMetaCondition[]): Promise<Array<{ item_id: string; item_type: string }>> {
        await this.ensureInitialized();
        const wherePieces: string[] = [];
        const params: ArkDataValueType[] = [];
        for (const cond of conditions ?? []) {
            if (cond.operator === '=') {
                wherePieces.push(`${cond.field} = ?`);
                params.push(this.scalar(cond.value as string));
            } else if (cond.operator === 'in') {
                const vals = cond.value as string[];
                if (vals.length === 0) {
                    wherePieces.push('1 = 0');
                    continue;
                }
                wherePieces.push(`${cond.field} IN (${vals.map(() => '?').join(',')})`);
                for (const v of vals) params.push(this.scalar(v));
            } else {
                throw new Error(`VectorIndexDBArkdata.searchMeta: unsupported operator ${(cond as any).operator}`);
            }
        }
        const where = wherePieces.length ? `WHERE ${wherePieces.join(' AND ')}` : '';
        const sql = `SELECT DISTINCT item_id, item_type FROM ${this.tableName} ${where}`;
        const rows = await this.runSelect(sql, params);
        return rows.map((r) => ({ item_id: String(r.item_id), item_type: String(r.item_type) }));
    }

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureInitialized();
        if (hasArkDataTx(this.storeId)) return await fn();
        return this.kit().transaction(this.storeId, async (tx) => {
            return await runWithArkDataTx(this.storeId, tx.id, fn);
        });
    }

    close(): void {
        if (this.dbKit) {
            void this.dbKit.closeStore(this.storeId).catch((e) => logger.warn('closeStore failed', e));
        }
        this.dbKit = null;
        this.isInitialized = false;
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
                    `VectorIndexDBArkdata.getStoredDim: schema metadata dim is not a positive number: ${String(metaRows[0].meta_value)}`
                );
            }
            return parsed;
        }

        const dataRows = await this.runSelect(`SELECT 1 AS present FROM ${this.tableName} LIMIT 1`);
        if (dataRows.length === 0) return null;

        throw new Error(
            `VectorIndexDBArkdata.getStoredDim: vector_index has rows but schema metadata dim is missing; ` +
                `DB is corrupt or predates the schema-meta migration (path=${this.dbPath})`
        );
    }

    private async existingVectorIds(ids: string[]): Promise<Set<string>> {
        if (ids.length === 0) return new Set();
        const placeholders = ids.map(() => '?').join(',');
        const rows = await this.runSelect(
            `SELECT vector_id FROM ${this.tableName} WHERE vector_id IN (${placeholders})`,
            ids.map((id) => this.scalar(id))
        );
        return new Set(rows.map((r) => String(r.vector_id)));
    }
}
