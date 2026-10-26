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

import { watch, type FSWatcher } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { FileChangeEvent, FileWatchOptions, FileWatchSubscription } from './types.js';

async function fingerprint(filename: string): Promise<string | null> {
    try {
        const state = await lstat(filename);
        if (!state.isFile()) throw new TypeError('File watch target must be a regular file');
        return [state.dev, state.ino, state.size, state.mtimeMs, state.ctimeMs, state.mode].join(':');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw error;
    }
}

/**
 * Watches fixed file paths using parent-directory notifications and metadata only.
 * No content reads, move tracking, recursive scans, polling, or Electron dependency.
 */
export class FileWatchService {
    private readonly registrations = new Set<() => void>();
    private disposed = false;

    async watch(
        filePath: string,
        onChange: (event: FileChangeEvent) => void | Promise<void>,
        options: FileWatchOptions = {}
    ): Promise<FileWatchSubscription> {
        // Errors in this service are infrastructure diagnostics; UI callers localize their own messages.
        if (this.disposed) throw new Error('File watch service is disposed');
        if (!filePath.trim()) throw new TypeError('File watch path must not be empty');
        const filename = path.resolve(filePath);
        let watcher: FSWatcher | undefined;
        let scheduled: ReturnType<typeof setImmediate> | undefined;
        let active = true;
        let ready = false;
        let checking = false;
        let pending = false;
        let previous: string | null = null;
        let startupError: Error | undefined;
        const dispose = () => {
            if (!active) return;
            active = false;
            if (scheduled !== undefined) clearImmediate(scheduled);
            watcher?.close();
            this.registrations.delete(dispose);
        };
        const reportError = (cause: unknown) => {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            try {
                if (options.onError) options.onError(error);
                else console.error('File watch failed:', filename, error);
            } catch (handlerError) {
                console.error('File watch error callback failed:', filename, handlerError);
            }
        };
        const fail = (cause: unknown) => {
            if (!active) return;
            const error = cause instanceof Error ? cause : new Error(String(cause));
            if (!ready) startupError = error;
            dispose();
            if (ready) reportError(error);
        };
        const check = async () => {
            checking = true;
            try {
                while (active && pending) {
                    pending = false;
                    const current = await fingerprint(filename);
                    if (!active) return;
                    if (current === previous) continue;
                    previous = current;
                    try {
                        const result = onChange({ path: filename, type: current === null ? 'missing' : 'changed' });
                        // Callbacks are independent; do not hold the filesystem check open for business work.
                        void Promise.resolve(result).catch((error) => {
                            if (active) reportError(error);
                        });
                    } catch (error) {
                        reportError(error);
                    }
                }
            } catch (error) {
                fail(error);
            } finally {
                checking = false;
            }
        };
        const schedule = () => {
            pending = true;
            if (!active || !ready || checking || scheduled !== undefined) return;
            // Coalesce only this event burst. Continuous writes cannot postpone checks indefinitely.
            scheduled = setImmediate(() => {
                scheduled = undefined;
                void check();
            });
        };
        this.registrations.add(dispose);
        try {
            // Watch the directory, not the inode: editors commonly replace files during a save.
            // Check metadata on every directory signal, so missing/case-variant filenames are safe.
            watcher = watch(path.dirname(filename), schedule);
            watcher.on('error', fail);
            previous = await fingerprint(filename);
            if (startupError) throw startupError;
            if (!active) throw new Error('File watch service is disposed');
            if (previous === null) throw new Error('File watch target does not exist');
            ready = true;
            if (pending) schedule();
            return { path: filename, dispose };
        } catch (error) {
            dispose();
            throw error;
        }
    }

    /** Releases all registrations and rejects future registrations. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const dispose of this.registrations) dispose();
    }
}
