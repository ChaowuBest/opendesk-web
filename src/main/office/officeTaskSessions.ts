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

export type OfficeTaskSessionKind = 'slides' | 'word' | 'sheets';

export interface OfficeSessionContents {
    readonly id: number;
    isDestroyed(): boolean;
    once(event: 'destroyed', listener: () => void): unknown;
}

export interface TaskBoundOfficeSession<T extends OfficeSessionContents> {
    kind: OfficeTaskSessionKind;
    taskId: string;
    filePath: string;
    contents: T;
    generation: number;
}

export class OfficeTaskSessionRegistry<T extends OfficeSessionContents> {
    private readonly sessionsByTask = new Map<string, TaskBoundOfficeSession<T>>();
    private readonly sessionKeyByContentsId = new Map<number, string>();
    private readonly waitersByTask = new Map<
        string,
        Set<{
            filePath: string;
            resolve: (session: TaskBoundOfficeSession<T> | undefined) => void;
            timer: ReturnType<typeof setTimeout>;
            abortSignal?: AbortSignal;
            abortListener?: () => void;
        }>
    >();
    private generation = 0;

    private key(kind: OfficeTaskSessionKind, taskId: string): string {
        return `${kind}:${taskId}`;
    }

    bind(
        kind: OfficeTaskSessionKind,
        taskId: string,
        filePath: string,
        contents: T
    ): TaskBoundOfficeSession<T> {
        const sessionKey = this.key(kind, taskId);
        const previousKey = this.sessionKeyByContentsId.get(contents.id);
        if (previousKey && previousKey !== sessionKey) this.removeByKey(previousKey);
        if (this.sessionsByTask.has(sessionKey)) this.removeByKey(sessionKey);

        const session: TaskBoundOfficeSession<T> = {
            kind,
            taskId,
            filePath,
            contents,
            generation: ++this.generation
        };
        this.sessionsByTask.set(sessionKey, session);
        this.sessionKeyByContentsId.set(contents.id, sessionKey);
        const waiters = this.waitersByTask.get(sessionKey);
        if (waiters) {
            for (const waiter of [...waiters]) {
                if (waiter.filePath !== filePath) continue;
                clearTimeout(waiter.timer);
                if (waiter.abortSignal && waiter.abortListener) {
                    waiter.abortSignal.removeEventListener('abort', waiter.abortListener);
                }
                waiters.delete(waiter);
                waiter.resolve(session);
            }
            if (waiters.size === 0) this.waitersByTask.delete(sessionKey);
        }
        contents.once('destroyed', () => {
            const current = this.sessionsByTask.get(sessionKey);
            if (current?.generation === session.generation) this.removeByKey(sessionKey);
        });
        return session;
    }

    get(kind: OfficeTaskSessionKind, taskId: string): TaskBoundOfficeSession<T> | undefined {
        const sessionKey = this.key(kind, taskId);
        const session = this.sessionsByTask.get(sessionKey);
        if (!session) return undefined;
        if (session.contents.isDestroyed()) {
            this.removeByKey(sessionKey);
            return undefined;
        }
        return session;
    }

    waitFor(
        kind: OfficeTaskSessionKind,
        taskId: string,
        filePath: string,
        timeoutMs: number,
        abortSignal?: AbortSignal
    ): Promise<TaskBoundOfficeSession<T> | undefined> {
        const sessionKey = this.key(kind, taskId);
        const current = this.get(kind, taskId);
        if (current?.filePath === filePath) return Promise.resolve(current);
        if (abortSignal?.aborted) return Promise.resolve(undefined);

        return new Promise((resolve) => {
            const waiters = this.waitersByTask.get(sessionKey) ?? new Set();
            const finish = (session: TaskBoundOfficeSession<T> | undefined): void => {
                clearTimeout(waiter.timer);
                if (waiter.abortSignal && waiter.abortListener) {
                    waiter.abortSignal.removeEventListener('abort', waiter.abortListener);
                }
                waiters.delete(waiter);
                if (waiters.size === 0) this.waitersByTask.delete(sessionKey);
                resolve(session);
            };
            const waiter: {
                filePath: string;
                resolve: (session: TaskBoundOfficeSession<T> | undefined) => void;
                timer: ReturnType<typeof setTimeout>;
                abortSignal?: AbortSignal;
                abortListener?: () => void;
            } = {
                filePath,
                resolve: finish,
                timer: setTimeout(() => finish(undefined), timeoutMs),
                abortSignal
            };
            if (abortSignal) {
                waiter.abortListener = () => finish(undefined);
                abortSignal.addEventListener('abort', waiter.abortListener, { once: true });
            }
            waiters.add(waiter);
            this.waitersByTask.set(sessionKey, waiters);
        });
    }

    remove(kind: OfficeTaskSessionKind, taskId: string): void {
        this.removeByKey(this.key(kind, taskId));
    }

    private removeByKey(sessionKey: string): void {
        const session = this.sessionsByTask.get(sessionKey);
        if (!session) return;
        this.sessionsByTask.delete(sessionKey);
        if (this.sessionKeyByContentsId.get(session.contents.id) === sessionKey) {
            this.sessionKeyByContentsId.delete(session.contents.id);
        }
    }
}
