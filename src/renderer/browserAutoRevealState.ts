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

type BrowserAutoRevealStorage = Pick<Storage, 'getItem' | 'setItem'>;

const STORAGE_KEY_PREFIX = 'opendesk-browser-auto-reveal-consumed:';

/** Keeps the one-time Browser Use layout reveal scoped to a task. */
export class BrowserAutoRevealState {
    private readonly _consumedTaskIds = new Set<string>();

    consume(taskId: string, storage: BrowserAutoRevealStorage | null = this._getDefaultStorage()): boolean {
        if (!taskId || this._consumedTaskIds.has(taskId)) return false;

        const storageKey = `${STORAGE_KEY_PREFIX}${taskId}`;
        try {
            if (storage?.getItem(storageKey) === '1') {
                this._consumedTaskIds.add(taskId);
                return false;
            }
        } catch {
            // Keep the process-local guard when persistent storage is unavailable.
        }

        this._consumedTaskIds.add(taskId);
        try {
            storage?.setItem(storageKey, '1');
        } catch {
            // The one-time rule still holds for the current renderer process.
        }
        return true;
    }

    private _getDefaultStorage(): BrowserAutoRevealStorage | null {
        try {
            return window.localStorage;
        } catch {
            return null;
        }
    }
}

export const browserAutoRevealState = new BrowserAutoRevealState();
