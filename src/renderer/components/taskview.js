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

import { ElasticToolbarWidget } from './toolbar.ts';
import './taskartifacts.ts';
import { BrowserPip } from './browserPip.ts';
import { showImageLightbox } from './imageLightbox.js';
import { showWorkspacePicker } from './workspacePicker.ts';
import { enhanceCodeBlocks, enhanceToolPreviewCards } from './previewer.ts';
import { escapeHtml } from '../../common/utils/escape.js';
import { createRendererTranslator } from '../locale.ts';
import { formatLocalDateTime } from './goal-time-format.js';
import {
    getGoalSummaryFromStatusResult,
    isGoalRunningInput,
    isTextOnlyGoalSupplementDetail
} from './taskview-goal-input.js';

const DANGEROUS_TAGS = new Set(['STYLE', 'SCRIPT', 'LINK', 'META', 'IFRAME', 'OBJECT', 'EMBED', 'APPLET', 'BASE']);
const BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_RIGHT_SIDEBAR_WIDTH = 500;
export const TASKVIEW_HISTORY_BATCH_MESSAGE_LIMIT = 20;
export const TASKVIEW_HISTORY_BATCH_HTML_CHAR_LIMIT = 200000;
const TASKVIEW_HISTORY_TOP_LOAD_THRESHOLD_PX = 96;
const TASKVIEW_HISTORY_VIEWPORT_FILL_GUARD = 8;
let taskViewT = createRendererTranslator();
let guiReasonDisplayMode = 'inline';

function updateTaskViewTranslator(setting) {
    taskViewT = createRendererTranslator(setting);
    guiReasonDisplayMode = setting?.gui_config?.gui_reason_display || 'inline';
}

void window.settingAPI
    ?.loadSettingObject?.()
    .then(updateTaskViewTranslator)
    .catch(() => {});
window.settingAPI?.onSettingChanged?.(updateTaskViewTranslator);

function removeDangerousNodes(root) {
    root.querySelectorAll(Array.from(DANGEROUS_TAGS).join(',')).forEach((el) => el.remove());
}

function installDOMSanitizer(container) {
    removeDangerousNodes(container);
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (DANGEROUS_TAGS.has(node.tagName)) {
                        node.remove();
                    } else {
                        removeDangerousNodes(node);
                    }
                }
            }
        }
    });
    observer.observe(container, { childList: true, subtree: true });
    return observer;
}

function getGoalSupplementDisplayText(message) {
    if (
        message?.internal === true &&
        message?.metadata?.origin?.reason === 'goal_supplement' &&
        typeof message.rawText === 'string'
    ) {
        const text = message.rawText.trim();
        return text.length > 0 ? text : undefined;
    }
    return undefined;
}

function isGoalEditReminderMessage(message) {
    const reason = message?.metadata?.origin?.reason;
    return message?.internal === true && (reason === 'goal_create' || reason === 'goal_edit');
}

function getGoalEditReminderGoalId(message) {
    const goalId = message?.metadata?.execution?.controllerId;
    return typeof goalId === 'string' && goalId.length > 0 ? goalId : null;
}

function createRenderedTextPartFromPlainText(text) {
    return {
        type: 'text',
        rendered: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`
    };
}

export function shouldRenderUserHistoryMessage(message) {
    return !message?.internal || getGoalSupplementDisplayText(message) !== undefined;
}

function getRenderableUserParts(message, fallbackParts) {
    const supplementText = getGoalSupplementDisplayText(message);
    if (supplementText !== undefined) {
        return [createRenderedTextPartFromPlainText(supplementText)];
    }
    return Array.isArray(fallbackParts) ? fallbackParts : [];
}

function getProgressPartIndex(progress) {
    return Number.isInteger(progress?.last_part_index) && progress.last_part_index >= 0 ? progress.last_part_index : 0;
}

function markRenderedUserParts(renderedUserParts, messageId, partCount) {
    if (typeof messageId !== 'string' || messageId.length === 0) return;
    const renderedSet = new Set();
    for (let index = 0; index < partCount; index += 1) {
        renderedSet.add(index);
    }
    renderedUserParts.set(messageId, renderedSet);
}

function getRenderedUserPartSet(renderedUserParts, messageId) {
    let renderedSet = renderedUserParts.get(messageId);
    if (!renderedSet) {
        renderedSet = new Set();
        renderedUserParts.set(messageId, renderedSet);
    }
    return renderedSet;
}

function formatReasoningElapsedTime(seconds) {
    if (seconds < 60) {
        return taskViewT('reasoning.elapsed.seconds', { seconds });
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return taskViewT('reasoning.elapsed.minutes', { minutes, seconds: remainingSeconds });
}

function mergeGoalSummary(existingGoal, incomingGoal) {
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

function getGoalEvalStatusLabel(status) {
    if (typeof status !== 'string' || status.length === 0) {
        return taskViewT('goal.eval.status.unknown');
    }
    const label = taskViewT(`goal.label.evaluation.${status}`);
    return label === `goal.label.evaluation.${status}` ? status : label;
}

function getGoalEvalIconClass(progress) {
    if (progress?.phase === 'start') return 'fa-circle-notch fa-spin';
    if (progress?.status === 'met') return 'fa-circle-check';
    if (progress?.status === 'blocked' || progress?.status === 'error') return 'fa-triangle-exclamation';
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

function getGoalEvalSelectorId(progress) {
    const identity = sanitizeDomIdSegment(getGoalEvalIdentity(progress));
    return `goal-eval-${identity || crypto.randomUUID()}`;
}

function renderGoalEvalProgressHtml(progress, selectorId) {
    const phase = progress?.phase === 'end' ? 'end' : 'start';
    const status = typeof progress?.status === 'string' ? progress.status : '';
    const statusLabel = getGoalEvalStatusLabel(status);
    const title =
        phase === 'start'
            ? taskViewT('goal.eval.running')
            : taskViewT('goal.eval.result_title', { status: statusLabel });
    const message = typeof progress?.message === 'string' ? progress.message.trim() : '';
    const evidence = Array.isArray(progress?.evidence)
        ? progress.evidence.filter((item) => typeof item === 'string' && item.trim().length > 0)
        : [];
    const metaItems = [];
    if (typeof progress?.goalRevision === 'number') {
        metaItems.push(taskViewT('goal.label.revision', { revision: progress.goalRevision }));
    }
    const timestamp = progress?.evaluatedAt || progress?.updatedAt || progress?.startedAt;
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
                <div style="font-weight:600;color:#374151;margin-bottom:3px;">${escapeHtml(taskViewT('goal.eval.evidence'))}</div>
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
                <i class="fa-solid ${getGoalEvalIconClass(progress)}" aria-hidden="true"></i>
                <span>${escapeHtml(title)}</span>
            </div>
            ${metaHtml}
            ${messageHtml}
            ${evidenceHtml}
        </div>
    `;
}

function getGoalEvaluationRecords(goal) {
    const evaluations = Array.isArray(goal?.evaluations) ? goal.evaluations : [];
    if (evaluations.length > 0) {
        return evaluations;
    }
    if (goal?.lastEvaluation) {
        return [
            {
                phase: 'end',
                status: goal.lastEvaluation.status,
                message: goal.lastEvaluation.reason,
                evidence: goal.lastEvaluation.evidence,
                evaluatedAt: goal.lastEvaluation.evaluatedAt,
                updatedAt: goal.lastEvaluation.evaluatedAt,
                startedAt: goal.lastEvaluation.evaluatedAt,
                evaluationId: goal.lastEvaluation.evaluationId,
                goalId: goal.lastEvaluation.goalId,
                goalRevision: goal.lastEvaluation.goalRevision
            }
        ];
    }
    return [];
}

function renderGoalEvaluationRecordHtml(evaluation, taskId) {
    const progress = {
        type: 'goal_eval',
        task_id: taskId,
        ...evaluation
    };
    return renderGoalEvalProgressHtml(progress, getGoalEvalSelectorId(progress));
}

function renderGoalEvaluationRecordsHtml(evaluations, taskId) {
    return evaluations.map((evaluation) => renderGoalEvaluationRecordHtml(evaluation, taskId)).join('');
}

function getGoalEvaluationRecordsForMessage(evaluations, message) {
    const messageId = typeof message?.message_id === 'string' ? message.message_id : '';
    if (!messageId) return [];
    return evaluations.filter((evaluation) => evaluation?.anchorMessageId === messageId);
}

function getUnanchoredGoalEvaluationRecords(evaluations, messages) {
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

function escapeCssIdent(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function findRenderedMessageAnchor(root, messageId) {
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
        if (!target) continue;
        return target.closest('.od-user-msg-container, .od-assistant-msg-container') || target;
    }
    return null;
}

function insertGoalEvalHtml(historyContainer, anchorElement, html, progress) {
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

class TaskView extends HTMLElement {
    constructor() {
        super();

        // 每个任务独立的侧边栏状态
        this._rightSidebarExpanded = false;
        this._rightSidebarWidth = DEFAULT_RIGHT_SIDEBAR_WIDTH;

        this.task_id = null;
        this.widget_id = crypto.randomUUID();
        /** @type {HTMLDivElement | null} */
        this.history_container = null;
        /** @type {string | null} */
        this.subscription_id = null;
        this.auto_scrolling_to_bottom = true;
        this.task_status = 'waiting';
        this._currentGoal = null;
        /** @type {Array} 当前任务级待办 */
        this._taskTodos = [];
        /** @type {Array} 全局待办 */
        this._globalTodos = [];
        /** @type {Function | null} 取消全局待办订阅 */
        this._globalTodosUnsubscribe = null;
        /** @type {Function | null} 取消任务级待办订阅 */
        this._taskTodosUnsubscribe = null;
        /** @type {Function | null} 取消 workspace-changed 监听 */
        this._workspaceChangedHandler = null;
        /** @type {import('./toolbar.ts').ElasticToolbarWidget | null} */
        this._toolbar = null;
        /** @type {Function | null} */
        this._taskListUpdateHandler = null;
        /** @type {string | null} 任务指定的工作空间路径 */
        this._taskWorkspace = null;
        /** @type {string} 任务名称（用于工作空间选择器标题） */
        this._taskName = '';
        /** @type {number} 当前模型上下文窗口大小（tokens） */
        this._modelContextSize = 0;
        /** @type {string | null} 当前已加载上下文大小的模型别名 */
        this._contextSizeModel = null;
        /** @type {Map<string, HTMLElement>} 缓存活跃的 message container 元素 */
        this._messageContainerCache = new Map();
        /** @type {number | null} 节流滚动的 rAF id */
        this._scrollRafId = null;
        /** @type {BrowserPip | null} 浏览器画中画浮窗 */
        this._browserPip = null;
        /** @type {number | null} 浏览器空闲销毁倒计时 */
        this._browserIdleTimer = null;
        /** @type {Array<{id: string, message: string, attachedFilePaths: string[], attachedImages: string[], selectedModel?: string, reasoningEffort?: string}>} 消息队列 */
        this.messageQueue = [];
        /** @type {boolean} 正在执行 sendQueueMessageImmediately 流程 */
        this._immediateQueueSending = false;
        /** @type {Map<string, Set<number>>} 跟踪已渲染的用户消息 part（message_id → part_index 集合），防止重复渲染 */
        this._renderedUserParts = new Map();
        /** @type {boolean} 是否正在执行 reload()，用于暂停订阅回调的 DOM 操作 */
        this._reloading = false;
        /** @type {number} reload 版本号，用于丢弃过期 reload 的后续操作 */
        this._reloadVersion = 0;
        /** @type {number | null} goal 面板节流刷新定时器 */
        this._goalRefreshTimer = null;
        /** @type {number | null} active goal 运行期刷新定时器 */
        this._goalLiveRefreshTimer = null;
        /** @type {boolean} 是否有待刷新的 goal 状态 */
        this._goalRefreshPending = false;
        /** @type {Array<object>} GUI 运行期已点击发送、等待进入上下文的 goal supplement。 */
        this._pendingGoalSupplementMessages = [];
        /** @type {{id: string, goalId: string, type: 'create'|'edit', objective: string, taskId: string} | null} */
        this._pendingGoalEditMessage = null;
        /** @type {Array<object>} 当前任务的完整持久化消息列表，DOM 只渲染其中的尾部窗口。 */
        this._historyMessages = [];
        /** @type {Array<object>} 当前任务持久化的 goal evaluation 记录，用 message anchor 插入历史上下文。 */
        this._historyGoalEvaluationRecords = [];
        /** @type {number} 当前已经渲染的最早持久化消息下标。 */
        this._historyRenderStartIndex = 0;
        /** @type {boolean} 防止顶部滚动连续触发重复补载。 */
        this._loadingOlderHistory = false;
    }

    static isCompactBoundaryMessage(message) {
        return Boolean(message) && message.role === 'compact_separator';
    }

    static isRenderableHistoryMessage(message) {
        if (!message) return false;
        if (message.role === 'user') {
            return shouldRenderUserHistoryMessage(message);
        }
        if (message.role === 'assistant') {
            return Array.isArray(message.content) && message.content.length > 0;
        }
        return TaskView.isCompactBoundaryMessage(message);
    }

    static getMessageRenderedHtmlCharLength(message) {
        if (!message) return 0;
        if (message.role === 'user') {
            return getRenderableUserParts(message, message.content).reduce(
                (total, part) => total + String(part?.rendered || '').length,
                0
            );
        }
        if (message.role === 'assistant') {
            const parts = Array.isArray(message.content) ? message.content : [];
            return parts.reduce((total, part) => total + String(part?.rendered || '').length, 0);
        }
        return 0;
    }

    static findHistoryBatchStart(messages, endIndex) {
        const boundedEnd = Math.max(0, Math.min(endIndex, messages.length));
        let renderedCount = 0;
        let renderedHtmlChars = 0;
        let startIndex = boundedEnd;

        for (let i = boundedEnd - 1; i >= 0; i--) {
            const message = messages[i];
            const renderable = TaskView.isRenderableHistoryMessage(message);
            const messageHtmlChars = renderable ? TaskView.getMessageRenderedHtmlCharLength(message) : 0;
            const hasLoadedAtLeastOneMessage = renderedCount > 0;
            const exceedsMessageLimit = renderedCount >= TASKVIEW_HISTORY_BATCH_MESSAGE_LIMIT;
            const exceedsHtmlLimit = renderedHtmlChars + messageHtmlChars > TASKVIEW_HISTORY_BATCH_HTML_CHAR_LIMIT;

            if (renderable && hasLoadedAtLeastOneMessage && (exceedsMessageLimit || exceedsHtmlLimit)) {
                break;
            }

            startIndex = i;

            if (renderable) {
                renderedCount += 1;
                renderedHtmlChars += messageHtmlChars;
            }
        }

        return startIndex;
    }

    _programmaticScrolling = false;

    setAutoScrollingToBottom(auto_scrolling_to_bottom) {
        this.auto_scrolling_to_bottom = auto_scrolling_to_bottom;
        const scrollButton = this.querySelector('#taskview-scroll-to-bottom-button');
        if (auto_scrolling_to_bottom) {
            scrollButton.classList.add('hidden');
        } else {
            scrollButton.classList.remove('hidden');
        }
    }

    getHistoryContainer() {
        if (this.history_container === null) {
            this.history_container = this.querySelector('#taskview-chat-history');
        }
        return this.history_container;
    }

    renderUserPart(part) {
        if (part.type === 'image_url') {
            return `<div class="flex flex-col items-end"><div class="od-user-image-group"><div class="od-user-image-container">${part.rendered}</div></div></div>`;
        }
        if (part.type === 'file') {
            return `<div class="self-end max-w-[340px]">${part.rendered}</div>`;
        }
        return `<div class="flex flex-col items-end"><div class="od-user-msg bg-white text-gray-900 rounded-lg px-3 py-1.5 max-w-3xl border border-gray-200"><div class="${TaskView.USER_PART_CLASS_MAP[part.type] || ''}">${part.rendered}</div></div></div>`;
    }

    renderUserMessage(user_message) {
        const rawAttr = user_message.rawText ? ` data-raw-text="${escapeHtml(user_message.rawText)}"` : '';
        const timeHtml = user_message.timestamp
            ? `<div class="text-right text-[10px] text-gray-400 mt-0.5 mr-1">${TaskView.formatRelativeTime(user_message.timestamp)}</div>`
            : '';

        const parts = getRenderableUserParts(user_message, user_message.content);
        let inner = '';
        for (const part of parts) {
            inner += this.renderUserPart(part);
        }
        inner += timeHtml;

        return `<div id="user-msg-${escapeHtml(user_message.message_id)}" class="od-user-msg-container" data-message-id="${escapeHtml(user_message.message_id)}"${rawAttr}>${inner}</div>`;
    }

    createPendingGoalSupplementMessage(content) {
        const text = String(content || '').trim();
        return {
            id: crypto.randomUUID(),
            message: text,
            timestamp: Date.now()
        };
    }

    renderPendingGoalSupplementMessage(message) {
        const textHtml = escapeHtml(message.message).replace(/\n/g, '<br>');
        const pendingLabel = taskViewT('renderer.goalSupplement.pending');
        return `
            <div id="goal-supplement-pending-${escapeHtml(message.id)}" class="goal-supplement-pending flex flex-col items-end my-1" data-pending-goal-supplement-id="${escapeHtml(message.id)}">
                <div class="max-w-3xl border border-dashed border-indigo-200 bg-indigo-50/60 text-gray-700 rounded-lg px-3 py-1.5">
                    <div class="text-[10px] text-indigo-500 mb-1 flex items-center justify-end gap-1">
                        <i class="fas fa-clock"></i>
                        <span>${escapeHtml(pendingLabel)}</span>
                    </div>
                    <div class="text-[11px] leading-relaxed">${textHtml}</div>
                </div>
            </div>
        `;
    }

    appendPendingGoalSupplementMessage(message) {
        const historyContainer = this.getHistoryContainer();
        if (!historyContainer) return;
        if (historyContainer.querySelector(`#goal-supplement-pending-${message.id}`)) return;

        const waitingPlaceholder = historyContainer.querySelector('.waiting-usage-placeholder');
        waitingPlaceholder?.remove();
        historyContainer.insertAdjacentHTML('beforeend', this.renderPendingGoalSupplementMessage(message));
        if (waitingPlaceholder) {
            historyContainer.appendChild(waitingPlaceholder);
        }
        this.tryScrollToEnd();
    }

    createPendingGoalEditMessage(type, objective, goalId, taskId = this.task_id) {
        return {
            id: crypto.randomUUID(),
            type,
            objective: String(objective || '').trim(),
            goalId: String(goalId || ''),
            taskId: String(taskId || this.task_id || ''),
            timestamp: Date.now()
        };
    }

    renderPendingGoalEditMessage(message) {
        const pendingLabel = taskViewT('goal.pending.tag');
        const title = taskViewT(`goal.pending.${message.type}`);
        const textHtml = escapeHtml(message.objective).replace(/\n/g, '<br>');
        return `
            <div id="goal-edit-pending-${escapeHtml(message.id)}" class="goal-edit-pending flex flex-col items-end my-1" data-pending-goal-id="${escapeHtml(message.goalId)}">
                <div class="max-w-3xl border border-dashed border-indigo-200 bg-indigo-50/60 text-gray-700 rounded-lg px-3 py-1.5">
                    <div class="text-[10px] text-indigo-500 mb-1 flex items-center justify-end gap-1">
                        <i class="fas fa-clock"></i>
                        <span>${escapeHtml(pendingLabel)}</span>
                    </div>
                    <div class="text-[11px] leading-relaxed mb-1">${escapeHtml(title)}</div>
                    <div class="text-[11px] leading-relaxed">${textHtml}</div>
                </div>
            </div>
        `;
    }

    appendPendingGoalEditMessage(message) {
        const historyContainer = this.getHistoryContainer();
        if (!historyContainer) return;
        if (historyContainer.querySelector(`#goal-edit-pending-${message.id}`)) return;

        this.querySelector('.goal-edit-pending')?.remove();
        const waitingPlaceholder = historyContainer.querySelector('.waiting-usage-placeholder');
        waitingPlaceholder?.remove();
        historyContainer.insertAdjacentHTML('beforeend', this.renderPendingGoalEditMessage(message));
        if (waitingPlaceholder) {
            historyContainer.appendChild(waitingPlaceholder);
        }
        this.tryScrollToEnd();
    }

    showPendingGoalSupplement(content) {
        const message = this.createPendingGoalSupplementMessage(content);
        this._pendingGoalSupplementMessages.push(message);
        this.appendPendingGoalSupplementMessage(message);
    }

    showPendingGoalEdit(type, objective, goalId, taskId = this.task_id) {
        if (!goalId) return;
        const message = this.createPendingGoalEditMessage(type, objective, goalId, taskId);
        this._pendingGoalEditMessage = message;
        this.appendPendingGoalEditMessage(message);
    }

    removePendingGoalSupplementForText(rawText) {
        const text = String(rawText || '').trim();
        if (!text || this._pendingGoalSupplementMessages.length === 0) return;
        const remaining = [];
        for (const message of this._pendingGoalSupplementMessages) {
            const pendingText = String(message.message || '').trim();
            const consumed =
                pendingText === text ||
                text.startsWith(`${pendingText}\n\n`) ||
                text.endsWith(`\n\n${pendingText}`) ||
                text.includes(`\n\n${pendingText}\n\n`);
            if (consumed) {
                this.querySelector(`#goal-supplement-pending-${message.id}`)?.remove();
            } else {
                remaining.push(message);
            }
        }
        this._pendingGoalSupplementMessages = remaining;
    }

    removePendingGoalEditByGoalId(goalId) {
        if (!this._pendingGoalEditMessage || this._pendingGoalEditMessage.goalId !== goalId) return;
        this.querySelector(`#goal-edit-pending-${this._pendingGoalEditMessage.id}`)?.remove();
        this._pendingGoalEditMessage = null;
    }

    static formatRelativeTime(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);

        if (minutes < 1) return '刚刚';
        if (minutes < 60) return `${minutes} 分钟前`;
        if (hours < 24) return `${hours} 小时前`;

        const d = new Date(timestamp);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    static USER_PART_CLASS_MAP = {
        text: 'bg-transparent text-[11px] text-black markdown-body'
    };

    static ASSISTANT_PART_CLASS_MAP = {
        text: 'py-1.5 bg-transparent text-[11px] text-black markdown-body',
        reasoning: '',
        tool_call: ''
    };

    static SPINNER_SVG = `<i class="fa-solid fa-circle-notch fa-spin"></i>`;

    static normalizeUsageToken(value) {
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    }

    static getUsageDisplayTokens(usage) {
        return {
            promptTokens: TaskView.normalizeUsageToken(usage?.prompt_tokens),
            completionTokens: TaskView.normalizeUsageToken(usage?.completion_tokens),
            totalTokens: TaskView.normalizeUsageToken(usage?.total_tokens)
        };
    }

    static hasDisplayableUsage(usage) {
        if (!usage) return false;
        const { completionTokens, totalTokens } = TaskView.getUsageDisplayTokens(usage);
        return completionTokens > 0 || totalTokens > 0;
    }

    static createWaitingAssistantPlaceholderHtml() {
        const label = escapeHtml(taskViewT('renderer.taskview.thinking'));
        return `
        <div class="waiting-usage-placeholder od-assistant-msg-container flex items-start">
            <div class="px-2 bg-transparent w-full">
                <div class="od-thinking-placeholder od-inline-toolcall-container" role="status" aria-live="polite">
                    <div class="flex items-center gap-1.5 min-w-0">
                        <i class="fa-solid fa-circle-notch fa-spin shrink-0 text-slate-400 text-xs"></i>
                        <span class="shrink-0 text-slate-500 text-xs">${label}</span>
                    </div>
                </div>
            </div>
        </div>
        `;
    }

    static hasAssistantOutputAfterLatestUser(historyContainer) {
        const children = Array.from(historyContainer.children);
        let latestUserIndex = -1;
        children.forEach((child, index) => {
            if (child.classList.contains('od-user-msg-container')) {
                latestUserIndex = index;
            }
        });

        for (let i = latestUserIndex + 1; i < children.length; i++) {
            const child = children[i];
            if (
                !child.classList.contains('od-assistant-msg-container') ||
                child.classList.contains('waiting-usage-placeholder')
            ) {
                continue;
            }
            const contentEl =
                child.querySelector('div[id^="message-content-"]') ||
                Array.from(child.querySelectorAll('div[id^="message-"]')).find(
                    (el) => !el.id.startsWith('message-container-')
                );
            if (contentEl && (contentEl.children.length > 0 || contentEl.textContent.trim().length > 0)) {
                return true;
            }
        }
        return false;
    }

    static formatUsageHtml(usage, contextSize, isStreaming = false) {
        if (!TaskView.hasDisplayableUsage(usage)) return '';
        const { promptTokens, completionTokens, totalTokens } = TaskView.getUsageDisplayTokens(usage);
        const titleParts = `输入: ${promptTokens}, 输出: ${completionTokens}, 总计: ${totalTokens}`;
        let ratioText = '';
        if (contextSize > 0 && totalTokens > 0) {
            const pct = ((totalTokens / contextSize) * 100).toFixed(1);
            ratioText = `, 上下文占比 ${pct}%`;
        }
        const spinnerDisplay = isStreaming ? '' : 'display:none;';
        return `<span class="message-usage text-xs text-gray-400 mt-3 flex items-center gap-1" title="${titleParts}" data-prompt-tokens="${promptTokens}" data-completion-tokens="${completionTokens}" data-total-tokens="${totalTokens}" data-streaming="${isStreaming}"><span class="usage-spinner" style="${spinnerDisplay}">${TaskView.SPINNER_SVG}</span><span class="usage-text">已输出 ${completionTokens} 词, 总计 ${totalTokens} 词${ratioText}</span></span>`;
    }

    /**
     * Create reasoning block HTML in inline-tool style.
     * @param {string} rendered - Reasoning text content
     * @param {boolean} isStreaming - Whether the reasoning is currently being streamed
     */
    static createReasoningPartHtml(rendered, isStreaming = false, elapsedSeconds = null) {
        const escaped = escapeHtml(rendered || '');
        const title = escapeHtml(taskViewT('reasoning.card.title'));
        const stateClass = isStreaming ? 'reasoning-active' : 'reasoning-completed';

        // During streaming: icon breathes with gradient to indicate active thinking
        const iconBreathClass = isStreaming ? ' reasoning-icon-breathing' : '';

        // Pre-fill elapsed time for completed (e.g. historical) reasoning blocks
        const timeText =
            !isStreaming && elapsedSeconds != null && elapsedSeconds > 0
                ? `（${formatReasoningElapsedTime(elapsedSeconds)}）`
                : '';

        const isBubble = guiReasonDisplayMode === 'bubble';

        if (isBubble) {
            // Bubble starts hidden for completed blocks; streaming blocks show it immediately
            const bubbleHiddenClass = isStreaming ? '' : ' reasoning-bubble-hidden';
            const bubbleHtml = `<div class="reasoning-bubble compact-scroll${bubbleHiddenClass}"><div class="reasoning-bubble-content text-[11px] leading-relaxed whitespace-pre-wrap">${escaped}</div></div>`;
            return `
        <div class="reasoning-block-od od-inline-toolcall-container ${stateClass}"${isStreaming ? ` data-reasoning-start="${Date.now()}"` : ''}>
            <div class="reasoning-header flex items-center gap-1.5 min-w-0 cursor-pointer select-none py-0.5">
                <i class="fa-regular fa-lightbulb${iconBreathClass} shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">${title}</span>
                <span class="reasoning-time text-xs text-slate-400 shrink-0">${timeText}</span>
            </div>
            ${bubbleHtml}
        </div>`;
        }

        // Inline mode
        const toggleHtml = isStreaming
            ? ''
            : `<span class="reasoning-toggle text-xs text-blue-500 hover:text-blue-600 cursor-pointer shrink-0"></span>`;

        let previewHtml = '';
        if (isStreaming) {
            previewHtml = `<div class="reasoning-preview-area"><div class="reasoning-preview-content px-3 pb-1.5 text-slate-500 text-[11px] leading-relaxed whitespace-pre-wrap">${escaped}</div></div>`;
        }

        const fullHtml = `<div class="reasoning-full-area"><div class="reasoning-content px-3 pb-2 text-slate-500 text-[11px] leading-relaxed whitespace-pre-wrap">${escaped}</div></div>`;

        return `
        <div class="reasoning-block-od od-inline-toolcall-container ${stateClass}"${isStreaming ? ` data-reasoning-start="${Date.now()}"` : ''}>
            <div class="reasoning-header flex items-center gap-1.5 min-w-0 cursor-pointer select-none py-0.5">
                <i class="fa-regular fa-lightbulb${iconBreathClass} shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">${title}</span>
                <span class="reasoning-time text-xs text-slate-400 shrink-0">${timeText}</span>
                ${toggleHtml}
            </div>
            ${previewHtml}
            ${fullHtml}
        </div>`;
    }

    /**
     * Update the live preview and hidden full content of a streaming reasoning block.
     * Also updates the elapsed time display in real-time.
     */
    static updateReasoningPreview(el, text) {
        if (!el) return;

        // Start a per-second time updater on first call
        if (!el._reasoningTimeInterval) {
            const updateTime = () => {
                if (el.classList.contains('reasoning-completed')) return;
                const startTime = parseInt(el.dataset.reasoningStart || '0', 10);
                if (startTime > 0) {
                    const elapsed = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
                    const timeEl = el.querySelector('.reasoning-time');
                    if (timeEl) {
                        timeEl.textContent = `（${formatReasoningElapsedTime(elapsed)}）`;
                    }
                }
            };
            updateTime();
            el._reasoningTimeInterval = setInterval(updateTime, 1000);
        }

        // Bubble mode: update bubble content
        const bubbleContent = el.querySelector('.reasoning-bubble-content');
        if (bubbleContent) {
            bubbleContent.textContent = text;
            const bubble = el.querySelector('.reasoning-bubble');
            if (bubble) {
                bubble.scrollTop = bubble.scrollHeight;
            }
            return;
        }

        // Inline mode: update preview content
        const previewContent = el.querySelector('.reasoning-preview-content');
        if (previewContent) {
            previewContent.textContent = text;
            const previewArea = el.querySelector('.reasoning-preview-area');
            if (previewArea) {
                previewArea.scrollTop = previewArea.scrollHeight;
            }
        }

        const fullContent = el.querySelector('.reasoning-content');
        if (fullContent) {
            fullContent.textContent = text;
        }
    }

    /**
     * Transition a reasoning block from active (streaming) to completed state.
     * Calculates elapsed time, hides preview, shows toggle button.
     */
    static finalizeReasoningBlock(el) {
        if (!el || el.classList.contains('reasoning-completed')) return;

        // Clear the per-second time interval
        if (el._reasoningTimeInterval) {
            clearInterval(el._reasoningTimeInterval);
            el._reasoningTimeInterval = null;
        }

        el.classList.remove('reasoning-active');
        el.classList.add('reasoning-completed');

        // Bubble mode: auto-hide the bubble after a short delay
        const bubble = el.querySelector('.reasoning-bubble');
        if (bubble) {
            setTimeout(() => {
                if (
                    el.classList.contains('reasoning-completed') &&
                    !el.classList.contains('reasoning-bubble-pinned') &&
                    !el.matches(':hover')
                ) {
                    bubble.classList.add('reasoning-bubble-hidden');
                    el.classList.remove('reasoning-content-visible');
                }
            }, 1000);
        }

        // Hide preview area (inline mode)
        const previewArea = el.querySelector('.reasoning-preview-area');
        if (previewArea) previewArea.style.display = 'none';

        // Calculate and display final elapsed time
        const startTime = parseInt(el.dataset.reasoningStart || '0', 10);
        if (startTime > 0) {
            const elapsed = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
            const timeEl = el.querySelector('.reasoning-time');
            if (timeEl) {
                timeEl.textContent = `（${formatReasoningElapsedTime(elapsed)}）`;
            }
        }

        // Reset toggle text (collapsed state = empty)
        const toggle = el.querySelector('.reasoning-toggle');
        if (toggle) toggle.textContent = '';

        // Stop icon breathing animation
        const icon = el.querySelector('.reasoning-header i.fa-lightbulb');
        if (icon) icon.classList.remove('reasoning-icon-breathing');
    }

    renderAssistantPart(part, classMap = TaskView.ASSISTANT_PART_CLASS_MAP) {
        if (part.type === 'reasoning') {
            return TaskView.createReasoningPartHtml(part.rendered, false, part.elapsedSeconds);
        }
        return `<div class="${classMap[part.type] || ''}">${part.rendered || ''}</div>`;
    }

    renderAssistantParts(parts, classMap = TaskView.ASSISTANT_PART_CLASS_MAP) {
        return parts.map((part) => this.renderAssistantPart(part, classMap)).join('');
    }

    renderAssistantMessage(assistant_message, isLast = false) {
        const content = this.renderAssistantParts(assistant_message.content);
        const usageHtml = isLast ? TaskView.formatUsageHtml(assistant_message.usage, this._modelContextSize) : '';
        const html = `
        <div class="od-assistant-msg-container flex items-start">
            <div id='message-container-${assistant_message.message_id}' class="px-2 bg-transparent w-full">
                <div id='message-content-${assistant_message.message_id}'>
                    ${content}
                </div>
                ${usageHtml}
            </div>
        </div>
        `;
        return html;
    }

    createEmptyAssistantContainer(message_id) {
        return `
        <div class="od-assistant-msg-container flex items-start">
            <div id='message-container-${message_id}' class="px-2 bg-transparent w-full">
                <div id='message-content-${message_id}'>
                </div>
            </div>
        </div>
        `;
    }

    _removeUsageOutside(messageContainer) {
        this.getHistoryContainer()
            .querySelectorAll('.message-usage')
            .forEach((el) => {
                if (!messageContainer.contains(el)) {
                    el.remove();
                }
            });
    }

    _getHistoryMessageIndexById(messageId) {
        if (typeof messageId !== 'string' || messageId.length === 0) return -1;
        return this._historyMessages.findIndex((message) => message?.message_id === messageId);
    }

    _hasOlderHistory() {
        return this._historyRenderStartIndex > 0;
    }

    _isHistoryMessageBeforeRenderedWindow(messageId) {
        const index = this._getHistoryMessageIndexById(messageId);
        return index >= 0 && index < this._historyRenderStartIndex;
    }

    _renderHistoryRangeToHtml(startIndex, endIndex, options = {}) {
        const htmlParts = [];
        const start = Math.max(0, startIndex);
        const end = Math.min(endIndex, this._historyMessages.length);
        const usageAssistantIdx = options.usageAssistantIdx ?? -1;

        for (let i = start; i < end; i++) {
            const message = this._historyMessages[i];
            if (message.role === 'user') {
                if (!shouldRenderUserHistoryMessage(message)) continue;
                const parts = getRenderableUserParts(message, message.content);
                if (options.markRenderedUserParts) {
                    markRenderedUserParts(this._renderedUserParts, message.message_id, parts.length);
                }
                htmlParts.push(this.renderUserMessage(message));
            } else if (message.role === 'assistant') {
                if (!Array.isArray(message.content) || message.content.length === 0) continue;
                htmlParts.push(this.renderAssistantMessage(message, i === usageAssistantIdx));
            } else if (TaskView.isCompactBoundaryMessage(message)) {
                htmlParts.push(TaskView.renderCompactBoundary());
            }
            const goalEvaluationHtml = renderGoalEvaluationRecordsHtml(
                getGoalEvaluationRecordsForMessage(this._historyGoalEvaluationRecords, message),
                this.task_id
            );
            if (goalEvaluationHtml) {
                htmlParts.push(goalEvaluationHtml);
            }
        }

        return htmlParts.join('');
    }

    _renderInitialHistoryWindow(messages, options = {}) {
        this._historyMessages = Array.isArray(messages) ? messages : [];
        this._historyGoalEvaluationRecords = getGoalEvaluationRecords(options.goal);
        this._historyRenderStartIndex = TaskView.findHistoryBatchStart(
            this._historyMessages,
            this._historyMessages.length
        );

        const historyContainer = this.getHistoryContainer();
        const htmlParts = [
            this._renderHistoryRangeToHtml(this._historyRenderStartIndex, this._historyMessages.length, {
                markRenderedUserParts: true,
                usageAssistantIdx: options.usageAssistantIdx
            })
        ];
        const unanchoredGoalEvaluationHtml = renderGoalEvaluationRecordsHtml(
            getUnanchoredGoalEvaluationRecords(this._historyGoalEvaluationRecords, this._historyMessages),
            this.task_id
        );
        if (unanchoredGoalEvaluationHtml) {
            htmlParts.push(unanchoredGoalEvaluationHtml);
        }

        for (const message of this._historyMessages) {
            const supplementText = getGoalSupplementDisplayText(message);
            if (supplementText !== undefined) {
                this.removePendingGoalSupplementForText(supplementText);
            }
            if (isGoalEditReminderMessage(message)) {
                const goalId = getGoalEditReminderGoalId(message);
                if (goalId) {
                    this.removePendingGoalEditByGoalId(goalId);
                }
            }
        }

        for (const message of this._pendingGoalSupplementMessages) {
            htmlParts.push(this.renderPendingGoalSupplementMessage(message));
        }
        if (this._pendingGoalEditMessage?.taskId === this.task_id) {
            htmlParts.push(this.renderPendingGoalEditMessage(this._pendingGoalEditMessage));
        }

        historyContainer.innerHTML = htmlParts.join('');
        enhanceCodeBlocks(historyContainer);
        enhanceToolPreviewCards(historyContainer);
    }

    _loadOlderHistoryBatch(options = {}) {
        if (this._loadingOlderHistory || !this._hasOlderHistory()) return false;

        const previousStartIndex = this._historyRenderStartIndex;
        const nextStartIndex = TaskView.findHistoryBatchStart(this._historyMessages, previousStartIndex);
        if (nextStartIndex >= previousStartIndex) return false;

        const historyContainer = this.getHistoryContainer();
        const previousScrollHeight = historyContainer.scrollHeight;
        const previousScrollTop = historyContainer.scrollTop;

        this._loadingOlderHistory = true;
        try {
            const html = this._renderHistoryRangeToHtml(nextStartIndex, previousStartIndex, {
                markRenderedUserParts: true
            });
            this._historyRenderStartIndex = nextStartIndex;

            if (html) {
                const template = document.createElement('template');
                template.innerHTML = html;
                const insertedElements = Array.from(template.content.children);
                historyContainer.insertBefore(template.content, historyContainer.firstChild);

                for (const element of insertedElements) {
                    enhanceCodeBlocks(element);
                    enhanceToolPreviewCards(element);
                }
            }

            if (options.preserveScrollPosition !== false) {
                const scrollDelta = historyContainer.scrollHeight - previousScrollHeight;
                historyContainer.scrollTop = previousScrollTop + scrollDelta;
            }

            return true;
        } finally {
            this._loadingOlderHistory = false;
        }
    }

    _loadOlderHistoryFromScroll() {
        const historyContainer = this.getHistoryContainer();
        let loaded = false;
        let guard = 0;
        while (
            this._hasOlderHistory() &&
            historyContainer.scrollTop <= TASKVIEW_HISTORY_TOP_LOAD_THRESHOLD_PX &&
            guard < TASKVIEW_HISTORY_VIEWPORT_FILL_GUARD
        ) {
            if (!this._loadOlderHistoryBatch()) break;
            loaded = true;
            guard += 1;
        }
        return loaded;
    }

    _fillHistoryViewportIfNeeded() {
        const historyContainer = this.getHistoryContainer();
        if (historyContainer.clientHeight <= 0) return;

        let guard = 0;
        while (
            this._hasOlderHistory() &&
            historyContainer.scrollHeight <= historyContainer.clientHeight &&
            guard < TASKVIEW_HISTORY_VIEWPORT_FILL_GUARD
        ) {
            if (!this._loadOlderHistoryBatch({ preserveScrollPosition: false })) break;
            guard += 1;
        }
    }

    _applyHiddenUserProgressToHistory(progress) {
        const index = this._getHistoryMessageIndexById(progress.message_id);
        if (index < 0) return;
        const message = this._historyMessages[index];
        if (!message || message.role !== 'user') return;
        const parts = getRenderableUserParts(progress, progress.last_part ? [progress.last_part] : []);
        const partIndex = getProgressPartIndex(progress);
        if (!Array.isArray(message.content)) {
            message.content = [];
        }
        if (parts.length > 0) {
            message.content[partIndex] = parts[0];
        }
        if (progress.rawText) {
            message.rawText = progress.rawText;
        }
        if (progress.timestamp) {
            message.timestamp = progress.timestamp;
        }
    }

    _applyHiddenUserReplaceToHistory(progress) {
        const index = this._getHistoryMessageIndexById(progress.message_id);
        if (index < 0) return;
        const message = this._historyMessages[index];
        if (!message || message.role !== 'user') return;
        message.content = getRenderableUserParts(progress, progress.parts);
        if (progress.rawText) {
            message.rawText = progress.rawText;
        }
        if (progress.timestamp) {
            message.timestamp = progress.timestamp;
        }
    }

    _applyHiddenAssistantProgressToHistory(progress) {
        const index = this._getHistoryMessageIndexById(progress.message_id);
        if (index < 0) return;
        const message = this._historyMessages[index];
        if (!message || message.role !== 'assistant' || !progress.last_part) return;
        if (!Array.isArray(message.content)) {
            message.content = [];
        }
        message.content[getProgressPartIndex(progress)] = progress.last_part;
        if (TaskView.hasDisplayableUsage(progress.usage)) {
            message.usage = progress.usage;
        }
    }

    _applyHiddenAssistantReplaceToHistory(progress) {
        const index = this._getHistoryMessageIndexById(progress.message_id);
        if (index < 0) return;
        const message = this._historyMessages[index];
        if (!message || message.role !== 'assistant') return;
        message.content = Array.isArray(progress.parts) ? progress.parts : [];
        if (TaskView.hasDisplayableUsage(progress.usage)) {
            message.usage = progress.usage;
        }
    }

    _removeWaitingAssistantPlaceholder() {
        const waitingPlaceholder = this.getHistoryContainer().querySelector('.waiting-usage-placeholder');
        if (waitingPlaceholder) waitingPlaceholder.remove();
    }

    _showWaitingAssistantPlaceholder(options = {}) {
        const historyContainer = this.getHistoryContainer();
        const existingPlaceholder = historyContainer.querySelector('.waiting-usage-placeholder');
        if (!options.force && TaskView.hasAssistantOutputAfterLatestUser(historyContainer)) {
            existingPlaceholder?.remove();
            return;
        }
        if (existingPlaceholder) {
            historyContainer.appendChild(existingPlaceholder);
            return;
        }

        historyContainer.insertAdjacentHTML('beforeend', TaskView.createWaitingAssistantPlaceholderHtml());
    }

    static formatRetryStatusHtml(progress) {
        const remainingMs = Math.max(0, (progress.next_retry_at || Date.now()) - Date.now());
        const seconds = Math.ceil(remainingMs / 1000);
        const retryTime = new Date(progress.next_retry_at || Date.now()).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        const statusText =
            progress.status === 'retrying'
                ? `正在发起第 ${progress.attempt} 次重试...`
                : `已重试 ${progress.attempt} 次，下次重试 ${retryTime}（${seconds}s 后）`;
        const errorText = progress.error_message ? escapeHtml(progress.error_message) : '';
        const retryNowButton =
            progress.status === 'scheduled'
                ? `<button class="od-retry-now-btn ml-auto self-center inline-flex items-center gap-1 flex-shrink-0 rounded-md px-3 py-1.5 text-xs font-medium
                    bg-amber-200 text-amber-800
                    hover:bg-amber-300 active:bg-amber-400
                    transition-colors duration-150"
                    data-action="retry-now"
                    title="跳过等待，立即重试">
                    <i class="fa-solid fa-arrow-rotate-right text-[11px]"></i>立即重试
                  </button>`
                : '';

        return `
        <div class="od-task-retry-status my-2 mx-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-amber-700 text-xs" data-retry-status="true">
            <div class="flex items-center gap-2 font-medium">
                <i class="fa-solid fa-circle-notch fa-spin"></i>
                <span>LLM 请求自动重试</span>
                ${retryNowButton}
            </div>
            <div class="mt-1">${escapeHtml(statusText)}</div>
            ${errorText ? `<div class="mt-1 text-amber-700/80 break-words">上次错误: ${errorText}</div>` : ''}
        </div>
        `;
    }

    handleRetryProgress(progress) {
        const existing = this.querySelector('.od-task-retry-status');
        if (progress.status === 'cleared') {
            existing?.remove();
            return;
        }

        const html = TaskView.formatRetryStatusHtml(progress);
        if (existing) {
            existing.outerHTML = html;
        } else {
            this.getHistoryContainer().insertAdjacentHTML('beforeend', html);
        }

        // 绑定"立即重试"按钮事件
        if (progress.status === 'scheduled') {
            const btn = this.querySelector('.od-retry-now-btn');
            if (btn && !btn._boundRetryNow) {
                btn._boundRetryNow = true;
                btn.addEventListener('click', async () => {
                    btn.disabled = true;
                    btn.textContent = '重试中...';
                    try {
                        await window.taskManagerAPI.skipRetryDelay(this.task_id);
                    } catch (err) {
                        console.error('skipRetryDelay failed:', err);
                        btn.disabled = false;
                        btn.textContent = '立即重试';
                    }
                });
            }
        }
    }

    handleAssistantReplace(progress) {
        const history_container = this.getHistoryContainer();
        let message_container =
            this._messageContainerCache.get(progress.message_id) ||
            this.querySelector(`#message-container-${progress.message_id}`);

        if (!message_container && this._isHistoryMessageBeforeRenderedWindow(progress.message_id)) {
            this._applyHiddenAssistantReplaceToHistory(progress);
            return;
        }

        if (progress.parts.length === 0) {
            if (message_container) {
                const wrapper = message_container.closest('.od-assistant-msg-container');
                if (wrapper) {
                    wrapper.remove();
                } else {
                    message_container.remove();
                }
                this._messageContainerCache.delete(progress.message_id);
            }
            if (progress.task_status === 'running') {
                this._showWaitingAssistantPlaceholder();
            }
            return;
        }

        if (!message_container) {
            this._removeWaitingAssistantPlaceholder();
            history_container.insertAdjacentHTML('beforeend', this.createEmptyAssistantContainer(progress.message_id));
            message_container = this.querySelector(`#message-container-${progress.message_id}`);
            if (!message_container) return;
            this._messageContainerCache.set(progress.message_id, message_container);
        }

        const message_content = message_container.querySelector(`#message-content-${progress.message_id}`);
        if (!message_content) return;

        message_content.innerHTML = this.renderAssistantParts(progress.parts);
        enhanceCodeBlocks(message_content);
        enhanceToolPreviewCards(message_content);

        const usageEl = message_container.querySelector('.message-usage');
        if (TaskView.hasDisplayableUsage(progress.usage)) {
            this._removeUsageOutside(message_container);
            const usageHtml = TaskView.formatUsageHtml(progress.usage, this._modelContextSize, false);
            if (usageEl) {
                usageEl.outerHTML = usageHtml;
            } else {
                message_container.insertAdjacentHTML('beforeend', usageHtml);
            }
        } else if (usageEl) {
            usageEl.dataset.streaming = 'false';
            const spinnerEl = usageEl.querySelector('.usage-spinner');
            if (spinnerEl) {
                spinnerEl.style.display = 'none';
            }
        }
    }

    _renderAssistantProgress(progress, history_container) {
        if (!progress.last_part) return false;

        let message_container =
            this._messageContainerCache.get(progress.message_id) ||
            this.querySelector(`#message-container-${progress.message_id}`);
        const isNewMessage = !message_container;

        if (isNewMessage && this._isHistoryMessageBeforeRenderedWindow(progress.message_id)) {
            this._applyHiddenAssistantProgressToHistory(progress);
            return false;
        }

        if (isNewMessage) {
            this._removeWaitingAssistantPlaceholder();
            history_container.insertAdjacentHTML('beforeend', this.createEmptyAssistantContainer(progress.message_id));
            message_container = this.querySelector(`#message-container-${progress.message_id}`);
            if (!message_container) return false;
            this._messageContainerCache.set(progress.message_id, message_container);
        }

        const message_content = message_container.querySelector(`#message-content-${progress.message_id}`);
        if (!message_content) return false;

        const partIndex = getProgressPartIndex(progress);
        while (message_content.children.length <= partIndex) {
            if (progress.last_part.type === 'reasoning') {
                message_content.insertAdjacentHTML('beforeend', TaskView.createReasoningPartHtml('', true));
            } else {
                // Finalize any active reasoning blocks before inserting a new non-reasoning part
                message_content.querySelectorAll('.reasoning-block-od.reasoning-active').forEach((el) => {
                    TaskView.finalizeReasoningBlock(el);
                });
                message_content.insertAdjacentHTML(
                    'beforeend',
                    `<div class='${TaskView.ASSISTANT_PART_CLASS_MAP[progress.last_part.type]}'></div>`
                );
            }
        }

        const last_part_element = message_content.children[partIndex];
        if (!last_part_element) return false;

        if (progress.last_part.type === 'reasoning') {
            TaskView.updateReasoningPreview(last_part_element, progress.last_part.rendered || '');
        } else {
            last_part_element.innerHTML = progress.last_part.rendered || '';
        }

        if (progress.last_part.type === 'tool_call') {
            last_part_element.querySelectorAll('.terminal-tool-scroll').forEach((el) => {
                el.scrollTop = el.scrollHeight;
            });
            enhanceToolPreviewCards(last_part_element);
        }

        if (progress.last_part.type === 'text') {
            enhanceCodeBlocks(last_part_element);
        }

        const isStreaming = progress.task_status === 'running';
        const usageEl = message_container.querySelector('.message-usage');
        const usage = TaskView.hasDisplayableUsage(progress.usage) ? progress.usage : null;
        if (usageEl) {
            const prevPrompt = parseInt(usageEl.dataset.promptTokens || '0', 10);
            const prevCompletion = parseInt(usageEl.dataset.completionTokens || '0', 10);
            const prevTotal = parseInt(usageEl.dataset.totalTokens || '0', 10);
            const usageTokens = TaskView.getUsageDisplayTokens(usage);
            const promptTokens = usage ? usageTokens.promptTokens : prevPrompt;
            const completionTokens = usage ? usageTokens.completionTokens : prevCompletion;
            const totalTokens = usage ? usageTokens.totalTokens : prevTotal;
            if (usage) {
                this._removeUsageOutside(message_container);
            }
            const titleParts =
                totalTokens > 0 ? `输入: ${promptTokens}, 输出: ${completionTokens}, 总计: ${totalTokens}` : '';
            let ratioText = '';
            if (this._modelContextSize > 0 && totalTokens > 0) {
                const pct = ((totalTokens / this._modelContextSize) * 100).toFixed(1);
                ratioText = `, 上下文占比 ${pct}%`;
            }
            usageEl.title = titleParts;
            usageEl.dataset.promptTokens = String(promptTokens);
            usageEl.dataset.completionTokens = String(completionTokens);
            usageEl.dataset.totalTokens = String(totalTokens);
            usageEl.dataset.streaming = String(isStreaming);
            const spinnerEl = usageEl.querySelector('.usage-spinner');
            if (spinnerEl) {
                spinnerEl.style.display = isStreaming ? '' : 'none';
            }
            const textEl = usageEl.querySelector('.usage-text');
            if (textEl) {
                textEl.textContent = `已输出 ${completionTokens} 词, 总计 ${totalTokens} 词${ratioText}`;
            }
        } else if (usage) {
            this._removeUsageOutside(message_container);
            message_container.insertAdjacentHTML(
                'beforeend',
                TaskView.formatUsageHtml(usage, this._modelContextSize, isStreaming)
            );
        }

        return true;
    }

    tryScrollToEnd() {
        if (!this.auto_scrolling_to_bottom) {
            return;
        }
        if (this._scrollRafId !== null) return;
        this._scrollRafId = requestAnimationFrame(() => {
            this._scrollRafId = null;
            if (!this.auto_scrolling_to_bottom) return;
            const domElement = this.getHistoryContainer();
            const targetScrollTop = domElement.scrollHeight - domElement.clientHeight;
            // 仅在需要向下滚动时才设置 scrollTop，避免因布局抖动导致向上回跳
            if (targetScrollTop > domElement.scrollTop) {
                this._programmaticScrolling = true;
                domElement.scrollTop = targetScrollTop;
                // 使用 rAF 而非 setTimeout，将保护窗口从 150ms 缩短到 ~16ms
                // 避免 AI 快速输出时用户滚动被长时间屏蔽
                if (this._programmaticScrollTimer) cancelAnimationFrame(this._programmaticScrollTimer);
                this._programmaticScrollTimer = requestAnimationFrame(() => {
                    this._programmaticScrolling = false;
                    this._programmaticScrollTimer = null;
                });
            }
        });
    }

    _findGoalMessageTarget(messageId) {
        const escapedId =
            typeof messageId === 'string' &&
            messageId.length > 0 &&
            typeof CSS !== 'undefined' &&
            typeof CSS.escape === 'function'
                ? CSS.escape(messageId)
                : typeof messageId === 'string'
                  ? messageId.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
                  : '';
        if (escapedId) {
            const selectors = [
                `#user-msg-${escapedId}`,
                `#message-container-${escapedId}`,
                `#message-content-${escapedId}`,
                `#message-${escapedId}`
            ];
            for (const selector of selectors) {
                const target = this.querySelector(selector);
                if (target) return target;
            }
        }
        return null;
    }

    _scrollToGoalMessage(messageId, options = {}) {
        const target = this._findGoalMessageTarget(messageId);
        if (!target) return false;

        this.setAutoScrollingToBottom(false);
        if (typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({
                behavior: options.behavior || 'smooth',
                block: options.block || 'center'
            });
        }

        const highlightTarget =
            target.querySelector('.od-user-msg') ||
            target.querySelector(`[id^="message-content-"]`) ||
            target.querySelector(`[id^="message-"]`) ||
            target;
        const originalOutline = highlightTarget.style.outline;
        const originalBoxShadow = highlightTarget.style.boxShadow;
        highlightTarget.style.outline = '2px solid rgba(124, 77, 255, 0.85)';
        highlightTarget.style.boxShadow = '0 0 0 5px rgba(124, 77, 255, 0.16)';
        setTimeout(() => {
            highlightTarget.style.outline = originalOutline;
            highlightTarget.style.boxShadow = originalBoxShadow;
        }, 1400);
        return true;
    }

    _ensureHistoryLoadedThroughMessage(messageId) {
        const messageIndex = this._getHistoryMessageIndexById(messageId);
        if (messageIndex < 0) return false;

        let guard = 0;
        while (
            messageIndex < this._historyRenderStartIndex &&
            this._hasOlderHistory() &&
            guard < this._historyMessages.length
        ) {
            const previousStartIndex = this._historyRenderStartIndex;
            if (!this._loadOlderHistoryBatch({ preserveScrollPosition: false })) break;
            if (this._historyRenderStartIndex === previousStartIndex) break;
            guard += 1;
        }

        return messageIndex >= this._historyRenderStartIndex;
    }

    async scrollToMessage(messageId, options = {}) {
        if (typeof messageId !== 'string' || messageId.length === 0) return false;
        if (this._scrollToGoalMessage(messageId, options)) return true;
        if (!this._ensureHistoryLoadedThroughMessage(messageId)) return false;
        return this._scrollToGoalMessage(messageId, options);
    }

    _handleGoalMessageAnchor = (event) => {
        const messageId = event?.detail?.messageId;
        if (typeof messageId !== 'string' || messageId.length === 0) return;
        void this.scrollToMessage(messageId).then((found) => {
            if (found) return;
            return this.reload().then(() => this.scrollToMessage(messageId));
        });
    };

    async reload() {
        this._reloading = true;
        const version = ++this._reloadVersion;
        let shouldAutoSendQueuedMessage = false;
        try {
            const task_state = await window.taskManagerAPI.getFullTask(this.task_id);
            // 如果在 await 期间有更新的 reload() 被触发，丢弃本次操作
            if (version !== this._reloadVersion) return;

            this.task_status = task_state.task_status || 'waiting';
            this._currentGoal = mergeGoalSummary(this._currentGoal, task_state.goal || null);
            this._syncGoalLiveRefresh();
            const artifacts = this.querySelector(`#task-${this.task_id}-artifacts`);
            if (artifacts && typeof artifacts.setGoalState === 'function') {
                this._syncArtifactsGoalState(this._currentGoal);
                if (this._currentGoal && !this._rightSidebarExpanded) {
                    const resizer = this.querySelector(`#task-${this.task_id}-resizer`);
                    this._expandRightSidebar(artifacts, resizer);
                }
            }
            this.updateStopButtonVisibility();
            this._messageContainerCache.clear();
            this._renderedUserParts.clear();

            if (this._toolbar && task_state.task_name) {
                this._taskName = task_state.task_name;
                this._toolbar.setToolbarTitle(task_state.task_name);
            }
            if (this._toolbar && typeof task_state.workspace === 'string' && task_state.workspace.length > 0) {
                this._taskWorkspace = task_state.workspace;
                this._toolbar.setToolbarSubtitle(
                    task_state.workspace,
                    () => {
                        void this._pickWorkspace();
                    },
                    taskViewT('workspace.taskLabel')
                );
            }

            const input_widget = this.querySelector(`#task-${this.task_id}-input`);
            if (input_widget) {
                input_widget.taskId = this.task_id;
                if (task_state.model) {
                    input_widget.setModel(task_state.model);
                }
                if (task_state.reasoningEffort !== undefined) {
                    input_widget.setReasoningEffort(task_state.reasoningEffort);
                }
                input_widget.selectedExecutionNodeId = task_state.executionNodeId || '';
                input_widget.selectedExecutionNodeLabel = task_state.executionNodeLabel || '';
                input_widget._updateNodeButton?.();
                if (task_state.activeModeId) {
                    input_widget.selectedModeId = task_state.activeModeId;
                    input_widget._updateModeButton?.();
                }
            }

            // 非阻塞获取上下文大小，避免延迟首次渲染
            this._refreshModelContextSize(task_state.model).then(() => this._updateLastUsageRatio());

            const messages = task_state.chat_context.messages;
            const lastAssistantIdx = (() => {
                for (let i = messages.length - 1; i >= 0; i--) {
                    if (messages[i].role === 'assistant') return i;
                }
                return -1;
            })();
            const usageAssistantIdx = (() => {
                for (let i = messages.length - 1; i >= 0; i--) {
                    const message = messages[i];
                    if (
                        message.role === 'assistant' &&
                        Array.isArray(message.content) &&
                        message.content.length > 0 &&
                        TaskView.hasDisplayableUsage(message.usage)
                    ) {
                        return i;
                    }
                }
                return -1;
            })();
            const lastAssistantMessage = lastAssistantIdx >= 0 ? messages[lastAssistantIdx] : null;
            const isWaitingForAssistant =
                this.task_status === 'running' &&
                (lastAssistantIdx === -1 ||
                    !Array.isArray(lastAssistantMessage?.content) ||
                    lastAssistantMessage.content.length === 0);
            this._renderInitialHistoryWindow(messages, {
                goal: task_state.goal,
                usageAssistantIdx
            });
            if (isWaitingForAssistant) {
                this._showWaitingAssistantPlaceholder();
            }

            this._fillHistoryViewportIfNeeded();
            this.tryScrollToEnd();

            // 刷新任务计划面板数据（不影响侧边栏展开状态）
            this._refreshTaskTodos();
            this._refreshGlobalTodos();

            // 刷新变更面板
            const sidebar = this._getRightSidebarEl();
            if (sidebar && typeof sidebar.refreshChanges === 'function') {
                sidebar.refreshChanges();
            }

            if (this.task_status !== 'running' && this.messageQueue.length > 0 && !this._immediateQueueSending) {
                shouldAutoSendQueuedMessage = true;
            }
        } finally {
            // 只有最新的 reload 才能重置标志，避免过期 reload 提前解除守卫
            if (version === this._reloadVersion) {
                this._reloading = false;
                if (shouldAutoSendQueuedMessage) {
                    this._autoSendQueueMessages();
                }
            }
        }
    }

    _renderUserProgress(progress, history_container) {
        if (isGoalEditReminderMessage(progress)) {
            const goalId = getGoalEditReminderGoalId(progress);
            if (goalId) {
                this.removePendingGoalEditByGoalId(goalId);
            }
        }
        const parts = getRenderableUserParts(progress, progress.last_part ? [progress.last_part] : []);
        if (!shouldRenderUserHistoryMessage(progress) || parts.length === 0) return false;
        const supplementText = getGoalSupplementDisplayText(progress);
        if (supplementText !== undefined) {
            this.removePendingGoalSupplementForText(supplementText);
        }

        const renderedSet = getRenderedUserPartSet(this._renderedUserParts, progress.message_id);
        const partIndex = getProgressPartIndex(progress);
        if (renderedSet.has(partIndex)) return false;
        renderedSet.add(partIndex);

        let container = this.querySelector(`#user-msg-${progress.message_id}`);
        if (!container) {
            history_container.insertAdjacentHTML(
                'beforeend',
                `<div id="user-msg-${escapeHtml(progress.message_id)}" class="od-user-msg-container" data-message-id="${escapeHtml(progress.message_id)}" data-raw-text="${escapeHtml(progress.rawText || '')}"></div>`
            );
            container = this.querySelector(`#user-msg-${progress.message_id}`);
        }
        if (!container) return false;

        const part = parts[0];
        container.insertAdjacentHTML('beforeend', this.renderUserPart(part));
        if (progress.isLastPart) {
            const timeHtml = progress.timestamp
                ? `<div class="text-right text-[10px] text-gray-400 mt-0.5 mr-1">${TaskView.formatRelativeTime(progress.timestamp)}</div>`
                : '';
            if (timeHtml) container.insertAdjacentHTML('beforeend', timeHtml);
        }
        if (progress.task_status === 'running') {
            this._showWaitingAssistantPlaceholder();
        }
        return true;
    }

    /** 渲染目标评估进度和结果。 */
    _renderGoalEvalProgress(progress) {
        const historyContainer = this.getHistoryContainer();
        const selectorId = getGoalEvalSelectorId(progress);
        const el = historyContainer.querySelector(`#${selectorId}`);

        const html = renderGoalEvalProgressHtml(progress, selectorId);

        if (el) {
            el.outerHTML = html;
        } else {
            insertGoalEvalHtml(
                historyContainer,
                findRenderedMessageAnchor(this, progress.anchorMessageId),
                html,
                progress
            );
        }
        this.tryScrollToEnd();
    }

    _syncArtifactsGoalEvalProgress(progress, options = {}) {
        const artifacts = this._getRightSidebarEl();
        if (!artifacts || typeof artifacts.setGoalEvalProgress !== 'function') return;
        artifacts.setGoalEvalProgress(progress);
        if (options.autoExpand) {
            this._ensureRightSidebarOpen();
        }
    }

    _handleGoalEvalProgress(progress, options = {}) {
        if (options.renderToConversation !== false) {
            this._renderGoalEvalProgress(progress);
        }
        this._syncArtifactsGoalEvalProgress(progress, { autoExpand: progress.phase === 'start' });
        if (progress.phase === 'end') {
            this._scheduleGoalRefresh();
        }
    }

    async _refreshModelContextSize(modelAlias) {
        if (modelAlias && modelAlias === this._contextSizeModel) return;
        try {
            const size = await window.taskManagerAPI.getModelContextSize(modelAlias || null);
            this._modelContextSize = size || 0;
            this._contextSizeModel = modelAlias || null;
        } catch {
            this._modelContextSize = 0;
        }
    }

    _updateLastUsageRatio() {
        const lastUsage = this.getHistoryContainer().querySelector('.message-usage');
        if (!lastUsage) return;
        const completionTokens = parseInt(lastUsage.dataset.completionTokens || '0', 10);
        const totalTokens = parseInt(lastUsage.dataset.totalTokens || '0', 10);
        let ratioText = '';
        if (this._modelContextSize > 0 && totalTokens > 0) {
            const pct = ((totalTokens / this._modelContextSize) * 100).toFixed(1);
            ratioText = `, 上下文占比 ${pct}%`;
        }
        const textEl = lastUsage.querySelector('.usage-text');
        if (textEl) {
            textEl.textContent = `已输出 ${completionTokens} 词, 总计 ${totalTokens} 词${ratioText}`;
        }
    }

    static renderCompactBoundary() {
        return `
        <div class="flex items-center my-6 select-none">
            <div class="flex-grow border-t border-dashed border-amber-300/60"></div>
            <span class="mx-4 text-xs text-amber-500/80 font-medium tracking-wide flex items-center gap-1.5">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 9l6 6 6-6"/>
                </svg>
                上下文已压缩
            </span>
            <div class="flex-grow border-t border-dashed border-amber-300/60"></div>
        </div>`;
    }

    _hasActiveGoal() {
        return this._currentGoal?.status === 'active';
    }

    _isTaskInputRunning() {
        const inputWidget = this.querySelector(`#task-${this.task_id}-input`);
        return this.task_status === 'running' || inputWidget?.isRunning === true;
    }

    _syncArtifactsGoalState(goal, options = {}) {
        const artifacts = this._getRightSidebarEl();
        if (!artifacts || typeof artifacts.setGoalState !== 'function') return false;
        const hadGoalSuggestion = typeof artifacts.hasGoalSuggestion === 'function' && artifacts.hasGoalSuggestion();
        artifacts.setGoalState(goal);
        const hasGoalSuggestion = typeof artifacts.hasGoalSuggestion === 'function' && artifacts.hasGoalSuggestion();
        const revealedGoalSuggestion = !hadGoalSuggestion && hasGoalSuggestion;
        if (options.autoExpandForGoalSuggestion && revealedGoalSuggestion) {
            this._ensureRightSidebarOpen();
        }
        return revealedGoalSuggestion;
    }

    _syncArtifactsTaskTodos(todos, options = {}) {
        const artifacts = this._getRightSidebarEl();
        if (!artifacts || typeof artifacts.setTaskTodos !== 'function') return false;
        const hadGoalSuggestion = typeof artifacts.hasGoalSuggestion === 'function' && artifacts.hasGoalSuggestion();
        artifacts.setTaskTodos(todos);
        const hasGoalSuggestion = typeof artifacts.hasGoalSuggestion === 'function' && artifacts.hasGoalSuggestion();
        const revealedGoalSuggestion = !hadGoalSuggestion && hasGoalSuggestion;
        if (options.autoExpandForGoalSuggestion && revealedGoalSuggestion) {
            this._ensureRightSidebarOpen();
        }
        return revealedGoalSuggestion;
    }

    async _refreshGoalSummary() {
        if (!this.task_id) return undefined;
        try {
            const result = await window.taskManagerAPI.getGoalStatus(this.task_id);
            const goal = getGoalSummaryFromStatusResult(result);
            if (goal) {
                this._currentGoal = mergeGoalSummary(this._currentGoal, goal);
                this._syncGoalLiveRefresh();
                this._syncArtifactsGoalState(this._currentGoal, { autoExpandForGoalSuggestion: true });
                this.updateStopButtonVisibility();
            }
            return goal;
        } catch {
            return undefined;
        }
    }

    async _isActiveGoalRunningNow() {
        if (isGoalRunningInput(this.task_status, this._currentGoal?.status)) {
            return true;
        }
        if (!this._isTaskInputRunning()) {
            return false;
        }
        const goal = await this._refreshGoalSummary();
        return goal?.status === 'active';
    }

    async _handleActiveGoalInput(detail, options = {}) {
        const goal = this._currentGoal?.status === 'active' ? this._currentGoal : await this._refreshGoalSummary();
        if (goal?.status !== 'active') {
            return 'not-goal';
        }
        if (!isTextOnlyGoalSupplementDetail(detail)) {
            if (options.alertUnsupported) {
                window.alert(taskViewT('goal.supplement.images_unsupported'));
            }
            return 'unsupported';
        }
        return (await this._submitGoalSupplement(detail)) ? 'submitted' : 'failed';
    }

    async _handleRunningGoalInput(detail, options = {}) {
        const activeGoalRunning = await this._isActiveGoalRunningNow();
        if (!activeGoalRunning) {
            return 'not-goal';
        }
        return this._handleActiveGoalInput(detail, options);
    }

    async _submitGoalSupplement(detail) {
        try {
            const result = await window.taskManagerAPI.addGoalSupplement(this.task_id, detail.message);
            if (result?.ok === false) {
                window.alert(taskViewT(result.messageKey || 'goal.error.unknown', result.messageArgs || {}));
                return false;
            }
            this._currentGoal = result?.summary
                ? mergeGoalSummary(this._currentGoal, result.summary)
                : this._currentGoal;
            this._syncGoalLiveRefresh();
            this._syncArtifactsGoalState(this._currentGoal);
            this.showPendingGoalSupplement(detail.message);
            return true;
        } catch (error) {
            console.error('Failed to add goal supplement:', error);
            return false;
        }
    }

    /**
     * 节流刷新 goal 面板（0.5s 一次）。
     * 在 subscribeTaskUpdate 回调中调用，让 token 进度条实时推进。
     * 不依赖 progress.usage：很多 provider 流式过程中不返回 usage。
     */
    _scheduleGoalRefresh() {
        if (this._goalRefreshTimer) {
            this._goalRefreshPending = true;
            return;
        }
        this._doGoalRefresh();
        this._goalRefreshTimer = setTimeout(() => {
            this._goalRefreshTimer = null;
            if (this._goalRefreshPending) {
                this._goalRefreshPending = false;
                this._scheduleGoalRefresh();
            }
        }, 500);
    }

    _syncGoalLiveRefresh() {
        const shouldRefresh = this._currentGoal?.status === 'active';
        if (shouldRefresh && !this._goalLiveRefreshTimer) {
            this._goalLiveRefreshTimer = window.setInterval(() => {
                if (this.style.display === 'none' || this.hasAttribute('data-background')) return;
                this._scheduleGoalRefresh();
            }, 1000);
        } else if (!shouldRefresh && this._goalLiveRefreshTimer) {
            clearInterval(this._goalLiveRefreshTimer);
            this._goalLiveRefreshTimer = null;
        }
    }

    async _doGoalRefresh() {
        if (!this.task_id || !this._currentGoal) return;
        try {
            const result = await window.taskManagerAPI.getGoalStatus(this.task_id);
            const statusView = result?.data?.summary ? result.data : result;
            if (!statusView?.summary) return;
            const goal = statusView.summary;
            this._currentGoal = mergeGoalSummary(this._currentGoal, goal);
            this._syncGoalLiveRefresh();
            this._syncArtifactsGoalState(this._currentGoal, { autoExpandForGoalSuggestion: true });
            this.updateStopButtonVisibility();
        } catch {
            // 非致命错误，goal 面板会在下次 reload 时同步
        }
    }

    async _pauseActiveGoal() {
        const result = await window.taskManagerAPI.pauseGoal(this.task_id);
        if (result?.ok === false) {
            window.alert(taskViewT(result.messageKey || 'goal.error.unknown', result.messageArgs || {}));
            return false;
        }
        this._currentGoal = result?.summary
            ? mergeGoalSummary(this._currentGoal, result.summary)
            : this._currentGoal
              ? { ...this._currentGoal, status: 'paused' }
              : null;
        this._syncGoalLiveRefresh();
        this._syncArtifactsGoalState(this._currentGoal);
        return true;
    }

    updateStopButtonVisibility() {
        const inputWidget = this.querySelector(`#task-${this.task_id}-input`);
        if (inputWidget) {
            if (typeof inputWidget.setRunningInputMode === 'function') {
                inputWidget.setRunningInputMode('queue');
            }
            if (this.task_status === 'running') {
                inputWidget.setDisabled(true);
                inputWidget.setStopMode(true, async () => {
                    try {
                        if (this._hasActiveGoal()) {
                            const paused = await this._pauseActiveGoal();
                            if (!paused) return;
                        } else {
                            await window.taskManagerAPI.stopTask(this.task_id);
                        }
                        this.task_status = 'stopped';
                        // 手动停止后立即完成所有活跃 reasoning 块的计时，
                        // 避免因后端 _turnRunning=true 时延迟发送的
                        // sendSubscriptionFeedback 被 _handleTaskStatusUpdate
                        // 跳过（前端 status 已为 'stopped'）而导致计时器永久运行。
                        const historyContainer = this.getHistoryContainer();
                        if (historyContainer) {
                            historyContainer
                                .querySelectorAll('.reasoning-block-od.reasoning-active')
                                .forEach((el) => TaskView.finalizeReasoningBlock(el));
                            // 手动停止后移除等待占位和 spinner，
                            // 避免因前端提前设置 stopped 导致后续
                            // _handleTaskStatusUpdate 返回 false 而跳过清理。
                            const waitingPlaceholder = historyContainer.querySelector('.waiting-usage-placeholder');
                            if (waitingPlaceholder) waitingPlaceholder.remove();
                            historyContainer.querySelectorAll('.usage-spinner').forEach((el) => {
                                el.style.display = 'none';
                            });
                        }
                        this.updateStopButtonVisibility();
                        // 手动停止后启动浏览器空闲回收定时器，
                        // 避免因状态已提前设为 stopped 导致订阅回调跳过定时器启动
                        this._startBrowserIdleTimer();
                        // 手动停止后尝试自动发送队列中的消息（非"立即发送"流程时）
                        if (!this._immediateQueueSending) {
                            this._autoSendQueueMessages();
                        }
                    } catch (error) {
                        console.error('Failed to stop task:', error);
                    }
                });
            } else {
                inputWidget.setDisabled(false);
                inputWidget.setStopMode(false);
            }
            // 同步 slash command 上下文
            inputWidget.setSlashCommandContext({
                globalControlAPI: window.globalControlAPI,
                taskManagerAPI: window.taskManagerAPI,
                currentTaskId: this.task_id,
                clearMessageQueue: () => {
                    this.messageQueue = [];
                    this._updateMessageQueuePanel();
                }
            });
        }
        this._updateMessageQueuePanel();
    }

    /**
     * 添加消息到队列
     * @param {Object} detail 消息详情
     */
    addToMessageQueue(detail) {
        const queueItem = {
            id: crypto.randomUUID(),
            message: detail.message || '',
            attachedFilePaths: detail.attachedFilePaths || [],
            attachedImages: detail.attachedImages || [],
            selectedModel: detail.selectedModel,
            reasoningEffort: detail.reasoningEffort,
            selectedExecutionNodeId: detail.selectedExecutionNodeId
        };
        this.messageQueue.push(queueItem);
        this._updateMessageQueuePanel();
    }

    /**
     * 从队列中删除消息
     * @param {string} id 消息 ID
     */
    removeFromMessageQueue(id) {
        this.messageQueue = this.messageQueue.filter((item) => item.id !== id);
        this._updateMessageQueuePanel();
    }

    /**
     * 立即发送队列中的消息（打断当前任务）
     * @param {string} id 消息 ID
     */
    async sendQueueMessageImmediately(id) {
        const item = this.messageQueue.find((q) => q.id === id);
        if (!item) return;
        if (this._immediateQueueSending) return;

        const goalInputResult = await this._handleRunningGoalInput(item, { alertUnsupported: true });
        if (goalInputResult === 'submitted') {
            this.removeFromMessageQueue(id);
            return;
        }
        if (goalInputResult === 'unsupported' || goalInputResult === 'failed') {
            return;
        }

        this._immediateQueueSending = true;
        this.removeFromMessageQueue(id);

        // 停止当前任务
        if (this.task_status === 'running') {
            try {
                await window.taskManagerAPI.stopTask(this.task_id);
            } catch (error) {
                console.error('Failed to stop task for queue message:', error);
                this._immediateQueueSending = false;
                return;
            }
        }

        try {
            await window.taskManagerAPI.submitMessage(this.task_id, {
                message: item.message,
                attachedFilePaths: item.attachedFilePaths,
                attachedImages: item.attachedImages,
                selectedModel: item.selectedModel,
                reasoningEffort: item.reasoningEffort,
                selectedExecutionNodeId: item.selectedExecutionNodeId ?? null
            });
        } catch (error) {
            console.error('Failed to submit queue message immediately:', error);
            // 即使失败了也要重置标志位，防止永久阻塞自动发送
        } finally {
            this._immediateQueueSending = false;
        }

        // 若提交的任务在 await 期间已经完成，订阅回调可能因
        // _immediateQueueSending 为 true 而跳过了自动发送。
        // 延迟到下一轮事件循环检查，此时 task_status 已由订阅回调更新。
        setTimeout(() => {
            if (this.task_status !== 'running' && this.messageQueue.length > 0) {
                this._autoSendQueueMessages();
            }
        }, 100);
    }

    /**
     * 编辑队列中的消息（填充到输入框）
     * @param {Object} item 队列消息项
     */
    editQueueMessage(item) {
        const inputWidget = this.querySelector(`#task-${this.task_id}-input`);
        if (!inputWidget) return;

        // 从队列中删除
        this.removeFromMessageQueue(item.id);

        // 填充到输入框
        inputWidget.setText(item.message);
        if (item.attachedFilePaths && item.attachedFilePaths.length > 0) {
            inputWidget.attachedFilePaths = [...item.attachedFilePaths];
            inputWidget.render();
        }
        if (item.attachedImages && item.attachedImages.length > 0) {
            // 注意：attachedImages 是 dataUrl 格式，需要转换为 {dataUrl, name} 格式
            item.attachedImages.forEach((dataUrl, idx) => {
                inputWidget.addImage(dataUrl, `图片 ${idx + 1}`);
            });
        }
        inputWidget.focus();
    }

    /**
     * 任务结束时自动发送队列中的下一条消息。
     * 由订阅回调或 reload() 兜底在任务已经非 running 时调用。
     */
    _autoSendQueueMessages() {
        if (this.messageQueue.length === 0) return;
        if (this.task_status === 'running') return;
        // "立即发送"流程进行中（stopTask → submitMessage），跳过
        if (this._immediateQueueSending) return;

        const item = this.messageQueue.shift();
        this._updateMessageQueuePanel();

        // 立即同步状态为 running，防止用户在 submitMessage 异步完成前
        // 通过正常 submit 路径再次发送消息，造成竞态
        this.task_status = 'running';
        this._cancelBrowserIdleTimer();
        this.updateStopButtonVisibility();

        window.taskManagerAPI
            .submitMessage(this.task_id, {
                message: item.message,
                attachedFilePaths: item.attachedFilePaths,
                attachedImages: item.attachedImages,
                selectedModel: item.selectedModel,
                reasoningEffort: item.reasoningEffort,
                selectedExecutionNodeId: item.selectedExecutionNodeId ?? null
            })
            .catch((error) => {
                console.error('Failed to auto-submit queued message:', error);
                this.task_status = 'stopped';
                this.updateStopButtonVisibility();
                this._startBrowserIdleTimer();
            });
    }

    /**
     * 处理任务状态迁移。隐藏的 task-view 也必须执行这里的逻辑，
     * 否则后台任务结束时无法自动消费消息队列。
     * @param {string | undefined} nextStatus
     * @returns {boolean} 状态是否发生变化
     */
    _handleTaskStatusUpdate(nextStatus) {
        if (!nextStatus || nextStatus === this.task_status) return false;

        const wasRunning = this.task_status === 'running';
        this.task_status = nextStatus;
        this.updateStopButtonVisibility();

        if (this.task_status === 'running') {
            this._cancelBrowserIdleTimer();
            return true;
        }

        if (wasRunning && !this._immediateQueueSending && !this._reloading) {
            this._autoSendQueueMessages();
        }

        if (this.task_status !== 'running') {
            this._startBrowserIdleTimer();
        }

        return true;
    }

    _shouldSuppressIncrementalRender() {
        return this._reloading || this.style.display === 'none' || this.hasAttribute('data-background');
    }

    /**
     * 更新消息队列面板显示
     */
    _updateMessageQueuePanel() {
        const panel = this.querySelector('#message-queue-panel');
        if (!panel) return;

        panel.setQueue(this.messageQueue, {
            activeGoalRunning: this.task_status === 'running' && this._hasActiveGoal()
        });
    }

    _toggleRightSidebar() {
        const rightSidebar = this.querySelector(`#task-${this.task_id}-artifacts`);
        const resizer = this.querySelector(`#task-${this.task_id}-resizer`);
        if (!rightSidebar) return;

        const isExpanded = !this._isRightSidebarHidden(rightSidebar);
        if (isExpanded) {
            this._collapseRightSidebar(rightSidebar, resizer);
        } else {
            this._expandRightSidebar(rightSidebar, resizer);
        }
        this._updateSidebarToggleIcon(!isExpanded);
    }

    _expandRightSidebar(rightSidebar, resizer) {
        const targetWidth = this._rightSidebarWidth || DEFAULT_RIGHT_SIDEBAR_WIDTH;
        this._restoreRightSidebarFromOffscreen(rightSidebar);
        rightSidebar.style.display = '';
        rightSidebar.style.width = '0px';
        rightSidebar.style.opacity = '0';
        rightSidebar.style.overflow = 'hidden';
        if (resizer) {
            resizer.style.display = '';
            resizer.style.opacity = '0';
        }

        // 强制浏览器回流，确保初始状态（width:0）被记录
        void rightSidebar.offsetWidth;

        rightSidebar.style.transition =
            'width 280ms cubic-bezier(0.4, 0, 0.2, 1), opacity 280ms cubic-bezier(0.4, 0, 0.2, 1)';
        if (resizer) {
            resizer.style.transition = 'opacity 280ms ease';
        }
        rightSidebar.style.width = targetWidth + 'px';
        rightSidebar.style.opacity = '1';
        if (resizer) resizer.style.opacity = '1';

        const onEnd = (e) => {
            if (e.propertyName !== 'width') return;
            rightSidebar.removeEventListener('transitionend', onEnd);
            rightSidebar.style.overflow = '';
            rightSidebar.style.transition = '';
            if (resizer) resizer.style.transition = '';
        };
        rightSidebar.addEventListener('transitionend', onEnd);

        this._rightSidebarExpanded = true;
        this._autoSwitchTabIfEmpty(rightSidebar);

        // 侧边栏展开时隐藏画中画浮窗
        if (this._browserPip) {
            this._browserPip.hide();
        }
    }

    _collapseRightSidebar(rightSidebar, resizer) {
        // 侧边栏收起时关闭编辑器覆盖层
        if (typeof rightSidebar.closeEditor === 'function') {
            rightSidebar.closeEditor();
        }

        this._rightSidebarWidth =
            parseInt(rightSidebar.style.width) || rightSidebar.offsetWidth || DEFAULT_RIGHT_SIDEBAR_WIDTH;
        rightSidebar.style.overflow = 'hidden';
        rightSidebar.style.transition =
            'width 280ms cubic-bezier(0.4, 0, 0.2, 1), opacity 280ms cubic-bezier(0.4, 0, 0.2, 1)';
        if (resizer) {
            resizer.style.transition = 'opacity 200ms ease';
            resizer.style.opacity = '0';
        }

        requestAnimationFrame(() => {
            rightSidebar.style.width = '0px';
            rightSidebar.style.opacity = '0';
        });

        const onEnd = (e) => {
            if (e.propertyName !== 'width') return;
            rightSidebar.removeEventListener('transitionend', onEnd);
            // 不使用 display:none — 使用 offscreen 定位，保持 webview 活跃
            // （display:none 会导致 Chromium 暂停 webview 渲染，使 CDP 操作卡住、截图无法更新）
            this._hideRightSidebarOffscreen(rightSidebar);
            rightSidebar.style.overflow = '';
            rightSidebar.style.transition = '';
            rightSidebar.style.opacity = '';
            if (resizer) {
                resizer.style.display = 'none';
                resizer.style.transition = '';
                resizer.style.opacity = '';
            }
        };
        rightSidebar.addEventListener('transitionend', onEnd);

        this._rightSidebarExpanded = false;

        // 侧边栏收起时重置画中画关闭状态（新的折叠周期，允许重新弹出）
        if (this._browserPip) {
            this._browserPip.resetClosed();
        }
        // 若浏览器已被使用，显示画中画浮窗
        this._showBrowserPipIfNeeded();
    }

    _autoSwitchTabIfEmpty(_sidebar) {
        // Tab visibility is now managed dynamically inside TaskArtifacts
    }

    /**
     * 初始化浏览器画中画浮窗。在 init() 渲染完成后调用。
     */
    _initBrowserPip() {
        // 浮窗挂载在聊天历史滚动区域的外层 relative 容器内
        const chatWrapper = this.querySelector('#taskview-chat-history')?.parentElement;
        if (!chatWrapper) return;

        this._browserPip = new BrowserPip(chatWrapper, {
            onRestore: () => {
                if (this._browserPip) this._browserPip.hide();
                const sidebar = this._getRightSidebarEl();
                if (sidebar && typeof sidebar.ensureBrowserReady === 'function') {
                    sidebar.ensureBrowserReady();
                }
                this._forceExpandRightSidebar();
                this._updateSidebarToggleIcon(true);
            },
            capturePage: async () => {
                const sidebar = this._getRightSidebarEl();
                if (!sidebar || typeof sidebar.browserCapturePage !== 'function') return null;
                return sidebar.browserCapturePage();
            },
            getTabCount: () => {
                const sidebar = this._getRightSidebarEl();
                if (!sidebar || typeof sidebar.browserGetTabCount !== 'function') return 0;
                return sidebar.browserGetTabCount();
            },
            getActiveTabTitle: () => {
                const sidebar = this._getRightSidebarEl();
                if (!sidebar || typeof sidebar.browserGetActiveTabTitle !== 'function') return '';
                return sidebar.browserGetActiveTabTitle();
            },
            getActiveTabUrl: () => {
                const sidebar = this._getRightSidebarEl();
                if (!sidebar || typeof sidebar.browserGetActiveTabUrl !== 'function') return '';
                return sidebar.browserGetActiveTabUrl();
            }
        });
    }

    /**
     * 若侧边栏已收起且浏览器已被使用（且浮窗未被手动关闭），则显示画中画浮窗。
     */
    _showBrowserPipIfNeeded() {
        const sidebar = this._getRightSidebarEl();
        if (!sidebar || typeof sidebar.isBrowserVisible !== 'function') return;
        if (!sidebar.isBrowserVisible()) return;

        if (!this._browserPip) {
            this._initBrowserPip();
        }
        if (this._browserPip && !this._browserPip.isClosed()) {
            this._browserPip.show();
        }
    }

    /**
     * 启动浏览器空闲销毁倒计时。任务结束后调用，
     * 5 分钟内无新请求则销毁浏览器实例释放内存。
     */
    _startBrowserIdleTimer() {
        this._cancelBrowserIdleTimer();
        const sidebar = this._getRightSidebarEl();
        if (!sidebar || typeof sidebar.isBrowserVisible !== 'function' || !sidebar.isBrowserVisible()) return;
        this._browserIdleTimer = setTimeout(() => {
            this._browserIdleTimer = null;
            const el = this._getRightSidebarEl();
            if (el && typeof el.destroyBrowser === 'function') {
                el.destroyBrowser();
            }
            if (this._browserPip) {
                this._browserPip.destroy();
                this._browserPip = null;
            }
        }, BROWSER_IDLE_TIMEOUT_MS);
    }

    _cancelBrowserIdleTimer() {
        if (this._browserIdleTimer !== null) {
            clearTimeout(this._browserIdleTimer);
            this._browserIdleTimer = null;
        }
    }

    /**
     * 确保右侧边栏处于展开状态。若原本未展开则展开它。
     * 当侧边栏已收起且浏览器正在被使用（画中画模式），
     * 不强制展开侧边栏，而是尝试显示画中画。
     * 注意：即使画中画被用户关闭，也不阻塞调用（浏览器工具仍可在后台工作）。
     */
    _ensureRightSidebarOpen() {
        if (!this._rightSidebarExpanded) {
            const sidebar = this._getRightSidebarEl();
            const browserActive =
                sidebar && typeof sidebar.isBrowserVisible === 'function' && sidebar.isBrowserVisible();
            if (browserActive) {
                // 浏览器已激活且侧边栏收起，尝试显示画中画（用户已关闭则不弹出）
                // 不展开侧边栏，让浏览器工具在后台继续运行
                this._showBrowserPipIfNeeded();
                // 延迟刷新截图，等待浏览器操作渲染完成
                if (this._browserPip && this._browserPip.isVisible()) {
                    setTimeout(() => this._browserPip?.triggerCapture(), 600);
                }
                return;
            }
        }

        const rightSidebar = this.querySelector(`#task-${this.task_id}-artifacts`);
        const resizer = this.querySelector(`#task-${this.task_id}-resizer`);
        if (!rightSidebar) return;
        if (!this._isRightSidebarHidden(rightSidebar)) return;

        this._expandRightSidebar(rightSidebar, resizer);
        this._updateSidebarToggleIcon(true);
    }

    /**
     * 强制展开右侧边栏（不受画中画状态影响）。
     * 仅用于用户主动点击恢复按钮等场景。
     */
    _forceExpandRightSidebar() {
        const rightSidebar = this.querySelector(`#task-${this.task_id}-artifacts`);
        const resizer = this.querySelector(`#task-${this.task_id}-resizer`);
        if (!rightSidebar) return;
        if (!this._isRightSidebarHidden(rightSidebar)) return;

        this._expandRightSidebar(rightSidebar, resizer);
        this._updateSidebarToggleIcon(true);
    }

    /**
     * 处理聊天区域中 [data-open-editor] 元素的点击事件。
     * 展开侧边栏 → 切换到工作空间 tab → 在编辑器中打开文件。
     */
    _handleEditorOpenClick(e) {
        const target = e.target.closest('[data-open-editor]');
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        const filePath = target.dataset.openEditor;
        if (!filePath) return;
        const lineAttr = target.dataset.editorLine;
        const line = lineAttr ? parseInt(lineAttr, 10) : undefined;
        const validLine = line === undefined || Number.isFinite(line) ? line : undefined;

        // 1. 展开侧边栏
        this._forceExpandRightSidebar();
        // 2. 在侧边栏编辑器中打开文件
        const sidebar = this._getRightSidebarEl();
        if (sidebar && typeof sidebar.openFileInEditor === 'function') {
            sidebar.openFileInEditor(filePath, validLine);
        }
    }

    /**
     * 处理聊天区域中 [data-open-preview] 元素的点击事件。
     * 展开侧边栏 → 切换到工作空间 tab → 在预览模式下打开文件。
     */
    _handlePreviewOpenClick(e) {
        const target = e.target.closest('[data-open-preview]');
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        const filePath = target.dataset.openPreview;
        if (!filePath) return;

        // 1. 展开侧边栏
        this._forceExpandRightSidebar();
        // 2. 在预览模式下打开文件（不打开编辑器）
        const sidebar = this._getRightSidebarEl();
        if (sidebar && typeof sidebar.openFilePreview === 'function') {
            sidebar.openFilePreview(filePath);
        }
    }

    /**
     * 处理已完成 reasoning 块的 header 点击事件，展开/收起完整思考内容。
     */
    _handleReasoningToggleClick(e) {
        const header = e.target.closest('.reasoning-block-od.reasoning-completed .reasoning-header');
        if (!header) return;
        e.preventDefault();
        e.stopPropagation();
        const wrapper = header.closest('.reasoning-block-od');
        if (!wrapper) return;

        // Bubble mode: toggle pin state
        const bubble = wrapper.querySelector('.reasoning-bubble');
        if (bubble) {
            const isPinned = wrapper.classList.toggle('reasoning-bubble-pinned');
            if (isPinned) {
                bubble.classList.remove('reasoning-bubble-hidden');
                wrapper.classList.add('reasoning-content-visible');
            } else {
                bubble.classList.add('reasoning-bubble-hidden');
                wrapper.classList.remove('reasoning-content-visible');
            }
            return;
        }

        // Inline mode: toggle expanded class
        const isExpanded = wrapper.classList.toggle('reasoning-expanded');
        wrapper.classList.toggle('reasoning-content-visible', isExpanded);
        const toggle = wrapper.querySelector('.reasoning-toggle');
        if (toggle) {
            toggle.textContent = isExpanded ? taskViewT('reasoning.hide.content') : '';
        }
    }

    /** Bubble mode: show bubble on header hover (unless pinned) */
    _handleReasoningHoverEnter(e) {
        const header = e.target.closest('.reasoning-block-od.reasoning-completed .reasoning-header');
        if (!header) return;
        const wrapper = header.closest('.reasoning-block-od');
        if (!wrapper || wrapper.classList.contains('reasoning-bubble-pinned')) return;
        const bubble = wrapper.querySelector('.reasoning-bubble');
        if (bubble) {
            bubble.classList.remove('reasoning-bubble-hidden');
            wrapper.classList.add('reasoning-content-visible');
        }
    }

    /** Bubble mode: hide bubble on leave (unless pinned). Only reacts when leaving header or bubble, not internal element transitions. */
    _handleReasoningHoverLeave(e) {
        const isFromHeader = e.target.closest('.reasoning-block-od.reasoning-completed .reasoning-header');
        const isFromBubble = e.target.closest('.reasoning-bubble');
        if (!isFromHeader && !isFromBubble) return;
        const wrapper = e.target.closest('.reasoning-block-od.reasoning-completed');
        if (!wrapper || wrapper.classList.contains('reasoning-bubble-pinned')) return;
        const bubble = wrapper.querySelector('.reasoning-bubble');
        if (bubble && !wrapper.matches(':hover')) {
            bubble.classList.add('reasoning-bubble-hidden');
            wrapper.classList.remove('reasoning-content-visible');
        }
    }

    _getRightSidebarEl() {
        return this.querySelector(`#task-${this.task_id}-artifacts`);
    }

    /**
     * 将侧边栏移到屏幕外（保持渲染活跃），代替 display:none。
     * 保留原始宽度，让 webview 继续在合理尺寸下渲染。
     */
    _hideRightSidebarOffscreen(el) {
        el.style.display = '';
        el.style.position = 'absolute';
        // 保持元素在视口内（left: 0 而非 -9999px），防止 Chromium 因元素完全移出视口
        // 而暂停 webview guest compositor 的 BeginFrame 调度，导致截图命令永久挂起。
        // 使用 opacity: 0 + pointer-events: none + z-index: -1 确保不可见、不可交互。
        el.style.left = '0';
        el.style.top = '0';
        // 使用桌面标准宽度，使 webview 以正常桌面布局渲染（而非移动端窄布局），
        // 画中画截图可以显示完整宽度的页面内容
        el.style.width = '1280px';
        el.style.height = '800px';
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        el.style.zIndex = '-1';
        el.dataset.offscreen = '1';
        // 确保浏览器 tab 内容面板不被 display:none 隐藏，
        // 否则即使宿主元素在视口内，内部 webview 也会因 display:none 被暂停渲染
        if (typeof el.keepBrowserPanelRenderable === 'function') {
            el.keepBrowserPanelRenderable();
        }
    }

    /**
     * 将侧边栏从屏幕外恢复到正常位置。
     */
    _restoreRightSidebarFromOffscreen(el) {
        el.style.position = '';
        el.style.left = '';
        el.style.top = '';
        el.style.height = '';
        el.style.pointerEvents = '';
        el.style.zIndex = '';
        el.style.opacity = '';
        delete el.dataset.offscreen;
        // 恢复浏览器面板的正常布局（清理 keepBrowserPanelRenderable 的临时样式）
        if (typeof el.restoreBrowserPanelLayout === 'function') {
            el.restoreBrowserPanelLayout();
        }
    }

    /**
     * 判断侧边栏是否处于隐藏状态（offscreen 或 display:none）。
     */
    _isRightSidebarHidden(el) {
        return el.style.display === 'none' || el.dataset.offscreen === '1';
    }

    /**
     * 刷新任务级待办。
     * @param {{autoExpand?: boolean}} opts autoExpand=true 时，若从无待办变为有待办则自动展开侧边栏
     */
    async _refreshTaskTodos(opts = {}) {
        if (!window.taskManagerAPI || !window.taskManagerAPI.getTaskTodos) return;
        try {
            const prevHasTodos = this._taskTodos.length > 0;
            const todos = await window.taskManagerAPI.getTaskTodos(this.task_id);
            this._taskTodos = Array.isArray(todos) ? todos : [];
            const revealedGoalSuggestion = this._syncArtifactsTaskTodos(this._taskTodos, {
                autoExpandForGoalSuggestion: opts.autoExpand
            });
            if (opts.autoExpand && !revealedGoalSuggestion && !prevHasTodos && this._taskTodos.length > 0) {
                this._ensureRightSidebarOpen();
            }
        } catch (err) {
            console.warn('refresh task todos failed', err);
        }
    }

    async _refreshGlobalTodos() {
        if (!window.applicationRegistryAPI || !window.applicationRegistryAPI.call) return;
        try {
            const todos = await window.applicationRegistryAPI.call('todomgr', 'listGlobalTodos', 'all');
            this._globalTodos = Array.isArray(todos) ? todos : [];
            const sidebar = this._getRightSidebarEl();
            if (sidebar && typeof sidebar.setGlobalTodos === 'function') {
                sidebar.setGlobalTodos(this._globalTodos);
            }
        } catch (err) {
            // 非致命错误，全局待办模块可能暂时不可用
            console.warn('refresh global todos failed', err);
        }
    }

    async _subscribeGlobalTodos() {
        if (this._globalTodosUnsubscribe) return;
        if (!window.applicationRegistryAPI || !window.applicationRegistryAPI.subscribeEvent) return;
        try {
            const unsubscribe = await window.applicationRegistryAPI.subscribeEvent(
                'todomgr',
                'globalTodosUpdated',
                (todos) => {
                    this._globalTodos = Array.isArray(todos) ? todos : [];
                    const sidebar = this._getRightSidebarEl();
                    if (sidebar && typeof sidebar.setGlobalTodos === 'function') {
                        sidebar.setGlobalTodos(this._globalTodos);
                    }
                }
            );
            if (typeof unsubscribe === 'function') {
                this._globalTodosUnsubscribe = unsubscribe;
            }
        } catch (err) {
            console.warn('subscribe global todos failed', err);
        }
    }

    /**
     * 订阅任务级待办更新事件。TodoWrite 工具每次写入后会派发 `taskTodosUpdated`，
     * 事件负载为 { taskId, todos }。只有 taskId 匹配当前任务才刷新面板。
     */
    async _subscribeTaskTodos() {
        if (this._taskTodosUnsubscribe) return;
        if (!window.applicationRegistryAPI || !window.applicationRegistryAPI.subscribeEvent) return;
        try {
            const unsubscribe = await window.applicationRegistryAPI.subscribeEvent(
                'todomgr',
                'taskTodosUpdated',
                (payload) => {
                    if (!payload || payload.taskId !== this.task_id) return;
                    const prevHasTodos = this._taskTodos.length > 0;
                    this._taskTodos = Array.isArray(payload.todos) ? payload.todos : [];
                    const revealedGoalSuggestion = this._syncArtifactsTaskTodos(this._taskTodos, {
                        autoExpandForGoalSuggestion: true
                    });
                    // 仅在从"无任务计划"变为"有任务计划"时自动展开右侧栏，
                    // 避免每次 TodoWrite 都强制展开，干扰用户手动折叠的偏好
                    if (!revealedGoalSuggestion && !prevHasTodos && this._taskTodos.length > 0) {
                        this._ensureRightSidebarOpen();
                    }
                }
            );
            if (typeof unsubscribe === 'function') {
                this._taskTodosUnsubscribe = unsubscribe;
            }
        } catch (err) {
            console.warn('subscribe task todos failed', err);
        }
    }

    /** 订阅浏览器应用事件，agent 工具调用时转发到对应任务的浏览器实例 */
    async _subscribeBrowserEvents() {
        if (!window.applicationRegistryAPI || !window.applicationRegistryAPI.subscribeEvent) return;
        this._browserEventUnsubscribes = [];

        const browserEvents = [
            { name: 'navigate', handler: (taskId, url) => this._handleBrowserEvent('browserNavigate', taskId, url) },
            { name: 'goBack', handler: (taskId) => this._handleBrowserEvent('browserGoBack', taskId) },
            { name: 'goForward', handler: (taskId) => this._handleBrowserEvent('browserGoForward', taskId) },
            { name: 'refresh', handler: (taskId) => this._handleBrowserEvent('browserRefresh', taskId) },
            {
                name: 'executeScript',
                handler: (taskId, script) => this._handleBrowserEvent('browserExecuteScript', taskId, script)
            }
        ];

        for (const evt of browserEvents) {
            try {
                const unsubscribe = await window.applicationRegistryAPI.subscribeEvent('browser', evt.name, (...args) =>
                    evt.handler(...args)
                );
                if (typeof unsubscribe === 'function') {
                    this._browserEventUnsubscribes.push(unsubscribe);
                }
            } catch (err) {
                console.warn(`subscribe browser event ${evt.name} failed`, err);
            }
        }
    }

    /** 处理浏览器事件，只处理当前任务的事件 */
    _handleBrowserEvent(method, taskId, ...args) {
        if (taskId !== this.task_id) return;
        const sidebar = this._getRightSidebarEl();
        if (!sidebar || typeof sidebar[method] !== 'function') return;

        if (!this._rightSidebarExpanded) {
            // 侧边栏未展开：先展开侧边栏
            this._ensureRightSidebarOpen();
        }
        sidebar[method](...args);

        // 若侧边栏已展开则保持不变；若已收起，尝试显示画中画浮窗
        if (!this._rightSidebarExpanded) {
            this._showBrowserPipIfNeeded();
            // 浏览器事件发生时立即刷新截图，而不是等待定时器
            if (this._browserPip && this._browserPip.isVisible()) {
                // 延迟 500ms 等待浏览器操作完成后再截图
                setTimeout(() => this._browserPip?.triggerCapture(), 500);
            }
        }
    }

    /** 同步当前任务侧边栏状态到 DOM（切换任务时调用） */
    syncRightSidebarState() {
        const rightSidebar = this.querySelector(`#task-${this.task_id}-artifacts`);
        const resizer = this.querySelector(`#task-${this.task_id}-resizer`);
        if (!rightSidebar) return;

        if (this._rightSidebarExpanded) {
            this._restoreRightSidebarFromOffscreen(rightSidebar);
            rightSidebar.style.display = '';
            rightSidebar.style.width = this._rightSidebarWidth + 'px';
            rightSidebar.style.opacity = '';
            if (resizer) resizer.style.display = '';
            this._autoSwitchTabIfEmpty(rightSidebar);
            // 侧边栏展开时隐藏画中画
            if (this._browserPip) this._browserPip.hide();
        } else {
            this._hideRightSidebarOffscreen(rightSidebar);
            if (resizer) resizer.style.display = 'none';
            // 侧边栏收起时，根据浏览器状态决定是否显示画中画
            this._showBrowserPipIfNeeded();
        }
        this._updateSidebarToggleIcon(this._rightSidebarExpanded);

        if (typeof rightSidebar.refreshWorkspace === 'function') {
            rightSidebar.refreshWorkspace(this._taskWorkspace);
        }
    }

    _updateSidebarToggleIcon(isExpanded) {
        const btn = this.querySelector(`[id^="taskview-sidebar-toggle-btn"]`);
        if (!btn) return;
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = isExpanded
                ? 'fa-solid fa-table-columns text-sm text-blue-600'
                : 'fa-solid fa-table-columns text-sm';
        }
    }

    async _initToolbarWorkspace() {
        if (!this._toolbar || !window.workspaceAPI) return;
        try {
            const wsClickHandler = async () => {
                const selected = await showWorkspacePicker({
                    title: this._buildWorkspacePickerTitle()
                });
                if (selected) {
                    await window.taskManagerAPI.updateTaskWorkspace(this.task_id, selected);
                    this._taskWorkspace = selected;
                    this._toolbar.setToolbarSubtitle(selected, wsClickHandler, taskViewT('workspace.taskLabel'));
                    document.dispatchEvent(new CustomEvent('workspace-changed'));
                }
            };
            // 从任务状态获取 workspace
            const workspacePath = this._taskWorkspace || (await window.workspaceAPI.getEffectiveWorkspace());
            this._toolbar.setToolbarSubtitle(workspacePath, wsClickHandler, taskViewT('workspace.taskLabel'));
        } catch (error) {
            console.error('Failed to init toolbar workspace:', error);
        }
    }

    _buildWorkspacePickerTitle() {
        const taskName = this._taskName || '';
        const maxLen = 24;
        const displayName = taskName.length > maxLen ? taskName.substring(0, maxLen) + '...' : taskName;
        const key = taskName ? 'workspace.taskPickerTitleWithName' : 'workspace.taskPickerTitle';
        return taskViewT(key, { name: displayName });
    }

    async _pickWorkspace() {
        if (!this._toolbar || !window.taskManagerAPI) {
            console.warn('_pickWorkspace: toolbar or taskManagerAPI not available');
            return;
        }
        const selected = await showWorkspacePicker({
            title: this._buildWorkspacePickerTitle()
        });
        if (selected) {
            await window.taskManagerAPI.updateTaskWorkspace(this.task_id, selected);
            this._taskWorkspace = selected;
            this._toolbar.setToolbarSubtitle(
                selected,
                () => {
                    void this._pickWorkspace();
                },
                taskViewT('workspace.taskLabel')
            );
            document.dispatchEvent(new CustomEvent('workspace-changed'));
        }
    }

    async exportTask() {
        try {
            const timestamp = new Date().toISOString().slice(0, 10);
            const defaultFileName = `conversation-${timestamp}.html`;

            // 1. 显示保存文件对话框（Electron 会自动处理文件覆盖确认）
            const saveResult = await window.fsAPI.saveFile({
                title: '导出会话',
                defaultPath: defaultFileName,
                filters: [
                    { name: 'HTML Files', extensions: ['html'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });

            if (saveResult.canceled || !saveResult.filePath) {
                return; // 用户取消了操作
            }

            const filePath = saveResult.filePath;

            // 2. 保存文件
            await window.taskManagerAPI.exportTask(this.task_id, filePath);
        } catch (error) {
            console.error('Failed to export task:', error);
            alert('导出失败：' + error.message);
        }
    }

    connectedCallback() {
        const task_id = this.getAttribute('task_id');
        if (task_id === null) {
            throw new Error('task_id is required');
        }
        this.task_id = task_id;

        this.render();

        // Initialize toolbar with spread layout
        const toolbarContainer = this.querySelector('#taskview-toolbar');
        if (toolbarContainer) {
            const toolbar = new ElasticToolbarWidget(
                [
                    {
                        id: 'taskview-export-btn',
                        icon: 'fa-download',
                        label: '导出',
                        action: () => {
                            this.exportTask();
                        }
                    },
                    {
                        id: 'taskview-sidebar-toggle-btn',
                        icon: this._rightSidebarExpanded ? 'fa-table-columns' : 'fa-table-columns',
                        label: '面板',
                        action: () => {
                            this._toggleRightSidebar();
                        }
                    }
                ],
                '智能体对话',
                'spread'
            );
            toolbarContainer.appendChild(toolbar);
            this._toolbar = toolbar;
        }

        this._initToolbarWorkspace();
        this.setUpEventListeners();

        // 添加编辑器打开按钮的点击事件监听（事件代理）
        this._handleEditorOpenClick = this._handleEditorOpenClick.bind(this);
        this.addEventListener('click', this._handleEditorOpenClick);

        // 添加预览打开按钮的点击事件监听（事件代理）
        this._handlePreviewOpenClick = this._handlePreviewOpenClick.bind(this);
        this.addEventListener('click', this._handlePreviewOpenClick);

        // 添加 reasoning 块展开/收起的事件代理
        this._handleReasoningToggleClick = this._handleReasoningToggleClick.bind(this);
        this.addEventListener('click', this._handleReasoningToggleClick);

        // Bubble mode hover handlers
        this._handleReasoningHoverEnter = this._handleReasoningHoverEnter.bind(this);
        this._handleReasoningHoverLeave = this._handleReasoningHoverLeave.bind(this);
        this.addEventListener('mouseover', this._handleReasoningHoverEnter);
        this.addEventListener('mouseout', this._handleReasoningHoverLeave);

        this._handleGoalStateChanged = () => {
            void this.reload();
        };
        this.addEventListener('goal-state-changed', this._handleGoalStateChanged);
        this.addEventListener('goal-message-anchor', this._handleGoalMessageAnchor);

        this._handleGoalCreationOpen = () => {
            const artifacts = this.querySelector(`#task-${this.task_id}-artifacts`);
            const resizer = this.querySelector(`#task-${this.task_id}-resizer`);
            if (artifacts && typeof artifacts.showGoalCreationForm === 'function') {
                artifacts.showGoalCreationForm();
                this._expandRightSidebar(artifacts, resizer);
            }
        };
        this.addEventListener('open-goal-creation', this._handleGoalCreationOpen);
        this._handlePendingGoalEvent = (event) => {
            const detail = event?.detail;
            if (!detail || detail.taskId !== this.task_id) return;
            this.showPendingGoalEdit(detail.type, detail.objective, detail.goalId, detail.taskId);
        };
        document.addEventListener('goal-pending', this._handlePendingGoalEvent);

        // 初始化 session memory 刷新
        const sidebarEl = this._getRightSidebarEl();
        if (sidebarEl && typeof sidebarEl.setTaskId === 'function') {
            sidebarEl.setTaskId(this.task_id);
        }

        // 订阅全局待办更新（跨任务共享）
        this._subscribeGlobalTodos();
        // 订阅任务级待办更新（仅处理当前任务的事件）
        this._subscribeTaskTodos();

        // 订阅浏览器事件（agent 工具 → main → renderer → 操作浏览器）
        this._subscribeBrowserEvents();

        this._workspaceChangedHandler = async () => {
            const sidebar = this._getRightSidebarEl();
            if (sidebar && typeof sidebar.refreshWorkspace === 'function') {
                sidebar.refreshWorkspace(this._taskWorkspace);
            }
            if (this._toolbar && window.workspaceAPI && !this._taskWorkspace) {
                try {
                    const p = await window.workspaceAPI.getEffectiveWorkspace();
                    this._toolbar.setToolbarSubtitle(p, this._toolbar._subtitleClickHandler);
                } catch {
                    /* ignore */
                }
            }
        };
        document.addEventListener('workspace-changed', this._workspaceChangedHandler);

        this._taskListUpdateHandler = (event) => {
            if (!this._toolbar) return;
            const taskList = event.detail;
            if (!Array.isArray(taskList)) return;
            const myTask = taskList.find((t) => t.task_id === this.task_id);
            if (myTask && myTask.task_name) {
                this._taskName = myTask.task_name;
                this._toolbar.setToolbarTitle(myTask.task_name);
            }
            if (myTask && Object.prototype.hasOwnProperty.call(myTask, 'goal')) {
                this._currentGoal = mergeGoalSummary(this._currentGoal, myTask.goal || null);
                this._syncGoalLiveRefresh();
                this._syncArtifactsGoalState(this._currentGoal, { autoExpandForGoalSuggestion: true });
                this.updateStopButtonVisibility();
            }
            if (
                myTask &&
                typeof myTask.workspace === 'string' &&
                myTask.workspace.length > 0 &&
                myTask.workspace !== this._taskWorkspace
            ) {
                this._taskWorkspace = myTask.workspace;
                this._toolbar.setToolbarSubtitle(
                    myTask.workspace,
                    () => {
                        void this._pickWorkspace();
                    },
                    taskViewT('workspace.taskLabel')
                );
            }
        };
        document.addEventListener('task-list-updated', this._taskListUpdateHandler);

        this.reload().then(async () => {
            // 首页"创建目标"按钮引导创建的任务：自动展开右侧栏目标编辑框
            const pendingGoalTaskId = sessionStorage.getItem('opendesk:pendingGoalCreation');
            if (pendingGoalTaskId && pendingGoalTaskId === this.task_id) {
                sessionStorage.removeItem('opendesk:pendingGoalCreation');
                const artifacts = this.querySelector(`#task-${this.task_id}-artifacts`);
                const resizer = this.querySelector(`#task-${this.task_id}-resizer`);
                if (artifacts && typeof artifacts.showGoalCreationForm === 'function') {
                    artifacts.showGoalCreationForm();
                    this._expandRightSidebar(artifacts, resizer);
                }
            }
            this.subscription_id = await window.taskManagerAPI.subscribeTaskUpdate(this.task_id, (progress) => {
                // 后台任务或正在 reload 时跳过 DOM 操作，避免无效渲染。
                // 用户切回时 openTask() 会调用 reload() 补齐所有跳过的更新。
                // 检查 display:none（hideAllNonAppChildren 隐藏）和 data-background
                // （ensureTaskViewExists 创建的不可见视图，用 opacity:0 隐藏）。
                if (this._shouldSuppressIncrementalRender()) {
                    this._handleTaskStatusUpdate(progress.task_status);
                    if (progress.type === 'goal_eval') {
                        this._handleGoalEvalProgress(progress, { renderToConversation: false });
                    }
                    return;
                }

                const history_container = this.getHistoryContainer();

                if (progress.type === 'user_replace') {
                    // slash skill 替换文本后重新渲染整条用户消息
                    if (shouldRenderUserHistoryMessage(progress)) {
                        const container = this.querySelector(`#user-msg-${progress.message_id}`);
                        if (container) {
                            container.innerHTML = '';
                            if (progress.rawText) {
                                container.dataset.rawText = progress.rawText;
                            }
                            const parts = getRenderableUserParts(progress, progress.parts);
                            for (const part of parts) {
                                container.insertAdjacentHTML('beforeend', this.renderUserPart(part));
                            }
                            markRenderedUserParts(this._renderedUserParts, progress.message_id, parts.length);
                            const timeHtml = progress.timestamp
                                ? `<div class="text-right text-[10px] text-gray-400 mt-0.5 mr-1">${TaskView.formatRelativeTime(progress.timestamp)}</div>`
                                : '';
                            if (timeHtml) container.insertAdjacentHTML('beforeend', timeHtml);
                        } else if (this._isHistoryMessageBeforeRenderedWindow(progress.message_id)) {
                            this._applyHiddenUserReplaceToHistory(progress);
                        }
                    }
                } else if (progress.type === 'assistant_replace') {
                    this.handleAssistantReplace(progress);
                } else if (progress.type === 'retry') {
                    this.handleRetryProgress(progress);
                } else if (progress.type === 'user') {
                    // last_part 可能不存在（如流式更新异常），跳过内容渲染但仍处理状态迁移
                    if (this._isHistoryMessageBeforeRenderedWindow(progress.message_id)) {
                        this._applyHiddenUserProgressToHistory(progress);
                    } else {
                        this._renderUserProgress(progress, history_container);
                    }
                } else if (progress.type === 'goal_eval') {
                    this._handleGoalEvalProgress(progress);
                } else {
                    this._renderAssistantProgress(progress, history_container);
                    // 任务运行中且有 goal 时，节流刷新 goal 面板（token 进度条实时推进）。
                    // 不依赖 progress.usage：很多 provider 流式过程中不返回 usage，只在结束时才返回。
                    if (this._currentGoal) {
                        this._scheduleGoalRefresh();
                    }
                }

                if (this._handleTaskStatusUpdate(progress.task_status) && this.task_status !== 'running') {
                    // 流式结束：移除等待占位，隐藏 spinner
                    const waitingPlaceholder = history_container.querySelector('.waiting-usage-placeholder');
                    if (waitingPlaceholder) waitingPlaceholder.remove();
                    history_container.querySelectorAll('.usage-spinner').forEach((el) => {
                        el.style.display = 'none';
                    });
                    this.getHistoryContainer()
                        .querySelectorAll('.reasoning-block-od.reasoning-active')
                        .forEach((el) => {
                            TaskView.finalizeReasoningBlock(el);
                        });
                    const inputWidget = this.querySelector(`#task-${this.task_id}-input`);
                    if (inputWidget) {
                        const textarea = inputWidget.querySelector('#agent-input-textarea');
                        if (textarea && document.activeElement !== textarea) textarea.focus();
                    }
                }

                // 任务级待办的实时更新已通过 todomgr.taskTodosUpdated 事件单独订阅，
                // 这里无需再从工具调用进度里反推 TodoWrite 的执行状态。

                // 文件操作工具完成后，增量刷新工作空间文件浏览器
                if (progress.last_part && progress.last_part.type === 'tool_call') {
                    const FILE_TOOLS = new Set(['writeFile', 'editFile', 'searchReplace', 'applyPatch']);
                    const toolcalls = progress.last_part.toolcalls || [];
                    const hasFileOp = toolcalls.some((tc) => {
                        const name = tc.tool_name || '';
                        const shortName = name.includes('-') ? name.slice(name.lastIndexOf('-') + 1) : name;
                        return FILE_TOOLS.has(shortName) && (tc.status === 'success' || tc.status === 'error');
                    });
                    if (hasFileOp) {
                        const sidebar = this._getRightSidebarEl();
                        if (sidebar && typeof sidebar.softRefreshWorkspace === 'function') {
                            sidebar.softRefreshWorkspace();
                        }
                        if (sidebar && typeof sidebar.refreshChanges === 'function') {
                            sidebar.refreshChanges();
                        }
                    }
                }

                this.tryScrollToEnd();
            });
        });
    }

    disconnectedCallback() {
        const artifacts = this.querySelector(`#task-${this.task_id}-artifacts`);
        if (artifacts && typeof artifacts.setTaskTodos === 'function') {
            artifacts.setTaskTodos([]);
        }
        this.removeEventListener('click', this._handleEditorOpenClick);
        this.removeEventListener('click', this._handlePreviewOpenClick);
        this.removeEventListener('click', this._handleReasoningToggleClick);
        this.removeEventListener('mouseover', this._handleReasoningHoverEnter);
        this.removeEventListener('mouseout', this._handleReasoningHoverLeave);
        this.getHistoryContainer()
            ?.querySelectorAll('.reasoning-block-od.reasoning-active')
            .forEach((el) => TaskView.finalizeReasoningBlock(el));
        this.removeEventListener('goal-state-changed', this._handleGoalStateChanged);
        this.removeEventListener('goal-message-anchor', this._handleGoalMessageAnchor);
        this.removeEventListener('open-goal-creation', this._handleGoalCreationOpen);
        if (this._handlePendingGoalEvent) {
            document.removeEventListener('goal-pending', this._handlePendingGoalEvent);
            this._handlePendingGoalEvent = null;
        }
        if (this._goalRefreshTimer) {
            clearTimeout(this._goalRefreshTimer);
            this._goalRefreshTimer = null;
        }
        if (this._goalLiveRefreshTimer) {
            clearInterval(this._goalLiveRefreshTimer);
            this._goalLiveRefreshTimer = null;
        }
        this._goalRefreshPending = false;
        this._cancelBrowserIdleTimer();
        if (this._browserPip) {
            this._browserPip.destroy();
            this._browserPip = null;
        }
        window.taskManagerAPI.unsubscribeTaskUpdate(this.task_id, this.subscription_id);
        this.subscription_id = null;
        if (this._globalTodosUnsubscribe) {
            try {
                this._globalTodosUnsubscribe();
            } catch (err) {
                console.warn('failed to unsubscribe global todos', err);
            }
            this._globalTodosUnsubscribe = null;
        }
        if (this._taskTodosUnsubscribe) {
            try {
                this._taskTodosUnsubscribe();
            } catch (err) {
                console.warn('failed to unsubscribe task todos', err);
            }
            this._taskTodosUnsubscribe = null;
        }
        if (this._browserEventUnsubscribes) {
            for (const unsub of this._browserEventUnsubscribes) {
                try {
                    unsub();
                } catch {
                    /* ignore */
                }
            }
            this._browserEventUnsubscribes = null;
        }
        if (this._workspaceChangedHandler) {
            document.removeEventListener('workspace-changed', this._workspaceChangedHandler);
            this._workspaceChangedHandler = null;
        }
        if (this._taskListUpdateHandler) {
            document.removeEventListener('task-list-updated', this._taskListUpdateHandler);
            this._taskListUpdateHandler = null;
        }
        if (this._poolSegObserver) {
            this._poolSegObserver.disconnect();
            this._poolSegObserver = null;
        }
        if (this._domSanitizer) {
            this._domSanitizer.disconnect();
            this._domSanitizer = null;
        }
    }

    render() {
        this.innerHTML = `
        <div class="bg-gray-30 h-full flex flex-col">
            <header id="taskview-toolbar" class="w-full"></header>
            <div id="task-${this.task_id}-content-row" class="flex-1 flex flex-row min-h-0 overflow-hidden relative">
                <div class="flex-1 flex flex-col min-w-0">
                    <div class="relative flex-1 overflow-hidden">
                        <!-- 对话历史区域 - 可滚动 -->
                        <div id="taskview-chat-history" class="w-full h-full overflow-y-auto px-3 pt-4">
                        </div>
                        <!-- 滚动到底部按钮, 按需显示 -->
                        <button
                            id="taskview-scroll-to-bottom-button"
                            class="absolute bottom-3 right-8 flex items-center justify-center px-3 py-1 text-white rounded-full shadow transition-all focus:outline-none active:scale-95 text-xs hidden"
                            style="min-width: unset; height: 2rem; background: rgba(120,140,170,0.72); backdrop-filter: blur(4px);"
                            title="滚动到底部"
                        >
                            <i class="fas fa-arrow-down text-sm"></i>
                            <span class="ml-1">滚动到底部</span>
                        </button>
                    </div>

                    <!-- 权限确认浮窗 -->
                    <permission-prompt id="task-${this.task_id}-permission" data-task-id="${this.task_id}" class="block px-4"></permission-prompt>

                    <!-- 用户提问面板 -->
                    <ask-user-prompt id="task-${this.task_id}-ask-user" data-task-id="${this.task_id}" class="block px-4"></ask-user-prompt>

                    <!-- 计划审批面板 -->
                    <exit-plan-mode-prompt id="task-${this.task_id}-exit-plan" class="block px-4"></exit-plan-mode-prompt>

                    <!-- 输入区域 -->
                    <div class="px-3 pb-3 pt-1">
                        <!-- 消息队列面板 -->
                        <message-queue-panel id="message-queue-panel"></message-queue-panel>
                        <agent-input id="task-${this.task_id}-input" />
                    </div>
                </div>

                <!-- 右侧边栏拖拽条 -->
                <div id="task-${this.task_id}-resizer"
                    class="resizer-group relative shrink-0"
                    style="background: linear-gradient(to right, transparent 40%, #e0e0e0 50%, transparent 60%); width: 4px; cursor: col-resize; display: ${this._rightSidebarExpanded ? '' : 'none'};"
                >
                    <div class="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none">
                        <div class="resizer-handle-indicator resizer-blue" style="width: 2px; height: 3rem; border-radius: 9999px; background: #e5e7eb;"></div>
                    </div>
                </div>

                <!-- 右侧边栏（任务产物 / 任务计划 / 变更） -->
                <task-artifacts id="task-${this.task_id}-artifacts" task-id="${this.task_id}" style="display: ${this._rightSidebarExpanded ? '' : 'none'}; width: ${this._rightSidebarWidth}px;"></task-artifacts>
            </div>
        </div>
        `;

        this._initRightSidebarResize();

        const hc = this.getHistoryContainer();
        if (hc) {
            this._domSanitizer = installDOMSanitizer(hc);
        }
    }

    _initRightSidebarResize() {
        const resizer = this.querySelector(`#task-${this.task_id}-resizer`);
        const rightSidebar = this.querySelector(`#task-${this.task_id}-artifacts`);
        if (!resizer || !rightSidebar) return;

        let isResizing = false;
        let cachedContainerRect = null;
        let resizeRafId = null;
        const onMouseMove = (e) => {
            if (!isResizing) return;
            e.preventDefault();
            if (resizeRafId !== null) return;
            resizeRafId = requestAnimationFrame(() => {
                resizeRafId = null;
                if (!isResizing || !cachedContainerRect) return;
                const newWidth = cachedContainerRect.right - e.clientX;
                const minWidth = 200;
                const maxWidth = cachedContainerRect.width * 0.85;
                if (newWidth < minWidth || newWidth > maxWidth) return;
                rightSidebar.style.width = newWidth + 'px';
                this._rightSidebarWidth = newWidth;
            });
        };

        const onMouseUp = () => {
            if (!isResizing) return;
            isResizing = false;
            cachedContainerRect = null;
            if (resizeRafId !== null) {
                cancelAnimationFrame(resizeRafId);
                resizeRafId = null;
            }
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            rightSidebar.style.pointerEvents = '';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const container = this.querySelector(`#task-${this.task_id}-content-row`);
            if (!container) return;
            cachedContainerRect = container.getBoundingClientRect();
            isResizing = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            rightSidebar.style.pointerEvents = 'none';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        resizer.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._toggleRightSidebar();
        });
    }

    setUpEventListeners() {
        // 为输入框添加事件监听器
        const input_widget = this.querySelector(`#task-${this.task_id}-input`);
        input_widget.taskId = this.task_id;
        input_widget.addEventListener('model-changed', async (event) => {
            const modelAlias = event.detail?.model;
            if (modelAlias) {
                try {
                    await window.taskManagerAPI.setTaskModel(this.task_id, modelAlias);
                } catch (err) {
                    console.error('setTaskModel failed:', err);
                }
                this._contextSizeModel = null;
                await this._refreshModelContextSize(modelAlias);
                this._updateLastUsageRatio();
            }
        });
        input_widget.addEventListener('submit', async (event) => {
            const message = event.detail.message;

            if (window.quickpassAPI && message.trim().startsWith('[[Opendesk')) {
                try {
                    const isQP = await window.quickpassAPI.isQuickPass(message);
                    if (isQP) {
                        const { hasApplications } = await window.quickpassAPI.importQuickPass(message);
                        const scope = hasApplications ? '全部设置（含应用配置）' : '基础设置（不含应用配置）';
                        await window.notificationAPI.sendNotification(
                            'info',
                            '设置',
                            `已成功导入口令`,
                            `导入范围：${scope}`
                        );
                        window.globalControlAPI.openHomePage();
                        return;
                    }
                } catch (err) {
                    await window.notificationAPI.sendNotification(
                        'error',
                        '口令导入失败',
                        '导入口令时出错',
                        err.message || String(err)
                    );
                    return;
                }
            }

            if (await this._isActiveGoalRunningNow()) {
                this.addToMessageQueue(event.detail);
                return;
            }

            this.task_status = 'running';
            this._cancelBrowserIdleTimer();
            this.updateStopButtonVisibility();

            this._showWaitingAssistantPlaceholder({ force: true });
            this.tryScrollToEnd();

            try {
                await window.taskManagerAPI.submitMessage(this.task_id, event.detail);
            } catch (error) {
                console.error('Failed to submit message:', error);
                // 发送失败时重置状态，防止 task_status/isRunning 永久卡住
                // 导致后续所有输入都被阻塞
                this.task_status = 'stopped';
                this.updateStopButtonVisibility();
                this._startBrowserIdleTimer();
            }
        });

        // 监听消息队列事件
        input_widget.addEventListener('queue', (event) => {
            this.addToMessageQueue(event.detail);
        });

        // 设置消息队列面板的回调
        const queuePanel = this.querySelector('#message-queue-panel');
        if (queuePanel) {
            queuePanel.setCallbacks(
                (id) => this.sendQueueMessageImmediately(id),
                (item) => this.editQueueMessage(item),
                (id) => this.removeFromMessageQueue(id)
            );
        }

        const chatHistory = this.querySelector('#taskview-chat-history');
        chatHistory.addEventListener('scroll', () => {
            if (this._programmaticScrolling) return;
            if (chatHistory.scrollTop <= TASKVIEW_HISTORY_TOP_LOAD_THRESHOLD_PX) {
                this._loadOlderHistoryFromScroll();
            }
            const scrollBottom = chatHistory.scrollTop + chatHistory.clientHeight;
            const distanceToBottom = Math.abs(chatHistory.scrollHeight - scrollBottom);
            // 使用更宽松的阈值避免因内容增长导致的误 detach
            if (distanceToBottom < 80) {
                if (!this.auto_scrolling_to_bottom) {
                    this.setAutoScrollingToBottom(true);
                }
            } else {
                if (this.auto_scrolling_to_bottom) {
                    this.setAutoScrollingToBottom(false);
                }
            }
        });

        // wheel 事件用于检测用户手动滚轮/触摸板操作，直接解锁
        // wheel 事件不受 _programmaticScrolling 影响，可解决 AI 快速输出时
        // 用户滚动被长时间屏蔽的问题
        chatHistory.addEventListener(
            'wheel',
            (e) => {
                // 向上滚动（deltaY < 0）→ 解锁；向下滚动到底部 → 重新锁定
                if (e.deltaY < 0) {
                    const scrollBottom = chatHistory.scrollTop + chatHistory.clientHeight;
                    const distanceToBottom = Math.abs(chatHistory.scrollHeight - scrollBottom);
                    if (distanceToBottom >= 80 && this.auto_scrolling_to_bottom) {
                        this.setAutoScrollingToBottom(false);
                    }
                } else if (e.deltaY > 0) {
                    // 向下滚动，如果已经接近底部则重新锁定
                    const scrollBottom = chatHistory.scrollTop + chatHistory.clientHeight;
                    const distanceToBottom = Math.abs(chatHistory.scrollHeight - scrollBottom);
                    if (distanceToBottom < 80 && !this.auto_scrolling_to_bottom) {
                        this.setAutoScrollingToBottom(true);
                    }
                }
            },
            { passive: true }
        );

        this._poolSegRaf = null;
        const initPoolSegIndicators = () => {
            chatHistory.querySelectorAll('.pool-seg').forEach((seg) => {
                const indicator = seg.querySelector('.pool-seg-indicator');
                const active = seg.querySelector('.pool-seg-btn.active');
                if (indicator && active) {
                    indicator.style.left = active.offsetLeft + 'px';
                    indicator.style.width = active.offsetWidth + 'px';
                }
            });
        };
        this._poolSegObserver = new MutationObserver(() => {
            // 流式输出期间跳过布局计算，避免频繁 forced reflow 导致抖动
            if (this.task_status === 'running') return;
            if (this._poolSegRaf) return;
            this._poolSegRaf = requestAnimationFrame(() => {
                this._poolSegRaf = null;
                initPoolSegIndicators();
            });
        });
        this._poolSegObserver.observe(chatHistory, { childList: true, subtree: true });

        chatHistory.addEventListener('click', (e) => {
            const tabBtn = e.target.closest('.pool-seg-btn[data-pool-filter]');
            if (!tabBtn) return;
            const card = tabBtn.closest('.subtask-pool-card');
            if (!card) return;
            const filter = tabBtn.dataset.poolFilter;

            card.querySelectorAll('.pool-seg-btn').forEach((btn) => btn.classList.remove('active'));
            tabBtn.classList.add('active');

            const seg = tabBtn.closest('.pool-seg');
            const indicator = seg ? seg.querySelector('.pool-seg-indicator') : null;
            if (indicator) {
                indicator.style.left = tabBtn.offsetLeft + 'px';
                indicator.style.width = tabBtn.offsetWidth + 'px';
            }

            card.querySelectorAll('[data-pool-task-idx]').forEach((row) => {
                const status = row.dataset.poolTaskStatus;
                if (filter === 'all') {
                    row.style.display = '';
                } else if (filter === 'running') {
                    row.style.display = status === 'running' || status === 'retrying' ? '' : 'none';
                } else if (filter === 'success') {
                    row.style.display = status === 'success' ? '' : 'none';
                } else if (filter === 'fail') {
                    row.style.display = status === 'fail' ? '' : 'none';
                }
            });
        });

        chatHistory.addEventListener('click', (e) => {
            const img = e.target.closest('.od-user-image-thumb');
            if (!img) return;
            e.stopPropagation();
            showImageLightbox(img.src);
        });

        // 用户消息气泡的右键菜单（样式与侧边栏一致）
        chatHistory.addEventListener('contextmenu', (e) => {
            const bubble = e.target.closest('.od-user-msg');
            if (!bubble) return;
            const container = bubble.closest('.od-user-msg-container');
            if (!container?.dataset?.messageId) return;
            e.preventDefault();
            e.stopPropagation();
            if (window.contextMenuAPI) window.contextMenuAPI.suppress();
            TaskView._showUserMsgContextMenu(e.clientX, e.clientY, bubble, container);
        });

        const scrollButton = this.querySelector('#taskview-scroll-to-bottom-button');
        scrollButton.addEventListener('click', () => {
            this.setAutoScrollingToBottom(true);
            this.tryScrollToEnd();
        });
    }

    static _dismissUserMsgContextMenu() {
        document.getElementById('od-user-msg-ctx')?.remove();
        document.removeEventListener('mousedown', TaskView._userMsgCtxDismissHandler);
    }

    static _userMsgCtxDismissHandler = (e) => {
        if (!e.target.closest('#od-user-msg-ctx')) {
            TaskView._dismissUserMsgContextMenu();
        }
    };

    static _showUserMsgContextMenu(x, y, bubble, messageContainer) {
        TaskView._dismissUserMsgContextMenu();

        const taskView = bubble.closest('task-view');
        const messageId = messageContainer?.dataset?.messageId || '';
        const canRewind = !!taskView?.task_id && !!messageId && !!window.taskManagerAPI?.rewindToUserMessage;
        const menu = document.createElement('div');
        menu.id = 'od-user-msg-ctx';
        Object.assign(menu.style, {
            position: 'fixed',
            zIndex: '9999',
            minWidth: '196px',
            maxWidth: '280px',
            padding: '4px',
            borderRadius: '10px',
            background: 'rgba(255, 255, 255, 0.88)',
            backdropFilter: 'blur(40px) saturate(1.8)',
            WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
            border: '0.5px solid rgba(0, 0, 0, 0.08)',
            boxShadow:
                '0 12px 40px -8px rgba(0,0,0,0.15), 0 0 0 0.5px rgba(0,0,0,0.04), inset 0 0.5px 0 rgba(255,255,255,0.5)',
            animation: 'od-ctx-appear 0.12s ease-out',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            left: `${x}px`,
            top: `${y}px`
        });

        const items = [
            { id: 'copy', icon: 'fa-solid fa-copy', label: taskViewT('renderer.taskview.menu.copy') },
            { id: 'copy-plain', icon: 'fa-solid fa-font', label: taskViewT('renderer.taskview.menu.copyPlain') },
            { id: 'select-all', icon: 'fa-solid fa-text-width', label: taskViewT('renderer.taskview.menu.selectAll') },
            {
                id: 'rewind',
                icon: 'fa-solid fa-clock-rotate-left',
                label: taskViewT('renderer.taskview.menu.rewindToHere'),
                hint: taskViewT('renderer.taskview.menu.rewindHint'),
                separatorBefore: true,
                disabled: !canRewind
            },
            {
                id: 'continue-from',
                icon: 'fa-solid fa-play',
                label: taskViewT('renderer.taskview.menu.continueFromHere'),
                hint: taskViewT('renderer.taskview.menu.continueHint'),
                disabled: !canRewind
            }
        ];

        const btnStyle = `display:flex; align-items:center; gap:8px; width:100%; padding:6px 10px; border:none; border-radius:6px; background:transparent; font-size:12px; cursor:pointer; text-align:left; transition:background 0.1s; color:#1f2937;`;
        const disabledBtnStyle = `opacity:0.45; cursor:not-allowed;`;
        const iconStyle = 'width:16px; text-align:center; font-size:12px; flex-shrink:0; color:#6b7280;';

        const buttonsHtml = items
            .map((item) => {
                const sep = item.separatorBefore
                    ? '<div style="height:1px;background:rgba(0,0,0,0.08);margin:4px 2px;"></div>'
                    : '';
                const disabled = item.disabled ? ' disabled aria-disabled="true"' : '';
                const hint = item.hint ? ` data-hint="${escapeHtml(item.hint)}"` : '';
                const extraStyle = item.disabled ? disabledBtnStyle : '';
                return `${sep}<button data-action="${item.id}"${hint}${disabled} style="${btnStyle}${extraStyle}"><i class="${item.icon}" style="${iconStyle}"></i><span>${escapeHtml(item.label)}</span></button>`;
            })
            .join('');
        menu.innerHTML = `${buttonsHtml}<div data-role="hint" style="display:none;margin:4px 4px 2px;padding:6px 8px;border-top:1px solid rgba(0,0,0,0.08);font-size:11px;line-height:1.45;color:#6b7280;"></div>`;

        document.body.appendChild(menu);

        requestAnimationFrame(() => {
            const margin = 14;
            const rect = menu.getBoundingClientRect();
            const left = Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - rect.width - margin));
            const top = Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - rect.height - margin));
            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
        });

        const hintEl = menu.querySelector('[data-role="hint"]');
        menu.querySelectorAll('[data-action]').forEach((btn) => {
            btn.addEventListener('mouseenter', () => {
                if (btn.disabled) return;
                btn.style.background = '#3b82f6';
                btn.style.color = 'white';
                const icon = btn.querySelector('i');
                if (icon) icon.style.color = 'white';
                if (btn.dataset.hint && hintEl) {
                    hintEl.textContent = btn.dataset.hint;
                    hintEl.style.display = 'block';
                }
            });
            btn.addEventListener('mouseleave', () => {
                if (btn.disabled) return;
                btn.style.background = 'transparent';
                btn.style.color = '#1f2937';
                const icon = btn.querySelector('i');
                if (icon) icon.style.color = '#6b7280';
                if (btn.dataset.hint && hintEl) {
                    hintEl.textContent = '';
                    hintEl.style.display = 'none';
                }
            });
        });

        menu.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
            const sel = window.getSelection();
            if (sel && sel.toString().trim().length > 0) {
                document.execCommand('copy');
            } else {
                navigator.clipboard.writeText(bubble.textContent || '').catch(() => {});
            }
            TaskView._dismissUserMsgContextMenu();
        });

        menu.querySelector('[data-action="copy-plain"]')?.addEventListener('click', () => {
            navigator.clipboard.writeText(bubble.textContent || '').catch(() => {});
            TaskView._dismissUserMsgContextMenu();
        });

        menu.querySelector('[data-action="select-all"]')?.addEventListener('click', () => {
            const range = document.createRange();
            range.selectNodeContents(bubble);
            const s = window.getSelection();
            s.removeAllRanges();
            s.addRange(range);
            TaskView._dismissUserMsgContextMenu();
        });

        const runRewindAction = async (resubmit) => {
            TaskView._dismissUserMsgContextMenu();
            if (!taskView?.task_id || !messageId) return;
            try {
                const result = await window.taskManagerAPI.rewindToUserMessage(taskView.task_id, messageId, {
                    resubmit
                });
                // preload 层已解包 result.data，所以 result 直接就是 { removedCount, resubmitted, userMessageText }
                const userMessageText = !resubmit ? result?.userMessageText : null;
                await taskView.reload();
                if (userMessageText) {
                    const inputWidget = taskView.querySelector(`#task-${taskView.task_id}-input`);
                    if (inputWidget?.setText) {
                        inputWidget.setText(userMessageText);
                    }
                }
            } catch (err) {
                console.error('Failed to rewind task message:', err);
                window.notificationAPI?.sendNotification?.(
                    'error',
                    taskViewT('renderer.taskview.menu.operationTitle'),
                    taskViewT('renderer.taskview.menu.operationFailed'),
                    err?.message || String(err)
                );
            }
        };

        menu.querySelector('[data-action="rewind"]')?.addEventListener('click', () => {
            runRewindAction(false);
        });

        menu.querySelector('[data-action="continue-from"]')?.addEventListener('click', () => {
            runRewindAction(true);
        });

        setTimeout(() => {
            document.addEventListener('mousedown', TaskView._userMsgCtxDismissHandler);
        }, 0);
    }
}

class EmbeddedTaskView extends HTMLElement {
    constructor() {
        super();

        this.task_id = null;
        this.widget_id = crypto.randomUUID();
        /** @type {HTMLDivElement | null} */
        this.history_container = null;
        /** @type {string | null} */
        this.subscription_id = null;
        /**
         * Whether to auto scroll to bottom when new messages are added
         * @type {boolean}
         */
        this.auto_scrolling_to_bottom = true;
        /**
         * Current task status
         * @type {string}
         */
        this.task_status = 'waiting';
        /** @type {Map<string, Set<number>>} 跟踪已渲染的用户消息 part，防止重复渲染 */
        this._renderedUserParts = new Map();
    }

    getHistoryContainer() {
        if (this.history_container === null) {
            this.history_container = this.querySelector('#taskview-chat-history');
        }
        return this.history_container;
    }

    renderUserPart(part) {
        if (part.type === 'image_url') {
            return `<div class="flex flex-col items-end"><div class="od-user-image-group"><div class="od-user-image-container">${part.rendered}</div></div></div>`;
        }
        if (part.type === 'file') {
            return `<div class="self-end max-w-[340px]">${part.rendered}</div>`;
        }
        return `<div class="flex flex-col items-end"><div class="od-user-msg bg-white text-gray-900 rounded-lg px-3 py-1 max-w-3xl border border-gray-200"><div class="${EmbeddedTaskView.USER_PART_CLASS_MAP[part.type] || ''}">${part.rendered}</div></div></div>`;
    }

    renderUserMessage(user_message) {
        const parts = getRenderableUserParts(user_message, user_message.content);
        if (parts.length === 0) {
            return '';
        }
        const rawAttr = user_message.rawText ? ` data-raw-text="${escapeHtml(user_message.rawText)}"` : '';
        const timeHtml = user_message.timestamp
            ? `<div class="text-right text-[10px] text-gray-400 mt-0.5 mr-1">${TaskView.formatRelativeTime(user_message.timestamp)}</div>`
            : '';

        let inner = '';
        for (const part of parts) {
            inner += this.renderUserPart(part);
        }
        inner += timeHtml;

        return `<div id="user-msg-${escapeHtml(user_message.message_id)}" class="od-user-msg-container" data-message-id="${escapeHtml(user_message.message_id)}"${rawAttr}>${inner}</div>`;
    }

    static USER_PART_CLASS_MAP = {
        text: 'bg-transparent text-[13px] text-black markdown-body'
    };

    static ASSISTANT_PART_CLASS_MAP = {
        text: 'py-1.5 bg-transparent text-[13px] text-black markdown-body',
        reasoning: '',
        tool_call: ''
    };

    renderAssistantPart(part, classMap = EmbeddedTaskView.ASSISTANT_PART_CLASS_MAP) {
        if (part.type === 'reasoning') {
            return TaskView.createReasoningPartHtml(part.rendered, false, part.elapsedSeconds);
        }
        return `<div class="${classMap[part.type] || ''}">${part.rendered || ''}</div>`;
    }

    renderAssistantParts(parts, classMap = EmbeddedTaskView.ASSISTANT_PART_CLASS_MAP) {
        return parts.map((part) => this.renderAssistantPart(part, classMap)).join('');
    }

    renderAssistantMessage(assistant_message) {
        const content = this.renderAssistantParts(assistant_message.content);
        const html = `
        <div class="od-assistant-msg-container flex items-start">
            <div id='message-container-${assistant_message.message_id}' class="px-2 bg-transparent w-full">
                <div id='message-${assistant_message.message_id}'>
                    ${content}
                </div>
            </div>
        </div>
        `;
        return html;
    }

    createEmptyAssistantContainer(message_id) {
        return `
        <div class="od-assistant-msg-container flex items-start">
            <div id='message-container-${message_id}' class="px-2 bg-transparent w-full">
                <div id='message-${message_id}'>
                </div>
            </div>
        </div>
        `;
    }

    _removeWaitingAssistantPlaceholder() {
        const waitingPlaceholder = this.getHistoryContainer().querySelector('.waiting-usage-placeholder');
        if (waitingPlaceholder) waitingPlaceholder.remove();
    }

    _showWaitingAssistantPlaceholder(options = {}) {
        const historyContainer = this.getHistoryContainer();
        const existingPlaceholder = historyContainer.querySelector('.waiting-usage-placeholder');
        if (!options.force && TaskView.hasAssistantOutputAfterLatestUser(historyContainer)) {
            existingPlaceholder?.remove();
            return;
        }
        if (existingPlaceholder) {
            historyContainer.appendChild(existingPlaceholder);
            return;
        }
        historyContainer.insertAdjacentHTML('beforeend', TaskView.createWaitingAssistantPlaceholderHtml());
    }

    handleRetryProgress(progress) {
        const existing = this.querySelector('.od-task-retry-status');
        if (progress.status === 'cleared') {
            existing?.remove();
            return;
        }

        const html = TaskView.formatRetryStatusHtml(progress);
        if (existing) {
            existing.outerHTML = html;
        } else {
            this.getHistoryContainer().insertAdjacentHTML('beforeend', html);
        }
    }

    handleAssistantReplace(progress) {
        let message_element = this.querySelector(`#message-${progress.message_id}`);

        if (progress.parts.length === 0) {
            if (message_element) {
                const wrapper = message_element.closest('.od-assistant-msg-container');
                if (wrapper) {
                    wrapper.remove();
                } else {
                    message_element.remove();
                }
            }
            if (progress.task_status === 'running') {
                this._showWaitingAssistantPlaceholder();
            }
            return;
        }

        this._removeWaitingAssistantPlaceholder();
        if (!message_element) {
            this.getHistoryContainer().insertAdjacentHTML(
                'beforeend',
                this.createEmptyAssistantContainer(progress.message_id)
            );
            message_element = this.querySelector(`#message-${progress.message_id}`);
        }
        if (!message_element) return;

        message_element.innerHTML = this.renderAssistantParts(progress.parts);
        enhanceCodeBlocks(message_element);
        enhanceToolPreviewCards(message_element);
    }

    tryScrollToEnd() {
        const domElement = this.getHistoryContainer();
        setTimeout(() => {
            if (!this.auto_scrolling_to_bottom) {
                return;
            }
            domElement.scroll({
                top: domElement.scrollHeight,
                behavior: 'smooth'
            });
        }, 100);
    }

    updateStopButtonVisibility() {
        // EmbeddedTaskView 没有输入框，不需要停止按钮
        // 停止功能由应用层面的输入框控制
    }

    /**
     * 发送任务状态变化事件
     * @param {string} status 任务状态
     */
    emitTaskStatusChanged(status) {
        const event = new CustomEvent('task-status-changed', {
            detail: {
                taskId: this.task_id,
                status: status
            },
            bubbles: true
        });
        this.dispatchEvent(event);
    }

    async reload() {
        const task_state = await window.taskManagerAPI.getFullTask(this.task_id);
        const previous_status = this.task_status;
        this.task_status = task_state.task_status || 'waiting';
        this.updateStopButtonVisibility();

        // 如果状态发生变化，发送事件
        if (previous_status !== this.task_status) {
            this.emitTaskStatusChanged(this.task_status);
        }

        const history_container = this.getHistoryContainer();
        const htmlParts = [];
        const messages = task_state.chat_context.messages;
        const goalEvaluationRecords = getGoalEvaluationRecords(task_state.goal);
        const lastAssistantIdx = (() => {
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'assistant') return i;
            }
            return -1;
        })();
        const lastAssistantMessage = lastAssistantIdx >= 0 ? messages[lastAssistantIdx] : null;
        const isWaitingForAssistant =
            this.task_status === 'running' &&
            (lastAssistantIdx === -1 ||
                !Array.isArray(lastAssistantMessage?.content) ||
                lastAssistantMessage.content.length === 0);
        for (const message of messages) {
            if (message.role === 'user') {
                if (!shouldRenderUserHistoryMessage(message)) continue;
                htmlParts.push(this.renderUserMessage(message));
            } else if (message.role === 'assistant') {
                if (!Array.isArray(message.content) || message.content.length === 0) continue;
                htmlParts.push(this.renderAssistantMessage(message));
            } else if (TaskView.isCompactBoundaryMessage(message)) {
                htmlParts.push(TaskView.renderCompactBoundary());
            }
            const goalEvaluationHtml = renderGoalEvaluationRecordsHtml(
                getGoalEvaluationRecordsForMessage(goalEvaluationRecords, message),
                this.task_id
            );
            if (goalEvaluationHtml) {
                htmlParts.push(goalEvaluationHtml);
            }
        }
        const unanchoredGoalEvaluationHtml = renderGoalEvaluationRecordsHtml(
            getUnanchoredGoalEvaluationRecords(goalEvaluationRecords, messages),
            this.task_id
        );
        if (unanchoredGoalEvaluationHtml) {
            htmlParts.push(unanchoredGoalEvaluationHtml);
        }
        history_container.innerHTML = htmlParts.join('');
        enhanceCodeBlocks(history_container);
        enhanceToolPreviewCards(history_container);
        if (isWaitingForAssistant) {
            this._showWaitingAssistantPlaceholder();
        }
        this._renderedUserParts.clear();
        this.tryScrollToEnd();
    }

    /** 渲染目标评估进度和结果（EmbeddedTaskView 版）。 */
    _renderGoalEvalProgress(progress) {
        const historyContainer = this.getHistoryContainer();
        const selectorId = getGoalEvalSelectorId(progress);
        const el = historyContainer.querySelector(`#${selectorId}`);

        const html = renderGoalEvalProgressHtml(progress, selectorId);

        if (el) {
            el.outerHTML = html;
        } else {
            insertGoalEvalHtml(
                historyContainer,
                findRenderedMessageAnchor(this, progress.anchorMessageId),
                html,
                progress
            );
        }
        this.tryScrollToEnd();
    }

    connectedCallback() {
        const task_id = this.getAttribute('task_id');
        if (task_id === null) {
            throw new Error('task_id is required');
        }
        this.task_id = task_id;

        this.render();
        this._handleReasoningToggleClick = this._handleReasoningToggleClick.bind(this);
        this.addEventListener('click', this._handleReasoningToggleClick);
        this._handleReasoningHoverEnter = this._handleReasoningHoverEnter.bind(this);
        this._handleReasoningHoverLeave = this._handleReasoningHoverLeave.bind(this);
        this.addEventListener('mouseover', this._handleReasoningHoverEnter);
        this.addEventListener('mouseout', this._handleReasoningHoverLeave);
        this.reload().then(async () => {
            // 在首次加载完成后，发送一次初始状态事件
            this.emitTaskStatusChanged(this.task_status);

            this.subscription_id = await window.taskManagerAPI.subscribeTaskUpdate(this.task_id, (progress) => {
                const history_container = this.getHistoryContainer();

                if (progress.type === 'user_replace') {
                    if (!shouldRenderUserHistoryMessage(progress)) return;
                    const container = this.querySelector(`#user-msg-${progress.message_id}`);
                    if (container) {
                        container.innerHTML = '';
                        if (progress.rawText) {
                            container.dataset.rawText = progress.rawText;
                        }
                        for (const part of getRenderableUserParts(progress, progress.parts)) {
                            container.insertAdjacentHTML('beforeend', this.renderUserPart(part));
                        }
                        const timeHtml = progress.timestamp
                            ? `<div class="text-right text-[10px] text-gray-400 mt-0.5 mr-1">${TaskView.formatRelativeTime(progress.timestamp)}</div>`
                            : '';
                        if (timeHtml) container.insertAdjacentHTML('beforeend', timeHtml);
                    }
                } else if (progress.type === 'assistant_replace') {
                    this.handleAssistantReplace(progress);
                } else if (progress.type === 'retry') {
                    this.handleRetryProgress(progress);
                } else if (progress.type === 'user') {
                    if (!shouldRenderUserHistoryMessage(progress)) return;
                    const parts = getRenderableUserParts(progress, progress.last_part ? [progress.last_part] : []);
                    if (parts.length === 0) return;

                    // 去重：追踪已渲染的 part，防止后端竞态导致重复推送
                    let renderedSet = this._renderedUserParts.get(progress.message_id);
                    if (!renderedSet) {
                        renderedSet = new Set();
                        this._renderedUserParts.set(progress.message_id, renderedSet);
                    }
                    if (renderedSet.has(progress.last_part_index)) {
                        return; // 该 part 已渲染，跳过重复推送
                    }
                    renderedSet.add(progress.last_part_index);

                    let container = this.querySelector(`#user-msg-${progress.message_id}`);
                    if (!container) {
                        history_container.insertAdjacentHTML(
                            'beforeend',
                            `<div id="user-msg-${progress.message_id}" class="od-user-msg-container" data-raw-text="${(progress.rawText || '').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"></div>`
                        );
                        container = this.querySelector(`#user-msg-${progress.message_id}`);
                    }
                    const part = parts[0];
                    container.insertAdjacentHTML('beforeend', this.renderUserPart(part));
                    if (progress.isLastPart) {
                        const timeHtml = progress.timestamp
                            ? `<div class="text-right text-[10px] text-gray-400 mt-0.5 mr-1">${TaskView.formatRelativeTime(progress.timestamp)}</div>`
                            : '';
                        if (timeHtml) container.insertAdjacentHTML('beforeend', timeHtml);
                    }
                    if (progress.task_status === 'running') {
                        this._showWaitingAssistantPlaceholder();
                    }
                } else if (progress.type === 'goal_eval') {
                    this._renderGoalEvalProgress(progress);
                } else {
                    let message_element = this.querySelector(`#message-${progress.message_id}`);
                    if (!message_element) {
                        this._removeWaitingAssistantPlaceholder();
                        history_container.insertAdjacentHTML(
                            'beforeend',
                            this.createEmptyAssistantContainer(progress.message_id)
                        );
                        message_element = this.querySelector(`#message-${progress.message_id}`);
                    }
                    if (message_element && message_element.children.length <= progress.last_part_index) {
                        if (progress.last_part.type === 'reasoning') {
                            message_element.insertAdjacentHTML('beforeend', TaskView.createReasoningPartHtml('', true));
                        } else {
                            // Finalize any active reasoning blocks before inserting a new non-reasoning part
                            message_element.querySelectorAll('.reasoning-block-od.reasoning-active').forEach((el) => {
                                TaskView.finalizeReasoningBlock(el);
                            });
                            message_element.insertAdjacentHTML(
                                'beforeend',
                                `<div class='${EmbeddedTaskView.ASSISTANT_PART_CLASS_MAP[progress.last_part.type]}'></div>`
                            );
                        }
                    }
                    if (message_element) {
                        const last_part_element = message_element.children[progress.last_part_index];
                        if (last_part_element) {
                            if (progress.last_part.type === 'reasoning') {
                                TaskView.updateReasoningPreview(last_part_element, progress.last_part.rendered || '');
                            } else {
                                last_part_element.innerHTML = progress.last_part.rendered || '';
                            }

                            if (progress.last_part.type === 'tool_call') {
                                last_part_element.querySelectorAll('.terminal-tool-scroll').forEach((el) => {
                                    el.scrollTop = el.scrollHeight;
                                });
                                enhanceToolPreviewCards(last_part_element);
                            }

                            if (progress.last_part.type === 'text') {
                                enhanceCodeBlocks(last_part_element);
                            }
                        }
                    }
                }
                this.tryScrollToEnd();

                if (progress.task_status && progress.task_status !== this.task_status) {
                    this.task_status = progress.task_status;
                    this.emitTaskStatusChanged(this.task_status);
                    if (this.task_status !== 'running') {
                        this.getHistoryContainer()
                            .querySelectorAll('.reasoning-block-od.reasoning-active')
                            .forEach((el) => {
                                TaskView.finalizeReasoningBlock(el);
                            });
                    }
                }
            });
        });
    }

    disconnectedCallback() {
        window.taskManagerAPI.unsubscribeTaskUpdate(this.task_id, this.subscription_id);
        this.subscription_id = null;
        this.removeEventListener('click', this._handleReasoningToggleClick);
        this.removeEventListener('mouseover', this._handleReasoningHoverEnter);
        this.removeEventListener('mouseout', this._handleReasoningHoverLeave);
        this.getHistoryContainer()
            ?.querySelectorAll('.reasoning-block-od.reasoning-active')
            .forEach((el) => TaskView.finalizeReasoningBlock(el));
        if (this._domSanitizer) {
            this._domSanitizer.disconnect();
            this._domSanitizer = null;
        }
    }

    setAutoScrollingToBottom(auto_scrolling_to_bottom) {
        this.auto_scrolling_to_bottom = auto_scrolling_to_bottom;
        const scrollButton = this.querySelector('#taskview-scroll-to-bottom-button');
        if (auto_scrolling_to_bottom) {
            scrollButton.classList.add('hidden');
        } else {
            scrollButton.classList.remove('hidden');
        }
    }

    render() {
        this.innerHTML = `
        <div class="bg-gray-30 h-full flex flex-col">
            <div class="relative flex-1 overflow-y-auto p-3 space-y-1" id="taskview-chat-history"></div>

            <!-- 滚动到底部按钮, 按需显示 -->
            <button
                id="taskview-scroll-to-bottom-button"
                class="absolute bottom-20 left-1/2 -translate-x-1/2 flex items-center justify-center px-3 py-1 text-white rounded-full shadow transition-all focus:outline-none active:scale-95 text-xs hidden"
                style="min-width: unset; height: 2rem; background: rgba(120,140,170,0.72); backdrop-filter: blur(4px);"
                title="滚动到底部"
            >
                <i class="fas fa-arrow-down text-sm"></i>
                <span class="ml-1">滚动到底部</span>
            </button>
        </div>
        `;

        this.querySelector('#taskview-scroll-to-bottom-button').addEventListener('click', () => {
            this.setAutoScrollingToBottom(true);
            this.tryScrollToEnd();
        });
        const chatHistory = this.querySelector('#taskview-chat-history');
        chatHistory.addEventListener('scroll', (event) => {
            const scrollBottom = event.target.scrollTop + event.target.clientHeight;
            const distanceToBottom = Math.abs(event.target.scrollHeight - scrollBottom);
            if (distanceToBottom < 80) {
                if (!this.auto_scrolling_to_bottom) {
                    this.setAutoScrollingToBottom(true);
                }
            } else {
                if (this.auto_scrolling_to_bottom) {
                    this.setAutoScrollingToBottom(false);
                }
            }
        });

        chatHistory.addEventListener('click', (e) => {
            const img = e.target.closest('.od-user-image-thumb');
            if (!img) return;
            e.stopPropagation();
            showImageLightbox(img.src);
        });

        const hc = this.getHistoryContainer();
        if (hc) {
            this._domSanitizer = installDOMSanitizer(hc);
        }
    }
}

customElements.define('task-view', TaskView);
customElements.define('embedded-task-view', EmbeddedTaskView);
