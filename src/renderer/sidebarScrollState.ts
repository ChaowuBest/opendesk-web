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

export interface SidebarScrollState {
    runningList: number;
    taskGroups: number;
    groupBodies: Record<string, number>;
}

export function captureSidebarScrollState(root: ParentNode): SidebarScrollState {
    const groupBodies: Record<string, number> = {};
    root.querySelectorAll<HTMLElement>('.sb-task-group[data-group-id]').forEach((group) => {
        const groupId = group.dataset.groupId;
        const body = group.querySelector<HTMLElement>('.sb-task-group-body');
        if (groupId && body) {
            groupBodies[groupId] = body.scrollTop;
        }
    });

    return {
        runningList: root.querySelector<HTMLElement>('.sb-running-list')?.scrollTop ?? 0,
        taskGroups: root.querySelector<HTMLElement>('.sb-task-groups')?.scrollTop ?? 0,
        groupBodies
    };
}

export function restoreSidebarScrollState(root: ParentNode, state: SidebarScrollState): void {
    const runningList = root.querySelector<HTMLElement>('.sb-running-list');
    const taskGroups = root.querySelector<HTMLElement>('.sb-task-groups');
    if (runningList) runningList.scrollTop = state.runningList;
    if (taskGroups) taskGroups.scrollTop = state.taskGroups;

    root.querySelectorAll<HTMLElement>('.sb-task-group[data-group-id]').forEach((group) => {
        const groupId = group.dataset.groupId;
        const body = group.querySelector<HTMLElement>('.sb-task-group-body');
        if (groupId && body && state.groupBodies[groupId] !== undefined) {
            body.scrollTop = state.groupBodies[groupId];
        }
    });
}
