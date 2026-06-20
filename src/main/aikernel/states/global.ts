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

import { TaskManagerState } from './tasks.js';

class GlobalState {
    private static instance: GlobalState | null = null;
    taskManagerState: TaskManagerState;

    /**
     * 是否处于 serve 模式（opencode/acp）。
     * serve 模式下不应自动启动设备网关等独立服务。
     */
    private _serveMode: boolean = false;

    /**
     * 设置是否处于 serve 模式
     */
    setServerMode(mode: boolean): void {
        this._serveMode = mode;
    }

    /**
     * 是否处于 serve 模式
     */
    isServeMode(): boolean {
        return this._serveMode;
    }

    constructor() {
        this.taskManagerState = new TaskManagerState();
    }

    static initialize(): void {
        GlobalState.getInstance();
    }

    /**
     * Get the unique global state instance
     * @returns the GlobalState instance
     */
    static getInstance(): GlobalState {
        if (!GlobalState.instance) {
            const existingGlobalState = GlobalState.load();
            if (existingGlobalState !== null) {
                GlobalState.instance = existingGlobalState;
            } else {
                console.info('creating new global state instance');
                GlobalState.instance = new GlobalState();
            }
        }

        return GlobalState.instance;
    }

    static load(): GlobalState | null {
        const taskManagerState = TaskManagerState.load();
        if (taskManagerState === null) {
            return null;
        }

        const globalState = new GlobalState();
        globalState.taskManagerState = taskManagerState;
        return globalState;
    }
}

export { GlobalState };
