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

export interface TaskFileOpenRequest {
    requestId: string;
    taskId: string;
    filePath: string;
}

interface TaskFileTarget extends Element {
    task_id?: string;
    openFileInSidebar?: (filePath: string, line?: number, onSwitchBlocked?: () => void) => void;
}

export function routeTaskFileOpenRequest(
    root: ParentNode,
    request: TaskFileOpenRequest,
    onNotOpened: (requestId: string) => void
): boolean {
    if (!request?.requestId || !request.taskId || !request.filePath) return false;

    const taskView = [...root.querySelectorAll('task-view')].find((candidate) => {
        const target = candidate as TaskFileTarget;
        return target.task_id === request.taskId || target.getAttribute('task_id') === request.taskId;
    }) as TaskFileTarget | undefined;
    if (!taskView?.openFileInSidebar) return false;

    taskView.openFileInSidebar(request.filePath, undefined, () => onNotOpened(request.requestId));
    return true;
}
