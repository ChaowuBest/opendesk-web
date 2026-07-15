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

import { escapeHtml } from '../../../common/utils/escape.js';
import { formatLocalDateTime, getGoalEvaluationDisplayTimestamp } from '../../../common/goal/format.js';
import {
    getGoalEvaluationDisplayKind,
    getLatestGoalEvaluationDisplay,
    normalizeGoalEvaluationDisplay
} from '../../../common/goal/evaluation-display.js';
import {
    getGoalSectionActionIds,
    getTaskTodoSnapshotKey,
    hasUnfinishedGoalStatus,
    isAttachedRunningGoalCreateResult,
    isTerminalGoalStatus,
    shouldAutoCollapseTerminalGoalDetails,
    shouldShowGoalSuggestion,
    type GoalActionId,
    type GoalRenderStatus,
    type GoalTodoSnapshotItem
} from './state.js';

export interface GoalRenderSummaryLike {
    id: string;
    status: GoalRenderStatus;
    revision: number;
    objective: string;
    pendingContinuation: boolean;
    updatedAt: string;
    completedAt?: string;
    successCriteria?: string[];
    attempts?: number;
    lastEvaluation?: {
        evaluationId?: string;
        goalId?: string;
        goalRevision?: number;
        status: string;
        reason: string;
        evidence?: string[];
        evaluatedAt: string;
    };
    evaluations?: GoalEvaluationLike[];
    recentEvents?: GoalObjectiveEventLike[];
    objectiveEvents?: GoalObjectiveEventLike[];
}

export interface GoalEvaluationLike {
    evaluationId?: string;
    goalId?: string;
    goalRevision?: number;
    phase: 'start' | 'end';
    status?: string;
    message?: string;
    evidence?: string[];
    startedAt?: string;
    evaluatedAt?: string;
    updatedAt?: string;
}

export type GoalEvalProgressLike = GoalEvaluationLike;

interface GoalObjectiveEventLike {
    type: string;
    revision: number;
    timestamp: string;
    source: string;
    objective?: string;
    previousObjective?: string;
    displayMessageId?: string;
}

interface GoalDisclosureState {
    evaluationOpen: boolean;
    timelineOpen: boolean;
    autoCollapsedAfterTodoUpdate: boolean;
}

type GoalDisplayEvent = {
    type?: string;
    revision?: number;
    displayMessageId?: string;
};

type GoalTranslate = (key: string, params?: Record<string, string | number>) => string;

export interface TaskArtifactsGoalHost {
    element: HTMLElement;
    getShadowRoot(): ShadowRoot | null;
    getTaskId(): string;
    isTaskRunning(): boolean;
    switchToTaskPlan(): void;
    syncTaskPlanVisibility(): void;
    renderTaskPlanPanel(options?: { autoCollapseCurrentGoalDetails?: boolean }): void;
    translate: GoalTranslate;
}

function getLatestGoalDisplayMessageEvent(
    goal: GoalRenderSummaryLike | null | undefined,
    type: 'create' | 'edit'
): GoalDisplayEvent | undefined {
    const events =
        goal?.objectiveEvents && goal.objectiveEvents.length > 0 ? goal.objectiveEvents : (goal?.recentEvents ?? []);
    const expectedType = type === 'create' ? 'created' : 'edited';
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!event || event.type !== expectedType) {
            continue;
        }
        const messageId = event.displayMessageId;
        if (typeof messageId === 'string' && messageId.length > 0 && typeof event.revision === 'number') {
            return { type: event.type, revision: event.revision, displayMessageId: messageId };
        }
    }
    return undefined;
}

function dispatchPendingGoalEvent(
    taskId: string,
    type: 'create' | 'edit',
    objective: string,
    goalId: string | undefined,
    goalRevision: number | undefined,
    source: 'goal_editor' = 'goal_editor'
): void {
    if (typeof document === 'undefined' || typeof goalId !== 'string' || goalId.length === 0) return;
    document.dispatchEvent(
        new CustomEvent('goal-pending', {
            detail: {
                taskId,
                type,
                objective,
                goalId,
                goalRevision,
                source
            }
        })
    );
}

export class TaskArtifactsGoalController {
    private _goalState: GoalRenderSummaryLike | null = null;
    private _goalEvalProgress: GoalEvalProgressLike | null = null;
    private _goalEditing = false;
    private _goalEditPending = false;
    private _goalDisclosureByGoalId = new Map<string, GoalDisclosureState>();
    private _taskTodoSnapshotKey: string | null = null;
    private _taskTodoCount = 0;
    /** 是否正在显示 goal 创建表单 */
    private _goalCreating = false;
    private _goalCreationObjectiveDraft = '';
    private _goalSuggestionDismissed = false;

    constructor(private readonly _host: TaskArtifactsGoalHost) {}

    connect(): void {
        const shadowRoot = this._host.getShadowRoot();
        shadowRoot?.addEventListener('click', this._onGoalSectionClick as EventListener);
        shadowRoot?.addEventListener('keydown', this._onGoalTimelineKeydown as EventListener);
        shadowRoot?.addEventListener('input', this._onGoalInput as EventListener);
    }

    disconnect(): void {
        const shadowRoot = this._host.getShadowRoot();
        shadowRoot?.removeEventListener('click', this._onGoalSectionClick as EventListener);
        shadowRoot?.removeEventListener('keydown', this._onGoalTimelineKeydown as EventListener);
        shadowRoot?.removeEventListener('input', this._onGoalInput as EventListener);
    }

    updateTaskTodos(
        todos: GoalTodoSnapshotItem[] | null | undefined,
        source: 'refresh' | 'live-update' = 'refresh'
    ): { autoCollapseCurrentGoalDetails: boolean } {
        const hadTodos = this._taskTodoCount > 0;
        const nextTodos = Array.isArray(todos) ? todos : [];
        const nextTodoSnapshotKey = getTaskTodoSnapshotKey(nextTodos);
        const currentGoalId = this._goalState?.id ?? null;
        const autoCollapseCurrentGoalDetails = shouldAutoCollapseTerminalGoalDetails({
            goalId: currentGoalId,
            goalStatus: this._goalState?.status,
            previousTodoSnapshotKey: this._taskTodoSnapshotKey,
            nextTodoSnapshotKey,
            collapseAlreadyApplied: currentGoalId
                ? (this._goalDisclosureByGoalId.get(currentGoalId)?.autoCollapsedAfterTodoUpdate ?? false)
                : false,
            source
        });
        this._taskTodoCount = nextTodos.length;
        this._taskTodoSnapshotKey = nextTodoSnapshotKey;
        if (this._taskTodoCount === 0) {
            this._goalSuggestionDismissed = false;
        }
        if (!hadTodos && this.hasGoalSuggestion()) {
            this._host.switchToTaskPlan();
        }
        return { autoCollapseCurrentGoalDetails };
    }

    setGoalState(goal: GoalRenderSummaryLike | null | undefined): void {
        const hadGoal = this._goalState !== null;
        const hadGoalSuggestion = this.hasGoalSuggestion();
        const previousGoalId = this._goalState?.id;
        const previousGoalRevision = this._goalState?.revision;
        const wasEditing = this._goalEditing;
        this._goalState = goal ?? null;
        if (!this._goalState || previousGoalId !== this._goalState.id || this._isTerminalGoal(this._goalState)) {
            this._goalEvalProgress = null;
        } else if (this._goalEvalProgress) {
            const goalRevisionChanged =
                typeof previousGoalRevision === 'number' &&
                typeof this._goalState.revision === 'number' &&
                previousGoalRevision !== this._goalState.revision;
            if (
                goalRevisionChanged &&
                this._goalEvalProgress.phase === 'start' &&
                typeof this._goalEvalProgress.goalRevision === 'number' &&
                this._goalEvalProgress.goalRevision < this._goalState.revision
            ) {
                this._goalEvalProgress = {
                    ...this._goalEvalProgress,
                    phase: 'end',
                    status: 'superseded',
                    message: this._t('goal.eval.superseded_by_edit'),
                    updatedAt: this._goalState.updatedAt
                };
            }
            const progressEvaluationId = this._goalEvalProgress.evaluationId;
            const persistedProgress =
                progressEvaluationId &&
                this._goalState.evaluations?.some(
                    (evaluation) => evaluation.evaluationId === progressEvaluationId && evaluation.phase === 'end'
                );
            if (persistedProgress || (!progressEvaluationId && this._goalState.lastEvaluation)) {
                this._goalEvalProgress = null;
            }
        }
        if (this._goalState && previousGoalId !== this._goalState.id) {
            this._getGoalDisclosureState(this._goalState.id);
        }
        if (this._goalState && !this._isTerminalGoal(this._goalState)) {
            this._goalCreating = false;
            this._goalCreationObjectiveDraft = '';
        }
        // 无 goal 或终态（complete/cleared）时关闭编辑模式；
        // 终态下不再自动移除面板，保留显示当前状态。
        if (!this._goalState || this._isTerminalGoal(this._goalState)) {
            this._goalEditing = false;
        }
        this._host.syncTaskPlanVisibility();
        if ((!hadGoal && this._goalState) || (!hadGoalSuggestion && this.hasGoalSuggestion())) {
            this._host.switchToTaskPlan();
        }
        const keepEditingDom =
            wasEditing &&
            this._goalEditing &&
            this._goalState !== null &&
            previousGoalId === this._goalState.id &&
            !this._isTerminalGoal(this._goalState);
        const keepCreatingDom = this._goalCreating && !hasUnfinishedGoalStatus(this._goalState?.status);
        if (!keepEditingDom && !keepCreatingDom) {
            this._host.renderTaskPlanPanel();
        }
    }

    setGoalEditPending(pending: boolean): void {
        const nextPending = pending === true;
        if (this._goalEditPending === nextPending) return;
        this._goalEditPending = nextPending;
        if (nextPending) {
            this._goalEditing = false;
        }
        this._host.renderTaskPlanPanel();
    }

    setGoalEvalProgress(progress: GoalEvalProgressLike | null | undefined): void {
        this._goalEvalProgress = progress
            ? {
                  ...progress,
                  ...(Array.isArray(progress.evidence) ? { evidence: [...progress.evidence] } : {})
              }
            : null;
        if (this._goalState) {
            // 评估开始时自动展开评估堆栈
            if (progress?.phase === 'start') {
                this._setGoalDisclosureState(this._goalState.id, { evaluationOpen: true });
            }
            this._host.switchToTaskPlan();
        }
        if (this.shouldPreserveEditorDom()) {
            this._renderGoalEvaluationStack();
        } else {
            this._host.renderTaskPlanPanel();
        }
    }

    /**
     * 打开 goal 创建表单（由外部“创建目标”按钮触发）。
     */
    showGoalCreationForm(): void {
        if (this._goalState && !this._isTerminalGoal(this._goalState)) {
            window.alert(this._t('goal.create.requires_clear'));
            this._host.switchToTaskPlan();
            return;
        }
        this._goalCreating = true;
        this._goalEditing = false;
        this._goalCreationObjectiveDraft = '';
        this._host.syncTaskPlanVisibility();
        this._host.switchToTaskPlan();
        this._host.renderTaskPlanPanel();
    }

    hasGoalSuggestion(): boolean {
        return shouldShowGoalSuggestion({
            todoCount: this._taskTodoCount,
            goalStatus: this._goalState?.status,
            goalCreating: this._goalCreating,
            dismissed: this._goalSuggestionDismissed
        });
    }

    hasGoalContent(): boolean {
        return this._goalState !== null || this._goalCreating;
    }

    shouldPreserveEditorDom(): boolean {
        return (
            this._goalCreating ||
            (this._goalEditing && this._goalState !== null && !this._isTerminalGoal(this._goalState))
        );
    }

    prepareTaskPlanRender(panel: HTMLElement, autoCollapseCurrentGoalDetails = false): void {
        this._rememberGoalTimelineState(panel);
        this._rememberGoalEvalState(panel);
        if (autoCollapseCurrentGoalDetails && this._goalState) {
            this._setGoalDisclosureState(this._goalState.id, {
                evaluationOpen: false,
                timelineOpen: false,
                autoCollapsedAfterTodoUpdate: true
            });
        }
    }

    renderTaskPlanContent(): string {
        const showGoalCreation = this._goalCreating && !hasUnfinishedGoalStatus(this._goalState?.status);
        const suggestionHtml = this.hasGoalSuggestion() ? this._renderGoalSuggestion() : '';
        const goalHtml = showGoalCreation
            ? this._renderGoalCreationForm()
            : this._goalState
              ? this._renderGoalSection(this._goalState)
              : '';
        return `${suggestionHtml}${goalHtml}`;
    }

    private _t(key: string, params?: Record<string, string | number>): string {
        return this._host.translate(key, params);
    }

    private _isTerminalGoal(goal: GoalRenderSummaryLike): boolean {
        return isTerminalGoalStatus(goal.status);
    }

    private _getGoalEditUnavailableMessage(): string | null {
        if (this._goalEditPending) {
            return this._t('goal.renderer.edit_unavailable_pending');
        }
        if (!this._goalState || this._isTerminalGoal(this._goalState)) {
            return this._t('goal.renderer.edit_unavailable_status');
        }
        return null;
    }

    private _renderGoalSuggestion(): string {
        return `
        <section class="goal-suggestion-section">
            <div class="goal-suggestion-copy">
                <i class="fa-solid fa-bullseye"></i>
                <span>${escapeHtml(this._t('goal.renderer.suggestion'))}</span>
            </div>
            <div class="goal-suggestion-actions">
                <button type="button" class="goal-action-btn goal-action-primary" data-goal-action="suggest-create">${escapeHtml(this._t('goal.renderer.suggestion.accept'))}</button>
                <button type="button" class="goal-action-btn" data-goal-action="suggest-dismiss">${escapeHtml(this._t('goal.renderer.suggestion.dismiss'))}</button>
            </div>
        </section>`;
    }

    private _getGoalDisclosureState(goalId: string): GoalDisclosureState {
        let state = this._goalDisclosureByGoalId.get(goalId);
        if (!state) {
            state = {
                evaluationOpen: true,
                timelineOpen: true,
                autoCollapsedAfterTodoUpdate: false
            };
            this._goalDisclosureByGoalId.set(goalId, state);
        }
        return state;
    }

    private _setGoalDisclosureState(goalId: string, patch: Partial<GoalDisclosureState>): void {
        const current = this._getGoalDisclosureState(goalId);
        this._goalDisclosureByGoalId.set(goalId, { ...current, ...patch });
    }

    private _rememberGoalTimelineState(panel?: HTMLElement): void {
        const container =
            panel ?? this._host.getShadowRoot()?.querySelector<HTMLElement>('.tab-content[data-tab="task-plan"]');
        const timeline = container?.querySelector<HTMLDetailsElement>('details.goal-timeline');
        const goalId = timeline?.closest<HTMLElement>('[data-goal-id]')?.dataset.goalId;
        if (timeline && goalId) {
            this._setGoalDisclosureState(goalId, { timelineOpen: timeline.hasAttribute('open') });
        }
    }

    private _rememberGoalEvalState(panel?: HTMLElement): void {
        const container =
            panel ?? this._host.getShadowRoot()?.querySelector<HTMLElement>('.tab-content[data-tab="task-plan"]');
        const evalDetails = container?.querySelector<HTMLDetailsElement>('details.goal-eval-stack');
        const goalId = evalDetails?.closest<HTMLElement>('[data-goal-id]')?.dataset.goalId;
        if (evalDetails && goalId) {
            this._setGoalDisclosureState(goalId, { evaluationOpen: evalDetails.hasAttribute('open') });
        }
    }

    private _formatGoalLabel(prefix: string, value: string): string {
        const key = `${prefix}.${value}`;
        const label = this._t(key);
        return label === key ? value : label;
    }

    private _formatGoalEvalStatus(status?: string): string {
        if (!status) return this._t('goal.eval.status.unknown');
        return this._formatGoalLabel('goal.label.evaluation', status);
    }

    private _renderGoalEvalEvidence(evidence?: string[]): string {
        const visibleEvidence = Array.isArray(evidence)
            ? evidence.filter((item) => typeof item === 'string' && item.trim().length > 0)
            : [];
        if (visibleEvidence.length === 0) return '';
        return `<div class="goal-evaluation-evidence">
            <div class="goal-evaluation-evidence-title">${escapeHtml(this._t('goal.eval.evidence'))}</div>
            <ul>${visibleEvidence.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </div>`;
    }

    private _renderGoalEvalProgressCard(): string {
        const progress = this._goalEvalProgress;
        if (!progress) return '';
        return this._renderGoalEvaluationCard(normalizeGoalEvaluationDisplay(progress), 'live');
    }

    private _renderGoalEvaluationMeta(evaluation: GoalEvaluationLike): string {
        const metaItems: string[] = [];
        if (typeof evaluation.goalRevision === 'number') {
            metaItems.push(this._t('goal.label.revision', { revision: evaluation.goalRevision }));
        }
        const timestamp = getGoalEvaluationDisplayTimestamp(evaluation);
        if (timestamp) {
            metaItems.push(formatLocalDateTime(timestamp));
        }
        return metaItems.length > 0
            ? `<div class="goal-evaluation-title" style="font-weight:400;color:#6b7280;">${escapeHtml(metaItems.join(' · '))}</div>`
            : '';
    }

    private _renderGoalEvaluationCard(evaluation: GoalEvaluationLike, kind: 'live' | 'result'): string {
        const normalized = normalizeGoalEvaluationDisplay(evaluation);
        const phase = normalized.phase;
        const status = normalized.status;
        const statusLabel = this._formatGoalEvalStatus(status);
        const title =
            phase === 'start'
                ? this._t('goal.eval.running')
                : this._t('goal.eval.result_title', { status: statusLabel });
        const message = normalized.message;
        const kindInfo = getGoalEvaluationDisplayKind(normalized);
        const icon =
            kindInfo === 'running'
                ? 'fa-circle-notch fa-spin'
                : kindInfo === 'success'
                  ? 'fa-circle-check'
                  : kindInfo === 'danger'
                    ? 'fa-triangle-exclamation'
                    : 'fa-circle-info';
        return `<div class="goal-evaluation goal-evaluation-${kind} goal-evaluation-${escapeHtml(status || 'running')}">
            <div class="goal-evaluation-title">
                <i class="fa-solid ${icon}" aria-hidden="true"></i>
                <span>${escapeHtml(title)}</span>
            </div>
            ${this._renderGoalEvaluationMeta(normalized)}
            ${message ? `<div>${escapeHtml(message)}</div>` : ''}
            ${this._renderGoalEvalEvidence(normalized.evidence)}
        </div>`;
    }

    private _renderGoalLatestEvaluationCard(goal: GoalRenderSummaryLike): string {
        const latestEvaluation = getLatestGoalEvaluationDisplay(goal);
        if (latestEvaluation) {
            return this._renderGoalEvaluationCard(latestEvaluation, 'result');
        }
        return '';
    }

    private _renderGoalEvaluationStackContent(goal: GoalRenderSummaryLike): string {
        return this._renderGoalEvalProgressCard() || this._renderGoalLatestEvaluationCard(goal);
    }

    private _renderGoalEvaluationStack(): void {
        if (!this._goalState) return;
        const stack = this._host.getShadowRoot()?.querySelector<HTMLElement>('.goal-evaluation-stack');
        if (!stack) {
            this._host.renderTaskPlanPanel();
            return;
        }
        stack.innerHTML = this._renderGoalEvaluationStackContent(this._goalState);
    }

    private _renderGoalCreationForm(): string {
        return `
        <section class="goal-creation-section">
            <div class="goal-creation-header">
                <i class="fa-solid fa-bullseye" style="color:#7C4DFF;font-size:14px;"></i>
                <div>
                    <div style="font-weight:500;font-size:13px;color:var(--color-text-primary)">${escapeHtml(this._t('goal.renderer.followup_create_title'))}</div>
                    <div class="goal-creation-subtitle">${escapeHtml(this._t('goal.renderer.followup_create_description'))}</div>
                </div>
            </div>
            <div class="goal-creation-body">
                <div class="goal-form-group">
                    <label class="goal-form-label">${escapeHtml(this._t('goal.renderer.objective_label'))}</label>
                    <textarea
                        class="goal-form-textarea"
                        data-goal-creation-input="objective"
                        placeholder="${escapeHtml(this._t('goal.renderer.followup_placeholder'))}"
                        rows="3"
                    >${escapeHtml(this._goalCreationObjectiveDraft)}</textarea>
                </div>
            </div>
            <div class="goal-creation-footer">
                <button type="button" class="goal-action-btn" data-goal-action="creation-cancel">${escapeHtml(this._t('common.cancel'))}</button>
                <button type="button" class="goal-action-btn goal-action-primary" data-goal-action="creation-create">${escapeHtml(this._t('goal.renderer.start_followup'))}</button>
            </div>
        </section>`;
    }

    private _renderGoalSection(goal: GoalRenderSummaryLike): string {
        const actionLabels: Record<GoalActionId, string> = {
            'edit-start': this._t('goal.renderer.edit'),
            pause: this._t('goal.renderer.pause'),
            resume: this._t('goal.renderer.resume'),
            'create-new': this._t('goal.renderer.create'),
            clear: this._t('goal.renderer.clear')
        };
        const actions = getGoalSectionActionIds(goal.status).map((id) => ({ id, label: actionLabels[id] }));
        const attemptsText = typeof goal.attempts === 'number' ? String(goal.attempts) : '-';
        const disclosureState = this._getGoalDisclosureState(goal.id);
        const criteriaHtml =
            goal.successCriteria && goal.successCriteria.length > 0
                ? `<div class="goal-criteria">${goal.successCriteria
                      .map((criterion) => `<span class="goal-chip">${escapeHtml(criterion)}</span>`)
                      .join('')}</div>`
                : '';
        const evaluationStackContent = this._renderGoalEvaluationStackContent(goal);
        const evaluationHtml = evaluationStackContent
            ? `<details class="goal-eval-stack"${disclosureState.evaluationOpen ? ' open' : ''}>
                <summary>${escapeHtml(this._t('goal.panel.latest_evaluation'))}</summary>
                <div class="goal-evaluation-stack">${evaluationStackContent}</div>
            </details>`
            : '';
        const timelineEvents =
            goal.objectiveEvents && goal.objectiveEvents.length > 0 ? goal.objectiveEvents : (goal.recentEvents ?? []);
        const timelineHtml =
            timelineEvents.length > 0
                ? `<details class="goal-timeline"${disclosureState.timelineOpen ? ' open' : ''}>
                    <summary>${escapeHtml(this._t('goal.renderer.timeline'))}</summary>
                    <div class="goal-timeline-list">${timelineEvents
                        .map((event) => {
                            const eventLabel = this._formatGoalLabel('goal.label.event', event.type);
                            const eventRevision = this._t('goal.label.revision', { revision: event.revision });
                            const objectiveLabel = this._t('goal.renderer.timeline.objective');
                            const previousLabel = this._t('goal.renderer.timeline.previous');
                            const noObjective = this._t('goal.renderer.timeline.no_objective');
                            const objectiveText = event.objective ?? '';
                            const previousText = event.previousObjective ?? '';
                            const displayMessageId =
                                typeof event.displayMessageId === 'string' ? event.displayMessageId : '';
                            const hasObjective = objectiveText.length > 0;
                            const hasPrevious = previousText.length > 0;
                            const isAnchored = displayMessageId.length > 0;
                            const anchorAttrs = isAnchored
                                ? ` role="button" tabindex="0" data-goal-message-id="${escapeHtml(displayMessageId)}"`
                                : '';
                            const anchorClass = isAnchored ? ' goal-timeline-anchor' : '';
                            const anchorIcon = isAnchored
                                ? '<i class="fa-solid fa-location-dot goal-timeline-anchor-icon" aria-hidden="true"></i>'
                                : '';
                            const objectiveBlock = hasObjective
                                ? `<div class="goal-timeline-objective">
                                    <span class="goal-timeline-objective-label">${escapeHtml(objectiveLabel)}</span>
                                    <span class="goal-timeline-objective-text">${escapeHtml(objectiveText)}</span>
                                </div>`
                                : '';
                            const previousBlock = hasPrevious
                                ? `<div class="goal-timeline-objective goal-timeline-previous">
                                    <span class="goal-timeline-objective-label">${escapeHtml(previousLabel)}</span>
                                    <span class="goal-timeline-objective-text">${escapeHtml(previousText)}</span>
                                </div>`
                                : '';
                            const emptyHint =
                                !hasObjective && !hasPrevious
                                    ? `<div class="goal-timeline-objective goal-timeline-empty">${escapeHtml(noObjective)}</div>`
                                    : '';
                            return `<div class="goal-timeline-item${anchorClass}"${anchorAttrs}>
                                <div class="goal-timeline-head">
                                    <span class="goal-timeline-type">${escapeHtml(eventLabel)}</span>
                                    <span class="goal-timeline-revision">${escapeHtml(eventRevision)}</span>
                                    <span class="goal-timeline-time">${escapeHtml(formatLocalDateTime(event.timestamp))}</span>
                                    ${anchorIcon}
                                </div>
                                ${objectiveBlock}${previousBlock}${emptyHint}
                            </div>`;
                        })
                        .join('')}</div>
                </details>`
                : '';
        const editUnavailableMessage = this._getGoalEditUnavailableMessage();
        const objectiveHtml = this._goalEditing
            ? `<div class="goal-objective-editor">
                <label class="goal-form-label">${escapeHtml(this._t('goal.renderer.objective_label'))}</label>
                <textarea class="goal-objective-input" data-goal-edit-input="1">${escapeHtml(goal.objective || '')}</textarea>
                <div class="goal-editor-actions">
                    <button type="button" class="goal-action-btn" data-goal-action="edit-cancel">${escapeHtml(this._t('common.cancel'))}</button>
                    <button type="button" class="goal-action-btn" data-goal-action="edit-save"${this._goalEditPending ? ' disabled' : ''}>${escapeHtml(this._t('goal.renderer.save'))}</button>
                </div>
            </div>`
            : `<button type="button" class="goal-objective" data-goal-action="edit-start"${editUnavailableMessage ? ' aria-disabled="true"' : ''}>${escapeHtml(goal.objective || '')}</button>`;
        const statusLabel = this._formatGoalLabel('goal.label.status', goal.status);
        const revisionLabel = this._t('goal.label.revision', { revision: goal.revision });
        return `
        <section class="goal-section" data-goal-id="${escapeHtml(goal.id)}">
            <div class="goal-header">
                <div class="goal-title">
                    <span>${escapeHtml(this._t('goal.renderer.followup_title'))}</span>
                    <span class="goal-badge goal-${escapeHtml(goal.status)}">${escapeHtml(statusLabel)} · ${escapeHtml(revisionLabel)}</span>
                </div>
                <div class="goal-actions">
                    ${actions
                        .map(
                            (action) =>
                                `<button type="button" class="goal-action-btn" data-goal-action="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`
                        )
                        .join('')}
                </div>
            </div>
            ${objectiveHtml}
            <div class="goal-progress">
                <div class="goal-progress-row">
                    <span>${escapeHtml(this._t('goal.renderer.attempts'))}</span>
                    <span>${escapeHtml(attemptsText)}</span>
                </div>
            </div>
            ${criteriaHtml}
            ${evaluationHtml}
            ${
                goal.pendingContinuation
                    ? `<div class="goal-continuation">${escapeHtml(this._t('goal.renderer.continuation_pending'))}</div>`
                    : ''
            }
            ${timelineHtml}
        </section>`;
    }

    private _emitGoalTimelineAnchor(anchor: Element): void {
        const messageId = anchor.getAttribute('data-goal-message-id') || '';
        if (!messageId) return;
        this._host.element.dispatchEvent(
            new CustomEvent('goal-message-anchor', {
                bubbles: true,
                composed: true,
                detail: { messageId }
            })
        );
    }

    private _onGoalTimelineKeydown = (event: KeyboardEvent): void => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const anchor = event.target instanceof Element ? event.target.closest('[data-goal-message-id]') : null;
        if (!anchor || !this._host.getShadowRoot()?.contains(anchor)) return;
        event.preventDefault();
        this._emitGoalTimelineAnchor(anchor);
    };

    private _onGoalInput = (event: Event): void => {
        const target = event.target;
        if (target instanceof HTMLTextAreaElement && target.getAttribute('data-goal-creation-input') === 'objective') {
            this._goalCreationObjectiveDraft = target.value;
        }
    };

    private _onGoalSectionClick = async (event: Event): Promise<void> => {
        const shadowRoot = this._host.getShadowRoot();
        const anchor = event.target instanceof Element ? event.target.closest('[data-goal-message-id]') : null;
        if (anchor && shadowRoot?.contains(anchor)) {
            event.preventDefault();
            this._emitGoalTimelineAnchor(anchor);
            return;
        }

        const target = event.target instanceof Element ? event.target.closest('[data-goal-action]') : null;
        if (!target || !shadowRoot?.contains(target)) return;
        event.preventDefault();
        const action = target.getAttribute('data-goal-action');
        const taskId = this._host.getTaskId();
        if (!action || !taskId) return;

        const button = target instanceof HTMLButtonElement ? target : undefined;
        if (button) button.disabled = true;
        try {
            let result: any;
            if (action === 'suggest-create' || action === 'create-new') {
                this._goalCreating = true;
                this._goalEditing = false;
                this._goalCreationObjectiveDraft = '';
                this._goalSuggestionDismissed = false;
                this._host.renderTaskPlanPanel();
                return;
            } else if (action === 'suggest-dismiss') {
                this._goalSuggestionDismissed = true;
                this._host.renderTaskPlanPanel();
                return;
            } else if (action === 'creation-cancel') {
                this._goalCreating = false;
                this._goalCreationObjectiveDraft = '';
                this._host.syncTaskPlanVisibility();
                this._host.renderTaskPlanPanel();
                return;
            } else if (action === 'creation-create') {
                const objectiveInput = shadowRoot?.querySelector<HTMLTextAreaElement>(
                    '[data-goal-creation-input="objective"]'
                );
                const rawObjective = objectiveInput?.value ?? this._goalCreationObjectiveDraft;
                this._goalCreationObjectiveDraft = rawObjective;
                const objective = rawObjective.trim();
                if (!objective) {
                    window.alert(this._t('goal.renderer.empty_objective'));
                    if (button) button.disabled = false;
                    return;
                }
                try {
                    const createResult = await (window as any).taskManagerAPI.createGoal(taskId, objective);
                    if (createResult?.ok === false) {
                        if (isAttachedRunningGoalCreateResult(createResult)) {
                            this._goalState = createResult.summary;
                            this._goalCreating = false;
                            this._goalCreationObjectiveDraft = '';
                            this._goalSuggestionDismissed = false;
                            this._host.renderTaskPlanPanel();
                            this._dispatchGoalStateChanged();
                            return;
                        }
                        window.alert(
                            this._t(createResult.messageKey || 'goal.error.unknown', createResult.messageArgs || {})
                        );
                        if (button) button.disabled = false;
                        return;
                    }
                    const createEvent =
                        createResult?.summary && typeof createResult.summary.id === 'string'
                            ? getLatestGoalDisplayMessageEvent(createResult.summary, 'create')
                            : undefined;
                    const hasValidCreateEvent =
                        createResult?.startedScheduler !== true &&
                        Boolean(createEvent) &&
                        createResult?.summary?.revision === createEvent?.revision &&
                        createResult?.summary?.status === 'active';
                    if (this._host.isTaskRunning() && hasValidCreateEvent) {
                        dispatchPendingGoalEvent(
                            taskId,
                            'create',
                            objective,
                            createResult.summary.id,
                            createEvent?.revision
                        );
                    }
                    this._goalCreating = false;
                    this._goalCreationObjectiveDraft = '';
                    this._goalSuggestionDismissed = false;
                    // 触发 goal 状态刷新
                    this._dispatchGoalStateChanged();
                    return;
                } catch (error: any) {
                    const message = error?.message || String(error);
                    window.alert(this._t('goal.renderer.action_failed', { message }));
                    if (button) button.disabled = false;
                    return;
                }
            } else if (action === 'edit-start') {
                const editUnavailableMessage = this._getGoalEditUnavailableMessage();
                if (editUnavailableMessage) {
                    window.alert(editUnavailableMessage);
                    return;
                }
                this._goalEditing = true;
                this._host.renderTaskPlanPanel();
                return;
            } else if (action === 'edit-cancel') {
                this._goalEditing = false;
                this._host.renderTaskPlanPanel();
                return;
            } else if (action === 'edit-save') {
                const editUnavailableMessage = this._getGoalEditUnavailableMessage();
                if (editUnavailableMessage) {
                    window.alert(editUnavailableMessage);
                    return;
                }
                const currentObjective = this._goalState?.objective || '';
                const input = shadowRoot?.querySelector<HTMLTextAreaElement>('[data-goal-edit-input="1"]');
                const trimmedObjective = input?.value.trim() ?? '';
                if (!trimmedObjective) {
                    window.alert(this._t('goal.renderer.empty_objective'));
                    return;
                }
                const objectiveChanged = trimmedObjective !== currentObjective.trim();
                if (!objectiveChanged) {
                    this._goalEditing = false;
                    this._host.renderTaskPlanPanel();
                    return;
                }
                result = await (window as any).taskManagerAPI.editGoal(taskId, trimmedObjective);
            } else if (action === 'pause') {
                result = await (window as any).taskManagerAPI.pauseGoal(taskId);
            } else if (action === 'resume') {
                result = await (window as any).taskManagerAPI.resumeGoal(taskId);
            } else if (action === 'clear') {
                result = await (window as any).taskManagerAPI.clearGoal(taskId);
            }

            if (result?.ok === false) {
                window.alert(this._t(result.messageKey || 'goal.error.unknown', result.messageArgs || {}));
                return;
            }
            if (result?.summary) {
                // 终态（含 cleared）也保留显示，不再置 null
                this._goalState = result.summary;
                this._goalEditing = false;
                this._host.syncTaskPlanVisibility();
                this._host.renderTaskPlanPanel();
                if (action === 'edit-save' && this._host.isTaskRunning() && result.summary.status === 'active') {
                    const trimmedObjective = result.summary.objective;
                    const editEvent =
                        result.summary && typeof result.summary.id === 'string'
                            ? getLatestGoalDisplayMessageEvent(result.summary, 'edit')
                            : undefined;
                    if (result.startedScheduler !== true) {
                        dispatchPendingGoalEvent(
                            taskId,
                            'edit',
                            trimmedObjective,
                            result.summary.id,
                            editEvent?.revision ?? result.summary.revision
                        );
                    }
                }
            }
            this._dispatchGoalStateChanged();
            if (action === 'edit-save' && result?.summary) {
                const messageId = getLatestGoalDisplayMessageEvent(result.summary, 'edit')?.displayMessageId ?? '';
                if (messageId) {
                    this._host.element.dispatchEvent(
                        new CustomEvent('goal-message-anchor', {
                            bubbles: true,
                            composed: true,
                            detail: { messageId }
                        })
                    );
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            window.alert(this._t('goal.renderer.action_failed', { message }));
        } finally {
            if (button) button.disabled = false;
        }
    };

    private _dispatchGoalStateChanged(): void {
        this._host.element.dispatchEvent(new CustomEvent('goal-state-changed', { bubbles: true, composed: true }));
    }
}

export function getTaskArtifactsGoalCSS(): string {
    return `
            .goal-section {
                border-top: 1px solid #e5e7eb;
                margin: 0 12px;
                padding: 12px 0;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .goal-header {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 8px;
            }

            .goal-title {
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: 0;
                font-size: 13px;
                font-weight: 600;
                color: #1f2937;
            }

            .goal-badge {
                border: 1px solid #b4b2a9;
                border-radius: 999px;
                padding: 1px 6px;
                font-size: 11px;
                font-weight: 500;
                color: #5f5e5a;
                background: #f1efe8;
                white-space: nowrap;
            }

            .goal-active,
            .goal-complete {
                color: #3b6d11;
                background: #eaf3de;
                border-color: #97c459;
            }

            .goal-paused {
                color: #854f0b;
                background: #faeeda;
                border-color: #fac775;
            }

            .goal-blocked {
                color: #a32d2d;
                background: #fcebeb;
                border-color: #f09595;
            }

            .goal-actions {
                display: flex;
                flex-wrap: wrap;
                justify-content: flex-end;
                gap: 6px;
            }

            .goal-action-btn {
                border: 1px solid #d1d5db;
                background: #fff;
                color: #374151;
                border-radius: 4px;
                padding: 3px 7px;
                font-size: 11px;
                line-height: 1.3;
                cursor: pointer;
            }

            .goal-action-btn:hover {
                background: #f9fafb;
            }

            .goal-action-btn:disabled {
                opacity: 0.55;
                cursor: default;
            }

            .goal-objective {
                display: block;
                width: 100%;
                border: 0;
                background: transparent;
                color: #4b5563;
                font-size: 12px;
                line-height: 1.5;
                padding: 0;
                text-align: left;
                white-space: pre-wrap;
                cursor: pointer;
            }

            .goal-objective[aria-disabled="true"] {
                opacity: 0.72;
                cursor: not-allowed;
            }

            .goal-objective-editor {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }

            .goal-objective-input {
                width: 100%;
                min-height: 72px;
                resize: vertical;
                border: 1px solid #d1d5db;
                border-radius: 4px;
                padding: 6px 8px;
                font-size: 12px;
                line-height: 1.5;
                color: #374151;
                background: #fff;
                box-sizing: border-box;
            }

            .goal-editor-actions {
                display: flex;
                justify-content: flex-end;
                gap: 6px;
            }

            .goal-progress {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }

            .goal-progress-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                font-size: 11px;
                color: #6b7280;
            }

            .goal-suggestion-section {
                border-top: 1px solid #e5e7eb;
                margin: 0 12px;
                padding: 12px 0;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
            }

            .goal-suggestion-copy {
                display: flex;
                align-items: flex-start;
                gap: 8px;
                min-width: 0;
                color: #4b5563;
                font-size: 12px;
                line-height: 1.5;
            }

            .goal-suggestion-copy i {
                flex: none;
                margin-top: 2px;
                color: #7C4DFF;
                font-size: 12px;
            }

            .goal-suggestion-actions {
                display: flex;
                flex: none;
                align-items: center;
                gap: 6px;
            }

            /* ── Goal 创建表单 ───────────────────────────────────── */
            .goal-creation-section {
                margin: 0 12px;
                padding: 12px 0;
                border-top: 1px solid #e5e7eb;
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .goal-creation-header {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 13px;
                font-weight: 500;
                color: #1f2937;
            }
            .goal-creation-subtitle {
                margin-top: 2px;
                font-size: 12px;
                line-height: 1.4;
                font-weight: 400;
                color: #6b7280;
            }
            .goal-creation-body {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .goal-form-group {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .goal-form-label {
                font-size: 12px;
                font-weight: 500;
                color: #374151;
            }
            .goal-form-hint {
                font-weight: 400;
                color: #9ca3af;
            }
            .goal-form-textarea {
                width: 100%;
                min-height: 72px;
                resize: vertical;
                border: 1px solid #d1d5db;
                border-radius: 6px;
                padding: 8px 10px;
                font-size: 13px;
                line-height: 1.5;
                color: #374151;
                background: #fff;
                box-sizing: border-box;
                font-family: inherit;
            }
            .goal-form-textarea:focus {
                outline: none;
                border-color: #7C4DFF;
                box-shadow: 0 0 0 2px rgba(124,77,255,0.15);
            }
            .goal-form-input {
                width: 100%;
                border: 1px solid #d1d5db;
                border-radius: 6px;
                padding: 6px 10px;
                font-size: 13px;
                color: #374151;
                background: #fff;
                box-sizing: border-box;
            }
            .goal-form-input:focus {
                outline: none;
                border-color: #7C4DFF;
                box-shadow: 0 0 0 2px rgba(124,77,255,0.15);
            }
            .goal-creation-footer {
                display: flex;
                justify-content: flex-end;
                gap: 8px;
                padding-top: 4px;
            }
            .goal-action-primary {
                background: #7C4DFF;
                color: #fff;
                border-color: #7C4DFF;
            }
            .goal-action-primary:hover {
                background: #6B3FE8;
            }

            .goal-criteria {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
            }

            .goal-chip {
                border: 1px solid #d1d5db;
                border-radius: 999px;
                padding: 2px 7px;
                font-size: 11px;
                color: #4b5563;
                background: #fff;
            }

            .goal-eval-stack {
                font-size: 11px;
                color: #6b7280;
            }
            .goal-eval-stack summary {
                cursor: pointer;
                font-weight: 500;
                margin-bottom: 4px;
            }

            .goal-evaluation-stack {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }

            .goal-evaluation {
                border-left: 3px solid #378add;
                padding: 7px 8px;
                background: #f0f7ff;
                color: #1f4f82;
                font-size: 11px;
                line-height: 1.45;
            }

            .goal-evaluation-live {
                border-left-color: #7c3aed;
                background: #f5f3ff;
                color: #4c1d95;
            }

            .goal-evaluation-met {
                border-left-color: #10b981;
                background: #ecfdf5;
                color: #065f46;
            }

            .goal-evaluation-not_met {
                border-left-color: #f59e0b;
                background: #fffbeb;
                color: #854d0e;
            }

            .goal-evaluation-blocked,
            .goal-evaluation-error {
                border-left-color: #ef4444;
                background: #fef2f2;
                color: #991b1b;
            }

            .goal-evaluation-title {
                display: flex;
                align-items: center;
                gap: 6px;
                font-weight: 600;
                margin-bottom: 3px;
            }

            .goal-evaluation-evidence {
                margin-top: 5px;
            }

            .goal-evaluation-evidence-title {
                font-weight: 600;
                margin-bottom: 2px;
            }

            .goal-evaluation-evidence ul {
                margin: 0;
                padding-left: 16px;
            }

            .goal-continuation {
                border-left: 3px solid #fac775;
                padding-left: 8px;
                font-size: 11px;
                color: #854f0b;
            }

            .goal-timeline {
                font-size: 11px;
                color: #6b7280;
            }

            .goal-timeline summary {
                cursor: pointer;
                font-weight: 500;
            }

            .goal-timeline-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
                margin-top: 6px;
            }

            .goal-timeline-item {
                display: flex;
                flex-direction: column;
                gap: 3px;
                width: 100%;
                padding: 6px 8px;
                background: var(--color-background-secondary, rgba(0, 0, 0, 0.03));
                border-radius: 6px;
                border-left: 2px solid #c4b5fd;
                text-align: left;
            }

            .goal-timeline-anchor {
                cursor: pointer;
                transition:
                    background 0.12s ease,
                    border-color 0.12s ease,
                    box-shadow 0.12s ease;
            }

            .goal-timeline-anchor:hover {
                background: rgba(124, 77, 255, 0.08);
                border-left-color: #7c4dff;
                box-shadow: 0 0 0 1px rgba(124, 77, 255, 0.14);
            }

            .goal-timeline-anchor:focus-visible {
                outline: 2px solid rgba(124, 77, 255, 0.55);
                outline-offset: 2px;
            }

            .goal-timeline-head {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
            }

            .goal-timeline-type {
                font-weight: 600;
                color: #4b5563;
            }

            .goal-timeline-revision {
                font-size: 10px;
                color: #9ca3af;
            }

            .goal-timeline-time {
                margin-left: auto;
                font-size: 10px;
                color: #9ca3af;
                font-variant-numeric: tabular-nums;
            }

            .goal-timeline-anchor-icon {
                font-size: 10px;
                color: #7c4dff;
            }

            .goal-timeline-objective {
                display: flex;
                gap: 6px;
                line-height: 1.45;
            }

            .goal-timeline-objective-label {
                flex-shrink: 0;
                color: #9ca3af;
                font-size: 10px;
            }

            .goal-timeline-objective-text {
                color: #1f2937;
                word-break: break-word;
                white-space: pre-wrap;
            }

            .goal-timeline-previous .goal-timeline-objective-text {
                color: #9ca3af;
                text-decoration: line-through;
            }

            .goal-timeline-empty {
                color: #9ca3af;
                font-style: italic;
            }
    `;
}

export function getTaskArtifactsGoalSuggestionDarkCSS(): string {
    return `
            :host([data-theme="dark"]) .goal-suggestion-copy {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .goal-creation-subtitle {
                color: #ababab !important;
            }
    `;
}

export function getTaskArtifactsGoalDarkCSS(): string {
    return `
            :host([data-theme="dark"]) .goal-section {

            }
            :host([data-theme="dark"]) .goal-header {
                border-bottom-color: rgba(255,255,255,0.12) !important;
            }
            :host([data-theme="dark"]) .goal-title {
                color: #e4e4e4 !important;
            }
            :host([data-theme="dark"]) .goal-objective {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .goal-objective-input {
                background: #1e1e1e !important;
                color: #cccccc !important;
                border-color: rgba(255,255,255,0.18) !important;
            }
            :host([data-theme="dark"]) .goal-evaluation {
                background: #1e1e1e !important;
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .goal-chip {
                background: #333333 !important;
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .goal-action-btn {
                background: #333333 !important;
                color: #cccccc !important;
                border-color: rgba(255,255,255,0.18) !important;
            }
            :host([data-theme="dark"]) .goal-action-btn:hover {
                background: #3f3f46 !important;
            }
            :host([data-theme="dark"]) .goal-action-primary {
                background: #7C4DFF !important;
                color: #fff !important;
                border-color: #7C4DFF !important;
            }
            :host([data-theme="dark"]) .goal-form-textarea {
                background: #1e1e1e !important;
                color: #cccccc !important;
                border-color: rgba(255,255,255,0.18) !important;
            }
            :host([data-theme="dark"]) .goal-form-input {
                background: #1e1e1e !important;
                color: #cccccc !important;
                border-color: rgba(255,255,255,0.18) !important;
            }
            :host([data-theme="dark"]) .goal-form-label {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .goal-progress-row {
                color: #787878 !important;
            }
            :host([data-theme="dark"]) .goal-creation-header {
                color: #e4e4e4 !important;
            }
            :host([data-theme="dark"]) .goal-timeline {
                border-top-color: rgba(255,255,255,0.12) !important;
            }
            :host([data-theme="dark"]) .goal-timeline-item {
                color: #ababab !important;
                background: rgba(255, 255, 255, 0.04) !important;
                border-left-color: #7c4dff !important;
            }
            :host([data-theme="dark"]) .goal-timeline-type {
                color: #d1d5db !important;
            }
            :host([data-theme="dark"]) .goal-timeline-objective-text {
                color: #e5e7eb !important;
            }
            :host([data-theme="dark"]) .goal-timeline-previous .goal-timeline-objective-text {
                color: #6b7280 !important;
            }
            :host([data-theme="dark"]) .goal-timeline-empty {
                color: #6b7280 !important;
            }
            :host([data-theme="dark"]) .goal-badge {
                background: #333333 !important;
                color: #ababab !important;
            }
    `;
}
