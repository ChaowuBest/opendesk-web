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

import { randomUUID } from 'node:crypto';
import {
    ArkDataBridgeError,
    executePreparedManyBatchedWith,
    type ArkDataBM25Request,
    type ArkDataTxHandle,
    type DatabaseKit
} from '../../../platforms/bridges/common.js';
import { ArkDataStoreSession, getArkdataDatabaseKit } from './arkdata-bridge.js';
import { recordStorageInitializationFailure } from './platform.js';
import { createArkDataStoreId, toArkDataDbPath } from './arkdata-path.js';
import {
    BM25_TABLES,
    BM25CompatibilityError,
    assertBM25Text,
    validateBM25Records,
    validateBM25SearchOptions,
    validateBM25FieldStats,
    type BM25PreparedRecord,
    type BM25Info,
    type BM25SearchOptions,
    type BM25Value,
    BM25_INDEX_DDL,
    inspectBM25Schema,
    type BM25Row,
    type BM25SchemaSnapshot
} from './bm25-stats-store.js';

import {
    assertBM25Integer,
    bm25Contribution,
    compareBM25Text,
    rankBM25Hits,
    type BM25RecordHit
} from './bm25-scoring.js';

export const ARKDATA_BM25_INDEX_VERSION = 2;

interface BM25SearchWait {
    deadline: number;
}

const readSlots = new Map<string, { active: number; waiting: Set<() => void> }>();

function searchTimeout(cause?: unknown): ArkDataBridgeError {
    return new ArkDataBridgeError(
        'bm25_search_timeout',
        'bridge',
        'BM25 search timed out',
        {
            backend: 'arkdata',
            causeCode: (cause as ArkDataBridgeError)?.code
        },
        cause
    );
}

function checkDeadline(wait?: BM25SearchWait): void {
    if (wait && Date.now() >= wait.deadline) throw searchTimeout();
}

async function acquireRead(storeId: string, wait?: BM25SearchWait): Promise<() => void> {
    checkDeadline(wait);
    const slots = readSlots.get(storeId) ?? { active: 0, waiting: new Set<() => void>() };
    readSlots.set(storeId, slots);
    if (slots.active < 3) slots.active++;
    else
        await new Promise<void>((resolve, reject) => {
            let timer: NodeJS.Timeout | undefined;
            const grant = () => {
                clearTimeout(timer);
                resolve();
            };
            slots.waiting.add(grant);
            if (wait)
                timer = setTimeout(
                    () => {
                        slots.waiting.delete(grant);
                        reject(searchTimeout());
                    },
                    Math.max(0, wait.deadline - Date.now())
                );
        });
    return () => {
        const next = slots.waiting.values().next().value;
        if (next) {
            slots.waiting.delete(next);
            next();
        } else if (--slots.active === 0) readSlots.delete(storeId);
    };
}

export function isArkDataBM25Busy(error: unknown): error is {
    details: { source: 'sdk'; sdkErrorCode: number; closeError?: unknown };
} {
    const facts = (error as { details?: { source?: string; sdkErrorCode?: number } })?.details;
    return facts?.source === 'sdk' && [14800015, 14800024, 14800047].includes(facts.sdkErrorCode ?? 0);
}

/** BM25 uses ordinary store sessions and a separate SDK object transaction for each operation. */
export class BM25IndexDBArkdata {
    readonly backend = 'arkdata' as const;
    readonly dbPath: string;
    readonly storeId: string;
    private readonly kit: DatabaseKit;
    private owner: ArkDataStoreSession | null = null;
    private initialization: Promise<void> | null = null;
    private initialized = false;
    private closing = false;
    private released = false;
    private closingPromise: Promise<void> | null = null;
    private corruption: unknown;
    private readonly operations = new Set<Promise<unknown>>();
    private searchWaitMs = 25_000;
    private openRetryMs = 90_000;

    constructor(dbPath: string, kit?: DatabaseKit) {
        this.kit = kit ?? getArkdataDatabaseKit();
        this.dbPath = toArkDataDbPath(dbPath);
        this.storeId = createArkDataStoreId('arkdata-bm25', this.dbPath);
    }

    private track<T>(run: () => Promise<T>): Promise<T> {
        const pending = Promise.resolve().then(run);
        this.operations.add(pending);
        void pending.then(
            () => this.operations.delete(pending),
            () => this.operations.delete(pending)
        );
        return pending;
    }

    private async open(): Promise<void> {
        if (this.closing || this.released) throw new Error('BM25 store is closing or closed');
        if (this.owner) return this.owner.open();
        const owner = new ArkDataStoreSession(this.kit, this.storeId, { path: this.dbPath, vector: false });
        this.owner = owner;
        try {
            await owner.open();
        } catch (error) {
            if (isArkDataBM25Busy(error)) {
                try {
                    await owner.close();
                } catch (closeError) {
                    error.details.closeError = closeError;
                } finally {
                    this.owner = null;
                }
            }
            throw error;
        }
    }

    private storageError(error: unknown): unknown {
        const value = error as ArkDataBridgeError;
        const facts = value?.details as any;
        if (
            facts?.source === 'sdk' &&
            facts.sdkErrorCode === 14800011 &&
            facts.storeId === this.storeId &&
            [
                'store_open_failed',
                'sql_execute_failed',
                'sql_query_failed',
                'tx_begin_failed',
                'tx_commit_failed',
                'tx_rollback_failed',
                'sql_result_read_failed'
            ].includes(value.code)
        ) {
            this.corruption ??= new ArkDataBridgeError(
                'bm25_corrupt',
                'required',
                'BM25 database is corrupt',
                { ...facts, backend: this.backend, indexer: 'BM25Indexer' },
                error
            );
            return this.corruption;
        }
        return error;
    }
    private initializationError(error: unknown): never {
        error = this.storageError(error);
        recordStorageInitializationFailure(error, {
            indexer: 'BM25Indexer',
            backend: this.backend,
            operation: 'initialize'
        });
        if (error && typeof error === 'object') {
            const value = error as Error & { details?: Record<string, unknown> };
            value.details = { ...value.details, indexer: 'BM25Indexer', backend: this.backend, phase: 'initialize' };
        }
        throw error;
    }

    initialize(): Promise<void> {
        if (this.initialization) return this.initialization;
        if (this.closing || this.released) return Promise.reject(new Error('BM25 store is closing or closed'));
        if (this.corruption) return Promise.reject(this.corruption);
        if (this.initialized) return this.assertAvailable();
        const pending = this.track(async () => {
            const deadline = Date.now() + this.openRetryMs;
            let delay = 250;
            for (;;) {
                try {
                    await this.open();
                    const state = await this.transaction('read', (tx) => this.inspectTransaction(tx));
                    if (state === 'uninitialized')
                        await this.transaction('write', async (tx) => {
                            if ((await this.inspectTransaction(tx)) === 'uninitialized') {
                                for (const sql of [
                                    ...Object.values(BM25_TABLES),
                                    ...BM25_INDEX_DDL,
                                    `PRAGMA user_version=${ARKDATA_BM25_INDEX_VERSION}`
                                ])
                                    await this.execute(tx, sql);
                                await this.inspectTransaction(tx);
                            }
                        });
                    break;
                } catch (error) {
                    const remaining = deadline - Date.now();
                    if (
                        !isArkDataBM25Busy(error) ||
                        (error as { rollbackError?: unknown }).rollbackError ||
                        remaining <= 0 ||
                        this.closing
                    )
                        throw error;
                    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
                    if (Date.now() >= deadline) throw error;
                    delay = Math.min(delay * 2, 4000);
                }
            }
            this.initialized = true;
        })
            .catch((error) => this.initializationError(error))
            .finally(() => {
                if (this.initialization === pending) this.initialization = null;
            });
        this.initialization = pending;
        return pending;
    }

    private async transaction<T>(
        mode: 'read' | 'write',
        run: (tx: ArkDataTxHandle) => Promise<T>,
        wait?: BM25SearchWait
    ): Promise<T> {
        const release = mode === 'read' ? await acquireRead(this.storeId, wait) : undefined;
        try {
            checkDeadline(wait);
            const tx = await this.kit.beginTransaction(this.storeId, { mode });
            let committing = false;
            try {
                checkDeadline(wait);
                const result = await run(tx);
                checkDeadline(wait);
                committing = true;
                await this.kit.commitTransaction(this.storeId, tx);
                return result;
            } catch (error) {
                const code = (error as ArkDataBridgeError)?.code;
                if (
                    !committing ||
                    !['operation_timeout', 'operation_unresolved', 'rpc_timeout', 'envelope_parse_failed'].includes(
                        code
                    )
                ) {
                    try {
                        await this.kit.rollbackTransaction(this.storeId, tx);
                    } catch (cleanup) {
                        if (error instanceof Error) Object.assign(error, { rollbackError: cleanup });
                    }
                }
                throw error;
            }
        } catch (error) {
            if (wait && (error as ArkDataBridgeError)?.code === 'operation_timeout') throw searchTimeout(error);
            throw error;
        } finally {
            release?.();
        }
    }

    private async query(tx: ArkDataTxHandle | undefined, sql: string, params: BM25Value[] = []): Promise<BM25Row[]> {
        this.checkPayload(
            sql,
            params.map((v) => ({ t: 'scalar', v }))
        );
        return this.kit.queryPrepared(
            this.storeId,
            sql,
            params.map((v) => ({ t: 'scalar' as const, v })),
            { txId: tx?.id }
        );
    }
    private async inspectTransaction(tx?: ArkDataTxHandle): Promise<'uninitialized' | 'compatible'> {
        const snapshot: BM25SchemaSnapshot = {
            version: (await this.query(tx, 'PRAGMA user_version'))[0]?.user_version,
            objects: await this.query(tx, "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'"),
            rows: Object.create(null)
        };
        const read = async (sql: string) => (snapshot.rows[sql] = await this.query(tx, sql));
        if (snapshot.objects.length) {
            for (const table of Object.keys(BM25_TABLES)) {
                await read(`PRAGMA table_info(${table})`);
                for (const index of await read(`PRAGMA index_list(${table})`)) {
                    if (typeof index.name === 'string')
                        await read(`PRAGMA index_xinfo('${index.name.replace(/'/g, "''")}')`);
                }
            }
            await read('PRAGMA foreign_key_list(postings)');
        }
        return inspectBM25Schema(snapshot, this.backend, ARKDATA_BM25_INDEX_VERSION);
    }

    inspect(): Promise<'uninitialized' | 'compatible'> {
        if (!this.owner || this.closing || this.released)
            return Promise.reject(new Error('BM25 store not initialized or closed'));
        return this.track(() => this.transaction('read', (tx) => this.inspectTransaction(tx)));
    }

    private integer(value: unknown, minimum: number, name: string): number {
        assertBM25Integer(value, minimum, name);
        return value;
    }
    private checkPayload(sql: string, params: unknown): void {
        // JSON parameters are themselves string-encoded by Start/Ready transport. Doubling the
        // encoded body plus a fixed identity allowance bounds that outer envelope conservatively.
        if (2 * Buffer.byteLength(JSON.stringify([this.storeId, sql, params])) + 4096 > 6 * 1024 * 1024)
            throw new ArkDataBridgeError('payload_too_large', 'required', 'BM25 input exceeds the bridge budget', {
                source: 'storage',
                outcome: 'not_executed'
            });
    }
    private batches<T extends string | number>(values: T[], maximum = 128, reserved = 0): T[][] {
        const result: T[][] = [];
        let batch: T[] = [];
        let bytes = 0;
        for (const value of values) {
            const size = 2 * Buffer.byteLength(JSON.stringify(value)) + 64;
            if (size + reserved + 4096 > 6 * 1024 * 1024)
                throw new ArkDataBridgeError(
                    'payload_too_large',
                    'required',
                    'BM25 binding exceeds the request budget',
                    { source: 'storage', outcome: 'not_executed' }
                );
            if (batch.length && (batch.length >= maximum || bytes + size + reserved + 4096 > 6 * 1024 * 1024)) {
                result.push(batch);
                batch = [];
                bytes = 0;
            }
            batch.push(value);
            bytes += size;
        }
        if (batch.length) result.push(batch);
        return result;
    }
    private placeholders(values: readonly unknown[]): string {
        return values.map(() => '?').join(',');
    }
    private execute(tx: ArkDataTxHandle, sql: string, params: BM25Value[] = []): Promise<unknown> {
        this.checkPayload(
            sql,
            params.map((v) => ({ t: 'scalar', v }))
        );
        return this.kit.executePrepared(
            this.storeId,
            sql,
            params.map((v) => ({ t: 'scalar' as const, v })),
            { txId: tx?.id }
        );
    }
    private many(tx: ArkDataTxHandle, sql: string, rows: BM25Value[][]): Promise<unknown> {
        return executePreparedManyBatchedWith(
            (batch) => {
                this.checkPayload(sql, batch);
                return this.kit.executePreparedMany(this.storeId, sql, batch, { txId: tx.id });
            },
            rows.map((row) => row.map((v) => ({ t: 'scalar' as const, v }))),
            { maxRows: 500, maxBytes: 3 * 1024 * 1024 - 4096 - 2 * Buffer.byteLength(sql) }
        );
    }
    private operation<T>(
        mode: 'read' | 'write',
        run: (tx: ArkDataTxHandle) => Promise<T>,
        wait?: BM25SearchWait
    ): Promise<T> {
        return this.track(async () => {
            if (this.corruption) throw this.corruption;
            if (!this.initialized || this.closing) throw new Error('BM25 store not initialized');
            try {
                return await this.transaction(
                    mode,
                    async (tx) => {
                        const version = (await this.query(tx, 'PRAGMA user_version'))[0]?.user_version;
                        if (version !== ARKDATA_BM25_INDEX_VERSION)
                            throw new BM25CompatibilityError(
                                'bm25_index_version_mismatch',
                                this.backend,
                                version,
                                'incompatible version',
                                ARKDATA_BM25_INDEX_VERSION
                            );
                        return run(tx);
                    },
                    wait
                );
            } catch (error) {
                throw this.storageError(error);
            }
        });
    }
    async assertAvailable(): Promise<void> {
        await this.operation('read', async () => {});
    }
    private async page(tx: ArkDataTxHandle, sql: string, params: BM25Value[], cursor = 0): Promise<BM25Row[]> {
        const rows: BM25Row[] = [];
        let size = 5000;
        for (;;) {
            let page: BM25Row[];
            try {
                page = await this.query(tx, sql, [...params, cursor, size]);
            } catch (error) {
                const value = error as ArkDataBridgeError;
                const facts = value.details as any;
                if (
                    !['payload_row_limit_exceeded', 'payload_too_large'].includes(value.code) ||
                    facts?.resourceState !== 'healthy' ||
                    facts?.cleanupErrors?.length ||
                    size === 1
                )
                    throw error;
                size = Math.max(1, Math.floor(size / 2));
                continue;
            }
            if (page.length > size) throw new Error('Invalid BM25 page size');
            for (const row of page) {
                const id = this.integer(row.id, 1, 'cursor id');
                if (id <= cursor) throw new Error('Invalid BM25 cursor order');
                cursor = id;
                rows.push(row);
            }
            if (page.length < size) return rows;
        }
    }
    private async stats(tx: ArkDataTxHandle, field: string): Promise<{ n: number; sum_len: number }> {
        const row = (await this.query(tx, 'SELECT n,sum_len FROM field_stats WHERE field=?', [field]))[0];
        return validateBM25FieldStats(row);
    }
    private async adjust(tx: ArkDataTxHandle, field: string, dn: number, dl: number): Promise<void> {
        const old = await this.stats(tx, field);
        const n = this.integer(old.n + dn, 0, 'n');
        const sum = this.integer(old.sum_len + dl, 0, 'sum_len');
        await this.execute(
            tx,
            'INSERT INTO field_stats(field,n,sum_len) VALUES (?,?,?) ON CONFLICT(field) DO UPDATE SET n=excluded.n,sum_len=excluded.sum_len',
            [field, n, sum]
        );
    }
    private async remove(tx: ArkDataTxHandle, row: BM25Row, terms: Set<number>, records: Set<number>): Promise<void> {
        const id = this.integer(row.id, 1, 'record id');
        const len = this.integer(row.len, 1, 'len');
        assertBM25Text(row.field, 'field');
        records.add(id);
        for (const term of await this.page(
            tx,
            'SELECT term_id AS id FROM postings WHERE rec_id=? AND term_id>? ORDER BY term_id LIMIT ?',
            [id]
        ))
            terms.add(this.integer(term.id, 1, 'term id'));
        await this.execute(tx, 'DELETE FROM postings WHERE rec_id=?', [id]);
        await this.execute(tx, 'DELETE FROM records WHERE id=?', [id]);
        await this.adjust(tx, row.field, -1, -len);
    }
    private async cleanup(tx: ArkDataTxHandle, terms: Set<number>, records: Set<number>): Promise<void> {
        for (const batch of this.batches([...terms], 400))
            await this.execute(
                tx,
                `DELETE FROM terms WHERE id IN (${this.placeholders(batch)}) AND NOT EXISTS (SELECT 1 FROM postings WHERE term_id=terms.id)`,
                batch
            );
        for (const batch of this.batches([...records], 400)) {
            const row = (
                await this.query(
                    tx,
                    `SELECT COUNT(*) n FROM postings p LEFT JOIN records r ON r.id=p.rec_id LEFT JOIN terms t ON t.id=p.term_id WHERE p.rec_id IN (${this.placeholders(batch)}) AND (r.id IS NULL OR t.id IS NULL)`,
                    batch
                )
            )[0];
            if (this.integer(row?.n, 0, 'broken references') !== 0) throw new Error('BM25 association check failed');
        }
    }
    private async findMany(
        tx: ArkDataTxHandle,
        identities: Map<string, BM25PreparedRecord>
    ): Promise<Map<string, BM25Row>> {
        const found = new Map<string, BM25Row>();
        for (const keys of this.batches([...identities.keys()], 80, 8192)) {
            const params = keys.flatMap((key) => {
                const record = identities.get(key)!;
                return [record.item_id, record.field, record.subKey];
            });
            const rows = await this.query(
                tx,
                `SELECT id,item_id,field,sub_key,len FROM records WHERE ${keys.map(() => '(item_id=? AND field=? AND sub_key=?)').join(' OR ')}`,
                params
            );
            for (const row of rows) {
                this.integer(row.id, 1, 'record id');
                this.integer(row.len, 1, 'len');
                assertBM25Text(row.item_id, 'item_id', true);
                assertBM25Text(row.field, 'field');
                assertBM25Text(row.sub_key, 'subKey', true);
                const key = JSON.stringify([row.item_id, row.field, row.sub_key]);
                if (!identities.has(key) || found.has(key)) throw new Error('Invalid BM25 record lookup');
                found.set(key, row);
            }
        }
        return found;
    }
    private write(records: BM25PreparedRecord[], operation: 'insert' | 'update' | 'upsert'): Promise<void> {
        validateBM25Records(records);
        return this.operation(records.length ? 'write' : 'read', async (tx) => {
            const key = (record: BM25PreparedRecord) => JSON.stringify([record.item_id, record.field, record.subKey]);
            const identities = new Map(records.map((record) => [key(record), record]));
            const initial = await this.findMany(tx, identities);
            const final = new Map<string, BM25PreparedRecord>();
            const changes: Array<{ field: string; n: number; sum_len: number }> = [];
            // Resolve duplicates in input order, with update eligibility fixed at batch entry.
            for (const record of records) {
                const identity = key(record);
                if (operation === 'update' && !initial.has(identity)) continue;
                const present = final.has(identity) ? final.get(identity)!.len > 0 : initial.has(identity);
                if (operation === 'insert' && present) continue;
                if (present)
                    changes.push({
                        field: record.field,
                        n: -1,
                        sum_len: -(final.has(identity)
                            ? final.get(identity)!.len
                            : this.integer(initial.get(identity)!.len, 1, 'len'))
                    });
                if (record.len) changes.push({ field: record.field, n: 1, sum_len: record.len });
                final.set(identity, record);
            }
            const oldIds: number[] = [];
            const affectedTerms = new Set<number>();
            const affectedRecords = new Set<number>();
            for (const identity of final.keys()) {
                const previous = initial.get(identity);
                if (previous) {
                    const id = this.integer(previous.id, 1, 'record id');
                    oldIds.push(id);
                    affectedRecords.add(id);
                }
            }
            for (const batch of this.batches(oldIds, 128)) {
                for (const term of await this.page(
                    tx,
                    `SELECT DISTINCT term_id AS id FROM postings WHERE rec_id IN (${this.placeholders(batch)}) AND term_id>? ORDER BY term_id LIMIT ?`,
                    batch
                ))
                    affectedTerms.add(this.integer(term.id, 1, 'term id'));
                await this.execute(tx, `DELETE FROM postings WHERE rec_id IN (${this.placeholders(batch)})`, batch);
                await this.execute(tx, `DELETE FROM records WHERE id IN (${this.placeholders(batch)})`, batch);
            }
            const writes = [...final.values()].filter((record) => record.len > 0);
            const allTerms = [...new Set(writes.flatMap((record) => [...record.terms.keys()]))];
            const termIds = new Map<string, number>();
            await this.many(
                tx,
                'INSERT INTO terms(term) VALUES (?) ON CONFLICT(term) DO NOTHING',
                allTerms.map((term) => [term])
            );
            for (const batch of this.batches(allTerms, 400)) {
                for (const row of await this.query(
                    tx,
                    `SELECT id,term FROM terms WHERE term IN (${this.placeholders(batch)})`,
                    batch
                )) {
                    assertBM25Text(row.term, 'term');
                    const id = this.integer(row.id, 1, 'term id');
                    termIds.set(row.term, id);
                    affectedTerms.add(id);
                }
            }
            if (termIds.size !== allTerms.length) throw new Error('Incomplete BM25 term lookup');
            await this.many(
                tx,
                'INSERT INTO records(item_id,field,sub_key,len) VALUES (?,?,?,?)',
                writes.map((record) => [record.item_id, record.field, record.subKey, record.len])
            );
            const inserted = await this.findMany(tx, new Map(writes.map((record) => [key(record), record])));
            if (inserted.size !== writes.length) throw new Error('Incomplete BM25 record lookup');
            let postings: BM25Value[][] = [];
            for (const record of writes) {
                const id = this.integer(inserted.get(key(record))!.id, 1, 'record id');
                affectedRecords.add(id);
                for (const [term, tf] of record.terms) {
                    postings.push([termIds.get(term)!, id, tf]);
                    if (postings.length === 500) {
                        await this.many(tx, 'INSERT INTO postings(term_id,rec_id,tf) VALUES (?,?,?)', postings);
                        postings = [];
                    }
                }
            }
            await this.many(tx, 'INSERT INTO postings(term_id,rec_id,tf) VALUES (?,?,?)', postings);
            const stats = new Map<string, { n: number; sum_len: number }>();
            for (const fields of this.batches([...new Set(changes.map((change) => change.field))], 128)) {
                for (const row of await this.query(
                    tx,
                    `SELECT field,n,sum_len FROM field_stats WHERE field IN (${this.placeholders(fields)})`,
                    fields
                )) {
                    assertBM25Text(row.field, 'field');
                    stats.set(row.field, validateBM25FieldStats(row));
                }
            }
            // Preserve intermediate validation, including fields ending at zero after duplicate inputs.
            for (const change of changes) {
                const old = stats.get(change.field) ?? { n: 0, sum_len: 0 };
                const next = {
                    n: this.integer(old.n + change.n, 0, 'n'),
                    sum_len: this.integer(old.sum_len + change.sum_len, 0, 'sum_len')
                };
                validateBM25FieldStats(next);
                stats.set(change.field, next);
            }
            await this.many(
                tx,
                'INSERT INTO field_stats(field,n,sum_len) VALUES (?,?,?) ON CONFLICT(field) DO UPDATE SET n=excluded.n,sum_len=excluded.sum_len',
                [...stats].map(([field, value]) => [field, value.n, value.sum_len])
            );
            await this.cleanup(tx, affectedTerms, affectedRecords);
        });
    }
    insert(records: BM25PreparedRecord[]): Promise<void> {
        return this.write(records, 'insert');
    }
    update(records: BM25PreparedRecord[]): Promise<void> {
        return this.write(records, 'update');
    }
    upsert(records: BM25PreparedRecord[]): Promise<void> {
        return this.write(records, 'upsert');
    }
    delete(itemIds: string[]): Promise<void> {
        if (!Array.isArray(itemIds)) throw new TypeError('Invalid BM25 item IDs');
        for (const id of itemIds) assertBM25Text(id, 'item_id', true);
        return this.operation(itemIds.length ? 'write' : 'read', async (tx) => {
            const terms = new Set<number>(),
                records = new Set<number>();
            for (const batch of this.batches([...new Set(itemIds)], 398)) {
                const selected = await this.page(
                    tx,
                    `SELECT id,field,len FROM records WHERE item_id IN (${this.placeholders(batch)}) AND id>? ORDER BY id LIMIT ?`,
                    batch
                );
                for (const row of selected) await this.remove(tx, row, terms, records);
            }
            await this.cleanup(tx, terms, records);
        });
    }
    clear(): Promise<void> {
        return this.operation('write', async (tx) => {
            for (const table of ['postings', 'records', 'terms', 'field_stats'])
                await this.execute(tx, `DELETE FROM ${table}`);
        });
    }
    getInfo(): Promise<BM25Info> {
        return this.operation('read', async (tx) => {
            const fields: BM25Info['fields'] = Object.create(null);
            let cursor: string | undefined;
            let size = 128;
            for (;;) {
                let page: BM25Row[];
                try {
                    page = await this.query(
                        tx,
                        `SELECT field,n,sum_len FROM field_stats ${cursor === undefined ? '' : 'WHERE field>?'} ORDER BY field LIMIT ?`,
                        cursor === undefined ? [size] : [cursor, size]
                    );
                } catch (error) {
                    const value = error as ArkDataBridgeError;
                    const facts = value.details as any;
                    if (
                        !['payload_row_limit_exceeded', 'payload_too_large'].includes(value.code) ||
                        facts?.resourceState !== 'healthy' ||
                        facts?.cleanupErrors?.length ||
                        size === 1
                    )
                        throw error;
                    size = Math.max(1, Math.floor(size / 2));
                    continue;
                }
                for (const row of page) {
                    assertBM25Text(row.field, 'field');
                    fields[row.field] = validateBM25FieldStats(row);
                    cursor = row.field;
                }
                if (page.length < size) break;
            }
            return {
                size: this.integer((await this.query(tx, 'SELECT COUNT(*) n FROM records'))[0]?.n, 0, 'record count'),
                backend: this.backend,
                indexVersion: ARKDATA_BM25_INDEX_VERSION,
                compatibility: 'compatible',
                fields
            };
        });
    }
    async search(terms: readonly string[], options: BM25SearchOptions): Promise<BM25RecordHit[]> {
        return (await this.searchWithDiagnostics(terms, options)).hits;
    }
    searchWithDiagnostics(
        terms: readonly string[],
        options: BM25SearchOptions,
        collect = false
    ): Promise<{
        hits: BM25RecordHit[];
        diagnostics: {
            strategy: 'exact_in';
            totalTargetRows: number;
            exactCandidateCount: number;
            exactBatchSize: number;
            exactBatchCount: number;
        };
    }> {
        validateBM25SearchOptions(options);
        if (!Array.isArray(terms)) throw new TypeError('Invalid BM25 query terms');
        for (const term of terms) assertBM25Text(term, 'query term');
        const sorted = [...new Set(terms)].sort(compareBM25Text);
        const allowed = options.allowedItemIds === undefined ? undefined : [...new Set(options.allowedItemIds)];
        const wait: BM25SearchWait = { deadline: Date.now() + this.searchWaitMs };
        return this.operation(
            'read',
            async (tx) => {
                // Upload size is independent of the host's 128-ID SQL batches.
                const batches = allowed === undefined ? undefined : this.uploadBatches(allowed);
                const searchId = batches ? randomUUID() : undefined;
                if (batches)
                    for (let index = 0; index < batches.length; index++) {
                        const uploaded = await this.hostQuery(tx, wait, {
                            kind: 'allowlist',
                            searchId,
                            batchIndex: index,
                            batchCount: batches.length,
                            itemIds: batches[index]
                        });
                        if (!uploaded.uploaded) throw new Error('Invalid BM25 allowlist acknowledgement');
                    }
                // Empty scopes still use the explicit complete-list protocol.
                if (batches?.length === 0) {
                    const uploaded = await this.hostQuery(tx, wait, {
                        kind: 'allowlist',
                        searchId,
                        batchIndex: 0,
                        batchCount: 1,
                        itemIds: []
                    });
                    if (!uploaded.uploaded) throw new Error('Invalid BM25 allowlist acknowledgement');
                }
                const result = await this.hostQuery(tx, wait, {
                    kind: 'search',
                    searchId,
                    batchCount: batches ? Math.max(1, batches.length) : undefined,
                    field: options.field,
                    terms: sorted,
                    topK: options.topK ?? 10,
                    pageSize: 5000,
                    collect
                });
                if (!Array.isArray(result.hits) || !result.diagnostics) throw new Error('Invalid host BM25 result');
                for (const hit of result.hits) {
                    assertBM25Text(hit.item_id, 'item_id');
                    assertBM25Text(hit.field, 'field');
                    assertBM25Text(hit.subKey, 'subKey', true);
                    if (!Number.isFinite(hit.score) || hit.score < 0) throw new Error('Invalid host BM25 score');
                }
                return { hits: result.hits, diagnostics: result.diagnostics };
            },
            wait
        );
    }

    private uploadBatches(ids: string[]): string[][] {
        const batches: string[][] = [];
        let batch: string[] = [],
            bytes = 2;
        for (const id of ids) {
            // Account for encoding request JSON as a string in the outer bridge message.
            const size = Buffer.byteLength(JSON.stringify(JSON.stringify(id))) - 2 + 1;
            if (size + 8192 > 6 * 1024 * 1024)
                throw new ArkDataBridgeError('payload_too_large', 'required', 'BM25 item ID exceeds upload budget', {
                    outcome: 'not_executed'
                });
            if (batch.length && bytes + size + 8192 > 6 * 1024 * 1024) {
                batches.push(batch);
                batch = [];
                bytes = 2;
            }
            batch.push(id);
            bytes += size;
        }
        if (batch.length) batches.push(batch);
        return batches;
    }

    private hostQuery(tx: ArkDataTxHandle, wait: BM25SearchWait, request: Omit<ArkDataBM25Request, 'deadline'>) {
        checkDeadline(wait);
        return this.kit.bm25Query(this.storeId, { ...request, deadline: wait.deadline }, tx.id);
    }

    /** Prebuilt comparison path for tests; production search never falls back to App scoring. */
    searchReferenceWithDiagnostics(
        terms: readonly string[],
        options: BM25SearchOptions,
        collect = false
    ): Promise<{
        hits: BM25RecordHit[];
        diagnostics: {
            strategy: 'exact_in';
            totalTargetRows: number;
            exactCandidateCount: number;
            exactBatchSize: number;
            exactBatchCount: number;
        };
    }> {
        validateBM25SearchOptions(options);
        if (!Array.isArray(terms)) throw new TypeError('Invalid BM25 query terms');
        for (const term of terms) assertBM25Text(term, 'query term');
        const sorted = [...new Set(terms)].sort(compareBM25Text);
        const allowed = options.allowedItemIds === undefined ? undefined : [...new Set(options.allowedItemIds)];
        const largestTermBytes = sorted.reduce(
            (maximum, term) => Math.max(maximum, Buffer.byteLength(JSON.stringify(term))),
            0
        );
        const reserved = 2 * (Buffer.byteLength(JSON.stringify(options.field)) + largestTermBytes) + 128;
        const batches = allowed === undefined ? [undefined] : this.batches(allowed, 128, reserved);
        return this.operation('read', async (tx) => {
            const fieldStats = collect || allowed === undefined ? await this.stats(tx, options.field) : undefined;
            const diagnostics = {
                strategy: 'exact_in' as const,
                totalTargetRows: fieldStats?.n ?? 0,
                exactCandidateCount: allowed?.length ?? 0,
                exactBatchSize: allowed?.length ? Math.min(128, allowed.length) : 0,
                exactBatchCount: batches.length
            };
            let n = 0,
                sum = 0;
            for (const batch of batches) {
                const corpus: BM25Row =
                    batch === undefined
                        ? fieldStats!
                        : (
                              await this.query(
                                  tx,
                                  `SELECT COUNT(*) n,COALESCE(SUM(len),0) sum_len FROM records WHERE field=? AND item_id IN (${this.placeholders(batch)})`,
                                  [options.field, ...batch]
                              )
                          )[0];
                n += this.integer(corpus.n, 0, 'n');
                sum += this.integer(corpus.sum_len, 0, 'sum_len');
                assertBM25Integer(n, 0, 'n');
                assertBM25Integer(sum, 0, 'sum_len');
            }
            if (sum < n || (n === 0 && sum !== 0)) throw new Error('Invalid BM25 corpus statistics');
            const hits = new Map<number, BM25RecordHit>();
            if (n)
                for (const term of sorted) {
                    let df = 0;
                    const matching: BM25Row[] = [];
                    for (const batch of batches) {
                        const from = `FROM postings p JOIN records r ON r.id=p.rec_id JOIN terms t ON t.id=p.term_id WHERE t.term=? AND r.field=?${batch === undefined ? '' : ` AND r.item_id IN (${this.placeholders(batch)})`}`;
                        const params = [term, options.field, ...(batch ?? [])];
                        df += this.integer((await this.query(tx, `SELECT COUNT(*) n ${from}`, params))[0]?.n, 0, 'df');
                        for (const row of await this.page(
                            tx,
                            `SELECT r.id,r.item_id,r.sub_key,r.len,p.tf ${from} AND r.id>? ORDER BY r.id LIMIT ?`,
                            params
                        ))
                            matching.push(row);
                    }
                    assertBM25Integer(df, 0, 'df');
                    if (df > n || matching.length !== df) throw new Error('Incomplete BM25 postings or invalid df');
                    for (const row of matching) {
                        const id = this.integer(row.id, 1, 'record id');
                        assertBM25Text(row.item_id, 'item_id');
                        assertBM25Text(row.sub_key, 'subKey', true);
                        let hit = hits.get(id);
                        if (!hit) {
                            hit = { item_id: row.item_id, field: options.field, subKey: row.sub_key, score: 0 };
                            hits.set(id, hit);
                        }
                        hit.score += bm25Contribution(
                            n,
                            df,
                            sum,
                            this.integer(row.len, 1, 'len'),
                            this.integer(row.tf, 1, 'tf')
                        );
                    }
                }
            return { hits: rankBM25Hits([...hits.values()], options.topK ?? 10), diagnostics };
        });
    }

    stopAccepting(): Promise<void> {
        this.closing = true;
        return Promise.resolve();
    }

    close(): Promise<void> {
        if (this.released) return Promise.resolve();
        if (this.closingPromise) return this.closingPromise;
        const notification = this.stopAccepting();
        const closing = (async () => {
            await notification;
            await Promise.allSettled([...this.operations]);
            await this.owner?.close();
            this.owner = null;
            this.initialized = false;
            this.released = true;
        })().finally(() => {
            if (this.closingPromise === closing) this.closingPromise = null;
        });
        this.closingPromise = closing;
        return closing;
    }

    async dropStorage(): Promise<void> {
        await this.close();
        await this.kit.deleteStore(this.storeId, { path: this.dbPath, vector: false });
    }
}
