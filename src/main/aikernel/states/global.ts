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
     * 全局默认执行节点 ID（不落盘，仅在本次启动期间有效）。
     * 新建任务时如果未指定执行节点，将使用此默认值。
     */
    private _defaultExecutionNodeId: string = '';

    /**
     * 全局默认执行节点显示标签（不落盘）。
     */
    private _defaultExecutionNodeLabel: string = '';

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

    /**
     * 设置全局默认执行节点（运行时状态，不落盘）
     */
    setDefaultExecutionNode(nodeId: string, label?: string): void {
        this._defaultExecutionNodeId = nodeId;
        this._defaultExecutionNodeLabel = label ?? '';
    }

    /**
     * 获取全局默认执行节点 ID
     */
    getDefaultExecutionNodeId(): string {
        return this._defaultExecutionNodeId;
    }

    /**
     * 获取全局默认执行节点显示标签
     */
    getDefaultExecutionNodeLabel(): string {
        return this._defaultExecutionNodeLabel;
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

    static getCurrentInstance(): GlobalState | undefined {
        return GlobalState.instance ?? undefined;
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
