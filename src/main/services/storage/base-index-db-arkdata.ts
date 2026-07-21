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

import { createHash } from 'node:crypto';
import { ColumnSchema, validateColumnSchema, type ColumnConstraint } from './abstract-storage.js';
import type {
    BaseIndexStoreProbeResult,
    BaseQueryCondition,
    BaseQueryOptions,
    BaseQueryOperator,
    IBaseIndexDB
} from './base-indexer.js';
import type {
    ArkDataBatchOptions,
    ArkDataExecOptions,
    ArkDataRow,
    ArkDataValueType,
    DatabaseKit
} from '../../../platforms/bridges/common.js';
import { getArkdataDatabaseKit } from './arkdata-bridge.js';
import { logger } from '../../utils/logger.js';
import { createArkDataStoreId, toArkDataDbPath } from './arkdata-path.js';
import { getArkDataTxId, hasArkDataTx, runWithArkDataTx } from './arkdata-tx-context.js';
import {
    ARKDATA_MAX_RESULT_ROWS,
    arkDataNonNegativeIntegerLiteral,
    normalizeArkDataResultLimit
} from './arkdata-result-limit.js';
import {
    normalizePathDescendantOrSelfValues,
    pathDescendantOrSelfSqlValues
} from './path-scope.js';

const ARKDATA_SELECT_PAGE_ROWS = ARKDATA_MAX_RESULT_ROWS;

type BaseWriteGroup = { columns: string[]; rows: any[][] };

function describeArkDataError(error: unknown): Record<string, any> {
    const err = error as any;
    return {
        name: err?.name,
        message: err?.message ?? String(error),
        code: err?.code,
        category: err?.category,
        details: err?.details ?? null,
        stack: typeof err?.stack === 'string' ? err.stack.split('\n').slice(0, 5).join('\n') : undefined
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

export async function probeBaseIndexStoreArkdata(dbPath: string): Promise<BaseIndexStoreProbeResult> {
    const formalDbPath = toArkDataDbPath(dbPath);
    const storeId = createArkDataStoreId('arkdata-base', formalDbPath);
    const dbKit = getArkdataDatabaseKit();
    logger.info(`[arkdata-probe] base start logicalDbPath=${dbPath} formalDbPath=${formalDbPath} storeId=${storeId}`);
    try {
        await dbKit.openStore(storeId, { path: formalDbPath, vector: true });
        try {
            await dbKit.querySqlShort(storeId, 'SELECT item_id FROM base_index LIMIT 1');
            logger.info(`[arkdata-probe] base exists storeId=${storeId}`);
            return 'exists';
        } catch (error) {
            if (isMissingArkDataTableError(error)) {
                logger.info(`[arkdata-probe] base missing storeId=${storeId} reason=missing_table`);
                return 'missing';
            }
            logger.warn(`[arkdata-probe] base open_failed storeId=${storeId}`, describeArkDataError(error));
            return 'open_failed';
        }
    } catch (error) {
        logger.warn(`[arkdata-probe] base open_failed storeId=${storeId}`, describeArkDataError(error));
        return 'open_failed';
    } finally {
        await dbKit
            .closeStore(storeId)
            .catch((error) =>
                logger.warn(`[arkdata-probe] base close failed storeId=${storeId}`, describeArkDataError(error))
            );
    }
}

export class BaseIndexDBArkdata implements IBaseIndexDB {
    private readonly dbPath: string;
    private readonly tableName = 'base_index';
    private readonly schemaMetaTableName = '__schema_meta_safe';
    private readonly schemaHashMetaName = 'base_schema_hash';
    private readonly schemaProbeItemId = '__schema_probe__';
    private readonly schema: ColumnSchema;
    private readonly validFields: string[];
    private readonly storeId: string;

    private dbKit: DatabaseKit | null = null;
    private isInitialized = false;

    constructor(dbPath: string, schema: ColumnSchema) {
        validateColumnSchema(schema);
        this.dbPath = toArkDataDbPath(dbPath);
        this.schema = schema;
        this.validFields = Object.keys(schema.columns);
        this.storeId = createArkDataStoreId('arkdata-base', this.dbPath);
        logger.info(
            `[BaseIndexDBArkdata] constructor logicalDbPath=${dbPath} formalDbPath=${this.dbPath} storeId=${this.storeId}`
        );
    }

    async initialize(): Promise<void> {
        await this.ensureInitialized();
    }

    private async ensureInitialized(): Promise<void> {
        if (this.isInitialized) return;
        this.dbKit = getArkdataDatabaseKit();
        await this.dbKit.openStore(this.storeId, { path: this.dbPath, vector: true });
        await this.initializeTable();
        this.isInitialized = true;
    }

    private kit(): DatabaseKit {
        if (!this.dbKit) throw new Error('BaseIndexDBArkdata not initialized');
        return this.dbKit;
    }

    private opts(): ArkDataExecOptions | undefined {
        const txId = getArkDataTxId(this.storeId);
        return txId ? { txId } : undefined;
    }

    private scalar(value: any): ArkDataValueType {
        if (value === undefined) throw new Error('Cannot bind undefined ArkData scalar');
        if (value === null) return { t: 'scalar', v: null };
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) throw new Error(`Cannot bind non-finite number: ${value}`);
            return { t: 'scalar', v: value };
        }
        if (typeof value === 'string' || typeof value === 'boolean') return { t: 'scalar', v: value };
        throw new Error(`Unsupported ArkData scalar type: ${Object.prototype.toString.call(value)}`);
    }

    private params(values: any[]): ArkDataValueType[] {
        return values.map((value) => this.scalar(value));
    }

    private hasDuplicateItemIds(records: Record<string, any>[]): boolean {
        const seen = new Set<string>();
        for (const record of records) {
            const itemId = String(record.item_id);
            if (seen.has(itemId)) return true;
            seen.add(itemId);
        }
        return false;
    }

    private addWriteGroupRow(groups: Map<string, BaseWriteGroup>, columns: string[], values: any[]): void {
        const key = columns.join('\0');
        let group = groups.get(key);
        if (!group) {
            group = { columns, rows: [] };
            groups.set(key, group);
        }
        group.rows.push(values);
    }

    private async executeMany(sql: string, rows: any[][]): Promise<void> {
        if (rows.length === 0) return;
        const opts: ArkDataBatchOptions = { ...(this.opts() ?? {}), maxRows: 1000 };
        await this.kit().executePreparedManyBatched(
            this.storeId,
            sql,
            rows.map((row) => this.params(row)),
            opts
        );
    }

    private sqlLimitLiteral(value: unknown): string {
        return String(normalizeArkDataResultLimit('limit', value, 5000, 'BaseIndexDBArkdata.findAll'));
    }

    private sqlOffsetLiteral(value: unknown): string {
        return arkDataNonNegativeIntegerLiteral('offset', value, 'BaseIndexDBArkdata.findAll');
    }

    private logicalLimit(value: unknown): number | undefined {
        if (value === undefined) return undefined;
        if (!Number.isSafeInteger(value) || (value as number) < 0) {
            throw new Error(`BaseIndexDBArkdata.findAll: invalid limit=${String(value)}`);
        }
        return value as number;
    }

    private buildOrderClause(orderBy?: BaseQueryOptions['orderBy'], forceStableOrder = false): string {
        if (!orderBy) {
            return forceStableOrder ? ' ORDER BY item_id ASC' : '';
        }
        this.validateField(orderBy.field);
        const direction = orderBy.direction === 'DESC' ? 'DESC' : 'ASC';
        if (orderBy.field === 'item_id') {
            return ` ORDER BY item_id ${direction}`;
        }
        return ` ORDER BY ${orderBy.field} ${direction}, item_id ASC`;
    }

    private buildSelectSql(
        options?: BaseQueryOptions,
        pageLimit?: number,
        pageOffset?: number,
        forceStableOrder = false
    ): { sql: string; params: any[] } {
        let sql = `SELECT * FROM ${this.tableName}`;
        const params: any[] = [];
        if (options?.conditions && options.conditions.length > 0) {
            const { whereClause, params: whereParams } = this.buildWhereClause(options.conditions);
            sql += ` WHERE ${whereClause}`;
            params.push(...whereParams);
        }
        sql += this.buildOrderClause(options?.orderBy, forceStableOrder);
        sql += ` LIMIT ${this.sqlLimitLiteral(pageLimit ?? options?.limit ?? ARKDATA_SELECT_PAGE_ROWS)}`;
        if (pageOffset !== undefined) {
            sql += ` OFFSET ${this.sqlOffsetLiteral(pageOffset)}`;
        }
        return { sql, params };
    }

    private async runSelect(sql: string, params: any[] = []): Promise<ArkDataRow[]> {
        return await this.kit().queryPrepared(this.storeId, sql, this.params(params));
    }

    private async runExec(sql: string, params: any[] = []): Promise<number> {
        const txId = getArkDataTxId(this.storeId);
        const bound = this.params(params);
        if (txId !== null) {
            const res = await this.kit().executePrepared(this.storeId, sql, bound, this.opts());
            return res.affectedRows ?? 0;
        }
        if (bound.length === 0) {
            await this.kit().execSql(this.storeId, sql);
            return 0;
        }
        const res = await this.kit().executePrepared(this.storeId, sql, bound);
        return res.affectedRows ?? 0;
    }

    private async initializeTable(): Promise<void> {
        const columnDefs = Object.entries(this.schema.columns).map(([columnName, def]) =>
            this.buildColumnDef(columnName, def)
        );
        await this.kit().execSql(
            this.storeId,
            `CREATE TABLE IF NOT EXISTS ${this.tableName} (${columnDefs.join(', ')})`
        );
        await this.kit().execSql(
            this.storeId,
            `CREATE TABLE IF NOT EXISTS ${this.schemaMetaTableName} (
                meta_name  TEXT PRIMARY KEY,
                meta_value TEXT NOT NULL
            )`
        );
        await this.ensureColumns();
    }

    private async ensureColumns(): Promise<void> {
        const schemaHash = this.computeSchemaHash();
        const recordedHash = await this.readSchemaMetaValue(this.schemaHashMetaName);
        if (recordedHash === schemaHash) return;

        try {
            await this.probeFullSchemaDml();
            await this.writeSchemaMeta(schemaHash);
            return;
        } catch (error) {
            logger.info(
                `[BaseIndexDBArkdata] schema probe failed before ALTER reconciliation; ` +
                    `storeId=${this.storeId} error=${JSON.stringify(tempDebugError(error))}`
            );
        }

        for (const [columnName, def] of Object.entries(this.schema.columns)) {
            if (columnName === 'item_id') continue;
            const sql = `ALTER TABLE ${this.tableName} ADD COLUMN ${this.buildColumnDef(columnName, def)}`;
            try {
                await this.kit().execSql(this.storeId, sql);
                logger.info(`[BaseIndexDBArkdata] schema ALTER applied column=${columnName} storeId=${this.storeId}`);
            } catch (error) {
                logger.warn(
                    `[BaseIndexDBArkdata] schema ALTER reconciliation skipped column=${columnName} ` +
                        `storeId=${this.storeId} error=${JSON.stringify(tempDebugError(error))}`
                );
            }
        }

        try {
            await this.probeFullSchemaDml();
            await this.writeSchemaMeta(schemaHash);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const wrapped = new Error(`ArkData base schema upgrade failed: ${message}`);
            (wrapped as any).cause = error;
            throw wrapped;
        }
    }

    private computeSchemaHash(): string {
        const columnDefs = Object.entries(this.schema.columns)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([columnName, def]) => [columnName, this.buildColumnDef(columnName, def)]);
        return createHash('sha256').update(JSON.stringify(columnDefs)).digest('hex');
    }

    private async readSchemaMetaValue(metaName: string): Promise<string | null> {
        const rows = await this.runSelect(
            `SELECT meta_value FROM ${this.schemaMetaTableName} WHERE meta_name = ? LIMIT 1`,
            [metaName]
        );
        if (rows.length === 0) return null;
        return String(rows[0].meta_value);
    }

    private async writeSchemaMeta(schemaHash: string): Promise<void> {
        await this.kit().transaction(this.storeId, async (tx) => {
            await runWithArkDataTx(this.storeId, tx.id, async () => {
                await this.runExec(`DELETE FROM ${this.schemaMetaTableName} WHERE meta_name = ? OR meta_name LIKE ?`, [
                    this.schemaHashMetaName,
                    'base_column:%'
                ]);
                for (const [columnName, def] of Object.entries(this.schema.columns).sort(([left], [right]) =>
                    left < right ? -1 : left > right ? 1 : 0
                )) {
                    await this.runExec(
                        `INSERT OR REPLACE INTO ${this.schemaMetaTableName} (meta_name, meta_value) VALUES (?, ?)`,
                        [`base_column:${columnName}`, this.buildColumnDef(columnName, def)]
                    );
                }
                await this.runExec(
                    `INSERT OR REPLACE INTO ${this.schemaMetaTableName} (meta_name, meta_value) VALUES (?, ?)`,
                    [this.schemaHashMetaName, schemaHash]
                );
            });
        });
    }

    private async probeFullSchemaDml(): Promise<void> {
        await this.runExec(`DELETE FROM ${this.tableName} WHERE item_id = ?`, [this.schemaProbeItemId]).catch((error) =>
            logger.warn(
                `[BaseIndexDBArkdata] schema probe pre-clean failed storeId=${this.storeId}`,
                tempDebugError(error)
            )
        );

        const columns = Object.keys(this.schema.columns);
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map((columnName) => this.schemaProbeValue(columnName, this.schema.columns[columnName]));
        try {
            await this.runExec(
                `INSERT OR REPLACE INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders})`,
                values
            );
        } finally {
            await this.runExec(`DELETE FROM ${this.tableName} WHERE item_id = ?`, [this.schemaProbeItemId]).catch(
                (error) =>
                    logger.warn(
                        `[BaseIndexDBArkdata] schema probe cleanup failed storeId=${this.storeId}`,
                        tempDebugError(error)
                    )
            );
        }
    }

    private schemaProbeValue(columnName: string, def: ColumnConstraint): string | number {
        if (columnName === 'item_id') return this.schemaProbeItemId;
        if (columnName === 'item_type') return 'file';
        if (def.defaultValue !== undefined && def.defaultValue !== null) return def.defaultValue;
        switch (def.type) {
            case 'INTEGER':
            case 'REAL':
                return 0;
            case 'TEXT':
            case 'BLOB':
                return '';
        }
        throw new Error(`Unsupported ArkData schema probe column type: ${def.type}`);
    }

    private buildColumnDef(columnName: string, def: ColumnConstraint): string {
        let colDef = `${columnName} ${def.type}`;
        if (columnName === 'item_id') {
            colDef += ' PRIMARY KEY';
        } else {
            if (!def.nullable) colDef += ' NOT NULL';
            if (def.defaultValue !== undefined && def.defaultValue !== null) {
                const defaultVal =
                    typeof def.defaultValue === 'string'
                        ? `'${def.defaultValue.replace(/'/g, "''")}'`
                        : def.defaultValue;
                colDef += ` DEFAULT ${defaultVal}`;
            }
        }
        return colDef;
    }

    private validateField(field: string): void {
        if (!this.validFields.includes(field)) {
            throw new Error(`Invalid field name: ${field}. Valid fields: ${this.validFields.join(', ')}`);
        }
    }

    private getRecordColumns(record: Record<string, any>): string[] {
        return this.validFields.filter((col) => record[col] !== undefined);
    }

    private async loadExistingRows(itemIds: string[]): Promise<Map<string, Record<string, any>>> {
        const uniqueIds = [...new Set(itemIds)];
        if (uniqueIds.length === 0) return new Map();
        const placeholders = uniqueIds.map(() => '?').join(', ');
        const rows = (await this.runSelect(
            `SELECT * FROM ${this.tableName} WHERE item_id IN (${placeholders})`,
            uniqueIds
        )) as Record<string, any>[];
        return new Map(rows.filter((row) => row.item_id !== undefined).map((row) => [String(row.item_id), row]));
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
        const existingRows = await this.loadExistingRows(normalizedRecords.map((record) => String(record.item_id)));
        if (this.hasDuplicateItemIds(normalizedRecords)) {
            return await this.insertManySequentialForArkData(normalizedRecords, existingRows);
        }
        return await this.transaction(async () => {
            let count = 0;
            const seenItemIds = new Set(existingRows.keys());
            const insertGroups = new Map<string, BaseWriteGroup>();
            for (const record of normalizedRecords) {
                const itemId = String(record.item_id);
                if (seenItemIds.has(itemId)) continue;
                seenItemIds.add(itemId);
                const columns = this.getRecordColumns(record);
                if (columns.length === 0) continue;
                const values = columns.map((col) => record[col]);
                this.addWriteGroupRow(insertGroups, columns, values);
                count++;
            }
            for (const group of insertGroups.values()) {
                const placeholders = group.columns.map(() => '?').join(', ');
                await this.executeMany(
                    `INSERT INTO ${this.tableName} (${group.columns.join(', ')}) VALUES (${placeholders})`,
                    group.rows
                );
            }
            return count;
        });
    }

    private async insertManySequentialForArkData(
        normalizedRecords: Record<string, any>[],
        existingRows: Map<string, Record<string, any>>
    ): Promise<number> {
        return await this.transaction(async () => {
            let count = 0;
            const seenItemIds = new Set(existingRows.keys());
            for (const record of normalizedRecords) {
                const itemId = String(record.item_id);
                if (seenItemIds.has(itemId)) continue;
                seenItemIds.add(itemId);
                const columns = this.getRecordColumns(record);
                if (columns.length === 0) continue;
                const placeholders = columns.map(() => '?').join(', ');
                const values = columns.map((col) => record[col]);
                await this.runExec(
                    `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders})`,
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
        const existingRows = await this.loadExistingRows(normalizedRecords.map((record) => String(record.item_id)));
        if (this.hasDuplicateItemIds(normalizedRecords)) {
            return await this.upsertManySequentialForArkData(normalizedRecords, existingRows);
        }
        return await this.transaction(async () => {
            let count = 0;
            const currentRows = new Map(existingRows);
            const insertGroups = new Map<string, BaseWriteGroup>();
            const updateGroups = new Map<string, BaseWriteGroup>();
            for (const record of normalizedRecords) {
                const itemId = String(record.item_id);
                const columns = this.getRecordColumns(record);
                if (columns.length === 0) continue;
                const updateColumns = columns.filter((col) => col !== 'item_id');
                const existing = currentRows.get(itemId);
                if (!existing) {
                    const values = columns.map((col) => record[col]);
                    this.addWriteGroupRow(insertGroups, columns, values);
                    count++;
                    currentRows.set(itemId, { ...record });
                    continue;
                }
                if (updateColumns.length === 0) continue;
                const hasChanges = updateColumns.some((col) => !Object.is(existing[col], record[col]));
                if (!hasChanges) continue;
                const values = [...updateColumns.map((col) => record[col]), itemId];
                this.addWriteGroupRow(updateGroups, updateColumns, values);
                count++;
                currentRows.set(itemId, { ...existing, ...record });
            }
            for (const group of insertGroups.values()) {
                const placeholders = group.columns.map(() => '?').join(', ');
                await this.executeMany(
                    `INSERT INTO ${this.tableName} (${group.columns.join(', ')}) VALUES (${placeholders})`,
                    group.rows
                );
            }
            for (const group of updateGroups.values()) {
                const setClause = group.columns.map((col) => `${col} = ?`).join(', ');
                await this.executeMany(`UPDATE ${this.tableName} SET ${setClause} WHERE item_id = ?`, group.rows);
            }
            return count;
        });
    }

    private async upsertManySequentialForArkData(
        normalizedRecords: Record<string, any>[],
        existingRows: Map<string, Record<string, any>>
    ): Promise<number> {
        return await this.transaction(async () => {
            let count = 0;
            const currentRows = new Map(existingRows);
            for (const record of normalizedRecords) {
                const itemId = String(record.item_id);
                const columns = this.getRecordColumns(record);
                if (columns.length === 0) continue;
                const updateColumns = columns.filter((col) => col !== 'item_id');
                const existing = currentRows.get(itemId);
                if (!existing) {
                    const placeholders = columns.map(() => '?').join(', ');
                    const values = columns.map((col) => record[col]);
                    await this.runExec(
                        `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders})`,
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
                await this.runExec(`UPDATE ${this.tableName} SET ${setClause} WHERE item_id = ?`, values);
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
        await this.runExec(`DELETE FROM ${this.tableName} WHERE item_id = ?`, [itemId]);
        return true;
    }

    async deleteMany(itemIds: string[]): Promise<number> {
        await this.ensureInitialized();
        if (itemIds.length === 0) return 0;
        const placeholders = itemIds.map(() => '?').join(', ');
        const countBefore = await this.count([{ field: 'item_id', operator: 'in', value: itemIds }]);
        await this.runExec(`DELETE FROM ${this.tableName} WHERE item_id IN (${placeholders})`, itemIds);
        return countBefore;
    }

    async deleteByConditions(conditions: BaseQueryCondition[]): Promise<number> {
        await this.ensureInitialized();
        if (conditions.length === 0) throw new Error('At least one condition is required for deleteByConditions');
        const countBefore = await this.count(conditions);
        const { whereClause, params } = this.buildWhereClause(conditions);
        await this.runExec(`DELETE FROM ${this.tableName} WHERE ${whereClause}`, params);
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
        const existingRows = await this.loadExistingRows(normalizedRecords.map((record) => String(record.item_id)));
        if (this.hasDuplicateItemIds(normalizedRecords)) {
            return await this.updateManySequentialForArkData(normalizedRecords, existingRows);
        }
        return await this.transaction(async () => {
            let count = 0;
            const currentRows = new Map(existingRows);
            const updateGroups = new Map<string, BaseWriteGroup>();
            for (const record of normalizedRecords) {
                const itemId = String(record.item_id);
                const columns = this.getRecordColumns(record).filter((col) => col !== 'item_id');
                if (columns.length === 0) continue;
                const existing = currentRows.get(itemId);
                if (!existing) continue;
                const hasChanges = columns.some((col) => !Object.is(existing[col], record[col]));
                if (!hasChanges) continue;
                const values = [...columns.map((field) => record[field]), itemId];
                this.addWriteGroupRow(updateGroups, columns, values);
                count++;
                currentRows.set(itemId, { ...existing, ...record });
            }
            for (const group of updateGroups.values()) {
                const setClause = group.columns.map((field) => `${field} = ?`).join(', ');
                await this.executeMany(`UPDATE ${this.tableName} SET ${setClause} WHERE item_id = ?`, group.rows);
            }
            return count;
        });
    }

    private async updateManySequentialForArkData(
        normalizedRecords: Record<string, any>[],
        existingRows: Map<string, Record<string, any>>
    ): Promise<number> {
        return await this.transaction(async () => {
            let count = 0;
            const currentRows = new Map(existingRows);
            for (const record of normalizedRecords) {
                const itemId = String(record.item_id);
                const columns = this.getRecordColumns(record).filter((col) => col !== 'item_id');
                if (columns.length === 0) continue;
                const existing = currentRows.get(itemId);
                if (!existing) continue;
                const hasChanges = columns.some((col) => !Object.is(existing[col], record[col]));
                if (!hasChanges) continue;
                const setClause = columns.map((field) => `${field} = ?`).join(', ');
                const values = [...columns.map((field) => record[field]), itemId];
                await this.runExec(`UPDATE ${this.tableName} SET ${setClause} WHERE item_id = ?`, values);
                count++;
                currentRows.set(itemId, { ...existing, ...record });
            }
            return count;
        });
    }

    async updateWhere(field: string, value: any, conditions: BaseQueryCondition[]): Promise<number> {
        await this.ensureInitialized();
        this.validateField(field);
        const countBefore = await this.count(conditions);
        const { whereClause, params } = this.buildWhereClause(conditions);
        await this.runExec(`UPDATE ${this.tableName} SET ${field} = ? WHERE ${whereClause}`, [value, ...params]);
        return countBefore;
    }

    async findById(itemId: string): Promise<Record<string, any> | undefined> {
        await this.ensureInitialized();
        return (await this.queryOneSql(`SELECT * FROM ${this.tableName} WHERE item_id = ?`, [itemId])) as
            | Record<string, any>
            | undefined;
    }

    async findByIds(itemIds: string[]): Promise<Record<string, any>[]> {
        await this.ensureInitialized();
        if (itemIds.length === 0) return [];
        const placeholders = itemIds.map(() => '?').join(', ');
        return (await this.queryAllSql(
            `SELECT * FROM ${this.tableName} WHERE item_id IN (${placeholders})`,
            itemIds
        )) as Record<string, any>[];
    }

    async findAll(options?: BaseQueryOptions): Promise<Record<string, any>[]> {
        await this.ensureInitialized();
        const explicitLimit = this.logicalLimit(options?.limit);
        if (explicitLimit === 0) return [];

        const requiresTransparentPaging =
            explicitLimit === undefined || explicitLimit > ARKDATA_SELECT_PAGE_ROWS || options?.offset !== undefined;
        if (!requiresTransparentPaging) {
            const { sql, params } = this.buildSelectSql(options, explicitLimit, undefined, false);
            return (await this.queryAllSql(sql, params)) as Record<string, any>[];
        }

        const targetLimit = explicitLimit ?? Infinity;
        const startOffset = options?.offset ?? 0;
        const rows: Record<string, any>[] = [];
        let fetched = 0;
        while (rows.length < targetLimit) {
            const remaining = targetLimit - rows.length;
            const pageLimit = Math.min(ARKDATA_SELECT_PAGE_ROWS, remaining);
            const pageOffset = startOffset + fetched;
            const { sql, params } = this.buildSelectSql(options, pageLimit, pageOffset, true);
            const page = (await this.queryAllSql(sql, params)) as Record<string, any>[];
            rows.push(...page);
            fetched += page.length;
            if (page.length < pageLimit) break;
        }
        return rows;
    }

    async search(
        conditions: BaseQueryCondition[],
        options?: Omit<BaseQueryOptions, 'conditions'>
    ): Promise<Record<string, any>[]> {
        return await this.findAll({ ...options, conditions });
    }

    async count(conditions?: BaseQueryCondition[]): Promise<number> {
        await this.ensureInitialized();
        let sql = `SELECT COUNT(*) AS count FROM ${this.tableName}`;
        const params: any[] = [];
        if (conditions && conditions.length > 0) {
            const { whereClause, params: whereParams } = this.buildWhereClause(conditions);
            sql += ` WHERE ${whereClause}`;
            params.push(...whereParams);
        }
        const row = (await this.queryOneSql(sql, params)) as { count?: number } | undefined;
        return Number(row?.count ?? 0);
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
        await this.runExec(`DELETE FROM ${this.tableName}`);
        return countBefore;
    }

    async dropStorage(): Promise<void> {
        await this.ensureInitialized();
        await this.kit().execSql(this.storeId, `DROP TABLE IF EXISTS ${this.tableName}`);
        await this.kit().execSql(this.storeId, `DROP TABLE IF EXISTS ${this.schemaMetaTableName}`);
        this.close();
    }

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureInitialized();
        if (hasArkDataTx(this.storeId)) return await fn();
        return await this.kit().transaction(this.storeId, async (tx) => {
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

    getSchema(): ColumnSchema {
        return this.schema;
    }

    getValidFields(): string[] {
        return [...this.validFields];
    }

    async getStats(): Promise<{ totalRecords: number; dbSize: number }> {
        await this.ensureInitialized();
        const totalRecords = await this.count();
        return { totalRecords, dbSize: 0 };
    }

    private async queryAllSql(sql: string, params: any[] = []): Promise<ArkDataRow[]> {
        return await this.runSelect(sql, params);
    }

    private async queryOneSql(sql: string, params: any[] = []): Promise<ArkDataRow | undefined> {
        const rows = await this.queryAllSql(sql, params);
        return rows[0];
    }

    private buildWhereClause(conditions: BaseQueryCondition[]): { whereClause: string; params: any[] } {
        const clauses: string[] = [];
        const params: any[] = [];
        for (const condition of conditions) {
            const { field, operator, value } = condition;
            const op = operator.toLowerCase() as BaseQueryOperator;
            this.validateField(field);
            if (op === 'path_descendant_or_self') {
                const pathClauses = normalizePathDescendantOrSelfValues(value).map((pathValue) => {
                    const [normalizedPath, descendantPattern] = pathDescendantOrSelfSqlValues(pathValue);
                    params.push(normalizedPath, descendantPattern);
                    return `(${field} = ? OR ${field} LIKE ? ESCAPE '\\')`;
                });
                clauses.push(pathClauses.length === 1 ? pathClauses[0] : `(${pathClauses.join(' OR ')})`);
            } else if (op === 'in' || op === 'notin') {
                if (!Array.isArray(value)) throw new Error(`${operator} requires array`);
                if (value.length === 0) {
                    clauses.push(op === 'in' ? '1 = 0' : '1 = 1');
                } else {
                    const placeholders = value.map(() => '?').join(', ');
                    clauses.push(`${field} ${op === 'in' ? 'IN' : 'NOT IN'} (${placeholders})`);
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

export default BaseIndexDBArkdata;
