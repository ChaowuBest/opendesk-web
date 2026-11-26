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

import { BaseTaskUpdateSubscriber, type TaskState, type TaskUpdateChunk } from '../../../../../aikernel/states/tasks.js';
import { BaseTaskManagerUpdateSubscriber, type TaskManagerState } from '../../../../../aikernel/task/manager.js';
import type {
    RemoteTaskManagerSubscriber,
    RemoteTaskUpdateSubscriber
} from '../remote-session-service/public-session-sync.js';
import type { TaskUpdateChunk as MobileTaskUpdateChunk } from '../remote-session-service/session-projector.js';

/**
 * Bridges between the Task core subscription base classes and the structural contracts the mobile
 * Remote Session Service consumes. This is the only mobile layer allowed to name real Task types;
 * the host composition receives the resulting callbacks and never imports this module.
 */
export function subscribeMobileTaskUpdates(task: TaskState, delegate: RemoteTaskUpdateSubscriber): () => void {
    class Bridge extends BaseTaskUpdateSubscriber {
        override wantsHtmlRender = false;
        override isAvailable() {
            return delegate.isAvailable();
        }
        override send(chunk: TaskUpdateChunk) {
            delegate.send(chunk as unknown as MobileTaskUpdateChunk);
        }
    }
    const bridge = new Bridge();
    const id = task.addSubscriber(bridge);
    return () => {
        task.removeSubscriber(id);
    };
}

export function subscribeMobileTaskManagerUpdates(
    manager: TaskManagerState,
    delegate: RemoteTaskManagerSubscriber
): () => void {
    class Bridge extends BaseTaskManagerUpdateSubscriber {
        override isAvailable() {
            return delegate.isAvailable();
        }
        override send(taskList: object[]) {
            delegate.send(taskList);
        }
    }
    const bridge = new Bridge();
    const id = manager.addSubscriber(bridge);
    return () => {
        manager.removeSubscriber(id);
    };
}
