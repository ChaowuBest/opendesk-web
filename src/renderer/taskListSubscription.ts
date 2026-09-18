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

const TASK_LIST_UPDATE_CHANNEL = 'taskManager:taskListUpdate';
const TASK_LIST_SUBSCRIBE_CHANNEL = 'taskManager:subscribeTaskListUpdate';

type TaskListUpdateListener = (event: unknown, ...args: unknown[]) => void;

interface TaskListSubscriptionIPC {
    on(channel: string, listener: TaskListUpdateListener): unknown;
    removeListener(channel: string, listener: TaskListUpdateListener): unknown;
    invoke(channel: string): Promise<{ status: string; data?: unknown; message?: unknown }>;
}

export interface TaskListUpdateSubscription {
    subscriptionId: string;
    listener: TaskListUpdateListener;
}

/**
 * Install the renderer listener before asking main to publish updates. Main registers
 * the subscriber during invoke(), so installing the listener afterwards leaves a gap
 * where a newly created task can be published and permanently missed by the sidebar.
 */
export async function createTaskListUpdateSubscription(
    ipc: TaskListSubscriptionIPC,
    callback: (...args: unknown[]) => void
): Promise<TaskListUpdateSubscription> {
    const listener: TaskListUpdateListener = (_event, ...args) => callback(...args);
    ipc.on(TASK_LIST_UPDATE_CHANNEL, listener);

    try {
        const result = await ipc.invoke(TASK_LIST_SUBSCRIBE_CHANNEL);
        if (result.status !== 'ok' || typeof result.data !== 'string') {
            throw new Error(
                typeof result.message === 'string' ? result.message : 'subscribing task list update failed'
            );
        }
        return { subscriptionId: result.data, listener };
    } catch (error) {
        ipc.removeListener(TASK_LIST_UPDATE_CHANNEL, listener);
        throw error;
    }
}
