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

import { isRecoverableMainProcessError } from './recoverable-errors.js';

type WorkerErrorLogger = {
    warn(message: string): void;
    error(message: string): void;
};

export function handleWorkerUncaughtException(
    error: Error,
    origin: NodeJS.UncaughtExceptionOrigin,
    errorLogger: WorkerErrorLogger
): void {
    // 与主进程共用同一套可恢复判定，避免 worker / 主进程的崩溃行为各自漂移
    const recoverableReason = isRecoverableMainProcessError(error);
    if (recoverableReason !== null) {
        errorLogger.warn(`[RECOVERABLE] ${recoverableReason} in worker thread (${origin}), ignoring`);
        return;
    }
    errorLogger.error(`[FATAL] uncaughtException (${origin}) in worker: ${error.stack || error.message}`);
    throw error;
}

export function handleWorkerUnhandledRejection(reason: unknown, errorLogger: WorkerErrorLogger): void {
    const recoverableReason = isRecoverableMainProcessError(reason);
    if (recoverableReason !== null) {
        errorLogger.warn(`[RECOVERABLE] ${recoverableReason} rejection in worker thread, ignoring`);
        return;
    }
    const details = reason instanceof Error ? reason.stack || reason.message : String(reason);
    errorLogger.error(`unhandledRejection in worker: ${details}`);
    throw reason instanceof Error ? reason : new Error(details);
}
