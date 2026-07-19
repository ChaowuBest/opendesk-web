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

/**
 * 子应用浮动对话的内存会话控制器。
 * 同一应用页只保留一个当前任务，并合并并发的创建/切换请求。
 */
export class ApplicationTaskSession {
    private currentTaskId: string | null = null;
    private creationPromise: Promise<string> | null = null;
    private switchPromise: Promise<string> | null = null;

    constructor(
        private readonly hooks: {
            createTask: () => Promise<string>;
            mountTask: (taskId: string) => Promise<void> | void;
            unmountTask: () => Promise<void> | void;
            discardTask?: (taskId: string) => Promise<void> | void;
        }
    ) {}

    get taskId(): string | null {
        return this.currentTaskId;
    }

    isCurrent(taskId: string): boolean {
        return this.currentTaskId === taskId;
    }

    ensureTask(): Promise<string> {
        if (this.switchPromise) {
            return this.switchPromise;
        }
        if (this.currentTaskId) {
            return Promise.resolve(this.currentTaskId);
        }
        return this.createAndMountTask();
    }

    startNewTask(): Promise<string> {
        if (this.switchPromise) {
            return this.switchPromise;
        }

        const switchPromise = (async () => {
            if (this.creationPromise) {
                const pendingCreation = this.creationPromise;
                try {
                    await pendingCreation;
                } catch {
                    // 创建失败的任务没有可保留状态，继续尝试创建新任务。
                }
                if (this.creationPromise === pendingCreation) {
                    this.creationPromise = null;
                }
            }
            this.currentTaskId = null;
            await this.hooks.unmountTask();
            return this.createAndMountTask();
        })();
        this.switchPromise = switchPromise;
        void switchPromise.then(
            () => {
                if (this.switchPromise === switchPromise) {
                    this.switchPromise = null;
                }
            },
            () => {
                if (this.switchPromise === switchPromise) {
                    this.switchPromise = null;
                }
            }
        );
        return switchPromise;
    }

    private createAndMountTask(): Promise<string> {
        if (this.creationPromise) {
            return this.creationPromise;
        }

        const creationPromise = (async () => {
            const taskId = await this.hooks.createTask();
            this.currentTaskId = taskId;
            try {
                await this.hooks.mountTask(taskId);
                return taskId;
            } catch (error) {
                if (this.currentTaskId === taskId) {
                    this.currentTaskId = null;
                }
                await this.hooks.unmountTask();
                try {
                    await this.hooks.discardTask?.(taskId);
                } catch {
                    // 保留原始挂载错误；后端清理失败不应掩盖真正故障。
                }
                throw error;
            }
        })();
        this.creationPromise = creationPromise;
        void creationPromise.then(
            () => {
                if (this.creationPromise === creationPromise) {
                    this.creationPromise = null;
                }
            },
            () => {
                if (this.creationPromise === creationPromise) {
                    this.creationPromise = null;
                }
            }
        );
        return creationPromise;
    }
}
