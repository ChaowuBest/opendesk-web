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

import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskSearchMessage, TaskSearchRequest } from './protocol.js';
import type { TaskSearchResponse } from '../../../common/task-search.js';
import { TASK_SEARCH_MAX_QUERY, TASK_SEARCH_MAX_RESULTS } from '../../../common/task-search.js';

export type SearchTaskMetadata = {
    task_id: string;
    task_name?: string | null;
    workspace?: string | null;
    internal?: boolean;
    name_pending?: boolean;
};

/** Validate requests and recheck live metadata without loading task histories. */
export async function searchVisibleTasks(
    service: Pick<TaskSearchService, 'search'>,
    getTasks: () => readonly SearchTaskMetadata[],
    query: unknown,
    limit: unknown,
    clientId = 0
): Promise<TaskSearchResponse> {
    if (
        typeof query !== 'string' ||
        query.length > TASK_SEARCH_MAX_QUERY ||
        typeof limit !== 'number' ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > TASK_SEARCH_MAX_RESULTS
    )
        throw new Error('Invalid task search request');
    const data = await service.search(query, limit, clientId);
    const visible = new Map(
        getTasks()
            .filter((task) => task.internal !== true && Boolean(task.task_name?.trim() || task.name_pending))
            .map((task) => [task.task_id, task])
    );
    return {
        ...data,
        items: data.items
            .filter((item) => visible.has(item.taskId))
            .map((item) => {
                const task = visible.get(item.taskId)!;
                return { ...item, title: task.task_name || '', workspace: task.workspace || '' };
            })
    };
}

export class TaskSearchService {
    private worker?: Worker;
    private serial = 0;
    private disposed = false;
    private pending = new Map<
        number,
        {
            resolve: (value: TaskSearchResponse) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    constructor(
        private readonly directory: string,
        private readonly dbPath: string,
        private readonly events: { onChange(unavailable?: boolean): void; onError(error: Error): void }
    ) {}
    start(): void {
        if (this.worker || this.disposed) return;
        const root = path.dirname(fileURLToPath(import.meta.url));
        const filename = [
            // Hosts without a package.json module declaration need an explicit ESM extension.
            path.join(root, 'task-search-worker.mjs'),
            path.join(root, '..', 'task-search-worker.mjs'),
            path.join(root, 'task-search-worker.js'),
            path.join(root, '..', 'task-search-worker.js')
        ].find(existsSync);
        if (!filename) throw new Error('Task search worker bundle is missing');
        const worker = new Worker(filename, { workerData: { directory: this.directory, dbPath: this.dbPath } });
        this.worker = worker;
        worker.unref();
        worker.on('message', (message: TaskSearchMessage) => {
            if (this.worker !== worker) return;
            if (message.type === 'changed') {
                this.events.onChange();
                return;
            }
            if (message.type === 'error' && message.id === undefined) {
                this.events.onError(new Error(message.message));
                return;
            }
            const request = this.pending.get(message.id!);
            if (!request) return;
            this.pending.delete(message.id!);
            clearTimeout(request.timer);
            if (message.type === 'error') request.reject(new Error(message.message));
            else request.resolve(message.data);
        });
        const fail = (error: Error) => {
            if (this.worker !== worker) return;
            this.worker = undefined;
            // Requests carry their cause to the IPC logger. Startup failures have
            // no request, so report them explicitly through the host boundary.
            if (!this.pending.size) this.events.onError(error);
            this.rejectPending(error);
            this.events.onChange(true);
        };
        worker.on('error', fail);
        worker.on('exit', (code) => fail(new Error(`Task search worker exited with code ${code}`)));
    }
    refresh(): void {
        this.start();
        this.worker?.postMessage({ type: 'refresh' } satisfies TaskSearchRequest);
    }

    search(query: string, limit: number, clientId = 0): Promise<TaskSearchResponse> {
        if (this.disposed) return Promise.reject(new Error('Task search is closed'));
        this.start();
        const id = ++this.serial;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('Task search timed out'));
            }, 15000);
            this.pending.set(id, { resolve, reject, timer });
            this.worker!.postMessage({ type: 'search', id, query, limit, clientId } satisfies TaskSearchRequest);
        });
    }
    private rejectPending(error: Error): void {
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
    }
    async dispose(): Promise<void> {
        this.disposed = true;
        const worker = this.worker;
        this.worker = undefined;
        this.rejectPending(new Error('Task search is closed'));
        await worker?.terminate();
    }
}
