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
    normalizeGoalEvaluationDisplay,
    normalizeGoalEvaluationDisplayList
} from '../../../common/goal/evaluation-display.ts';

function getTranslator(translate) {
    return typeof translate === 'function' ? translate : (key) => key;
}

function getGoalEvalStatusLabel(status, translate) {
    const t = getTranslator(translate);
    if (typeof status !== 'string' || status.length === 0) {
        return t('goal.eval.status.unknown');
    }
    const label = t(`goal.label.evaluation.${status}`);
    return label === `goal.label.evaluation.${status}` ? status : label;
}

function getGoalEvalIconClass(progress) {
    const kind = getGoalEvaluationDisplayKind(progress);
    if (kind === 'running') return 'fa-circle-notch fa-spin';
    if (kind === 'success') return 'fa-circle-check';
    if (kind === 'danger') return 'fa-triangle-exclamation';
    return 'fa-circle-info';
}

function sanitizeDomIdSegment(value) {
    return String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function getGoalEvalIdentity(progress) {
    return (
        progress?.evaluationId ||
        [
            progress?.goalId || progress?.task_id || 'goal',
            progress?.goalRevision ?? 'rev',
            progress?.evaluatedAt || progress?.startedAt || progress?.updatedAt || progress?.phase || 'eval'
        ].join('-')
    );
}

export function getGoalEvalSelectorId(progress) {
    const identity = sanitizeDomIdSegment(getGoalEvalIdentity(progress));
    return `goal-eval-${identity || crypto.randomUUID()}`;
}

export function renderGoalEvalProgressHtml(progress, selectorId, translate) {
    const t = getTranslator(translate);
    const evaluation = normalizeGoalEvaluationDisplay(progress);
    const phase = evaluation.phase;
    const status = evaluation.status;
    const statusLabel = getGoalEvalStatusLabel(status, t);
    const title = phase === 'start' ? t('goal.eval.running') : t('goal.eval.result_title', { status: statusLabel });
    const message = evaluation.message;
    const evidence = evaluation.evidence;
    const metaItems = [];
    if (typeof evaluation.goalRevision === 'number') {
        metaItems.push(t('goal.label.revision', { revision: evaluation.goalRevision }));
    }
    const timestamp = getGoalEvaluationDisplayTimestamp(evaluation);
    if (typeof timestamp === 'string' && timestamp.trim().length > 0) {
        metaItems.push(formatLocalDateTime(timestamp));
    }

    const kind = getGoalEvaluationDisplayKind(evaluation);
    // 颜色全部由主题 CSS 变量（custom.css 中的 .od-goal-eval-kind-*）决定，JS 不感知主题。
    const colors = {
        border: 'var(--od-goal-eval-border)',
        accent: 'var(--od-goal-eval-accent)',
        bg: 'var(--od-goal-eval-bg)',
        titleColor: 'var(--od-goal-eval-title)',
        textColor: 'var(--od-goal-eval-text)',
        metaColor: 'var(--od-goal-eval-meta)'
    };

    const metaHtml =
        metaItems.length > 0
            ? `<span class="od-goal-eval-meta" style="margin-left:auto;font-size:10px;color:${colors.metaColor};white-space:nowrap;">${escapeHtml(metaItems.join(' · '))}</span>`
            : '';
    const messageHtml = message
        ? `<div class="od-goal-eval-message" style="font-size:11px;color:${colors.textColor};line-height:1.6;">${escapeHtml(message)}</div>`
        : '';
    const evidenceHtml =
        evidence.length > 0
            ? `<div class="od-goal-eval-evidence" style="border-top:1px dashed ${colors.border};padding-top:8px;display:flex;flex-direction:column;gap:3px;">
            <span style="font-size:10px;font-weight:600;color:${colors.titleColor};">${escapeHtml(t('goal.eval.evidence'))}</span>
            <ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px;">${evidence
                .map(
                    (item) =>
                        `<li style="font-size:10px;line-height:1.6;color:${colors.textColor};display:flex;gap:6px;"><span style="flex:none;width:4px;height:4px;border-radius:50%;background:${colors.accent};margin-top:6px;"></span>${escapeHtml(item)}</li>`
                )
                .join('')}</ul>
        </div>`
            : '';
    const attrs = [
        `id="${escapeHtml(selectorId)}"`,
        'class="od-goal-eval-container od-goal-eval-' +
            escapeHtml(phase) +
            ' od-goal-eval-status-' +
            escapeHtml(status || 'running') +
            ' od-goal-eval-kind-' +
            escapeHtml(kind) +
            '"',
        progress?.goalId ? `data-goal-id="${escapeHtml(progress.goalId)}"` : '',
        progress?.evaluationId ? `data-evaluation-id="${escapeHtml(progress.evaluationId)}"` : '',
        progress?.anchorMessageId ? `data-anchor-message-id="${escapeHtml(progress.anchorMessageId)}"` : '',
        typeof progress?.goalRevision === 'number' ? `data-goal-revision="${escapeHtml(progress.goalRevision)}"` : ''
    ]
        .filter(Boolean)
        .join(' ');

    return `
        <div ${attrs} style="margin:8px 0;padding:12px 14px;border:1px solid ${colors.border};border-left:3px solid ${colors.accent};border-radius:14px;background:${colors.bg};display:flex;flex-direction:column;gap:8px;font-size:12px;font-family:system-ui,-apple-system,sans-serif;">
            <div style="display:flex;align-items:center;gap:7px;">
                <i class="fa-solid ${getGoalEvalIconClass(evaluation)}" style="color:${colors.accent};flex:none;" aria-hidden="true"></i>
                <span style="font-size:12px;font-weight:600;color:${colors.titleColor};">${escapeHtml(title)}</span>
                ${metaHtml}
            </div>
            ${messageHtml}
            ${evidenceHtml}
        </div>
    `;
}

function getGoalEvaluationRecords(goal) {
    const evaluations = normalizeGoalEvaluationDisplayList(goal?.evaluations);
    if (evaluations.length > 0) return evaluations;
    if (goal?.lastEvaluation) {
        return [normalizeGoalEvaluationDisplay({ ...goal.lastEvaluation, phase: 'end' })];
    }
    return [];
}

function getGoalFinalSnapshotEvaluationRecords(snapshots, currentGoal) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) return [];
    const currentGoalId = typeof currentGoal?.id === 'string' ? currentGoal.id : '';
    return snapshots
        .filter((snapshot) => snapshot?.goalId && snapshot.goalId !== currentGoalId && snapshot.lastEvaluation)
        .map((snapshot) =>
            normalizeGoalEvaluationDisplay({
                ...snapshot.lastEvaluation,
                phase: 'end',
                updatedAt: snapshot.finalizedAt || snapshot.lastEvaluation.evaluatedAt,
                startedAt: snapshot.lastEvaluation.evaluatedAt,
                evaluationId: snapshot.lastEvaluation.evaluationId || snapshot.id,
                goalId: snapshot.goalId,
                goalRevision: snapshot.goalRevision,
                anchorMessageId: snapshot.anchorMessageId,
                anchorMessageIndex: snapshot.anchorMessageIndex
            })
        );
}

export function getTaskGoalEvaluationRecords(goal, snapshots) {
    return [...getGoalFinalSnapshotEvaluationRecords(snapshots, goal), ...getGoalEvaluationRecords(goal)];
}

function renderGoalEvaluationRecordHtml(evaluation, taskId, translate) {
    const progress = { type: 'goal_eval', task_id: taskId, ...evaluation };
    return renderGoalEvalProgressHtml(progress, getGoalEvalSelectorId(progress), translate);
}

export function renderGoalEvaluationRecordsHtml(evaluations, taskId, translate) {
    return evaluations.map((evaluation) => renderGoalEvaluationRecordHtml(evaluation, taskId, translate)).join('');
}

export function getGoalEvaluationRecordsForMessage(evaluations, message) {
    const messageId = typeof message?.message_id === 'string' ? message.message_id : '';
    if (!messageId) return [];
    return evaluations.filter((evaluation) => evaluation?.anchorMessageId === messageId);
}

export function getUnanchoredGoalEvaluationRecords(evaluations, messages) {
    const messageIds = new Set(
        (Array.isArray(messages) ? messages : [])
            .map((message) => (typeof message?.message_id === 'string' ? message.message_id : ''))
            .filter(Boolean)
    );
    return evaluations.filter((evaluation) => {
        const anchorMessageId = evaluation?.anchorMessageId;
        return typeof anchorMessageId !== 'string' || anchorMessageId.length === 0 || !messageIds.has(anchorMessageId);
    });
}

export function escapeCssIdent(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

export function findRenderedMessageAnchor(root, messageId) {
    if (typeof messageId !== 'string' || messageId.length === 0) return null;
    const escapedId = escapeCssIdent(messageId);
    const selectors = [
        `#user-msg-${escapedId}`,
        `#message-container-${escapedId}`,
        `#message-content-${escapedId}`,
        `#message-${escapedId}`
    ];
    for (const selector of selectors) {
        const target = root.querySelector(selector);
        if (target) return target.closest('.od-user-msg-container, .od-assistant-msg-container') || target;
    }
    return null;
}

export function insertGoalEvalHtml(historyContainer, anchorElement, html, progress) {
    if (!anchorElement || !historyContainer.contains(anchorElement)) {
        historyContainer.insertAdjacentHTML('beforeend', html);
        return;
    }
    let insertAfter = anchorElement;
    const anchorMessageId = progress?.anchorMessageId;
    while (
        anchorMessageId &&
        insertAfter.nextElementSibling?.classList?.contains('od-goal-eval-container') &&
        insertAfter.nextElementSibling?.dataset?.anchorMessageId === anchorMessageId
    ) {
        insertAfter = insertAfter.nextElementSibling;
    }
    insertAfter.insertAdjacentHTML('afterend', html);
}

export function relocateGoalEvaluationsToMessage(historyContainer, messageId) {
    const anchorElement = findRenderedMessageAnchor(historyContainer, messageId);
    if (!anchorElement || !historyContainer.contains(anchorElement)) return;

    const selector = `.od-goal-eval-container[data-anchor-message-id="${escapeCssIdent(messageId)}"]`;
    const evaluations = Array.from(historyContainer.querySelectorAll(selector));
    let insertAfter = anchorElement;
    for (const evaluation of evaluations) {
        if (insertAfter.nextElementSibling !== evaluation) insertAfter.insertAdjacentElement('afterend', evaluation);
        insertAfter = evaluation;
    }
}

export function findActiveGoalEvalProgress(historyContainer, progress) {
    const selectors = [];
    if (typeof progress?.evaluationId === 'string' && progress.evaluationId.length > 0) {
        selectors.push(
            `.od-goal-eval-container.od-goal-eval-start[data-evaluation-id="${escapeCssIdent(progress.evaluationId)}"]`
        );
    }
    if (typeof progress?.anchorMessageId === 'string' && progress.anchorMessageId.length > 0) {
        selectors.push(
            `.od-goal-eval-container.od-goal-eval-start[data-anchor-message-id="${escapeCssIdent(progress.anchorMessageId)}"]`
        );
    }
    if (typeof progress?.goalId === 'string' && progress.goalId.length > 0) {
        const goalSelector = `.od-goal-eval-container.od-goal-eval-start[data-goal-id="${escapeCssIdent(progress.goalId)}"]`;
        selectors.push(
            typeof progress.goalRevision === 'number'
                ? `${goalSelector}[data-goal-revision="${escapeCssIdent(String(progress.goalRevision))}"]`
                : goalSelector
        );
    }
    for (const selector of selectors) {
        const matches = historyContainer.querySelectorAll(selector);
        if (
            matches.length === 1 ||
            selector.includes('data-evaluation-id') ||
            selector.includes('data-anchor-message-id')
        ) {
            const match = matches[matches.length - 1];
            if (match) return match;
        }
    }
    return null;
}

export function renderGoalEvaluationProgress(host, progress, translate) {
    const historyContainer = host.getHistoryContainer();
    const selectorId = getGoalEvalSelectorId(progress);
    let element = historyContainer.querySelector(`#${selectorId}`);
    if (!element && progress?.phase === 'end') {
        element = findActiveGoalEvalProgress(historyContainer, progress);
    }

    const html = renderGoalEvalProgressHtml(progress, selectorId, translate);
    if (element) {
        element.outerHTML = html;
    } else {
        insertGoalEvalHtml(historyContainer, findRenderedMessageAnchor(host, progress.anchorMessageId), html, progress);
    }
    if (typeof progress?.anchorMessageId === 'string' && progress.anchorMessageId.length > 0) {
        relocateGoalEvaluationsToMessage(historyContainer, progress.anchorMessageId);
    }
    host.tryScrollToEnd();
}
