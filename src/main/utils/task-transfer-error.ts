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

export type TaskTransferStage =
    | 'readImportFile'
    | 'prepareTasks'
    | 'flushPending'
    | 'taskDirectory'
    | 'serializeTask'
    | 'writeTask'
    | 'writeIndex';

// These codes are protocol values; the GUI translates them at the presentation boundary.
export type TaskTransferErrorCode =
    | 'invalidBundle'
    | 'invalidTask'
    | 'unsupportedVersion'
    | 'corruptArchive'
    | 'taskExceedsRuntimeCapacity'
    | 'writeFailed'
    | 'expired'
    | 'invalidWorkspace';
export class TaskTransferError extends Error {
    constructor(
        readonly code: TaskTransferErrorCode,
        cause?: unknown,
        readonly stage?: TaskTransferStage,
        readonly filePath?: string,
        readonly retryable: boolean = false
    ) {
        super(code, { cause });
    }
}
