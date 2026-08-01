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

export type SidebarTaskView = 'time' | 'workspace';

export interface SidebarTask {
    task_id: string;
    parent_id?: string;
    task_name?: string | null;
    task_status?: string;
    completion_status?: string;
    internal?: boolean;
    name_pending?: boolean;
    created_at?: string;
    updated_at?: string;
    finished_at?: string;
    workspace?: string;
    [key: string]: unknown;
}

export interface SidebarTaskTreeItem {
    task: SidebarTask;
    children: SidebarTask[];
    recentlyCompleted?: boolean;
}

export interface SidebarTaskGroup {
    id: string;
    label: string;
    workspace?: string;
    items: SidebarTaskTreeItem[];
}

export function isSidebarTaskVisible(task: SidebarTask | null | undefined): task is SidebarTask {
    return Boolean(
        task && ((typeof task.task_name === 'string' && task.task_name.trim()) || task.name_pending === true)
    );
}

function timestamp(value?: string): number {
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

export function getTaskActivityTimestamp(task: SidebarTask): number {
    return Math.max(timestamp(task.updated_at), timestamp(task.finished_at), timestamp(task.created_at));
}

function sortTasks(tasks: SidebarTask[]): SidebarTask[] {
    return [...tasks].sort((left, right) => getTaskActivityTimestamp(right) - getTaskActivityTimestamp(left));
}

function sortChildTasks(tasks: SidebarTask[]): SidebarTask[] {
    return [...tasks].sort((left, right) => {
        const createdDifference = timestamp(left.created_at) - timestamp(right.created_at);
        return createdDifference || getTaskActivityTimestamp(left) - getTaskActivityTimestamp(right);
    });
}

function sortTreeItems(items: SidebarTaskTreeItem[]): SidebarTaskTreeItem[] {
    return [...items].sort((left, right) => getTaskActivityTimestamp(right.task) - getTaskActivityTimestamp(left.task));
}

function buildRootItems(tasks: SidebarTask[]): SidebarTaskTreeItem[] {
    const tasksById = new Map(tasks.map((task) => [task.task_id, task]));
    const childrenByParent = new Map<string, SidebarTask[]>();
    const roots: SidebarTask[] = [];

    for (const task of tasks) {
        if (task.parent_id && tasksById.has(task.parent_id)) {
            const children = childrenByParent.get(task.parent_id) ?? [];
            children.push(task);
            childrenByParent.set(task.parent_id, children);
        } else {
            roots.push(task);
        }
    }

    return sortTasks(roots).map((task) => ({
        task,
        children: sortChildTasks(childrenByParent.get(task.task_id) ?? [])
    }));
}

export function normalizeWorkspace(workspace?: string): string {
    const normalized = (workspace ?? '').replace(/\\/g, '/');
    if (normalized === '/') return normalized;
    return normalized.replace(/\/+$/, '');
}

function workspaceName(workspace: string): string {
    if (!workspace) return '';
    const segments = workspace.split('/').filter(Boolean);
    return segments.at(-1) ?? workspace;
}

function startOfLocalDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfLocalWeek(date: Date): Date {
    const dayStart = startOfLocalDay(date);
    const daysSinceMonday = (dayStart.getDay() + 6) % 7;
    dayStart.setDate(dayStart.getDate() - daysSinceMonday);
    return dayStart;
}

export function getSidebarRunningTasks(tasks: SidebarTask[], now: Date = new Date()): SidebarTaskTreeItem[] {
    const rootItems = buildRootItems(tasks);
    const runningItems = rootItems
        .filter((item) => item.task.internal !== true && item.task.task_status === 'running')
        .map((item) => ({ ...item, recentlyCompleted: false }));
    const nowTimestamp = now.getTime();
    const recentlyCompletedItems = rootItems
        .filter((item) => {
            if (item.task.internal === true || item.task.task_status === 'running') return false;
            const finishedAt = timestamp(item.task.finished_at);
            const elapsed = nowTimestamp - finishedAt;
            return finishedAt > 0 && elapsed >= 0 && elapsed <= 10 * 60 * 1000;
        })
        .sort((left, right) => timestamp(right.task.finished_at) - timestamp(left.task.finished_at))
        .slice(0, 2)
        .map((item) => ({ ...item, recentlyCompleted: true }));

    return [...runningItems, ...recentlyCompletedItems];
}

export function buildSidebarSearchResults(tasks: SidebarTask[]): SidebarTaskTreeItem[] {
    const rootItems = buildRootItems(tasks);
    const results = rootItems.filter((item) => item.task.task_status !== 'running');
    return sortTreeItems(results);
}

export function buildSidebarTaskGroups(
    tasks: SidebarTask[],
    view: SidebarTaskView,
    now: Date = new Date()
): SidebarTaskGroup[] {
    const rootItems = buildRootItems(tasks);
    const automaticItems = rootItems.filter((item) => item.task.internal === true);
    const regularItems = rootItems.filter((item) => item.task.internal !== true);

    if (view === 'workspace') {
        const workspaceGroups = new Map<string, SidebarTaskTreeItem[]>();
        for (const item of regularItems) {
            const workspace = normalizeWorkspace(item.task.workspace);
            const items = workspaceGroups.get(workspace) ?? [];
            items.push(item);
            workspaceGroups.set(workspace, items);
        }
        const sortedWorkspaceGroups = [...workspaceGroups.entries()]
            .map(([workspace, items]) => ({
                id: `workspace:${workspace}`,
                label: workspaceName(workspace),
                workspace,
                items: sortTreeItems(items)
            }))
            .sort(
                (left, right) =>
                    getTaskActivityTimestamp(right.items[0].task) - getTaskActivityTimestamp(left.items[0].task)
            );
        const visibleWorkspaceGroups = sortedWorkspaceGroups.slice(0, 3);
        const otherWorkspaceItems = sortTreeItems(sortedWorkspaceGroups.slice(3).flatMap((group) => group.items));
        return [
            ...visibleWorkspaceGroups,
            ...(otherWorkspaceItems.length > 0
                ? [
                      {
                          id: 'other-workspaces',
                          label: 'other-workspaces',
                          items: otherWorkspaceItems
                      }
                  ]
                : []),
            {
                id: 'automatic',
                label: 'automatic',
                items: automaticItems
            }
        ];
    }

    const todayStart = startOfLocalDay(now).getTime();
    const weekStart = startOfLocalWeek(now).getTime();
    const today: SidebarTaskTreeItem[] = [];
    const thisWeek: SidebarTaskTreeItem[] = [];
    const earlier: SidebarTaskTreeItem[] = [];

    for (const item of regularItems) {
        const createdAt = timestamp(item.task.created_at);
        if (createdAt >= todayStart) {
            today.push(item);
        } else if (createdAt >= weekStart) {
            thisWeek.push(item);
        } else {
            earlier.push(item);
        }
    }

    return [
        { id: 'today', label: 'today', items: today },
        { id: 'this-week', label: 'this-week', items: thisWeek },
        { id: 'earlier', label: 'earlier', items: earlier },
        { id: 'automatic', label: 'automatic', items: automaticItems }
    ];
}
