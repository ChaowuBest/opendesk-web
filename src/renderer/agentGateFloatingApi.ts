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

import { createIpcChannelDispatcher, type IpcOnOff } from './ipcChannelDispatcher.js';

export interface AgentGateFloatingAPI {
    onEventsUpdate(callback: (events: unknown, counts: unknown) => void): () => void;
    onAttributionStart(callback: (data: unknown) => void): () => void;
    onAttributionEnd(callback: (data: unknown) => void): () => void;
}

/**
 * AgentGate 浮窗/归因事件的 renderer 侧 API。
 *
 * 同一 renderer 里可能同时存在多个 TaskView（index.html 的 taskViewCache 会缓存多个），
 * 每个都会订阅归因事件，因此每个订阅必须拿到只退订自己的 unsubscribe ——
 * 否则删除一个任务会让其余任务的“分析中”状态收不到 end 而滞留（issue #116）。
 */
export function createAgentGateFloatingApi(ipc: IpcOnOff): AgentGateFloatingAPI {
    const eventsUpdate = createIpcChannelDispatcher(ipc, 'agentgate:eventsUpdate');
    const attributionStart = createIpcChannelDispatcher(ipc, 'agentgate:attributionStart');
    const attributionEnd = createIpcChannelDispatcher(ipc, 'agentgate:attributionEnd');

    return {
        onEventsUpdate: (callback) =>
            eventsUpdate.subscribe((data) => {
                const payload = data as { events?: unknown; counts?: unknown };
                callback(payload.events || payload, payload.counts || { totalCount: 0, denyCount: 0, allowCount: 0 });
            }),
        onAttributionStart: (callback) => attributionStart.subscribe((data) => callback(data)),
        onAttributionEnd: (callback) => attributionEnd.subscribe((data) => callback(data))
    };
}
