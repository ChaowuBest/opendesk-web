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
    const messageHtml = message
        ? `<div class="od-goal-eval-message" style="margin-top:4px;color:#4b5563;line-height:1.45;">${escapeHtml(message)}</div>`
        : '';
    const metaHtml =
        metaItems.length > 0
            ? `<div class="od-goal-eval-meta" style="margin-top:3px;color:#6b7280;font-size:11px;">${escapeHtml(metaItems.join(' · '))}</div>`
            : '';
    const evidenceHtml =
        evidence.length > 0
            ? `<div class="od-goal-eval-evidence" style="margin-top:6px;">
                <div style="font-weight:600;color:#374151;margin-bottom:3px;">${escapeHtml(t('goal.eval.evidence'))}</div>
                <ul style="margin:0;padding-left:18px;color:#4b5563;line-height:1.45;">${evidence
                    .map((item) => `<li>${escapeHtml(item)}</li>`)
                    .join('')}</ul>
            </div>`
            : '';
    const borderColor =
        phase === 'start'
            ? '#378add'
            : status === 'met'
              ? '#10b981'
              : status === 'blocked' || status === 'error'
                ? '#ef4444'
                : '#f59e0b';
    const attrs = [
        `id="${escapeHtml(selectorId)}"`,
        'class="od-goal-eval-container od-goal-eval-' +
            escapeHtml(phase) +
            ' od-goal-eval-status-' +
            escapeHtml(status || 'running') +
            '"',
        progress?.goalId ? `data-goal-id="${escapeHtml(progress.goalId)}"` : '',
        progress?.evaluationId ? `data-evaluation-id="${escapeHtml(progress.evaluationId)}"` : '',
        progress?.anchorMessageId ? `data-anchor-message-id="${escapeHtml(progress.anchorMessageId)}"` : '',
        typeof progress?.goalRevision === 'number' ? `data-goal-revision="${escapeHtml(progress.goalRevision)}"` : ''
    ]
        .filter(Boolean)
        .join(' ');

    return `
        <div ${attrs} style="margin:8px 0;padding:8px 12px;border-left:3px solid ${borderColor};background:#f9fafb;color:#374151;font-size:12px;font-family:system-ui,-apple-system,sans-serif;">
            <div style="display:flex;align-items:center;gap:7px;font-weight:600;color:#1f2937;">
                <i class="fa-solid ${getGoalEvalIconClass(evaluation)}" aria-hidden="true"></i>
                <span>${escapeHtml(title)}</span>
            </div>
            ${metaHtml}
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
