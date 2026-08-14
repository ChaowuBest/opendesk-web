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

export interface SlidesSessionContents {
    readonly id: number;
    isDestroyed(): boolean;
    once(event: 'destroyed', listener: () => void): unknown;
}

export interface TaskBoundSlidesSession<T extends SlidesSessionContents> {
    taskId: string;
    filePath: string;
    contents: T;
    generation: number;
}

export class SlidesTaskSessionRegistry<T extends SlidesSessionContents> {
    private readonly sessionsByTask = new Map<string, TaskBoundSlidesSession<T>>();
    private readonly taskByContentsId = new Map<number, string>();
    private generation = 0;

    bind(taskId: string, filePath: string, contents: T): TaskBoundSlidesSession<T> {
        const previousTask = this.taskByContentsId.get(contents.id);
        if (previousTask && previousTask !== taskId) this.remove(previousTask);
        if (this.sessionsByTask.has(taskId)) this.remove(taskId);

        const session: TaskBoundSlidesSession<T> = {
            taskId,
            filePath,
            contents,
            generation: ++this.generation
        };
        this.sessionsByTask.set(taskId, session);
        this.taskByContentsId.set(contents.id, taskId);
        contents.once('destroyed', () => {
            const current = this.sessionsByTask.get(taskId);
            if (current?.generation === session.generation) this.remove(taskId);
        });
        return session;
    }

    get(taskId: string): TaskBoundSlidesSession<T> | undefined {
        const session = this.sessionsByTask.get(taskId);
        if (!session) return undefined;
        if (session.contents.isDestroyed()) {
            this.remove(taskId);
            return undefined;
        }
        return session;
    }

    remove(taskId: string): void {
        const session = this.sessionsByTask.get(taskId);
        if (!session) return;
        this.sessionsByTask.delete(taskId);
        if (this.taskByContentsId.get(session.contents.id) === taskId) {
            this.taskByContentsId.delete(session.contents.id);
        }
    }
}
