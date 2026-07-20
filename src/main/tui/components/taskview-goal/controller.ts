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

import type { Component } from '@earendil-works/pi-tui';

import type { TaskState, TaskUpdateUserChunk } from '../../../aikernel/states/tasks.js';
import { getGoalTokenUsage } from '../../../aikernel/goal/controller.js';
import { GoalStates, type GoalFinalSnapshot } from '../../../aikernel/goal/state.js';
import { getGoalSupplementIds } from '../../../../common/goal/user-message-display.js';
import { getGoalElapsedMs } from '../../../../common/goal/format.js';
import { t } from '../../../../locale/index.js';
import { GoalPanel, type GoalPanelData } from '../goalpanel.js';
import { getGoalPanelDataFromFinalSnapshot, getGoalSnapshotTimestamp } from './history-placement.js';

export interface TaskViewGoalHost {
    getTaskState(): TaskState | undefined;
    appendPendingUserMessage(text: string): Component;
    appendGoalPanel(view: GoalPanel): void;
    removeGoalManagedView(view: Component): void;
    replaceGoalManagedView(previous: Component, next: GoalPanel): void;
    placeGoalManagedView(view: Component, placement: { after?: Component; before?: Component }): void;
    findMessageViewById(messageId: string): Component | undefined;
    findFirstExternalUserMessageViewAfter(timestamp: number): Component | undefined;
    moveGoalPanelToLayoutEnd(view: GoalPanel): void;
    markInvalidated(): void;
}

interface PendingGoalSupplementView {
    supplementId?: string;
    view: Component;
}

interface PendingGoalEditView {
    type: 'create' | 'edit';
    objective: string;
    goalId: string;
    goalRevision: number;
    view: Component;
}

function getGoalEditReminderId(chunk: TaskUpdateUserChunk): string | undefined {
    const reason = chunk.metadata?.origin?.reason;
    const controllerId = chunk.metadata?.execution?.controllerId;
    if (
        chunk.internal !== true ||
        (reason !== 'goal_create' &&
            reason !== 'goal_edit' &&
            reason !== 'goal_create_display' &&
            reason !== 'goal_edit_display') ||
        typeof controllerId !== 'string'
    ) {
        return undefined;
    }
    return controllerId;
}

export class TaskViewGoalController {
    readonly goalPanelViews: Map<string, GoalPanel> = new Map();
    private pendingGoalSupplementViews: PendingGoalSupplementView[] = [];
    private pendingGoalEditView: PendingGoalEditView | null = null;

    constructor(private readonly host: TaskViewGoalHost) {}

    get pendingSupplements(): readonly PendingGoalSupplementView[] {
        return this.pendingGoalSupplementViews;
    }

    get pendingEdit(): PendingGoalEditView | null {
        return this.pendingGoalEditView;
    }

    reset(): void {
        this.goalPanelViews.clear();
        this.pendingGoalSupplementViews = [];
        this.pendingGoalEditView = null;
    }

    isGoalSupplementInput(task: TaskState): boolean {
        return task.goal_state?.status === 'active' && task.task_status === 'running';
    }

    trackSubmittedGoalSupplement(view: Component, supplementId?: string): void {
        this.pendingGoalSupplementViews.push({ supplementId, view });
    }

    appendPendingGoalSupplementMessage(text: string, supplementId?: string): void {
        const view = this.host.appendPendingUserMessage(text);
        this.trackSubmittedGoalSupplement(view, supplementId);
    }

    showPendingGoalEdit(type: 'create' | 'edit', objective: string, goalId: string, goalRevision: number): void {
        const text = t(`goal.pending.${type}`, { objective });
        if (this.pendingGoalEditView) {
            if (this.pendingGoalEditView.goalId === goalId && this.pendingGoalEditView.goalRevision === goalRevision) {
                return;
            }
            this.host.removeGoalManagedView(this.pendingGoalEditView.view);
        }
        const view = this.host.appendPendingUserMessage(text);
        this.pendingGoalEditView = { type, objective, goalId, goalRevision, view };
    }

    private clearPendingGoalEditView(): void {
        if (!this.pendingGoalEditView) return;
        this.host.removeGoalManagedView(this.pendingGoalEditView.view);
        this.pendingGoalEditView = null;
        this.host.markInvalidated();
    }

    private clearStalePendingGoalEdit(): void {
        if (!this.pendingGoalEditView) return;
        const goal = this.host.getTaskState()?.goal_state;
        if (!goal || goal.id !== this.pendingGoalEditView.goalId || goal.status !== 'active') {
            this.clearPendingGoalEditView();
        }
    }

    removePendingGoalSupplementViewsForIds(supplementIds: string[]): void {
        if (this.pendingGoalSupplementViews.length === 0 || supplementIds.length === 0) return;

        const consumedIds = new Set(supplementIds);
        const remaining: PendingGoalSupplementView[] = [];
        for (const pending of this.pendingGoalSupplementViews) {
            if (pending.supplementId && consumedIds.has(pending.supplementId)) {
                this.host.removeGoalManagedView(pending.view);
            } else {
                remaining.push(pending);
            }
        }
        this.pendingGoalSupplementViews = remaining;
    }

    private clearPendingGoalSupplementViews(): void {
        if (this.pendingGoalSupplementViews.length === 0) return;
        for (const pending of this.pendingGoalSupplementViews) {
            this.host.removeGoalManagedView(pending.view);
        }
        this.pendingGoalSupplementViews = [];
        this.host.markInvalidated();
    }

    removePendingGoalEditByGoalId(goalId: string): void {
        if (!this.pendingGoalEditView || this.pendingGoalEditView.goalId !== goalId) return;
        this.clearPendingGoalEditView();
    }

    reconcileUserMessage(message: unknown, chunk: TaskUpdateUserChunk): void {
        this.removePendingGoalSupplementViewsForIds(getGoalSupplementIds(message));
        const goalId = getGoalEditReminderId(chunk);
        if (goalId) this.removePendingGoalEditByGoalId(goalId);
    }

    private removeGoalPanelByKey(key: string): void {
        const view = this.goalPanelViews.get(key);
        if (!view) return;
        this.goalPanelViews.delete(key);
        this.host.removeGoalManagedView(view);
        this.host.markInvalidated();
    }

    removeLiveGoalPanel(goalId: string): void {
        this.removeGoalPanelByKey(`goal:${goalId}`);
    }

    private placeFinalGoalPanel(view: GoalPanel, snapshot: GoalFinalSnapshot): void {
        const anchorView = snapshot.anchorMessageId
            ? this.host.findMessageViewById(snapshot.anchorMessageId)
            : undefined;
        const finalizedAt = getGoalSnapshotTimestamp(snapshot);
        const firstLaterUserView =
            finalizedAt === undefined ? undefined : this.host.findFirstExternalUserMessageViewAfter(finalizedAt);

        this.host.placeGoalManagedView(view, {
            ...(anchorView ? { after: anchorView } : {}),
            ...(firstLaterUserView ? { before: firstLaterUserView } : {})
        });
    }

    syncFinalGoalSnapshot(snapshot: GoalFinalSnapshot): boolean {
        if (snapshot.status === 'cleared') return false;
        this.clearStalePendingGoalEdit();
        const key = snapshot.id || `goal-final:${snapshot.goalId}`;
        const data = getGoalPanelDataFromFinalSnapshot(snapshot);
        const existing = this.goalPanelViews.get(key);
        if (existing) {
            this.removeLiveGoalPanel(snapshot.goalId);
            existing.update(data);
            this.placeFinalGoalPanel(existing, snapshot);
            this.host.markInvalidated();
            return true;
        }

        const view = new GoalPanel({ showCleared: true, showTerminal: true, id: key });
        view.update(data);
        const liveKey = `goal:${snapshot.goalId}`;
        const liveView = this.goalPanelViews.get(liveKey);
        if (liveView) this.goalPanelViews.delete(liveKey);
        this.goalPanelViews.set(key, view);

        if (liveView) {
            this.host.replaceGoalManagedView(liveView, view);
        } else {
            this.host.appendGoalPanel(view);
        }
        this.placeFinalGoalPanel(view, snapshot);
        this.host.markInvalidated();
        return true;
    }

    private getFinalSnapshotForGoal(goalId: string): GoalFinalSnapshot | undefined {
        const snapshots = this.host.getTaskState()?.goal_final_snapshots;
        if (!Array.isArray(snapshots)) return undefined;
        for (let index = snapshots.length - 1; index >= 0; index -= 1) {
            const snapshot = snapshots[index];
            if (snapshot.goalId === goalId) return snapshot;
        }
        return undefined;
    }

    syncGoalPanel(data: GoalPanelData): boolean {
        const goal = data.goalState;
        if (!goal) return false;
        this.clearStalePendingGoalEdit();
        if (goal.status === 'cleared') {
            this.clearPendingGoalSupplementViews();
            this.removeLiveGoalPanel(goal.id);
            const snapshot = this.getFinalSnapshotForGoal(goal.id);
            if (snapshot) {
                const finalKey = snapshot.id || `goal-final:${snapshot.goalId}`;
                this.removeGoalPanelByKey(finalKey);
            }
            return true;
        }

        const snapshot = this.getFinalSnapshotForGoal(goal.id);
        const finalSnapshotKey = snapshot && (snapshot.id || `goal-final:${snapshot.goalId}`);
        if (
            snapshot &&
            (GoalStates.isTerminal(goal.status) || (finalSnapshotKey && this.goalPanelViews.has(finalSnapshotKey)))
        ) {
            return this.syncFinalGoalSnapshot(snapshot);
        }

        const key = `goal:${goal.id}`;
        const existing = this.goalPanelViews.get(key);
        if (existing) {
            existing.update(data);
            this.host.markInvalidated();
            this.ensureGoalPanelLast();
            return true;
        }

        const view = new GoalPanel({ showCleared: true, showTerminal: true, id: key });
        view.update(data);
        this.goalPanelViews.set(key, view);
        this.host.appendGoalPanel(view);
        this.host.markInvalidated();
        return true;
    }

    ensureGoalPanelLast(): void {
        if (this.goalPanelViews.size === 0) return;
        for (const panel of this.goalPanelViews.values()) {
            const goalState = panel.getGoalState();
            if (!goalState || GoalStates.isTerminal(goalState.status)) continue;
            this.host.moveGoalPanelToLayoutEnd(panel);
        }
    }

    syncGoalPanelForCurrentTask(): boolean {
        const task = this.host.getTaskState();
        const goalState = task?.goal_state;
        if (!task || !goalState) return false;
        return this.syncGoalPanel({
            goalState,
            totalTokens: getGoalTokenUsage(task),
            elapsedMs: getGoalElapsedMs(goalState)
        });
    }
}
