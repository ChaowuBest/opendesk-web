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
    type DatabaseKit,
    type HuaweiAccountKit,
    type NativeBridge,
    NaiveHuaweiAccountKit,
    type OcrKit,
    type PeekResult,
    type QuickCaptureKit,
    type QuickCapturePendingCapture,
    type QuickCaptureState,
    type SpeechKit,
    type StartupKit,
    type StartupState
} from './common.js';

/**
 * 原生桥接依赖宿主在 window 上注入 native。未注入时直接抛错，
 * 而不是把 undefined 当作可用桥接、在调用处炸出难以定位的 TypeError。
 */
function nativeBridge(): NonNullable<Window['native']> {
    if (!window.native) {
        throw new Error('window.native 未注入：platforms bridge 需要宿主提供原生桥接');
    }
    return window.native;
}

class SpeechKitProxy implements SpeechKit {
    async available(): Promise<boolean> {
        return nativeBridge().call('speechKit:available');
    }

    async initialize(locale?: string | null): Promise<void> {
        return nativeBridge().call('speechKit:initialize', locale ?? null);
    }

    async start(): Promise<void> {
        return nativeBridge().call('speechKit:start');
    }

    async peek(): Promise<PeekResult> {
        return nativeBridge().call('speechKit:peek');
    }

    async stop(): Promise<string> {
        return nativeBridge().call('speechKit:stop');
    }

    async release(): Promise<void> {
        return nativeBridge().call('speechKit:release');
    }
}

class OcrKitProxy implements OcrKit {
    async available(): Promise<boolean> {
        return false;
    }
}

class DatabaseKitProxy implements DatabaseKit {
    async available(): Promise<boolean> {
        return nativeBridge().call('databaseKit:available');
    }

    execSql(storeId: string, sql: string): Promise<void> {
        return nativeBridge().call('databaseKit:execSql', storeId, sql);
    }

    execSqlParams(storeId: string, sql: string, params: ArkDataValueType[]): Promise<void> {
        return nativeBridge().call('databaseKit:execSqlParams', storeId, sql, params);
    }

    querySqlShort(storeId: string, sql: string): Promise<ArkDataRow[]> {
        return nativeBridge().call('databaseKit:querySqlShort', storeId, sql);
    }

    openStore(storeId: string, opts?: ArkDataOpenStoreOptions): Promise<void> {
        return nativeBridge().call('databaseKit:openStore', storeId, opts);
    }

    closeStore(storeId: string, opts?: ArkDataCloseStoreOptions): Promise<void> {
        return nativeBridge().call('databaseKit:closeStore', storeId, opts);
    }

    executePrepared(
        storeId: string,
        sql: string,
        params: ArkDataValueType[],
        opts?: ArkDataExecOptions
    ): Promise<ArkDataExecResult> {
        return nativeBridge().call('databaseKit:executePrepared', storeId, sql, params, opts);
    }

    executePreparedMany(
        storeId: string,
        sql: string,
        rows: ArkDataValueType[][],
        opts?: ArkDataExecManyOptions
    ): Promise<ArkDataExecResult> {
        const { onProgress: _omit, ...mainOpts } = opts ?? {};
        return nativeBridge().call('databaseKit:executePreparedMany', storeId, sql, rows, mainOpts);
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
        return nativeBridge().call('databaseKit:queryPrepared', storeId, sql, params, opts);
    }

    beginTransaction(storeId: string): Promise<ArkDataTxHandle> {
        return nativeBridge().call('databaseKit:beginTransaction', storeId);
    }

    commitTransaction(storeId: string, tx: ArkDataTxHandle): Promise<void> {
        return nativeBridge().call('databaseKit:commitTransaction', storeId, tx);
    }

    rollbackTransaction(storeId: string, tx: ArkDataTxHandle): Promise<void> {
        return nativeBridge().call('databaseKit:rollbackTransaction', storeId, tx);
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

class StartupKitProxy implements StartupKit {
    async getState(): Promise<StartupState> {
        return nativeBridge().call('startupKit:getState');
    }

    async delegateSetting(enabled?: boolean): Promise<void> {
        return nativeBridge().call('startupKit:delegateSetting', enabled);
    }
}

class QuickCaptureKitProxy implements QuickCaptureKit {
    async getState(): Promise<QuickCaptureState> {
        return nativeBridge().call('quickCaptureKit:getState');
    }

    async setEnabled(enabled: boolean): Promise<QuickCaptureState> {
        return nativeBridge().call('quickCaptureKit:setEnabled', enabled);
    }

    async takePendingCapture(): Promise<QuickCapturePendingCapture | null> {
        return nativeBridge().call('quickCaptureKit:takePendingCapture');
    }
}

export class NativeBridgeProxy implements NativeBridge {
    async getStartupKit(): Promise<StartupKit> {
        return new StartupKitProxy();
    }

    async getPlatform(): Promise<string> {
        return nativeBridge().call('getPlatform');
    }

    async getVariant(): Promise<string> {
        return nativeBridge().call('getVariant');
    }

    async getSpeechKit(): Promise<SpeechKit> {
        return new SpeechKitProxy();
    }

    async getOcrKit(): Promise<OcrKit> {
        return new OcrKitProxy();
    }

    async getDatabaseKit(): Promise<DatabaseKit> {
        return new DatabaseKitProxy();
    }

    async getHuaweiAccountKit(): Promise<HuaweiAccountKit> {
        return new NaiveHuaweiAccountKit();
    }

    async getQuickCaptureKit(): Promise<QuickCaptureKit> {
        return new QuickCaptureKitProxy();
    }
}
