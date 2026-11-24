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

import type { TaskManagerState } from '../../../../../aikernel/task/manager.js';
import { resolveTaskMode } from '../../../../../aikernel/task/mode.js';
import type { ModeDecl } from '../../../../../aikernel/agents/common.js';
import type { MobileHostCapabilities } from '../host-composition.js';
import { createHostSessionTask, type HostSessionModelSource } from '../remote-session-service/host-binding.js';
import { subscribeMobileTaskManagerUpdates, subscribeMobileTaskUpdates } from './task-subscriptions.js';
import type { TaskState } from '../../../../../aikernel/states/tasks.js';

export interface TuiHostCapabilitySource {
    taskManager: TaskManagerState;
    getModelOverride(): string | undefined;
    getMainMode(): ModeDecl;
    getDefaultWorkspace(): string;
    sessionModelSource: HostSessionModelSource;
    getDefaultExecutionNodeId(): string;
    getExecutionNode: Parameters<typeof createHostSessionTask>[1]['getExecutionNode'];
    diagnose: Parameters<typeof createHostSessionTask>[1]['diagnose'];
}

export function createTuiHostCapabilities(source: TuiHostCapabilitySource): MobileHostCapabilities {
    const manager = source.taskManager;
    return {
        getTaskList: () => manager.getTaskList(),
        getTaskLoadResult: (id) => manager.getTaskLoadResult(id),
        getDefaultWorkspace: source.getDefaultWorkspace,
        sessionModelSource: source.sessionModelSource,
        publishTaskListUpdate: () => manager.publishTaskListUpdate(),
        createSessionTask: (input) =>
            createHostSessionTask(input, {
                taskManager: {
                    get tasks() {
                        return manager.tasks;
                    },
                    createTask: () => manager.createTask(source.getModelOverride()),
                    initHarness: (task, workspace) =>
                        manager.initHarness(
                            task as TaskState,
                            workspace,
                            resolveTaskMode(task as TaskState, source.getMainMode())
                        ),
                    publishTaskListUpdate: () => manager.publishTaskListUpdate()
                },
                getDefaultExecutionNodeId: source.getDefaultExecutionNodeId,
                getExecutionNode: source.getExecutionNode,
                diagnose: source.diagnose
            }),
        subscribeTaskUpdates: (task, subscriber) => subscribeMobileTaskUpdates(task as TaskState, subscriber),
        subscribeTaskManagerUpdates: (subscriber) => subscribeMobileTaskManagerUpdates(manager, subscriber)
    };
}
