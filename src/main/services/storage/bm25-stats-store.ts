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

import { isBM25StorageText, type BM25TokenStats } from './bm25-tokenizer.js';
import { assertBM25Integer, bm25Contribution, compareBM25Text, rankBM25Hits } from './bm25-scoring.js';
import { recordStorageCleanupFailure, recordStorageInitializationFailure } from './platform.js';
import { removeSqliteStoreFiles } from './drop-utils.js';
import type { BM25RecordHit } from './bm25-scoring.js';

export type BM25DriverBackend = 'native' | 'wasm';
export type BM25Backend = BM25DriverBackend | 'arkdata';
export type BM25Result<T> = T | Promise<T>;
export type BM25Access = 'readwrite' | 'readonly';
export type BM25Row = Record<string, unknown>;
export type BM25Value = string | number | null;
export interface BM25Statement {
    /** True only when the handle was released, even if finalize reported a prior SQL error. */
    readonly isFinalized?: boolean;
    run(params: BM25Value[]): void;
    get(params: BM25Value[]): BM25Row | undefined;
    all(params: BM25Value[]): BM25Row[];
    finalize(): void;
}
export interface BM25Driver {
    readonly backend: BM25DriverBackend;
    exec(sql: string): void;
    prepare(sql: string): BM25Statement;
    close(): void;
}
export interface BM25PreparedRecord extends BM25TokenStats {
    item_id: string;
    field: string;
    subKey: string;
}
export interface BM25SearchOptions {
    field: string;
    topK?: number;
    allowedItemIds?: readonly string[];
}
export interface BM25Info {
    size: number;
    backend: BM25Backend;
    indexVersion: number;
    compatibility: 'compatible';
    fields: Record<string, { n: number; sum_len: number }>;
}
export interface BM25SearchDiagnostics {
    strategy: 'exact_in';
    totalTargetRows: number;
    exactCandidateCount: number;
    exactBatchSize: number;
    exactBatchCount: number;
}
export interface BM25IndexBackend {
    assertAvailable?(): BM25Result<void>;
    stopAccepting?(): BM25Result<void>;
    searchWithDiagnostics?(
        terms: readonly string[],
        options: BM25SearchOptions,
        collect?: boolean
    ): BM25Result<{
        hits: BM25RecordHit[];
        diagnostics: BM25SearchDiagnostics;
    }>;
    readonly backend: BM25Backend;
    insert(records: BM25PreparedRecord[]): BM25Result<void>;
    update(records: BM25PreparedRecord[]): BM25Result<void>;
    upsert(records: BM25PreparedRecord[]): BM25Result<void>;
    delete(itemIds: string[]): BM25Result<void>;
    clear(): BM25Result<void>;
    search(terms: readonly string[], options: BM25SearchOptions): BM25Result<BM25RecordHit[]>;
    getInfo(): BM25Result<BM25Info>;
    close(): BM25Result<void>;
    dropStorage(): BM25Result<void>;
}
export const BM25_INDEX_VERSION = 1;

const max = Number.MAX_SAFE_INTEGER;
const integer = (column: string, minimum: number) =>
    `CHECK(typeof(${column})='integer' AND ${column} BETWEEN ${minimum} AND ${max})`;
const text = (column: string, nonempty = true) =>
    `CHECK(typeof(${column})='text'${nonempty ? ` AND length(${column})>0` : ''})`;
export const BM25_TABLES: Readonly<Record<string, string>> = {
    terms: `CREATE TABLE terms (id INTEGER PRIMARY KEY ${integer('id', 1)}, term TEXT NOT NULL COLLATE BINARY UNIQUE ${text('term')})`,
    records: `CREATE TABLE records (id INTEGER PRIMARY KEY ${integer('id', 1)}, item_id TEXT NOT NULL COLLATE BINARY ${text('item_id')}, field TEXT NOT NULL COLLATE BINARY ${text('field')}, sub_key TEXT NOT NULL COLLATE BINARY DEFAULT '' ${text('sub_key', false)}, len INTEGER NOT NULL ${integer('len', 1)}, UNIQUE(item_id,field,sub_key))`,
    postings: `CREATE TABLE postings (term_id INTEGER NOT NULL ${integer('term_id', 1)} REFERENCES terms(id) ON DELETE RESTRICT, rec_id INTEGER NOT NULL ${integer('rec_id', 1)} REFERENCES records(id) ON DELETE CASCADE, tf INTEGER NOT NULL ${integer('tf', 1)}, PRIMARY KEY(term_id,rec_id)) WITHOUT ROWID`,
    field_stats: `CREATE TABLE field_stats (field TEXT NOT NULL COLLATE BINARY PRIMARY KEY ${text('field')}, n INTEGER NOT NULL ${integer('n', 0)}, sum_len INTEGER NOT NULL ${integer('sum_len', 0)}, CHECK((n=0 AND sum_len=0) OR (n>0 AND sum_len>=n))) WITHOUT ROWID`
};
const tableColumns: Record<string, Array<[string, string, number, number]>> = {
    terms: [
        ['id', 'INTEGER', 0, 1],
        ['term', 'TEXT', 1, 0]
    ],
    records: [
        ['id', 'INTEGER', 0, 1],
        ['item_id', 'TEXT', 1, 0],
        ['field', 'TEXT', 1, 0],
        ['sub_key', 'TEXT', 1, 0],
        ['len', 'INTEGER', 1, 0]
    ],
    postings: [
        ['term_id', 'INTEGER', 1, 1],
        ['rec_id', 'INTEGER', 1, 2],
        ['tf', 'INTEGER', 1, 0]
    ],
    field_stats: [
        ['field', 'TEXT', 1, 1],
        ['n', 'INTEGER', 1, 0],
        ['sum_len', 'INTEGER', 1, 0]
    ]
};
function checks(sql: string): string[] {
    const result: string[] = [];
    const normalized = sql.toLowerCase().replace(/[\s"`[\]]/g, '');
    let start = 0;
    while ((start = normalized.indexOf('check(', start)) !== -1) {
        let end = start + 6,
            depth = 1;
        for (; end < normalized.length && depth; end++) {
            if (normalized[end] === '(') depth++;
            if (normalized[end] === ')') depth--;
        }
        result.push(normalized.slice(start + 6, end - 1));
        start = end;
    }
    return result;
}
export class BM25CompatibilityError extends Error {
    readonly indexer = 'BM25Indexer';
    readonly expectedVersion: number;
    readonly direction: 'older' | 'newer' | 'invalid';
    constructor(
        readonly code: 'bm25_index_version_mismatch' | 'bm25_invalid_schema',
        readonly backend: BM25Backend,
        readonly actualVersion: unknown,
        detail: string,
        expectedVersion = BM25_INDEX_VERSION
    ) {
        super(`BM25 ${code}: ${detail}`, { cause: new Error(detail) });
        this.expectedVersion = expectedVersion;
        this.direction =
            typeof actualVersion === 'number' && actualVersion > 0 && actualVersion < expectedVersion
                ? 'older'
                : typeof actualVersion === 'number' && actualVersion > expectedVersion
                  ? 'newer'
                  : 'invalid';
    }
}
export function assertBM25Text(value: unknown, name: string, allowEmpty = false): asserts value is string {
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || !isBM25StorageText(value))
        throw new TypeError(`Invalid BM25 ${name}`);
}
export function validateBM25SearchOptions(options: BM25SearchOptions): void {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new TypeError('Invalid BM25 search options');
    assertBM25Text(options.field, 'field');
    assertBM25Integer(options.topK === undefined ? 10 : options.topK, 1, 'topK');
    if (options.allowedItemIds !== undefined) {
        if (!Array.isArray(options.allowedItemIds)) throw new TypeError('Invalid BM25 allowedItemIds');
        for (let i = 0; i < options.allowedItemIds.length; i++)
            assertBM25Text(options.allowedItemIds[i], 'allowedItemIds entry', true);
    }
}

export interface BM25SchemaSnapshot {
    version: unknown;
    objects: BM25Row[];
    rows: Record<string, BM25Row[]>;
}
export const BM25_INDEX_DDL = [
    'CREATE INDEX records_field ON records(field,id)',
    'CREATE INDEX postings_rec ON postings(rec_id,term_id)'
] as const;
export function inspectBM25Schema(
    snapshot: BM25SchemaSnapshot,
    backend: BM25Backend,
    expectedVersion = BM25_INDEX_VERSION
): 'uninitialized' | 'compatible' {
    const version = snapshot.version;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0 || version > 2147483647)
        throw new BM25CompatibilityError(
            'bm25_index_version_mismatch',
            backend,
            version,
            'invalid version',
            expectedVersion
        );
    const all = (sql: string): BM25Row[] => snapshot.rows[sql] ?? [];
    const objects = snapshot.objects;
    if (version === 0 && objects.length === 0) return 'uninitialized';
    if (version !== expectedVersion)
        throw new BM25CompatibilityError(
            'bm25_index_version_mismatch',
            backend,
            version,
            'incompatible version',
            expectedVersion
        );
    const invalid = (detail: string): never => {
        throw new BM25CompatibilityError('bm25_invalid_schema', backend, version, detail, expectedVersion);
    };
    if (
        objects.some((row) => row.type !== 'table' && row.type !== 'index') ||
        objects.filter((row) => row.type === 'table').length !== 4
    )
        invalid('unexpected schema objects');
    for (const [table, ddl] of Object.entries(BM25_TABLES)) {
        const object = objects.find((row) => row.type === 'table' && row.name === table);
        if (typeof object?.sql !== 'string') invalid(`missing table ${table}`);
        const sql = object!.sql as string;
        const columns = all(`PRAGMA table_info(${table})`);
        if (
            JSON.stringify(columns.map((row) => [row.name, row.type, row.notnull, row.pk])) !==
            JSON.stringify(tableColumns[table])
        )
            invalid(`invalid columns ${table}`);
        if (table === 'records' && columns.find((row) => row.name === 'sub_key')?.dflt_value !== "''")
            invalid('invalid sub_key default');
        if (checks(ddl).some((check) => !checks(sql).includes(check))) invalid(`missing constraints ${table}`);
        if (ddl.includes('WITHOUT ROWID') && !/without\s+rowid/i.test(sql)) invalid(`missing WITHOUT ROWID ${table}`);
        for (const [column, type] of tableColumns[table]) {
            if (
                type === 'TEXT' &&
                !new RegExp(`\\b${column}\\s+TEXT\\s+NOT\\s+NULL\\s+COLLATE\\s+BINARY`, 'i').test(sql)
            )
                invalid(`invalid collation ${table}.${column}`);
        }
    }
    const hasIndex = (table: string, columns: string[], unique: boolean) =>
        all(`PRAGMA index_list(${table})`).some((index) => {
            if (unique && index.unique !== 1) return false;
            if (index.partial !== 0 || typeof index.name !== 'string') return false;
            const quoted = index.name.replace(/'/g, "''");
            const parts = all(`PRAGMA index_xinfo('${quoted}')`).filter((row) => row.key === 1);
            return (
                JSON.stringify(parts.map((row) => row.name)) === JSON.stringify(columns) &&
                parts.every((row) => row.coll === 'BINARY' && row.desc === 0)
            );
        });
    if (
        !hasIndex('terms', ['term'], true) ||
        !hasIndex('records', ['item_id', 'field', 'sub_key'], true) ||
        !hasIndex('records', ['field', 'id'], false) ||
        !hasIndex('postings', ['rec_id', 'term_id'], false)
    )
        invalid('missing indexes');
    const fks = all('PRAGMA foreign_key_list(postings)');
    for (const [from, table, action] of [
        ['term_id', 'terms', 'RESTRICT'],
        ['rec_id', 'records', 'CASCADE']
    ]) {
        if (
            !fks.some(
                (row) =>
                    row.from === from &&
                    row.table === table &&
                    row.to === 'id' &&
                    row.on_delete === action &&
                    row.on_update === 'NO ACTION'
            )
        )
            invalid('invalid posting foreign keys');
    }
    return 'compatible';
}

export function validateBM25Records(records: BM25PreparedRecord[]): void {
    if (!Array.isArray(records)) throw new TypeError('Invalid BM25 records');
    for (const record of records) {
        if (!record || typeof record !== 'object') throw new TypeError('Invalid BM25 record');
        assertBM25Text(record.item_id, 'item_id');
        assertBM25Text(record.field, 'field');
        assertBM25Text(record.subKey, 'subKey', true);
        assertBM25Integer(record.len, 0, 'len');
        if (!(record.terms instanceof Map)) throw new TypeError('Invalid BM25 terms');
        let sum = 0;
        for (const [term, tf] of record.terms) {
            assertBM25Text(term, 'term');
            assertBM25Integer(tf, 1, 'tf');
            sum += tf;
            assertBM25Integer(sum, 0, 'sum tf');
        }
        if (sum !== record.len) throw new Error('BM25 len must equal sum of tf');
    }
}

export function validateBM25FieldStats(row: BM25Row | undefined): { n: number; sum_len: number } {
    if (row === undefined) return { n: 0, sum_len: 0 };
    assertBM25Integer(row.n, 0, 'n');
    assertBM25Integer(row.sum_len, 0, 'sum_len');
    if ((row.n === 0 && row.sum_len !== 0) || row.sum_len < row.n) throw new Error('Invalid BM25 field statistics');
    return { n: row.n, sum_len: row.sum_len };
}

export class BM25StatsStore {
    private statements = new Map<string, BM25Statement>();
    private initialized = false;
    private closed = false;
    private closing = false;
    private poisoned = false;
    private active = false;
    private dropped = false;
    constructor(
        readonly driver: BM25Driver,
        readonly dbPath: string,
        readonly access: BM25Access = 'readwrite'
    ) {}
    get backend(): BM25Backend {
        return this.driver.backend;
    }
    private statement(sql: string): BM25Statement {
        let statement = this.statements.get(sql);
        if (!statement) {
            statement = this.driver.prepare(sql);
            this.statements.set(sql, statement);
        }
        return statement;
    }
    private execute<T>(sql: string, operation: (statement: BM25Statement) => T): T {
        const statement = this.statement(sql);
        try {
            return operation(statement);
        } catch (error) {
            // Failed SQLite steps can poison the next bind/reset of a cached statement.
            try {
                statement.finalize();
                this.statements.delete(sql);
            } catch (cleanup) {
                if (statement.isFinalized === true) {
                    this.statements.delete(sql);
                } else {
                    this.poisoned = true;
                    recordStorageCleanupFailure(error, cleanup, 'BM25Indexer');
                }
            }
            throw error;
        }
    }
    private all(sql: string, params: BM25Value[] = []): BM25Row[] {
        return this.execute(sql, (statement) => statement.all(params));
    }
    private get(sql: string, params: BM25Value[] = []): BM25Row | undefined {
        return this.execute(sql, (statement) => statement.get(params));
    }
    private run(sql: string, params: BM25Value[] = []): void {
        this.execute(sql, (statement) => statement.run(params));
    }
    private integer(value: unknown, minimum: number, name: string): number {
        assertBM25Integer(value, minimum, name);
        return value;
    }
    private version(): number {
        const value = this.get('PRAGMA user_version')?.user_version;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2147483647) {
            throw new BM25CompatibilityError('bm25_index_version_mismatch', this.backend, value, 'invalid version');
        }
        return value;
    }
    private checkVersion(): number {
        const version = this.version();
        if (version !== BM25_INDEX_VERSION)
            throw new BM25CompatibilityError(
                'bm25_index_version_mismatch',
                this.backend,
                version,
                'incompatible version'
            );
        return version;
    }
    inspect(): 'uninitialized' | 'compatible' {
        const snapshot: BM25SchemaSnapshot = {
            version: this.version(),
            objects: this.all("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'"),
            rows: Object.create(null)
        };
        if (snapshot.version === 0 && snapshot.objects.length === 0) return 'uninitialized';
        // A competing creator may commit between the first version read and the schema read.
        snapshot.version = this.checkVersion();
        if (snapshot.objects.length > 0) {
            const read = (sql: string): BM25Row[] => (snapshot.rows[sql] = this.all(sql));
            for (const table of Object.keys(BM25_TABLES)) {
                read(`PRAGMA table_info(${table})`);
                for (const index of read(`PRAGMA index_list(${table})`)) {
                    if (typeof index.name === 'string') read(`PRAGMA index_xinfo('${index.name.replace(/'/g, "''")}')`);
                }
            }
            read('PRAGMA foreign_key_list(postings)');
        }
        return inspectBM25Schema(snapshot, this.backend);
    }
    initialize(): void {
        if (this.closed || this.closing || this.poisoned || this.dropped)
            throw new Error('BM25 store is closing or closed');
        if (this.initialized) return;
        this.driver.exec('PRAGMA busy_timeout=5000');
        this.driver.exec('PRAGMA foreign_keys=ON');
        if (this.get('PRAGMA foreign_keys')?.foreign_keys !== 1) throw new Error('BM25 foreign_keys unavailable');
        const state = this.inspect();
        if (this.access === 'readonly') {
            if (state !== 'compatible')
                throw Object.assign(new Error('BM25 store is uninitialized'), {
                    code: 'bm25_uninitialized',
                    indexer: 'BM25Indexer',
                    backend: this.backend
                });
        } else {
            const mode = this.backend === 'native' ? 'wal' : 'delete';
            if (
                this.get('PRAGMA journal_mode')?.journal_mode !== mode &&
                this.get(`PRAGMA journal_mode=${mode}`)?.journal_mode !== mode
            )
                throw new Error(`BM25 journal_mode must be ${mode}`);
            if (state === 'uninitialized')
                this.transaction(
                    true,
                    () => {
                        if (this.inspect() === 'uninitialized') {
                            for (const ddl of Object.values(BM25_TABLES)) this.driver.exec(ddl);
                            this.driver.exec('CREATE INDEX records_field ON records(field,id)');
                            this.driver.exec('CREATE INDEX postings_rec ON postings(rec_id,term_id)');
                            this.driver.exec(`PRAGMA user_version=${BM25_INDEX_VERSION}`);
                        }
                    },
                    false
                );
        }
        this.initialized = true;
    }
    private ensure(write = false): void {
        if (this.closed || this.closing || this.poisoned || this.dropped)
            throw new Error('BM25 store is closing or closed, or requires cleanup');
        if (!this.initialized) throw new Error('BM25 store not initialized');
        if (write && this.access === 'readonly') throw new Error('BM25 store is readonly');
    }
    private transaction<T>(write: boolean, fn: () => T, validate = true): T {
        if (validate) this.ensure(write);
        if (this.active) throw new Error('BM25 connection reentry');
        this.active = true;
        let began = false;
        try {
            this.driver.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
            began = true;
            if (validate) this.checkVersion();
            const value = fn();
            this.driver.exec('COMMIT');
            return value;
        } catch (error) {
            if (began) {
                try {
                    this.driver.exec('ROLLBACK');
                } catch (cleanup) {
                    this.poisoned = true;
                    recordStorageCleanupFailure(error, cleanup, 'BM25Indexer');
                }
            }
            throw error;
        } finally {
            this.active = false;
        }
    }
    close(): void {
        if (this.closed) return;
        this.closing = true;
        const errors: unknown[] = [];
        for (const [sql, statement] of this.statements) {
            try {
                statement.finalize();
                this.statements.delete(sql);
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length) {
            for (const other of errors.slice(1)) recordStorageCleanupFailure(errors[0], other, 'BM25Indexer');
            recordStorageInitializationFailure(errors[0], {
                indexer: 'BM25Indexer',
                backend: this.backend,
                operation: 'close'
            });
            throw errors[0];
        }
        try {
            this.driver.close();
        } catch (error) {
            recordStorageInitializationFailure(error, {
                indexer: 'BM25Indexer',
                backend: this.backend,
                operation: 'close'
            });
            throw error;
        }
        this.closed = true;
        this.initialized = false;
    }
    dropStorage(): void {
        if (this.access === 'readonly') throw new Error('BM25 store is readonly');
        this.close();
        removeSqliteStoreFiles(this.dbPath, [`${this.dbPath}-journal`]);
        this.dropped = true;
    }
    private fieldStats(field: string): { n: number; sum_len: number } {
        const row = this.get('SELECT n,sum_len FROM field_stats WHERE field=?', [field]);
        return validateBM25FieldStats(row);
    }
    private adjustField(field: string, dn: number, dl: number): void {
        const old = this.fieldStats(field);
        const n = this.integer(old.n + dn, 0, 'n');
        const sum = this.integer(old.sum_len + dl, 0, 'sum_len');
        this.run(
            'INSERT INTO field_stats(field,n,sum_len) VALUES (?,?,?) ON CONFLICT(field) DO UPDATE SET n=excluded.n,sum_len=excluded.sum_len',
            [field, n, sum]
        );
    }
    private findRecord(record: Pick<BM25PreparedRecord, 'item_id' | 'field' | 'subKey'>): BM25Row | undefined {
        return this.get('SELECT id,field,len FROM records WHERE item_id=? AND field=? AND sub_key=?', [
            record.item_id,
            record.field,
            record.subKey
        ]);
    }
    private removeRecord(row: BM25Row, affected: Set<number>): void {
        const id = this.integer(row.id, 1, 'record id');
        const len = this.integer(row.len, 1, 'len');
        assertBM25Text(row.field, 'field');
        for (const term of this.all('SELECT term_id FROM postings WHERE rec_id=?', [id]))
            affected.add(this.integer(term.term_id, 1, 'term id'));
        this.run('DELETE FROM postings WHERE rec_id=?', [id]);
        this.run('DELETE FROM records WHERE id=?', [id]);
        this.adjustField(row.field, -1, -len);
    }
    private cleanupTerms(affected: Set<number>): void {
        for (const id of affected)
            this.run('DELETE FROM terms WHERE id=? AND NOT EXISTS (SELECT 1 FROM postings WHERE term_id=?)', [id, id]);
    }
    private write(records: BM25PreparedRecord[], operation: 'insert' | 'update' | 'upsert'): void {
        this.ensure(true);
        validateBM25Records(records);
        // Empty batches still validate compatibility without reserving the writer lock.
        this.transaction(records.length > 0, () => {
            const key = (record: BM25PreparedRecord) => JSON.stringify([record.item_id, record.field, record.subKey]);
            const eligible =
                operation === 'update'
                    ? new Set(records.filter((record) => this.findRecord(record)).map(key))
                    : undefined;
            const affected = new Set<number>();
            const termIds = new Map<string, number>();
            for (const record of records) {
                if (eligible && !eligible.has(key(record))) continue;
                const previous = this.findRecord(record);
                if (operation === 'insert' && previous) continue;
                if (previous) this.removeRecord(previous, affected);
                if (record.len === 0) continue;
                this.run('INSERT INTO records(item_id,field,sub_key,len) VALUES (?,?,?,?)', [
                    record.item_id,
                    record.field,
                    record.subKey,
                    record.len
                ]);
                const id = this.integer(this.findRecord(record)?.id, 1, 'record id');
                for (const [term, tf] of record.terms) {
                    let termId = termIds.get(term);
                    if (termId === undefined) {
                        this.run('INSERT INTO terms(term) VALUES (?) ON CONFLICT(term) DO NOTHING', [term]);
                        termId = this.integer(this.get('SELECT id FROM terms WHERE term=?', [term])?.id, 1, 'term id');
                        termIds.set(term, termId);
                    }
                    affected.add(termId);
                    this.run('INSERT INTO postings(term_id,rec_id,tf) VALUES (?,?,?)', [termId, id, tf]);
                }
                this.adjustField(record.field, 1, record.len);
            }
            this.cleanupTerms(affected);
        });
    }
    insert(records: BM25PreparedRecord[]): void {
        this.write(records, 'insert');
    }
    update(records: BM25PreparedRecord[]): void {
        this.write(records, 'update');
    }
    upsert(records: BM25PreparedRecord[]): void {
        this.write(records, 'upsert');
    }
    delete(itemIds: string[]): void {
        this.ensure(true);
        if (!Array.isArray(itemIds)) throw new TypeError('Invalid BM25 item IDs');
        for (const id of itemIds) assertBM25Text(id, 'item_id', true);
        this.transaction(itemIds.length > 0, () => {
            const affected = new Set<number>();
            for (const id of new Set(itemIds)) {
                for (const row of this.all('SELECT id,field,len FROM records WHERE item_id=?', [id]))
                    this.removeRecord(row, affected);
            }
            this.cleanupTerms(affected);
        });
    }
    clear(): void {
        this.transaction(true, () => {
            for (const table of ['postings', 'records', 'terms', 'field_stats'])
                this.driver.exec(`DELETE FROM ${table}`);
        });
    }
    getInfo(): {
        size: number;
        backend: BM25Backend;
        indexVersion: number;
        compatibility: 'compatible';
        fields: Record<string, { n: number; sum_len: number }>;
    } {
        return this.transaction(false, () => {
            const fields: Record<string, { n: number; sum_len: number }> = Object.create(null);
            for (const row of this.all('SELECT field,n,sum_len FROM field_stats')) {
                assertBM25Text(row.field, 'field');
                fields[row.field] = this.fieldStats(row.field);
            }
            return {
                size: this.integer(this.get('SELECT COUNT(*) AS n FROM records')?.n, 0, 'record count'),
                backend: this.backend,
                indexVersion: BM25_INDEX_VERSION,
                compatibility: 'compatible',
                fields
            };
        });
    }
    search(terms: readonly string[], options: BM25SearchOptions): BM25RecordHit[] {
        this.ensure();
        validateBM25SearchOptions(options);
        if (!Array.isArray(terms)) throw new TypeError('Invalid BM25 query terms');
        for (const term of terms) assertBM25Text(term, 'query term');
        const sorted = [...new Set(terms)].sort(compareBM25Text);
        const allowed = options.allowedItemIds === undefined ? undefined : [...new Set(options.allowedItemIds)];
        return this.transaction(false, () => {
            if (sorted.length === 0 || allowed?.length === 0) return [];
            let hasTemp = false;
            const query = (): BM25RecordHit[] => {
                if (allowed) {
                    this.driver.exec(
                        'CREATE TEMP TABLE bm25_allowlist(item_id TEXT NOT NULL COLLATE BINARY PRIMARY KEY) WITHOUT ROWID'
                    );
                    hasTemp = true;
                    for (const id of allowed) this.run('INSERT INTO temp.bm25_allowlist(item_id) VALUES (?)', [id]);
                }
                const join = allowed ? ' JOIN temp.bm25_allowlist a ON a.item_id=r.item_id' : '';
                const corpus = allowed
                    ? this.get(
                          `SELECT COUNT(*) n,COALESCE(SUM(r.len),0) sum_len FROM records r${join} WHERE r.field=?`,
                          [options.field]
                      )!
                    : this.fieldStats(options.field);
                const n = this.integer(corpus.n, 0, 'n');
                const sum = this.integer(corpus.sum_len, 0, 'sum_len');
                if ((n === 0 && sum !== 0) || sum < n) throw new Error('Invalid BM25 corpus statistics');
                if (n === 0) return [];
                const hits = new Map<number, BM25RecordHit>();
                for (const term of sorted) {
                    const dictionary = this.get('SELECT id FROM terms WHERE term=?', [term]);
                    if (!dictionary) continue;
                    const termId = this.integer(dictionary.id, 1, 'term id');
                    const from = `FROM postings p JOIN records r ON r.id=p.rec_id${join} WHERE p.term_id=? AND r.field=?`;
                    const params = [termId, options.field];
                    const postings = this.all(`SELECT r.id,r.item_id,r.sub_key,r.len,p.tf ${from}`, params);
                    const df = this.integer(postings.length, 0, 'df');
                    if (df > n) throw new Error('Invalid BM25 df');
                    for (const row of postings) {
                        const id = this.integer(row.id, 1, 'record id');
                        const len = this.integer(row.len, 1, 'len');
                        const tf = this.integer(row.tf, 1, 'tf');
                        assertBM25Text(row.item_id, 'item_id');
                        assertBM25Text(row.sub_key, 'subKey', true);
                        let hit = hits.get(id);
                        if (!hit) {
                            hit = { item_id: row.item_id, field: options.field, subKey: row.sub_key, score: 0 };
                            hits.set(id, hit);
                        }
                        hit.score += bm25Contribution(n, df, sum, len, tf);
                    }
                }
                return rankBM25Hits([...hits.values()], options.topK ?? 10);
            };
            let hits: BM25RecordHit[] = [];
            let failure: unknown;
            let failed = false;
            try {
                hits = query();
            } catch (error) {
                failure = error;
                failed = true;
            }
            if (hasTemp) {
                try {
                    this.driver.exec('DROP TABLE temp.bm25_allowlist');
                } catch (cleanup) {
                    this.poisoned = true;
                    if (failed) recordStorageCleanupFailure(failure, cleanup, 'BM25Indexer');
                    else {
                        failure = cleanup;
                        failed = true;
                    }
                }
            }
            if (failed) throw failure;
            return hits;
        });
    }
    count(): number {
        return this.transaction(false, () =>
            this.integer(this.get('SELECT COUNT(*) AS n FROM records')?.n, 0, 'record count')
        );
    }
}
