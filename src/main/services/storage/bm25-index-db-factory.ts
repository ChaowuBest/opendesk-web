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

import fs from 'node:fs';
import { BM25IndexDBArkdata } from './bm25-index-db-arkdata.js';
import type { DatabaseKit } from '../../../platforms/bridges/common.js';
import type { ColumnSchema } from './abstract-storage.js';
import { BM25IndexDB, openBM25NativeDriver, type BM25NativeLoader } from './bm25-index-db.js';
import { BM25IndexDBWasm, openBM25WasmDriver, type BM25WasmLoader } from './bm25-index-db-wasm.js';
import {
    BM25StatsStore,
    BM25CompatibilityError,
    BM25_INDEX_VERSION,
    type BM25Access,
    type BM25Backend,
    type BM25Driver,
    type BM25IndexBackend,
    type BM25DriverBackend
} from './bm25-stats-store.js';
import {
    createWithNativeSqliteFallback,
    recordStorageInitializationFailure,
    recordStorageCleanupFailure,
    getStorageInitializationFailure,
    isNativeSqliteUnavailable,
    type RetainStorageInitializationCleanup,
    type StorageInitializationFailure
} from './platform.js';
import { assertWasmStoresUnlocked, removeSqliteStoreFiles } from './drop-utils.js';
import { toWasmDbPath } from './wasm-path.js';

export type BM25StoreProbeResult =
    | { status: 'exists'; backend: BM25Backend; indexVersion: number; compatibility: 'compatible' }
    | { status: 'unsupported'; backend: 'arkdata' }
    | { status: 'missing'; backend?: BM25Backend }
    | { status: 'uninitialized'; backend: BM25Backend }
    | { status: 'incompatible'; reason: string; expectedVersion?: number; actualVersion?: unknown }
    | { status: 'open_failed'; failure: Readonly<StorageInitializationFailure> };

export interface BM25DBDependencies {
    platform?: string;
    kit?: DatabaseKit;
    forceWasm?: boolean;
    nativeLoader?: BM25NativeLoader;
    wasmLoader?: BM25WasmLoader;
    wrapDriver?: (driver: BM25Driver) => BM25Driver;
}

function cleanupFailure(store: BM25StatsStore, error: unknown, retain: RetainStorageInitializationCleanup): void {
    try {
        store.close();
    } catch (cleanup) {
        recordStorageCleanupFailure(error, cleanup, 'BM25Indexer');
        retain({ error, close: () => store.close() });
    }
}
export async function createBM25IndexDB(
    schema: ColumnSchema,
    dbPath: string,
    access: BM25Access,
    retain: RetainStorageInitializationCleanup,
    dependencies: BM25DBDependencies = {}
): Promise<BM25IndexBackend> {
    if ((dependencies.platform ?? process.platform) === 'openharmony') {
        if (access === 'readonly')
            throw Object.assign(new Error('BM25 readonly search is unsupported'), {
                code: 'bm25_access_mode_unsupported',
                details: { backend: 'arkdata', outcome: 'not_executed' }
            });
        const store = new BM25IndexDBArkdata(dbPath, dependencies.kit);
        try {
            await store.initialize();
            return store;
        } catch (error) {
            try {
                await store.close();
            } catch (cleanup) {
                recordStorageCleanupFailure(error, cleanup, 'BM25Indexer');
                retain({ error, close: () => store.close() });
            }
            throw error;
        }
    }
    const open = async (backend: BM25DriverBackend) => {
        let store: BM25StatsStore | undefined;
        try {
            store =
                backend === 'native'
                    ? new BM25IndexDB(schema, dbPath, access, dependencies.nativeLoader)
                    : new BM25IndexDBWasm(schema, dbPath, access, dependencies.wasmLoader);
            if (dependencies.wrapDriver) {
                // Retain the original owner if a test adapter fails before transfer.
                const wrapped = dependencies.wrapDriver(store.driver);
                store = new BM25StatsStore(wrapped, store.dbPath, access);
            }
            store.initialize();
            return store;
        } catch (cause) {
            let error = cause;
            if (!store && access === 'readonly' && !isNativeSqliteUnavailable(cause)) {
                const code = (cause as NodeJS.ErrnoException)?.code;
                if (code === 'SQLITE_CANTOPEN' || (backend === 'wasm' && (cause as Error)?.name === 'SQLite3Error')) {
                    try {
                        fs.statSync(backend === 'native' ? dbPath : toWasmDbPath(dbPath));
                    } catch (statError) {
                        if ((statError as NodeJS.ErrnoException).code === 'ENOENT')
                            error = Object.assign(new Error('BM25 store is missing', { cause }), {
                                code: 'bm25_missing'
                            });
                    }
                }
            }
            const operation = getStorageInitializationFailure(error)?.operation ?? 'initialize';
            recordStorageInitializationFailure(error, { indexer: 'BM25Indexer', backend, operation });
            if (operation === 'close') recordStorageCleanupFailure(error, error, 'BM25Indexer');
            if (store) cleanupFailure(store, error, retain);
            throw error;
        }
    };
    return createWithNativeSqliteFallback(
        () => open('native'),
        () => open('wasm'),
        dependencies
    );
}

export async function probeBM25IndexStore(
    dbPath: string,
    retain: RetainStorageInitializationCleanup,
    dependencies: BM25DBDependencies = {}
): Promise<BM25StoreProbeResult> {
    // A scan-lock contender must leave the writer's store untouched. Ordinary ArkData open may create it.
    if ((dependencies.platform ?? process.platform) === 'openharmony')
        return { status: 'unsupported', backend: 'arkdata' };
    const probe = async (backend: BM25DriverBackend): Promise<BM25StoreProbeResult> => {
        const physicalPath = backend === 'native' ? dbPath : toWasmDbPath(dbPath);
        let store: BM25StatsStore | undefined;
        const open = (filename: string) => {
            const raw =
                backend === 'native'
                    ? openBM25NativeDriver(
                          filename,
                          filename === ':memory:' ? 'readwrite' : 'readonly',
                          dependencies.nativeLoader
                      )
                    : openBM25WasmDriver(
                          filename,
                          filename === ':memory:' ? 'readwrite' : 'readonly',
                          dependencies.wasmLoader
                      );
            store = new BM25StatsStore(raw, filename, 'readonly');
            if (dependencies.wrapDriver) store = new BM25StatsStore(dependencies.wrapDriver(raw), filename, 'readonly');
            store.driver.exec('PRAGMA busy_timeout=5000');
            return store;
        };
        try {
            open(':memory:').close();
            store = undefined;
            try {
                fs.statSync(physicalPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', backend };
                throw error;
            }
            const target = open(physicalPath);
            const status = target.inspect();
            target.close();
            store = undefined;
            return status === 'uninitialized'
                ? { status, backend }
                : { status: 'exists', backend, indexVersion: BM25_INDEX_VERSION, compatibility: 'compatible' };
        } catch (error) {
            const operation = getStorageInitializationFailure(error)?.operation ?? 'initialize';
            recordStorageInitializationFailure(error, { indexer: 'BM25Indexer', backend, operation });
            if (operation === 'close') recordStorageCleanupFailure(error, error, 'BM25Indexer');
            if (store) cleanupFailure(store, error, retain);
            if (
                error instanceof BM25CompatibilityError &&
                !getStorageInitializationFailure(error)?.cleanupFailures.length
            ) {
                return {
                    status: 'incompatible',
                    reason: error.code,
                    expectedVersion: error.expectedVersion,
                    actualVersion: error.actualVersion
                };
            }
            throw error;
        }
    };
    try {
        return await createWithNativeSqliteFallback(
            () => probe('native'),
            () => probe('wasm'),
            dependencies
        );
    } catch (error) {
        return {
            status: 'open_failed',
            failure: getStorageInitializationFailure(error) ?? {
                indexer: 'BM25Indexer',
                operation: 'initialize',
                cause: error,
                cleanupFailures: []
            }
        };
    }
}
export async function dropBM25IndexStore(dbPath: string, dependencies: BM25DBDependencies = {}): Promise<void> {
    if ((dependencies.platform ?? process.platform) === 'openharmony') {
        await new BM25IndexDBArkdata(dbPath, dependencies.kit).dropStorage();
        return;
    }
    assertWasmStoresUnlocked([dbPath]);
    for (const file of new Set([dbPath, toWasmDbPath(dbPath)])) removeSqliteStoreFiles(file, [`${file}-journal`]);
}
