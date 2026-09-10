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

import { getGoalSummaryFromStatusResult, isGoalRunningInput, isTextOnlyGoalSupplementDetail } from './input.js';
import { showInfoModal, escapeModalText } from '../confirmModal.js';

export function isGoalEditReminderMessage(message) {
    const reason = message?.metadata?.origin?.reason;
    return message?.internal === true && (reason === 'goal_create' || reason === 'goal_edit');
}

export function getGoalEditReminderGoalId(message) {
    const goalId = message?.metadata?.execution?.controllerId;
    return typeof goalId === 'string' && goalId.length > 0 ? goalId : null;
}

export function mergeGoalSummary(existingGoal, incomingGoal) {
    if (!incomingGoal) return null;
    if (!existingGoal || existingGoal.id !== incomingGoal.id) return incomingGoal;

    const merged = { ...existingGoal, ...incomingGoal };
    if (!Array.isArray(incomingGoal.recentEvents) && Array.isArray(existingGoal.recentEvents)) {
        merged.recentEvents = existingGoal.recentEvents;
    }
    if (!Array.isArray(incomingGoal.objectiveEvents) && Array.isArray(existingGoal.objectiveEvents)) {
        merged.objectiveEvents = existingGoal.objectiveEvents;
    }
    if (!Array.isArray(incomingGoal.evaluations) && Array.isArray(existingGoal.evaluations)) {
        merged.evaluations = existingGoal.evaluations;
    }
    return merged;
}

export function hasGoalEditReminderAfterLatestAssistant(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    let latestAssistantIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'assistant') {
            latestAssistantIndex = index;
            break;
        }
    }
    for (let index = latestAssistantIndex + 1; index < messages.length; index += 1) {
        if (isGoalEditReminderMessage(messages[index])) return true;
    }
    return false;
}

export function canShowWaitingAssistantPlaceholder(taskStatus, goal) {
    return taskStatus === 'running' && (!goal || goal.status === 'active');
}

export function isWaitingForAssistantReply(taskStatus, goal, messages) {
    if (!canShowWaitingAssistantPlaceholder(taskStatus, goal)) return false;
    const safeMessages = Array.isArray(messages) ? messages : [];
    for (let index = safeMessages.length - 1; index >= 0; index -= 1) {
        const message = safeMessages[index];
        if (message?.role !== 'assistant') continue;
        return !Array.isArray(message.content) || message.content.length === 0;
    }
    return true;
}

export class GoalController {
    constructor(host, options = {}) {
        this.host = host;
        this.getTranslator = options.getTranslator;
        this.currentGoal = null;
        this.refreshTimer = null;
        this.liveRefreshTimer = null;
        this.refreshPending = false;
        this.pendingSupplementMessages = [];
        this.consumedSupplementPendingItems = [];
        this.pendingEditMessage = null;
        this._connected = false;
        this._disposed = false;
        this._requestEpoch = 0;
        this._handleGoalStateChanged = null;
        this._handleGoalMessageAnchor = null;
        this._handleGoalCreationOpen = null;
        this._handlePendingGoalEvent = null;
    }

    t(key, args) {
        const translate = this.getTranslator?.();
        return typeof translate === 'function' ? translate(key, args) : key;
    }

    /**
     * goal 提示统一走页内模态弹窗：window.alert 是原生阻塞式对话框，
     * Windows 下关闭后会使窗口失去焦点（issue #265）。
     */
    async showGoalInfoDialog(message) {
        await showInfoModal({
            title: this.t('goal.renderer.title'),
            message: escapeModalText(message),
            confirmText: this.t('common.confirm')
        });
    }

    connect() {
        if (this._connected) return;
        this._connected = true;
        this._disposed = false;
        this._requestEpoch += 1;

        this._handleGoalStateChanged = () => void this.host.reload();
        this._handleGoalMessageAnchor = (event) => this.handleMessageAnchor(event);
        this._handleGoalCreationOpen = () => this.openGoalCreation();
        this._handlePendingGoalEvent = (event) => this.handlePendingGoalEvent(event);

        this.host.addEventListener('goal-state-changed', this._handleGoalStateChanged);
        this.host.addEventListener('goal-message-anchor', this._handleGoalMessageAnchor);
        this.host.addEventListener('open-goal-creation', this._handleGoalCreationOpen);
        document.addEventListener('goal-pending', this._handlePendingGoalEvent);
        this.syncGoalLiveRefresh();
    }

    disconnect() {
        if (this._handleGoalStateChanged) {
            this.host.removeEventListener('goal-state-changed', this._handleGoalStateChanged);
        }
        if (this._handleGoalMessageAnchor) {
            this.host.removeEventListener('goal-message-anchor', this._handleGoalMessageAnchor);
        }
        if (this._handleGoalCreationOpen) {
            this.host.removeEventListener('open-goal-creation', this._handleGoalCreationOpen);
        }
        if (this._handlePendingGoalEvent) {
            document.removeEventListener('goal-pending', this._handlePendingGoalEvent);
        }
        this._handleGoalStateChanged = null;
        this._handleGoalMessageAnchor = null;
        this._handleGoalCreationOpen = null;
        this._handlePendingGoalEvent = null;
        this._connected = false;
        this._disposed = true;
        this._requestEpoch += 1;
        this.clearRefreshTimers();
    }

    clearRefreshTimers() {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        if (this.liveRefreshTimer) clearInterval(this.liveRefreshTimer);
        this.refreshTimer = null;
        this.liveRefreshTimer = null;
        this.refreshPending = false;
    }

    captureRequestContext() {
        return { taskId: this.host.task_id, epoch: this._requestEpoch };
    }

    isRequestContextCurrent(context) {
        return !this._disposed && context.epoch === this._requestEpoch && context.taskId === this.host.task_id;
    }

    handleMessageAnchor(event) {
        const messageId = event?.detail?.messageId;
        if (typeof messageId !== 'string' || messageId.length === 0) return;
        const requestContext = this.captureRequestContext();
        void this.host.scrollToMessage(messageId).then((found) => {
            if (found || !this.isRequestContextCurrent(requestContext)) return undefined;
            return this.host.reload().then(() => {
                if (this.isRequestContextCurrent(requestContext)) return this.host.scrollToMessage(messageId);
                return false;
            });
        });
    }

    openGoalCreation() {
        const artifacts = this.host.querySelector(`#task-${this.host.task_id}-artifacts`);
        const resizer = this.host.querySelector(`#task-${this.host.task_id}-resizer`);
        if (artifacts && typeof artifacts.showGoalCreationForm === 'function') {
            artifacts.showGoalCreationForm();
            this.host._expandRightSidebar(artifacts, resizer);
        }
    }

    handlePendingGoalEvent(event) {
        const detail = event?.detail;
        const taskId = detail?.taskId;
        const goalId = detail?.goalId;
        const goalRevision = detail?.goalRevision;
        if (typeof taskId !== 'string' || typeof goalId !== 'string' || taskId !== this.host.task_id) return;
        if (typeof goalRevision !== 'number' || !Number.isFinite(goalRevision)) {
            if (detail?.source === 'slash_command') this.showPendingSlashGoalCommand();
            return;
        }
        const suppressEcho = detail?.source === 'slash_command' || detail?.source === 'goal_editor';
        this.showPendingGoalEdit(detail.type, detail.objective, goalId, taskId, goalRevision, { suppressEcho });
    }

    createPendingGoalSupplementMessage(content, supplementId) {
        return {
            id: crypto.randomUUID(),
            supplementId,
            message: String(content || '').trim(),
            timestamp: Date.now()
        };
    }

    renderPendingGoalSupplementMessage(message) {
        return this.host.renderPendingContextEchoMessage(message, { type: 'goal_supplement' });
    }

    appendPendingGoalSupplementMessage(message) {
        const historyContainer = this.host.getHistoryContainer();
        if (!historyContainer || historyContainer.querySelector(`#pending-context-${message.id}`)) return;
        historyContainer.insertAdjacentHTML('beforeend', this.renderPendingGoalSupplementMessage(message));
        this.host._showWaitingAssistantPlaceholder({ force: true });
        this.host.tryScrollToEnd();
    }

    renderConsumedGoalSupplementMessage(message) {
        return this.host.renderPendingContextEchoMessage(message, { type: 'goal_supplement' });
    }

    createPendingGoalEditMessage(type, objective, goalId, taskId = this.host.task_id, goalRevision, options = {}) {
        const revision = Number.isFinite(Number(goalRevision)) ? Number(goalRevision) : 0;
        return {
            id: crypto.randomUUID(),
            type,
            objective: String(objective || '').trim(),
            goalId: String(goalId || ''),
            taskId: String(taskId || this.host.task_id || ''),
            goalRevision: Number.isFinite(revision) && revision > 0 ? revision : 0,
            suppressEcho: options.suppressEcho === true,
            timestamp: Date.now()
        };
    }

    renderPendingGoalEditMessage(message) {
        if (message.type === 'create' || message.suppressEcho === true) return '';
        return this.host.renderPendingContextEchoMessage(message, {
            type: `goal_${message.type}`,
            text: message.objective
        });
    }

    appendPendingGoalEditMessage(message) {
        const historyContainer = this.host.getHistoryContainer();
        if (!historyContainer || historyContainer.querySelector(`#pending-context-${message.id}`)) return;
        this.host.querySelector('.od-pending-context-entry[data-pending-context-type="goal_create"]')?.remove();
        this.host.querySelector('.od-pending-context-entry[data-pending-context-type="goal_edit"]')?.remove();
        const html = this.renderPendingGoalEditMessage(message);
        if (html) historyContainer.insertAdjacentHTML('beforeend', html);
        this.host._showWaitingAssistantPlaceholder({ force: true });
        this.host.tryScrollToEnd();
    }

    showPendingGoalSupplement(content, supplementId) {
        const message = this.createPendingGoalSupplementMessage(content, supplementId);
        this.pendingSupplementMessages.push(message);
        this.appendPendingGoalSupplementMessage(message);
    }

    showPendingGoalEdit(type, objective, goalId, taskId = this.host.task_id, goalRevision = 0, options = {}) {
        if (!goalId) return;
        const normalizedTaskId = String(taskId || this.host.task_id || '');
        const nextGoalRevision = Number(goalRevision);
        if (
            this.pendingEditMessage &&
            this.pendingEditMessage.goalId === goalId &&
            this.pendingEditMessage.taskId === normalizedTaskId
        ) {
            if (this.pendingEditMessage.goalRevision === nextGoalRevision) return;
            this.host.querySelector(`#pending-context-${this.pendingEditMessage.id}`)?.remove();
        } else if (this.pendingEditMessage) {
            this.host.querySelector(`#pending-context-${this.pendingEditMessage.id}`)?.remove();
        }
        this.pendingEditMessage = this.createPendingGoalEditMessage(
            type,
            objective,
            goalId,
            normalizedTaskId,
            nextGoalRevision,
            options
        );
        this.syncPendingGoalEditToArtifacts();
        this.appendPendingGoalEditMessage(this.pendingEditMessage);
    }

    syncPendingGoalEditToArtifacts() {
        const artifacts = this.host._getRightSidebarEl?.();
        if (artifacts && typeof artifacts.setGoalEditPending === 'function') {
            artifacts.setGoalEditPending(Boolean(this.pendingEditMessage));
        }
    }

    showPendingSlashGoalCommand() {
        this.host._showWaitingAssistantPlaceholder({ force: true });
        this.host.tryScrollToEnd();
    }

    removePendingGoalSupplementForIds(supplementIds) {
        if (!Array.isArray(supplementIds) || supplementIds.length === 0) return;
        if (this.pendingSupplementMessages.length === 0) return;
        const consumedIds = new Set(supplementIds);
        const remaining = [];
        for (const message of this.pendingSupplementMessages) {
            if (message.supplementId && consumedIds.has(message.supplementId)) {
                this.transitionGoalSupplementToConsumed(message);
            } else {
                remaining.push(message);
            }
        }
        this.pendingSupplementMessages = remaining;
    }

    transitionGoalSupplementToConsumed(message) {
        this.host.querySelector(`#pending-context-${message.id}`)?.remove();
    }

    clearPendingGoalSupplements() {
        for (const message of this.pendingSupplementMessages) {
            this.host.querySelector(`#pending-context-${message.id}`)?.remove();
        }
        for (const message of this.consumedSupplementPendingItems) {
            this.host.querySelector(`#pending-context-${message.id}`)?.remove();
        }
        this.pendingSupplementMessages = [];
        this.consumedSupplementPendingItems = [];
    }

    resolvePendingGoalSupplements() {
        if (this.consumedSupplementPendingItems.length === 0) return;
        for (const item of this.consumedSupplementPendingItems) {
            this.host.querySelector(`#pending-context-${item.id}`)?.remove();
        }
        this.consumedSupplementPendingItems = [];
    }

    removePendingGoalEditByGoalId(goalId) {
        if (!this.pendingEditMessage || this.pendingEditMessage.goalId !== goalId) return;
        this.host.querySelector(`#pending-context-${this.pendingEditMessage.id}`)?.remove();
        this.pendingEditMessage = null;
        this.syncPendingGoalEditToArtifacts();
    }

    resolvePendingGoalEditFromSummary(goal) {
        if (!this.pendingEditMessage) return;
        if (!goal || this.pendingEditMessage.goalId !== goal.id) {
            this.removePendingGoalEditByGoalId(this.pendingEditMessage.goalId);
            return;
        }
        const pendingRevision = Number(this.pendingEditMessage.goalRevision);
        const currentRevision = Number(goal.revision);
        if (
            !Number.isFinite(pendingRevision) ||
            !Number.isFinite(currentRevision) ||
            currentRevision < pendingRevision
        ) {
            return;
        }
        this.pendingEditMessage.contextAccepted = true;
        this.syncPendingGoalEditToArtifacts();
    }

    consumeGoalEditReminder(progress) {
        if (!isGoalEditReminderMessage(progress)) return;
        const goalId = getGoalEditReminderGoalId(progress);
        if (goalId) this.removePendingGoalEditByGoalId(goalId);
    }

    syncArtifactsGoalEvalProgress(progress, options = {}) {
        const artifacts = this.host._getRightSidebarEl();
        if (!artifacts || typeof artifacts.setGoalEvalProgress !== 'function') return;
        artifacts.setGoalEvalProgress(progress);
        if (options.autoExpand) this.host._ensureRightSidebarOpen();
    }

    handleGoalEvalProgress(progress, options = {}) {
        if (progress?.phase === 'end' && progress.status === 'superseded') {
            if (options.renderToConversation !== false) this.host._renderGoalEvalProgress(progress);
            this.syncArtifactsGoalEvalProgress(null);
            this.host._showWaitingAssistantPlaceholder({ force: true });
            this.host.tryScrollToEnd();
            this.scheduleGoalRefresh();
            return;
        }
        if (options.renderToConversation !== false) this.host._renderGoalEvalProgress(progress);
        this.syncArtifactsGoalEvalProgress(progress, { autoExpand: progress.phase === 'start' });
        if (progress.phase === 'end') this.scheduleGoalRefresh();
    }

    hasActiveGoal() {
        return this.currentGoal?.status === 'active';
    }

    syncArtifactsGoalState(goal, options = {}) {
        this.resolvePendingGoalEditFromSummary(goal);
        if (goal && goal.status !== 'active') this.host._removeWaitingAssistantPlaceholder();
        const artifacts = this.host._getRightSidebarEl();
        if (!artifacts || typeof artifacts.setGoalState !== 'function') return false;
        if (goal?.status === 'cleared') this.clearPendingGoalSupplements();
        const hadGoalSuggestion = typeof artifacts.hasGoalSuggestion === 'function' && artifacts.hasGoalSuggestion();
        this.host._syncArtifactsTaskStatus();
        artifacts.setGoalState(goal);
        const hasGoalSuggestion = typeof artifacts.hasGoalSuggestion === 'function' && artifacts.hasGoalSuggestion();
        const revealedGoalSuggestion = !hadGoalSuggestion && hasGoalSuggestion;
        if (options.autoExpandForGoalSuggestion && revealedGoalSuggestion) this.host._ensureRightSidebarOpen();
        return revealedGoalSuggestion;
    }

    async refreshGoalSummary() {
        if (!this.host.task_id || this._disposed) return undefined;
        const requestContext = this.captureRequestContext();
        try {
            const result = await window.taskManagerAPI.getGoalStatus(requestContext.taskId);
            if (!this.isRequestContextCurrent(requestContext)) return undefined;
            const goal = getGoalSummaryFromStatusResult(result);
            if (goal) {
                this.currentGoal = mergeGoalSummary(this.currentGoal, goal);
                this.syncGoalLiveRefresh();
                this.syncArtifactsGoalState(this.currentGoal, { autoExpandForGoalSuggestion: true });
                this.host.updateStopButtonVisibility();
            }
            return goal;
        } catch {
            return undefined;
        }
    }

    async isActiveGoalRunningNow() {
        if (isGoalRunningInput(this.host.task_status, this.currentGoal?.status)) return true;
        if (!this.host._isTaskInputRunning()) return false;
        const goal = await this.refreshGoalSummary();
        return goal?.status === 'active';
    }

    async handleActiveGoalInput(detail, options = {}) {
        const goal = this.currentGoal?.status === 'active' ? this.currentGoal : await this.refreshGoalSummary();
        if (goal?.status !== 'active') return 'not-goal';
        if (!isTextOnlyGoalSupplementDetail(detail)) {
            if (options.alertUnsupported) await this.showGoalInfoDialog(this.t('goal.supplement.images_unsupported'));
            return 'unsupported';
        }
        return (await this.submitGoalSupplement(detail)) ? 'submitted' : 'failed';
    }

    async handleRunningGoalInput(detail, options = {}) {
        if (!(await this.isActiveGoalRunningNow())) return 'not-goal';
        return this.handleActiveGoalInput(detail, options);
    }

    async submitGoalSupplement(detail) {
        if (!this.host.task_id || this._disposed) return false;
        const requestContext = this.captureRequestContext();
        try {
            const result = await window.taskManagerAPI.addGoalSupplement(requestContext.taskId, detail.message);
            if (result?.ok === false) {
                await this.showGoalInfoDialog(
                    this.t(result.messageKey || 'goal.error.unknown', result.messageArgs || {})
                );
                return false;
            }
            if (!this.isRequestContextCurrent(requestContext)) return false;
            this.currentGoal = result?.summary ? mergeGoalSummary(this.currentGoal, result.summary) : this.currentGoal;
            this.syncGoalLiveRefresh();
            this.syncArtifactsGoalState(this.currentGoal);
            this.showPendingGoalSupplement(detail.message, result?.supplementId);
            return true;
        } catch (error) {
            console.error('Failed to add goal supplement:', error);
            return false;
        }
    }

    scheduleGoalRefresh() {
        if (this._disposed) return;
        if (this.refreshTimer) {
            this.refreshPending = true;
            return;
        }
        void this.doGoalRefresh();
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            if (this._disposed) {
                this.refreshPending = false;
                return;
            }
            if (this.refreshPending) {
                this.refreshPending = false;
                this.scheduleGoalRefresh();
            }
        }, 500);
    }

    syncGoalLiveRefresh() {
        const shouldRefresh = !this._disposed && this.currentGoal?.status === 'active';
        if (shouldRefresh && !this.liveRefreshTimer) {
            this.liveRefreshTimer = window.setInterval(() => {
                if (this.host.style.display === 'none' || this.host.hasAttribute('data-background')) return;
                this.scheduleGoalRefresh();
            }, 1000);
        } else if (!shouldRefresh && this.liveRefreshTimer) {
            clearInterval(this.liveRefreshTimer);
            this.liveRefreshTimer = null;
        }
    }

    async doGoalRefresh() {
        if (!this.host.task_id || !this.currentGoal || this._disposed) return;
        const requestContext = this.captureRequestContext();
        try {
            const result = await window.taskManagerAPI.getGoalStatus(requestContext.taskId);
            if (!this.isRequestContextCurrent(requestContext)) return;
            const goal = getGoalSummaryFromStatusResult(result);
            if (!goal) return;
            this.currentGoal = mergeGoalSummary(this.currentGoal, goal);
            this.syncGoalLiveRefresh();
            this.syncArtifactsGoalState(this.currentGoal, { autoExpandForGoalSuggestion: true });
            this.host.updateStopButtonVisibility();
        } catch {
            // 非致命错误，goal 面板会在下次 reload 时同步。
        }
    }

    async pauseActiveGoal() {
        if (!this.host.task_id || this._disposed) return false;
        const requestContext = this.captureRequestContext();
        const result = await window.taskManagerAPI.pauseGoal(requestContext.taskId);
        if (result?.ok === false) {
            await this.showGoalInfoDialog(this.t(result.messageKey || 'goal.error.unknown', result.messageArgs || {}));
            return false;
        }
        if (!this.isRequestContextCurrent(requestContext)) return true;
        this.currentGoal = result?.summary
            ? mergeGoalSummary(this.currentGoal, result.summary)
            : this.currentGoal
              ? { ...this.currentGoal, status: 'paused' }
              : null;
        this.syncGoalLiveRefresh();
        this.syncArtifactsGoalState(this.currentGoal);
        return true;
    }

    async stopActiveGoal() {
        if (!this.host.task_id || this._disposed) return false;
        const requestContext = this.captureRequestContext();
        const result = await window.taskManagerAPI.stopTask(requestContext.taskId);
        if (result?.ok === false) {
            await this.showGoalInfoDialog(this.t(result.messageKey || 'goal.error.unknown', result.messageArgs || {}));
            return false;
        }
        if (!this.isRequestContextCurrent(requestContext)) return true;
        if (result?.summary) {
            this.currentGoal = mergeGoalSummary(this.currentGoal, result.summary);
            this.syncGoalLiveRefresh();
            this.syncArtifactsGoalState(this.currentGoal);
        }
        return true;
    }
}
