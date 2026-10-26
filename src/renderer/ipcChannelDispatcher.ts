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

type IpcChannelListener = (event: unknown, ...args: unknown[]) => void;

export interface IpcOnOff {
    on(channel: string, listener: IpcChannelListener): unknown;
    removeListener(channel: string, listener: IpcChannelListener): unknown;
}

export interface IpcChannelDispatcher {
    /** 每个 callback 得到只移除自己的 unsubscribe（幂等），不影响同通道上的其他订阅者 */
    subscribe(callback: (...args: unknown[]) => void): () => void;
    /** 当前订阅者数量（诊断与测试用） */
    readonly size: number;
}

/**
 * renderer 侧「一个 IPC 通道 → 多个订阅者」的分发器，所有 renderer 订阅都应经由它，
 * 不要直接 ipcRenderer.on + removeAllListeners。
 *
 * 两个约束来自实际缺陷（issue #116）：同一个 renderer 里可能有多个 consumer 订阅同一
 * 通道（例如被缓存的多个 task-view 都在监听 AgentGate 归因事件），此时
 * 1) 退订必须只移除自己 —— removeAllListeners 会连带清掉其他 consumer 的 handler，
 *    表现为删掉一个任务后其余任务再也收不到事件；
 * 2) 通道上只保留一个 IPC listener，由回调表分发 —— 订阅者数量不受 Node EventEmitter
 *    默认上限（10）约束（与 settingChangedSubscription 的收敛思路一致）。
 */
export function createIpcChannelDispatcher(ipc: IpcOnOff, channel: string): IpcChannelDispatcher {
    const callbacks: Array<(...args: unknown[]) => void> = [];
    let listener: IpcChannelListener | null = null;

    const detachIpcListener = () => {
        if (listener === null) return;
        ipc.removeListener(channel, listener);
        listener = null;
    };

    return {
        subscribe(callback) {
            callbacks.push(callback);
            if (listener === null) {
                listener = (_event, ...args) => {
                    // 快照遍历：回调内部退订/新增订阅不应影响本轮分发
                    for (const current of [...callbacks]) {
                        // 消费者异常必须就地隔离：共用同一个 IPC listener 之后，一个 consumer
                        // 抛错会连带让本轮其余 consumer 收不到事件（旧实现里各 listener 相互
                        // 独立，行为差异会变成"某个任务的事件间歇性丢失"这种难查的问题）
                        try {
                            current(...args);
                        } catch (error) {
                            console.error(`[ipcChannelDispatcher] handler failed on ${channel}`, error);
                        }
                    }
                };
                ipc.on(channel, listener);
            }
            let active = true;
            return () => {
                if (!active) return;
                active = false;
                const index = callbacks.indexOf(callback);
                if (index >= 0) {
                    callbacks.splice(index, 1);
                }
                if (callbacks.length === 0) {
                    detachIpcListener();
                }
            };
        },
        get size() {
            return callbacks.length;
        }
    };
}
