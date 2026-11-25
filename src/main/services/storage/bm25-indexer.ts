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

import { Indexer, type IndexerSearchResult } from './indexer.js';
import type { Item, QueryOperator, ColumnSchema } from './abstract-storage.js';
import type { BaseIndexStoreProbeResult } from './base-indexer.js';
import { createBM25IndexDB, probeBM25IndexStore, type BM25StoreProbeResult } from './bm25-index-db-factory.js';
import { isArkDataBM25Busy } from './bm25-index-db-arkdata.js';
import { createBM25Tokenizer, type BM25Tokenizer } from './bm25-tokenizer.js';
import {
    type BM25IndexBackend,
    type BM25Info,
    assertBM25Text,
    validateBM25SearchOptions,
    type BM25SearchOptions,
    type BM25PreparedRecord,
    type BM25Access,
    type BM25Backend,
    type BM25SearchDiagnostics
} from './bm25-stats-store.js';
import type { BM25RecordHit } from './bm25-scoring.js';
import {
    getStorageInitializationFailure,
    recordStorageInitializationFailure,
    recordStorageCleanupFailure,
    type RetainStorageInitializationCleanup,
    type StorageInitializationCleanup
} from './platform.js';

export type IBM25IndexDB = BM25IndexBackend;
export type { BM25SearchOptions, BM25RecordHit, BM25StoreProbeResult };
export interface BM25TextRecord {
    item_id: string;
    field: string;
    subKey: string;
    text: string;
}
export interface BM25IndexerDependencies {
    platform?: string;
    tokenizer: (retain?: RetainStorageInitializationCleanup) => BM25Tokenizer | Promise<BM25Tokenizer>;
    database: (...args: Parameters<typeof createBM25IndexDB>) => IBM25IndexDB | Promise<IBM25IndexDB>;
    probe: typeof probeBM25IndexStore;
    prepare: (
        records: BM25TextRecord[],
        tokenizer: BM25Tokenizer
    ) => BM25PreparedRecord[] | Promise<BM25PreparedRecord[]>;
}

export function resolveBM25Access(schema: ColumnSchema): BM25Access {
    let access: BM25Access | undefined;
    for (const binding of Object.values(schema.needIndexers).flat()) {
        if (binding.indexer !== 'BM25Indexer' || binding.options === undefined) continue;
        const options = binding.options;
        if (!options || typeof options !== 'object' || Array.isArray(options))
            throw new Error('BM25 options must be an object');
        if (Object.keys(options).some((key) => key !== 'access')) throw new Error('Unknown BM25 option');
        const next = options.access;
        if (next === undefined) continue;
        if (next !== 'readonly' && next !== 'readwrite') throw new Error('Invalid BM25 access');
        if (access !== undefined && access !== next) throw new Error('Conflicting BM25 access');
        access = next;
    }
    return access ?? 'readwrite';
}

export function classifyBM25Failure(error: unknown) {
    const failure = getStorageInitializationFailure(error);
    const cause = failure?.cause ?? error;
    const code = (error as { code?: unknown })?.code ?? (cause as { code?: unknown })?.code;
    const facts = (error as any)?.details ?? (cause as any)?.details;
    const backend =
        failure?.backend ??
        (['native', 'wasm', 'arkdata'].includes(facts?.backend) ? (facts.backend as BM25Backend) : undefined);
    const corrupt =
        code === 'bm25_corrupt' ||
        (backend === 'native' && typeof code === 'string' && /^SQLITE_CORRUPT(?:_[A-Z0-9]+)*$/.test(code));
    const reason = corrupt
        ? 'corrupt'
        : code === 'bm25_missing'
          ? 'missing'
          : code === 'bm25_uninitialized'
            ? 'uninitialized'
            : code === 'bm25_index_version_mismatch'
              ? 'incompatible'
              : code === 'bm25_invalid_schema'
                ? 'invalid_schema'
                : code === 'bm25_tokenizer_unavailable'
                  ? 'tokenizer_unavailable'
                  : isArkDataBM25Busy(cause) ||
                      (typeof code === 'string' && /^SQLITE_(?:BUSY|LOCKED)(?:_[A-Z0-9]+)*$/.test(code))
                    ? 'busy'
                    : code === 'EACCES' || code === 'EPERM' || code === 'SQLITE_READONLY'
                      ? 'permission'
                      : code === 'MODULE_NOT_FOUND' || code === 'ERR_DLOPEN_FAILED'
                        ? 'native_dependency'
                        : 'unknown';
    return {
        kind: corrupt ? ('corrupt' as const) : ('other' as const),
        reason,
        indexer: 'BM25Indexer' as const,
        backend,
        operation: failure?.operation,
        availability:
            code === 'bm25_tokenizer_unavailable' &&
            ['temporary', 'terminal', 'unsupported'].includes(facts?.availability)
                ? (facts.availability as 'temporary' | 'terminal' | 'unsupported')
                : undefined,
        cause,
        cleanupFailures: failure?.cleanupFailures ?? []
    };
}

export class BM25Indexer extends Indexer {
    readonly name = 'BM25Indexer';
    readonly supportedFields: string[];
    readonly supportedOperators: QueryOperator[] = ['bm25_match'];
    private db: IBM25IndexDB | null = null;
    private tokenizer: BM25Tokenizer | null = null;
    private initializationPromise: Promise<void> | null = null;
    private closingPromise: Promise<void> | null = null;
    private closing = false;
    private isDropped = false;
    private dropPending: IBM25IndexDB | null = null;
    private initializationCleanup: StorageInitializationCleanup[] = [];
    private operations = new Set<Promise<unknown>>();
    private readonly access: BM25Access;
    private dependencies: BM25IndexerDependencies = {
        tokenizer: () => createBM25Tokenizer(),
        database: createBM25IndexDB,
        probe: probeBM25IndexStore,
        prepare: async (records, tokenizer) => {
            const prepared: BM25PreparedRecord[] = [];
            for (const { text, ...identity } of records)
                prepared.push({ ...identity, ...(await tokenizer.tokenize(text)) });
            return prepared;
        }
    };
    constructor(
        private readonly schema: ColumnSchema,
        private readonly _dbPath: string
    ) {
        super();
        this.access = resolveBM25Access(schema);
        this.supportedFields = Object.entries(schema.needIndexers)
            .filter(([, bindings]) => bindings.some((binding) => binding.indexer === this.name))
            .map(([field]) => field);
    }
    private ensureAccepting(): void {
        if (this.isDropped) throw new Error('BM25Indexer storage has been dropped. Construct a new BM25Indexer.');
        if (this.closing || this.dropPending) throw new Error('BM25Indexer is closing or closed, or partially dropped');
        if (this.initializationCleanup.length) throw this.initializationCleanup[0].error;
    }
    private ensureDB(write = false): IBM25IndexDB {
        this.ensureAccepting();
        if (!this.db || !this.tokenizer) throw new Error('BM25Indexer not initialized. Call initialize() first.');
        if (write && this.access === 'readonly') throw new Error('BM25Indexer is readonly');
        return this.db;
    }
    private track<T>(operation: () => T | Promise<T>): Promise<T> {
        const pending = Promise.resolve().then(operation);
        this.operations.add(pending);
        void pending.then(
            () => this.operations.delete(pending),
            () => this.operations.delete(pending)
        );
        return pending;
    }
    initialize(): Promise<void> {
        try {
            this.ensureAccepting();
        } catch (error) {
            return Promise.reject(error);
        }
        if (this.initializationPromise) return this.initializationPromise;
        const pending = this.track(async () => {
            if ((this.dependencies.platform ?? process.platform) === 'openharmony' && this.access === 'readonly')
                throw Object.assign(new Error('BM25 readonly search is unsupported'), {
                    code: 'bm25_access_mode_unsupported',
                    details: { backend: 'arkdata', outcome: 'not_executed' }
                });
            if (this.db) {
                await this.tokenizer?.assertAvailable?.();
                await this.db.assertAvailable?.();
                return;
            }
            let tokenizer: BM25Tokenizer;
            try {
                tokenizer = await this.dependencies.tokenizer((cleanup) => this.initializationCleanup.push(cleanup));
            } catch (cause) {
                const error =
                    (cause as any)?.code === 'bm25_tokenizer_unavailable'
                        ? cause
                        : Object.assign(new Error('BM25 tokenizer unavailable', { cause }), {
                              code: 'bm25_tokenizer_unavailable'
                          });
                recordStorageInitializationFailure(error, { indexer: this.name, operation: 'initialize' });
                throw error;
            }
            this.tokenizer = tokenizer;
            this.ensureAccepting();
            const db = await this.dependencies.database(this.schema, this._dbPath, this.access, (cleanup) =>
                this.initializationCleanup.push(cleanup)
            );
            this.db = db;
            this.tokenizer = tokenizer;
            this.ensureAccepting();
            await tokenizer.assertAvailable?.();
        }).finally(() => {
            if (this.initializationPromise === pending) this.initializationPromise = null;
        });
        this.initializationPromise = pending;
        return pending;
    }
    validateSearch(query: string, options: BM25SearchOptions): void {
        if (typeof query !== 'string') throw new TypeError('Invalid BM25 query');
        validateBM25SearchOptions(options);
        if (!this.supportedFields.includes(options.field))
            throw new Error(`BM25Indexer does not support field: ${options.field}`);
    }
    async searchHits(query: string, options: BM25SearchOptions): Promise<BM25RecordHit[]> {
        return (await this.searchHitsWithDiagnostics(query, options)).hits;
    }
    async searchHitsWithDiagnostics(
        query: string,
        options: BM25SearchOptions,
        collect = false
    ): Promise<{
        hits: BM25RecordHit[];
        diagnostics?: BM25SearchDiagnostics;
    }> {
        const db = this.ensureDB();
        this.validateSearch(query, options);
        const tokenizer = this.tokenizer!;
        return this.track(async () => {
            const terms = [...(await tokenizer.tokenize(query)).terms.keys()];
            return db.searchWithDiagnostics
                ? db.searchWithDiagnostics(terms, options, collect)
                : { hits: await db.search(terms, options) };
        });
    }
    async search(): Promise<IndexerSearchResult> {
        throw new Error('Use BaseStorage.search, searchBM25 or searchScope for BM25 queries');
    }
    private buildRecords(items: Item[]): BM25TextRecord[] {
        if (!Array.isArray(items)) throw new TypeError('Invalid BM25 items');
        const records: BM25TextRecord[] = [];
        for (const item of items) {
            if (!item || typeof item !== 'object') throw new TypeError('Invalid BM25 item');
            const entries = item.indexer_columns?.[this.name];
            if (entries === undefined || entries === null) continue;
            if (!Array.isArray(entries)) throw new TypeError('Invalid BM25 payload');
            if (entries.length === 0) continue;
            assertBM25Text(item.item_id, 'item_id');
            for (const entry of entries) {
                if (!entry || typeof entry !== 'object') throw new TypeError('Invalid BM25 entry');
                assertBM25Text(entry.column, 'column');
                if (!this.supportedFields.includes(entry.column))
                    throw new Error(`BM25Indexer does not support field: ${entry.column}`);
                if (typeof entry.content !== 'string') throw new TypeError('Invalid BM25 content');
                const subKey = entry.id === undefined ? '' : entry.id;
                assertBM25Text(subKey, 'id', true);
                records.push({ item_id: item.item_id, field: entry.column, subKey, text: entry.content });
            }
        }
        return records;
    }
    private async write(items: Item[], operation: 'insert' | 'update' | 'upsert'): Promise<void> {
        const db = this.ensureDB(true);
        const records = this.buildRecords(items);
        const tokenizer = this.tokenizer!;
        return this.track(async () => {
            const prepared = records.length ? await this.dependencies.prepare(records, tokenizer) : [];
            if (db.backend === 'arkdata' && records.length) {
                await tokenizer.assertAvailable?.();
                if (this.closing)
                    throw Object.assign(new Error('BM25 owner closing'), {
                        code: 'operation_aborted',
                        details: { source: 'storage', reason: 'closing', outcome: 'not_executed' }
                    });
            }
            await db[operation](prepared);
        });
    }
    insert(items: Item[]): Promise<void> {
        return this.write(items, 'insert');
    }
    update(items: Item[]): Promise<void> {
        return this.write(items, 'update');
    }
    upsert(items: Item[]): Promise<void> {
        return this.write(items, 'upsert');
    }
    async delete(itemIds: string[]): Promise<void> {
        const db = this.ensureDB(true);
        return this.track(() => db.delete(itemIds));
    }
    async clear(): Promise<void> {
        const db = this.ensureDB(true);
        return this.track(() => db.clear());
    }
    getBackend(): BM25Backend {
        return this.ensureDB().backend;
    }
    async getInfo(): Promise<BM25Info & { tokenizer: BM25Tokenizer['backend'] }> {
        const db = this.ensureDB();
        const tokenizer = this.tokenizer!;
        return this.track(async () => ({ ...(await db.getInfo()), tokenizer: tokenizer.backend }));
    }
    async probeBM25Store(): Promise<BM25StoreProbeResult> {
        this.ensureAccepting();
        return this.track(() =>
            this.dependencies.probe(this._dbPath, (cleanup) => this.initializationCleanup.push(cleanup))
        );
    }
    async probeStore(): Promise<BaseIndexStoreProbeResult> {
        const result = await this.probeBM25Store();
        return result.status === 'exists'
            ? 'exists'
            : result.status === 'missing' || result.status === 'uninitialized'
              ? 'missing'
              : 'open_failed';
    }
    close(): Promise<void> {
        if (this.closingPromise) return this.closingPromise;
        this.closing = true;
        const notices = [this.db?.stopAccepting?.(), this.tokenizer?.stopAccepting?.()];
        const pending = (async () => {
            const notificationResults = await Promise.allSettled(notices);
            await Promise.allSettled([...this.operations]);
            const failures: unknown[] = notificationResults
                .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                .map((result) => result.reason);
            if (this.db) {
                try {
                    await this.db.close();
                    this.db = null;
                } catch (error) {
                    failures.push(error);
                }
            }
            if (this.tokenizer) {
                try {
                    await this.tokenizer.close?.();
                    this.tokenizer = null;
                } catch (error) {
                    failures.push(error);
                }
            }
            for (const cleanup of [...this.initializationCleanup]) {
                try {
                    await cleanup.close();
                    this.initializationCleanup.splice(this.initializationCleanup.indexOf(cleanup), 1);
                } catch (error) {
                    failures.push(error);
                }
            }
            if (failures.length) {
                for (const failure of failures.slice(1)) recordStorageCleanupFailure(failures[0], failure, this.name);
                throw failures[0];
            }
            this.closing = false;
        })().finally(() => {
            if (this.closingPromise === pending) this.closingPromise = null;
        });
        this.closingPromise = pending;
        return pending;
    }
    async dropStorage(): Promise<void> {
        if (this.isDropped) throw new Error('BM25Indexer storage has been dropped');
        if (this.access === 'readonly') throw new Error('BM25Indexer is readonly');
        if (!this.dropPending) {
            // A failed probe may coexist with a usable DB. Keep its identity before
            // closing either owner so a failed cleanup/delete can be retried.
            if (this.db) this.dropPending = this.db;
            else {
                if (this.initializationCleanup.length) await this.close();
                this.dropPending = this.ensureDB(true);
            }
        }
        const store = this.dropPending;
        await this.close();
        try {
            await store.dropStorage();
        } catch (error) {
            recordStorageInitializationFailure(error, {
                indexer: this.name,
                backend: store.backend,
                operation: 'delete'
            });
            throw error;
        }
        this.dropPending = null;
        this.isDropped = true;
    }
}
export function createBM25Indexer(schema: ColumnSchema, dbPath: string): BM25Indexer {
    return new BM25Indexer(schema, dbPath);
}
export default BM25Indexer;
