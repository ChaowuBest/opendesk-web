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

/**
 * Watches fixed file paths using parent-directory notifications and metadata only.
 * No content reads, move tracking, recursive scans, polling, or Electron dependency.
 */
export class FileWatchService {
    private readonly registrations = new Set<FileWatchRegistration>();
    private disposed = false;

    async watch(
        filePath: string,
        onChange: (event: FileChangeEvent) => void | Promise<void>,
        options: FileWatchOptions = {}
    ): Promise<FileWatchSubscription> {
        // Errors in this service are infrastructure diagnostics; UI callers localize their own messages.
        if (this.disposed) throw new Error('File watch service is disposed');
        if (!filePath.trim()) throw new TypeError('File watch path must not be empty');
        const registration = new FileWatchRegistration(path.resolve(filePath), onChange, options, () => {
            this.registrations.delete(registration);
        });
        this.registrations.add(registration);
        try {
            await registration.start();
            return registration;
        } catch (error) {
            registration.dispose();
            throw error;
        }
    }

    /** Releases all registrations and rejects future registrations. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const registration of this.registrations) registration.dispose();
    }
}

class FileWatchRegistration implements FileWatchSubscription {
    private watcher?: FSWatcher;
    private scheduled?: ReturnType<typeof setImmediate>;
    private active = true;
    private ready = false;
    private checking = false;
    private pending = false;
    private previous: string | null = null;
    private startupError?: Error;

    constructor(
        readonly path: string,
        private readonly onChange: (event: FileChangeEvent) => void | Promise<void>,
        private readonly options: FileWatchOptions,
        private readonly onDispose: () => void
    ) {}

    async start(): Promise<void> {
        // Watch the directory, not the inode: editors commonly replace files during a save.
        const normalizeFilename = (name: string) => name.normalize('NFC').toLowerCase().toUpperCase();
        const filename = normalizeFilename(path.basename(this.path));
        this.watcher = watch(path.dirname(this.path), (_eventType, changedFilename) => {
            // Compare conservatively on every platform: case/Unicode aliases may refer to the same file.
            // Missing filenames still require a check; filesystem metadata determines the actual change.
            const changed = changedFilename?.toString();
            if (!changed || normalizeFilename(changed) === filename) this.scheduleCheck();
        });
        this.watcher.on('error', (error) => this.handleWatchFailure(error));
        this.previous = await readFileFingerprint(this.path);
        if (this.startupError) throw this.startupError;
        if (!this.active) throw new Error('File watch service is disposed');
        if (this.previous === null) throw new Error('File watch target does not exist');
        this.ready = true;
        if (this.pending) this.scheduleCheck();
    }

    private scheduleCheck(): void {
        this.pending = true;
        if (!this.active || !this.ready || this.checking || this.scheduled !== undefined) return;
        // Coalesce only this event burst. Continuous writes cannot postpone checks indefinitely.
        this.scheduled = setImmediate(() => {
            this.scheduled = undefined;
            void this.checkForChanges();
        });
    }

    private async checkForChanges(): Promise<void> {
        this.checking = true;
        try {
            while (this.active && this.pending) {
                this.pending = false;
                const current = await readFileFingerprint(this.path);
                if (!this.active) return;
                if (current === this.previous) continue;
                this.previous = current;
                this.notifyChange(current === null ? 'missing' : 'changed');
            }
        } catch (error) {
            this.handleWatchFailure(error);
        } finally {
            this.checking = false;
        }
    }

    private notifyChange(type: FileChangeEvent['type']): void {
        try {
            const onChange = this.onChange;
            const result = onChange({ path: this.path, type });
            // Callbacks are independent; do not hold the filesystem check open for business work.
            void Promise.resolve(result).catch((error) => {
                if (this.active) this.reportError(error);
            });
        } catch (error) {
            this.reportError(error);
        }
    }

    private handleWatchFailure(cause: unknown): void {
        if (!this.active) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (!this.ready) this.startupError = error;
        this.dispose();
        if (this.ready) this.reportError(error);
    }

    private reportError(cause: unknown): void {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        try {
            if (this.options.onError) this.options.onError(error);
            else console.error('File watch failed:', this.path, error);
        } catch (handlerError) {
            console.error('File watch error callback failed:', this.path, handlerError);
        }
    }

    readonly dispose = (): void => {
        if (!this.active) return;
        this.active = false;
        if (this.scheduled !== undefined) clearImmediate(this.scheduled);
        this.watcher?.close();
        this.onDispose();
    };
}

async function readFileFingerprint(filename: string): Promise<string | null> {
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
