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

/** Protocol values for infrastructure callers, not user-facing UI text. */
export interface FileChangeEvent {
    path: string;
    type: 'changed' | 'missing';
}

export interface FileWatchOptions {
    /** Receives runtime filesystem errors and callback failures. Defaults to an internal diagnostic. */
    onError?: (error: Error) => void;
}

export interface FileWatchSubscription {
    readonly path: string;
    /** Idempotent. Prevents new callbacks; an already running callback may finish. */
    dispose(): void;
}
