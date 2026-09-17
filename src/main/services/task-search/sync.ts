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

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TaskSearchIndex } from './index.js';
import { isSearchableTask, type SearchTask } from './extract.js';

export class TaskSearchSync {
    readonly failures = new Set<string>();
    indexing = true;
    revision = 0;
    private syncing?: Promise<void>;
    private requested = false;
    private fullRequested = false;
    private changedIds = new Set<string>();
    constructor(
        private readonly directory: string,
        private readonly index: TaskSearchIndex,
        private readonly onChange: () => void = () => {}
    ) {}
    refresh(changedIds?: readonly string[]): Promise<void> {
        this.requested = true;
        if (changedIds === undefined) this.fullRequested = true;
        else for (const id of changedIds) this.changedIds.add(id);
        this.indexing = true;
        this.onChange();
        if (!this.syncing) {
            this.syncing = this.drain().finally(() => {
                this.syncing = undefined;
                this.indexing = false;
                this.onChange();
            });
        }
        return this.syncing;
    }
    private async drain(): Promise<void> {
        while (this.requested) {
            this.requested = false;
            const full = this.fullRequested;
            const changedIds = this.changedIds;
            this.fullRequested = false;
            this.changedIds = new Set();
            await this.pass(full, changedIds);
        }
    }
    private async pass(full: boolean, changedIds: Set<string>): Promise<void> {
        let entries: SearchTask[];
        try {
            const parsed: unknown = JSON.parse(await readFile(path.join(this.directory, 'task_list.json'), 'utf8'));
            if (!Array.isArray(parsed)) throw new Error('Invalid task manifest');
            entries = parsed.filter(
                (entry): entry is SearchTask =>
                    entry && typeof entry.task_id === 'string' && /^[a-zA-Z0-9_-]+$/.test(entry.task_id)
            );
            this.failures.delete('manifest');
        } catch (error) {
            // A missing first-run manifest is an empty library; malformed/unreadable
            // manifests preserve the last good index and report incomplete coverage.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
            else {
                this.failures.add('manifest');
                return;
            }
        }
        const fingerprints = this.index.fingerprints();
        const ids = new Set(entries.filter(isSearchableTask).map((entry) => entry.task_id));
        for (const failure of this.failures) {
            if (!['manifest', 'index', 'watch'].includes(failure) && !ids.has(failure)) this.failures.delete(failure);
        }
        for (const id of fingerprints.keys()) {
            if (!ids.has(id)) {
                this.index.removeTask(id);
                this.revision++;
                this.onChange();
                this.failures.delete(id);
            }
        }
        entries.sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''));
        for (const entry of entries) {
            if (!ids.has(entry.task_id)) continue;
            if (!full && !changedIds.has(entry.task_id) && fingerprints.has(entry.task_id)) continue;
            const filename = path.join(this.directory, entry.task_id + '.json');
            try {
                const before = await stat(filename);
                const fingerprint = before.mtimeMs + ':' + before.ctimeMs + ':' + before.size;
                if (fingerprints.get(entry.task_id) === fingerprint) continue;
                const raw: SearchTask = JSON.parse(await readFile(filename, 'utf8'));
                const after = await stat(filename);
                if (
                    before.mtimeMs !== after.mtimeMs ||
                    before.ctimeMs !== after.ctimeMs ||
                    before.size !== after.size
                ) {
                    this.requested = true;
                    this.changedIds.add(entry.task_id);
                    continue;
                }
                if (raw.task_id !== entry.task_id) throw new Error('Task ID mismatch');
                this.index.replaceTask(raw, fingerprint);
                this.failures.delete(entry.task_id);
                this.revision++;
                this.onChange();
            } catch {
                this.index.removeTask(entry.task_id);
                this.failures.add(entry.task_id);
                this.revision++;
                this.onChange();
            }
            // Each task is a separate transaction. Yield for queries between imports.
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    }
}
