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
    type NativeBridge,
    type OcrKit,
    type PeekResult,
    type SpeechKit
} from './common';

class SpeechKitProxy implements SpeechKit {
    async available(): Promise<boolean> {
        return window.native.call('speechKit:available');
    }

    async initialize(locale?: string | null): Promise<void> {
        return window.native.call('speechKit:initialize', locale ?? null);
    }

    async start(): Promise<void> {
        return window.native.call('speechKit:start');
    }

    async peek(): Promise<PeekResult> {
        return window.native.call('speechKit:peek');
    }

    async stop(): Promise<string> {
        return window.native.call('speechKit:stop');
    }

    async release(): Promise<void> {
        return window.native.call('speechKit:release');
    }
}

class OcrKitProxy implements OcrKit {
    async available(): Promise<boolean> {
        return false;
    }
}

class DatabaseKitProxy implements DatabaseKit {
    async available(): Promise<boolean> {
        return window.native.call('databaseKit:available');
    }

    execSql(storeId: string, sql: string): Promise<void> {
        return window.native.call('databaseKit:execSql', storeId, sql);
    }

    execSqlParams(storeId: string, sql: string, params: ArkDataValueType[]): Promise<void> {
        return window.native.call('databaseKit:execSqlParams', storeId, sql, params);
    }

    querySqlShort(storeId: string, sql: string): Promise<ArkDataRow[]> {
        return window.native.call('databaseKit:querySqlShort', storeId, sql);
    }

    openStore(storeId: string, opts?: ArkDataOpenStoreOptions): Promise<void> {
        return window.native.call('databaseKit:openStore', storeId, opts);
    }

    closeStore(storeId: string, opts?: ArkDataCloseStoreOptions): Promise<void> {
        return window.native.call('databaseKit:closeStore', storeId, opts);
    }

    executePrepared(
        storeId: string,
        sql: string,
        params: ArkDataValueType[],
        opts?: ArkDataExecOptions
    ): Promise<ArkDataExecResult> {
        return window.native.call('databaseKit:executePrepared', storeId, sql, params, opts);
    }

    executePreparedMany(
        storeId: string,
        sql: string,
        rows: ArkDataValueType[][],
        opts?: ArkDataExecManyOptions
    ): Promise<ArkDataExecResult> {
        const { onProgress: _omit, ...mainOpts } = opts ?? {};
        return window.native.call('databaseKit:executePreparedMany', storeId, sql, rows, mainOpts);
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
        return window.native.call('databaseKit:queryPrepared', storeId, sql, params, opts);
    }

    beginTransaction(storeId: string): Promise<ArkDataTxHandle> {
        return window.native.call('databaseKit:beginTransaction', storeId);
    }

    commitTransaction(storeId: string, tx: ArkDataTxHandle): Promise<void> {
        return window.native.call('databaseKit:commitTransaction', storeId, tx);
    }

    rollbackTransaction(storeId: string, tx: ArkDataTxHandle): Promise<void> {
        return window.native.call('databaseKit:rollbackTransaction', storeId, tx);
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

export class NativeBridgeProxy implements NativeBridge {
    async getPlatform(): Promise<string> {
        return window.native.call('getPlatform');
    }

    async getVariant(): Promise<string> {
        return window.native.call('getVariant');
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
}
