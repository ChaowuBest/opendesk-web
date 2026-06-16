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
import { logger } from '../../../main/utils/logger.js';
import { ArkDataBridgeError, executePreparedManyBatchedWith } from '../common.js';
import type {
    ArkDataBatchOptions,
    ArkDataCloseStoreOptions,
    ArkDataExecManyOptions,
    ArkDataExecOptions,
    ArkDataExecResult,
    ArkDataOpenStoreOptions,
    ArkDataRow,
    ArkDataTxHandle,
    ArkDataValueType,
    DatabaseKit
} from '../common.js';
import { callArkTS, EtsBridgeMethods, hasArkTSAdapter } from './arkts.js';

const POLL_INITIAL_MS = 50;
const POLL_MAX_MS = 500;
const POLL_TIMEOUT_MS = 30_000;
const pendingStoreCloses = new Map<string, Promise<void>>();

const REQUIRED_CODES = new Set([
    'store_id_conflict',
    'store_not_open',
    'store_closing',
    'store_force_closed',
    'store_busy_with_pending_ops',
    'store_busy_with_tx',
    'tx_active_on_store',
    'tx_invalid',
    'tx_already_committed',
    'tx_already_rolled_back',
    'tx_commit_failed',
    'tx_rollback_failed',
    'stmt_not_found',
    'stmt_no_params_bound',
    'stmt_no_rows_bound',
    'op_not_found',
    'op_type_mismatch',
    'param_type_invalid',
    'payload_json_invalid',
    'payload_shape_invalid',
    'payload_too_large',
    'payload_row_limit_exceeded',
    'batch_too_large',
    'vector_dim_mismatch',
    'sql_execute_failed',
    'sql_query_failed',
    'adapter_internal_error'
]);

const DIAGNOSTIC_CODES = new Set([
    'store_open_failed',
    'store_close_failed',
    'store_path_invalid',
    'store_config_invalid',
    'tx_begin_failed',
    'tx_format_invalid',
    'stmt_store_mismatch',
    'stmt_sql_kind_mismatch',
    'stmt_already_consumed',
    'stmt_already_bound',
    'param_store_id_invalid',
    'param_tx_id_invalid',
    'param_statement_id_invalid',
    'param_op_id_invalid',
    'payload_type_unsupported',
    'vector_format_invalid',
    'sql_result_read_failed',
    'adapter_serialization_failed',
    'adapter_state_corrupted'
]);

function categoryOf(code?: string): 'required' | 'diagnostic' | 'bridge' {
    if (!code) return 'diagnostic';
    if (
        code === 'envelope_parse_failed' ||
        code === 'operation_timeout' ||
        code === 'transaction_rollback_after_fn_failed' ||
        code === 'transaction_rollback_after_commit_failed'
    ) {
        return 'bridge';
    }
    if (REQUIRED_CODES.has(code)) return 'required';
    if (DIAGNOSTIC_CODES.has(code)) return 'diagnostic';
    return 'diagnostic';
}

async function callArkRaw(name: string, args: string[]): Promise<any> {
    const raw = await callArkTS<string>(name, 'string', args);
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new ArkDataBridgeError(
            'envelope_parse_failed',
            'bridge',
            `${name} envelope parse failed`,
            { raw },
            error
        );
    }
}

async function callArkEnvelope<T = any>(name: string, args: string[]): Promise<T> {
    const env = await callArkRaw(name, args);
    if (!env.ok) {
        const code = env.error?.code ?? 'unknown_error';
        throw new ArkDataBridgeError(code, categoryOf(code), env.error?.message ?? code, env.error?.details);
    }
    return env as T;
}

async function pollReady<T = any>(readyName: string, opId: string, onTick?: (env: any) => void): Promise<T> {
    let delay = POLL_INITIAL_MS;
    const startedAt = Date.now();
    for (;;) {
        const env = await callArkRaw(readyName, [opId]);
        onTick?.(env);
        if (env.state === 'pending') {
            if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
                throw new ArkDataBridgeError(
                    'operation_timeout',
                    'bridge',
                    `${readyName} timed out after ${POLL_TIMEOUT_MS}ms`,
                    { readyName, opId, timeoutMs: POLL_TIMEOUT_MS }
                );
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, POLL_MAX_MS);
            continue;
        }
        if (env.state === 'success') {
            return env as T;
        }
        const code = env.error?.code ?? 'unknown_error';
        throw new ArkDataBridgeError(code, categoryOf(code), env.error?.message ?? code, env.error?.details);
    }
}

function stringifyParams(params: ArkDataValueType[]): string {
    return JSON.stringify(params);
}

function optionsJson(opts?: ArkDataOpenStoreOptions): string {
    return opts ? JSON.stringify({ vector: opts.vector === true }) : '';
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value ?? null);
    } catch {
        return '"<unserializable>"';
    }
}

function logSqlFailure(
    operation: string,
    storeId: string,
    sql: string,
    error: unknown,
    extra?: Record<string, unknown>
) {
    const err = error as { code?: string; category?: string; message?: string; details?: unknown } | null | undefined;
    logger.warn(
        `[arkdata] ${operation} failed storeId=${storeId} code=${err?.code ?? 'unknown'} ` +
            `category=${err?.category ?? 'unknown'} message=${err?.message ?? String(error)} ` +
            `details=${safeJson(err?.details ?? null)} extra=${safeJson(extra ?? null)} sql=${sql}`
    );
}

async function waitPendingStoreClose(storeId: string): Promise<void> {
    const pending = pendingStoreCloses.get(storeId);
    if (pending) {
        await pending.catch(() => undefined);
    }
}

function trackPendingStoreClose(storeId: string, closePromise: Promise<void>): void {
    const tracked = closePromise
        .catch(() => undefined)
        .finally(() => {
            if (pendingStoreCloses.get(storeId) === tracked) {
                pendingStoreCloses.delete(storeId);
            }
        });
    pendingStoreCloses.set(storeId, tracked);
}

export function arkDataStoreName(storeId: string, path?: string): string {
    if (!path) return '';
    // ArkTS relationalStore StoreConfig.name is a database name, not an absolute filesystem path.
    const hash = createHash('sha1').update(`${storeId}\0${path}`).digest('hex').slice(0, 24);
    const safeStoreId = storeId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48);
    return `${safeStoreId}-${hash}.db`;
}

export class HarmonyOSDatabaseKit implements DatabaseKit {
    async available(): Promise<boolean> {
        if (!hasArkTSAdapter()) return false;
        try {
            await callArkEnvelope(EtsBridgeMethods.ARKDATA_PING, ['probe']);
            return true;
        } catch {
            return false;
        }
    }

    async execSql(storeId: string, sql: string): Promise<void> {
        try {
            await callArkEnvelope(EtsBridgeMethods.ARKDATA_EXEC_SQL, [storeId, sql]);
        } catch (error) {
            logSqlFailure('execSql', storeId, sql, error);
            throw error;
        }
    }

    async execSqlParams(storeId: string, sql: string, params: ArkDataValueType[]): Promise<void> {
        try {
            await callArkEnvelope(EtsBridgeMethods.ARKDATA_EXEC_SQL_PARAMS, [storeId, sql, stringifyParams(params)]);
        } catch (error) {
            logSqlFailure('execSqlParams', storeId, sql, error, { paramsCount: params.length });
            throw error;
        }
    }

    async querySqlShort(storeId: string, sql: string): Promise<ArkDataRow[]> {
        try {
            const env = await callArkEnvelope<{ rows?: ArkDataRow[] }>(EtsBridgeMethods.ARKDATA_QUERY_SQL_SHORT, [
                storeId,
                sql
            ]);
            return env.rows ?? [];
        } catch (error) {
            logSqlFailure('querySqlShort', storeId, sql, error);
            throw error;
        }
    }

    async openStore(storeId: string, opts?: ArkDataOpenStoreOptions): Promise<void> {
        await waitPendingStoreClose(storeId);
        const start = await callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_OPEN_STORE_START, [
            storeId,
            arkDataStoreName(storeId, opts?.path),
            optionsJson(opts)
        ]);
        await pollReady(EtsBridgeMethods.ARKDATA_OPEN_STORE_READY, start.opId);
    }

    async closeStore(storeId: string, opts?: ArkDataCloseStoreOptions): Promise<void> {
        const closePromise = this.closeStoreInternal(storeId, opts);
        trackPendingStoreClose(storeId, closePromise);
        await closePromise;
    }

    private async closeStoreInternal(storeId: string, opts?: ArkDataCloseStoreOptions): Promise<void> {
        if (opts?.force) {
            const start = await callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_CLOSE_STORE_FORCE_START, [
                storeId
            ]);
            await pollReady(EtsBridgeMethods.ARKDATA_CLOSE_STORE_FORCE_READY, start.opId);
            return;
        }
        const start = await callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_CLOSE_STORE_START, [storeId]);
        await pollReady(EtsBridgeMethods.ARKDATA_CLOSE_STORE_READY, start.opId);
    }

    async executePrepared(
        storeId: string,
        sql: string,
        params: ArkDataValueType[],
        opts: ArkDataExecOptions = {}
    ): Promise<ArkDataExecResult> {
        let statementId: string | undefined;
        try {
            statementId = await this.beginPrepared(storeId, sql);
            await callArkEnvelope(EtsBridgeMethods.ARKDATA_BIND_PARAMS, [statementId, stringifyParams(params)]);
            const start = await callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_EXECUTE_PREPARED_START, [
                storeId,
                statementId,
                opts.txId ?? ''
            ]);
            const ready = await pollReady<{ affectedRows?: number | null }>(
                EtsBridgeMethods.ARKDATA_EXECUTE_PREPARED_READY,
                start.opId
            );
            return { affectedRows: ready.affectedRows ?? null };
        } catch (error) {
            logSqlFailure('executePrepared', storeId, sql, error, { paramsCount: params.length, txId: opts.txId });
            throw error;
        } finally {
            if (statementId) await this.closePrepared(statementId);
        }
    }

    async executePreparedMany(
        storeId: string,
        sql: string,
        rows: ArkDataValueType[][],
        opts: ArkDataExecManyOptions = {}
    ): Promise<ArkDataExecResult> {
        let statementId: string | undefined;
        try {
            statementId = await this.beginPrepared(storeId, sql);
            await callArkEnvelope(EtsBridgeMethods.ARKDATA_BIND_PARAMS_MANY, [statementId, JSON.stringify(rows)]);
            const start = await callArkEnvelope<{ opId: string }>(
                EtsBridgeMethods.ARKDATA_EXECUTE_PREPARED_MANY_START,
                [storeId, statementId, opts.txId ?? '']
            );
            const ready = await pollReady<{ affectedRows?: number | null; done?: number; total?: number }>(
                EtsBridgeMethods.ARKDATA_EXECUTE_PREPARED_MANY_READY,
                start.opId,
                (env) => {
                    if (typeof env.done === 'number' && typeof env.total === 'number') {
                        opts.onProgress?.(env.done, env.total);
                    }
                }
            );
            return { affectedRows: ready.affectedRows ?? ready.done ?? null };
        } catch (error) {
            logSqlFailure('executePreparedMany', storeId, sql, error, { rowCount: rows.length, txId: opts.txId });
            throw error;
        } finally {
            if (statementId) await this.closePrepared(statementId);
        }
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

    async queryPrepared(
        storeId: string,
        sql: string,
        params: ArkDataValueType[],
        opts: ArkDataExecOptions = {}
    ): Promise<ArkDataRow[]> {
        let statementId: string | undefined;
        try {
            statementId = await this.beginPrepared(storeId, sql);
            await callArkEnvelope(EtsBridgeMethods.ARKDATA_BIND_PARAMS, [statementId, stringifyParams(params)]);
            const start = await callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_EXECUTE_PREPARED_START, [
                storeId,
                statementId,
                opts.txId ?? ''
            ]);
            const ready = await pollReady<{ rows?: ArkDataRow[] }>(
                EtsBridgeMethods.ARKDATA_EXECUTE_PREPARED_READY,
                start.opId
            );
            return ready.rows ?? [];
        } catch (error) {
            logSqlFailure('queryPrepared', storeId, sql, error, { paramsCount: params.length, txId: opts.txId });
            throw error;
        } finally {
            if (statementId) await this.closePrepared(statementId);
        }
    }

    async beginTransaction(storeId: string): Promise<ArkDataTxHandle> {
        const start = await callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_BEGIN_TRANS_START, [storeId]);
        const ready = await pollReady<{ txId: string }>(EtsBridgeMethods.ARKDATA_BEGIN_TRANS_READY, start.opId);
        return { id: ready.txId };
    }

    async commitTransaction(storeId: string, tx: ArkDataTxHandle): Promise<void> {
        const start = await callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_COMMIT_TRANS_START, [
            storeId,
            tx.id
        ]);
        await pollReady(EtsBridgeMethods.ARKDATA_COMMIT_TRANS_READY, start.opId);
    }

    async rollbackTransaction(storeId: string, tx: ArkDataTxHandle): Promise<void> {
        const start = await callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_ROLLBACK_TRANS_START, [
            storeId,
            tx.id
        ]);
        await pollReady(EtsBridgeMethods.ARKDATA_ROLLBACK_TRANS_READY, start.opId);
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
                throw new ArkDataBridgeError(
                    'transaction_rollback_after_fn_failed',
                    'bridge',
                    'Rollback failed after fn rejected',
                    { adapterError: rollbackErr },
                    fnErr
                );
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

    private async beginPrepared(storeId: string, sql: string): Promise<string> {
        const begin = await callArkEnvelope<{ statementId: string }>(EtsBridgeMethods.ARKDATA_BEGIN_PREPARED, [
            storeId,
            sql
        ]);
        return begin.statementId;
    }

    private async closePrepared(statementId: string): Promise<void> {
        try {
            await callArkEnvelope(EtsBridgeMethods.ARKDATA_CLOSE_PREPARED, [statementId]);
        } catch (error) {
            logger.warn('ClosePrepared failed (ignored)', error);
        }
    }
}
