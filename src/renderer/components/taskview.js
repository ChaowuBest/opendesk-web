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

import { ensureOverlayStyles } from './overlay.js';
import { ElasticToolbarWidget } from './toolbar.ts';
import { morphDomChildren } from '../utils/dom-morph.js';
import { updateStreamingText } from '../utils/streaming-text.js';
import { AssistantProgressBuffer } from '../utils/assistant-progress-buffer.js';
import { BackgroundUpdateGate } from '../utils/background-update-gate.js';
import { nestedScrollerConsumesWheel } from '../utils/history-scroll.js';
import { ChatNavigation, buildConversationStops, mergeRenderedConversationStops } from './chatNavigation.js';
import { ChatFind } from './chatFind.js';
import './taskartifacts.ts';
import { BrowserPip } from './browserPip.ts';
import { showImageLightbox } from './imageLightbox.js';
import { showWorkspacePicker } from './workspacePicker.ts';
import { showConfirmModal } from './confirmModal.ts';
import './skills/skill-detail-card.ts';
import {
    enhanceCodeBlocks,
    enhanceToolPreviewCards,
    renderMermaidBlocks,
    untrackPreviewerContainers
} from './previewer.ts';
import { escapeHtml } from '../../common/utils/escape.js';
import { getSafeWebUrl } from '../../common/web-link.js';
import { normalizeDriveRootPath } from '../../common/utils/path.js';
import { createRendererTranslator } from '../locale.ts';
import { renderSafeMarkdown } from '../utils/markdown.ts';
import { DeferredTaskUpdateQueue } from '../utils/deferred-task-updates.ts';
import { shouldReleaseTaskView, TASK_VIEW_BACKGROUND_RELEASE_MS } from '../utils/task-view-release.ts';
import { buildTaskExportHtml } from '../utils/task-export.ts';
import { createWebLinkContextMenuItems } from '../utils/web-link-context-menu.ts';
import {
    GoalController,
    canShowWaitingAssistantPlaceholder,
    getGoalEditReminderGoalId,
    hasGoalEditReminderAfterLatestAssistant,
    isGoalEditReminderMessage,
    isWaitingForAssistantReply,
    mergeGoalSummary
} from './taskview-goal/controller.js';

/** 右侧面板展开/收起动画时长（与 _expandRightSidebar / _collapseRightSidebar 的 transition 保持一致） */
const RIGHT_SIDEBAR_TRANSITION_MS = 280;
/** 收起后显示画中画的兜底延时：过渡事件不触发时，等动画时长 + 一点缓冲，确保布局已落定 */
const BROWSER_PIP_SHOW_FALLBACK_MS = RIGHT_SIDEBAR_TRANSITION_MS + 60;

const SIDEBAR_TOGGLE_SVG =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6.5 3v10"/></svg>';
const EXPORT_OPEN_SVG =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7.79 3H4.36A1.35 1.35 0 0 0 3 4.36v7.29A1.35 1.35 0 0 0 4.36 13h7.29A1.35 1.35 0 0 0 13 11.65V8"/><path d="M8 8 13 3"/><path d="M9.8 3H13v3.2"/></svg>';
const EXPORT_WEBPAGE_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';
const EXPORT_JSON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M10 11c-.6 0-1 .4-1 1v1c0 .6-.4 1-1 1 .6 0 1 .4 1 1v1c0 .6.4 1 1 1"/><path d="M14 11c.6 0 1 .4 1 1v1c0 .6.4 1 1 1-.6 0-1 .4-1 1v1c0 .6-.4 1-1 1"/></svg>';

const RUNNING_TOOL_ICON_SVG =
    '<svg class="lucide lucide-wrench od-running-status-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94L14.7 6.3z"/></svg>';
const RUNNING_THINKING_ICON_SVG =
    '<svg class="lucide lucide-lightbulb od-running-status-thinking-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.68.66-1.17 1.16-1.75A6 6 0 1 0 7.75 12.25c.48.56.97 1.07 1.16 1.75"/></svg>';
const CHEVRON_RIGHT_ICON_SVG =
    '<svg class="lucide lucide-chevron-right" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';

const COPY_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const REGENERATE_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>';
const FORK_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/></svg>';
const EDIT_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const RESEND_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';
const CTX_FONT_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>';
const CTX_SELECT_ALL_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/></svg>';
const FILE_TAG_PREVIEW_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const FILE_TAG_OPEN_DEFAULT_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
const FILE_TAG_REVEAL_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
import {
    findActiveGoalEvalProgress,
    getGoalEvaluationRecordsForMessage,
    getTaskGoalEvaluationRecords,
    getUnanchoredGoalEvaluationRecords,
    relocateGoalEvaluationsToMessage,
    renderGoalEvaluationProgress,
    renderGoalEvaluationRecordsHtml
} from './taskview-goal/evaluation.js';
import {
    getGoalSupplementDisplayText,
    getGoalSupplementIds,
    shouldRenderGoalUserMessage
} from '../../common/goal/user-message-display.ts';
import {
    MIN_CHAT_AREA_WIDTH,
    RIGHT_PANEL_RESIZER_WIDTH,
    WORKSPACE_FOCUS_LAYOUT_CHANGE_EVENT,
    WorkspaceFocusLayoutController
} from './workspaceFocusLayout.js';
import { listenForAgentInputRequests } from '../input/agentInputRequest.js';
import {
    buildAssistantOutputItems,
    getDefaultExpanded,
    getVisibleAssistantOutputItems,
    normalizeGuiOutputMode,
    normalizeGuiReasonDisplayMode
} from './taskview-output.js';
import { installGenUi, renderGenUiForExport, setGenUiLocaleSource } from '../genui/index.js';

const DANGEROUS_TAGS = new Set(['STYLE', 'SCRIPT', 'LINK', 'META', 'IFRAME', 'OBJECT', 'EMBED', 'APPLET', 'BASE']);
const BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_RIGHT_SIDEBAR_WIDTH = 380;
export const TASKVIEW_HISTORY_BATCH_MESSAGE_LIMIT = 20;
export const TASKVIEW_HISTORY_BATCH_HTML_CHAR_LIMIT = 200000;
const TASKVIEW_HISTORY_TOP_LOAD_THRESHOLD_PX = 96;
const TASKVIEW_HISTORY_VIEWPORT_FILL_GUARD = 8;
// 锁定底部时滚动跟随使用 rAF 合并（每帧最多执行一次）：scrollHeight 读取会强制
// 同步布局，高频流式输出下把同一帧内多次 DOM 更新合并为一次读取与滚动，避免在
// 巨大会话 DOM 上反复全量重排。相比时间节流（旧 150ms），每次快照后下一帧即跟随
// 到最新底部，消除"内容已增高但滚动未跟上"导致的滚动条 thumb 抖动。
const PROCESS_INNER_SCROLL_BOTTOM_THRESHOLD_PX = 24;
// 流式思考预览只保留尾部切片：全文每帧重写的布局/文本成本会随思考长度线性膨胀，
// 是长任务下渲染进程 CPU 飙高的主因之一。
const TASKVIEW_REASONING_PREVIEW_TAIL_CHARS = 2000;
let taskViewT = createRendererTranslator();
// showUI/askUI 工具调用渲染出的组件占位节点由生成式 UI 模块挂载成 React 组件
installGenUi();
let guiOutputMode = 'minimal';
let guiReasonDisplayMode = 'inline';

function updateTaskViewTranslator(setting) {
    taskViewT = createRendererTranslator(setting);
    setGenUiLocaleSource(setting);
    const nextOutputMode = normalizeGuiOutputMode(setting?.gui_config?.output_mode);
    const nextReasonDisplayMode = normalizeGuiReasonDisplayMode(setting?.gui_config?.gui_reason_display);
    const outputModeChanged = nextOutputMode !== guiOutputMode;
    const reasonDisplayModeChanged = nextReasonDisplayMode !== guiReasonDisplayMode;
    guiOutputMode = nextOutputMode;
    guiReasonDisplayMode = nextReasonDisplayMode;
    if (outputModeChanged || reasonDisplayModeChanged) {
        document.querySelectorAll('task-view').forEach((view) => view._handleGuiDisplaySettingsChanged?.());
    }
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

function createRenderedTextPartFromPlainText(text) {
    return {
        type: 'text',
        rendered: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`
    };
}

export function shouldRenderUserHistoryMessage(message) {
    return shouldRenderGoalUserMessage(message);
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

function formatReasoningElapsedTime(seconds, tokens = null) {
    let timeStr;
    if (seconds < 60) {
        timeStr = taskViewT('reasoning.elapsed.seconds', { seconds });
    } else {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        timeStr = taskViewT('reasoning.elapsed.minutes', { minutes, seconds: remainingSeconds });
    }
    if (tokens != null) {
        // 入参已是加权估算 token（与 usage 胶囊同口径），直接展示
        const normalized = Math.max(1, Math.round(tokens));
        timeStr += taskViewT('reasoning.elapsed.chars', { chars: normalized });
    }
    return timeStr;
}

/** 将毫秒耗时格式化为耗时展示文案：<60s 显示秒，<1h 显示分+秒，≥1h 显示小时+分。 */
function formatTurnDuration(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return '';
    const totalSeconds = Math.floor(durationMs / 1000);
    if (totalSeconds < 60) {
        return taskViewT('renderer.taskview.output.duration.seconds', { seconds: totalSeconds });
    }
    if (totalSeconds < 3600) {
        return taskViewT('renderer.taskview.output.duration.minutes', {
            minutes: Math.floor(totalSeconds / 60),
            seconds: totalSeconds % 60
        });
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    return taskViewT('renderer.taskview.output.duration.hours', {
        hours: Math.floor(totalMinutes / 60),
        minutes: totalMinutes % 60
    });
}

/** 提取一条 assistant 消息的 turn 耗时（毫秒）：读取 execution.startAt/finishAt；老任务缺少任一字段则无法计算。 */
function extractAssistantTurnDurationMs(message) {
    if (!message) return null;
    const execution = message.metadata?.execution;
    const startAt = typeof execution?.startAt === 'number' ? execution.startAt : null;
    const finishAt = typeof execution?.finishAt === 'number' ? execution.finishAt : null;
    if (startAt != null && finishAt != null && finishAt >= startAt) {
        return finishAt - startAt;
    }
    return null;
}

/** 提取 assistant 消息 turn 的结束时间（毫秒时间戳）：优先 finishAt，回退 startAt；老任务在反序列化时已迁移。 */
function getAssistantTurnEndTimestamp(message) {
    const execution = message?.metadata?.execution;
    if (typeof execution?.finishAt === 'number') return execution.finishAt;
    if (typeof execution?.startAt === 'number') return execution.startAt;
    return null;
}

/**
 * 流式思考预览的尾部切片：预览区始终滚动钉底展示最新内容，
 * 只写尾部可将每帧 DOM 写入与文本排版成本从 O(累计长度) 降到 O(切片长度)。
 * 切片按行边界对齐，避免首行显示半截内容。
 */
function sliceReasoningPreviewTail(text) {
    const value = text || '';
    if (value.length <= TASKVIEW_REASONING_PREVIEW_TAIL_CHARS) return value;
    const tail = value.slice(-TASKVIEW_REASONING_PREVIEW_TAIL_CHARS);
    const newlineIndex = tail.indexOf('\n');
    return newlineIndex >= 0 ? tail.slice(newlineIndex + 1) : tail;
}

/**
 * 终端工具卡片的开合态归一化。主进程渲染的卡片固定带 open（工具渲染层不应感知
 * GUI 输出模式），这里在渲染前按当前模式改写：极简模式收起、详细模式展开。
 *
 * 只重写 class 含 terminal-tool 的 <details> 开标签，[^>]* 不会跨过标签进入 body。
 */
const TERMINAL_CARD_DETAILS_TAG_RE = /<details\b([^>]*\bclass="[^"]*\bterminal-tool(?=[\s"])[^"]*"[^>]*)>/g;

class TaskView extends HTMLElement {
    // 全局侧边栏状态：跨任务共享
    static rightSidebarExpanded = false;
    static rightSidebarWidth = 380;

    get isEmbedded() {
        return this.hasAttribute('embedded');
    }

    get _currentGoal() {
        return this._goalController.currentGoal;
    }

    set _currentGoal(value) {
        this._goalController.currentGoal = value;
    }

    get _goalRefreshTimer() {
        return this._goalController.refreshTimer;
    }

    set _goalRefreshTimer(value) {
        this._goalController.refreshTimer = value;
    }

    get _goalLiveRefreshTimer() {
        return this._goalController.liveRefreshTimer;
    }

    set _goalLiveRefreshTimer(value) {
        this._goalController.liveRefreshTimer = value;
    }

    get _goalRefreshPending() {
        return this._goalController.refreshPending;
    }

    set _goalRefreshPending(value) {
        this._goalController.refreshPending = value;
    }

    get _pendingGoalSupplementMessages() {
        return this._goalController.pendingSupplementMessages;
    }

    set _pendingGoalSupplementMessages(value) {
        this._goalController.pendingSupplementMessages = value;
    }

    get _consumedGoalSupplementPendingItems() {
        return this._goalController.consumedSupplementPendingItems;
    }

    set _consumedGoalSupplementPendingItems(value) {
        this._goalController.consumedSupplementPendingItems = value;
    }

    get _pendingGoalEditMessage() {
        return this._goalController.pendingEditMessage;
    }

    set _pendingGoalEditMessage(value) {
        this._goalController.pendingEditMessage = value;
    }
    constructor() {
        super();

        // 每个任务独立的侧边栏状态
        this._rightSidebarExpanded = false;
        this._rightSidebarWidth = DEFAULT_RIGHT_SIDEBAR_WIDTH;
        this._workspaceFocusLayout = new WorkspaceFocusLayoutController({
            getPanel: () => this.querySelector(`#task-${this.task_id}-artifacts`),
            getDefaultPanelWidth: () => `${this._rightSidebarWidth || DEFAULT_RIGHT_SIDEBAR_WIDTH}px`,
            getMaxPanelWidth: () => this._getMaxRightSidebarWidth(),
            shouldSuppressAnimation: () => this._shouldSuppressIncrementalRender(),
            collapseNavigation: () => {
                document.dispatchEvent(
                    new CustomEvent('sidebar-collapse-request', {
                        detail: { collapsed: true, persist: false },
                        bubbles: true
                    })
                );
            },
            isNavigationCollapsed: () => {
                return document.getElementById('app-root')?.classList.contains('sidebar-collapsed') ?? false;
            },
            expandNavigation: () => {
                document.dispatchEvent(
                    new CustomEvent('sidebar-collapse-request', {
                        detail: { collapsed: false, persist: false },
                        bubbles: true
                    })
                );
            }
        });
        this.addEventListener(WORKSPACE_FOCUS_LAYOUT_CHANGE_EVENT, this._workspaceFocusLayout.handleChange);

        this.task_id = null;
        this._goalController = new GoalController(this, { getTranslator: () => taskViewT });
        this.widget_id = crypto.randomUUID();
        /** @type {HTMLDivElement | null} */
        this.history_container = null;
        /** @type {string | null} */
        this.subscription_id = null;
        /** @type {number} 用于丢弃组件卸载后才完成的异步初始化。 */
        this._connectionEpoch = 0;
        this.auto_scrolling_to_bottom = true;
        this.task_status = 'waiting';
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
        /** @type {{p: number, t: number} | null} 任务内最近一次真实 usage（输入/总计），流式估算的基线 */
        this._contextUsageBaseline = null;
        /** @type {Map<string, HTMLElement>} 缓存活跃的 message container 元素 */
        this._messageContainerCache = new Map();
        this._assistantProgressBuffer = new AssistantProgressBuffer((progress) => {
            if (this._shouldSuppressIncrementalRender()) return;
            // 兜底丢弃隐藏边界上的 50ms pending 快照（push 在隐藏前、定时器到期在
            // 隐藏后）。丢弃必须登记补齐标记：窗口冻结期间被丢弃的一切渲染工作
            // 都由恢复可见时的一次 reload 全量恢复
            if (this._isWindowRenderFrozen()) {
                this._backgroundUpdateGate.markPendingReload();
                return;
            }
            const historyContainer = this.getHistoryContainer();
            if (!historyContainer) return;
            this._renderAssistantProgress(progress, historyContainer);
            this.tryScrollToEnd();
        });
        // 窗口隐藏（最小化/完全遮挡）但本视图仍活跃时冻结渲染工作：后台期间
        // backgroundThrottling 只节流 timer/rAF，IPC 到达后的 DOM 工作照常执行，
        // 持续积攒渲染债务；窗口置前时合成器恢复被积压债务阻塞，表现为回前台
        // 数秒不响应。冻结期间跳过的更新由恢复可见时的一次 reload 全量补齐。
        this._backgroundUpdateGate = new BackgroundUpdateGate(
            () => !this._isWindowRenderFrozen(),
            () => {
                // reload 对非损坏错误会重抛，吞掉 rejection 避免 unhandled；
                // 失败后标记已消费，等待下一个可见性周期自然补齐，不做无限重试
                this.reload().catch((error) =>
                    console.error('Failed to reload task view after window became visible:', error)
                );
            }
        );
        /** @type {number | null} 滚动跟随的 rAF id（同一帧内多次更新合并为一次跟随） */
        this._scrollRafId = null;
        /** @type {number} 视图进入后台不可见的时间戳；0 表示可见。用于后台超时释放。 */
        this._viewHiddenAt = 0;
        /** @type {number | null} 节流过程区内部滚动的 rAF id */
        this._processScrollFollowRafId = null;
        /** @type {Map<string, {root: HTMLElement, targetKey: string}>} */
        this._pendingProcessScrollFollowTargets = new Map();
        /** @type {BrowserPip | null} 浏览器画中画浮窗 */
        this._browserPip = null;
        /** @type {number | null} 侧边栏收起后延迟显示画中画的定时器 */
        this._browserPipShowTimer = null;
        /** @type {number | null} 浏览器空闲销毁倒计时 */
        this._browserIdleTimer = null;
        /** @type {Array<{id: string, message: string, attachedFilePaths: string[], attachedImages: string[], selectedModel?: string, reasoningEffort?: string}>} 消息队列 */
        this.messageQueue = [];
        /** @type {boolean} 正在执行 sendQueueMessageImmediately 流程 */
        this._immediateQueueSending = false;
        /** @type {Map<string, Set<number>>} 跟踪已渲染的用户消息 part（message_id → part_index 集合），防止重复渲染 */
        this._renderedUserParts = new Map();
        /** @type {Map<string, Array<object>>} 增量消息的完整 part 快照。 */
        this._assistantPartsByMessage = new Map();
        /** @type {Map<string, {isRunning: boolean}>} assistant 输出重绘所需的渲染状态。 */
        this._assistantRenderStateByMessage = new Map();
        /** @type {Map<string, Map<string, boolean>>} 模式切换期间不可见 disclosure 的展开状态。 */
        this._assistantDisclosureStateByMessage = new Map();
        /** @type {Map<string, boolean>} 极简运行态是否展开了当前消息的执行过程。 */
        this._assistantRunningDetails = new Map();
        /** @type {boolean} 是否正在执行 reload()，用于暂停订阅回调的 DOM 操作 */
        this._reloading = false;
        /** @type {number} reload 版本号，用于丢弃过期 reload 的后续操作 */
        this._reloadVersion = 0;
        /** reload 重建 DOM 期间到达、待重放的任务更新（流式快照按 key 去重，防积压）。 */
        this._deferredTaskUpdates = new DeferredTaskUpdateQueue();
        /** @type {((progress: object) => void) | null} 当前订阅的统一更新处理器。 */
        this._taskUpdateHandler = null;
        /** @type {Array<object>} 当前任务的完整持久化消息列表，DOM 只渲染其中的尾部窗口。 */
        this._historyMessages = [];
        /** @type {number|null} 最近一次 assistant turn 的本地完成时间，用于隐藏历史消息场景下的时间戳兜底。 */
        this._lastAssistantCompletedAt = null;
        /** @type {Array<object>} 当前任务持久化的 goal evaluation 记录，用 message anchor 插入历史上下文。 */
        this._historyGoalEvaluationRecords = [];
        /** @type {number} 当前已经渲染的最早持久化消息下标。 */
        this._historyRenderStartIndex = 0;
        /** @type {boolean} 防止顶部滚动连续触发重复补载。 */
        this._loadingOlderHistory = false;
        /**
         * 输出速度统计 - 消息级累计状态（跨 part 保留，工具 part 不清零）：
         * messageTokens 为消息内所有生成 part 的 CJK 加权估算 token 数（浮点累计），
         * 用于无 usage 时估算「已输出 / 总计」；messageUsage 记录本消息最近一次真实 usage，
         * 用于估算基线；usageOffset 为 usage 首达时的 token 序列校准偏移
         * （估算→真实切换保持连续，速度不跳变）；
         * samples 为滑动窗口测速样本（{t, seq}，seq 为消息级累计 token 序列值）。
         * @type {{messageId: string, messageTokens: number, messageUsage: {p: number, c: number, t: number} | null, messageTokensAtUsage: number, usageOffset: number | null, samples: Array<{t: number, seq: number}>} | null}
         */
        this._speedMessageState = null;
        /**
         * 输出速度统计 - part 级锚点（reasoning/text）：仅用于维护 messageTokens 的跨 part
         * 累计基线；scanCounted/scanTokens 为当前 part 文本的增量扫描缓存（流式快照为
         * 全量累积，每帧只扫新增尾巴）；速度测速与锚点时间解耦（消息级滑动窗口），
         * part 切换 / 工具插入不再造成速度断供。
         * @type {{key: string, partTokens: number, baseMessageTokens: number, scanCounted: number, scanTokens: number} | null}
         */
        this._speedPartState = null;
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

    /** @type {number} 最近一次用户主动滚动输入的时间戳，用于区分缩放等引起的被动 scroll。 */
    _lastUserScrollTs = 0;

    _lastUserScrollDirection = 0;

    /** @type {((e: KeyboardEvent) => void) | null} document 级键盘滚动意图监听，组件销毁时移除。 */
    _historyScrollKeydownHandler = null;

    /** @type {ResizeObserver | null} 聊天区尺寸变化监听：布局变化（侧边栏展开/收起等）后保持底部锁定。 */
    _historyResizeObserver = null;

    setAutoScrollingToBottom(auto_scrolling_to_bottom) {
        if (auto_scrolling_to_bottom && this._chatFind?.visible) return;
        this.auto_scrolling_to_bottom = auto_scrolling_to_bottom;
        const scrollControls = this.querySelector('#taskview-scroll-controls');
        if (auto_scrolling_to_bottom) {
            scrollControls?.classList.add('hidden');
        } else {
            scrollControls?.classList.remove('hidden');
        }
    }

    /** 记录一次用户主动滚动输入（滚轮/触摸/滚动键），缩放等被动滚动不应调用。 */
    _markUserScrollIntent(direction = 0) {
        this._conversationJumpInProgress = false;
        this._lastUserScrollTs = Date.now();
        this._lastUserScrollDirection = direction;
    }

    /** 判断最近是否刚发生过用户主动滚动，避免把缩放引起的被动 scroll 当作手动离开底部。 */
    _hasRecentUserScrollIntent() {
        return Date.now() - this._lastUserScrollTs < 300;
    }

    /**
     * 判断键盘事件目标是否位于预览区域（右侧边栏、画中画浮窗）。
     * 这些区域拥有独立的滚动容器，其中的键盘滚动（PageDown/方向键等）
     * 作用于预览内容而非聊天历史，不应被标记为聊天区滚动意图——
     * 否则放大预览时滚动预览内容会把聊天区的底部锁定误解除。
     */
    _isKeydownInPreviewArea(target) {
        if (!target || typeof target.closest !== 'function') return false;
        // 右侧边栏（task-artifacts 宿主，含其 shadow DOM 内的键盘事件）
        const artifacts = this.querySelector(`#task-${this.task_id}-artifacts`);
        if (artifacts && artifacts.contains(target)) return true;
        // 浏览器画中画浮窗
        if (target.closest('.browser-pip')) return true;
        return false;
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
        return `<div class="flex flex-col items-end min-w-0"><div class="od-user-msg"><div class="${TaskView.USER_PART_CLASS_MAP[part.type] || ''}">${part.rendered}</div></div></div>`;
    }

    renderUserMessage(user_message) {
        const rawAttr = user_message.rawText ? ` data-raw-text="${escapeHtml(user_message.rawText)}"` : '';
        const metaRowHtml = TaskView.buildMsgMetaRow('user', user_message.timestamp, user_message.message_id);

        const parts = getRenderableUserParts(user_message, user_message.content);
        let inner = '';
        for (const part of parts) {
            inner += this.renderUserPart(part);
        }
        inner += metaRowHtml;

        return `<div id="user-msg-${escapeHtml(user_message.message_id)}" class="od-user-msg-container" data-message-id="${escapeHtml(user_message.message_id)}"${rawAttr}>${inner}</div>`;
    }

    createPendingGoalSupplementMessage(content, supplementId) {
        return this._goalController.createPendingGoalSupplementMessage(content, supplementId);
    }

    renderPendingContextEchoMessage(message, options = {}) {
        const text = String(options.text ?? message?.message ?? message?.objective ?? '').trim();
        if (!text) return '';
        const id = escapeHtml(String(message?.id || crypto.randomUUID()));
        const type = escapeHtml(String(options.type || message?.type || 'context'));
        const rawAttr = ` data-raw-text="${escapeHtml(text)}"`;
        // 回显只是还没进入 chat_context 的占位条目，id 是渲染进程临时生成的，
        // 不能当成消息 id 传给消息菜单，否则"重新执行"会报 user message ... not found
        const metaRowHtml = TaskView.buildMsgMetaRow('user', message?.timestamp);
        return `
            <div id="pending-context-${id}" class="od-user-msg-container od-pending-context-entry" data-pending-context-id="${id}" data-pending-context-type="${type}"${rawAttr}>
                ${this.renderUserPart(createRenderedTextPartFromPlainText(text))}
                ${metaRowHtml}
            </div>
        `;
    }

    renderPendingGoalSupplementMessage(message) {
        return this._goalController.renderPendingGoalSupplementMessage(message);
    }

    appendPendingGoalSupplementMessage(message) {
        return this._goalController.appendPendingGoalSupplementMessage(message);
    }

    renderConsumedGoalSupplementMessage(message) {
        return this._goalController.renderConsumedGoalSupplementMessage(message);
    }

    createPendingGoalEditMessage(type, objective, goalId, taskId = this.task_id, goalRevision, options = {}) {
        return this._goalController.createPendingGoalEditMessage(
            type,
            objective,
            goalId,
            taskId,
            goalRevision,
            options
        );
    }

    renderPendingGoalEditMessage(message) {
        return this._goalController.renderPendingGoalEditMessage(message);
    }

    appendPendingGoalEditMessage(message) {
        return this._goalController.appendPendingGoalEditMessage(message);
    }

    showPendingGoalSupplement(content, supplementId) {
        return this._goalController.showPendingGoalSupplement(content, supplementId);
    }

    showPendingGoalEdit(type, objective, goalId, taskId = this.task_id, goalRevision = 0, options = {}) {
        return this._goalController.showPendingGoalEdit(type, objective, goalId, taskId, goalRevision, options);
    }

    _syncPendingGoalEditToArtifacts() {
        return this._goalController.syncPendingGoalEditToArtifacts();
    }

    showPendingSlashGoalCommand() {
        return this._goalController.showPendingSlashGoalCommand();
    }

    removePendingGoalSupplementForIds(supplementIds) {
        return this._goalController.removePendingGoalSupplementForIds(supplementIds);
    }

    _transitionGoalSupplementToConsumed(message) {
        return this._goalController.transitionGoalSupplementToConsumed(message);
    }

    clearPendingGoalSupplements() {
        return this._goalController.clearPendingGoalSupplements();
    }

    /** 当 LLM 开始输出时，移除所有处于过渡状态的 supplement 回显。 */
    resolvePendingGoalSupplements() {
        return this._goalController.resolvePendingGoalSupplements();
    }

    removePendingGoalEditByGoalId(goalId) {
        return this._goalController.removePendingGoalEditByGoalId(goalId);
    }

    resolvePendingGoalEditFromSummary(goal) {
        return this._goalController.resolvePendingGoalEditFromSummary(goal);
    }

    static formatRelativeTime(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);

        if (minutes < 1) return taskViewT('renderer.taskview.time.justNow');
        if (minutes < 60) return taskViewT('renderer.taskview.time.minutesAgo', { minutes });
        if (hours < 24) return taskViewT('renderer.taskview.time.hoursAgo', { hours });

        const d = new Date(timestamp);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    static buildMsgMetaRow(role, timestamp, messageId) {
        if (!timestamp) return '';
        const timeHtml = `<span class="od-msg-timestamp">${TaskView.formatRelativeTime(timestamp)}</span>`;
        // 没有真实消息 id 的占位回显（如待消费的 goal 补充消息）不提供消息操作：
        // 它还没有进入 chat_context，重新发送/编辑/重新执行都找不到对应消息。
        if (!messageId) return `<div class="od-msg-meta-row">${timeHtml}</div>`;
        const escapedId = escapeHtml(messageId);
        const copyLabel = taskViewT('renderer.taskview.action.copy');
        const copyBtn = `<button class="od-msg-action-btn" type="button" data-action="copy" data-message-id="${escapedId}">${COPY_ICON_SVG}<span class="od-msg-action-label">${copyLabel}</span></button>`;
        let menuHtml;
        if (role === 'assistant') {
            const regenLabel = taskViewT('renderer.taskview.action.regenerate');
            const forkLabel = taskViewT('renderer.taskview.action.fork');
            const regenBtn = `<button class="od-msg-action-btn" type="button" data-action="regenerate" data-message-id="${escapedId}">${REGENERATE_ICON_SVG}<span class="od-msg-action-label">${regenLabel}</span></button>`;
            const forkBtn = `<button class="od-msg-action-btn" type="button" data-action="fork" data-message-id="${escapedId}">${FORK_ICON_SVG}<span class="od-msg-action-label">${forkLabel}</span></button>`;
            menuHtml = `${copyBtn}${regenBtn}${forkBtn}`;
        } else {
            const editLabel = taskViewT('renderer.taskview.action.edit');
            const resubmitLabel = taskViewT('renderer.taskview.action.resubmit');
            const resendLabel = taskViewT('renderer.taskview.action.resend');
            const resubmitHint = escapeHtml(taskViewT('renderer.taskview.menu.continueHint'));
            const resendHint = escapeHtml(taskViewT('renderer.taskview.menu.resendHint'));
            const editBtn = `<button class="od-msg-action-btn" type="button" data-action="edit" data-message-id="${escapedId}">${EDIT_ICON_SVG}<span class="od-msg-action-label">${editLabel}</span></button>`;
            const resubmitBtn = `<button class="od-msg-action-btn" type="button" data-action="resubmit" data-message-id="${escapedId}" title="${resubmitHint}">${REGENERATE_ICON_SVG}<span class="od-msg-action-label">${resubmitLabel}</span></button>`;
            const resendBtn = `<button class="od-msg-action-btn" type="button" data-action="resend" data-message-id="${escapedId}" title="${resendHint}">${RESEND_ICON_SVG}<span class="od-msg-action-label">${resendLabel}</span></button>`;
            menuHtml = `${copyBtn}${editBtn}${resubmitBtn}${resendBtn}`;
        }
        return `<div class="od-msg-meta-row">${timeHtml}<div class="od-msg-hover-menu">${menuHtml}</div></div>`;
    }

    static USER_PART_CLASS_MAP = {
        text: 'bg-transparent markdown-body'
    };

    static REASONING_UPDATE_FALLBACK_MS = 250;

    static SPINNER_SVG = `<i class="fa-solid fa-circle-notch fa-spin"></i>`;

    /**
     * CJK 字符 token 权重（0.7 = 7/10），与后端 token-estimation.ts 折中口径一致
     * （DeepSeek ≈0.6 token/字，GPT cl100k ≈1.0 token/字）。
     */
    static CJK_TOKEN_WEIGHT = 0.7;
    /** 非 CJK 字符 token 权重：约 4 字符 1 token（2 的幂，整数计数乘法精确）。 */
    static OTHER_TOKEN_WEIGHT = 0.25;

    /** CJK 相关 Unicode 区段：符号标点、假名、统一表意文字及扩展 A、谚文、兼容表意、全角形式。 */
    static CJK_CODE_POINT_RANGES = [
        [0x3000, 0x303f],
        [0x3040, 0x30ff],
        [0x3400, 0x4dbf],
        [0x4e00, 0x9fff],
        [0xac00, 0xd7af],
        [0xf900, 0xfaff],
        [0xff00, 0xffef]
    ];

    static isCjkCharCode(code) {
        const ranges = TaskView.CJK_CODE_POINT_RANGES;
        for (let i = 0; i < ranges.length; i++) {
            if (code < ranges[i][0]) return false;
            if (code <= ranges[i][1]) return true;
        }
        return false;
    }

    /** CJK 加权文本 token 估算（全量口径，与后端 estimateTextTokens 一致；流式路径请走增量扫描）。 */
    static estimateTextTokensWeighted(text) {
        if (!text) return 0;
        let cjkCount = 0;
        let otherCount = 0;
        for (let i = 0; i < text.length; i++) {
            if (TaskView.isCjkCharCode(text.charCodeAt(i))) cjkCount++;
            else otherCount++;
        }
        return Math.ceil(cjkCount * TaskView.CJK_TOKEN_WEIGHT + otherCount * TaskView.OTHER_TOKEN_WEIGHT);
    }

    /** 输出速度滑动窗口时长（ms）：速度代表该窗口内的最新 decode 速率 */
    static SPEED_WINDOW_MS = 3000;
    /** 相邻样本间隔超过该值视为 decode 断流（工具执行 / 长停顿），速度窗口从断点重算。
     *  取值需大于慢速输出的合法 progress 间隔（思考输出可达秒级/帧），否则窗口被反复
     *  误重置，速度永远停留在冷却期无法产出。 */
    static SPEED_WINDOW_MAX_GAP_MS = 3000;
    /** 窗口时间跨度不足该值时不产出速度（流式首帧冷却，避免单帧抖动） */
    static SPEED_MIN_SPAN_MS = 500;
    /** 滑动窗口样本数上限（防止长流式会话样本无限增长） */
    static SPEED_WINDOW_MAX_SAMPLES = 120;

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

    /**
     * Create attribution analysis status indicator HTML.
     * Shown in the chat stream when AgentGate is performing malicious skill attribution analysis,
     * similar to the "deep thinking" indicator for reasoning.
     */
    static createAttributionStatusHtml() {
        const label = escapeHtml(taskViewT('agentgate.attribution.status'));
        return `
        <div class="od-attribution-placeholder od-assistant-msg-container flex items-start" data-attribution-status="active">
            <div class="px-2 bg-transparent w-full">
                <div class="od-inline-toolcall-container" role="status" aria-live="polite">
                    <div class="flex items-center gap-1.5 min-w-0">
                        <i class="fa-solid fa-shield-halved shrink-0 text-amber-500 text-xs"></i>
                        <i class="fa-solid fa-circle-notch fa-spin shrink-0 text-amber-400 text-xs"></i>
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

    static hasGoalEditReminderAfterLatestAssistant(messages) {
        return hasGoalEditReminderAfterLatestAssistant(messages);
    }

    static isWaitingForAssistantReply(taskStatus, goal, messages) {
        return isWaitingForAssistantReply(taskStatus, goal, messages);
    }

    static canShowWaitingAssistantPlaceholder(taskStatus, goal) {
        return canShowWaitingAssistantPlaceholder(taskStatus, goal);
    }

    static formatContextRatioText(totalTokens, contextSize) {
        if (contextSize <= 0 || totalTokens <= 0) return '';
        const ratio = totalTokens / contextSize;
        const pctNum = ratio * 100;
        if (pctNum > 100) {
            // 占比超过 100% 意味着回复的 token 数大于当前配置的上下文窗口。常见原因：
            // 切换到更小上下文窗口的模型，或在设置中手动把上下文长度设得很小。此时仍展示
            // 真实比值并标注已超限，而非把数值截断成 100%，便于用户察觉窗口配置偏小。
            const pct = pctNum.toFixed(1);
            return taskViewT('renderer.taskview.usage.contextRatioExceeded', { pct });
        }
        return taskViewT('renderer.taskview.usage.contextRatio', { pct: pctNum.toFixed(1) });
    }

    static formatUsageHtml(usage, contextSize, isStreaming = false, speed = null, speedEstimated = false) {
        if (!TaskView.hasDisplayableUsage(usage)) return '';
        const { promptTokens, completionTokens, totalTokens } = TaskView.getUsageDisplayTokens(usage);
        const titleParts = taskViewT('renderer.taskview.usage.title', {
            input: promptTokens,
            output: completionTokens,
            total: totalTokens
        });
        const speedSuffix = TaskView.formatSpeedSuffix(speed, speedEstimated);
        const displayText = TaskView.formatUsageDisplayText(completionTokens, totalTokens, contextSize, speedSuffix);
        const spinnerDisplay = isStreaming ? '' : 'display:none;';
        return `<span class="message-usage text-xs text-gray-400 mt-3 flex items-center gap-1" title="${titleParts}" data-prompt-tokens="${promptTokens}" data-completion-tokens="${completionTokens}" data-total-tokens="${totalTokens}" data-streaming="${isStreaming}" data-speed-value="${speed ?? ''}" data-speed-estimated="${speedEstimated ? 'true' : 'false'}"><span class="usage-spinner" style="${spinnerDisplay}">${TaskView.SPINNER_SVG}</span><span class="usage-text">${displayText}</span></span>`;
    }

    /** 组装 usage 胶囊的展示文本（已输出词数 + 速度内联 + 总计 + 上下文占比）。 */
    static formatUsageDisplayText(completionTokens, totalTokens, contextSize, speedText = '') {
        const ratioText = TaskView.formatContextRatioText(totalTokens, contextSize);
        return taskViewT('renderer.taskview.usage.display', {
            output: completionTokens,
            total: totalTokens,
            ratio: ratioText,
            speed: speedText
        });
    }

    /**
     * 速度后缀文案：estimated 为 true 时加 ≈ 前缀（速度来自 CJK 加权估算序列，
     * 非 usage 检查点推进的精确值），与真实 usage 驱动的速度区分口径。
     */
    static formatSpeedSuffix(speed, estimated = false) {
        if (speed == null || speed === '') return '';
        return taskViewT(
            estimated === true ? 'renderer.taskview.usage.speedEstimated' : 'renderer.taskview.usage.speed',
            { speed }
        );
    }

    /**
     * 实例级最近测速缓存（task_id → 最近一次窗口测速）。仅存内存，实例关闭即消失：
     * 任务切换 / reload 重建 DOM 后，历史渲染与流式恢复路径据此回读最近 decode 数据，
     * 让速度信息在实例存续期内持续可见。
     * @type {Map<string, {speed: number, estimated: boolean, messageId: string}>}
     */
    static RECENT_SPEED_BY_TASK = new Map();

    static rememberRecentSpeed(taskId, entry) {
        if (!taskId || !entry || typeof entry.speed !== 'number') return;
        TaskView.RECENT_SPEED_BY_TASK.set(taskId, entry);
    }

    static getRecentSpeed(taskId) {
        if (!taskId) return null;
        return TaskView.RECENT_SPEED_BY_TASK.get(taskId) ?? null;
    }

    /**
     * Update the live preview and hidden full content of a streaming reasoning block.
     * Also updates the elapsed time display in real-time.
     */
    static updateReasoningPreview(el, text) {
        if (!el) return;
        // 已完成（finalize 过）的块不再接受流式更新：插队中断后旧回合的
        // 残余 progress 可能晚到，若在此重新启动计时器，已 finalize 的
        // 思考块会继续计时，出现"两个思考块同时活跃同时计时"。
        if (el.classList.contains('reasoning-completed')) return;
        // _reasoningTextLength 存加权估算 token（与 usage 胶囊同口径），供耗时行展示
        el._reasoningTextLength = TaskView.estimateTextTokensWeighted(text || '');
        el._reasoningFullText = text || '';
        el._reasoningFullStale = true;

        // Time display refresh (created once per element)
        if (!el._refreshReasoningTime) {
            el._refreshReasoningTime = () => {
                if (el.classList.contains('reasoning-completed')) return;
                const startTime = parseInt(el.dataset.reasoningStart || '0', 10);
                if (startTime > 0) {
                    const elapsed = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
                    const timeEl = el.querySelector('.reasoning-time');
                    if (timeEl) {
                        const nextText = `（${formatReasoningElapsedTime(elapsed, el._reasoningTextLength || 0)}）`;
                        // 只在文案变化时写入，避免每秒 setInterval 与每帧内容更新
                        // 反复设置相同文本，触发无谓的 DOM 写入与布局。
                        if (timeEl.textContent !== nextText) {
                            timeEl.textContent = nextText;
                        }
                    }
                }
            };
        }

        // Start per-second timer on first call
        if (!el._reasoningTimeInterval) {
            el._refreshReasoningTime();
            el._reasoningTimeInterval = setInterval(el._refreshReasoningTime, 1000);
        }

        // Refresh time display on every content update (real-time char count)
        el._refreshReasoningTime();

        const tailText = sliceReasoningPreviewTail(text);

        // Bubble mode: update bubble content
        const bubbleContent = el.querySelector('.reasoning-bubble-content');
        if (bubbleContent) {
            // 流式快照会同时经由 scheduleReasoningPreviewUpdate（RAF 合并）与本函数
            // （_syncReasoningTimers 的兜底同步）到达，内容多数重复；textContent 相同
            // 时跳过写入与 scrollTop 读取，避免每快照一次无谓的 DOM 写 + 强制布局。
            if (bubbleContent.textContent !== tailText) {
                bubbleContent.textContent = tailText;
                const bubble = el.querySelector('.reasoning-bubble');
                if (bubble) {
                    bubble.scrollTop = bubble.scrollHeight;
                }
            }
            return;
        }

        // Inline mode: update preview content and keep it pinned to the newest
        // reasoning text so the user can watch the thinking progress live instead
        // of staring at a frozen head of the preview (clipped by max-height).
        const previewContent = el.querySelector('.reasoning-preview-content');
        if (previewContent) {
            if (previewContent.textContent !== tailText) {
                previewContent.textContent = tailText;
                const previewArea = el.querySelector('.reasoning-preview-area');
                if (previewArea) {
                    previewArea.scrollTop = previewArea.scrollHeight;
                }
            }
        }

        // 展开的全文区（详细模式 / 用户手动展开）是当前可见的思考窗口，必须随快照
        // 推进；折叠态全文区在布局树之外（display:none），维持零写入、finalize 回填。
        // 追加采用前缀增量：快照按累计文本推送且快照间为前缀关系，新文本与已渲染
        // 文本一致或为其后缀延伸时只 appendData 增量，每帧成本 O(delta) 而非 O(全文)。
        const fullContent = el.querySelector('.reasoning-content');
        if (fullContent && el.classList.contains('reasoning-expanded')) {
            const renderedText = fullContent.textContent || '';
            const nextText = text || '';
            let changed = false;
            if (nextText.length > renderedText.length && nextText.startsWith(renderedText)) {
                // 快照是已渲染文本的延伸：只写增量（每帧成本 O(delta) 而非 O(全文)）
                const delta = nextText.slice(renderedText.length);
                const textNode = fullContent.firstChild;
                if (textNode && typeof textNode.appendData === 'function') {
                    textNode.appendData(delta);
                } else {
                    fullContent.textContent = nextText;
                }
                changed = true;
            } else if (renderedText !== nextText) {
                // 快照回退/改写（如插队重发）：整段重写对齐；快照重复时两者相等，跳过写入
                fullContent.textContent = nextText;
                changed = true;
            }
            if (changed) {
                // 与简洁模式预览相同的钉底语义：仅当用户没有向上滚离底部时跟随，
                // 阈值与 _captureProcessScrollFollowState 的底部判定保持一致
                const fullArea = el.querySelector('.reasoning-full-area');
                if (
                    fullArea &&
                    fullArea.scrollHeight - fullArea.scrollTop - fullArea.clientHeight <=
                        PROCESS_INNER_SCROLL_BOTTOM_THRESHOLD_PX
                ) {
                    fullArea.scrollTop = fullArea.scrollHeight;
                }
            }
        }

        // 折叠态全文节点不在流式期间写入，见 finalizeReasoningBlock 的回填。
    }

    /**
     * Schedule a deferred update of a streaming reasoning block.
     *
     * Reasoning models stream tokens far faster than the renderer can meaningfully
     * repaint. Updating the DOM synchronously on every token floods the main thread
     * (full-text textContent writes + layout reads), which is what makes the UI feel
     * stuck while the model is "thinking". Coalescing to one update per animation
     * frame caps the per-frame cost regardless of token rate; the final text is
     * flushed when the block is finalized.
     *
     * RAF alone is not enough: Chromium suspends `requestAnimationFrame` while the
     * page is hidden / the window is backgrounded (Electron backgroundThrottling),
     * which would freeze the preview even though the elapsed-time counter (driven by
     * setInterval) keeps ticking. A fallback timer therefore guarantees the preview
     * keeps advancing at a bounded rate regardless of visibility.
     */
    static scheduleReasoningPreviewUpdate(el, text) {
        if (!el) return;
        el._pendingReasoningText = text;
        // 已有一个排队的更新（RAF 或兜底定时器）则合并，避免每个 token 一次 DOM 写入。
        if (el._reasoningPreviewRaf !== undefined || el._reasoningFallbackTimer !== undefined) return;

        const apply = () => {
            if (el._reasoningPreviewRaf !== undefined) {
                cancelAnimationFrame(el._reasoningPreviewRaf);
                el._reasoningPreviewRaf = undefined;
            }
            if (el._reasoningFallbackTimer !== undefined) {
                clearTimeout(el._reasoningFallbackTimer);
                el._reasoningFallbackTimer = undefined;
            }
            const pending = el._pendingReasoningText;
            if (pending === undefined) return;
            el._pendingReasoningText = undefined;
            TaskView.updateReasoningPreview(el, pending);
        };

        // RAF：前台高频合并，每动画帧最多一次。
        el._reasoningPreviewRaf = requestAnimationFrame(apply);
        // 兜底：RAF 被挂起（后台/不可见）时仍保证内容推进；与 RAF 竞争，先到先执行。
        el._reasoningFallbackTimer = setTimeout(apply, TaskView.REASONING_UPDATE_FALLBACK_MS);
    }

    /**
     * Immediately apply any deferred reasoning text and cancel the pending frame.
     * Called when a reasoning block is finalized so its collapsed/full content is
     * complete even if the last token arrived without a subsequent animation frame.
     */
    static flushReasoningPreview(el) {
        if (!el) return;
        if (el._reasoningPreviewRaf !== undefined) {
            cancelAnimationFrame(el._reasoningPreviewRaf);
            el._reasoningPreviewRaf = undefined;
        }
        if (el._reasoningFallbackTimer !== undefined) {
            clearTimeout(el._reasoningFallbackTimer);
            el._reasoningFallbackTimer = undefined;
        }
        const pending = el._pendingReasoningText;
        if (pending !== undefined) {
            el._pendingReasoningText = undefined;
            TaskView.updateReasoningPreview(el, pending);
        }
    }

    /**
     * Transition a reasoning block from active (streaming) to completed state.
     * Calculates elapsed time, hides preview, shows toggle button.
     */
    static finalizeReasoningBlock(el) {
        if (!el || el.classList.contains('reasoning-completed')) return;

        // Flush any deferred streaming text so the finalized block is complete.
        TaskView.flushReasoningPreview(el);

        // 折叠期间全文区跳写，这里一次性回填，保证完成后展开可见完整内容
        // （历史长时这是把全文逐帧写入布局树改为仅一次写入的关键）。
        if (el._reasoningFullStale && el._reasoningFullText !== undefined) {
            const fullContent = el.querySelector('.reasoning-content');
            if (fullContent) {
                fullContent.textContent = el._reasoningFullText;
            }
            const bubbleContent = el.querySelector('.reasoning-bubble-content');
            if (bubbleContent) {
                bubbleContent.textContent = el._reasoningFullText;
            }
            el._reasoningFullStale = false;
        }

        // Clear the per-second time interval
        if (el._reasoningTimeInterval) {
            clearInterval(el._reasoningTimeInterval);
            el._reasoningTimeInterval = null;
        }

        el.classList.remove('reasoning-active');
        el.classList.add('reasoning-completed');

        // Bubble mode: auto-hide the bubble after a short delay
        const bubble = el.querySelector('.reasoning-bubble');
        if (bubble && el.isConnected) {
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
                timeEl.textContent = `（${formatReasoningElapsedTime(elapsed, el._reasoningTextLength || 0)}）`;
            }
        }

        // Reset toggle text (collapsed state = empty)
        const toggle = el.querySelector('.reasoning-toggle');
        if (toggle) toggle.textContent = '';

        // Stop icon breathing animation
        const icon = el.querySelector('.reasoning-header i.fa-lightbulb');
        if (icon) icon.classList.remove('reasoning-icon-breathing');
    }

    // DOM morph 逻辑已提取到 ../utils/dom-morph.js，此处保留静态方法以兼容现有调用
    static morphDomChildren = morphDomChildren;

    /**
     * 在文本 part 元素末尾追加流式闪烁光标。
     * 光标注入到最后一个块级文本元素（p / li / h1-h6 / blockquote 等）内部，
     * 使得光标紧跟在文字末尾而非另起一行。
     */
    static _appendStreamCursor(el) {
        if (!el) return;
        const lastChild = el.lastElementChild;
        const cursorHtml = '<span class="stream-cursor" aria-hidden="true"></span>';
        if (lastChild && /^(P|LI|H[1-6]|BLOCKQUOTE|TD|TH|DD|DT)$/.test(lastChild.tagName)) {
            lastChild.insertAdjacentHTML('beforeend', cursorHtml);
        } else {
            el.insertAdjacentHTML('beforeend', cursorHtml);
        }
    }

    static createReasoningPartHtml(
        rendered,
        isStreaming = false,
        partIndex = -1,
        elapsedSeconds = null,
        expandedOverride,
        disclosureKey = ''
    ) {
        const escaped = escapeHtml(rendered || '');
        const title = escapeHtml(taskViewT('reasoning.card.title'));
        const stateClass = isStreaming ? 'reasoning-active' : 'reasoning-completed';
        const iconBreathClass = isStreaming ? ' reasoning-icon-breathing' : '';
        const streamingAttribute = isStreaming ? ` data-streaming-part-index="${partIndex}"` : '';
        const timingAttribute = isStreaming ? ` data-reasoning-start="${Date.now()}"` : '';
        const disclosureAttribute = disclosureKey
            ? ` data-reasoning-disclosure-key="${escapeHtml(disclosureKey)}"`
            : '';
        const timeText =
            !isStreaming && elapsedSeconds != null
                ? `（${formatReasoningElapsedTime(elapsedSeconds, TaskView.estimateTextTokensWeighted(rendered || ''))}）`
                : '';
        const expanded = typeof expandedOverride === 'boolean' ? expandedOverride : getDefaultExpanded(guiOutputMode);

        if (guiReasonDisplayMode === 'bubble') {
            const bubbleOpen = isStreaming || expanded;
            const wrapperExpandedClass =
                expanded && !isStreaming ? ' reasoning-bubble-pinned reasoning-content-visible' : '';
            const bubbleHiddenClass = bubbleOpen ? '' : ' reasoning-bubble-hidden';
            return `
                <div class="reasoning-block-od od-inline-toolcall-container ${stateClass}${wrapperExpandedClass}"${timingAttribute}${disclosureAttribute}>
                    <div class="reasoning-header flex items-center gap-1.5 min-w-0 cursor-pointer select-none py-0.5">
                        <i class="fa-regular fa-lightbulb${iconBreathClass} shrink-0 text-slate-400 text-xs"></i>
                        <span class="shrink-0 text-slate-500 text-xs">${title}</span>
                        <span class="reasoning-time text-xs text-slate-400 shrink-0">${timeText}</span>
                    </div>
                    <div class="reasoning-bubble compact-scroll${bubbleHiddenClass}">
                        <div class="reasoning-bubble-content text-[11px] leading-relaxed whitespace-pre-wrap"${streamingAttribute}>${escapeHtml(isStreaming ? sliceReasoningPreviewTail(rendered) : rendered || '')}</div>
                    </div>
                </div>`;
        }

        const previewHtml =
            isStreaming && !expanded
                ? `<div class="reasoning-preview-area"><div class="reasoning-preview-content px-3 pb-1.5 text-slate-500 text-[11px] leading-relaxed whitespace-pre-wrap"${streamingAttribute}>${escapeHtml(sliceReasoningPreviewTail(rendered))}</div></div>`
                : '';
        const fullStreamingAttribute = isStreaming ? ` data-streaming-part-index="${partIndex}"` : '';
        const wrapperExpandedClass = expanded ? ' reasoning-expanded reasoning-content-visible' : '';
        // 详细模式展开的全文区是用户唯一可见的思考窗口，流式时必须直接携带
        // 初始快照文本；折叠态仍保持空白，等 finalize 一次性回填（长历史性能优化）。
        const fullText = isStreaming ? (expanded ? escaped : '') : escaped;
        return `
            <div class="reasoning-block-od od-inline-toolcall-container ${stateClass}${wrapperExpandedClass}"${timingAttribute}${disclosureAttribute}>
                <div class="reasoning-header flex items-center gap-1.5 min-w-0 cursor-pointer select-none py-0.5">
                    <i class="fa-regular fa-lightbulb${iconBreathClass} shrink-0 text-slate-400 text-xs"></i>
                    <span class="shrink-0 text-slate-500 text-xs">${title}</span>
                    <span class="reasoning-time text-xs text-slate-400 shrink-0">${timeText}</span>
                </div>
                ${previewHtml}
                <div class="reasoning-full-area" data-reasoning-scroll-key="${partIndex}"><div class="reasoning-content px-3 pb-2 text-slate-500 text-[11px] leading-relaxed whitespace-pre-wrap"${fullStreamingAttribute}>${fullText}</div></div>
            </div>`;
    }

    static _plainTextFromHtml(value) {
        const container = document.createElement('div');
        container.innerHTML = String(value || '');
        return (container.textContent || '').replace(/\s+/g, ' ').trim();
    }

    static _toolDisplayName(tool) {
        // 后端 toRenderJSON 实时推送当前语言下的显示名；旧数据无该字段时回退协议名
        const name = typeof tool?.display_name === 'string' ? tool.display_name.trim() : '';
        return name || tool?.tool_name || '';
    }

    static _compactProcessPhrase(value, maxLength = 18) {
        const plainText = TaskView._plainTextFromHtml(value);
        const phrase = plainText.split(/[，,。！？!?；;]/, 1)[0].trim();
        const characters = Array.from(phrase);
        if (characters.length <= maxLength) return phrase;
        return `${characters
            .slice(0, maxLength - 1)
            .join('')
            .trim()}…`;
    }

    static _truncateProcessSummary(value, maxLength = 40) {
        const characters = Array.from(value);
        if (characters.length <= maxLength) return value;
        return `${characters
            .slice(0, maxLength - 1)
            .join('')
            .trim()}…`;
    }

    static _processSummary(item) {
        const entries = item.entries || [];
        const tools = entries.filter((entry) => entry.type === 'tool').flatMap((entry) => entry.tools || []);
        const displayNames = Array.from(new Set(tools.map((tool) => TaskView._toolDisplayName(tool)).filter(Boolean)));
        const toolNames = Array.from(new Set(displayNames.map((name) => TaskView._compactProcessPhrase(name, 12))));
        let toolSummary = '';
        const summarizeTools = (names) => {
            const listedNames = names
                .slice(0, 2)
                .join(taskViewT('renderer.taskview.output.processSummary.listSeparator'));
            return taskViewT('renderer.taskview.output.processSummary.usedTools', {
                tools: listedNames,
                count: tools.length
            });
        };
        if (toolNames.length > 0) {
            toolSummary = summarizeTools(toolNames);
        }
        const reasoningSummary = item.hasReasoning ? taskViewT('renderer.taskview.output.deepReasoning') : '';
        const combine = () =>
            reasoningSummary && toolSummary
                ? taskViewT('renderer.taskview.output.processSummary.combined', {
                      reasoning: reasoningSummary,
                      tools: toolSummary
                  })
                : reasoningSummary || toolSummary || taskViewT('renderer.taskview.output.processSummary');
        let summary = combine();
        if (Array.from(summary).length > 40 && toolNames.length > 1) {
            toolSummary = summarizeTools(toolNames.slice(0, 1));
            summary = combine();
        }
        return TaskView._truncateProcessSummary(summary);
    }

    /**
     * 统计当前连续工具调用块中已完成的工具调用（status 非 pending/running），
     * 供运行中的思考/调用状态块展示"已调用 N 个工具"。
     * 块边界：倒序扫描，遇到可见正文（text/error）即停止——更早的工具属于上一块，不计入；
     * reasoning 属于当前块，不作为边界。
     * @returns {{ count: number, names: string[] }} count 为调用次数，names 为去重压缩后的显示名
     */
    static _collectDoneToolStats(parts) {
        let count = 0;
        const names = new Set();
        for (let index = (parts || []).length - 1; index >= 0; index -= 1) {
            const part = parts[index];
            if (!part) continue;
            if (part.type === 'tool_call') {
                for (const tc of part.toolcalls || []) {
                    if (tc.status === 'pending' || tc.status === 'running') continue;
                    count += 1;
                    const name = TaskView._toolDisplayName(tc);
                    if (name) names.add(TaskView._compactProcessPhrase(name, 12));
                }
                continue;
            }
            if (part.type === 'reasoning') continue;
            if (String(part.rendered ?? part.text ?? '').trim()) break;
        }
        return { count, names: Array.from(names).slice(0, 2) };
    }

    _captureProcessDisclosureState(root) {
        const state = new Map();
        root?.querySelectorAll?.('[data-disclosure-key]').forEach((toggle) => {
            state.set(toggle.dataset.disclosureKey, toggle.getAttribute('aria-expanded') === 'true');
        });
        root?.querySelectorAll?.('[data-reasoning-disclosure-key]').forEach((block) => {
            state.set(
                block.dataset.reasoningDisclosureKey,
                block.classList.contains('reasoning-expanded') || block.classList.contains('reasoning-bubble-pinned')
            );
        });
        root?.querySelectorAll?.('details.terminal-tool[data-terminal-card-key]').forEach((card) => {
            state.set(card.dataset.terminalCardKey, card.open === true);
        });
        return state;
    }

    _syncReasoningTimers(root) {
        if (!root?.isConnected) return;
        root?.querySelectorAll?.('.reasoning-block-od.reasoning-active').forEach((block) => {
            const content = block.querySelector('[data-streaming-part-index]');
            TaskView.updateReasoningPreview(block, content?.textContent || '');
        });
        this._syncRunningStatusTimeTicker();
    }

    /**
     * 状态行"已思考 xx 秒"的秒级刷新：复用思考块的同步时机挂载一个共享 interval，
     * 逐条静默重写时间段文本（时间每秒变化，不重播淡入）。root 断开时自动清理。
     */
    _syncRunningStatusTimeTicker() {
        if (!this.isConnected) {
            this._stopRunningStatusTimeTicker();
            return;
        }
        const refresh = () => {
            if (!this.isConnected) {
                this._stopRunningStatusTimeTicker();
                return;
            }
            this.querySelectorAll('.od-running-status[data-reasoning-status-start]').forEach((statusEl) => {
                const messageId = statusEl.dataset.messageId;
                const startTime = parseInt(statusEl.dataset.reasoningStatusStart || '0', 10);
                if (!messageId || !startTime) return;
                const timeEl = statusEl.querySelector('.od-running-status-time span');
                if (!timeEl) return;
                const elapsed = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
                const nextText = taskViewT('renderer.taskview.output.status.thinkingTime', {
                    time: formatReasoningElapsedTime(elapsed)
                });
                if (timeEl.textContent !== nextText) {
                    timeEl.textContent = nextText;
                }
            });
        };
        // 仅在存在思考状态行时保持 interval，思考结束/状态切换后自动停止
        if (!this.querySelector('.od-running-status[data-reasoning-status-start]')) {
            this._stopRunningStatusTimeTicker();
            return;
        }
        if (!this._runningStatusTimeInterval) {
            this._runningStatusTimeInterval = setInterval(refresh, 1000);
        }
        refresh();
    }

    _stopRunningStatusTimeTicker() {
        if (this._runningStatusTimeInterval) {
            clearInterval(this._runningStatusTimeInterval);
            this._runningStatusTimeInterval = null;
        }
    }

    /**
     * 把主进程渲染的终端工具卡片 HTML 改写为当前 GUI 输出模式期望的开合态。
     *
     * 工具渲染层固定输出 open 的 <details>，不应感知 GUI 模式；展开态由渲染层在
     * 这里统一归一：极简模式收起（避免展开块内层层滚动条），详细模式展开。
     * disclosureState 里记录了用户的手动开合，优先于模式默认值，保证流式重渲染
     * 不会把用户刚展开的卡片又折回去。
     *
     * 卡片按渲染位置（消息 → part → 卡序）标识并写入 data-terminal-card-key：
     * 直接取工具 HTML 里的 id 会拿到 HTML 转义后的文本，与 DOM dataset 解码后的
     * 值对不上；位置 key 两端同源，且同一 part 的卡片只增不改、顺序稳定。
     */
    static _applyTerminalCardDisclosure(html, disclosureState, messageId, partIndex) {
        const source = String(html || '');
        if (!source.includes('terminal-tool')) return source;
        let cardIndex = 0;
        return source.replace(TERMINAL_CARD_DETAILS_TAG_RE, (_match, attrs) => {
            const key = `${messageId}-terminal-card-${partIndex}-${cardIndex}`;
            cardIndex += 1;
            const stored = disclosureState?.get(key);
            const expanded = stored === undefined ? getDefaultExpanded(guiOutputMode) : stored === true;
            // open 是布尔属性：只剥离独立成词的它，属性值里的 "open" 因两侧是引号
            // 而不会被 (?=\s|$) 命中。
            const cleaned = attrs.replace(/(^|\s)open(?=\s|$)/, '$1').replace(/\s+$/, '');
            const keyAttribute = ` data-terminal-card-key="${escapeHtml(key)}"`;
            return expanded ? `<details${cleaned}${keyAttribute} open>` : `<details${cleaned}${keyAttribute}>`;
        });
    }

    _renderProcessEntry(entry, messageId, disclosureState, options = {}) {
        const html = this._renderProcessEntryContent(entry, messageId, disclosureState, options);
        return this._getAssistantCompactBoundary(messageId)
            ? `<div data-output-part-index="${entry.partIndex}">${html}</div>`
            : html;
    }

    _renderProcessEntryContent(entry, messageId, disclosureState, options = {}) {
        if (entry.type === 'reasoning') {
            // 已完成消息（isRunning === false）中即使 part 残留 streaming 标记，也必须按
            // 已完成渲染：否则历史折叠内容里的推理块会保持 reasoning-active 并重新启动
            // 每秒计时器（data-reasoning-start 被设置为当前时间），出现"早已完成的内容
            // 还在持续计时"。运行中消息（isRunning === true）才允许流式布局。
            const streaming = options.isRunning === false ? false : entry.part?.streaming === true;
            // reasoning 正文优先 content 字段（后端真实字段），text/rendered 为旧数据与
            // 历史兼容（rendered 对 reasoning 恒等于 content 的纯文本）
            const content = streaming
                ? (entry.part?.content ?? entry.part?.text ?? entry.part?.rendered)
                : entry.part?.rendered;
            const disclosureKey = `${messageId}-reasoning-${entry.partIndex}`;
            return TaskView.createReasoningPartHtml(
                content,
                streaming,
                entry.partIndex,
                entry.part?.elapsedSeconds,
                options.forceReasoningCollapsed === true
                    ? false
                    : options.forceExpanded === true
                      ? true
                      : disclosureState?.get(disclosureKey),
                disclosureKey
            );
        }
        return TaskView._applyTerminalCardDisclosure(entry.part?.rendered, disclosureState, messageId, entry.partIndex);
    }

    _renderProcessItem(item, messageId, disclosureState, options = {}) {
        const processKey = `${messageId}-${item.key}`;
        const stored = disclosureState?.get(processKey);
        const expanded =
            options.forceExpanded === true || (stored === undefined ? getDefaultExpanded(guiOutputMode) : stored);
        // 详细模式下卡片全部铺开展示，摘要行与之重复，不再渲染可折叠头；
        // 简洁模式保留摘要行以承载"一块过程的折叠/展开"入口。
        if (guiOutputMode === 'verbose') {
            return `
            <section class="od-process-segment is-expanded" data-output-key="${escapeHtml(item.key)}">
                <div class="od-process-detail is-open">
                    ${item.entries
                        .map((entry) => this._renderProcessEntry(entry, messageId, disclosureState, options))
                        .join('')}
                </div>
            </section>`;
        }
        const detailId = `od-${this.widget_id}-${processKey}-detail`;
        const summary = TaskView._processSummary(item);
        return `
            <section class="od-process-segment${expanded ? ' is-expanded' : ''}" data-output-key="${escapeHtml(item.key)}">
                <button type="button" class="od-process-summary" data-process-toggle
                    data-disclosure-key="${escapeHtml(processKey)}" aria-expanded="${expanded}" aria-controls="${escapeHtml(detailId)}">
                    <svg class="lucide lucide-lightbulb od-process-main-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M9 18h6"></path>
                        <path d="M10 22h4"></path>
                        <path d="M15.09 14c.18-.68.66-1.17 1.16-1.75A6 6 0 1 0 7.75 12.25c.48.56.97 1.07 1.16 1.75"></path>
                    </svg>
                    <span class="od-process-summary-text" title="${escapeHtml(summary)}">${escapeHtml(summary)}</span>
                    <span class="od-process-action">
                        <span class="od-process-chevron">${CHEVRON_RIGHT_ICON_SVG}</span>
                    </span>
                </button>
                <div id="${escapeHtml(detailId)}" class="od-process-detail${expanded ? ' is-open' : ''}">
                    ${item.entries
                        .map((entry) => this._renderProcessEntry(entry, messageId, disclosureState, options))
                        .join('')}
                </div>
            </section>`;
    }

    _renderRunningProcessDetails(item, messageId, disclosureState) {
        const detailId = `od-${messageId}-running-details`;
        return `
            <div id="${escapeHtml(detailId)}" class="od-process-detail od-running-process-detail is-open"
                data-output-key="${escapeHtml(item.key)}">
                ${item.entries
                    .map((entry) => this._renderProcessEntry(entry, messageId, disclosureState, { isRunning: true }))
                    .join('')}
            </div>`;
    }

    _renderRunningStatus(item, messageId, options = {}) {
        if (!this._lastRunningStatusTextByMessage) {
            this._lastRunningStatusTextByMessage = new Map();
        }
        let icon = '';
        let iconStyle = '';
        let iconStateClass = ' is-thinking';
        let iconMarkup = RUNNING_THINKING_ICON_SVG;
        let label = taskViewT('renderer.taskview.output.status.thinkingPrefix');
        // target 是状态里可能频繁变化的部分（当前目标名），只有它和工具计数变化时才重播淡入
        let target = '';
        // 思考态的起始时间按消息持久化：状态行随流式快照全量重建，起点必须跨渲染保持，
        // 否则"已思考 xx 秒"每帧归零。切换到工具执行时清除。
        if (!this._reasoningStatusStartByMessage) {
            this._reasoningStatusStartByMessage = new Map();
        }
        let reasoningTime = '';
        let reasoningStart = 0;
        if (item.kind === 'tool') {
            const name = TaskView._toolDisplayName(item.tool);
            if (name) {
                iconStateClass = ' is-tool';
                iconMarkup = RUNNING_TOOL_ICON_SVG;
                // "正在"保持普通文本，仅目标名用 code 高亮，与思考态文案结构一致
                label = taskViewT('renderer.taskview.output.status.toolPrefix');
                target = `<code>${escapeHtml(name)}</code>`;
                this._reasoningStatusStartByMessage.delete(messageId);
            }
        } else if (item.kind === 'working') {
            icon = 'fa-spinner fa-spin';
            iconStyle = 'fa-solid';
            iconStateClass = '';
            label = taskViewT('renderer.taskview.output.status.working');
            this._reasoningStatusStartByMessage.delete(messageId);
        } else {
            // 思考态与工具态同构：label 为动词前缀，"深度思考"作为 target 段高亮，中间以空格分隔
            const now = Date.now();
            let startTime = this._reasoningStatusStartByMessage.get(messageId);
            if (!startTime) {
                startTime = now;
                this._reasoningStatusStartByMessage.set(messageId, startTime);
            }
            target = `<code>${escapeHtml(taskViewT('renderer.taskview.output.status.thinkingKeyword'))}</code>`;
            reasoningStart = startTime;
            reasoningTime = taskViewT('renderer.taskview.output.status.thinkingTime', {
                time: formatReasoningElapsedTime(Math.max(0, Math.floor((now - startTime) / 1000)))
            });
        }
        // 运行中的思考/调用块追加已完成的工具调用统计，随流式快照持续更新
        const doneStats = options.doneStats || { count: 0, names: [] };
        let done = '';
        if (doneStats.count > 0) {
            if (item.kind === 'tool') {
                done = taskViewT('renderer.taskview.output.status.doneCount', { count: doneStats.count });
            } else if (item.kind === 'reasoning' || item.kind === undefined) {
                const listed = doneStats.names
                    .slice(0, 2)
                    .join(taskViewT('renderer.taskview.output.processSummary.listSeparator'));
                done = listed
                    ? taskViewT('renderer.taskview.output.status.doneCountWithTools', {
                          tools: listed,
                          count: doneStats.count
                      })
                    : taskViewT('renderer.taskview.output.status.doneCount', { count: doneStats.count });
            }
        }
        // 文本未变化的分段不重播动画，避免每帧闪烁与不必要的合成开销。
        // 首次渲染时固定 label（如"正在思考"）视为未变化直接静态呈现；
        // 目标名/工具计数属于新出现的内容，正常淡入。
        const lastText = this._lastRunningStatusTextByMessage.get(messageId);
        this._lastRunningStatusTextByMessage.set(messageId, { label, target, done, reasoningTime });
        const lastParts = typeof lastText === 'object' && lastText !== null ? lastText : undefined;
        const fadeClass = (value, lastValue, isLabel = false) => {
            if (isLabel && lastParts === undefined) return ' od-running-status-fade--static';
            return value === lastValue ? ' od-running-status-fade--static' : '';
        };
        const labelAnimClass = fadeClass(label, lastParts?.label, true);
        const targetAnimClass = fadeClass(target, lastParts?.target);
        const doneAnimClass = fadeClass(done, lastParts?.done);
        // 时间每秒都在变：首现随段淡入，之后静默更新，不重播淡入（避免每秒闪烁）
        const timeAnimClass =
            lastParts === undefined
                ? ''
                : reasoningTime === lastParts?.reasoningTime
                  ? ' od-running-status-fade--static'
                  : ' od-running-status-fade--static';
        // 状态行仅在极简模式渲染（详细模式由卡片自述状态），点击可展开运行详情
        const expandable = options.isRunning === true;
        const expanded = expandable && this._assistantRunningDetails.get(messageId) === true;
        const tag = expandable ? 'button' : 'div';
        const renderedIcon = iconMarkup || `<i class="${iconStyle} ${icon}" aria-hidden="true"></i>`;
        const separator = taskViewT('renderer.taskview.output.status.separator');
        // 纯文本分段走 escapeHtml；label/target 可能包含内联 code 高亮，需保留原始 HTML
        const segment = (animClass, extraClass, content) =>
            content === ''
                ? ''
                : `<span class="od-running-status-fade${animClass} ${extraClass}"><span>${escapeHtml(content)}</span></span>`;
        const segmentHtml = (animClass, extraClass, content) =>
            content === ''
                ? ''
                : `<span class="od-running-status-fade${animClass} ${extraClass}"><span>${content}</span></span>`;
        return `
            <${tag}${expandable ? ' type="button" data-running-output-toggle' : ''} class="od-running-status" role="status" aria-live="polite"
                data-message-id="${escapeHtml(messageId)}"${reasoningStart ? ` data-reasoning-status-start="${reasoningStart}"` : ''}
                ${expandable ? `aria-expanded="${expanded}" aria-controls="od-${escapeHtml(messageId)}-running-details"` : ''}>
                <span class="od-running-status-icon${iconStateClass}">${renderedIcon}</span>
                <span class="od-running-status-viewport">
                    <span class="od-running-status-text">
                        ${segmentHtml(labelAnimClass, 'od-running-status-label', label)}${target ? `<span class="od-running-status-separator">${escapeHtml(' ')}</span>` : ''}${segmentHtml(targetAnimClass, 'od-running-status-target', target)}${reasoningTime ? `<span class="od-running-status-separator">${escapeHtml(' ')}</span>` : ''}${segment(timeAnimClass, 'od-running-status-time', reasoningTime)}${done ? `<span class="od-running-status-separator">${escapeHtml(separator)}</span>` : ''}${segment(doneAnimClass, 'od-running-status-done', done)}
                    </span>
                </span>
            </${tag}>`;
    }

    _renderAssistantOutputHtml(parts, options = {}) {
        const normalizedParts = Array.isArray(parts) ? parts : [];
        const messageId = String(options.messageId || 'assistant');
        const showRunningDetails =
            options.showRunningDetails === true || this._assistantRunningDetails.get(messageId) === true;
        const doneStats = TaskView._collectDoneToolStats(normalizedParts);
        const items = buildAssistantOutputItems(normalizedParts, {
            isRunning: Boolean(options.isRunning)
        });
        const visibleItems = getVisibleAssistantOutputItems(items, {
            mode: guiOutputMode,
            isRunning: Boolean(options.isRunning),
            showRunningDetails,
            parts: normalizedParts
        });
        const finalItem = visibleItems.find((item) => item.type === 'final');
        // 界面组件始终展示，不随已完成的过程一起折叠
        const widgetItems = visibleItems.filter((item) => item.type === 'widget');
        const processItems = visibleItems.filter((item) => item !== finalItem && item.type !== 'widget');
        const hasProcessItem = processItems.some((item) => item.type === 'process');
        const renderItem = (item, showFinalLabel = true, runningProcessDetails = false) => {
            if (item.type === 'process') {
                if (runningProcessDetails) {
                    return this._renderRunningProcessDetails(item, messageId, options.disclosureState);
                }
                return this._renderProcessItem(item, messageId, options.disclosureState, {
                    isRunning: Boolean(options.isRunning)
                });
            }
            if (item.type === 'status') {
                return this._renderRunningStatus(item, messageId, {
                    isRunning: Boolean(options.isRunning),
                    doneStats
                });
            }
            if (item.type === 'widget') {
                return `<div class="od-genui-item" data-output-part-index="${item.partIndex}">${item.part.rendered || ''}</div>`;
            }
            if (item.type === 'final') {
                const label =
                    showFinalLabel && guiOutputMode !== 'verbose'
                        ? `<div class="od-final-result-label">${taskViewT('renderer.taskview.output.finalResult')}</div>`
                        : '';
                const content = item.part.rendered
                    ? item.part.rendered
                    : `<div class="od-streaming-text">${renderSafeMarkdown(String(item.part.text || ''))}</div>`;
                const dividerClass =
                    guiOutputMode === 'verbose' && hasProcessItem ? ' od-final-result-with-divider' : '';
                return `${label}<div class="od-final-result markdown-body${dividerClass}" data-output-part-index="${item.partIndex}">${content}</div>`;
            }
            const className = item.type === 'error' ? 'od-stage-body od-stage-error' : 'od-stage-body';
            const content = item.part.streaming
                ? `<div class="od-streaming-text" data-streaming-part-index="${item.partIndex}">${
                      item.part.rendered || renderSafeMarkdown(String(item.part.text || ''))
                  }</div>`
                : item.part.rendered || '';
            return `<div class="${className} markdown-body" data-output-part-index="${item.partIndex}">${content}</div>`;
        };

        let html;
        if (guiOutputMode === 'minimal' && !options.isRunning && finalItem && processItems.length > 0) {
            const disclosureKey = `${messageId}-completed-process`;
            const expanded = options.disclosureState?.get(disclosureKey) === true;
            const detailId = `od-${this.widget_id}-${disclosureKey}-detail`;
            const durationText = formatTurnDuration(options.turnDurationMs);
            const toggleLabel = durationText
                ? taskViewT('renderer.taskview.output.completedProcessWithDuration', { duration: durationText })
                : taskViewT('renderer.taskview.output.completedProcess');
            html = `
                <section class="od-completed-process${expanded ? ' is-expanded' : ''}">
                    <button type="button" class="od-completed-process-summary" data-completed-process-toggle
                        data-disclosure-key="${escapeHtml(disclosureKey)}" aria-expanded="${expanded}"
                        aria-controls="${escapeHtml(detailId)}">
                        <span>${escapeHtml(toggleLabel)}</span>
                        <span class="od-completed-process-chevron">${CHEVRON_RIGHT_ICON_SVG}</span>
                    </button>
                    <div id="${escapeHtml(detailId)}" class="od-completed-process-detail${expanded ? ' is-open' : ''}">
                        ${processItems.map((item) => renderItem(item)).join('')}
                    </div>
                </section>
                ${widgetItems.map((item) => renderItem(item)).join('')}
                ${renderItem(finalItem, false)}`;
        } else {
            html = visibleItems
                .map((item, index) => {
                    const runningProcessDetails =
                        options.isRunning &&
                        item.type === 'process' &&
                        (item.requiresUserAttention === true ||
                            (showRunningDetails && visibleItems[index - 1]?.type === 'status'));
                    return renderItem(item, true, runningProcessDetails);
                })
                .join('');
        }
        const output = `<div class="od-assistant-output-flow" data-output-mode="${guiOutputMode}" data-reason-display="${guiReasonDisplayMode}">${html}</div>`;
        if (!this._getAssistantCompactBoundary(messageId)) return output;
        const container = document.createElement('div');
        container.innerHTML = output;
        this._placeAssistantCompactBoundary(messageId, container);
        return container.innerHTML;
    }

    _rememberAssistantOutput(messageId, parts, options = {}) {
        this._assistantPartsByMessage.set(messageId, [...parts]);
        this._assistantRenderStateByMessage.set(messageId, {
            isRunning: options.isRunning === true,
            ...(options.turnDurationMs != null ? { turnDurationMs: options.turnDurationMs } : {})
        });
    }

    renderAssistantMessage(assistant_message, isLast = false, options = {}) {
        this._rememberAssistantOutput(assistant_message.message_id, assistant_message.content, {
            isRunning: options.isRunning,
            turnDurationMs: extractAssistantTurnDurationMs(assistant_message)
        });
        const content = this._renderAssistantOutputHtml(assistant_message.content, {
            isRunning: Boolean(options.isRunning),
            messageId: assistant_message.message_id,
            turnDurationMs: extractAssistantTurnDurationMs(assistant_message)
        });
        const usageHtml = isLast ? TaskView.formatUsageHtml(assistant_message.usage, this._modelContextSize) : '';
        const metaRowHtml = TaskView.buildMsgMetaRow(
            'assistant',
            getAssistantTurnEndTimestamp(assistant_message),
            assistant_message.message_id
        );
        if (isLast && usageHtml) {
            // reload / 任务切回的历史重建：把实例级缓存的最近测速回填到胶囊上，
            // 速度信息在实例存续期内跨任务切换可见（不持久化，实例关闭即消失）。
            // 只在缓存归属本消息时回填，避免旧消息的张冠李戴
            const temp = document.createElement('template');
            temp.innerHTML = usageHtml.trim();
            const capsule = temp.content.querySelector('.message-usage');
            const cached = TaskView.getRecentSpeed(this.task_id);
            if (capsule && cached && cached.messageId === String(assistant_message.message_id ?? '')) {
                capsule.dataset.speedValue = String(cached.speed);
                capsule.dataset.speedEstimated = cached.estimated === true ? 'true' : 'false';
                const textEl = capsule.querySelector('.usage-text');
                if (textEl) {
                    const completionTokens = parseInt(capsule.dataset.completionTokens || '0', 10);
                    const totalTokens = parseInt(capsule.dataset.totalTokens || '0', 10);
                    textEl.textContent = TaskView.formatUsageDisplayText(
                        completionTokens,
                        totalTokens,
                        this._modelContextSize,
                        TaskView.formatSpeedSuffix(cached.speed, cached.estimated === true)
                    );
                }
                return `
        <div class="od-assistant-msg-container flex items-start">
            <div id='message-container-${assistant_message.message_id}' class="px-2 bg-transparent w-full">
                <div id='message-content-${assistant_message.message_id}'>
                    ${content}
                </div>
                ${metaRowHtml}
                ${temp.content.firstElementChild.outerHTML}
            </div>
        </div>
        `;
            }
        }
        const html = `
        <div class="od-assistant-msg-container flex items-start">
            <div id='message-container-${assistant_message.message_id}' class="px-2 bg-transparent w-full">
                <div id='message-content-${assistant_message.message_id}'>
                    ${content}
                </div>
                ${metaRowHtml}
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
                htmlParts.push(
                    this.renderAssistantMessage(message, i === usageAssistantIdx, {
                        isRunning: i === options.runningAssistantIdx
                    })
                );
            } else if (TaskView.isCompactBoundaryMessage(message)) {
                const target = this._historyMessages.find(
                    (item) => item.role === 'assistant' && item.message_id === message.kept_anchor_message_id
                );
                if (
                    !target ||
                    this._getAssistantCompactBoundary(target.message_id) !== message ||
                    !Array.isArray(target.content) ||
                    message.kept_anchor_start_part_index > target.content.length
                ) {
                    htmlParts.push(TaskView.renderCompactBoundary(message));
                }
            }
            const goalEvaluationHtml = renderGoalEvaluationRecordsHtml(
                getGoalEvaluationRecordsForMessage(this._historyGoalEvaluationRecords, message),
                this.task_id,
                taskViewT
            );
            if (goalEvaluationHtml) {
                htmlParts.push(goalEvaluationHtml);
            }
        }

        return htmlParts.join('');
    }

    _renderInitialHistoryWindow(messages, options = {}) {
        this._chatFind?.refresh();
        this._navigationHistorySource = null;
        this._historyMessages = Array.isArray(messages) ? messages : [];
        this._historyGoalEvaluationRecords = getTaskGoalEvaluationRecords(options.goal, options.goalFinalSnapshots);
        this._historyRenderStartIndex = TaskView.findHistoryBatchStart(
            this._historyMessages,
            this._historyMessages.length
        );

        const historyContainer = this.getHistoryContainer();
        let runningAssistantIdx = -1;
        if (this.task_status === 'running') {
            for (let index = this._historyMessages.length - 1; index >= 0; index -= 1) {
                if (this._historyMessages[index]?.role === 'assistant') {
                    runningAssistantIdx = index;
                    break;
                }
            }
        }
        const htmlParts = [
            this._renderHistoryRangeToHtml(this._historyRenderStartIndex, this._historyMessages.length, {
                markRenderedUserParts: true,
                usageAssistantIdx: options.usageAssistantIdx,
                runningAssistantIdx
            })
        ];
        const unanchoredGoalEvaluationHtml = renderGoalEvaluationRecordsHtml(
            getUnanchoredGoalEvaluationRecords(this._historyGoalEvaluationRecords, this._historyMessages),
            this.task_id,
            taskViewT
        );
        if (unanchoredGoalEvaluationHtml) {
            htmlParts.push(unanchoredGoalEvaluationHtml);
        }

        for (const message of this._historyMessages) {
            this.removePendingGoalSupplementForIds(getGoalSupplementIds(message));
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
        // 全量重渲染时恢复已被消费但等待 LLM 响应的过渡态卡片
        for (const message of this._consumedGoalSupplementPendingItems) {
            htmlParts.push(this.renderConsumedGoalSupplementMessage(message));
        }
        const shouldRestorePendingGoalEdit =
            this._pendingGoalEditMessage?.taskId === this.task_id &&
            TaskView.canShowWaitingAssistantPlaceholder(this.task_status, options.goal || this._currentGoal);
        if (shouldRestorePendingGoalEdit) {
            htmlParts.push(this.renderPendingGoalEditMessage(this._pendingGoalEditMessage));
        }

        historyContainer.innerHTML = htmlParts.join('');
        if (shouldRestorePendingGoalEdit) {
            this._showWaitingAssistantPlaceholder({ force: true });
        }
        enhanceCodeBlocks(historyContainer);
        enhanceToolPreviewCards(historyContainer);
        renderMermaidBlocks(historyContainer);
        this._syncReasoningTimers(historyContainer);
        this._syncPendingGoalEditToArtifacts();
    }

    _loadOlderHistoryBatch(options = {}) {
        if (this._loadingOlderHistory || !this._hasOlderHistory()) return false;

        const previousStartIndex = this._historyRenderStartIndex;
        const nextStartIndex = TaskView.findHistoryBatchStart(this._historyMessages, previousStartIndex);
        if (nextStartIndex >= previousStartIndex) return false;

        const historyContainer = this.getHistoryContainer();
        const preserveScrollPosition = options.preserveScrollPosition !== false;
        const previousScrollHeight = preserveScrollPosition ? historyContainer.scrollHeight : 0;
        const previousScrollTop = preserveScrollPosition ? historyContainer.scrollTop : 0;

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
                    renderMermaidBlocks(element);
                }
            }

            if (preserveScrollPosition) {
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
        this._chatFind?.refresh();
        this._navigationHistorySource = null;
        this._chatNavigation?.refresh();
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
        this._chatFind?.refresh();
        this._navigationHistorySource = null;
        this._chatNavigation?.refresh();
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
        this._chatFind?.refresh();
        this._navigationHistorySource = null;
        this._chatNavigation?.refresh();
        const index = this._getHistoryMessageIndexById(progress.message_id);
        if (index < 0) return;
        const message = this._historyMessages[index];
        if (!message || message.role !== 'assistant' || !progress.last_part) return;
        if (!Array.isArray(message.content)) {
            message.content = [];
        }
        const partIndex = getProgressPartIndex(progress);
        message.content[partIndex] =
            progress.streaming === true ? { ...progress.last_part, streaming: true } : progress.last_part;
        if (TaskView.hasDisplayableUsage(progress.usage)) {
            message.usage = progress.usage;
        }
    }

    _applyHiddenAssistantReplaceToHistory(progress) {
        this._chatFind?.refresh();
        this._navigationHistorySource = null;
        this._chatNavigation?.refresh();
        // 增量 replace 的隐藏历史路径：被省略的前缀以 _historyMessages 中该消息的
        // 现有 content 为真源回填（隐藏消息不经过 _assistantPartsByMessage 缓存）；
        // 历史中无该消息或前缀长度不足时按纯尾部覆盖（后续全量快照兜底纠正）。
        let parts = Array.isArray(progress.parts) ? progress.parts : [];
        if (typeof progress.unmodifiedTail === 'number' && progress.unmodifiedTail > 0) {
            const index = this._getHistoryMessageIndexById(progress.message_id);
            const cachedParts = index >= 0 ? this._historyMessages[index]?.content : null;
            if (Array.isArray(cachedParts) && cachedParts.length >= progress.unmodifiedTail) {
                parts = [...cachedParts.slice(0, progress.unmodifiedTail), ...parts];
            }
        }
        const messageIndex = this._getHistoryMessageIndexById(progress.message_id);
        if (messageIndex < 0) return;
        const message = this._historyMessages[messageIndex];
        if (!message || message.role !== 'assistant') return;
        message.content = parts;
        if (progress.metadata) {
            message.metadata = progress.metadata;
        }
        if (TaskView.hasDisplayableUsage(progress.usage)) {
            message.usage = progress.usage;
        }
    }

    /**
     * 可见消息的历史同步：把流式/replace 得到的 assistant 消息并入 _historyMessages。
     * 复制按钮与 HTML 导出都以 _historyMessages 为数据源，缺少同步会导致
     * 任务结束后立即复制不到内容、导出 HTML 缺少刚完成的整轮对话。
     */
    _syncAssistantMessageToHistory(messageId, parts, extra = {}) {
        this._chatFind?.refresh();
        if (!messageId || !Array.isArray(parts) || parts.length === 0) return;
        const index = this._getHistoryMessageIndexById(messageId);
        if (index >= 0) {
            const message = this._historyMessages[index];
            if (!message || message.role !== 'assistant') return;
            message.content = [...parts];
            if (extra.metadata) {
                message.metadata = extra.metadata;
            }
            if (extra.usage) {
                message.usage = extra.usage;
            }
            return;
        }
        this._navigationHistorySource = null;
        this._historyMessages.push({
            role: 'assistant',
            message_id: messageId,
            content: [...parts],
            ...(extra.metadata ? { metadata: extra.metadata } : {}),
            ...(extra.usage ? { usage: extra.usage } : {})
        });
        this._chatNavigation?.refresh();
    }

    /** 可见用户消息的历史同步：首帧 push 新消息，同消息的后续 part 帧按 partIndex 合并。 */
    _syncUserMessageToHistory(progress, parts, partIndex) {
        this._chatFind?.refresh();
        if (!progress.message_id) return;
        let index = this._getHistoryMessageIndexById(progress.message_id);
        if (index < 0) {
            this._navigationHistorySource = null;
            this._historyMessages.push({
                role: 'user',
                message_id: progress.message_id,
                content: []
            });
            this._chatNavigation?.refresh();
            index = this._historyMessages.length - 1;
        }
        const message = this._historyMessages[index];
        if (!message || message.role !== 'user') return;
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

    /** 可见用户消息 replace（slash skill 替换文本）的历史同步，与 _applyHiddenUserReplaceToHistory 对齐。 */
    _syncUserReplaceToHistory(progress) {
        this._chatFind?.refresh();
        if (!progress.message_id) return;
        let index = this._getHistoryMessageIndexById(progress.message_id);
        if (index < 0) {
            this._navigationHistorySource = null;
            this._historyMessages.push({
                role: 'user',
                message_id: progress.message_id,
                content: []
            });
            this._chatNavigation?.refresh();
            index = this._historyMessages.length - 1;
        }
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
            // 追加对话窗口内旧回合胶囊可能仍挂在上一条消息上，复用占位符时一并清理
            this._removeUsageOutside(existingPlaceholder);
            return;
        }

        historyContainer.insertAdjacentHTML('beforeend', TaskView.createWaitingAssistantPlaceholderHtml());
        // submitMessage / 队列消息自动发送会在旧回合胶囊仍挂在上一条消息上时先显示
        // 占位胶囊，用户消息 progress 到达前的窗口内会出现两个胶囊；按「仅保留
        // 最新一条胶囊」的既有规则立即清理占位符之外的旧胶囊
        this._removeUsageOutside(historyContainer.querySelector('.waiting-usage-placeholder'));
        // 首 token 之前的等待期（含模型思考期）同步展示上下文占用胶囊：
        // 此阶段尚无输出词数与速度可测，先让「总计/上下文占比」持续可见；
        // 模型开始输出后占位被移除，由首条 assistant progress 的正常胶囊接管
        const waitingBody = historyContainer.querySelector('.waiting-usage-placeholder > .px-2');
        if (!waitingBody) return;
        const baseline = this._contextUsageBaseline;
        if (baseline && baseline.t > 0) {
            waitingBody.insertAdjacentHTML(
                'beforeend',
                TaskView.formatUsageHtml(
                    { prompt_tokens: baseline.p, completion_tokens: 0, total_tokens: baseline.t },
                    this._modelContextSize,
                    true
                )
            );
        } else {
            // 任务首轮（无 usage 基线）：没有总计/占比可显示，但保留词数胶囊让统计持续在位
            const outputOnlyText = escapeHtml(taskViewT('renderer.taskview.usage.outputOnly', { output: 0 }));
            waitingBody.insertAdjacentHTML(
                'beforeend',
                `<span class="message-usage text-xs text-gray-400 mt-3 flex items-center gap-1" data-prompt-tokens="0" data-completion-tokens="0" data-total-tokens="0" data-streaming="true"><span class="usage-spinner">${TaskView.SPINNER_SVG}</span><span class="usage-text">${outputOnlyText}</span></span>`
            );
        }
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
                ? taskViewT('renderer.taskview.retry.retrying', { attempt: progress.attempt })
                : taskViewT('renderer.taskview.retry.scheduled', { attempt: progress.attempt, retryTime, seconds });
        const errorText = progress.error_message ? escapeHtml(progress.error_message) : '';
        const retryNowButton =
            progress.status === 'scheduled'
                ? `<button class="od-retry-now-btn ml-auto self-center inline-flex items-center gap-1 flex-shrink-0 rounded-md px-3 py-1.5 text-xs font-medium
                    bg-amber-200 text-amber-800
                    hover:bg-amber-300 active:bg-amber-400
                    transition-colors duration-150"
                    data-action="retry-now"
                    title="${taskViewT('renderer.taskview.retry.skipWait')}">
                    <i class="fa-solid fa-arrow-rotate-right text-[11px]"></i>${taskViewT('renderer.taskview.retry.now')}
                  </button>`
                : '';

        return `
        <div class="od-task-retry-status my-2 mx-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-amber-700 text-xs" data-retry-status="true">
            <div class="flex items-center gap-2 font-medium">
                <i class="fa-solid fa-circle-notch fa-spin"></i>
                <span>${taskViewT('renderer.taskview.retry.title')}</span>
                ${retryNowButton}
            </div>
            <div class="mt-1">${escapeHtml(statusText)}</div>
            ${errorText ? `<div class="mt-1 text-amber-700/80 break-words">${taskViewT('renderer.taskview.retry.lastError', { error: errorText })}</div>` : ''}
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
                    btn.textContent = taskViewT('renderer.taskview.retry.inProgress');
                    try {
                        await window.taskManagerAPI.skipRetryDelay(this.task_id);
                    } catch (err) {
                        console.error('skipRetryDelay failed:', err);
                        btn.disabled = false;
                        btn.textContent = taskViewT('renderer.taskview.retry.now');
                    }
                });
            }
        }
    }

    handleAssistantReplace(progress) {
        // 增量 replace：parts 只携带尾部 N 个新 parts，省略的前缀从本地缓存回填
        // （unmodifiedTail 指明被省略的前缀长度）。缓存缺失时按纯尾部渲染——
        // 宁可短暂显示不完整也不能捏造不存在的旧内容，后续全量快照会自然纠正。
        if (typeof progress.unmodifiedTail === 'number' && progress.unmodifiedTail > 0) {
            const cachedParts = this._assistantPartsByMessage.get(progress.message_id) || [];
            if (cachedParts.length >= progress.unmodifiedTail) {
                progress = {
                    ...progress,
                    parts: [...cachedParts.slice(0, progress.unmodifiedTail), ...progress.parts]
                };
            }
        }
        const previousRenderState = this._assistantRenderStateByMessage.get(progress.message_id);
        // 定型快照（finalized）发出时任务可能仍为 running，本条消息仍需
        // 按非流式处理，不得因 task_status 为 running 而提前返回
        const messageFinalized = progress.finalized === true;
        if (previousRenderState?.isRunning === false && progress.task_status === 'running' && !messageFinalized) {
            return;
        }
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
                this._assistantPartsByMessage.delete(progress.message_id);
                this._assistantRenderStateByMessage.delete(progress.message_id);
                this._assistantDisclosureStateByMessage.delete(progress.message_id);
            }
            if (TaskView.canShowWaitingAssistantPlaceholder(progress.task_status, this._currentGoal)) {
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
        const processScrollFollowState = this._captureProcessScrollFollowState(message_content);

        // 定型快照（finalized）即使 task_status=running 也按非流式处理
        const isRunning = progress.task_status === 'running' && progress.finalized !== true;
        const parts = progress.parts;
        const turnDurationMs = extractAssistantTurnDurationMs(progress);
        this._rememberAssistantOutput(progress.message_id, parts, {
            isRunning,
            turnDurationMs
        });
        this._syncAssistantMessageToHistory(progress.message_id, parts, {
            usage: TaskView.hasDisplayableUsage(progress.usage) ? progress.usage : undefined,
            metadata: progress.metadata
        });
        if (!isRunning) {
            const execution = progress.metadata?.execution;
            const finishedAt =
                (typeof execution?.finishAt === 'number' && execution.finishAt) ||
                (typeof execution?.startAt === 'number' && execution.startAt);
            if (finishedAt) {
                this._lastAssistantCompletedAt = finishedAt;
            }
        }
        const disclosureState = this._captureProcessDisclosureState(message_content);
        message_content
            .querySelectorAll('.reasoning-block-od.reasoning-active')
            .forEach((el) => TaskView.finalizeReasoningBlock(el));
        message_content.innerHTML = this._renderAssistantOutputHtml(parts, {
            isRunning,
            messageId: progress.message_id,
            disclosureState,
            turnDurationMs: extractAssistantTurnDurationMs(progress)
        });
        this._placeAssistantCompactBoundary(progress.message_id, message_content);
        enhanceCodeBlocks(message_content);
        enhanceToolPreviewCards(message_content);
        renderMermaidBlocks(message_content, { defer: isRunning });
        this._syncReasoningTimers(message_content);
        this._restoreProcessScrollFollowState(message_content, processScrollFollowState);

        const usageEl = message_container.querySelector('.message-usage');
        if (TaskView.hasDisplayableUsage(progress.usage)) {
            this._rememberContextUsage(progress.usage);
            this._removeUsageOutside(message_container);
            // 终态 replace 重建胶囊时保留流式期间测得的 decode 速度，
            // 避免「回合一结束速度就消失」——速度定格在最后一次窗口测速值；
            // DOM 胶囊缺失（如 reload 后重建）时回读实例级最近测速缓存；
            // 词数用测速状态融合值而非 progress.usage 直读：请求开始时的
            // prompt 检查点 usage（completion=0）会把思考期间涨起来的词数清零
            const cachedSpeed = TaskView.getRecentSpeed(this.task_id);
            const cachedBelongsToMessage = cachedSpeed?.messageId === String(progress.message_id ?? '');
            const finalSpeed = usageEl?.dataset.speedValue
                ? Number(usageEl.dataset.speedValue)
                : cachedBelongsToMessage
                  ? cachedSpeed.speed
                  : null;
            const finalSpeedEstimated = usageEl?.dataset.speedValue
                ? usageEl.dataset.speedEstimated === 'true'
                : cachedBelongsToMessage
                  ? cachedSpeed.estimated === true
                  : false;
            // 完成态 usage（completion>0）真实权威，直接采用；请求开始的 prompt 检查点
            // （completion=0）只提供 prompt/total，词数用测速状态融合值，避免把思考
            // 期间涨起来的词数清零
            const usageTokensForReplace = TaskView.getUsageDisplayTokens(progress.usage);
            let displayTokens;
            if (usageTokensForReplace.completionTokens > 0) {
                displayTokens = progress.usage;
            } else {
                // 测速状态必须属于本消息（_trackOutputSpeed 每条消息重建 state），
                // 否则会把另一条消息的累计词数错误地叠到这条上
                const stateBelongsToMessage = this._speedMessageState?.messageId === String(progress.message_id ?? '');
                const stateTokens = stateBelongsToMessage ? this._computeDisplayTokensFromState() : null;
                displayTokens = {
                    prompt_tokens: usageTokensForReplace.promptTokens,
                    completion_tokens: stateTokens ? stateTokens.completion : 0,
                    total_tokens: stateTokens
                        ? Math.max(usageTokensForReplace.totalTokens, stateTokens.total)
                        : usageTokensForReplace.totalTokens
                };
            }
            const usageHtml = TaskView.formatUsageHtml(
                displayTokens,
                this._modelContextSize,
                false,
                finalSpeed,
                finalSpeedEstimated
            );
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

        // 任务非运行状态时（已完成），为消息追加时间戳与 hover 菜单
        if (!isRunning && !message_container.querySelector('.od-msg-meta-row')) {
            const execution = progress.metadata?.execution;
            const ts =
                (typeof execution?.finishAt === 'number' && execution.finishAt) ||
                (typeof execution?.startAt === 'number' && execution.startAt) ||
                this._lastAssistantCompletedAt ||
                Date.now();
            const metaRowHtml = TaskView.buildMsgMetaRow('assistant', ts, progress.message_id);
            if (metaRowHtml) {
                const usageEl2 = message_container.querySelector('.message-usage');
                if (usageEl2) {
                    usageEl2.insertAdjacentHTML('beforebegin', metaRowHtml);
                } else {
                    message_container.insertAdjacentHTML('beforeend', metaRowHtml);
                }
            }
        }
    }

    /**
     * 运行中终端命令 live 输出快路径的判定：part 为 tool_call、前后同为 tool_call、
     * toolcall id 一一对应，且每个 toolcall 的状态相对上一帧未发生变化。
     * 静态纯函数，便于单测覆盖。
     */
    static canPatchRunningTerminalToolCall(progress, previousPart, isRunning) {
        if (
            progress?.last_part?.type !== 'tool_call' ||
            previousPart?.type !== 'tool_call' ||
            isRunning !== true ||
            !Array.isArray(progress.last_part.toolcalls) ||
            progress.last_part.toolcalls.length === 0 ||
            !Array.isArray(previousPart.toolcalls) ||
            previousPart.toolcalls.length !== progress.last_part.toolcalls.length
        ) {
            return false;
        }
        return progress.last_part.toolcalls.every((tc, i) => {
            const prev = previousPart.toolcalls[i];
            if (!prev || prev.id !== tc.id) return false;
            // 状态迁移（pending → running、running → success/error）必须走全量渲染：
            // 增量快路径只追加输出文本，不重建卡片，会让状态徽标、终态输出、耗时
            // 永远停在上一帧（用户看到命令已经跑完却仍显示「运行中」）。
            // 状态未变则允许被增量跳过，这样「并行工具里一个先结束后，另一个长时间
            // 输出」不会每 tick 整条消息全量重渲。
            return prev.status === tc.status;
        });
    }

    /**
     * 增量追加时允许累积的文本节点上限。
     *
     * 每 200ms 一个 tick 都 append 一个文本节点，长时间运行的命令（dev server、
     * 持续日志）会堆出上万个节点；`pre-wrap` 下的排版成本随节点数增长，最终拖慢
     * 渲染进程。达到上限后合并为单个文本节点，内容等价。
     */
    static LIVE_OUTPUT_MAX_TEXT_NODES = 64;

    /**
     * 运行中终端命令的 live 输出快路径。优先走增量分支：主进程 tick 携带
     * outputDelta（已剥离 ANSI 的纯文本）时，直接向已挂载卡片的
     * .terminal-tool-output 追加文本，跳过整份 part HTML 的解析与节点替换
     * （超长输出下每 200ms 一次的双重 HTML 解析曾是渲染进程的重要 CPU 来源）。
     * 任一前提不满足（卡片缺失、非终端工具、无增量字段、状态迁移）时回退
     * 全量路径：按 toolcall id 在新旧结构间配对，仅替换各卡片的输出区域
     * （.terminal-tool-scroll）并滚动到底部。
     */
    static patchRunningTerminalToolOutput(message_content, toolcalls, partRenderedHtml) {
        if (Array.isArray(toolcalls) && toolcalls.length > 0) {
            let incremental = true;
            const deltas = [];
            for (const tc of toolcalls) {
                if (typeof tc?.id !== 'string' || tc.id === '') {
                    incremental = false;
                    break;
                }
                // 已结束 / 本次没有增量 / 非终端卡片的 toolcall 不参与增量：
                // 它们不是本次要更新的目标，不应因此把整条消息退回全量重建。
                if (tc.status !== 'running' || typeof tc.outputDelta !== 'string' || tc.outputDelta === '') continue;
                const escapedId = tc.id.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
                const liveCard = message_content.querySelector(`[data-toolcall-id="${escapedId}"]`);
                const pre = liveCard?.querySelector('.terminal-tool-output');
                if (!liveCard || !pre) {
                    incremental = false;
                    break;
                }
                deltas.push({ pre, delta: tc.outputDelta, reset: tc.outputReset === true });
            }
            if (incremental && deltas.length > 0) {
                for (const { pre, delta, reset } of deltas) {
                    if (reset) {
                        pre.textContent = delta;
                    } else if (pre.childNodes.length >= TaskView.LIVE_OUTPUT_MAX_TEXT_NODES) {
                        // 合并已有节点，避免长期运行累积出上万个文本节点
                        pre.textContent = pre.textContent + delta;
                    } else {
                        pre.appendChild(document.createTextNode(delta));
                    }
                    const scroll = pre.closest('.terminal-tool-scroll');
                    if (scroll) {
                        scroll.scrollTop = scroll.scrollHeight;
                    }
                }
                return true;
            }
        }
        if (typeof partRenderedHtml !== 'string' || partRenderedHtml === '') return false;
        if (!Array.isArray(toolcalls) || toolcalls.length === 0) return false;
        const runningIds = [];
        for (const tc of toolcalls) {
            if (typeof tc?.id !== 'string' || tc.id === '' || tc.status !== 'running') return false;
            runningIds.push(tc.id);
        }
        const template = document.createElement('template');
        template.innerHTML = partRenderedHtml;
        const patches = [];
        for (const id of runningIds) {
            const escapedId = id.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
            const liveCard = message_content.querySelector(`[data-toolcall-id="${escapedId}"]`);
            const freshCard = template.content.querySelector(`[data-toolcall-id="${escapedId}"]`);
            if (!liveCard || !freshCard) return false;
            const freshScroll = freshCard.querySelector('.terminal-tool-scroll');
            const liveScroll = liveCard.querySelector('.terminal-tool-scroll');
            if (!freshScroll || !liveScroll) return false;
            patches.push({ freshScroll, liveScroll });
        }
        for (const { freshScroll, liveScroll } of patches) {
            liveScroll.innerHTML = freshScroll.innerHTML;
            liveScroll.scrollTop = liveScroll.scrollHeight;
        }
        return true;
    }

    _renderAssistantProgress(progress, history_container) {
        if (!progress.last_part) return false;

        const previousRenderState = this._assistantRenderStateByMessage.get(progress.message_id);
        if (previousRenderState?.isRunning === false && progress.task_status === 'running') {
            return false;
        }

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
        const processScrollFollowState = this._captureProcessScrollFollowState(message_content);

        // A display-only boundary must never shift the model part indices.
        message_content.querySelectorAll(':scope > .od-compact-boundary').forEach((element) => element.remove());

        const partIndex = getProgressPartIndex(progress);
        const parts = [...(this._assistantPartsByMessage.get(progress.message_id) || [])];
        const previousPart = parts[partIndex];
        const isRunning = progress.task_status === 'running';
        const isIncrementalTextPart =
            (progress.last_part?.type === 'text' || progress.last_part?.type === 'reasoning') &&
            progress.task_status === 'running';
        // streaming 标志是主进程对「该 part 仍在生成」的判定，必须原样保留：
        // 运行中同一 part 的增量快照才带 streaming=true；part 结束/切换后主进程
        // 发送的非流式快照（可能携带固化耗时）若被这里强行改写回 streaming=true，
        // 思考块会保持 reasoning-active 继续每秒计时，出现"早已结束还在已思考 N 秒"。
        // 同理，partIndex 未提供时不能假定 0 一定在流式（getFullTask 快照等场景）。
        const treatAsStreaming = isIncrementalTextPart && progress.streaming === true;
        // 增量补丁仅适用于「新旧快照都处于流式中的同一 part」；主进程在 part 结束时
        // 发送的非流式最终快照（streaming 标志消失，可能携带固化耗时）必须走全量
        // 渲染，思考块才能从 reasoning-active 切换为 completed 并定格计时。
        const canPatchStreamingPart =
            treatAsStreaming && previousPart?.streaming === true && previousPart.type === progress.last_part.type;
        // 运行中终端命令的 live 输出（每 200ms 一次）：同一批 toolcall 且状态均为 running 时，
        // 只需替换对应卡片内的输出区域，避免每 200ms 对整条消息做全量 morph + 增强。
        const canPatchStreamingToolCall = TaskView.canPatchRunningTerminalToolCall(progress, previousPart, isRunning);
        parts[partIndex] = treatAsStreaming ? { ...progress.last_part, streaming: true } : progress.last_part;
        this._rememberAssistantOutput(progress.message_id, parts, {
            isRunning
        });
        this._syncAssistantMessageToHistory(progress.message_id, parts, {
            usage: TaskView.hasDisplayableUsage(progress.usage) ? progress.usage : undefined
        });
        let patchedStreamingPart = false;
        // 流式光标在每次快照后追加到流式容器/末块内。在下一次快照的增量渲染前先移除，
        // 保证 updateStreamingText 的"已渲染块序列与 childNodes 一一对应"不被光标节点
        // 打破（否则每快照退化为全量重建，超长单回合下会引发全文档样式重算与布局）。
        message_content.querySelectorAll('.stream-cursor').forEach((el) => el.remove());
        if (canPatchStreamingToolCall) {
            patchedStreamingPart = TaskView.patchRunningTerminalToolOutput(
                message_content,
                progress.last_part.toolcalls,
                progress.last_part.rendered
            );
        }
        if (canPatchStreamingPart) {
            const targets = message_content.querySelectorAll(`[data-streaming-part-index="${partIndex}"]`);
            if (targets.length > 0) {
                targets.forEach((target) => {
                    const text = String(parts[partIndex].text ?? parts[partIndex].rendered ?? '');
                    if (progress.last_part.type === 'reasoning') {
                        const block = target.closest('.reasoning-block-od');
                        if (block) {
                            // reasoning 正文优先 content 字段（后端真实字段），text 为旧数据兼容
                            const reasoningText = String(parts[partIndex].content ?? text);
                            TaskView.scheduleReasoningPreviewUpdate(block, reasoningText);
                        }
                        const scrollingContainer = target.closest('.reasoning-bubble, .reasoning-preview-area');
                        if (scrollingContainer) scrollingContainer.scrollTop = scrollingContainer.scrollHeight;
                    } else {
                        const html =
                            parts[partIndex].rendered || renderSafeMarkdown(String(parts[partIndex].text || ''));
                        updateStreamingText(target, html);
                    }
                });
                patchedStreamingPart = true;
            } else if (progress.last_part.type === 'reasoning') {
                // Collapsed minimal mode does not mount reasoning details while streaming.
                patchedStreamingPart = true;
            }
        }
        if (!patchedStreamingPart) {
            const disclosureState = this._captureProcessDisclosureState(message_content);
            const isTerminal = progress.task_status !== 'running';
            const outputHtml = this._renderAssistantOutputHtml(parts, {
                isRunning: !isTerminal,
                messageId: progress.message_id,
                disclosureState,
                turnDurationMs: extractAssistantTurnDurationMs(progress)
            });
            if (isTerminal) {
                // Terminal updates may change the output hierarchy (for example, a normal
                // completion collapses the process timeline). Preview enhancers may also have
                // inserted nodes that are absent from outputHtml, so index-based morphing is
                // unsafe here.
                message_content
                    .querySelectorAll('.reasoning-block-od.reasoning-active')
                    .forEach((el) => TaskView.finalizeReasoningBlock(el));
                message_content.innerHTML = outputHtml;
            } else if (message_content.innerHTML !== outputHtml) {
                // 增量 morph 可能替换掉带活跃计时器的思考块节点（完成态 class 与活跃态
                // 不同导致 morphNode 整体替换）。被替换节点从文档脱钩后，每秒计时器
                // setInterval 若不显式清理，会在游离节点上空转并在头部显示持续增长的
                // 已思考耗时。与 disconnectedCallback 的 finalize 语义保持一致：先收尾
                // 计时再 morph。
                message_content
                    .querySelectorAll('.reasoning-block-od.reasoning-active')
                    .forEach((el) => TaskView.finalizeReasoningBlock(el));
                TaskView.morphDomChildren(message_content, outputHtml);
            }
        }
        if (!patchedStreamingPart) {
            // 与既有行为保持一致：终态更新同样执行增强器（代码块复制按钮、mermaid 等）。
            if (isRunning) {
                message_content.querySelectorAll('[data-streaming-part-index]').forEach((target) => {
                    const targetPart = parts[Number(target.dataset.streamingPartIndex)];
                    if (targetPart?.type !== 'text') return;
                    const html = targetPart.rendered || renderSafeMarkdown(String(targetPart.text || ''));
                    updateStreamingText(target, html);
                });
            }
            message_content.querySelectorAll('.terminal-tool-scroll').forEach((el) => {
                el.scrollTop = el.scrollHeight;
            });
            enhanceCodeBlocks(message_content);
            enhanceToolPreviewCards(message_content);
            renderMermaidBlocks(message_content, { defer: isRunning });
        }
        if (isRunning && progress.last_part.type === 'text') {
            TaskView._appendStreamCursor(message_content.querySelector(`[data-streaming-part-index="${partIndex}"]`));
        }
        this._syncReasoningTimers(message_content);
        this._restoreProcessScrollFollowState(message_content, processScrollFollowState);

        this._placeAssistantCompactBoundary(progress.message_id, message_content);
        const isStreaming = progress.task_status === 'running';
        // 实时输出速度 + 消息级 token 估算（无 usage 时按 chars/4 临时估算「已输出/总计」）
        const speedInfo = this._trackOutputSpeed(progress);
        const usageEl = message_container.querySelector('.message-usage');
        const usage = TaskView.hasDisplayableUsage(progress.usage) ? progress.usage : null;
        if (usage) {
            this._rememberContextUsage(usage);
        }
        if (usageEl) {
            const prevPrompt = parseInt(usageEl.dataset.promptTokens || '0', 10);
            const prevCompletion = parseInt(usageEl.dataset.completionTokens || '0', 10);
            const prevTotal = parseInt(usageEl.dataset.totalTokens || '0', 10);
            // 统一采用 _trackOutputSpeed 的估算值：它已融合 usage 检查点与输出增量
            // （provider 流中每帧带遗留 usage 时，词数仍随真实输出增长）；
            // 工具等非生成 part（speedInfo=null）保持上一状态
            const promptTokens = speedInfo ? (speedInfo.estPrompt ?? prevPrompt) : prevPrompt;
            const completionTokens = speedInfo ? (speedInfo.estCompletion ?? prevCompletion) : prevCompletion;
            const totalTokens = speedInfo ? (speedInfo.estTotal ?? prevTotal) : prevTotal;
            if (usage) {
                this._removeUsageOutside(message_container);
            }
            // 速度展示：工具帧/冷却期等无新测速时保留最近速度（含估算口径标记），
            // 实例存续期内不隐藏——旧值仍代表该任务的最近 decode 速率
            if (speedInfo != null && speedInfo.speed != null) {
                usageEl.dataset.speedValue = String(speedInfo.speed);
                usageEl.dataset.speedEstimated = speedInfo.speedEstimated === true ? 'true' : 'false';
            }
            // title 只展示真实 usage，避免估算期间出现误导性 tooltip
            if (usage) {
                usageEl.title = taskViewT('renderer.taskview.usage.title', {
                    input: promptTokens,
                    output: completionTokens,
                    total: totalTokens
                });
            }
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
                const speedValue = usageEl.dataset.speedValue || '';
                const speedEstimated = usageEl.dataset.speedEstimated === 'true';
                const speedSuffix = TaskView.formatSpeedSuffix(speedValue, speedEstimated);
                if (completionTokens > 0 || totalTokens > 0) {
                    textEl.textContent = TaskView.formatUsageDisplayText(
                        completionTokens,
                        totalTokens,
                        this._modelContextSize,
                        speedSuffix
                    );
                } else if (speedSuffix) {
                    textEl.textContent = speedSuffix;
                }
            }
        } else if (
            usage ||
            (isStreaming &&
                speedInfo &&
                (speedInfo.estCompletion > 0 || speedInfo.estTotal > 0 || speedInfo.estPrompt > 0))
        ) {
            this._removeUsageOutside(message_container);
            // 创建胶囊时同样采用估算融合值，保证与增量更新路径口径一致。
            // 流式首帧（part 尚无文本、词数为 0 且无 usage 基线 → estPrompt=0）也会走到
            // usage 分支之外——est 全为 0 时不建胶囊会留下「占位已移除、胶囊未创建」的
            // 统计真空窗口，故再补一个零词兜底分支
            const displayUsage = {
                prompt_tokens: speedInfo ? speedInfo.estPrompt : 0,
                completion_tokens: speedInfo ? speedInfo.estCompletion : 0,
                total_tokens: speedInfo ? speedInfo.estTotal : 0
            };
            const freshSpeed = speedInfo && speedInfo.speed != null ? speedInfo.speed : null;
            message_container.insertAdjacentHTML(
                'beforeend',
                TaskView.formatUsageHtml(
                    displayUsage,
                    this._modelContextSize,
                    isStreaming,
                    freshSpeed,
                    speedInfo?.speedEstimated === true
                )
            );
        } else if (isStreaming && (speedInfo || this._contextUsageBaseline)) {
            // 零词/工具首帧兜底：模型跳过文本直接调用工具时 speedInfo 为 null，
            // 此处用 baseline（若有）建「已输出 0 词， 总计 N 词」胶囊占住统计位，
            // 无 baseline（任务首轮）则只显示词数；后续生成帧无缝接管
            this._removeUsageOutside(message_container);
            const baseline = this._contextUsageBaseline;
            if (baseline && baseline.t > 0) {
                message_container.insertAdjacentHTML(
                    'beforeend',
                    TaskView.formatUsageHtml(
                        { prompt_tokens: baseline.p, completion_tokens: 0, total_tokens: baseline.t },
                        this._modelContextSize,
                        true
                    )
                );
            } else {
                const outputOnlyText = escapeHtml(taskViewT('renderer.taskview.usage.outputOnly', { output: 0 }));
                message_container.insertAdjacentHTML(
                    'beforeend',
                    `<span class="message-usage text-xs text-gray-400 mt-3 flex items-center gap-1" data-prompt-tokens="0" data-completion-tokens="0" data-total-tokens="0" data-streaming="true"><span class="usage-spinner">${TaskView.SPINNER_SVG}</span><span class="usage-text">${outputOnlyText}</span></span>`
                );
            }
        }

        // 任务非运行状态时（已完成），为消息追加时间戳与 hover 菜单
        if (!isStreaming && !message_container.querySelector('.od-msg-meta-row')) {
            const metaRowHtml = TaskView.buildMsgMetaRow('assistant', Date.now(), progress.message_id);
            if (metaRowHtml) {
                const usageEl2 = message_container.querySelector('.message-usage');
                if (usageEl2) {
                    usageEl2.insertAdjacentHTML('beforebegin', metaRowHtml);
                } else {
                    message_container.insertAdjacentHTML('beforeend', metaRowHtml);
                }
            }
        }

        return true;
    }

    _getProcessScrollFollowTargets(root) {
        const targets = new Map();
        // 过程块展开后按内容自然高度铺开、不再是滚动容器，故不再是滚动跟随目标；
        // 其内部的思考全文区仍有自身限高，继续参与跟随。
        root.querySelectorAll('.reasoning-block-od.reasoning-expanded .reasoning-full-area').forEach((element) => {
            const key = element.dataset.reasoningScrollKey;
            if (key !== undefined) targets.set(`reasoning:${key}`, element);
        });
        return targets;
    }

    _captureProcessScrollFollowState(root) {
        if (!this.auto_scrolling_to_bottom) return null;
        const state = new Map();
        for (const [key, element] of this._getProcessScrollFollowTargets(root)) {
            const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
            state.set(key, distanceToBottom <= PROCESS_INNER_SCROLL_BOTTOM_THRESHOLD_PX);
        }
        return state;
    }

    _restoreProcessScrollFollowState(root, state) {
        if (!state || !this.auto_scrolling_to_bottom) return;
        const rootKey = root.id || this.widget_id;
        for (const [targetKey] of this._getProcessScrollFollowTargets(root)) {
            if (state.get(targetKey) === false) continue;
            this._pendingProcessScrollFollowTargets.set(`${rootKey}:${targetKey}`, { root, targetKey });
        }
        if (this._pendingProcessScrollFollowTargets.size === 0 || this._processScrollFollowRafId !== null) return;

        this._processScrollFollowRafId = -1;
        const rafId = requestAnimationFrame(() => {
            this._processScrollFollowRafId = null;
            const pending = [...this._pendingProcessScrollFollowTargets.values()];
            this._pendingProcessScrollFollowTargets.clear();
            if (!this.auto_scrolling_to_bottom) return;
            for (const { root: pendingRoot, targetKey } of pending) {
                const element = this._getProcessScrollFollowTargets(pendingRoot).get(targetKey);
                if (element) element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
            }
        });
        if (this._processScrollFollowRafId !== null) this._processScrollFollowRafId = rafId;
    }

    /** 记录视图进入后台不可见状态（切换任务 / 后台创建时由宿主调用）。 */
    markViewHidden() {
        this._chatFind?.hide();
        this._getRightSidebarEl()?.setWorkspaceSidebarVisible?.(false);
        if (!this._viewHiddenAt) this._viewHiddenAt = Date.now();
    }

    /** 视图重新可见时清除后台计时。 */
    markViewShown() {
        this._viewHiddenAt = 0;
    }

    /**
     * 消息队列是否非空。队列消息仅存于控件内存且未持久化，释放控件会静默丢弃；
     * 草稿与附件已由 task-draft-storage 持久化，不在此列。
     */
    _hasQueuedMessages() {
        return Array.isArray(this.messageQueue) && this.messageQueue.length > 0;
    }

    /**
     * 消息队列是否非空（公开接口，供宿主 LRU 驻留数量上限淘汰判定调用）。
     * 队列仅存于控件内存且未持久化，淘汰/释放会静默丢弃待发送内容。
     */
    hasQueuedMessages() {
        return this._hasQueuedMessages();
    }

    /**
     * 后台释放判定：不可见超过 timeoutMs、任务非运行态、且消息队列为空时
     * 返回 true，宿主据此销毁控件并从缓存移除，下次打开重新加载。
     */
    shouldReleaseInBackground(now = Date.now(), timeoutMs = TASK_VIEW_BACKGROUND_RELEASE_MS) {
        return shouldReleaseTaskView(
            {
                isHidden: this.style.display === 'none' || this.hasAttribute('data-background'),
                hiddenAt: this._viewHiddenAt || 0,
                isRunning: this.task_status === 'running',
                hasQueuedMessages: this._hasQueuedMessages()
            },
            now,
            timeoutMs
        );
    }

    /** 取消尚未执行的滚动跟随 rAF（断连与强制滚动时调用，防止游离回调）。 */
    _cancelPendingScrollFollow() {
        if (this._scrollRafId !== null && this._scrollRafId >= 0) {
            cancelAnimationFrame(this._scrollRafId);
        }
        this._scrollRafId = null;
    }

    tryScrollToEnd() {
        if (!this.auto_scrolling_to_bottom) {
            return;
        }
        // 同一帧（或 rAF 尚未消费）内已排队的跟随请求直接合并，避免重复读取
        // scrollHeight（该读取会强制同步布局，是高频流式输出下主要的布局成本）。
        if (this._scrollRafId !== null) {
            return;
        }
        this._scrollRafId = requestAnimationFrame(() => {
            this._scrollRafId = null;
            if (!this.auto_scrolling_to_bottom) {
                return;
            }
            const domElement = this.getHistoryContainer();
            if (!domElement) {
                return;
            }
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

    /**
     * 强制进入"滚动到底部"状态并立即滚动到底部。
     * 用于用户发送新消息、队列消息自动/立即发出等主动产生新消息流的场景：
     * 即使此前用户手动滚动离开过底部（auto_scrolling_to_bottom=false），
     * 消息发出时也应重新锁定并回到底部，避免错过最新内容。
     */
    forceScrollToEnd() {
        this._chatFind?.hide();
        this.setAutoScrollingToBottom(true);
        // 组件可能尚未渲染历史容器（如仅存在于 model 层的最小 task-view），此时仅锁定状态
        if (this.getHistoryContainer()) {
            // 用户主动产生新消息流时取消在途跟随并立即重新排队，下一帧回到底部
            this._cancelPendingScrollFollow();
            this.tryScrollToEnd();
        }
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

    _getConversationStops() {
        const attachmentLabel = taskViewT('renderer.taskview.navigation.attachment');
        if (this._navigationHistorySource !== this._historyMessages) {
            this._navigationHistorySource = this._historyMessages;
            this._navigationHistoryStops = buildConversationStops(
                this._historyMessages,
                shouldRenderUserHistoryMessage,
                attachmentLabel,
                getGoalSupplementDisplayText
            );
        }
        return mergeRenderedConversationStops(
            this._navigationHistoryStops,
            this.getHistoryContainer(),
            attachmentLabel
        );
    }

    _navigateConversation(messageId) {
        const history = this.getHistoryContainer();
        if (!history || typeof messageId !== 'string' || messageId.length === 0) return;
        if (!this._findGoalMessageTarget(messageId) && this._getHistoryMessageIndexById(messageId) < 0) return;
        this.setAutoScrollingToBottom(false);
        this._ensureHistoryLoadedThroughMessage(messageId);
        const target = this._findGoalMessageTarget(messageId);
        if (!target) return;
        const requestedTop =
            history.scrollTop + target.getBoundingClientRect().top - history.getBoundingClientRect().top - 20;
        const top = Math.max(0, Math.min(requestedTop, history.scrollHeight - history.clientHeight));
        // Browsers do not emit scrollend when the clamped destination is already reached.
        this._conversationJumpInProgress = Math.abs(history.scrollTop - top) > 0.5;
        if (!this._conversationJumpInProgress) return;
        history.scrollTo({
            top,
            behavior: 'instant'
        });
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

    _scrollToUserMessage(direction) {
        const container = this.getHistoryContainer();
        if (!container) return;

        const containerRect = container.getBoundingClientRect();
        const userMessages = Array.from(container.querySelectorAll('.od-user-msg-container'));

        const isVisible = (el) => {
            const r = el.getBoundingClientRect();
            return r.bottom > containerRect.top && r.top < containerRect.bottom;
        };

        let target = null;

        // 在已渲染的用户消息中找到跳转目标
        if (direction === 'prev') {
            const topmostVisibleIdx = userMessages.findIndex(isVisible);
            if (topmostVisibleIdx > 0) {
                // 可见区域内有用户消息 → 取最顶部那条的上一条
                target = userMessages[topmostVisibleIdx - 1];
            } else if (topmostVisibleIdx === -1) {
                // 可见区域内无用户消息 → 往上找最近的一条已渲染消息
                for (let i = userMessages.length - 1; i >= 0; i--) {
                    if (userMessages[i].getBoundingClientRect().bottom <= containerRect.top) {
                        target = userMessages[i];
                        break;
                    }
                }
            }
            // topmostVisibleIdx === 0：第一条可见即第一条已渲染，无上一条 → target 保持 null
        } else {
            let bottommostVisibleIdx = -1;
            for (let i = userMessages.length - 1; i >= 0; i--) {
                if (isVisible(userMessages[i])) {
                    bottommostVisibleIdx = i;
                    break;
                }
            }
            if (bottommostVisibleIdx >= 0 && bottommostVisibleIdx < userMessages.length - 1) {
                target = userMessages[bottommostVisibleIdx + 1];
            } else if (bottommostVisibleIdx === -1) {
                for (let i = 0; i < userMessages.length; i++) {
                    if (userMessages[i].getBoundingClientRect().top >= containerRect.bottom) {
                        target = userMessages[i];
                        break;
                    }
                }
            }
        }

        // 无已渲染的上一条（target 为 null 或已是第一条已渲染用户消息）
        // 且还有更早的历史未加载 → 加载一批后同步递归重试
        if (
            direction === 'prev' &&
            (!target || target === userMessages[0]) &&
            this._hasOlderHistory() &&
            this._loadOlderHistoryBatch()
        ) {
            this._scrollToUserMessage(direction);
            return;
        }

        if (!target) return;

        const targetRect = target.getBoundingClientRect();
        const scrollDelta = targetRect.top - containerRect.top - 20;
        this.setAutoScrollingToBottom(false);
        container.scrollTo({
            top: container.scrollTop + scrollDelta,
            behavior: 'smooth'
        });
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

    openChatFind() {
        this._chatFind?.show();
    }

    _handleGoalMessageAnchor = (event) => {
        this._goalController.handleMessageAnchor(event);
    };

    async reload() {
        const compactRevision = this._compactProgressRevision || 0;
        this._assistantProgressBuffer.clear();
        // 丢弃上一任务/上一轮的测速状态与估算基线，避免 reload 后旧消息的
        // 累计词数/速度样本串到新流式消息上；baseline 随后由 reload 从历史
        // usage 重新恢复（单调门只约束同一任务内的连续流式帧）
        this._speedMessageState = null;
        this._speedPartState = null;
        this._contextUsageBaseline = null;
        this._reloading = true;
        const version = ++this._reloadVersion;
        // 加载期间锁定输入框（与 finally 中的解锁成对）：
        // 1) 确保 taskId 赋值（草稿恢复）必然发生在用户输入之前，消除恢复竞态；
        // 2) 加载中的 task_status 等状态尚未就绪，此时也不应允许编辑/发送。
        this.querySelector(`#task-${this.task_id}-input`)?.setTaskLoading?.(true);
        let shouldAutoSendQueuedMessage = false;
        try {
            const task_state = await window.taskManagerAPI.getFullTask(this.task_id);
            // 如果在 await 期间有更新的 reload() 被触发，丢弃本次操作
            if (version !== this._reloadVersion) return;

            const previousStatus = this.task_status;
            this.task_status = task_state.task_status || 'waiting';
            if (this.task_status === 'running') {
                this._cancelBrowserIdleTimer();
            }
            if (previousStatus !== this.task_status || this.isEmbedded) {
                this.emitTaskStatusChanged(this.task_status);
            }
            this._syncArtifactsTaskStatus();
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
            this._assistantPartsByMessage.clear();
            this._assistantRenderStateByMessage.clear();
            this._assistantDisclosureStateByMessage.clear();

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
                // 任务工作空间加载完成后同步刷新右边栏，避免首次打开时显示全局工作空间
                if (artifacts && typeof artifacts.refreshWorkspace === 'function') {
                    artifacts.refreshWorkspace(this._taskWorkspace);
                }
            }

            const input_widget = this.querySelector(`#task-${this.task_id}-input`);
            if (input_widget) {
                input_widget.taskId = this.task_id;
                this._syncInputTaskWorkspace();
                if (task_state.model) {
                    input_widget.setModel(task_state.model);
                }
                if (task_state.reasoningEffort !== undefined) {
                    input_widget.setReasoningEffort(task_state.reasoningEffort);
                } else {
                    // 任务没有显式设置推理模式时，重置为模型默认值，防止跨任务泄漏
                    const modelAlias = task_state.model || input_widget.selectedModel;
                    const model = input_widget.availableModels.find((m) => m.alias === modelAlias);
                    input_widget.setReasoningEffort(model?.reasoning_effort);
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
            // 重载后先恢复流式估算的 usage 基线，再渲染消息列表
            if (usageAssistantIdx >= 0) {
                this._rememberContextUsage(messages[usageAssistantIdx].usage);
            }
            const isWaitingForAssistant = TaskView.isWaitingForAssistantReply(
                this.task_status,
                this._currentGoal,
                messages
            );
            const isWaitingForGoalEditAssistant =
                this.task_status === 'running' &&
                this._currentGoal?.status === 'active' &&
                TaskView.hasGoalEditReminderAfterLatestAssistant(messages);
            this._renderInitialHistoryWindow(messages, {
                goal: task_state.goal,
                goalFinalSnapshots: task_state.goal_final_snapshots,
                usageAssistantIdx
            });
            if (isWaitingForGoalEditAssistant) {
                this._showWaitingAssistantPlaceholder({ force: true });
            } else if (isWaitingForAssistant) {
                this._showWaitingAssistantPlaceholder();
            }

            this.handleCompactProgress(
                compactRevision === (this._compactProgressRevision || 0)
                    ? task_state.compact_progress
                    : this._latestCompactProgress
            );
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
        } catch (error) {
            if (error.code === 'TASK_CORRUPTED') {
                await showConfirmModal({
                    icon: 'fa-circle-exclamation',
                    iconBg: '#FEF2F2',
                    iconColor: '#DC2626',
                    title: taskViewT('task.corrupted.title'),
                    message: taskViewT('renderer.task.corrupted.message'),
                    confirmText: taskViewT('task.corrupted.acknowledge'),
                    cancelText: null
                });
                if (window.globalControlAPI) {
                    window.globalControlAPI.removeTaskViewCache(this.task_id);
                    window.globalControlAPI.openTask(null);
                }
                return;
            }
            throw error;
        } finally {
            // 只有最新的 reload 才能重置标志，避免过期 reload 提前解除守卫
            if (version === this._reloadVersion) {
                this._reloading = false;
                this.querySelector(`#task-${this.task_id}-input`)?.setTaskLoading?.(false);
                this._flushDeferredTaskUpdates();
                if (shouldAutoSendQueuedMessage) {
                    this._autoSendQueueMessages();
                }
            }
            // 首屏内容就绪信号：供外层（openTask）的加载占位淡出使用。
            // 放在 finally 以覆盖任务损坏、加载异常等提前返回路径；元素已
            // 被移除时 disconnectedCallback 会递增版本号，同样要派发，否则
            // 占位会一直挂到 openTask 侧的超时兜底才消失。
            if (version === this._reloadVersion || !this.isConnected) {
                this.dispatchEvent(new CustomEvent('task-view-content-ready'));
            }
        }
    }

    _renderUserProgress(progress, history_container) {
        // 新用户消息 = 新回合开始信号：旧回合可能因插队/直接提交被新 turn 取代，
        // 后端不会发送 stopped 订阅反馈（_turnRunning=true 时中断不发送、旧 turn
        // 收尾时 _turnGeneration 已递增而跳过 feedback），这里兜底结束所有活跃
        // reasoning 块的计时，避免新旧思考块同时活跃同时计时。幂等，重复调用无副作用。
        this._cleanupStreamingState();
        // 上一回合的 usage 胶囊挂在旧 assistant 消息上，新回合开始后不应继续残留
        // （尤其模型跳过文本直接进工具调用时，旧胶囊会一直挂到新回合结束）
        history_container.querySelectorAll('.message-usage').forEach((el) => el.remove());
        const isGoalEditReminder = isGoalEditReminderMessage(progress);
        this._consumeGoalEditReminder(progress);
        const parts = getRenderableUserParts(progress, progress.last_part ? [progress.last_part] : []);
        if (!shouldRenderUserHistoryMessage(progress) || parts.length === 0) {
            if (
                isGoalEditReminder &&
                TaskView.canShowWaitingAssistantPlaceholder(progress.task_status, this._currentGoal)
            ) {
                this._showWaitingAssistantPlaceholder({ force: true });
            }
            return false;
        }
        this.removePendingGoalSupplementForIds(getGoalSupplementIds(progress));

        const renderedSet = getRenderedUserPartSet(this._renderedUserParts, progress.message_id);
        const partIndex = getProgressPartIndex(progress);
        if (renderedSet.has(partIndex)) return false;
        renderedSet.add(partIndex);
        this._syncUserMessageToHistory(progress, parts, partIndex);

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
            const metaRowHtml = TaskView.buildMsgMetaRow('user', progress.timestamp, progress.message_id);
            if (metaRowHtml) container.insertAdjacentHTML('beforeend', metaRowHtml);
        }
        relocateGoalEvaluationsToMessage(history_container, progress.message_id);
        if (TaskView.canShowWaitingAssistantPlaceholder(progress.task_status, this._currentGoal)) {
            // force：新用户消息刚上屏时 assistant 回复必然未开始，但上一回合的输出
            // 在 DOM 中仍位于这条新消息之前（本轮 assistant progress 尚未到达），
            // 非 force 分支的 hasAssistantOutputAfterLatestUser 会因旧输出误判
            // "已在回复中"而跳过占位，造成发送后无占位/胶囊的真空
            this._showWaitingAssistantPlaceholder({ force: true });
        }
        return true;
    }

    _consumeGoalEditReminder(progress) {
        return this._goalController.consumeGoalEditReminder(progress);
    }

    /** 渲染目标评估进度和结果。 */
    _renderGoalEvalProgress(progress) {
        return renderGoalEvaluationProgress(this, progress, taskViewT);
    }

    _findActiveGoalEvalProgress(progress) {
        return findActiveGoalEvalProgress(this.getHistoryContainer(), progress);
    }

    _syncArtifactsGoalEvalProgress(progress, options = {}) {
        return this._goalController.syncArtifactsGoalEvalProgress(progress, options);
    }

    _handleGoalEvalProgress(progress, options = {}) {
        return this._goalController.handleGoalEvalProgress(progress, options);
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

    /** 记录任务内最近一次真实 usage（输入/总计），作为后续流式估算「总计/上下文占比」的输入侧基线。
     *  只接受单调增长的有效值：部分 provider 流中每帧携带上一请求的遗留 usage，
     *  若允许回退覆盖，新回合的估算基线会被旧值拖小，总计/占比出现锯齿。 */
    _rememberContextUsage(usage) {
        const tokens = TaskView.getUsageDisplayTokens(usage);
        if (tokens.totalTokens <= 0) return;
        const current = this._contextUsageBaseline;
        if (current && tokens.totalTokens < current.t) return;
        this._contextUsageBaseline = { p: tokens.promptTokens, t: tokens.totalTokens };
    }

    _updateLastUsageRatio() {
        const lastUsage = this.getHistoryContainer().querySelector('.message-usage');
        if (!lastUsage) return;
        const completionTokens = parseInt(lastUsage.dataset.completionTokens || '0', 10);
        const totalTokens = parseInt(lastUsage.dataset.totalTokens || '0', 10);
        const textEl = lastUsage.querySelector('.usage-text');
        if (textEl) {
            const speedValue = lastUsage.dataset.speedValue || '';
            textEl.textContent = TaskView.formatUsageDisplayText(
                completionTokens,
                totalTokens,
                this._modelContextSize,
                speedValue ? taskViewT('renderer.taskview.usage.speed', { speed: speedValue }) : ''
            );
        }
    }

    /**
     * 实时统计当前流式输出的 token 速度与消息级估算 token 数。
     * 返回 null（非生成 part，如工具调用）或：
     * - speed: 最近滑动窗口的 decode 速度（token/s），窗口数据不足时为 null（胶囊保持上次速度）；
     * - estPrompt/estCompletion/estTotal: 无真实 usage 时的临时估算值
     *   （输入侧以任务内最近一次真实 usage 为基线，输出侧按 CJK 加权估算），
     *   usage 到达后调用方直接显示真实 usage，无需估算。
     *
     * 规则：
     * - 速度基于消息级 token 序列的滑动窗口（SPEED_WINDOW_MS），与 part 锚点时间解耦：
     *   part 切换、工具插入、锚点重建都不会造成速度断供；样本间隔超过
     *   SPEED_WINDOW_MAX_GAP_MS 视为 decode 断流，窗口从断点重算，速度始终反映最新输出；
     * - token 序列取 max(CJK 加权估算, 真实 usage + 校准偏移)：usage 首达时校准偏移使
     *   序列平滑切换不跳变；usage 停更时估算继续推进序列，速度不中断；
     * - 「已输出/总计」估算按消息内累计的加权 token 计算（跨 part、跨工具间隙保留），
     *   真实 usage 到达后校正为 usage 值，并作为后续估算的基线。
     */
    _trackOutputSpeed(progress) {
        const partType = progress?.last_part?.type;
        if (partType !== 'reasoning' && partType !== 'text') {
            // 工具等非生成 part：chars 基线锚点清零（词数/总计保持原状），消息级累计保留。
            // 速度返回实例级缓存的最近测速值（用户要求工具执行期持续可见最近 decode 数据）
            this._speedPartState = null;
            const cached = TaskView.getRecentSpeed(this.task_id);
            // est 置 null：工具帧无输出估算，渲染侧保持上一词数/总计状态
            return {
                speed: cached?.speed ?? null,
                speedEstimated: cached != null,
                estPrompt: null,
                estCompletion: null,
                estTotal: null
            };
        }
        const messageId = String(progress.message_id ?? '');
        // 流式 DTO 中思考文本在 text 字段（serializeStreamingAssistantPart 删除 rendered 后
        // 以 text 承载 content 拷贝，ReasoningMessagePart.toRenderJSON 不含 content 字段）；
        // content ?? text 与渲染层其余读取点口径一致
        const partText =
            partType === 'reasoning'
                ? String(progress.last_part.content ?? progress.last_part.text ?? '')
                : String(progress.last_part.text ?? '');
        const usageTokens = TaskView.getUsageDisplayTokens(progress.usage);
        const hasUsage = usageTokens.completionTokens > 0 || usageTokens.totalTokens > 0;

        // 消息级累计状态：新消息时重建
        let msg = this._speedMessageState;
        if (!msg || msg.messageId !== messageId) {
            msg = this._speedMessageState = {
                messageId,
                messageTokens: 0,
                messageUsage: null,
                messageTokensAtUsage: 0,
                usageOffset: null,
                samples: []
            };
        }

        // part 级锚点：key 变化（新消息 / 新 part / 工具后首个生成 part）时切换 token 基线。
        // 同类型且文本量不小于上一锚点（流式快照为全量累积）视为同一 part 的重复锚定
        // （如 progress 缺失 last_part_index 回退 0），继承基线与扫描缓存避免重复计入
        const key = `${messageId}:${getProgressPartIndex(progress)}:${partType}`;
        let part = this._speedPartState;
        if (!part || part.key !== key) {
            const isSamePartReanchored =
                part !== null && part.key.endsWith(`:${partType}`) && partText.length >= part.scanCounted;
            part = this._speedPartState = isSamePartReanchored
                ? {
                      key,
                      partTokens: part.partTokens,
                      baseMessageTokens: part.baseMessageTokens,
                      scanCounted: part.scanCounted,
                      scanTokens: part.scanTokens
                  }
                : { key, partTokens: 0, baseMessageTokens: msg.messageTokens, scanCounted: 0, scanTokens: 0 };
        }

        // 增量扫描：流式快照只追加不收缩，每帧仅统计新增尾巴的加权 token；
        // 文本变短（异常快照）时退回全量重扫
        if (partText.length < part.scanCounted) {
            part.scanCounted = 0;
            part.scanTokens = 0;
        }
        for (let i = part.scanCounted; i < partText.length; i++) {
            part.scanTokens += TaskView.isCjkCharCode(partText.charCodeAt(i))
                ? TaskView.CJK_TOKEN_WEIGHT
                : TaskView.OTHER_TOKEN_WEIGHT;
        }
        part.scanCounted = partText.length;
        part.partTokens = part.scanTokens;
        msg.messageTokens = part.baseMessageTokens + part.partTokens;

        if (hasUsage) {
            // usage 是检查点语义：仅在数值变化（新请求完成 / provider 流式推进）时
            // 重校偏移并推进估算基线。部分 provider（volcengine 系等）流中每帧携带
            // 上一请求的遗留 usage 且数值不变——若每帧都重置基线，delta 恒为 0，
            // 词数会冻结在 usage 遗留值上（真实输出全靠估算增量体现）。
            if (msg.messageUsage === null || usageTokens.completionTokens !== msg.messageUsage.c) {
                msg.usageOffset = msg.messageTokens - usageTokens.completionTokens;
                msg.messageTokensAtUsage = msg.messageTokens;
            }
            msg.messageUsage = {
                p: usageTokens.promptTokens,
                c: usageTokens.completionTokens,
                t: usageTokens.totalTokens
            };
        }

        // token 累计序列：有 usage 时优先真实值（+ 校准偏移），否则按加权估算；
        // 取 max 保证 usage 停更时序列仍随输出推进。
        // 注：usageOffset 校准使 c + offset === messageTokens 恒成立，序列实际始终
        // 由 CJK 加权估算驱动（token 级真实值 provider 不逐帧提供），因此测速口径为估算，
        // 渲染侧统一加 ≈ 标记
        const seq = msg.messageUsage
            ? Math.max(msg.messageTokens, msg.messageUsage.c + msg.usageOffset)
            : msg.messageTokens;

        // 滑动窗口测速：从最新样本向前回溯，窗口超出时长或样本间隔超阈值（断流）即止。
        // seq 为 0 的样本（part 已创建但还没有任何输出的空占位快照）不入队，
        // 避免把首 token 时延（等待首个非空输出的时间）摊进 decode 速度
        const now = Date.now();
        const samples = msg.samples;
        if (seq > 0) {
            samples.push({ t: now, seq });
            if (samples.length > TaskView.SPEED_WINDOW_MAX_SAMPLES) {
                samples.splice(0, samples.length - TaskView.SPEED_WINDOW_MAX_SAMPLES);
            }
        }
        let speed = null;
        if (samples.length > 0) {
            let start = samples.length - 1;
            while (
                start > 0 &&
                now - samples[start - 1].t <= TaskView.SPEED_WINDOW_MS &&
                samples[start].t - samples[start - 1].t <= TaskView.SPEED_WINDOW_MAX_GAP_MS
            ) {
                start--;
            }
            const spanMs = now - samples[start].t;
            if (spanMs >= TaskView.SPEED_MIN_SPAN_MS) {
                const value = Math.round((seq - samples[start].seq) / (spanMs / 1000));
                if (Number.isFinite(value) && value > 0) {
                    speed = value;
                }
            }
        }

        // 消息级估算：usage 检查点流（检查点值 + 之后增量）为主，
        // 无 usage 时退化为纯估算（上一请求基线 + 本消息输出）
        const baseline = this._contextUsageBaseline;
        let estPrompt = 0;
        let estCompletion;
        let estTotal;
        if (msg.messageUsage) {
            const delta = Math.max(0, Math.round(msg.messageTokens - msg.messageTokensAtUsage));
            estPrompt = msg.messageUsage.p;
            estCompletion = msg.messageUsage.c + delta;
            estTotal = msg.messageUsage.t + delta;
        } else {
            // 尚无真实 usage：以上一条消息的真实 usage（最近一次请求的输入+输出）为基线，
            // 叠加本消息的输出估算，保证「总计/上下文占比」在流式期间不跌回 0.0%。
            // 基线缺失（任务首轮请求）时上下文本身还很小，退化为仅输出估算。
            estPrompt = baseline ? baseline.p : 0;
            estCompletion = Math.round(msg.messageTokens);
            estTotal = (baseline ? baseline.t : 0) + estCompletion;
        }
        // 写入实例级缓存：任务切换 / reload 重建后最近测速仍可回读（实例存续期内不持久化）
        TaskView.rememberRecentSpeed(this.task_id, { speed, estimated: true, messageId });
        return { speed, speedEstimated: speed != null, estPrompt, estCompletion, estTotal };
    }

    /**
     * 从消息级测速状态计算胶囊展示 token（与 _trackOutputSpeed 的估算口径一致：
     * usage 检查点值 + 之后增量）。用于 replace 等不经流式测速的重建路径，
     * 避免请求开始的 prompt 检查点 usage（completion=0）把已涨起来的词数清零。
     * 返回 null 表示无测速状态可依据。
     */
    _computeDisplayTokensFromState() {
        const msg = this._speedMessageState;
        if (!msg) return null;
        const baseline = this._contextUsageBaseline;
        const roundedTokens = Math.round(msg.messageTokens);
        if (msg.messageUsage) {
            const delta = Math.max(0, Math.round(msg.messageTokens - msg.messageTokensAtUsage));
            return {
                prompt: msg.messageUsage.p,
                completion: msg.messageUsage.c + delta,
                total: msg.messageUsage.t + delta
            };
        }
        return {
            prompt: baseline ? baseline.p : 0,
            completion: roundedTokens,
            total: (baseline ? baseline.t : 0) + roundedTokens
        };
    }

    static renderCompactBoundary(message = {}) {
        return `
        <div class="od-compact-boundary flex items-center gap-1.5 my-4 mx-2 text-xs text-gray-400 select-none">
            <i class="fa-solid fa-compress" aria-hidden="true"></i>
            <span>${escapeHtml(taskViewT(message.trigger === 'auto' ? 'compact.boundary.autoDone' : 'compact.boundary.done'))}</span>
        </div>`;
    }

    _getAssistantCompactBoundary(messageId) {
        return (this._historyMessages || []).find(
            (message) =>
                TaskView.isCompactBoundaryMessage(message) &&
                message.kept_anchor_message_id === messageId &&
                Number.isInteger(message.kept_anchor_start_part_index) &&
                message.kept_anchor_start_part_index >= 0
        );
    }

    _placeAssistantCompactBoundary(messageId, content) {
        const boundary = this._getAssistantCompactBoundary(messageId);
        if (!boundary || !content) return false;
        content.querySelectorAll('.od-compact-boundary').forEach((element) => element.remove());
        const index = boundary.kept_anchor_start_part_index;
        const html = TaskView.renderCompactBoundary(boundary);
        const target = Array.from(content.querySelectorAll('[data-output-part-index]')).find(
            (element) => Number(element.dataset.outputPartIndex) >= index
        );
        if (target) target.insertAdjacentHTML('beforebegin', html);
        else (content.querySelector('.od-assistant-output-flow') || content).insertAdjacentHTML('beforeend', html);
        return true;
    }

    handleCompactProgress(progress) {
        const existing = this.querySelector('.od-compact-progress');
        if (progress?.phase === 'start') {
            this._removeWaitingAssistantPlaceholder();
            if (!existing) {
                this.getHistoryContainer().insertAdjacentHTML(
                    'beforeend',
                    `
                    <div class="od-compact-progress flex items-center gap-2 my-4 mx-2 text-xs text-gray-400" role="status" aria-live="polite">
                        <i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
                        <span>${escapeHtml(taskViewT('compact.boundary.loading'))}</span>
                    </div>`
                );
                this.tryScrollToEnd();
            }
            return;
        }
        existing?.remove();
        if (!progress?.compacted || !progress.boundary) return;

        // Keep lazy history in sync without reloading over an active response stream.
        const oldMessages = this._historyMessages || [];
        const oldStart = this._historyRenderStartIndex || 0;
        let start = oldStart - oldMessages.slice(0, oldStart).filter(TaskView.isCompactBoundaryMessage).length;
        const messages = oldMessages.filter((message) => !TaskView.isCompactBoundaryMessage(message));
        const anchorIndex = messages.findIndex((message) => message.message_id === progress.before_message_id);
        const insertIndex = anchorIndex < 0 ? messages.length : anchorIndex;
        messages.splice(insertIndex, 0, progress.boundary);
        this._historyMessages = messages;
        if (insertIndex < start) start++;
        this._historyRenderStartIndex = start;
        this.querySelectorAll('.od-compact-boundary').forEach((element) => element.remove());
        if (insertIndex < start) return;
        const anchorElement = progress.before_message_id
            ? Array.from(this.getHistoryContainer().querySelectorAll('[id]')).find(
                  (element) =>
                      element.id === `user-msg-${progress.before_message_id}` ||
                      element.id === `message-container-${progress.before_message_id}`
              )
            : null;
        const anchor = anchorElement?.closest('.od-assistant-msg-container') || anchorElement;
        if (
            this._placeAssistantCompactBoundary(
                progress.boundary.kept_anchor_message_id,
                anchorElement?.querySelector('[id^="message-content-"]')
            )
        )
            return;
        const html = TaskView.renderCompactBoundary(progress.boundary);
        if (anchor) anchor.insertAdjacentHTML('beforebegin', html);
        else this.getHistoryContainer().insertAdjacentHTML('beforeend', html);
    }

    _hasActiveGoal() {
        return this._goalController.hasActiveGoal();
    }

    _isTaskInputRunning() {
        const inputWidget = this.querySelector(`#task-${this.task_id}-input`);
        return this.task_status === 'running' || inputWidget?.isRunning === true;
    }

    _syncArtifactsGoalState(goal, options = {}) {
        return this._goalController.syncArtifactsGoalState(goal, options);
    }

    _syncArtifactsTaskStatus() {
        const artifacts = this._getRightSidebarEl();
        if (artifacts && typeof artifacts.setTaskRunning === 'function') {
            artifacts.setTaskRunning(this.task_status === 'running');
        }
    }

    _syncArtifactsTaskTodos(todos, options = {}) {
        const artifacts = this._getRightSidebarEl();
        if (!artifacts || typeof artifacts.setTaskTodos !== 'function') return false;
        const hadGoalSuggestion = typeof artifacts.hasGoalSuggestion === 'function' && artifacts.hasGoalSuggestion();
        artifacts.setTaskTodos(todos, { source: options.source });
        const hasGoalSuggestion = typeof artifacts.hasGoalSuggestion === 'function' && artifacts.hasGoalSuggestion();
        const revealedGoalSuggestion = !hadGoalSuggestion && hasGoalSuggestion;
        if (options.autoExpandForGoalSuggestion && revealedGoalSuggestion) {
            this._ensureRightSidebarOpen();
        }
        return revealedGoalSuggestion;
    }

    async _refreshGoalSummary() {
        return this._goalController.refreshGoalSummary();
    }

    async _isActiveGoalRunningNow() {
        return this._goalController.isActiveGoalRunningNow();
    }

    async _handleActiveGoalInput(detail, options = {}) {
        return this._goalController.handleActiveGoalInput(detail, options);
    }

    async _handleRunningGoalInput(detail, options = {}) {
        return this._goalController.handleRunningGoalInput(detail, options);
    }

    async _submitGoalSupplement(detail) {
        return this._goalController.submitGoalSupplement(detail);
    }

    /**
     * 节流刷新 goal 面板（0.5s 一次）。
     * 在 subscribeTaskUpdate 回调中调用，让 token 进度条实时推进。
     * 不依赖 progress.usage：很多 provider 流式过程中不返回 usage。
     */
    _scheduleGoalRefresh() {
        return this._goalController.scheduleGoalRefresh();
    }

    _syncGoalLiveRefresh() {
        return this._goalController.syncGoalLiveRefresh();
    }

    async _doGoalRefresh() {
        return this._goalController.doGoalRefresh();
    }

    async _pauseActiveGoal() {
        return this._goalController.pauseActiveGoal();
    }

    async _stopActiveGoal() {
        return this._goalController.stopActiveGoal();
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
                            const stopped = await this._stopActiveGoal();
                            if (!stopped) {
                                return;
                            }
                        } else {
                            await window.taskManagerAPI.stopTask(this.task_id);
                        }
                        this.task_status = 'stopped';
                        this.emitTaskStatusChanged(this.task_status);
                        // 手动停止后立即结束所有活跃 reasoning 块的计时并清理流式状态，
                        // 避免因后端 _turnRunning=true 时延迟发送的 sendSubscriptionFeedback
                        // 被 _handleTaskStatusUpdate 跳过（前端 status 已为 'stopped'）
                        // 而导致计时器永久运行。
                        this._cleanupStreamingState();
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

    /** 将队列消息移动到指定位置，后续自动发送沿用此顺序。 */
    reorderMessageQueue(id, targetIndex) {
        const index = this.messageQueue.findIndex((item) => item.id === id);
        if (
            index < 0 ||
            !Number.isInteger(targetIndex) ||
            targetIndex < 0 ||
            targetIndex >= this.messageQueue.length ||
            index === targetIndex
        )
            return;
        const [item] = this.messageQueue.splice(index, 1);
        this.messageQueue.splice(targetIndex, 0, item);
        this._updateMessageQueuePanel();
    }

    /**
     * 结束所有活跃 reasoning 块的计时并清理流式残留状态
     * （等待占位、usage spinner、流式光标、最后一条 assistant 消息的元信息行）。
     * 用于任务手动停止、插队中断、流式结束等任何"当前回合终止"的场景：
     * 后端在 _turnRunning=true 时被中断（如 interruptForNewMessage）不会发送
     * stopped 订阅反馈，前端状态可能一直停留在 running，导致 4065 的流式
     * 结束分支被 _handleTaskStatusUpdate 短路跳过、活跃 reasoning 块永不 finalize。
     */
    _cleanupStreamingState(timestamp = Date.now()) {
        this._assistantProgressBuffer.flush();
        const historyContainer = this.getHistoryContainer();
        if (!historyContainer) return;
        // 完成所有活跃 reasoning 块的计时（清除每秒计时器、定格耗时）
        historyContainer
            .querySelectorAll('.reasoning-block-od.reasoning-active')
            .forEach((el) => TaskView.finalizeReasoningBlock(el));
        // 移除等待占位和 spinner
        const waitingPlaceholder = historyContainer.querySelector('.waiting-usage-placeholder');
        if (waitingPlaceholder) waitingPlaceholder.remove();
        historyContainer.querySelectorAll('.usage-spinner').forEach((el) => {
            el.style.display = 'none';
        });
        // 移除流式光标
        historyContainer.querySelectorAll('.stream-cursor').forEach((el) => el.remove());
        // 为最后一条 assistant 消息追加时间戳与 hover 菜单
        const assistantContainers = historyContainer.querySelectorAll('.od-assistant-msg-container');
        const lastAssistantWrapper = assistantContainers[assistantContainers.length - 1];
        if (lastAssistantWrapper) {
            const msgContainer = lastAssistantWrapper.querySelector('[id^="message-container-"]');
            if (msgContainer && !msgContainer.querySelector('.od-msg-meta-row')) {
                const msgId = msgContainer.id.replace('message-container-', '');
                const metaRowHtml = TaskView.buildMsgMetaRow('assistant', timestamp, msgId);
                if (metaRowHtml) {
                    const usageEl = msgContainer.querySelector('.message-usage');
                    if (usageEl) {
                        usageEl.insertAdjacentHTML('beforebegin', metaRowHtml);
                    } else {
                        msgContainer.insertAdjacentHTML('beforeend', metaRowHtml);
                    }
                }
            }
        }
    }

    /**
     * 立即发送队列中的消息（中断当前任务，正在执行的子任务转为后台继续运行）
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

        // 立即锁定并滚动到底部，及时展示即将发出的新消息
        this.forceScrollToEnd();

        // 中断当前任务（不停止正在运行的子任务，子任务转为后台执行）
        if (this.task_status === 'running') {
            try {
                await window.taskManagerAPI.interruptForNewMessage(this.task_id);
            } catch (error) {
                console.error('Failed to interrupt task for queue message:', error);
                this._immediateQueueSending = false;
                return;
            }
            // 插队中断后立即结束旧回合的思考计时：后端在 _turnRunning=true 时
            // 不会发送 stopped 订阅反馈，旧 turn 收尾时又因 _turnGeneration 已被
            // 新 turn 取代而跳过 sendSubscriptionFeedback，前端 task_status 始终
            // 为 running，流式结束分支不会触发，活跃 reasoning 块会一直计时。
            // 手动停止（2338）已做同样处理，这里补上插队场景。
            this._cleanupStreamingState();
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
                inputWidget.addImage(dataUrl, taskViewT('renderer.taskview.imageLabel', { index: idx + 1 }));
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
        this.emitTaskStatusChanged(this.task_status);
        this._syncArtifactsTaskStatus();
        this._cancelBrowserIdleTimer();
        this.updateStopButtonVisibility();

        // 与手动发送路径一致：立即显示等待占位（含上下文胶囊），
        // 消除 submitMessage 往返与首个 progress 之间的统计真空。
        // 隐藏视图（historyContainer 为 null）下 DOM 操作无意义，跳过
        if (this.getHistoryContainer()) {
            this._showWaitingAssistantPlaceholder({ force: true });
        }

        // 自动发出队列消息前锁定并滚动到底部，及时展示新消息
        this.forceScrollToEnd();

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
                this.emitTaskStatusChanged(this.task_status);
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
        this.emitTaskStatusChanged(this.task_status);
        this._syncArtifactsTaskStatus();
        this.updateStopButtonVisibility();

        if (this.task_status === 'running') {
            this._cancelBrowserIdleTimer();
            return true;
        }

        if (wasRunning && !this._immediateQueueSending && !this._reloading) {
            this._autoSendQueueMessages();
        }

        if (this.task_status !== 'running') {
            if (this._pendingGoalEditMessage?.taskId === this.task_id) {
                this.removePendingGoalEditByGoalId(this._pendingGoalEditMessage.goalId);
            }
            this._startBrowserIdleTimer();
        }

        return true;
    }

    emitTaskStatusChanged(status) {
        // 流式期间禁用队列面板的 backdrop-filter：聊天区每帧重绘会让背景模糊持续
        // 重新光栅化，是 GPU 占用的重要来源（对应 CSS 见 task-view[streaming] 规则）。
        this.toggleAttribute('streaming', status === 'running');
        this.dispatchEvent(
            new CustomEvent('task-status-changed', {
                detail: {
                    taskId: this.task_id,
                    status
                },
                bubbles: true
            })
        );
    }

    _shouldSuppressIncrementalRender() {
        return this._reloading || this.style.display === 'none' || this.hasAttribute('data-background');
    }

    /** 窗口是否处于渲染冻结状态（最小化 / 被完全遮挡，任一信号源报告 hidden 即冻结）。 */
    _isWindowRenderFrozen() {
        return window.__isWindowVisible === false || document.visibilityState === 'hidden';
    }

    _deferTaskUpdateDuringReload(progress) {
        this._deferredTaskUpdates.push(progress);
    }

    _flushDeferredTaskUpdates() {
        if (
            this._reloading ||
            this.style.display === 'none' ||
            this.hasAttribute('data-background') ||
            typeof this._taskUpdateHandler !== 'function' ||
            this._deferredTaskUpdates.length === 0
        ) {
            return;
        }

        const updates = this._deferredTaskUpdates.drain();
        updates.forEach((progress) => this._taskUpdateHandler(progress));
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

    /**
     * 右侧面板在保证聊天区不小于 MIN_CHAT_AREA_WIDTH 的前提下可占用的最大像素宽度。
     * 容器尚未完成布局（宽度为 0）时返回 null，表示无法计算、不做限制。
     */
    _getMaxRightSidebarWidth() {
        const container = this.querySelector(`#task-${this.task_id}-content-row`);
        const containerWidth = container ? container.clientWidth : 0;
        if (!containerWidth) return null;
        return Math.max(0, containerWidth - MIN_CHAT_AREA_WIDTH - RIGHT_PANEL_RESIZER_WIDTH);
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
        // 展开过程中取消收起时排队的画中画显示，避免浮窗在展开态弹出
        this._cancelBrowserPipShowTimer();
        const targetWidth = this._workspaceFocusLayout.getTargetPanelWidth();
        this._restoreRightSidebarFromOffscreen(rightSidebar);
        rightSidebar.style.display = '';
        // 后台/隐藏任务跳过 width 0→targetWidth 的过渡动画，直接落到终态。
        // 动画会触发布局回流并通过共享合成影响其他可见任务窗口（界面向左平移）。
        const suppressAnimation = this._shouldSuppressIncrementalRender();
        if (suppressAnimation) {
            rightSidebar.style.width = targetWidth;
            rightSidebar.style.opacity = '1';
            rightSidebar.style.overflow = '';
            if (resizer) {
                resizer.style.display = '';
                resizer.style.opacity = '1';
            }
            this._rightSidebarExpanded = true;
            this._autoSwitchTabIfEmpty(rightSidebar);
            if (this._browserPip) {
                this._browserPip.hide();
            }
            return;
        }
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
        rightSidebar.style.width = targetWidth;
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
        rightSidebar.setWorkspaceSidebarVisible?.(false);
        // 收起侧边栏时退出放大布局，但保留用户当前选择的 Browser / Workspace tab。
        if (typeof rightSidebar.suspendPreviewLayout === 'function') {
            rightSidebar.suspendPreviewLayout();
        } else if (typeof rightSidebar.closeEditor === 'function') {
            rightSidebar.closeEditor();
        }

        // 聚焦布局使用临时百分比宽度，不能写回用户的固定侧边栏宽度。
        if (!this._workspaceFocusLayout.active) {
            const inlineWidth = rightSidebar.style.width.trim();
            const inlinePixelWidth = inlineWidth.endsWith('px') ? Number.parseFloat(inlineWidth) : 0;
            // 展开时写入的宽度可能已被聊天区最小宽度约束收窄，此时它不代表用户选择，
            // 不能写回 _rightSidebarWidth（否则窗口变宽后面板会停留在窄值上）。
            const maxWidth = this._getMaxRightSidebarWidth();
            if (maxWidth === null || inlinePixelWidth < maxWidth) {
                this._rightSidebarWidth = inlinePixelWidth || rightSidebar.offsetWidth || DEFAULT_RIGHT_SIDEBAR_WIDTH;
            }
        }
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
            // 收起动画结束、聊天区宽度已稳定，此时再显示浮窗
            this._cancelBrowserPipShowTimer();
            this._showBrowserPipIfNeeded();
        };
        rightSidebar.addEventListener('transitionend', onEnd);

        this._rightSidebarExpanded = false;

        // 侧边栏收起时重置画中画关闭状态（新的折叠周期，允许重新弹出）
        if (this._browserPip) {
            this._browserPip.resetClosed();
        }
        // 等收起动画结束、聊天区宽度稳定后再显示浮窗：
        // 动画期间按中间态算出的位置和大小都是错的
        this._scheduleBrowserPipShow();
    }

    /**
     * 收起动画结束后重新显示画中画浮窗。
     * 过渡事件不可靠（元素不可见、宽度未发生变化时不会触发），因此按动画时长兜底。
     */
    _scheduleBrowserPipShow() {
        this._cancelBrowserPipShowTimer();
        this._browserPipShowTimer = setTimeout(() => {
            this._browserPipShowTimer = null;
            // 动画期间又被展开：保持展开态，不弹浮窗
            if (this._rightSidebarExpanded) return;
            this._showBrowserPipIfNeeded();
        }, BROWSER_PIP_SHOW_FALLBACK_MS);
    }

    _cancelBrowserPipShowTimer() {
        if (this._browserPipShowTimer !== null) {
            clearTimeout(this._browserPipShowTimer);
            this._browserPipShowTimer = null;
        }
    }

    _autoSwitchTabIfEmpty(_sidebar) {
        // Tab visibility is now managed dynamically inside TaskArtifacts
    }

    /**
     * 初始化浏览器画中画浮窗。在 init() 渲染完成后调用。
     */
    _initBrowserPip() {
        // 浮窗挂在内容行上：默认位置要落到输入框上方，挂在聊天滚动区会被其 overflow:hidden 裁掉底部
        const contentRow = this.querySelector(`#task-${this.task_id}-content-row`);
        const host = contentRow || this.querySelector('#taskview-chat-history')?.parentElement;
        if (!host) return;

        this._browserPip = new BrowserPip(host, {
            onRestore: () => {
                if (this._browserPip) this._browserPip.hide();
                const sidebar = this._getRightSidebarEl();
                if (sidebar && typeof sidebar.forceBrowserActive === 'function') {
                    sidebar.forceBrowserActive();
                }
                this._forceExpandRightSidebar();
                this._updateSidebarToggleIcon(true);
            },
            getAnchorRect: () => {
                const input = this.querySelector(`#task-${this.task_id}-input`);
                const box = input?.querySelector('#agent-input-container') || input;
                if (!box) return null;
                const rect = box.getBoundingClientRect();
                return { top: rect.top, right: rect.right, width: rect.width };
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
            },
            // 浮窗可见时固定 webview 视口为 16:9（避免窄高容器把截图拉长），隐藏时恢复自适应
            onVisibilityChanged: (visible) => {
                const sidebar = this._getRightSidebarEl();
                if (sidebar && typeof sidebar.browserSetViewportFixed === 'function') {
                    sidebar.browserSetViewportFixed(visible);
                }
            }
        });
    }

    /**
     * 若侧边栏已收起、浏览器确有可展示的内容（非空白标签页）且浮窗未被手动关闭，则显示画中画浮窗。
     * 只剩 about:blank 标签页时（等同于没有标签页）不弹浮窗；已显示的浮窗也随之收起，
     * 避免浮窗只显示一个空白占位。
     */
    _showBrowserPipIfNeeded() {
        const sidebar = this._getRightSidebarEl();
        const hasContent = !!sidebar && typeof sidebar.hasBrowserContent === 'function' && sidebar.hasBrowserContent();
        if (!hasContent) {
            if (this._browserPip) {
                this._browserPip.hide();
            }
            return;
        }

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
            // 计时器可能来自上一轮任务。回调执行时必须重新确认当前状态，
            // 避免 reload 先观察到 running、后续同状态通知被短路时误销毁浏览器。
            if (this.task_status === 'running') return;
            const el = this._getRightSidebarEl();
            if (el && typeof el.isBrowserPresentedToUser === 'function' && el.isBrowserPresentedToUser()) {
                this._startBrowserIdleTimer();
                return;
            }
            if (el && typeof el.recycleBrowser === 'function') {
                el.recycleBrowser();
            } else if (el && typeof el.destroyBrowser === 'function') {
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
            // 只有空白标签页时等同于浏览器还没用起来：应展开侧边栏展示即将到来的内容，
            // 而不是留在折叠状态里靠画中画显示一个空白页。
            const browserInUse =
                sidebar && typeof sidebar.hasBrowserContent === 'function' && sidebar.hasBrowserContent();
            if (browserInUse) {
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
        const filePath = normalizeDriveRootPath(target.dataset.openEditor || '');
        if (!filePath) return;
        const lineAttr = target.dataset.editorLine;
        const line = lineAttr ? parseInt(lineAttr, 10) : undefined;
        const validLine = line === undefined || Number.isFinite(line) ? line : undefined;

        // 1. 展开侧边栏
        this._forceExpandRightSidebar();
        // 2. 在侧边栏编辑器中打开文件
        const sidebar = this._getRightSidebarEl();
        if (!sidebar) return;
        // md/markdown 文件默认以渲染预览模式打开，可通过预览头部按钮切换回编辑器
        const fileExt = filePath.split('.').pop()?.toLowerCase();
        if ((fileExt === 'md' || fileExt === 'markdown') && typeof sidebar.openFilePreview === 'function') {
            sidebar.openFilePreview(filePath);
            return;
        }
        if (typeof sidebar.openFileInEditor === 'function') {
            sidebar.openFileInEditor(filePath, validLine);
        }
    }

    /**
     * 处理聊天区域中 [data-open-file] 元素的点击事件。
     * 使用系统默认应用打开文件。
     */
    _handleOpenFileClick(e) {
        // 排除文件卡片菜单按钮的点击
        if (e.target.closest('.od-file-card-menu')) return;
        const target = e.target.closest('[data-open-file]');
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        const filePath = target.dataset.openFile;
        if (!filePath) return;
        window.fsAPI?.openPath?.(filePath);
    }

    async _handleSkillPillClick(e) {
        const target = e.target.closest('[data-skill-bundle][data-skill-name]');
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        const { skillBundle, skillName } = target.dataset;
        if (!skillBundle || !skillName || !window.applicationRegistryAPI?.callMainWorld) return;

        let detail;
        try {
            detail = await window.applicationRegistryAPI.callMainWorld(
                'skillmgr',
                'getSkillDetailForReference',
                skillBundle,
                skillName
            );
        } catch (error) {
            console.warn('Failed to load skill detail:', error);
            return;
        }
        if (!detail) return;

        this.querySelector('#taskview-skill-detail')?.remove();
        const card = document.createElement('skill-detail-card');
        card.id = 'taskview-skill-detail';
        card.dataset.theme = document.documentElement.dataset.theme || 'light';
        card.model = {
            id: detail.id,
            name: detail.name || skillName,
            closeLabel: taskViewT('renderer.taskview.skillTag.close'),
            description: detail.description,
            descriptionLabel: taskViewT('renderer.taskview.skillTag.description'),
            bodyHtml: detail.body ? renderSafeMarkdown(detail.body) : undefined,
            bodyLabel: taskViewT('renderer.taskview.skillTag.content'),
            metadata: [
                { label: taskViewT('renderer.taskview.skillTag.bundle'), value: skillBundle },
                ...(detail.directory
                    ? [{ label: taskViewT('renderer.taskview.skillTag.directory'), value: detail.directory }]
                    : [])
            ],
            metadataLabel: taskViewT('renderer.taskview.skillTag.metadata'),
            actions: [{ id: 'close', label: taskViewT('renderer.taskview.skillTag.close') }]
        };
        card.addEventListener('skill-detail-action', () => card.remove());
        this.appendChild(card);
    }

    /**
     * 处理聊天区域中 [data-open-preview] 元素的点击事件。
     * 展开侧边栏 → 切换到工作空间 tab → 在预览模式下打开文件。
     */
    _handlePreviewOpenClick(e) {
        const target = e.target.closest('[data-open-preview]');
        if (!target) return;
        // 排除 FileMessagePart 卡片的三点菜单按钮，避免与 _handleFileCardMenuClick 冲突
        if (e.target.closest('.od-file-card-menu')) return;
        e.preventDefault();
        e.stopPropagation();
        const filePath = target.dataset.openPreview;
        if (!filePath) return;

        const lineAttr = target.dataset.previewLine;
        const line = lineAttr ? parseInt(lineAttr, 10) : undefined;
        const validLine = line !== undefined && Number.isFinite(line) && line > 0 ? line : undefined;

        this.openFileInSidebar(filePath, validLine);
    }

    /**
     * 处理 file-pill 与 FileMessagePart 卡片的右键菜单事件。
     * 两者共用同一份菜单内容（预览 / 复制路径 / 默认打开 / 在文件夹显示），保证一致性。
     */
    _handleFilePillContextMenu(e) {
        const target = e.target.closest('.od-file-pill[data-open-preview], .od-file-card[data-open-preview]');
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        const filePath = target.dataset.openPreview;
        if (!filePath) return;
        this._openFileContextMenu(filePath, e.clientX, e.clientY);
    }

    /**
     * 处理 FileMessagePart 卡片右上角三点按钮的点击，复用与 file-pill 一致的右键菜单。
     */
    _handleFileCardMenuClick(e) {
        const btn = e.target.closest('.od-file-card-menu');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const card = btn.closest('.od-file-card[data-open-preview]');
        if (!card) return;
        const filePath = card.dataset.openPreview;
        if (!filePath) return;
        const rect = btn.getBoundingClientRect();
        // 菜单贴近按钮下方弹出
        this._openFileContextMenu(filePath, rect.left, rect.bottom);
    }

    /**
     * 弹出文件操作右键菜单（file-pill 与 FileMessagePart 卡片共用）。
     * @param {string} filePath 文件绝对路径
     * @param {number} x 菜单左上角 x 坐标
     * @param {number} y 菜单左上角 y 坐标
     */
    _openFileContextMenu(filePath, x, y) {
        this._dismissFilePillContextMenu();
        // 历史消息的 rendered HTML 可能仍存有 "/C:/..." 形式的路径，菜单全部动作统一使用规范化路径
        filePath = normalizeDriveRootPath(filePath);

        const dark =
            this.dataset.theme === 'dark' ||
            document.documentElement.dataset.theme === 'dark' ||
            document.body.dataset.theme === 'dark';
        const menu = document.createElement('div');
        menu.id = 'od-file-pill-ctx';
        menu.className = 'ctx-menu' + (dark ? ' ctx-menu-dark' : '');
        menu.style.minWidth = '180px';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        const items = [
            { action: 'preview', icon: FILE_TAG_PREVIEW_SVG, label: taskViewT('renderer.taskview.fileTag.preview') },
            { action: 'copy-path', icon: COPY_ICON_SVG, label: taskViewT('renderer.taskview.fileTag.copyPath') },
            {
                action: 'open-default',
                icon: FILE_TAG_OPEN_DEFAULT_SVG,
                label: taskViewT('renderer.taskview.fileTag.openDefault')
            },
            { action: 'reveal', icon: FILE_TAG_REVEAL_SVG, label: taskViewT('renderer.taskview.fileTag.reveal') }
        ];

        menu.innerHTML = items
            .map(
                (item) =>
                    `<button class="ctx-item" data-action="${item.action}">` +
                    `<span class="ctx-icon-sm">${item.icon}</span>` +
                    `<span class="ctx-label">${item.label}</span></button>`
            )
            .join('');

        document.body.appendChild(menu);

        requestAnimationFrame(() => {
            const margin = 8;
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth - margin) {
                menu.style.left = `${window.innerWidth - rect.width - margin}px`;
            }
            if (rect.bottom > window.innerHeight - margin) {
                menu.style.top = `${window.innerHeight - rect.height - margin}px`;
            }
        });

        menu.querySelector('[data-action="preview"]').addEventListener('click', () => {
            this._dismissFilePillContextMenu();
            this._forceExpandRightSidebar();
            const sidebar = this._getRightSidebarEl();
            if (sidebar && typeof sidebar.openFilePreview === 'function') {
                sidebar.openFilePreview(filePath);
            }
        });

        menu.querySelector('[data-action="copy-path"]').addEventListener('click', () => {
            this._dismissFilePillContextMenu();
            navigator.clipboard.writeText(filePath).catch(() => {});
        });

        menu.querySelector('[data-action="open-default"]').addEventListener('click', () => {
            this._dismissFilePillContextMenu();
            window.fsAPI?.openPath?.(filePath);
        });

        menu.querySelector('[data-action="reveal"]').addEventListener('click', () => {
            this._dismissFilePillContextMenu();
            window.fsAPI?.showItemInFolder?.(filePath);
        });

        this._filePillCtxDismissHandler = (ev) => {
            if (!menu.contains(ev.target)) {
                this._dismissFilePillContextMenu();
            }
        };
        document.addEventListener('mousedown', this._filePillCtxDismissHandler);
    }

    _dismissFilePillContextMenu() {
        document.getElementById('od-file-pill-ctx')?.remove();
        if (this._filePillCtxDismissHandler) {
            document.removeEventListener('mousedown', this._filePillCtxDismissHandler);
            this._filePillCtxDismissHandler = null;
        }
    }

    /**
     * 处理消息中 HTTP(S) 链接的右键菜单事件。
     */
    _handleLinkContextMenu(e) {
        const anchor = e.target.closest('a[href]');
        if (!anchor) return;
        const url = getSafeWebUrl(anchor.getAttribute('href'));
        if (!url) return;
        e.preventDefault();
        e.stopPropagation();
        this._openLinkContextMenu(url, e.clientX, e.clientY);
    }

    _openLinkContextMenu(url, x, y) {
        this._dismissLinkContextMenu();

        const items = createWebLinkContextMenuItems(
            url,
            {
                copyLink: taskViewT('renderer.taskview.linkTag.copyLink'),
                openExternal: taskViewT('renderer.taskview.linkTag.openExternal'),
                openInBrowser: taskViewT('renderer.taskview.linkTag.openInBrowser')
            },
            {
                copyLink: (linkUrl) => navigator.clipboard.writeText(linkUrl).catch(() => {}),
                openExternal: (linkUrl) => window.open(linkUrl, '_blank'),
                openInBrowser: (linkUrl) => this.openUrlInSidebar(linkUrl)
            }
        );
        if (items.length === 0) return;

        const dark =
            this.dataset.theme === 'dark' ||
            document.documentElement.dataset.theme === 'dark' ||
            document.body.dataset.theme === 'dark';
        const menu = document.createElement('div');
        menu.id = 'od-link-ctx';
        menu.className = 'ctx-menu' + (dark ? ' ctx-menu-dark' : '');
        menu.style.minWidth = '180px';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        const icons = {
            'copy-link': COPY_ICON_SVG,
            'open-external': FILE_TAG_OPEN_DEFAULT_SVG,
            'open-browser': FILE_TAG_PREVIEW_SVG
        };
        menu.innerHTML = items
            .map(
                (item) =>
                    `<button class="ctx-item" data-action="${item.action}">` +
                    `<span class="ctx-icon-sm">${icons[item.action]}</span>` +
                    `<span class="ctx-label">${escapeHtml(item.label)}</span></button>`
            )
            .join('');

        document.body.appendChild(menu);

        requestAnimationFrame(() => {
            const margin = 8;
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth - margin) {
                menu.style.left = `${window.innerWidth - rect.width - margin}px`;
            }
            if (rect.bottom > window.innerHeight - margin) {
                menu.style.top = `${window.innerHeight - rect.height - margin}px`;
            }
        });

        for (const item of items) {
            menu.querySelector(`[data-action="${item.action}"]`)?.addEventListener('click', () => {
                this._dismissLinkContextMenu();
                item.run();
            });
        }

        this._linkCtxDismissHandler = (event) => {
            if (!menu.contains(event.target)) this._dismissLinkContextMenu();
        };
        document.addEventListener('mousedown', this._linkCtxDismissHandler);
    }

    _dismissLinkContextMenu() {
        document.getElementById('od-link-ctx')?.remove();
        if (this._linkCtxDismissHandler) {
            document.removeEventListener('mousedown', this._linkCtxDismissHandler);
            this._linkCtxDismissHandler = null;
        }
    }

    _rerenderAssistantOutputsForModeChange() {
        const historyContainer = this.getHistoryContainer();
        const previousScrollTop = historyContainer?.scrollTop ?? 0;
        const wasAtBottom = historyContainer
            ? historyContainer.scrollHeight - historyContainer.scrollTop - historyContainer.clientHeight <= 24
            : false;

        const messageContents = Array.from(this.querySelectorAll('[id^="message-content-"]'));
        for (const messageContent of messageContents) {
            const messageId = messageContent.id.slice('message-content-'.length);
            const parts = this._assistantPartsByMessage.get(messageId);
            const renderState = this._assistantRenderStateByMessage.get(messageId);
            if (!Array.isArray(parts) || !renderState) continue;

            const disclosureState = this._assistantDisclosureStateByMessage.get(messageId) || new Map();
            for (const [key, expanded] of this._captureProcessDisclosureState(messageContent)) {
                disclosureState.set(key, expanded);
            }
            this._assistantDisclosureStateByMessage.set(messageId, disclosureState);
            const outputHtml = this._renderAssistantOutputHtml(parts, {
                isRunning: renderState.isRunning,
                messageId,
                disclosureState,
                turnDurationMs: renderState.turnDurationMs
            });
            if (messageContent.innerHTML !== outputHtml) {
                TaskView.morphDomChildren(messageContent, outputHtml);
            }
            enhanceCodeBlocks(messageContent);
            enhanceToolPreviewCards(messageContent);
            renderMermaidBlocks(messageContent);
            this._syncReasoningTimers(messageContent);
        }

        if (historyContainer) {
            historyContainer.scrollTop = wasAtBottom ? historyContainer.scrollHeight : previousScrollTop;
        }
    }

    _handleGuiDisplaySettingsChanged() {
        if (!this.isConnected || !this.task_id) return;
        this._rerenderAssistantOutputsForModeChange();
    }

    _handleProcessToggleClick(e) {
        if (e.target.closest('[data-open-preview]')) return;
        const completedToggle = e.target.closest('[data-completed-process-toggle]');
        if (completedToggle) {
            e.preventDefault();
            e.stopPropagation();
            const process = completedToggle.closest('.od-completed-process');
            if (!process) return;
            const expanded = completedToggle.getAttribute('aria-expanded') !== 'true';
            completedToggle.setAttribute('aria-expanded', String(expanded));
            process.classList.toggle('is-expanded', expanded);
            const detail = Array.from(process.children).find((child) =>
                child.classList.contains('od-completed-process-detail')
            );
            detail?.classList.toggle('is-open', expanded);
            return;
        }
        const runningToggle = e.target.closest('[data-running-output-toggle]');
        if (runningToggle) {
            e.preventDefault();
            e.stopPropagation();
            const messageId = runningToggle.dataset.messageId;
            const messageContent = messageId ? this.querySelector(`#message-content-${messageId}`) : null;
            if (!messageId || !messageContent) return;
            const expanded = runningToggle.getAttribute('aria-expanded') !== 'true';
            this._assistantRunningDetails.set(messageId, expanded);
            const parts = this._assistantPartsByMessage.get(messageId) || [];
            const disclosureState = this._captureProcessDisclosureState(messageContent);
            const outputHtml = this._renderAssistantOutputHtml(parts, {
                isRunning: true,
                messageId,
                disclosureState,
                showRunningDetails: expanded
            });
            if (messageContent.innerHTML !== outputHtml) {
                TaskView.morphDomChildren(messageContent, outputHtml);
            }
            enhanceCodeBlocks(messageContent);
            enhanceToolPreviewCards(messageContent);
            renderMermaidBlocks(messageContent, { defer: true });
            return;
        }
        const processToggle = e.target.closest('[data-process-toggle]');
        if (processToggle) {
            e.preventDefault();
            e.stopPropagation();
            const process = processToggle.closest('.od-process-segment');
            if (!process) return;
            const expanded = processToggle.getAttribute('aria-expanded') !== 'true';
            processToggle.setAttribute('aria-expanded', String(expanded));
            process.classList.toggle('is-expanded', expanded);
            const detail = Array.from(process.children).find((child) => child.classList.contains('od-process-detail'));
            detail?.classList.toggle('is-open', expanded);
            return;
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
     * 公开方法：在当前任务的右侧工作空间中打开文件。
     */
    async openFileInSidebar(filePath, line, onSwitchBlocked) {
        // 渲染阶段不校验文件存在性（允许路径样式文本的误报 pill），
        // 点击时在此处统一校验：不存在则弹模态提示，不再进入预览流程。
        // 历史消息的 rendered HTML 可能仍存有 "/C:/..." 形式的路径，入口统一规范化。
        filePath = normalizeDriveRootPath(filePath);
        try {
            const exists = await window.fsAPI?.fileExists?.(filePath);
            if (exists === false) {
                this._showFileMissingModal(filePath);
                return;
            }
        } catch {
            // 存在性校验失败时不阻塞打开，由后续打开流程自行处理
        }
        this._forceExpandRightSidebar();
        const sidebar = this._getRightSidebarEl();
        if (sidebar && typeof sidebar.openFilePreview === 'function') {
            sidebar.openFilePreview(filePath, line, onSwitchBlocked);
        }
    }

    /**
     * 文件不存在时的模态提示弹窗（简单展示类：遮罩点击可关闭）。
     */
    _showFileMissingModal(filePath) {
        document.getElementById('od-file-missing-modal')?.remove();
        const dark =
            this.dataset.theme === 'dark' ||
            document.documentElement.dataset.theme === 'dark' ||
            document.body.dataset.theme === 'dark';

        const overlay = document.createElement('div');
        ensureOverlayStyles();
        overlay.id = 'od-file-missing-modal';
        overlay.className = 'od-overlay fixed inset-0 z-[9999] flex items-center justify-center';
        overlay.innerHTML = `
            <div class="${dark ? 'bg-[#26262a] text-gray-100 ring-white/10' : 'bg-white text-gray-800 ring-black/10'} max-w-[460px] w-[88%] rounded-2xl p-5 shadow-2xl ring-1 flex flex-col gap-3">
                <div class="flex items-center gap-2">
                    <span class="text-red-500 flex-shrink-0">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                    </span>
                    <span class="font-semibold text-sm">${escapeHtml(taskViewT('renderer.taskview.file.missing.title'))}</span>
                </div>
                <div class="text-xs leading-relaxed ${dark ? 'text-gray-400' : 'text-gray-500'}">${escapeHtml(taskViewT('renderer.taskview.file.missing.hint'))}</div>
                <div class="text-xs font-mono break-all rounded-lg px-3 py-2 ${dark ? 'bg-white/5 text-gray-300' : 'bg-gray-50 text-gray-600'}">${escapeHtml(filePath)}</div>
                <div class="flex justify-end">
                    <button type="button" class="od-file-missing-close text-xs font-medium rounded-lg px-3.5 py-1.5 ${dark ? 'bg-white/10 hover:bg-white/15 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'} transition-colors">
                        ${escapeHtml(taskViewT('renderer.taskview.file.missing.close'))}
                    </button>
                </div>
            </div>`;

        const close = () => overlay.remove();
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
        overlay.querySelector('.od-file-missing-close')?.addEventListener('click', close);
        document.body.appendChild(overlay);
    }

    /**
     * 公开方法：在侧边栏内置浏览器中打开外部链接。
     * 从 renderer 全局链接拦截器调用，自动展开侧边栏并切换到浏览器 tab。
     */
    openUrlInSidebar(url) {
        this._forceExpandRightSidebar();
        const sidebar = this._getRightSidebarEl();
        if (sidebar && typeof sidebar.browserAddTab === 'function') {
            if (typeof sidebar.forceBrowserActive === 'function') {
                sidebar.forceBrowserActive();
            }
            sidebar.browserAddTab(url);
        }
    }

    _getDeepActiveElement() {
        let activeElement = document.activeElement;
        while (activeElement?.shadowRoot?.activeElement) {
            activeElement = activeElement.shadowRoot.activeElement;
        }
        return activeElement;
    }

    _isRightSidebarEditableFocused() {
        const sidebar = this._getRightSidebarEl();
        if (!sidebar) return false;

        const activeElement = this._getDeepActiveElement();
        if (!(activeElement instanceof HTMLElement)) return false;

        const activeInSidebar =
            activeElement === sidebar ||
            sidebar.contains(activeElement) ||
            Boolean(sidebar.shadowRoot?.contains(activeElement));
        if (!activeInSidebar) return false;

        return activeElement.matches('textarea, input, select, [contenteditable="true"]');
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
        el.setWorkspaceSidebarVisible?.(false);
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
        el.setWorkspaceSidebarVisible?.(true);
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
                        autoExpandForGoalSuggestion: true,
                        source: 'live-update'
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
        // 重连场景先退订上一次订阅：直接重置数组会把上一批句柄丢掉，句柄从此没人持有
        this._unsubscribeBrowserEvents();
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
                    // 等待期间视图可能已断开（此时 disconnectedCallback 已经跑过，数组都被置空）：
                    // 句柄自己退掉，不要挂到一个已经清理完的视图上
                    if (!this.isConnected) {
                        unsubscribe();
                        continue;
                    }
                    this._browserEventUnsubscribes?.push(unsubscribe);
                }
            } catch (err) {
                console.warn(`subscribe browser event ${evt.name} failed`, err);
            }
        }
    }

    /** 只退订本视图自己的浏览器事件订阅 */
    _unsubscribeBrowserEvents() {
        if (!this._browserEventUnsubscribes) return;
        for (const unsubscribe of this._browserEventUnsubscribes) {
            try {
                unsubscribe();
            } catch {
                /* ignore */
            }
        }
        this._browserEventUnsubscribes = null;
    }

    /**
     * Subscribe to AgentGate attribution analysis status events.
     * When attribution starts, show a status indicator in the chat stream.
     * When attribution ends, remove the indicator.
     */
    _subscribeAttributionStatus() {
        if (!window.agentGateFloatingAPI) return;

        this._handleAttributionStart = (data) => {
            // Only handle events for the current task
            if (data?.taskId !== this.task_id) return;
            const historyContainer = this.getHistoryContainer();
            if (!historyContainer) return;

            // Don't add if already present
            if (historyContainer.querySelector('[data-attribution-status="active"]')) return;

            const placeholder = TaskView.createAttributionStatusHtml();
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = placeholder;
            const el = tempDiv.firstElementChild;
            if (el) {
                historyContainer.appendChild(el);
                historyContainer.scrollTop = historyContainer.scrollHeight;
            }
        };

        this._handleAttributionEnd = (data) => {
            // Only handle events for the current task
            if (data?.taskId !== this.task_id) return;
            const historyContainer = this.getHistoryContainer();
            if (!historyContainer) return;

            const el = historyContainer.querySelector('[data-attribution-status="active"]');
            if (el) {
                el.remove();
            }
        };

        // 退订只移除本视图自己注册的 handler：同 renderer 中其他缓存的 task-view
        // 也订阅同一通道，不能用 removeAllListeners 波及其他任务（issue #116）。
        // 重连场景先退订上一次订阅，避免同通道堆叠 handler。
        this._unsubscribeAttributionStatus();
        this._attributionUnsubscribes = [
            window.agentGateFloatingAPI.onAttributionStart(this._handleAttributionStart),
            window.agentGateFloatingAPI.onAttributionEnd(this._handleAttributionEnd)
        ].filter((unsubscribe) => typeof unsubscribe === 'function');
    }

    /** 只退订本视图自己的归因订阅，不影响同 renderer 中其他 task-view 的订阅 */
    _unsubscribeAttributionStatus() {
        if (!this._attributionUnsubscribes) return;
        for (const unsubscribe of this._attributionUnsubscribes) {
            try {
                unsubscribe();
            } catch {
                /* ignore */
            }
        }
        this._attributionUnsubscribes = null;
    }

    /** 处理浏览器事件，只处理当前任务的事件 */
    _handleBrowserEvent(method, taskId, ...args) {
        if (taskId !== this.task_id) return;
        const sidebar = this._getRightSidebarEl();
        if (!sidebar || typeof sidebar[method] !== 'function') return;
        const initialBrowserUse =
            typeof sidebar.consumeInitialBrowserAutoReveal === 'function'
                ? sidebar.consumeInitialBrowserAutoReveal()
                : false;
        const shouldAutoReveal = initialBrowserUse && !this._shouldSuppressIncrementalRender();
        sidebar._suppressBrowserAutoSwitch = !shouldAutoReveal;
        if (shouldAutoReveal) {
            this._ensureRightSidebarOpen();
            if (typeof sidebar.forceBrowserActive === 'function') {
                sidebar.forceBrowserActive();
            } else if (typeof sidebar.ensureBrowserReady === 'function') {
                sidebar.ensureBrowserReady(true);
            }
        } else {
            if (initialBrowserUse && typeof sidebar.markPendingBrowserAutoReveal === 'function') {
                // 后台/隐藏期间的首次 Browser Use：记录大屏预览状态，待用户切回任务时生效
                sidebar.markPendingBrowserAutoReveal();
            }
            if (typeof sidebar.ensureBrowserReady === 'function') {
                sidebar.ensureBrowserReady(false);
            }
            if (typeof sidebar.keepBrowserPanelRenderable === 'function') {
                sidebar.keepBrowserPanelRenderable();
            }
        }
        sidebar[method](...args);

        // 若侧边栏已展开则保持不变；若已收起，尝试显示画中画浮窗
        if (!this._rightSidebarExpanded && !this._shouldSuppressIncrementalRender()) {
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

        // 后台首次 Browser Use 记录的大屏预览状态：按任务维度延迟到切回任务时生效，
        // 不受上次离开时的折叠状态影响（_expandRightSidebar 内部会隐藏画中画）。
        const pendingBrowserReveal =
            typeof rightSidebar.applyPendingBrowserAutoReveal === 'function' &&
            rightSidebar.applyPendingBrowserAutoReveal();
        if (pendingBrowserReveal) {
            this._forceExpandRightSidebar();
            if (typeof rightSidebar.forceBrowserActive === 'function') {
                rightSidebar.forceBrowserActive();
            }
        } else if (this._rightSidebarExpanded) {
            this._restoreRightSidebarFromOffscreen(rightSidebar);
            rightSidebar.style.display = '';
            rightSidebar.style.width = this._workspaceFocusLayout.getTargetPanelWidth();
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
        if (typeof rightSidebar.restoreSelectedBrowser === 'function') {
            rightSidebar.restoreSelectedBrowser();
        }
    }

    _updateSidebarToggleIcon(isExpanded) {
        const btn = this.querySelector(`[id^="taskview-sidebar-toggle-btn"]`);
        if (!btn) return;
        btn.classList.toggle('toolbar-spread-btn-on', isExpanded);
    }

    async _initToolbarWorkspace() {
        if (!this._toolbar || !window.workspaceAPI) return;
        try {
            const wsClickHandler = async () => {
                const selected = await showWorkspacePicker({
                    title: this._buildWorkspacePickerTitle(),
                    t: taskViewT
                });
                if (selected) {
                    await window.taskManagerAPI.updateTaskWorkspace(this.task_id, selected);
                    this._taskWorkspace = selected;
                    this._toolbar.setToolbarSubtitle(selected, wsClickHandler, taskViewT('workspace.taskLabel'));
                    this._syncInputTaskWorkspace();
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
            title: this._buildWorkspacePickerTitle(),
            t: taskViewT
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
            this._syncInputTaskWorkspace();
            document.dispatchEvent(new CustomEvent('workspace-changed'));
        }
    }

    /** 将任务工作空间同步给任务内输入框，使 @ 文件补全跟随任务工作空间 */
    _syncInputTaskWorkspace() {
        const input_widget = this.querySelector(`#task-${this.task_id}-input`);
        if (input_widget && typeof input_widget.setTaskWorkspace === 'function') {
            input_widget.setTaskWorkspace(this._taskWorkspace);
        }
    }

    /**
     * 用与 GUI 完全相同的渲染管线输出全量历史消息 HTML 分片，供导出使用。
     * DOM 中只渲染尾部窗口（虚拟化），这里必须显式覆盖全量消息；
     * 未锚定到具体消息的 goal evaluation 卡片与初始渲染保持一致地追加在末尾。
     * 返回分片数组而非单个巨串，避免超大任务的一次性字符串拼接开销。
     */
    _renderFullHistoryForExport() {
        const messages = this._historyMessages;
        let lastAssistantIdx = -1;
        for (let i = 0; i < messages.length; i++) {
            if (messages[i]?.role === 'assistant') lastAssistantIdx = i;
        }
        const htmlParts = [this._renderHistoryRangeToHtml(0, messages.length, { usageAssistantIdx: lastAssistantIdx })];
        const unanchoredGoalEvaluationHtml = renderGoalEvaluationRecordsHtml(
            getUnanchoredGoalEvaluationRecords(this._historyGoalEvaluationRecords, messages),
            this.task_id,
            taskViewT
        );
        if (unanchoredGoalEvaluationHtml) {
            htmlParts.push(unanchoredGoalEvaluationHtml);
        }
        return htmlParts;
    }

    /**
     * 收集导出 header 所需的任务元数据（模型/起止时间/累计 token 消耗）。
     * getTaskInfo 失败时返回 null，header 相应降级为仅标题 + 导出时间。
     */
    async _buildExportHeaderInfo() {
        const formatDateTime = (value) => {
            if (!value) return null;
            const d = new Date(value);
            if (Number.isNaN(d.getTime())) return null;
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        };
        const exportedAt = taskViewT('renderer.taskview.export.meta.exportedAt', {
            time: formatDateTime(Date.now())
        });
        const labels = {
            model: taskViewT('renderer.taskview.export.meta.model'),
            startedAt: '',
            exportedAt,
            totalTokens: taskViewT('renderer.taskStatusWidget.totalTokens'),
            inputTokens: taskViewT('renderer.taskStatusWidget.inputTokens'),
            outputTokens: taskViewT('renderer.taskStatusWidget.outputTokens'),
            cacheHitRate: taskViewT('renderer.taskview.export.meta.cacheHitRate'),
            toggleToLight: taskViewT('renderer.sidebar.themeToggleToLight'),
            toggleToDark: taskViewT('renderer.sidebar.themeToggleToDark')
        };
        const header = {
            title: this._taskName || this.task_id || 'OpenDesk',
            exportedAt,
            labels
        };
        try {
            const info = await window.taskManagerAPI.getTaskInfo(this.task_id);
            if (info.model) header.model = info.model;
            const startedAt = formatDateTime(info.started_at || info.created_at);
            if (startedAt) {
                header.startedAt = startedAt;
                labels.startedAt = taskViewT('renderer.taskStatusWidget.startedAt', { time: startedAt });
            }
            const usage = info.usage_summary;
            if (usage && typeof usage.total_tokens === 'number') {
                header.usage = {
                    total: usage.total_tokens,
                    input: usage.input_tokens,
                    output: usage.output_tokens
                };
                // cache 命中/未命中拆分，口径对齐 local-telemetry：未命中 = 非缓存输入 + 缓存写入
                if (typeof usage.cache_read_input_tokens === 'number' && typeof usage.input_tokens === 'number') {
                    header.usage.cacheRead = usage.cache_read_input_tokens;
                    header.usage.cacheMiss =
                        usage.input_tokens +
                        (typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0);
                }
            }
        } catch (error) {
            console.warn('Failed to load task info for export header:', error);
        }
        try {
            const version = await window.settingAPI.getVersion();
            if (version) {
                header.generatedBy = taskViewT('renderer.taskview.export.meta.generatedBy', { version });
            }
        } catch (error) {
            console.warn('Failed to load app version for export header:', error);
        }
        return header;
    }

    /**
     * 弹出导出下拉菜单（锚定在工具栏导出按钮下方）。
     * 再次点击导出按钮时关闭菜单（mousedown 处理器忽略按钮自身区域的点击）。
     */
    _openExportMenu(anchorEl) {
        if (!anchorEl) return;
        if (document.getElementById('od-taskview-export-menu') || this._exportMenuDismissHandler) {
            this._dismissExportMenu();
            return;
        }

        const dark =
            this.dataset.theme === 'dark' ||
            document.documentElement.dataset.theme === 'dark' ||
            document.body.dataset.theme === 'dark';
        const menu = document.createElement('div');
        menu.id = 'od-taskview-export-menu';
        menu.className = 'ctx-menu' + (dark ? ' ctx-menu-dark' : '');
        menu.style.minWidth = '150px';

        const items = [
            { action: 'export-html', icon: EXPORT_WEBPAGE_SVG, label: taskViewT('renderer.taskview.export.menu.html') },
            { action: 'export-json', icon: EXPORT_JSON_SVG, label: taskViewT('renderer.taskview.export.menu.json') }
        ];
        menu.innerHTML = items
            .map(
                (item) =>
                    `<button class="ctx-item" data-action="${item.action}">` +
                    `<span class="ctx-icon-sm">${item.icon}</span>` +
                    `<span class="ctx-label">${item.label}</span></button>`
            )
            .join('');

        const rect = anchorEl.getBoundingClientRect();
        // 菜单与按钮右缘对齐，锚定在按钮下方；待真实尺寸渲染后在 rAF 中修正越界
        menu.style.left = `${Math.max(8, rect.right - 150)}px`;
        menu.style.top = `${rect.bottom + 6}px`;
        document.body.appendChild(menu);

        requestAnimationFrame(() => {
            const margin = 8;
            const menuRect = menu.getBoundingClientRect();
            const left = Math.max(
                margin,
                Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - margin)
            );
            let top = rect.bottom + 6;
            if (top + menuRect.height > window.innerHeight - margin) {
                top = Math.max(margin, rect.top - menuRect.height - 6);
            }
            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
        });

        menu.querySelector('[data-action="export-html"]').addEventListener('click', () => {
            this._dismissExportMenu();
            void this.exportTask();
        });
        menu.querySelector('[data-action="export-json"]').addEventListener('click', () => {
            this._dismissExportMenu();
            void this.exportTaskJson();
        });

        this._updateExportButtonActive(true);

        this._exportMenuDismissHandler = (ev) => {
            if (!menu.contains(ev.target) && !anchorEl.contains(ev.target)) {
                this._dismissExportMenu();
            }
        };
        document.addEventListener('mousedown', this._exportMenuDismissHandler);
    }

    _dismissExportMenu() {
        document.getElementById('od-taskview-export-menu')?.remove();
        if (this._exportMenuDismissHandler) {
            document.removeEventListener('mousedown', this._exportMenuDismissHandler);
            this._exportMenuDismissHandler = null;
        }
        this._updateExportButtonActive(false);
    }

    /** 导出菜单打开期间保持按钮高亮（图标与文字同时点亮，鼠标移到菜单上也不熄灭） */
    _updateExportButtonActive(isOpen) {
        const btn = this.querySelector(`[id^="taskview-export-btn"]`);
        if (!btn) return;
        btn.classList.toggle('toolbar-spread-btn-on', isOpen);
    }

    async exportTaskJson() {
        try {
            // .task.json 的默认导出名与任务存储文件名一致，便于后续 /import task 导回
            const saveResult = await window.fsAPI.saveFile({
                title: taskViewT('renderer.taskview.export.jsonTitle'),
                defaultPath: `${this.task_id}.json`,
                filters: [
                    { name: 'JSON Files', extensions: ['json'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });
            if (saveResult.canceled || !saveResult.filePath) {
                return; // 用户取消了操作
            }
            await window.taskManagerAPI.exportTaskJson(this.task_id, saveResult.filePath);
        } catch (error) {
            console.error('Failed to export task json:', error);
            alert(taskViewT('renderer.taskview.export.failed', { message: error.message }));
        }
    }

    async exportTask() {
        try {
            const timestamp = new Date().toISOString().slice(0, 10);
            const defaultFileName = `task-${this.task_id}-${timestamp}.html`;

            // 1. 显示保存文件对话框（Electron 会自动处理文件覆盖确认）
            const saveResult = await window.fsAPI.saveFile({
                title: taskViewT('renderer.taskview.export.title'),
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
            const chatHistory = this.getHistoryContainer();
            if (!chatHistory) {
                return;
            }

            // 2. 复用 task view 的渲染管线与实时样式构建导出文档，保证显示效果与 GUI 对齐
            const header = await this._buildExportHeaderInfo();
            const { html, fontUrls } = buildTaskExportHtml({
                taskName: header.title,
                // 生成式 UI 组件在导出页里渲染成静态快照
                contentHtml: await renderGenUiForExport(this._renderFullHistoryForExport()),
                chatHistory,
                doc: document,
                reasoningCollapseLabel: taskViewT('reasoning.hide.content'),
                header
            });

            // 3. 交由主进程内联字体并写盘
            await window.taskManagerAPI.saveExportHtml(filePath, html, fontUrls);
        } catch (error) {
            console.error('Failed to export task:', error);
            alert(taskViewT('renderer.taskview.export.failed', { message: error.message }));
        }
    }

    _handleMsgActionClick(e) {
        const btn = e.target.closest('.od-msg-action-btn[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const messageId = btn.dataset.messageId;
        if (!action || !messageId) return;
        e.stopPropagation();
        if (action === 'copy') {
            this._handleCopyMessage(messageId)
                .then(() => this._showCopyFeedback(btn))
                .catch(() => {});
        } else if (action === 'regenerate') {
            this._handleRegenerateMessage(messageId);
        } else if (action === 'fork') {
            this._handleForkMessage(messageId);
        } else if (action === 'edit') {
            this._handleEditUserMessage(messageId);
        } else if (action === 'resubmit') {
            this._handleResubmitUserMessage(messageId);
        } else if (action === 'resend') {
            this._handleResendUserMessage(messageId);
        }
    }

    _handleCopyMessage(messageId) {
        const userContainer = this.querySelector(`#user-msg-${CSS.escape(messageId)}`);
        if (userContainer) {
            const rawText = userContainer.dataset.rawText;
            const text =
                rawText ||
                Array.from(userContainer.querySelectorAll('.od-user-msg'))
                    .map((el) => el.textContent || '')
                    .join('\n');
            return navigator.clipboard.writeText(text);
        }
        // 流式期间的消息可能尚未并入历史，退回 _assistantPartsByMessage 缓存（同样的 part 结构）
        const msgIdx = this._getHistoryMessageIndexById(messageId);
        const contentParts =
            msgIdx >= 0 ? this._historyMessages[msgIdx]?.content : this._assistantPartsByMessage.get(messageId);
        if (Array.isArray(contentParts)) {
            const textParts = contentParts.filter((p) => p && p.type === 'text' && p.text);
            const lastTextPart = textParts[textParts.length - 1];
            if (lastTextPart) {
                return navigator.clipboard.writeText(lastTextPart.text);
            }
        }
        const messageContent = this.querySelector(`#message-content-${CSS.escape(messageId)}`);
        if (messageContent) {
            // fallback: 从 DOM 取 textContent（.markdown-body 可能嵌套在输出流包裹层内，需深度查找）
            const textParts = Array.from(messageContent.querySelectorAll('.markdown-body'));
            const lastTextPart = textParts[textParts.length - 1];
            if (lastTextPart) {
                return navigator.clipboard.writeText(lastTextPart.textContent || '');
            }
        }
        return Promise.resolve();
    }

    _showCopyFeedback(btn) {
        const label = btn.querySelector('.od-msg-action-label');
        const labelHTML = label ? label.outerHTML : '';
        const originalHTML = btn.innerHTML;
        const FADE = 140;

        btn.style.opacity = '0';
        setTimeout(() => {
            btn.innerHTML = CHECK_ICON_SVG + labelHTML;
            btn.classList.add('od-msg-action-btn--copied');
            btn.style.opacity = '';
        }, FADE);

        setTimeout(() => {
            btn.style.opacity = '0';
            setTimeout(() => {
                btn.innerHTML = originalHTML;
                btn.classList.remove('od-msg-action-btn--copied');
                btn.style.opacity = '';
            }, FADE);
        }, FADE + 1200);
    }

    async _handleRegenerateMessage(messageId) {
        const assistantIdx = this._historyMessages.findIndex((m) => m.message_id === messageId);
        if (assistantIdx < 0) return;
        let userMessageId = null;
        for (let i = assistantIdx - 1; i >= 0; i--) {
            if (this._historyMessages[i].role === 'user') {
                userMessageId = this._historyMessages[i].message_id;
                break;
            }
        }
        if (!userMessageId) return;
        try {
            await window.taskManagerAPI.rewindToUserMessage(this.task_id, userMessageId, { resubmit: true });
            await this.reload();
        } catch (err) {
            console.error('Failed to regenerate:', err);
        }
    }

    async _handleForkMessage(messageId) {
        try {
            const forkedTaskId = await window.taskManagerAPI.forkTask(this.task_id, messageId);
            window.globalControlAPI.openTask(forkedTaskId);
        } catch (err) {
            console.error('Failed to fork:', err);
        }
    }

    _handleEditUserMessage(messageId) {
        const container = this.querySelector(`#user-msg-${CSS.escape(messageId)}`);
        if (!container) return;

        const textBubble = container.querySelector('.od-user-msg .markdown-body');
        if (!textBubble) return;

        const bubble = textBubble.parentElement;
        // 已在编辑态时忽略重复进入：否则下面捕获的 originalHtml / originalMenuHtml 都是编辑态
        // 快照，退出编辑后正文会被还原成一个没有监听器的 textarea，菜单也永久停在编辑态
        if (bubble.classList.contains('od-user-msg-editing')) return;
        const rawText = (container.dataset.rawText || textBubble.textContent || '').replace(/\n+$/, '');
        const originalHtml = textBubble.innerHTML;

        bubble.classList.add('od-user-msg-editing');

        // 编辑态下底部菜单只保留常驻高亮的"发送并重新执行"，避免出现"复制/编辑"等对当前编辑无意义的动作。
        // 初始内容与原文一致，按钮先置为禁用，由输入事件按 isUnchanged() 同步。
        const hoverMenu = container.querySelector('.od-msg-hover-menu');
        const originalMenuHtml = hoverMenu ? hoverMenu.innerHTML : '';
        let sendAgainBtn = null;
        if (hoverMenu) {
            hoverMenu.classList.add('od-msg-hover-menu--pinned');
            hoverMenu.innerHTML = `<button class="od-msg-action-btn od-msg-action-btn--send-again" type="button" disabled title="${escapeHtml(taskViewT('renderer.taskview.menu.sendAgainHint'))}">${RESEND_ICON_SVG}<span class="od-msg-action-label">${taskViewT('renderer.taskview.action.resubmit')}</span></button>`;
            sendAgainBtn = hoverMenu.querySelector('.od-msg-action-btn--send-again');
        }

        const textarea = document.createElement('textarea');
        textarea.className = 'od-user-msg-editor';
        textarea.value = rawText;
        textarea.rows = 1;
        textBubble.innerHTML = '';
        textBubble.appendChild(textarea);

        textarea.focus();
        textarea.setSelectionRange(rawText.length, rawText.length);

        let editing = true;
        let submitting = false;

        /**
         * 正文被清空或与原文一致时提交没有意义，此时禁用"发送并重新执行"。
         * 两侧都要 trim：rawText 取自 dataset.rawText，只裁过尾随换行，原文带首尾空格时
         * 单侧 trim 会让"一字未改"被判成已改动，按钮一进编辑态就可点。
         */
        const isUnchanged = () => {
            const value = textarea.value.trim();
            return !value || value === rawText.trim();
        };

        const syncSendAgainState = () => {
            if (sendAgainBtn) sendAgainBtn.disabled = isUnchanged();
        };
        syncSendAgainState();
        textarea.addEventListener('input', syncSendAgainState);

        const cleanup = () => {
            bubble.classList.remove('od-user-msg-editing');
            if (hoverMenu) {
                hoverMenu.classList.remove('od-msg-hover-menu--pinned');
                hoverMenu.innerHTML = originalMenuHtml;
            }
            document.removeEventListener('mousedown', outsideClickHandler);
        };

        const restoreOriginal = () => {
            if (!editing) return;
            editing = false;
            cleanup();
            textBubble.innerHTML = originalHtml;
        };

        /** 回车与"重新发送"按钮共用的提交路径。 */
        const submitEdit = async () => {
            if (!editing || submitting) return;
            if (isUnchanged()) {
                restoreOriginal();
                return;
            }
            const newText = textarea.value.trim();
            submitting = true;
            textarea.blur();
            const confirmed = await showConfirmModal({
                variant: 'warn',
                title: taskViewT('renderer.taskview.edit.title'),
                message: taskViewT('renderer.taskview.edit.message'),
                confirmText: taskViewT('renderer.taskview.edit.confirm'),
                cancelText: taskViewT('renderer.taskview.edit.cancel'),
                // 编辑消息场景：回车默认触发"继续对话"
                enterToConfirm: true
            });
            submitting = false;
            if (!confirmed) {
                textarea.focus();
                return;
            }
            editing = false;
            cleanup();
            try {
                await window.taskManagerAPI.rewindToUserMessage(this.task_id, messageId, {
                    resubmit: true,
                    overrideMessageText: newText
                });
                await this.reload();
            } catch (err) {
                console.error('Failed to edit and resubmit:', err);
                window.notificationAPI?.sendNotification?.(
                    'error',
                    taskViewT('renderer.taskview.menu.operationTitle'),
                    taskViewT('renderer.taskview.menu.operationFailed'),
                    err?.message || String(err)
                );
                textBubble.innerHTML = originalHtml;
            }
        };

        const outsideClickHandler = (e) => {
            if (!editing || submitting) return;
            if (textBubble.contains(e.target)) return;
            // 点"重新发送"按钮不算点到外部，否则编辑态先被撤销、按钮点击落空
            if (sendAgainBtn && sendAgainBtn.contains(e.target)) return;
            restoreOriginal();
        };

        /** 提交编排：showConfirmModal 抛错时不能让 submitting 卡死，否则按钮与回车都失效。 */
        const runSubmit = () => {
            submitEdit().catch((err) => {
                console.error('Failed to submit edited message:', err);
                submitting = false;
            });
        };

        sendAgainBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // 真实浏览器不会给 disabled 按钮派发 click，这里兜住合成事件/键盘激活
            if (sendAgainBtn.disabled) return;
            runSubmit();
        });

        textarea.addEventListener('keydown', (e) => {
            if (!editing) return;
            // 输入法（IME）组合期间不拦截按键，避免选词回车被误判为提交
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                runSubmit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                restoreOriginal();
            }
        });

        setTimeout(() => {
            document.addEventListener('mousedown', outsideClickHandler);
        }, 0);
    }

    async _handleResubmitUserMessage(messageId) {
        if (!this.task_id) return;
        try {
            await window.taskManagerAPI.rewindToUserMessage(this.task_id, messageId, {
                resubmit: true
            });
            await this.reload();
        } catch (err) {
            console.error('Failed to resubmit user message:', err);
            window.notificationAPI?.sendNotification?.(
                'error',
                taskViewT('renderer.taskview.menu.operationTitle'),
                taskViewT('renderer.taskview.menu.operationFailed'),
                err?.message || String(err)
            );
        }
    }

    async _handleResendUserMessage(messageId) {
        if (!this.task_id) return;
        try {
            const task = await window.taskManagerAPI.getFullTask(this.task_id);
            const message = task?.chat_context?.messages?.find(
                (item) => item.role === 'user' && item.message_id === messageId
            );
            if (!message) {
                throw new Error(taskViewT('renderer.taskview.menu.messageUnavailable'));
            }
            const content = message.content || [];
            await window.taskManagerAPI.submitMessage(this.task_id, {
                message:
                    message.rawText ||
                    content
                        .filter((part) => part.type === 'text')
                        .map((part) => part.text)
                        .join('\n'),
                attachedImages: content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url),
                attachedFilePaths: content.filter((part) => part.type === 'file').map((part) => part.path)
            });
            await this.reload();
            this.forceScrollToEnd();
        } catch (err) {
            console.error('Failed to resend user message:', err);
            window.notificationAPI?.sendNotification?.(
                'error',
                taskViewT('renderer.taskview.menu.operationTitle'),
                taskViewT('renderer.taskview.menu.operationFailed'),
                err?.message || String(err)
            );
        }
    }

    connectedCallback() {
        const connectionEpoch = ++this._connectionEpoch;
        const task_id = this.getAttribute('task_id');
        // setAttribute 会把 undefined 序列化成字符串 "undefined"，仅判 null 挡不住，
        // 这类视图初始化必然报 "task undefined not found"
        if (task_id === null || !task_id || task_id === 'undefined') {
            throw new Error('task_id is required');
        }
        this.task_id = task_id;

        // task-view 子树的 DOM 全部由组件自身管理（innerHTML/morph），不使用 Alpine 指令。
        // 标记 x-ignore 后 Alpine 的全局 MutationObserver 会跳过本子树的初始化与
        // 指令扫描，否则流式期间每次快照插入的新块都会被全树 walk 一遍。
        this.setAttribute('x-ignore', '');

        this.render();

        // Initialize toolbar with spread layout
        const toolbarContainer = this.querySelector('#taskview-toolbar');
        if (toolbarContainer) {
            const toolbar = new ElasticToolbarWidget(
                [
                    {
                        id: 'taskview-export-btn',
                        iconSvg: EXPORT_OPEN_SVG,
                        label: taskViewT('renderer.taskview.toolbar.export'),
                        expandLabel: true,
                        action: (event) => {
                            this._openExportMenu(event?.currentTarget);
                        }
                    },
                    {
                        id: 'taskview-sidebar-toggle-btn',
                        iconSvg: SIDEBAR_TOGGLE_SVG,
                        label: taskViewT('renderer.taskview.toolbar.panel'),
                        expandLabel: true,
                        action: () => {
                            this._toggleRightSidebar();
                        }
                    }
                ],
                taskViewT('renderer.taskview.toolbar.title'),
                'spread'
            );
            toolbarContainer.appendChild(toolbar);
            this._toolbar = toolbar;
        }

        this._initToolbarWorkspace();
        this.setUpEventListeners();

        this._disconnectAgentInputRequests?.();
        this._disconnectAgentInputRequests = listenForAgentInputRequests(this, () =>
            this.querySelector(`#task-${this.task_id}-input`)
        );

        // 添加编辑器打开按钮的点击事件监听（事件代理）
        this._handleEditorOpenClick = this._handleEditorOpenClick.bind(this);
        this.addEventListener('click', this._handleEditorOpenClick);

        // 添加系统默认应用打开按钮的点击事件监听（事件代理）
        this._handleOpenFileClick = this._handleOpenFileClick.bind(this);
        this.addEventListener('click', this._handleOpenFileClick);

        this._handleSkillPillClick = this._handleSkillPillClick.bind(this);
        this.addEventListener('click', this._handleSkillPillClick);

        // 添加预览打开按钮的点击事件监听（事件代理）
        this._handlePreviewOpenClick = this._handlePreviewOpenClick.bind(this);
        this.addEventListener('click', this._handlePreviewOpenClick);

        // 添加 FileMessagePart 卡片三点菜单按钮的点击事件监听（事件代理）
        this._handleFileCardMenuClick = this._handleFileCardMenuClick.bind(this);
        this.addEventListener('click', this._handleFileCardMenuClick);

        // 添加文件标签右键菜单的事件监听（事件代理）
        this._handleFilePillContextMenu = this._handleFilePillContextMenu.bind(this);
        this.addEventListener('contextmenu', this._handleFilePillContextMenu);

        // 添加消息中 Web 链接右键菜单的事件监听（事件代理）
        this._handleLinkContextMenu = this._handleLinkContextMenu.bind(this);
        this.addEventListener('contextmenu', this._handleLinkContextMenu);

        this._handleProcessToggleClick = this._handleProcessToggleClick.bind(this);
        this.addEventListener('click', this._handleProcessToggleClick);

        // 添加 reasoning 块展开/收起的事件代理
        this._handleReasoningToggleClick = this._handleReasoningToggleClick.bind(this);
        this.addEventListener('click', this._handleReasoningToggleClick);

        // 消息 hover 菜单按钮事件代理
        this._handleMsgActionClick = this._handleMsgActionClick.bind(this);
        this.addEventListener('click', this._handleMsgActionClick);

        // Bubble mode hover handlers
        this._handleReasoningHoverEnter = this._handleReasoningHoverEnter.bind(this);
        this._handleReasoningHoverLeave = this._handleReasoningHoverLeave.bind(this);
        this.addEventListener('mouseover', this._handleReasoningHoverEnter);
        this.addEventListener('mouseout', this._handleReasoningHoverLeave);

        this._goalController.connect();

        // 初始化 session memory 刷新
        const sidebarEl = this._getRightSidebarEl();
        if (sidebarEl && typeof sidebarEl.setTaskId === 'function') {
            sidebarEl.setTaskId(this.task_id);
        }
        this._syncArtifactsTaskStatus();

        // 订阅全局待办更新（跨任务共享）
        this._subscribeGlobalTodos();
        // 订阅任务级待办更新（仅处理当前任务的事件）
        this._subscribeTaskTodos();

        // 订阅浏览器事件（agent 工具 → main → renderer → 操作浏览器）
        this._subscribeBrowserEvents();

        // 订阅 AgentGate 归因分析状态事件
        this._subscribeAttributionStatus();

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
                // task-list 事件携带最新工作空间时，同步刷新右边栏
                const taskSidebar = this.querySelector(`#task-${this.task_id}-artifacts`);
                if (taskSidebar && typeof taskSidebar.refreshWorkspace === 'function') {
                    taskSidebar.refreshWorkspace(this._taskWorkspace);
                }
            }
        };
        document.addEventListener('task-list-updated', this._taskListUpdateHandler);

        // 窗口恢复可见时消费后台冻结期间登记的补齐标记。两个信号源互补：
        // openDesk:visibilityChanged（主进程 IPC）覆盖最小化/隐藏/恢复；
        // document visibilitychange（Chromium 遮挡检测）覆盖主进程不感知的
        // 窗口完全遮挡与重新露出。gate 标记一次性消费，重复事件自然去重。
        // 拒绝判定复用 _isWindowRenderFrozen，与 shouldSkipRender 的可见性
        // 判定互补由构造保证，规避事件到达顺序差异导致的提前补齐或漏补齐。
        this._windowVisibilityHandler = () => {
            if (this._isWindowRenderFrozen()) return;
            this._backgroundUpdateGate.onWindowBecameVisible();
        };
        window.addEventListener('openDesk:visibilityChanged', this._windowVisibilityHandler);
        document.addEventListener('visibilitychange', this._windowVisibilityHandler);

        void this.reload()
            .then(async () => {
                if (!this.isConnected || connectionEpoch !== this._connectionEpoch) {
                    return;
                }
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
                const handleTaskUpdate = (progress) => {
                    if (!this.isConnected || connectionEpoch !== this._connectionEpoch) {
                        return;
                    }
                    if (progress.type === 'compact') {
                        this._latestCompactProgress = progress;
                        this._compactProgressRevision = (this._compactProgressRevision || 0) + 1;
                    }
                    if (progress.type === 'user') {
                        this._consumeGoalEditReminder(progress);
                    }
                    // 后台任务或正在 reload 时跳过 DOM 操作，避免无效渲染。
                    // 用户切回时 openTask() 会调用 reload() 补齐所有跳过的更新。
                    // 检查 display:none（hideAllNonAppChildren 隐藏）和 data-background
                    // （ensureTaskViewExists 创建的不可见视图，用 opacity:0 隐藏）。
                    if (this._reloading) {
                        this._deferTaskUpdateDuringReload(progress);
                        this._handleTaskStatusUpdate(progress.task_status);
                        if (progress.type === 'goal_eval') {
                            this._handleGoalEvalProgress(progress, { renderToConversation: false });
                        }
                        return;
                    }
                    // 视图不可见（display:none / data-background）或窗口隐藏（最小化 /
                    // 完全遮挡）时走同一丢帧路径：仅同步轻量状态。补齐机制互不登记——
                    // 视图不可见由 openTask() 的 reload 补齐；窗口隐藏由
                    // _backgroundUpdateGate 在恢复可见时触发一次 reload 补齐
                    // （短路求值保证视图不可见时不触发 gate 登记）。
                    if (
                        this.style.display === 'none' ||
                        this.hasAttribute('data-background') ||
                        this._backgroundUpdateGate.shouldSkipRender()
                    ) {
                        this._assistantProgressBuffer.clear();
                        this._handleTaskStatusUpdate(progress.task_status);
                        if (progress.type === 'goal_eval') {
                            this._handleGoalEvalProgress(progress, { renderToConversation: false });
                        }
                        return;
                    }

                    // Control/replacement events must observe all preceding text.
                    if (progress.type !== 'assistant') this._assistantProgressBuffer.flush();
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
                                const metaRowHtml = TaskView.buildMsgMetaRow(
                                    'user',
                                    progress.timestamp,
                                    progress.message_id
                                );
                                if (metaRowHtml) container.insertAdjacentHTML('beforeend', metaRowHtml);
                            } else if (this._isHistoryMessageBeforeRenderedWindow(progress.message_id)) {
                                this._applyHiddenUserReplaceToHistory(progress);
                            }
                            this._syncUserReplaceToHistory(progress);
                        }
                    } else if (progress.type === 'assistant_replace') {
                        this.handleAssistantReplace(progress);
                    } else if (progress.type === 'retry') {
                        this.handleRetryProgress(progress);
                    } else if (progress.type === 'compact') {
                        this.handleCompactProgress(progress);
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
                        this._assistantProgressBuffer.push(progress);
                        // 有 assistant token 输出 → 移除过渡中的 goal supplement 卡片
                        this.resolvePendingGoalSupplements();
                        // 任务运行中且有 goal 时，节流刷新 goal 面板（token 进度条实时推进）。
                        // 不依赖 progress.usage：很多 provider 流式过程中不返回 usage，只在结束时才返回。
                        if (this._currentGoal) {
                            this._scheduleGoalRefresh();
                        }
                    }

                    if (this._handleTaskStatusUpdate(progress.task_status) && this.task_status !== 'running') {
                        // 流式结束：结束活跃 reasoning 块计时并清理等待占位/spinner/流式光标，
                        // 为最后一条 assistant 消息追加时间戳与 hover 菜单
                        this._cleanupStreamingState(
                            getAssistantTurnEndTimestamp(progress) || this._lastAssistantCompletedAt || Date.now()
                        );
                        // 任务结束时也清理过渡中的 supplement 卡片
                        this.resolvePendingGoalSupplements();
                        const inputWidget = this.querySelector(`#task-${this.task_id}-input`);
                        if (inputWidget && !this._isRightSidebarEditableFocused()) {
                            const textarea = inputWidget.querySelector('#agent-input-textarea');
                            if (textarea && document.activeElement !== textarea) textarea.focus();
                        }
                    }

                    // 任务级待办的实时更新已通过 todomgr.taskTodosUpdated 事件单独订阅，
                    // 这里无需再从工具调用进度里反推 TodoWrite 的执行状态。

                    // 文件树由目录监听更新，文件操作工具完成后只同步变更面板。
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
                            if (sidebar && typeof sidebar.refreshChanges === 'function') {
                                sidebar.refreshChanges();
                            }
                        }
                    }

                    this.tryScrollToEnd();
                };
                this._taskUpdateHandler = handleTaskUpdate;
                const subscriptionId = await window.taskManagerAPI.subscribeTaskUpdate(this.task_id, handleTaskUpdate);
                if (!this.isConnected || connectionEpoch !== this._connectionEpoch) {
                    await window.taskManagerAPI.unsubscribeTaskUpdate(this.task_id, subscriptionId);
                    return;
                }
                this.subscription_id = subscriptionId;
            })
            .catch((error) => {
                if (this.isConnected && connectionEpoch === this._connectionEpoch) {
                    console.error('Failed to initialize task view:', error);
                }
            });
    }

    disconnectedCallback() {
        this._assistantProgressBuffer.clear();
        this._chatFind?.destroy();
        this._chatFind = null;
        this._chatNavigation?.destroy();
        this._chatNavigation = null;
        // previewer 的容器注册表对历史/消息容器是强引用，销毁前显式解除，
        // 避免已销毁视图的整棵 DOM 驻留到下一次主题变更才被清理
        untrackPreviewerContainers(this);
        this._connectionEpoch += 1;
        this._reloadVersion += 1;
        this._reloading = false;
        this._deferredTaskUpdates.clear();
        this._taskUpdateHandler = null;
        if (this._processScrollFollowRafId !== null && this._processScrollFollowRafId >= 0) {
            cancelAnimationFrame(this._processScrollFollowRafId);
        }
        this._processScrollFollowRafId = null;
        this._cancelPendingScrollFollow();
        this._pendingProcessScrollFollowTargets.clear();
        const artifacts = this.querySelector(`#task-${this.task_id}-artifacts`);
        if (artifacts && typeof artifacts.setTaskTodos === 'function') {
            artifacts.setTaskTodos([]);
        }
        this.removeEventListener('click', this._handleEditorOpenClick);
        this.removeEventListener('click', this._handleOpenFileClick);
        this.removeEventListener('click', this._handleSkillPillClick);
        this.removeEventListener('click', this._handlePreviewOpenClick);
        this.removeEventListener('click', this._handleFileCardMenuClick);
        this.removeEventListener('contextmenu', this._handleFilePillContextMenu);
        this._dismissFilePillContextMenu();
        this.removeEventListener('contextmenu', this._handleLinkContextMenu);
        this._dismissLinkContextMenu();
        this._dismissExportMenu();
        this.removeEventListener('click', this._handleProcessToggleClick);
        this.removeEventListener('click', this._handleReasoningToggleClick);
        this._disconnectAgentInputRequests?.();
        this._disconnectAgentInputRequests = null;
        this.removeEventListener('mouseover', this._handleReasoningHoverEnter);
        this.removeEventListener('mouseout', this._handleReasoningHoverLeave);
        this.getHistoryContainer()
            ?.querySelectorAll('.reasoning-block-od.reasoning-active')
            .forEach((el) => TaskView.finalizeReasoningBlock(el));
        // 状态行秒级刷新与消息内思考块计时器一并停止
        this._stopRunningStatusTimeTicker();
        this._reasoningStatusStartByMessage?.clear();
        this._goalController.disconnect();
        this._workspaceFocusLayout.dispose();
        this._cancelBrowserIdleTimer();
        this._cancelBrowserPipShowTimer();
        if (this._browserPip) {
            this._browserPip.destroy();
            this._browserPip = null;
        }
        if (this.subscription_id !== null) {
            void Promise.resolve(window.taskManagerAPI.unsubscribeTaskUpdate(this.task_id, this.subscription_id)).catch(
                (error) => console.warn('Failed to unsubscribe task view:', error)
            );
        }
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
        // 只退订本视图自己的浏览器事件 / 归因订阅，不影响其他 task-view
        this._unsubscribeBrowserEvents();
        this._unsubscribeAttributionStatus();
        if (this._workspaceChangedHandler) {
            document.removeEventListener('workspace-changed', this._workspaceChangedHandler);
            this._workspaceChangedHandler = null;
        }
        if (this._taskListUpdateHandler) {
            document.removeEventListener('task-list-updated', this._taskListUpdateHandler);
            this._taskListUpdateHandler = null;
        }
        if (this._windowVisibilityHandler) {
            window.removeEventListener('openDesk:visibilityChanged', this._windowVisibilityHandler);
            document.removeEventListener('visibilitychange', this._windowVisibilityHandler);
            this._windowVisibilityHandler = null;
        }
        if (this._historyScrollKeydownHandler) {
            document.removeEventListener('keydown', this._historyScrollKeydownHandler);
            this._historyScrollKeydownHandler = null;
        }
        if (this._historyResizeObserver) {
            this._historyResizeObserver.disconnect();
            this._historyResizeObserver = null;
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

    _renderEmbedded() {
        this.innerHTML = `
        <div class="bg-gray-30 h-full flex flex-col" data-agent-input-height-reference data-chat-find-scope tabindex="-1">
            <div class="relative flex-1 overflow-hidden min-h-0">
                <div id="taskview-chat-history" class="w-full h-full overflow-y-auto px-3 pt-3"></div>
                <!-- 滚动控制按钮组 -->
                <div id="taskview-scroll-controls" class="absolute bottom-3 right-5 flex items-center rounded-full shadow hidden"
                     style="background: rgba(120,140,170,0.72); backdrop-filter: blur(4px); height: 2rem;">
                    <button
                        id="taskview-prev-user-msg-button"
                        class="flex items-center justify-center px-2.5 h-full text-white transition-all focus:outline-none active:scale-95 od-scroll-ctrl-btn"
                        title="${taskViewT('renderer.taskview.prevUserMessage')}"
                    >
                        <i class="fas fa-chevron-up text-xs"></i>
                        <span class="ml-1 text-[11px]">${taskViewT('renderer.taskview.prevUserMessage')}</span>
                    </button>
                    <div class="w-px h-3.5 bg-white/25"></div>
                    <button
                        id="taskview-next-user-msg-button"
                        class="flex items-center justify-center px-2.5 h-full text-white transition-all focus:outline-none active:scale-95 od-scroll-ctrl-btn"
                        title="${taskViewT('renderer.taskview.nextUserMessage')}"
                    >
                        <i class="fas fa-chevron-down text-xs"></i>
                        <span class="ml-1 text-[11px]">${taskViewT('renderer.taskview.nextUserMessage')}</span>
                    </button>
                    <div class="w-px h-3.5 bg-white/25"></div>
                    <button
                        id="taskview-scroll-to-bottom-button"
                        class="flex items-center justify-center px-2.5 h-full text-white transition-all focus:outline-none active:scale-95 od-scroll-ctrl-btn"
                        title="${taskViewT('renderer.taskview.scrollToBottom')}"
                    >
                        <i class="fas fa-arrow-down text-xs"></i>
                        <span class="ml-1 text-[11px]">${taskViewT('renderer.taskview.scrollToBottom')}</span>
                    </button>
                </div>
            </div>

            <permission-prompt id="task-${this.task_id}-permission" data-task-id="${this.task_id}" class="block px-3"></permission-prompt>
            <ask-user-prompt id="task-${this.task_id}-ask-user" data-task-id="${this.task_id}" class="block px-3"></ask-user-prompt>
            <exit-plan-mode-prompt id="task-${this.task_id}-exit-plan" class="block px-3"></exit-plan-mode-prompt>

            <div class="px-3 pb-3 pt-1 shrink-0">
                <message-queue-panel id="message-queue-panel"></message-queue-panel>
                <agent-input id="task-${this.task_id}-input" hide-search />
            </div>
        </div>
        `;

        const hc = this.getHistoryContainer();
        if (hc) {
            this._domSanitizer = installDOMSanitizer(hc);
        }
    }

    render() {
        this._conversationJumpInProgress = false;
        this._chatFind?.destroy();
        this._chatFind = null;
        this._chatNavigation?.destroy();
        this._chatNavigation = null;
        if (this.isEmbedded) {
            this._renderEmbedded();
            return;
        }

        // 初始宽度同样受聊天区最小宽度约束，避免窄窗口下首次渲染就把聊天区压到 350px 以下
        const initialSidebarWidth = this._workspaceFocusLayout.constrainPanelWidth(`${this._rightSidebarWidth}px`);

        this.innerHTML = `
        <div class="bg-gray-30 h-full flex flex-col">
            <header id="taskview-toolbar" class="w-full"></header>
            <div id="task-${this.task_id}-content-row" class="flex-1 flex flex-row min-h-0 overflow-hidden relative">
                <div class="flex-1 flex flex-col min-w-0" data-agent-input-height-reference data-chat-find-scope tabindex="-1">
                    <div class="relative flex-1 overflow-hidden">
                        <!-- 对话历史区域 - 可滚动 -->
                        <div id="taskview-chat-history" class="w-full h-full overflow-y-auto px-3 pt-4">
                        </div>
                        <!-- 滚动控制按钮组 -->
                        <div id="taskview-scroll-controls" class="absolute bottom-3 right-8 flex items-center rounded-full shadow hidden"
                             style="background: rgba(120,140,170,0.72); backdrop-filter: blur(4px); height: 2rem;">
                            <button
                                id="taskview-prev-user-msg-button"
                                class="flex items-center justify-center px-2.5 h-full text-white transition-all focus:outline-none active:scale-95 od-scroll-ctrl-btn"
                                title="${taskViewT('renderer.taskview.prevUserMessage')}"
                            >
                                <i class="fas fa-chevron-up text-xs"></i>
                                <span class="ml-1 text-[11px]">${taskViewT('renderer.taskview.prevUserMessage')}</span>
                            </button>
                            <div class="w-px h-3.5 bg-white/25"></div>
                            <button
                                id="taskview-next-user-msg-button"
                                class="flex items-center justify-center px-2.5 h-full text-white transition-all focus:outline-none active:scale-95 od-scroll-ctrl-btn"
                                title="${taskViewT('renderer.taskview.nextUserMessage')}"
                            >
                                <i class="fas fa-chevron-down text-xs"></i>
                                <span class="ml-1 text-[11px]">${taskViewT('renderer.taskview.nextUserMessage')}</span>
                            </button>
                            <div class="w-px h-3.5 bg-white/25"></div>
                            <button
                                id="taskview-scroll-to-bottom-button"
                                class="flex items-center justify-center px-2.5 h-full text-white transition-all focus:outline-none active:scale-95 od-scroll-ctrl-btn"
                                title="${taskViewT('renderer.taskview.scrollToBottom')}"
                            >
                                <i class="fas fa-arrow-down text-xs"></i>
                                <span class="ml-1 text-[11px]">${taskViewT('renderer.taskview.scrollToBottom')}</span>
                            </button>
                        </div>
                    </div>

                    <!-- 权限确认浮窗 -->
                    <permission-prompt id="task-${this.task_id}-permission" data-task-id="${this.task_id}" class="block px-[30px]"></permission-prompt>

                    <!-- 用户提问面板 -->
                    <ask-user-prompt id="task-${this.task_id}-ask-user" data-task-id="${this.task_id}" class="block px-[30px]"></ask-user-prompt>

                    <!-- 计划审批面板 -->
                    <exit-plan-mode-prompt id="task-${this.task_id}-exit-plan" class="block px-[30px]"></exit-plan-mode-prompt>

                    <!-- 输入区域 -->
                    <div class="px-[30px] pb-3 pt-1">
                        <!-- 消息队列面板 -->
                        <message-queue-panel id="message-queue-panel"></message-queue-panel>
                        <agent-input id="task-${this.task_id}-input" hide-search />
                    </div>
                </div>

                <!-- 右侧边栏拖拽条（data-od-no-longpress：拖拽分割线不参与触摸长按手势） -->
                <div id="task-${this.task_id}-resizer"
                    class="resizer-group taskview-resizer relative shrink-0"
                    data-od-no-longpress="1"
                    style="width: 4px; cursor: col-resize; touch-action: none; display: ${this._rightSidebarExpanded ? '' : 'none'};"
                >
                    <div class="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none">
                        <div class="resizer-handle-indicator resizer-blue" style="width: 2px; height: 3rem; border-radius: 9999px; background: #e5e7eb;"></div>
                    </div>
                </div>

                <!-- 右侧边栏（任务产物 / 任务计划 / 变更） -->
                <task-artifacts id="task-${this.task_id}-artifacts" task-id="${this.task_id}" style="display: ${this._rightSidebarExpanded ? '' : 'none'}; width: ${initialSidebarWidth};"></task-artifacts>
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
        // 发起拖动的指针：多指同按（触摸屏掌压、第二根手指）时只跟随它
        let pointerId = null;
        const onPointerMove = (e) => {
            if (!isResizing || e.pointerId !== pointerId) return;
            e.preventDefault();
            if (resizeRafId !== null) return;
            resizeRafId = requestAnimationFrame(() => {
                resizeRafId = null;
                if (!isResizing || !cachedContainerRect) return;
                const newWidth = cachedContainerRect.right - e.clientX;
                // 面板上限取两个约束的较小值：容器宽度的 85%，以及为聊天区保留 MIN_CHAT_AREA_WIDTH 后的余量
                const maxWidth = Math.min(
                    cachedContainerRect.width * 0.85,
                    cachedContainerRect.width - MIN_CHAT_AREA_WIDTH - RIGHT_PANEL_RESIZER_WIDTH
                );
                // 容器过窄时上限可能低于默认下限，此时以聊天区约束为准
                const minWidth = Math.min(200, maxWidth);
                if (newWidth < minWidth || newWidth > maxWidth) return;
                rightSidebar.style.width = newWidth + 'px';
                this._rightSidebarWidth = newWidth;
            });
        };

        const onPointerUp = (e) => {
            if (!isResizing || e.pointerId !== pointerId) return;
            isResizing = false;
            pointerId = null;
            cachedContainerRect = null;
            if (resizeRafId !== null) {
                cancelAnimationFrame(resizeRafId);
                resizeRafId = null;
            }
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            rightSidebar.style.pointerEvents = '';
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
        };

        // 统一使用指针事件：触摸屏拖动不会派发 mousemove，只监听鼠标事件时
        // 分割线在触摸/触控笔场景下完全无法拖动
        resizer.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || isResizing) return;
            e.preventDefault();
            e.stopPropagation();
            const container = this.querySelector(`#task-${this.task_id}-content-row`);
            if (!container) return;
            cachedContainerRect = container.getBoundingClientRect();
            isResizing = true;
            pointerId = e.pointerId;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            rightSidebar.style.pointerEvents = 'none';
            // 挂在 window 上：拖动过程中指针可能移出分割线甚至窗口边界
            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', onPointerUp);
            window.addEventListener('pointercancel', onPointerUp);
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
        this._syncInputTaskWorkspace();
        input_widget.addEventListener('model-changed', async (event) => {
            const modelAlias = event.detail?.model;
            if (modelAlias) {
                try {
                    await window.taskManagerAPI.setTaskModel(this.task_id, modelAlias, event.detail.reasoningEffort);
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
                        const scope = hasApplications
                            ? taskViewT('renderer.taskview.quickpass.scope.all')
                            : taskViewT('renderer.taskview.quickpass.scope.base');
                        await window.notificationAPI.sendNotification(
                            'info',
                            taskViewT('renderer.taskview.quickpass.settingsTitle'),
                            taskViewT('renderer.taskview.quickpass.success'),
                            taskViewT('renderer.taskview.quickpass.successDetail', { scope })
                        );
                        window.globalControlAPI.openHomePage();
                        return;
                    }
                } catch (err) {
                    await window.notificationAPI.sendNotification(
                        'error',
                        taskViewT('renderer.taskview.quickpass.failedTitle'),
                        taskViewT('renderer.taskview.quickpass.failedDetail'),
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
            this.emitTaskStatusChanged(this.task_status);
            this._syncArtifactsTaskStatus();
            this._cancelBrowserIdleTimer();
            this.updateStopButtonVisibility();

            this._showWaitingAssistantPlaceholder({ force: true });
            this.forceScrollToEnd();

            try {
                await window.taskManagerAPI.submitMessage(this.task_id, event.detail);
            } catch (error) {
                console.error('Failed to submit message:', error);
                // 发送失败时重置状态，防止 task_status/isRunning 永久卡住
                // 导致后续所有输入都被阻塞
                this.task_status = 'stopped';
                this.emitTaskStatusChanged(this.task_status);
                this._syncArtifactsTaskStatus();
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
                (id) => this.removeFromMessageQueue(id),
                (id, targetIndex) => this.reorderMessageQueue(id, targetIndex)
            );
        }

        const chatHistory = this.querySelector('#taskview-chat-history');
        this._chatFind?.destroy();
        // 搜索复用当前会话的完整内存记录；命中旧消息时，先补载 DOM，再由搜索控制器定位。
        this._chatFind = new ChatFind(chatHistory, {
            // 使用回调读取最新列表，而非只搜索已经渲染出来的消息。
            getMessages: () => this._historyMessages,
            ensureMessage: (messageId) => this._ensureHistoryLoadedThroughMessage(messageId),
            // 暂停底部自动跟随，避免搜索定位被持续生成的新内容打断。
            pauseFollow: () => {
                this.setAutoScrollingToBottom(false);
                this._cancelPendingScrollFollow();
            },
            translate: (key, params) => taskViewT(key, params)
        });
        this._chatNavigation?.destroy();
        this._chatNavigation = new ChatNavigation(chatHistory, {
            navigate: (messageId) => this._navigateConversation(messageId),
            translate: (key, params) => taskViewT(key, params),
            refresh: () => this._getConversationStops()
        });
        this._chatNavigation.setStops(this._getConversationStops());
        chatHistory.addEventListener('scrollend', () => {
            this._conversationJumpInProgress = false;
        });
        chatHistory.addEventListener('scroll', () => {
            if (this._programmaticScrolling) return;
            // Keep streamed output detached until the navigation scroll has completed.
            if (this._conversationJumpInProgress) return;
            if (chatHistory.scrollTop <= TASKVIEW_HISTORY_TOP_LOAD_THRESHOLD_PX) {
                this._loadOlderHistoryFromScroll();
            }
            const scrollBottom = chatHistory.scrollTop + chatHistory.clientHeight;
            const distanceToBottom = Math.abs(chatHistory.scrollHeight - scrollBottom);
            // 使用更宽松的阈值避免因内容增长导致的误 detach
            if (distanceToBottom < 80) {
                // A small upward gesture must not immediately reattach at the bottom.
                if (this._lastUserScrollDirection < 0 && this._hasRecentUserScrollIntent()) return;
                if (!this.auto_scrolling_to_bottom) {
                    this.setAutoScrollingToBottom(true);
                }
            } else if (this._hasRecentUserScrollIntent()) {
                // 仅在用户主动滚动（滚轮/触控板/触摸）时解除锁定，避免缩放等引起的
                // 被动 scroll（页面 zoom 会调整 scrollTop）被误判为手动离开底部
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
                // 忽略浏览器缩放/捏合手势（Ctrl/⌘ + 滚轮、触控板捏合），
                // 缩放不应改变“锁定底部自动更新”的状态
                if (e.ctrlKey || e.metaKey) return;
                if (e.deltaY !== 0 && nestedScrollerConsumesWheel(chatHistory, e)) return;
                if (e.deltaY !== 0) {
                    this._markUserScrollIntent(Math.sign(e.deltaY));
                }
                // 向上滚动（deltaY < 0）→ 解锁；向下滚动到底部 → 重新锁定
                if (e.deltaY < 0) {
                    // Unlock before native scrolling; a queued render must not win the race.
                    if (chatHistory.scrollTop > 0 && this.auto_scrolling_to_bottom) {
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
        // 触摸滚动视为用户主动滚动；仅在真实移动（touchmove）时标记，
        // 避免纯点击（touchstart 无位移）留下滚动意图痕迹
        chatHistory.addEventListener('touchmove', () => this._markUserScrollIntent(), { passive: true });
        // 聊天区尺寸变化（放大预览时侧边栏展开/收起、预览卡片加载、窗口缩放等引起
        // 的布局变化）会使视图偏离底部；锁定底部时重新滚到底部，避免“锁定但不在底部”
        // 的失效。重复调用 setUpEventListeners 时先释放旧观察器，避免累积
        if (this._historyResizeObserver) {
            this._historyResizeObserver.disconnect();
            this._historyResizeObserver = null;
        }
        if (typeof window.ResizeObserver === 'function') {
            this._historyResizeObserver = new window.ResizeObserver(() => {
                if (this.auto_scrolling_to_bottom) {
                    this.tryScrollToEnd();
                }
            });
            this._historyResizeObserver.observe(chatHistory);
        }
        // 命中右侧滚动条区域的拖拽（鼠标）视为滚动意图，覆盖滚动条拖动场景
        chatHistory.addEventListener('pointerdown', (e) => {
            // 触控笔（pen）在内容区按下基本为绘制/拖动，且可能不派发 touchmove，直接视为滚动意图
            if (e.pointerType === 'pen') {
                this._markUserScrollIntent();
                return;
            }
            const rect = chatHistory.getBoundingClientRect();
            if (e.clientX - rect.left >= chatHistory.clientWidth) {
                this._markUserScrollIntent();
            }
        });
        // 键盘滚动（PageUp/PageDown/方向键/Home/End/空格）同样视为用户主动滚动；
        // 挂到 document 以覆盖聊天区无焦点时的滚动，输入区域（textarea/input/可编辑）内除外
        // 防御性清理：setUpEventListeners 可能被重复调用（如实例重挂载），避免 document 监听累积
        if (this._historyScrollKeydownHandler) {
            document.removeEventListener('keydown', this._historyScrollKeydownHandler);
        }
        this._historyScrollKeydownHandler = (e) => {
            if (e.ctrlKey || e.metaKey) return; // Ctrl/⌘+方向键为跳词，⌘+± 为缩放
            const target = e.target;
            if (target?.closest?.('.od-chat-nav')) return;
            if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) {
                return;
            }
            // 焦点位于预览区域（右侧边栏/画中画）时，键盘滚动作用于预览自身，
            // 不应标记为聊天区滚动意图（否则放大预览时滚动预览内容会误解除底部锁定）
            if (this._isKeydownInPreviewArea(target)) {
                return;
            }
            const key = e.key;
            if (
                key === 'PageUp' ||
                key === 'PageDown' ||
                key === 'Home' ||
                key === 'End' ||
                key === ' ' ||
                key.startsWith('Arrow')
            ) {
                this._markUserScrollIntent();
            }
        };
        document.addEventListener('keydown', this._historyScrollKeydownHandler);

        this._poolSegRaf = null;
        const initPoolSegIndicators = () => {
            chatHistory.querySelectorAll('.pool-seg').forEach((seg) => {
                const indicator = seg.querySelector('.pool-seg-indicator');
                const active = seg.querySelector('.pool-seg-btn.active');
                // 历史子项启用 content-visibility:auto 后，视口外卡片是"跳过"态，
                // 读取 offset 会得到 0；此时不能把 0 写进指示器（否则滚回可见时
                // 指示器丢失），等卡片真实渲染后由点击/下次变更重新定位。
                if (indicator && active && active.offsetWidth > 0) {
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

        // 右键菜单：用户消息气泡 → 完整消息菜单；编辑态 → 只留编辑框的编辑菜单；
        // 其他区域（assistant 消息 / 终端工具等）有选中文本 → 复制选中内容菜单
        chatHistory.addEventListener('contextmenu', (e) => this._handleChatHistoryContextMenu(e));

        const scrollButton = this.querySelector('#taskview-scroll-to-bottom-button');
        scrollButton.addEventListener('click', () => {
            this.forceScrollToEnd();
        });

        const prevUserMsgButton = this.querySelector('#taskview-prev-user-msg-button');
        prevUserMsgButton.addEventListener('click', () => {
            this._scrollToUserMessage('prev');
        });

        const nextUserMsgButton = this.querySelector('#taskview-next-user-msg-button');
        nextUserMsgButton.addEventListener('click', () => {
            this._scrollToUserMessage('next');
        });
    }

    /**
     * 聊天区右键分发。编辑态下必须放行：编辑框的剪切/复制/粘贴/全选菜单由注入脚本自绘，
     * 叠加一层消息菜单会盖住它，且消息级动作对当前编辑没有意义。
     */
    _handleChatHistoryContextMenu(e) {
        // Web 链接命中时优先放行给 task-view 元素层的链接专用菜单（复制链接地址等），
        // 避免被下方消息/选中菜单的 stopPropagation 拦截
        if (e.target.closest('a[href]')) return;
        const bubble = e.target.closest('.od-user-msg');
        if (bubble) {
            if (bubble.classList.contains('od-user-msg-editing')) return;
            const container = bubble.closest('.od-user-msg-container');
            if (!container?.dataset?.messageId) return;
            e.preventDefault();
            e.stopPropagation();
            TaskView._showUserMsgContextMenu(e.clientX, e.clientY, bubble, container);
            return;
        }
        const selectedText = window.getSelection()?.toString().trim() || '';
        if (!selectedText) return;
        e.preventDefault();
        e.stopPropagation();
        TaskView._showSelectionContextMenu(e.clientX, e.clientY, selectedText);
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

    static _dismissSelectionContextMenu() {
        document.getElementById('od-selection-ctx')?.remove();
        document.removeEventListener('mousedown', TaskView._selectionCtxDismissHandler);
    }

    static _selectionCtxDismissHandler = (e) => {
        if (!e.target.closest('#od-selection-ctx')) {
            TaskView._dismissSelectionContextMenu();
        }
    };

    static _showSelectionContextMenu(x, y, selectedText) {
        TaskView._dismissSelectionContextMenu();
        TaskView._dismissUserMsgContextMenu();

        const dark = document.documentElement.dataset.theme === 'dark' || document.body.dataset.theme === 'dark';
        const menu = document.createElement('div');
        menu.id = 'od-selection-ctx';
        menu.className = 'ctx-menu' + (dark ? ' ctx-menu-dark' : '');
        menu.style.minWidth = '160px';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        menu.innerHTML = `<button class="ctx-item" data-action="copy"><span class="ctx-icon-sm">${COPY_ICON_SVG}</span><span class="ctx-label">${taskViewT('renderer.taskview.menu.copy')}</span></button>`;

        document.body.appendChild(menu);

        requestAnimationFrame(() => {
            const margin = 14;
            const rect = menu.getBoundingClientRect();
            const left = Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - rect.width - margin));
            const top = Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - rect.height - margin));
            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
        });

        menu.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
            navigator.clipboard.writeText(selectedText).catch(() => {});
            TaskView._dismissSelectionContextMenu();
        });

        document.addEventListener('mousedown', TaskView._selectionCtxDismissHandler);
    }

    static _showUserMsgContextMenu(x, y, bubble, messageContainer) {
        TaskView._dismissUserMsgContextMenu();
        TaskView._dismissSelectionContextMenu();

        const taskView = bubble.closest('task-view');
        const messageId = messageContainer?.dataset?.messageId || '';
        const canRewind = !!taskView?.task_id && !!messageId && !!window.taskManagerAPI?.rewindToUserMessage;
        const canResend =
            !!taskView?.task_id &&
            !!messageId &&
            !!window.taskManagerAPI?.getFullTask &&
            !!window.taskManagerAPI?.submitMessage;
        const dark =
            taskView?.dataset?.theme === 'dark' ||
            document.documentElement.dataset.theme === 'dark' ||
            document.body.dataset.theme === 'dark';
        const menu = document.createElement('div');
        menu.id = 'od-user-msg-ctx';
        menu.className = 'ctx-menu' + (dark ? ' ctx-menu-dark' : '');
        menu.style.minWidth = '196px';
        menu.style.maxWidth = '280px';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        const items = [
            { id: 'copy', icon: COPY_ICON_SVG, label: taskViewT('renderer.taskview.menu.copy') },
            { id: 'copy-plain', icon: CTX_FONT_ICON_SVG, label: taskViewT('renderer.taskview.menu.copyPlain') },
            { id: 'select-all', icon: CTX_SELECT_ALL_ICON_SVG, label: taskViewT('renderer.taskview.menu.selectAll') },
            {
                id: 'edit',
                icon: EDIT_ICON_SVG,
                label: taskViewT('renderer.taskview.menu.edit'),
                hint: taskViewT('renderer.taskview.menu.editHint'),
                separatorBefore: true,
                disabled: !canRewind
            },
            {
                id: 'continue-from',
                icon: REGENERATE_ICON_SVG,
                label: taskViewT('renderer.taskview.menu.continueFromHere'),
                hint: taskViewT('renderer.taskview.menu.continueHint'),
                disabled: !canRewind
            },
            {
                id: 'resend',
                icon: RESEND_ICON_SVG,
                label: taskViewT('renderer.taskview.action.resend'),
                hint: taskViewT('renderer.taskview.menu.resendHint'),
                disabled: !canResend
            }
        ];

        const buttonsHtml = items
            .map((item) => {
                const sep = item.separatorBefore ? '<div class="ctx-divider"></div>' : '';
                const cls = 'ctx-item' + (item.disabled ? ' disabled' : '');
                const disabled = item.disabled ? ' disabled aria-disabled="true"' : '';
                const hint = item.hint ? ` data-hint="${escapeHtml(item.hint)}"` : '';
                return `${sep}<button class="${cls}" data-action="${item.id}"${hint}${disabled}><span class="ctx-icon-sm">${item.icon}</span><span class="ctx-label">${escapeHtml(item.label)}</span></button>`;
            })
            .join('');
        menu.innerHTML = `${buttonsHtml}<div class="ctx-hint" data-role="hint"></div>`;

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
                if (btn.disabled || !btn.dataset.hint || !hintEl) return;
                hintEl.textContent = btn.dataset.hint;
                hintEl.classList.add('visible');
            });
            btn.addEventListener('mouseleave', () => {
                if (btn.disabled || !btn.dataset.hint || !hintEl) return;
                hintEl.textContent = '';
                hintEl.classList.remove('visible');
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

        menu.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
            TaskView._dismissUserMsgContextMenu();
            if (!taskView || !messageId) return;
            taskView._handleEditUserMessage(messageId);
        });

        menu.querySelector('[data-action="continue-from"]')?.addEventListener('click', () => {
            TaskView._dismissUserMsgContextMenu();
            taskView?._handleResubmitUserMessage(messageId);
        });

        menu.querySelector('[data-action="resend"]')?.addEventListener('click', () => {
            TaskView._dismissUserMsgContextMenu();
            taskView?._handleResendUserMessage(messageId);
        });

        setTimeout(() => {
            document.addEventListener('mousedown', TaskView._userMsgCtxDismissHandler);
        }, 0);
    }
}

customElements.define('task-view', TaskView);
