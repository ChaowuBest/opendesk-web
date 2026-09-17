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

import { parentPort, workerData } from 'node:worker_threads';
import { watch, type FSWatcher } from 'node:fs';
import { TaskSearchIndex } from './index.js';
import { TaskSearchSync } from './sync.js';
import type { TaskSearchMessage, TaskSearchRequest } from './protocol.js';

const port = parentPort!;
const configuration = workerData as { directory: string; dbPath: string };
const index = await TaskSearchIndex.open(configuration.dbPath);
const sync = new TaskSearchSync(configuration.directory, index, notifyChanged);
const cache = new Map<string, { revision: number; result: ReturnType<TaskSearchIndex['search']> }>();
let notificationScheduled = false;
let lastState = '';
let refreshScheduled = false;
let fullRefresh = false;
const changedIds = new Set<string>();
let watcher: FSWatcher | undefined;

function notifyChanged(): void {
    if (notificationScheduled) return;
    notificationScheduled = true;
    setImmediate(() => {
        notificationScheduled = false;
        const state = JSON.stringify([sync.revision, sync.indexing || refreshScheduled, [...sync.failures].sort()]);
        if (state === lastState) return;
        lastState = state;
        port.postMessage({ type: 'changed' } satisfies TaskSearchMessage);
    });
}
function reportError(error: unknown, id?: number): void {
    port.postMessage({
        type: 'error',
        id,
        message: error instanceof Error ? error.stack || error.message : String(error)
    } satisfies TaskSearchMessage);
}
function watchDirectory(): void {
    if (watcher) return;
    try {
        watcher = watch(configuration.directory, (_event, filename) => {
            if (filename && !String(filename).endsWith('.json')) return;
            scheduleRefresh(filename && filename !== 'task_list.json' ? String(filename).slice(0, -5) : undefined);
        });
        watcher.on('error', (error) => {
            watcher?.close();
            watcher = undefined;
            sync.failures.add('watch');
            reportError(error);
            notifyChanged();
        });
        sync.failures.delete('watch');
    } catch (error) {
        sync.failures.add('watch');
        reportError(error);
    }
}
function scheduleRefresh(id?: string): void {
    if (id === undefined) fullRefresh = true;
    else changedIds.add(id);
    if (refreshScheduled) return;
    refreshScheduled = true;
    notifyChanged();
    // Coalesce the current event burst, without a recurring scan or a debounce
    // deadline that continuous writes can keep postponing.
    setImmediate(() => {
        refreshScheduled = false;
        const ids = fullRefresh ? undefined : [...changedIds];
        fullRefresh = false;
        changedIds.clear();
        void sync.refresh(ids).then(
            () => {
                sync.failures.delete('index');
                notifyChanged();
            },
            (error) => {
                sync.failures.add('index');
                reportError(error);
                notifyChanged();
            }
        );
    });
}
watchDirectory();
scheduleRefresh();
type QueryRequest = Extract<TaskSearchRequest, { type: 'search' }>;
const pendingQueries = new Map<number, QueryRequest>();
let scheduled = false;
port.on('message', (request: TaskSearchRequest) => {
    if (request.type === 'refresh') {
        // Opening the dialog is an explicit recovery point for missed file events.
        watchDirectory();
        scheduleRefresh();
        return;
    }
    const previous = pendingQueries.get(request.clientId);
    if (previous) reportError(new Error('Task search superseded'), previous.id);
    pendingQueries.set(request.clientId, request);
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
        scheduled = false;
        const queries = [...pendingQueries.values()];
        pendingQueries.clear();
        for (const query of queries) search(query);
    });
});
function search(request: Extract<TaskSearchRequest, { type: 'search' }>): void {
    try {
        const key = JSON.stringify([request.query, request.limit]);
        let cached = cache.get(key);
        if (!cached || cached.revision !== sync.revision) {
            cached = { revision: sync.revision, result: index.search(request.query, request.limit) };
            cache.delete(key);
            cache.set(key, cached);
            if (cache.size > 30) cache.delete(cache.keys().next().value!);
        }
        port.postMessage({
            type: 'result',
            id: request.id,
            data: {
                ...cached.result,
                indexing: sync.indexing || refreshScheduled,
                revision: sync.revision,
                failedTasks: sync.failures.size
            }
        });
    } catch (error) {
        reportError(error, request.id);
    }
}
