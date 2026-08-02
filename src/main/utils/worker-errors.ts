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

type WorkerErrorLogger = {
    warn(message: string): void;
    error(message: string): void;
};

export function handleWorkerUncaughtException(
    error: Error,
    origin: NodeJS.UncaughtExceptionOrigin,
    errorLogger: WorkerErrorLogger
): void {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
        errorLogger.warn('EPIPE error in worker thread (IPC channel), ignoring');
        return;
    }
    errorLogger.error(`[FATAL] uncaughtException (${origin}) in worker: ${error.stack || error.message}`);
    throw error;
}

export function handleWorkerUnhandledRejection(reason: unknown, errorLogger: WorkerErrorLogger): void {
    if (reason instanceof Error && (reason as NodeJS.ErrnoException).code === 'EPIPE') {
        errorLogger.warn('EPIPE rejection in worker thread (IPC channel), ignoring');
        return;
    }
    const details = reason instanceof Error ? reason.stack || reason.message : String(reason);
    errorLogger.error(`unhandledRejection in worker: ${details}`);
    throw reason instanceof Error ? reason : new Error(details);
}
