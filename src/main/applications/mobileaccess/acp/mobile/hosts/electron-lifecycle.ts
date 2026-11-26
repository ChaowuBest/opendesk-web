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

/** Keep an approved Electron quit pending while the background service drains.
 * The retried before-quit event passes through to the normal plugin and window cleanup.
 */
export function createMobileQuitBarrier(close: () => Promise<void>, retryQuit: () => void): () => boolean {
    let closing = false;
    let released = false;
    function release(): void {
        released = true;
        retryQuit();
    }
    return () => {
        if (released) return false;
        if (!closing) {
            closing = true;
            void close().then(release, release);
        }
        return true;
    };
}
