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
    ArkDataBM25Request,
    ArkDataBM25Result,
    ArkDataTransactionOptions,
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

const POLL_INITIAL_MS = 5;
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
    'store_delete_failed',
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

type OpenStoreStartEnvelope = {
    ok: true;
    opId?: string;
    reused?: boolean;
    storeId?: string;
};

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

function resolveOpenStoreReadyOpId(start: OpenStoreStartEnvelope, storeId: string): string | null {
    if (start.reused === true) {
        return null;
    }
    if (typeof start.opId === 'string' && start.opId.length > 0) {
        return start.opId;
    }
    throw new ArkDataBridgeError(
        'payload_shape_invalid',
        'bridge',
        'ArkData.OpenStoreStart returned neither reused=true nor a valid opId',
        { storeId, start }
    );
}

async function pollReady<T = any>(
    readyName: string,
    opId: string,
    onTick?: (env: any) => void,
    lifecycle?: StoreOperation
): Promise<T> {
    let delay = POLL_INITIAL_MS;
    const startedAt = Date.now();
    for (;;) {
        let env: any;
        try {
            env = await callArkRaw(readyName, [opId]);
            if (
                lifecycle &&
                (env.error?.code === 'op_not_found' || !['pending', 'success', 'error', 'failed'].includes(env.state))
            ) {
                throw new Error('ArkData operation outcome is unavailable');
            }
        } catch (error) {
            if (!lifecycle) throw error;
            const unresolved = new ArkDataBridgeError(
                'operation_unresolved',
                'bridge',
                `${readyName} result is unavailable`,
                { readyName, opId },
                error
            );
            for (const waiter of lifecycle.waiters) waiter.reject(unresolved);
            // Accepted Start requests are idempotent at ArkTS, including after
            // Ready TTL eviction. Replay recovers the original terminal snapshot.
            const replay = await lifecycle.recover?.();
            env = replay?.settled ? replay : replay?.reused ? { state: 'success' } : { state: 'pending' };
        }
        onTick?.(env);
        if (env.state === 'pending') {
            if (!lifecycle && Date.now() - startedAt > POLL_TIMEOUT_MS) {
                throw new ArkDataBridgeError(
                    'operation_timeout',
                    'bridge',
                    `${readyName} timed out after ${POLL_TIMEOUT_MS}ms`,
                    { readyName, opId, timeoutMs: POLL_TIMEOUT_MS }
                );
            }
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, delay);
                if (lifecycle) {
                    lifecycle.timer = timer;
                    if (lifecycle.waiters.size === 0) timer.unref();
                }
            });
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

// Timeouts end a caller's wait, not the accepted SDK operation. Keep polling
// immediately, including after all callers leave, before ArkTS terminal-op GC.
// Terminal session outcomes remain cached so a late retry cannot affect a new store.
type StoreWaiter = { startedAt: number; reject: (error: unknown) => void };
type StoreOperation = {
    promise: Promise<void>;
    waiters: Set<StoreWaiter>;
    ticks: Set<() => void>;
    done: boolean;
    error?: unknown;
    timer?: NodeJS.Timeout;
    recover?: () => Promise<any>;
};
type StoreSession = {
    storeId: string;
    identity: string;
    opening: StoreOperation;
    closing?: StoreOperation;
    acquired: boolean;
    released: boolean;
    closeAttempt: number;
};

function operationTimeout(): ArkDataBridgeError {
    return new ArkDataBridgeError(
        'operation_timeout',
        'bridge',
        `ArkData store operation timed out after ${POLL_TIMEOUT_MS}ms`,
        { timeoutMs: POLL_TIMEOUT_MS }
    );
}

function startStoreOperation(run: (operation: StoreOperation) => Promise<void>): StoreOperation {
    const operation: StoreOperation = { promise: Promise.resolve(), waiters: new Set(), ticks: new Set(), done: false };
    // Defer start until the record and its first waiter exist, including reused opens.
    operation.promise = Promise.resolve()
        .then(() => run(operation))
        .then(
            () => {
                operation.done = true;
            },
            (error) => {
                operation.done = true;
                operation.error = error;
                throw error;
            }
        );
    // Detached operations still settle and remain observable on retry.
    void operation.promise.catch(() => {});
    return operation;
}

function checkStoreWaiters(operation: StoreOperation): void {
    for (const tick of operation.ticks) tick();
    for (const waiter of operation.waiters) {
        if (Date.now() - waiter.startedAt > POLL_TIMEOUT_MS) waiter.reject(operationTimeout());
    }
}

function waitStoreOperation(operation: StoreOperation): Promise<void> {
    if (operation.done) return operation.error ? Promise.reject(operation.error) : Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const waiter: StoreWaiter = { startedAt: Date.now(), reject };
        const timer = setTimeout(() => waiter.reject(operationTimeout()), POLL_TIMEOUT_MS);
        operation.waiters.add(waiter);
        operation.timer?.ref();
        const finish = () => {
            clearTimeout(timer);
            operation.waiters.delete(waiter);
            if (operation.waiters.size === 0) operation.timer?.unref();
        };
        operation.promise.then(resolve, reject);
        // Rejection from either clock path removes only this observer.
        waiter.reject = (error) => {
            finish();
            reject(error);
        };
        operation.promise.then(finish, finish);
    });
}

async function runStoreRequest(
    operation: StoreOperation,
    startName: string,
    readyName: string,
    args: string[],
    storeId: string
): Promise<void> {
    const recover = async (): Promise<any> => {
        let delay = POLL_INITIAL_MS;
        for (;;) {
            let start: any;
            try {
                start = await callArkRaw(startName, args);
                if (
                    !start ||
                    typeof start.ok !== 'boolean' ||
                    (start.reused !== undefined && typeof start.reused !== 'boolean') ||
                    (start.settled !== undefined && typeof start.settled !== 'boolean') ||
                    (start.ok && start.settled === true && !['success', 'error', 'failed'].includes(start.state)) ||
                    (start.ok &&
                        start.settled !== true &&
                        start.reused !== true &&
                        (typeof start.opId !== 'string' || start.opId.length === 0))
                ) {
                    throw new ArkDataBridgeError('operation_unresolved', 'bridge', 'Invalid store Start response');
                }
            } catch (error) {
                const unresolved =
                    error instanceof ArkDataBridgeError
                        ? error
                        : new ArkDataBridgeError(
                              'operation_unresolved',
                              'bridge',
                              'Store Start result is unavailable',
                              { storeId },
                              error
                          );
                for (const waiter of operation.waiters) waiter.reject(unresolved);
                checkStoreWaiters(operation);
                await new Promise<void>((resolve) => {
                    operation.timer = setTimeout(resolve, delay);
                    if (operation.waiters.size === 0) operation.timer.unref();
                });
                delay = Math.min(delay * 2, POLL_MAX_MS);
                continue;
            }
            if (!start.ok) {
                const code = start.error?.code ?? 'unknown_error';
                throw new ArkDataBridgeError(
                    code,
                    categoryOf(code),
                    start.error?.message ?? code,
                    start.error?.details
                );
            }
            return start;
        }
    };
    operation.recover = recover;
    const start = await recover();
    if (start.settled === true) {
        if (start.state !== 'success') {
            const code = start.error?.code ?? 'unknown_error';
            throw new ArkDataBridgeError(code, categoryOf(code), start.error?.message ?? code, start.error?.details);
        }
        return;
    }
    if (start.reused === true) return;
    await pollReady(readyName, start.opId, () => checkStoreWaiters(operation), operation);
}

function stringifyParams(params: ArkDataValueType[]): string {
    return JSON.stringify(params);
}

function optionsJson(opts?: ArkDataOpenStoreOptions): string {
    return opts ? JSON.stringify({ vector: opts.vector === true, sessionId: opts.sessionId }) : '';
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
    // SDK messages and SQL diagnostics may contain indexed file contents.
    if (typeof extra?.txId === 'string' && extra.txId.startsWith('otx_')) {
        logger.warn(`[arkdata] ${operation} failed storeId=${storeId} code=${err?.code ?? 'unknown'}`);
        return;
    }
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
    private readonly storeSessions = new Map<string, StoreSession>();
    async available(): Promise<boolean> {
        if (!hasArkTSAdapter()) return false;
        try {
            const capabilities = await callArkEnvelope(EtsBridgeMethods.ARKDATA_PING, ['probe']);
            // Older adapters remain usable by legacy callers, but cannot safely
            // serve the session contract. Factory selection then keeps using WASM.
            return capabilities.storeSessionProtocol === 1;
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

    async deleteStore(storeId: string, opts?: ArkDataOpenStoreOptions): Promise<void> {
        const start = await callArkEnvelope<{ opId?: string }>(EtsBridgeMethods.ARKDATA_DELETE_STORE_START, [
            storeId,
            arkDataStoreName(storeId, opts?.path),
            optionsJson(opts)
        ]);
        if (typeof start.opId !== 'string' || start.opId.length === 0) {
            throw new ArkDataBridgeError(
                'payload_shape_invalid',
                'bridge',
                'ArkData.DeleteStoreStart returned no valid opId',
                { storeId }
            );
        }
        await pollReady(EtsBridgeMethods.ARKDATA_DELETE_STORE_READY, start.opId);
    }

    async openStore(storeId: string, opts?: ArkDataOpenStoreOptions): Promise<void> {
        if (!opts?.sessionId) {
            await waitPendingStoreClose(storeId);
            const start = await callArkEnvelope<OpenStoreStartEnvelope>(EtsBridgeMethods.ARKDATA_OPEN_STORE_START, [
                storeId,
                arkDataStoreName(storeId, opts?.path),
                optionsJson(opts)
            ]);
            const opId = resolveOpenStoreReadyOpId(start, storeId);
            if (opId !== null) await pollReady(EtsBridgeMethods.ARKDATA_OPEN_STORE_READY, opId);
            return;
        }
        const identity = JSON.stringify([storeId, opts.path ?? '', opts.vector === true]);
        let session = this.storeSessions.get(opts.sessionId);
        if (session?.closing && !session.closing.done) {
            throw new ArkDataBridgeError('store_closing', 'required', 'Store session release is still pending');
        }
        if (session && (session.identity !== identity || session.released)) {
            throw new ArkDataBridgeError('store_id_conflict', 'required', 'Store session identity is no longer open');
        }
        if (!session) {
            const record = { storeId, identity, acquired: false, released: false, closeAttempt: 0 } as StoreSession;
            // Capture predecessors before publishing this session's own close;
            // otherwise an early release could make open wait for itself.
            const predecessor = pendingStoreCloses.get(storeId);
            record.opening = startStoreOperation(async (operation) => {
                await predecessor?.catch(() => {});
                await runStoreRequest(
                    operation,
                    EtsBridgeMethods.ARKDATA_OPEN_STORE_START,
                    EtsBridgeMethods.ARKDATA_OPEN_STORE_READY,
                    [storeId, arkDataStoreName(storeId, opts.path), optionsJson(opts)],
                    storeId
                );
                record.acquired = true;
            });
            this.storeSessions.set(opts.sessionId, record);
            session = record;
        }
        await waitStoreOperation(session.opening);
    }

    async closeStore(storeId: string, opts?: ArkDataCloseStoreOptions): Promise<void> {
        if (opts?.sessionId && !opts.force) {
            const session = this.storeSessions.get(opts.sessionId);
            if (!session) {
                // RPC responses are unordered: cancellation may arrive before the
                // original open request. Retire its identity without acquiring.
                this.storeSessions.set(opts.sessionId, {
                    storeId,
                    identity: '',
                    acquired: false,
                    released: true,
                    closeAttempt: 0,
                    opening: { promise: Promise.resolve(), waiters: new Set(), ticks: new Set(), done: true }
                });
                return;
            }
            if (session.storeId !== storeId) {
                throw new ArkDataBridgeError('store_id_conflict', 'required', 'Store session belongs to another store');
            }
            if (session.released) return;
            // A definitive SDK failure is retryable. A pending close must keep its
            // original opId even when its caller or worker RPC has timed out.
            if (!session.closing || (session.closing.done && session.closing.error)) {
                const requestJson = JSON.stringify({
                    sessionId: opts.sessionId,
                    requestId: `${opts.sessionId}:${++session.closeAttempt}`
                });
                const closing = startStoreOperation(async (operation) => {
                    await session.opening.promise.catch(() => {});
                    if (session.acquired) {
                        await runStoreRequest(
                            operation,
                            EtsBridgeMethods.ARKDATA_CLOSE_STORE_START,
                            EtsBridgeMethods.ARKDATA_CLOSE_STORE_READY,
                            [storeId, requestJson],
                            storeId
                        );
                    }
                    session.acquired = false;
                    session.released = true;
                });
                session.closing = closing;
                // Waiters of a close deferred behind an open need the same clock
                // boundary as the open's observers; the SDK operation continues.
                const observer = () => checkStoreWaiters(closing);
                session.opening.ticks.add(observer);
                closing.promise.then(
                    () => session.opening.ticks.delete(observer),
                    () => session.opening.ticks.delete(observer)
                );
                trackPendingStoreClose(storeId, closing.promise);
            }
            await waitStoreOperation(session.closing);
            return;
        }
        const closePromise = this.closeStoreInternal(storeId, opts);
        trackPendingStoreClose(storeId, closePromise);
        await closePromise;
    }

    private async closeStoreInternal(storeId: string, opts?: ArkDataCloseStoreOptions): Promise<void> {
        if (opts?.force) {
            const start = await callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_CLOSE_STORE_FORCE_START, [
                storeId
            ]);
            // Only a valid accepted Start confirms revocation; malformed replies retain normal release ownership.
            if (typeof start.opId === 'string' && start.opId.startsWith('op_')) {
                for (const session of this.storeSessions.values()) {
                    if (session.storeId === storeId) {
                        session.released = true;
                        session.acquired = false;
                    }
                }
            }
            await pollReady(EtsBridgeMethods.ARKDATA_CLOSE_STORE_FORCE_READY, start.opId);
            return;
        }
        const start = await callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_CLOSE_STORE_START, [
            storeId,
            ''
        ]);
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
            const start = await this.startPrepared(storeId, statementId, opts.txId, 'execute');
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
            const start = await this.startPrepared(storeId, statementId, opts.txId, 'query');
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

    async bm25Query(storeId: string, request: ArkDataBM25Request, txId: string): Promise<ArkDataBM25Result> {
        const start = await callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_BM25_QUERY_START, [
            storeId,
            JSON.stringify(request),
            txId
        ]);
        const ready = await pollReady<{ bm25: ArkDataBM25Result }>(
            EtsBridgeMethods.ARKDATA_BM25_QUERY_READY,
            start.opId
        );
        return ready.bm25;
    }

    async beginTransaction(storeId: string, opts?: ArkDataTransactionOptions): Promise<ArkDataTxHandle> {
        const start = opts
            ? await callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_BEGIN_OBJECT_TRANS_START, [
                  storeId,
                  opts.mode
              ])
            : await callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_BEGIN_TRANS_START, [storeId]);
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

    private startPrepared(storeId: string, statementId: string, txId: string | undefined, intent: 'execute' | 'query') {
        // AKI caches the callback signature per binding. Keep the legacy binding at three arguments.
        if (txId?.startsWith('otx_')) {
            return callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_EXECUTE_OBJECT_PREPARED_START, [
                storeId,
                statementId,
                txId,
                intent
            ]);
        }
        return callArkEnvelope<{ opId: string }>(EtsBridgeMethods.ARKDATA_EXECUTE_PREPARED_START, [
            storeId,
            statementId,
            txId ?? ''
        ]);
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
