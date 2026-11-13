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

import type { BaseWorker } from '../../main/applications/base.js';
import {
    ArkDataBridgeError,
    executePreparedManyBatchedWith,
    type ArkDataBatchOptions,
    type ArkDataCloseStoreOptions,
    type ArkDataExecManyOptions,
    type ArkDataExecOptions,
    type ArkDataExecResult,
    type ArkDataOpenStoreOptions,
    type ArkDataRow,
    type ArkDataTxHandle,
    type ArkDataValueType,
    type DatabaseKit
} from './common.js';

export class WorkerDatabaseKitProxy implements DatabaseKit {
    constructor(private readonly worker: BaseWorker) {}

    async available(): Promise<boolean> {
        return process.env.ARKDATA_AVAILABLE === '1';
    }

    execSql(storeId: string, sql: string): Promise<void> {
        return this.worker.callAppWithResponse('databaseKitCall', 'execSql', storeId, sql);
    }

    execSqlParams(storeId: string, sql: string, params: ArkDataValueType[]): Promise<void> {
        return this.worker.callAppWithResponse('databaseKitCall', 'execSqlParams', storeId, sql, params);
    }

    querySqlShort(storeId: string, sql: string): Promise<ArkDataRow[]> {
        return this.worker.callAppWithResponse('databaseKitCall', 'querySqlShort', storeId, sql);
    }

    deleteStore(storeId: string, opts?: ArkDataOpenStoreOptions): Promise<void> {
        return this.worker.callAppWithResponse('databaseKitCall', 'deleteStore', storeId, opts);
    }

    openStore(storeId: string, opts?: ArkDataOpenStoreOptions): Promise<void> {
        return this.worker.callAppWithResponse('databaseKitCall', 'openStore', storeId, opts);
    }

    closeStore(storeId: string, opts?: ArkDataCloseStoreOptions): Promise<void> {
        return this.worker.callAppWithResponse('databaseKitCall', 'closeStore', storeId, opts);
    }

    executePrepared(
        storeId: string,
        sql: string,
        params: ArkDataValueType[],
        opts?: ArkDataExecOptions
    ): Promise<ArkDataExecResult> {
        return this.worker.callAppWithResponse('databaseKitCall', 'executePrepared', storeId, sql, params, opts);
    }

    executePreparedMany(
        storeId: string,
        sql: string,
        rows: ArkDataValueType[][],
        opts?: ArkDataExecManyOptions
    ): Promise<ArkDataExecResult> {
        const { onProgress: _omit, ...mainOpts } = opts ?? {};
        return this.worker.callAppWithResponse('databaseKitCall', 'executePreparedMany', storeId, sql, rows, mainOpts);
    }

    executePreparedManyBatched(
        storeId: string,
        sql: string,
        rows: ArkDataValueType[][],
        opts?: ArkDataBatchOptions
    ): Promise<ArkDataExecResult> {
        return executePreparedManyBatchedWith(
            (batchRows, batchOpts) => this.executePreparedMany(storeId, sql, batchRows, batchOpts),
            rows,
            opts
        );
    }

    queryPrepared(
        storeId: string,
        sql: string,
        params: ArkDataValueType[],
        opts?: ArkDataExecOptions
    ): Promise<ArkDataRow[]> {
        return this.worker.callAppWithResponse('databaseKitCall', 'queryPrepared', storeId, sql, params, opts);
    }

    beginTransaction(storeId: string): Promise<ArkDataTxHandle> {
        return this.worker.callAppWithResponse('databaseKitCall', 'beginTransaction', storeId);
    }

    commitTransaction(storeId: string, tx: ArkDataTxHandle): Promise<void> {
        return this.worker.callAppWithResponse('databaseKitCall', 'commitTransaction', storeId, tx);
    }

    rollbackTransaction(storeId: string, tx: ArkDataTxHandle): Promise<void> {
        return this.worker.callAppWithResponse('databaseKitCall', 'rollbackTransaction', storeId, tx);
    }

    async transaction<T>(storeId: string, fn: (tx: ArkDataTxHandle) => Promise<T>): Promise<T> {
        const tx = await this.beginTransaction(storeId);
        let result: T;
        try {
            result = await fn(tx);
        } catch (fnErr) {
            try {
                await this.rollbackTransaction(storeId, tx);
            } catch (rollbackErr) {
                const error: Error & { code?: string; details?: unknown } = new Error(
                    'Rollback failed after fn rejected',
                    { cause: fnErr }
                );
                error.code = 'transaction_rollback_after_fn_failed';
                error.details = { adapterError: rollbackErr };
                throw error;
            }
            throw fnErr;
        }
        try {
            await this.commitTransaction(storeId, tx);
        } catch (commitErr) {
            try {
                await this.rollbackTransaction(storeId, tx);
            } catch (rollbackErr) {
                throw new ArkDataBridgeError(
                    'transaction_rollback_after_commit_failed',
                    'bridge',
                    'Rollback failed after commit rejected',
                    { adapterError: rollbackErr },
                    commitErr
                );
            }
            throw commitErr;
        }
        return result;
    }
}
