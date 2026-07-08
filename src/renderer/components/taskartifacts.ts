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

/**
 * 任务产物/计划面板（Task Artifacts）。
 *
 * 顶部三个 tab：
 *   - 任务计划：上半 = 当前任务级待办 (TodoWrite 写入)，下半 = 全局待办 (todomgr)。
 *     两者均为空时展示占位；只有任一侧有数据时，只渲染该侧。
 *   - 工作空间：文件浏览器（树状 / 网格视图），点击文件可预览文本内容。
 *   - 变更：占位，后续扩展。
 *
 * 每个待办项会展示执行耗时：
 *   - in_progress：显示 "已执行 xxx"，组件内 1s 刷新一次计时徽章；
 *   - completed：显示 "用时 xxx"（started_at → completed_at）；
 *   - pending：不展示耗时。
 */

import { FileExplorer, getFileExplorerCSS } from './fileExplorer';
import { EmbeddedBrowser } from '../browser';
import { syncShadowHostTheme } from '../theme/theme-shadow-overrides';
import { createRendererTranslator } from '../locale';
import {
    getGoalSectionActionIds,
    getTaskTodoSnapshotKey,
    hasUnfinishedGoalStatus,
    isAttachedRunningGoalCreateResult,
    isTerminalGoalStatus,
    shouldAutoCollapseTerminalGoalDetails,
    shouldShowGoalSuggestion,
    type GoalActionId,
    type GoalRenderStatus
} from './taskartifacts-goal-state.js';
import { formatLocalDateTime } from './goal-time-format.js';

// ============================================================================
// Types
// ============================================================================

type TodoStatus = 'pending' | 'in_progress' | 'completed';
type TodoPriority = 'low' | 'medium' | 'high';

interface TaskTodoLike {
    id: string;
    title?: string;
    content?: string;
    status: TodoStatus;
    created_at?: string;
    updated_at?: string;
    started_at?: string;
    completed_at?: string;
}

interface GlobalTodoLike extends TaskTodoLike {
    priority?: TodoPriority;
}

interface GoalRenderSummaryLike {
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
    recentEvents?: Array<{
        type: string;
        revision: number;
        timestamp: string;
        source: string;
        objective?: string;
        previousObjective?: string;
        displayMessageId?: string;
    }>;
    objectiveEvents?: Array<{
        type: string;
        revision: number;
        timestamp: string;
        source: string;
        objective?: string;
        previousObjective?: string;
        displayMessageId?: string;
    }>;
}

interface GoalEvaluationLike {
    evaluationId?: string;
    goalId?: string;
    goalRevision?: number;
    phase: 'start' | 'end';
    status?: string;
    message?: string;
    evidence?: string[];
    nextPrompt?: string;
    startedAt?: string;
    evaluatedAt?: string;
    updatedAt?: string;
}

type GoalEvalProgressLike = GoalEvaluationLike;

interface GoalDisclosureState {
    evaluationOpen: boolean;
    timelineOpen: boolean;
    autoCollapsedAfterTodoUpdate: boolean;
}

interface SetTaskTodosOptions {
    source?: 'refresh' | 'live-update';
}

interface RenderTaskPlanOptions {
    autoCollapseCurrentGoalDetails?: boolean;
}

interface TabSpec {
    id: 'task-plan' | 'workspace' | 'browser' | 'changes' | 'session-memory';
    label: string;
    labelKey?: string;
    icon: string;
    dynamic?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const TASK_PLAN_TAB: TabSpec = {
    id: 'task-plan',
    label: '任务进展',
    labelKey: 'renderer.taskartifacts.tab.taskProgress',
    icon: 'fa-list-check',
    dynamic: true
};
const WORKSPACE_TAB: TabSpec = { id: 'workspace', label: '工作空间', icon: 'fa-folder-open' };
const BROWSER_TAB: TabSpec = { id: 'browser', label: '浏览器', icon: 'fa-globe' };
const CHANGES_TAB: TabSpec = { id: 'changes', label: '变更', icon: 'fa-code-compare' };
const SESSION_MEMORY_TAB: TabSpec = { id: 'session-memory', label: '任务记忆', icon: 'fa-brain', dynamic: true };
let t = createRendererTranslator();

// ============================================================================
// Helpers
// ============================================================================

import { escapeHtml } from '../../common/utils/escape.js';

function statusIcon(status: TodoStatus): string {
    switch (status) {
        case 'completed':
            return '<i class="fas fa-check-circle" style="color:#10b981;font-size:13px;"></i>';
        case 'in_progress':
            return '<i class="fas fa-circle-notch fa-spin" style="color:#3b82f6;font-size:13px;"></i>';
        case 'pending':
        default:
            return '<i class="far fa-circle" style="color:#d1d5db;font-size:13px;"></i>';
    }
}

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 1) {
        return `${Math.max(0, ms)}ms`;
    }
    if (totalSec < 60) {
        return `${totalSec}s`;
    }
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) {
        return sec === 0 ? `${min}m` : `${min}m${String(sec).padStart(2, '0')}s`;
    }
    const hour = Math.floor(min / 60);
    const remMin = min % 60;
    return remMin === 0 ? `${hour}h` : `${hour}h${String(remMin).padStart(2, '0')}m`;
}

function computeDurationMs(todo: TaskTodoLike, nowMs: number): number | null {
    if (todo.status === 'completed') {
        const endIso = todo.completed_at || todo.updated_at;
        const startIso = todo.started_at || todo.created_at;
        if (!endIso || !startIso) return null;
        const start = Date.parse(startIso);
        const end = Date.parse(endIso);
        if (Number.isNaN(start) || Number.isNaN(end)) return null;
        return Math.max(0, end - start);
    }
    if (todo.status === 'in_progress') {
        const startIso = todo.started_at || todo.updated_at || todo.created_at;
        if (!startIso) return null;
        const start = Date.parse(startIso);
        if (Number.isNaN(start)) return null;
        return Math.max(0, nowMs - start);
    }
    return null;
}

type GoalDisplayEvent = {
    type?: string;
    revision?: number;
    displayMessageId?: string;
};

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

function isRunningTaskArtifactsContext(element: HTMLElement): boolean {
    const artifacts = element as HTMLElement & { isTaskRunning?: () => boolean };
    if (typeof artifacts.isTaskRunning === 'function') {
        return artifacts.isTaskRunning();
    }
    const taskView = element.closest('task-view') as { task_status?: string } | null;
    return taskView?.task_status === 'running';
}

/**
 * 将主文档中所有含 FontAwesome 相关选择器的 CSS 规则提取为纯文本。
 * Shadow DOM 隔离了父文档的样式，所以需要把 .fa / .fas 等规则手动注入。
 * @font-face 会穿透 shadow boundary，但选择器规则不会。
 */
function extractFontAwesomeRulesText(): string {
    const chunks: string[] = [];
    try {
        for (const sheet of document.styleSheets) {
            let rules: CSSRuleList;
            try {
                rules = sheet.cssRules;
            } catch {
                continue;
            }
            for (const rule of rules) {
                const text = rule.cssText;
                if (
                    /\.fa[srb]?\b/.test(text) ||
                    /font-family:\s*["']?Font\s*Awesome/i.test(text) ||
                    /\.fa-/.test(text) ||
                    /^@keyframes\s+fa-/i.test(text)
                ) {
                    chunks.push(text);
                }
            }
        }
    } catch {
        // safe to ignore
    }
    return chunks.join('\n');
}

// ============================================================================
// TaskArtifacts 组件
// ============================================================================

class TaskArtifacts extends HTMLElement {
    private _activeTab: TabSpec['id'] = 'workspace';
    private _taskTodos: TaskTodoLike[] = [];
    private _globalTodos: GlobalTodoLike[] = [];
    private _tickTimer: number | null = null;

    private _fileExplorer = new FileExplorer();
    private _browser: EmbeddedBrowser | null = null;
    private _isBrowserFullscreen = false;
    private _settingUnsubscribe: (() => void) | null = null;
    private _savedWidthBeforeFullscreen: string = '';

    private _taskPlanVisible = false;
    private _goalState: GoalRenderSummaryLike | null = null;
    private _goalEvalProgress: GoalEvalProgressLike | null = null;
    private _goalEditing = false;
    private _goalEditPending = false;
    private _taskRunning = false;
    private _goalDisclosureByGoalId = new Map<string, GoalDisclosureState>();
    private _taskTodoSnapshotKey: string | null = null;
    /** 是否正在显示 goal 创建表单 */
    private _goalCreating = false;
    private _goalCreationObjectiveDraft = '';
    private _goalSuggestionDismissed = false;
    private _browserVisible = false;
    private _sessionMemoryHtml: string | null = null;
    private _sessionMemoryVisible = false;
    private _sessionMemoryRefreshTimer: number | null = null;
    private _tabScrollResizeObserver: ResizeObserver | null = null;

    // Changes panel
    private _changesData: any = null; // TaskChangesResult | null

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._fileExplorer.onOpenInBrowser = (filePath: string) => {
            const normalized = filePath.replace(/\\/g, '/');
            const fileUrl = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
            this.browserAddTab(fileUrl);
        };
    }

    private _getTabs(): TabSpec[] {
        const tabs: TabSpec[] = [];
        if (this._taskPlanVisible) tabs.push(TASK_PLAN_TAB);
        tabs.push(WORKSPACE_TAB);
        tabs.push(BROWSER_TAB);
        tabs.push(CHANGES_TAB);
        if (this._sessionMemoryVisible) tabs.push(SESSION_MEMORY_TAB);
        return tabs;
    }

    private _getTabLabel(tab: TabSpec): string {
        if (!tab.labelKey) return tab.label;
        const localized = t(tab.labelKey);
        return localized === tab.labelKey ? tab.label : localized;
    }

    // ----- Tab scroll controls -----

    private _initTabScrollObserver(): void {
        const tabBarContainer = this.shadowRoot?.querySelector('.tab-bar-container');
        const tabBar = this.shadowRoot?.querySelector('.tab-bar-scrollable');

        if (!tabBarContainer || !tabBar) return;

        // 清理旧的监听器
        if (this._tabScrollResizeObserver) {
            this._tabScrollResizeObserver.disconnect();
        }

        // 监听容器大小变化
        this._tabScrollResizeObserver = new ResizeObserver(() => {
            this._updateTabScrollButtons();
        });
        this._tabScrollResizeObserver.observe(tabBarContainer);

        // 监听滚动位置变化
        tabBar.addEventListener('scroll', () => this._updateTabScrollButtons());

        // 延迟初始检测，确保 DOM 完全渲染
        requestAnimationFrame(() => {
            this._updateTabScrollButtons();
        });

        // 额外延迟检测，以防初始渲染时机问题
        setTimeout(() => {
            this._updateTabScrollButtons();
        }, 100);
    }

    private _destroyTabScrollObserver(): void {
        if (this._tabScrollResizeObserver) {
            this._tabScrollResizeObserver.disconnect();
            this._tabScrollResizeObserver = null;
        }
    }

    private _updateTabScrollButtons(): void {
        const tabBar = this.shadowRoot?.querySelector('.tab-bar-scrollable') as HTMLElement | null;
        const leftBtn = this.shadowRoot?.querySelector('.tab-scroll-btn-left') as HTMLElement | null;
        const rightBtn = this.shadowRoot?.querySelector('.tab-scroll-btn-right') as HTMLElement | null;

        if (!tabBar || !leftBtn || !rightBtn) {
            return;
        }

        const { scrollLeft, scrollWidth, clientWidth } = tabBar;
        const canScrollLeft = scrollLeft > 0;
        const canScrollRight = scrollLeft + clientWidth < scrollWidth - 1;

        // 当需要滚动时显示按钮
        const needsScroll = scrollWidth > clientWidth + 1;

        leftBtn.style.display = needsScroll && canScrollLeft ? 'flex' : 'none';
        rightBtn.style.display = needsScroll && canScrollRight ? 'flex' : 'none';
    }

    private _scrollTabBar(direction: 'left' | 'right'): void {
        const tabBar = this.shadowRoot?.querySelector('.tab-bar-scrollable') as HTMLElement | null;
        if (!tabBar) return;

        const scrollAmount = 100;
        const newScrollLeft =
            direction === 'left' ? tabBar.scrollLeft - scrollAmount : tabBar.scrollLeft + scrollAmount;

        tabBar.scrollTo({ left: newScrollLeft, behavior: 'smooth' });
    }

    connectedCallback(): void {
        this.render();
        this.shadowRoot?.addEventListener('click', this._onGoalSectionClick as EventListener);
        this.shadowRoot?.addEventListener('keydown', this._onGoalTimelineKeydown as EventListener);
        this.shadowRoot?.addEventListener('input', this._onGoalInput as EventListener);
        void this._initializeLocale();
        this._scheduleTick();
        // 监听主题变化
        document.addEventListener('opendesk-theme-changed', this._onThemeChange as EventListener);
    }

    disconnectedCallback(): void {
        this.shadowRoot?.removeEventListener('click', this._onGoalSectionClick as EventListener);
        this.shadowRoot?.removeEventListener('keydown', this._onGoalTimelineKeydown as EventListener);
        this.shadowRoot?.removeEventListener('input', this._onGoalInput as EventListener);
        document.removeEventListener('opendesk-theme-changed', this._onThemeChange as EventListener);
        this._settingUnsubscribe?.();
        this._settingUnsubscribe = null;
        this._stopTick();
        this._stopSessionMemoryRefresh();
        this._destroyTabScrollObserver();
    }

    // ----- Public API -----

    private _onThemeChange = (e: CustomEvent): void => {
        syncShadowHostTheme(this, e.detail?.effective);
    };

    private async _initializeLocale(): Promise<void> {
        try {
            const api = (window as any).settingAPI;
            if (api?.loadSettingObject) {
                t = createRendererTranslator(await api.loadSettingObject());
                this._refreshLocalizedText();
            }
            if (api?.onSettingChanged && !this._settingUnsubscribe) {
                this._settingUnsubscribe = api.onSettingChanged((setting: any) => {
                    t = createRendererTranslator(setting);
                    this._refreshLocalizedText();
                });
            }
        } catch {
            t = createRendererTranslator();
        }
    }

    private _refreshLocalizedText(): void {
        this._rebuildTabBar();
        if (this._activeTab === 'changes') {
            this._renderChangesPanel();
        }
        if (this._activeTab === 'task-plan') {
            this._renderTaskPlanPanel();
        }
    }

    setTaskTodos(todos: TaskTodoLike[] | null | undefined, options: SetTaskTodosOptions = {}): void {
        const hadTodos = this._taskTodos.length > 0;
        const nextTodos = Array.isArray(todos) ? todos : [];
        const nextTodoSnapshotKey = getTaskTodoSnapshotKey(nextTodos);
        const currentGoalId = this._goalState?.id ?? null;
        const shouldAutoCollapseGoalDetails = shouldAutoCollapseTerminalGoalDetails({
            goalId: currentGoalId,
            goalStatus: this._goalState?.status,
            previousTodoSnapshotKey: this._taskTodoSnapshotKey,
            nextTodoSnapshotKey,
            collapseAlreadyApplied: currentGoalId
                ? (this._goalDisclosureByGoalId.get(currentGoalId)?.autoCollapsedAfterTodoUpdate ?? false)
                : false,
            source: options.source ?? 'refresh'
        });
        this._taskTodos = nextTodos;
        this._taskTodoSnapshotKey = nextTodoSnapshotKey;
        if (this._taskTodos.length === 0) {
            this._goalSuggestionDismissed = false;
        }
        this._syncTaskPlanVisibility();
        if (
            !hadTodos &&
            shouldShowGoalSuggestion({
                todoCount: this._taskTodos.length,
                goalStatus: this._goalState?.status,
                goalCreating: this._goalCreating,
                dismissed: this._goalSuggestionDismissed
            })
        ) {
            this._switchTab('task-plan');
        }
        if (this._shouldPreserveGoalEditorDom()) {
            this._renderTaskTodosOnly();
        } else {
            this._renderTaskPlanPanel({ autoCollapseCurrentGoalDetails: shouldAutoCollapseGoalDetails });
        }
        this._scheduleTick();
    }

    setGlobalTodos(todos: GlobalTodoLike[] | null | undefined): void {
        this._globalTodos = Array.isArray(todos) ? todos : [];
        this._syncTaskPlanVisibility();
        if (!this._shouldPreserveGoalEditorDom()) {
            this._renderTaskPlanPanel();
        }
        this._scheduleTick();
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
                    message: t('goal.eval.superseded_by_edit'),
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
            this._goalCreating = false; // 有非终态 goal 时关闭创建模式
            this._goalCreationObjectiveDraft = '';
        }
        // 无 goal 或终态（complete/cleared）时关闭编辑模式；
        // 终态下不再自动移除面板，保留显示当前状态。
        if (!this._goalState || this._isTerminalGoal(this._goalState)) {
            this._goalEditing = false;
        }
        this._syncTaskPlanVisibility();
        if ((!hadGoal && this._goalState) || (!hadGoalSuggestion && this.hasGoalSuggestion())) {
            this._switchTab('task-plan');
        }
        const keepEditingDom =
            wasEditing &&
            this._goalEditing &&
            this._goalState !== null &&
            previousGoalId === this._goalState.id &&
            !this._isTerminalGoal(this._goalState);
        const keepCreatingDom = this._goalCreating && !hasUnfinishedGoalStatus(this._goalState?.status);
        if (!keepEditingDom && !keepCreatingDom) {
            this._renderTaskPlanPanel();
        }
    }

    setGoalEditPending(pending: boolean): void {
        const nextPending = pending === true;
        if (this._goalEditPending === nextPending) return;
        this._goalEditPending = nextPending;
        if (nextPending) {
            this._goalEditing = false;
        }
        this._renderTaskPlanPanel();
    }

    setTaskRunning(running: boolean): void {
        this._taskRunning = running === true;
    }

    isTaskRunning(): boolean {
        if (this._taskRunning) return true;
        const taskView = this.closest('task-view') as { task_status?: string } | null;
        return taskView?.task_status === 'running';
    }

    private _getGoalEditUnavailableMessage(): string | null {
        if (this._goalEditPending) {
            return t('goal.renderer.edit_unavailable_pending');
        }
        if (!this._goalState || this._isTerminalGoal(this._goalState)) {
            return t('goal.renderer.edit_unavailable_status');
        }
        return null;
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
            this._switchTab('task-plan');
        }
        if (this._shouldPreserveGoalEditorDom()) {
            this._renderGoalEvaluationStack();
        } else {
            this._renderTaskPlanPanel();
        }
    }

    /**
     * 打开 goal 创建表单（由外部"创建目标"按钮触发）。
     */
    showGoalCreationForm(): void {
        if (this._goalState && !this._isTerminalGoal(this._goalState)) {
            window.alert(t('goal.create.requires_clear'));
            this._switchTab('task-plan');
            return;
        }
        this._goalCreating = true;
        this._goalEditing = false;
        this._goalCreationObjectiveDraft = '';
        this._syncTaskPlanVisibility();
        this._switchTab('task-plan');
        this._renderTaskPlanPanel();
    }

    private _isTerminalGoal(goal: GoalRenderSummaryLike): boolean {
        return isTerminalGoalStatus(goal.status);
    }

    private _shouldPreserveGoalEditorDom(): boolean {
        return (
            this._goalCreating ||
            (this._goalEditing && this._goalState !== null && !this._isTerminalGoal(this._goalState))
        );
    }

    private _syncTaskPlanVisibility(): void {
        const hasTodos = this._taskTodos.length > 0;
        const hasGoal = this._goalState !== null || this._goalCreating;
        if ((hasTodos || hasGoal) && !this._taskPlanVisible) {
            this._taskPlanVisible = true;
            this._rebuildTabBar();
            this._switchTab('task-plan');
        } else if (!hasTodos && !hasGoal && this._taskPlanVisible) {
            this._taskPlanVisible = false;
            if (this._activeTab === 'task-plan') {
                this._activeTab = 'workspace';
            }
            this._rebuildTabBar();
        }
    }

    hasAnyTodos(): boolean {
        return this._taskTodos.length > 0;
    }

    hasTaskTodos(): boolean {
        return this._taskTodos.length > 0;
    }

    hasGoalSuggestion(): boolean {
        return shouldShowGoalSuggestion({
            todoCount: this._taskTodos.length,
            goalStatus: this._goalState?.status,
            goalCreating: this._goalCreating,
            dismissed: this._goalSuggestionDismissed
        });
    }

    /**
     * 外部调用：当工作空间路径可能已变化时（如用户切换工作空间、切换任务），
     * 重新拉取 workspace 路径并刷新文件浏览器。
     * @param workspace 可选的任务级工作空间路径
     */
    refreshWorkspace(workspace?: string): void {
        this._fileExplorer.refresh(workspace);
    }

    /**
     * 外部调用：当文件被编辑/创建/删除时，增量刷新已展开目录内容。
     */
    softRefreshWorkspace(): void {
        this._fileExplorer.softRefresh();
    }

    /**
     * 外部调用：切换到工作空间 tab 并打开指定文件的预览。
     */
    openFilePreview(filePath: string): void {
        this._switchTab('workspace');
        this._fileExplorer.selectFile(filePath);
    }

    /**
     * 外部调用：关闭编辑器（如侧边栏收起时）。
     */
    closeEditor(): void {
        this._fileExplorer.closeEditor();
    }

    /**
     * 外部调用：切换到工作空间 tab 并在编辑器中打开文件。
     * @param line 可选行号，打开后跳转到该行
     */
    openFileInEditor(filePath: string, line?: number): void {
        this._switchTab('workspace');
        this._fileExplorer.openEditor(filePath, line);
    }

    /**
     * 编辑器是否处于打开状态。
     */
    isEditorOpen(): boolean {
        return this._fileExplorer.isEditorOpen();
    }

    /**
     * 外部调用：设置任务 ID，启动 session memory 定期刷新。
     */
    setTaskId(taskId: string): void {
        this._taskId = taskId;
        this._startSessionMemoryRefresh();
    }

    private _taskId: string | null = null;

    /**
     * 外部调用：刷新 session memory 内容。
     */
    async refreshSessionMemory(): Promise<void> {
        if (!this._taskId) return;
        try {
            const data = await (window as any).taskManagerAPI.getSessionMemory(this._taskId);
            if (data && data.rendered) {
                this._sessionMemoryHtml = data.rendered;
                if (!this._sessionMemoryVisible) {
                    this._sessionMemoryVisible = true;
                    this._rebuildTabBar();
                }
                this._renderSessionMemoryPanel();
            } else if (this._sessionMemoryVisible) {
                this._sessionMemoryHtml = null;
                this._sessionMemoryVisible = false;
                if (this._activeTab === 'session-memory') {
                    this._switchTab('task-plan');
                }
                this._rebuildTabBar();
            }
        } catch {
            // ignore
        }
    }

    private _startSessionMemoryRefresh(): void {
        this._stopSessionMemoryRefresh();
        this.refreshSessionMemory();
        this._sessionMemoryRefreshTimer = window.setInterval(() => this.refreshSessionMemory(), 15000);
    }

    private _stopSessionMemoryRefresh(): void {
        if (this._sessionMemoryRefreshTimer !== null) {
            window.clearInterval(this._sessionMemoryRefreshTimer);
            this._sessionMemoryRefreshTimer = null;
        }
    }

    /**
     * 外部调用：刷新变更面板数据。
     */
    async refreshChanges(): Promise<void> {
        if (!this._taskId) return;
        try {
            const data = await (window as any).taskManagerAPI.getTaskChanges(this._taskId);
            this._changesData = data;
            this._renderChangesPanel();
        } catch {
            // ignore
        }
    }

    private _renderChangesPanel(): void {
        const root = this.shadowRoot;
        if (!root) return;
        const panel = root.querySelector<HTMLElement>('.tab-content[data-tab="changes"]');
        if (!panel) return;

        const data = this._changesData;
        if (!data || !data.files || data.files.length === 0) {
            panel.innerHTML = `
            <div class="placeholder-content">
                <i class="fas fa-code-compare placeholder-icon"></i>
                <p>暂无文件变更</p>
                <p class="placeholder-hint">当任务中的工具调用对工作空间文件进行修改后，变更将在此处显示</p>
            </div>`;
            return;
        }

        const filesHtml = data.files
            .map((file: any) => {
                const fileName = file.filePath.replace(/^.*[\\/]/, '');
                const dirPath = file.filePath.replace(/[\\/][^\\/]*$/, '') || file.filePath;
                const collapseId = `changes-file-${Math.random().toString(36).slice(2, 8)}`;

                const diffsHtml = file.changes
                    .map((change: any) => {
                        const changeLabel = escapeHtml(
                            change.toolName === 'cumulative'
                                ? t('renderer.taskartifacts.changes.cumulative')
                                : change.toolName
                        );

                        const hunksHtml = (change.hunks || [])
                            .map((hunk: any) => {
                                const oldRange = `${hunk.oldStart},${hunk.oldLines}`;
                                const newRange = `${hunk.newStart},${hunk.newLines}`;
                                const headerHtml =
                                    hunk.oldLines === 0 && hunk.newLines > 0
                                        ? '' // 纯新增不显示 hunk header
                                        : `<div class="diff-hunk-header">@@ -${oldRange} +${newRange} @@</div>`;

                                const linesHtml = hunk.lines
                                    .map((line: any) => {
                                        if (line.type === 'added') {
                                            const num = line.newNum != null ? String(line.newNum) : '';
                                            return `<div class="diff-line diff-line-added"><span class="diff-ln">${num}</span><span class="diff-op">+</span><span class="diff-content">${escapeHtml(line.content || ' ')}</span></div>`;
                                        } else if (line.type === 'removed') {
                                            const num = line.oldNum != null ? String(line.oldNum) : '';
                                            return `<div class="diff-line diff-line-removed"><span class="diff-ln">${num}</span><span class="diff-op">-</span><span class="diff-content">${escapeHtml(line.content || ' ')}</span></div>`;
                                        } else {
                                            const oldNum = line.oldNum != null ? String(line.oldNum) : '';
                                            return `<div class="diff-line diff-line-context"><span class="diff-ln">${oldNum}</span><span class="diff-op"> </span><span class="diff-content">${escapeHtml(line.content || ' ')}</span></div>`;
                                        }
                                    })
                                    .join('');

                                return `${headerHtml}${linesHtml}`;
                            })
                            .join('');

                        return `<div class="diff-change-block">
                    <div class="diff-change-label">${changeLabel} · <span class="diff-stat-add">+${change.addedLines}</span> <span class="diff-stat-remove">-${change.removedLines}</span></div>
                    <div class="diff-hunk-body">${hunksHtml}</div>
                </div>`;
                    })
                    .join('');

                return `<div class="changes-file-item">
                <div class="changes-file-header" data-collapse-id="${collapseId}" role="button" tabindex="0">
                    <svg class="changes-chevron" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
                    </svg>
                    <span class="changes-file-name">${escapeHtml(fileName)}</span>
                    <span class="changes-file-dir">${escapeHtml(dirPath)}</span>
                    <span class="changes-file-stats">
                        <span class="diff-stat-add">+${file.totalAdded}</span>
                        <span class="diff-stat-remove">-${file.totalRemoved}</span>
                    </span>
                </div>
                <div class="changes-file-body" id="${collapseId}">
                    ${diffsHtml}
                </div>
            </div>`;
            })
            .join('');

        panel.innerHTML = `
        <div class="changes-panel">
            <div class="changes-summary">
                <i class="fas fa-code-compare" style="margin-right:6px;color:#6b7280;"></i>
                <strong>${data.totalFiles}</strong> 个文件，
                <span class="diff-stat-add">+${data.totalAdded}</span>
                <span class="diff-stat-remove">-${data.totalRemoved}</span>
                <button class="changes-toggle-all-btn">收起全部</button>
            </div>
            <div class="changes-file-list">
                ${filesHtml}
            </div>
        </div>`;

        // Helper: check if any file is collapsed
        const hasCollapsed = (): boolean => {
            const bodies = panel.querySelectorAll('.changes-file-body');
            for (let i = 0; i < bodies.length; i++) {
                if ((bodies[i] as HTMLElement).style.display === 'none') return true;
            }
            return false;
        };

        // Helper: update toggle-all button text based on current state
        const updateToggleBtn = (): void => {
            const btn = panel.querySelector<HTMLButtonElement>('.changes-toggle-all-btn');
            if (btn) btn.textContent = hasCollapsed() ? '展开全部' : '收起全部';
        };

        // Bind toggle-all button
        const toggleBtn = panel.querySelector<HTMLButtonElement>('.changes-toggle-all-btn');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                const shouldExpand = hasCollapsed();
                panel.querySelectorAll('.changes-file-body').forEach((body) => {
                    (body as HTMLElement).style.display = shouldExpand ? '' : 'none';
                });
                panel.querySelectorAll('.changes-chevron').forEach((chevron) => {
                    (chevron as HTMLElement).style.transform = shouldExpand ? 'rotate(0deg)' : 'rotate(-90deg)';
                });
                updateToggleBtn();
            });
        }

        // Bind collapse/expand events
        panel.querySelectorAll('.changes-file-header').forEach((header) => {
            header.addEventListener('click', () => {
                const collapseId = (header as HTMLElement).dataset.collapseId;
                if (!collapseId) return;
                const body = panel.querySelector(`#${collapseId}`);
                const chevron = header.querySelector('.changes-chevron') as HTMLElement;
                if (!body) return;
                if (body.style.display === 'none') {
                    body.style.display = '';
                    if (chevron) chevron.style.transform = 'rotate(0deg)';
                } else {
                    body.style.display = 'none';
                    if (chevron) chevron.style.transform = 'rotate(-90deg)';
                }
                updateToggleBtn();
            });
        });
    }

    private _renderSessionMemoryPanel(): void {
        const root = this.shadowRoot;
        if (!root) return;
        const panel = root.querySelector<HTMLElement>('.tab-content[data-tab="session-memory"]');
        if (!panel) return;
        if (this._sessionMemoryHtml) {
            panel.innerHTML = `<div class="session-memory-content markdown-body">${this._sessionMemoryHtml}</div>`;
        } else {
            panel.innerHTML = `
            <div class="placeholder-content">
                <i class="fas fa-brain placeholder-icon"></i>
                <p>暂无任务记忆</p>
            </div>`;
        }
    }

    private _rebuildTabBar(): void {
        const root = this.shadowRoot;
        if (!root) return;
        const tabBar = root.querySelector<HTMLElement>('.tab-bar');
        if (!tabBar) return;
        const tabs = this._getTabs();
        tabBar.innerHTML = tabs
            .map((tab) => {
                const isActive = tab.id === this._activeTab;
                const iconExtra = tab.id === 'browser' && this._browserVisible ? ' browser-icon-active' : '';
                const label = this._getTabLabel(tab);
                return `<button class="tab-btn ${isActive ? 'tab-active' : ''}" data-tab="${tab.id}">
                <i class="fas ${tab.icon} text-xs${iconExtra}"></i>
                <span>${escapeHtml(label)}</span>
            </button>`;
            })
            .join('');
        tabBar.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const next = btn.dataset.tab as TabSpec['id'] | undefined;
                if (next) this._switchTab(next);
            });
        });
        // Ensure tab content elements exist for dynamic tabs
        const wrapper = root.querySelector<HTMLElement>('.tab-content-wrapper');
        if (wrapper) {
            for (const tab of tabs) {
                if (!root.querySelector(`.tab-content[data-tab="${tab.id}"]`)) {
                    const div = document.createElement('div');
                    div.className = 'tab-content';
                    div.dataset.tab = tab.id;
                    div.style.display = tab.id === this._activeTab ? '' : 'none';
                    wrapper.appendChild(div);
                }
            }
            // Remove dynamic tab content panels that are no longer visible
            const dynamicIds: Array<{ id: string; visible: boolean }> = [
                { id: 'task-plan', visible: this._taskPlanVisible },
                { id: 'session-memory', visible: this._sessionMemoryVisible }
            ];
            for (const { id, visible } of dynamicIds) {
                if (!visible) {
                    const panel = root.querySelector(`.tab-content[data-tab="${id}"]`);
                    if (panel) panel.remove();
                }
            }
        }

        // Ensure the active tab's panel is shown
        this._switchTab(this._activeTab);
    }

    /**
     * 外部调用：切换到指定的 tab。
     * 例如当任务计划为空时自动切到工作空间。
     */
    switchToTab(tabId: TabSpec['id']): void {
        this._switchTab(tabId);
    }

    // ----- Tab switching -----

    private _switchTab(tabId: TabSpec['id']): void {
        // 离开工作空间 tab 时自动关闭并保存编辑器
        if (tabId !== 'workspace' && this._fileExplorer.isEditorOpen()) {
            this._fileExplorer.closeEditor();
        }
        this._activeTab = tabId;
        const root = this.shadowRoot;
        if (!root) return;
        root.querySelectorAll<HTMLElement>('.tab-btn').forEach((btn) => {
            btn.classList.toggle('tab-active', btn.dataset.tab === tabId);
        });
        root.querySelectorAll<HTMLElement>('.tab-content').forEach((panel) => {
            panel.style.display = panel.dataset.tab === tabId ? '' : 'none';
        });
        if (tabId === 'workspace') {
            this._mountFileExplorer();
        } else if (tabId === 'browser') {
            this._mountBrowser();
        } else if (tabId === 'changes') {
            this.refreshChanges();
        }
    }

    private _mountFileExplorer(): void {
        const root = this.shadowRoot;
        if (!root) return;
        const panel = root.querySelector<HTMLElement>('.tab-content[data-tab="workspace"]');
        if (!panel) return;
        this._fileExplorer.mount(panel, root);
    }

    private _mountBrowser(): void {
        const root = this.shadowRoot;
        if (!root) return;
        const panel = root.querySelector<HTMLElement>('.tab-content[data-tab="browser"]');
        if (!panel) return;

        if (this._browser) {
            return;
        }

        // Initialize browser with taskId so it can be identified by BrowserController
        this._browser = new EmbeddedBrowser(panel, this._taskId || '');

        // Register with the preload bridge so main process IPC can reach this instance
        const browserAPI = (window as any).browserAPI;
        if (browserAPI) {
            this._browser.register(browserAPI);
        }

        // Listen for fullscreen toggle
        panel.addEventListener('browser-fullscreen-toggle', (e: any) => {
            this._isBrowserFullscreen = e.detail.isFullscreen;
            this._handleBrowserFullscreen(e.detail.isFullscreen);
        });

        // 标签页状态变更时同步浏览器活跃状态
        this._browser.onTabsChanged = () => {
            this._syncBrowserActiveState();
        };
    }

    private _handleBrowserFullscreen(isFullscreen: boolean): void {
        const root = this.shadowRoot;
        if (!root) return;

        const tabBar = root.querySelector<HTMLElement>('.tab-bar');

        if (isFullscreen) {
            // Remember current width before going fullscreen
            this._savedWidthBeforeFullscreen = this.style.width || this.offsetWidth + 'px';

            this.style.position = 'fixed';
            this.style.top = '0';
            this.style.left = '0';
            this.style.width = '100vw';
            this.style.height = '100vh';
            this.style.zIndex = '9999';

            if (tabBar) {
                tabBar.style.display = 'none';
            }
        } else {
            // Restore to previous width
            this.style.position = '';
            this.style.top = '';
            this.style.left = '';
            this.style.width = this._savedWidthBeforeFullscreen;
            this.style.height = '';
            this.style.zIndex = '';

            if (tabBar) {
                tabBar.style.display = '';
            }
        }
    }

    /** 外部可设置的标志：为 true 时 ensureBrowserReady 不自动切换 tab */
    public _suppressBrowserAutoSwitch = false;

    /**
     * Ensure the browser tab is active and the EmbeddedBrowser is mounted.
     * Called before any browser operation from tools.
     * @param autoSwitch 若为 false，则不自动切换到浏览器 tab（面板已展开时避免打断用户）
     */
    ensureBrowserReady(autoSwitch: boolean = true): void {
        const wasVisible = this._browserVisible;
        this._browserVisible = true;
        if (!wasVisible) {
            this._rebuildTabBar();
            this._dispatchBrowserVisibilityChanged();
        }
        const shouldSwitch = autoSwitch && !this._suppressBrowserAutoSwitch;
        if (shouldSwitch && this._activeTab !== 'browser') {
            this._switchTab('browser');
        }
        if (!this._browser) {
            this._mountBrowser();
        }
    }

    /**
     * 销毁浏览器实例并释放关联资源（webview、CDP 等）。
     * 任务空闲超时后由 TaskView 调用，减少持续内存开销。
     * 下次工具调用时 ensureBrowserReady() 会重新创建。
     */
    destroyBrowser(): void {
        if (this._browser) {
            // 清除回调，避免销毁过程中触发状态同步
            this._browser.onTabsChanged = null;
            // Unregister from the preload bridge before destroying
            const browserAPI = (window as any).browserAPI;
            if (browserAPI) {
                this._browser.unregister(browserAPI);
            }
            this._browser.destroy();
            this._browser = null;
        }
        this._browserVisible = false;
        this._rebuildTabBar();
        this._dispatchBrowserVisibilityChanged();
        // 浏览器被回收后，若当前正在浏览器 tab 上则切到工作空间
        if (this._activeTab === 'browser') {
            this._switchTab('workspace');
        }
    }

    /**
     * 浏览器可见性变化时，通过 document 级事件通知侧边栏任务列表刷新浏览器活跃图标。
     */
    private _dispatchBrowserVisibilityChanged(): void {
        if (!this._taskId) return;
        document.dispatchEvent(
            new CustomEvent('browser-visibility-changed', {
                detail: { taskId: this._taskId, visible: this._browserVisible }
            })
        );
    }

    /**
     * 外部调用：在浏览器中导航到指定 URL（供 agent 工具通过 IPC 调用）。
     * 自动切换到浏览器标签并展开侧边栏。
     */
    browserNavigate(url: string): void {
        this.ensureBrowserReady();
        if (this._browser) {
            this._browser.navigateTo(url);
        }
        this.dispatchEvent(new CustomEvent('browser-action', { bubbles: true, composed: true }));
    }

    /**
     * 外部调用：获取浏览器状态。
     */
    browserGetState(): { currentUrl: string; canGoBack: boolean; canGoForward: boolean; active: boolean } {
        if (!this._browser) {
            return { currentUrl: '', canGoBack: false, canGoForward: false, active: false };
        }
        const s = this._browser.getState();
        return { currentUrl: s.currentUrl, canGoBack: s.canGoBack, canGoForward: s.canGoForward, active: true };
    }

    /**
     * 外部调用：在浏览器中执行 JavaScript。
     */
    browserExecuteScript(script: string): Promise<any> {
        this.ensureBrowserReady();
        if (!this._browser) return Promise.reject('Browser not initialized');
        return this._browser.executeJavaScript(script);
    }

    /**
     * 外部调用：浏览器后退。
     */
    browserGoBack(): void {
        this.ensureBrowserReady();
        this._browser?.goBack();
    }

    /**
     * 外部调用：浏览器前进。
     */
    browserGoForward(): void {
        this.ensureBrowserReady();
        this._browser?.goForward();
    }

    /**
     * 外部调用：浏览器刷新。
     */
    browserRefresh(): void {
        this.ensureBrowserReady();
        this._browser?.refresh();
    }

    /**
     * 外部调用：列出所有浏览器标签页。
     */
    browserListTabs(): { id: number; title: string; url: string; active: boolean }[] {
        this.ensureBrowserReady();
        if (!this._browser) return [];
        return this._browser.listTabs();
    }

    /**
     * 外部调用：切换到指定标签页。
     */
    browserSwitchTab(tabId: number): void {
        this.ensureBrowserReady();
        this._browser?.switchToTab(tabId);
    }

    /**
     * 外部调用：关闭指定标签页。
     */
    browserCloseTab(tabId: number): void {
        this.ensureBrowserReady();
        this._browser?.closeTab(tabId);
    }

    /**
     * 外部调用：新建标签页并导航到指定 URL。
     */
    browserAddTab(url: string): number {
        this.ensureBrowserReady();
        if (!this._browser) return -1;
        return this._browser.addTab(url);
    }

    /**
     * 外部调用：获取当前活动 webview 的 webContentsId，供 main process 通过 CDP 控制。
     */
    browserGetWebContentsId(): number | null {
        this.ensureBrowserReady();
        if (!this._browser) return null;
        return this._browser.getWebContentsId();
    }

    /**
     * 外部调用：聚焦当前活动 webview，用于 pressKey 等键盘输入工具。
     */
    browserFocusActiveWebview(): boolean {
        this.ensureBrowserReady();
        return this._browser?.focusActiveWebview() ?? false;
    }

    /**
     * 外部调用：截取当前活动标签页的截图（data URL）。
     */
    async browserCapturePage(): Promise<string | null> {
        if (!this._browser) return null;
        return this._browser.capturePage();
    }

    /**
     * 外部调用：获取浏览器标签页总数。
     */
    browserGetTabCount(): number {
        if (!this._browser) return 0;
        return this._browser.getTabCount();
    }

    /**
     * 外部调用：检查浏览器是否已可见（即 agent 已使用过浏览器工具）。
     */
    isBrowserVisible(): boolean {
        return this._browserVisible;
    }

    /**
     * 根据浏览器标签页状态同步 _browserVisible。
     * 当所有标签页都只有 about:blank 时，浏览器视为非活跃状态（无绿色图标/无画中画）。
     */
    private _syncBrowserActiveState(): void {
        if (!this._browser) return;
        const hasContent = this._browser.hasActiveContent();
        if (this._browserVisible !== hasContent) {
            this._browserVisible = hasContent;
            this._rebuildTabBar();
            this._dispatchBrowserVisibilityChanged();
            // 如果浏览器变为非活跃且当前正在浏览器 tab，切回工作空间
            if (!hasContent && this._activeTab === 'browser') {
                this._switchTab('workspace');
            }
        }
    }

    /**
     * 侧边栏移到屏幕外时调用：确保浏览器 tab 内容面板不被 display:none 隐藏，
     * 否则 Chromium 会暂停 webview 的 BeginFrame 调度，导致截图/CDP 操作挂起。
     * 使用绝对定位撑满容器，不影响其他 tab 面板的 flex 布局。
     */
    keepBrowserPanelRenderable(): void {
        if (!this._browserVisible) return;
        const root = this.shadowRoot;
        if (!root) return;
        const browserPanel = root.querySelector<HTMLElement>('.tab-content[data-tab="browser"]');
        if (!browserPanel || browserPanel.style.display !== 'none') return;
        browserPanel.style.display = '';
        browserPanel.style.position = 'absolute';
        browserPanel.style.inset = '0';
        browserPanel.dataset.keepAlive = '1';
    }

    /**
     * 侧边栏恢复到正常位置时调用：清理 keepBrowserPanelRenderable 设置的临时样式，
     * 让 _switchTab 的 display 控制恢复正常。
     */
    restoreBrowserPanelLayout(): void {
        const root = this.shadowRoot;
        if (!root) return;
        const browserPanel = root.querySelector<HTMLElement>('.tab-content[data-tab="browser"]');
        if (!browserPanel || !browserPanel.dataset.keepAlive) return;
        delete browserPanel.dataset.keepAlive;
        browserPanel.style.position = '';
        browserPanel.style.inset = '';
        if (this._activeTab !== 'browser') {
            browserPanel.style.display = 'none';
        }
    }

    /**
     * 外部调用：获取当前活动标签页的标题。
     */
    browserGetActiveTabTitle(): string {
        if (!this._browser) return '';
        return this._browser.getActiveTabTitle();
    }

    /**
     * 外部调用：获取当前活动标签页的 URL。
     */
    browserGetActiveTabUrl(): string {
        if (!this._browser) return '';
        return this._browser.getActiveTabUrl();
    }

    // ----- Timer (for in_progress durations) -----

    private _scheduleTick(): void {
        const hasInProgress = this._taskTodos.some((t) => t.status === 'in_progress');

        if (!hasInProgress) {
            this._stopTick();
            return;
        }
        if (this._tickTimer !== null) return;
        this._tickTimer = window.setInterval(() => this._updateRunningDurations(), 1000);
    }

    private _stopTick(): void {
        if (this._tickTimer !== null) {
            window.clearInterval(this._tickTimer);
            this._tickTimer = null;
        }
    }

    private _updateRunningDurations(): void {
        const root = this.shadowRoot;
        if (!root) return;
        const now = Date.now();
        const nodes = root.querySelectorAll<HTMLElement>('.todo-duration[data-running="1"]');
        if (nodes.length === 0) {
            this._stopTick();
            return;
        }
        nodes.forEach((node) => {
            const startIso = node.dataset.start;
            if (!startIso) return;
            const start = Date.parse(startIso);
            if (Number.isNaN(start)) return;
            node.innerHTML = `<i class="fas fa-clock" style="font-size:9px;margin-right:2px;"></i> ${formatDuration(now - start)}`;
        });
    }

    // ----- Task Plan rendering -----

    private _renderTodoItem(todo: TaskTodoLike | GlobalTodoLike, _opts: { showPriority?: boolean } = {}): string {
        const isCompleted = todo.status === 'completed';
        const title = todo.title || todo.content || '';

        const now = Date.now();
        const durationMs = computeDurationMs(todo, now);
        let durationHtml = '';
        if (durationMs !== null) {
            if (todo.status === 'in_progress') {
                const startIso = todo.started_at || todo.updated_at || todo.created_at || '';
                durationHtml = `<span class="todo-duration todo-duration-running"
                    data-running="1" data-start="${escapeHtml(startIso)}"
                    title="已执行 ${escapeHtml(formatDuration(durationMs))}">
                    <i class="fas fa-clock" style="font-size:9px;margin-right:2px;"></i>
                    ${escapeHtml(formatDuration(durationMs))}
                </span>`;
            } else if (todo.status === 'completed') {
                durationHtml = `<span class="todo-duration todo-duration-done"
                    title="用时 ${escapeHtml(formatDuration(durationMs))}">
                    <i class="fas fa-check" style="font-size:9px;margin-right:2px;"></i>
                    ${escapeHtml(formatDuration(durationMs))}
                </span>`;
            }
        }

        const statusCls = todo.status === 'in_progress' ? 'todo-in-progress' : isCompleted ? 'todo-completed' : '';

        return `
        <div class="todo-item ${statusCls}">
            <span class="todo-status-icon">${statusIcon(todo.status)}</span>
            <div class="todo-body">
                <span class="todo-title">${escapeHtml(title)}</span>
                ${durationHtml ? `<div class="todo-meta-row">${durationHtml}</div>` : ''}
            </div>
        </div>`;
    }

    private _renderTaskPlanPanel(options: RenderTaskPlanOptions = {}): void {
        const root = this.shadowRoot;
        if (!root) return;
        const panel = root.querySelector<HTMLElement>('.tab-content[data-tab="task-plan"]');
        if (!panel) return;
        this._rememberGoalTimelineState(panel);
        this._rememberGoalEvalState(panel);
        if (options.autoCollapseCurrentGoalDetails && this._goalState) {
            this._setGoalDisclosureState(this._goalState.id, {
                evaluationOpen: false,
                timelineOpen: false,
                autoCollapsedAfterTodoUpdate: true
            });
        }

        if (this._taskTodos.length === 0 && !this._goalState && !this._goalCreating) {
            panel.innerHTML = '';
            return;
        }

        const todoHtml = this._renderTaskTodoListHtml();
        const showGoalCreation = this._goalCreating && !hasUnfinishedGoalStatus(this._goalState?.status);
        const suggestionHtml = this.hasGoalSuggestion() ? this._renderGoalSuggestion() : '';
        const goalHtml = showGoalCreation
            ? this._renderGoalCreationForm()
            : this._goalState
              ? this._renderGoalSection(this._goalState)
              : '';
        const html = `
        ${todoHtml}
        ${suggestionHtml}
        ${goalHtml}`;
        panel.innerHTML = html;
    }

    private _renderTaskTodoListHtml(): string {
        return this._taskTodos.length > 0
            ? `<section class="task-progress-section task-todo-section">
                <div class="task-progress-heading">${escapeHtml(t('renderer.taskartifacts.todo.title'))}</div>
                <div class="task-plan-list">
                    ${this._taskTodos.map((t) => this._renderTodoItem(t)).join('<div class="todo-separator"></div>')}
                </div>
            </section>`
            : '';
    }

    private _renderTaskTodosOnly(): void {
        const root = this.shadowRoot;
        if (!root) return;
        const panel = root.querySelector<HTMLElement>('.tab-content[data-tab="task-plan"]');
        if (!panel) return;
        if (!panel.querySelector('.goal-section, .goal-creation-section')) {
            this._renderTaskPlanPanel();
            return;
        }

        const html = this._renderTaskTodoListHtml();
        const existing = panel.querySelector<HTMLElement>('.task-todo-section');
        if (existing) {
            if (html) {
                existing.outerHTML = html;
            } else {
                existing.remove();
            }
            return;
        }
        if (html) {
            panel.insertAdjacentHTML('afterbegin', html);
        }
    }

    private _renderGoalSuggestion(): string {
        return `
        <section class="goal-suggestion-section">
            <div class="goal-suggestion-copy">
                <i class="fa-solid fa-bullseye"></i>
                <span>${escapeHtml(t('goal.renderer.suggestion'))}</span>
            </div>
            <div class="goal-suggestion-actions">
                <button type="button" class="goal-action-btn goal-action-primary" data-goal-action="suggest-create">${escapeHtml(t('goal.renderer.suggestion.accept'))}</button>
                <button type="button" class="goal-action-btn" data-goal-action="suggest-dismiss">${escapeHtml(t('goal.renderer.suggestion.dismiss'))}</button>
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
        const root = this.shadowRoot;
        const container = panel ?? root?.querySelector<HTMLElement>('.tab-content[data-tab="task-plan"]');
        const timeline = container?.querySelector<HTMLDetailsElement>('details.goal-timeline');
        const goalId = timeline?.closest<HTMLElement>('[data-goal-id]')?.dataset.goalId;
        if (timeline && goalId) {
            this._setGoalDisclosureState(goalId, { timelineOpen: timeline.hasAttribute('open') });
        }
    }

    private _rememberGoalEvalState(panel?: HTMLElement): void {
        const root = this.shadowRoot;
        const container = panel ?? root?.querySelector<HTMLElement>('.tab-content[data-tab="task-plan"]');
        const evalDetails = container?.querySelector<HTMLDetailsElement>('details.goal-eval-stack');
        const goalId = evalDetails?.closest<HTMLElement>('[data-goal-id]')?.dataset.goalId;
        if (evalDetails && goalId) {
            this._setGoalDisclosureState(goalId, { evaluationOpen: evalDetails.hasAttribute('open') });
        }
    }

    private _formatGoalLabel(prefix: string, value: string): string {
        const key = `${prefix}.${value}`;
        const label = t(key);
        return label === key ? value : label;
    }

    private _formatGoalEvalStatus(status?: string): string {
        if (!status) return t('goal.eval.status.unknown');
        return this._formatGoalLabel('goal.label.evaluation', status);
    }

    private _renderGoalEvalEvidence(evidence?: string[]): string {
        const visibleEvidence = Array.isArray(evidence)
            ? evidence.filter((item) => typeof item === 'string' && item.trim().length > 0)
            : [];
        if (visibleEvidence.length === 0) return '';
        return `<div class="goal-evaluation-evidence">
            <div class="goal-evaluation-evidence-title">${escapeHtml(t('goal.eval.evidence'))}</div>
            <ul>${visibleEvidence.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </div>`;
    }

    private _renderGoalEvalProgressCard(): string {
        const progress = this._goalEvalProgress;
        if (!progress) return '';
        return this._renderGoalEvaluationCard(progress, 'live');
    }

    private _renderGoalEvaluationMeta(evaluation: GoalEvaluationLike): string {
        const metaItems: string[] = [];
        if (typeof evaluation.goalRevision === 'number') {
            metaItems.push(t('goal.label.revision', { revision: evaluation.goalRevision }));
        }
        const timestamp = evaluation.evaluatedAt || evaluation.updatedAt || evaluation.startedAt;
        if (timestamp) {
            metaItems.push(formatLocalDateTime(timestamp));
        }
        return metaItems.length > 0
            ? `<div class="goal-evaluation-title" style="font-weight:400;color:#6b7280;">${escapeHtml(metaItems.join(' · '))}</div>`
            : '';
    }

    private _renderGoalEvaluationCard(evaluation: GoalEvaluationLike, kind: 'live' | 'result'): string {
        const phase = evaluation.phase === 'end' ? 'end' : 'start';
        const status = typeof evaluation.status === 'string' ? evaluation.status : '';
        const statusLabel = this._formatGoalEvalStatus(status);
        const title = phase === 'start' ? t('goal.eval.running') : t('goal.eval.result_title', { status: statusLabel });
        const message = typeof evaluation.message === 'string' ? evaluation.message.trim() : '';
        const icon =
            phase === 'start'
                ? 'fa-circle-notch fa-spin'
                : status === 'met'
                  ? 'fa-circle-check'
                  : status === 'blocked' || status === 'error'
                    ? 'fa-triangle-exclamation'
                    : 'fa-circle-info';
        return `<div class="goal-evaluation goal-evaluation-${kind} goal-evaluation-${escapeHtml(status || 'running')}">
            <div class="goal-evaluation-title">
                <i class="fa-solid ${icon}" aria-hidden="true"></i>
                <span>${escapeHtml(title)}</span>
            </div>
            ${this._renderGoalEvaluationMeta(evaluation)}
            ${message ? `<div>${escapeHtml(message)}</div>` : ''}
            ${this._renderGoalEvalEvidence(evaluation.evidence)}
            ${evaluation.nextPrompt && evaluation.status === 'not_met' ? `<div class="goal-evaluation-next-step"><span class="next-step-label">→ ${escapeHtml(t('goal.panel.next_step'))}:</span> <span class="next-step-text">${escapeHtml(evaluation.nextPrompt)}</span></div>` : ''}
        </div>`;
    }

    private _renderGoalLatestEvaluationCard(goal: GoalRenderSummaryLike): string {
        const evaluations = Array.isArray(goal.evaluations) ? goal.evaluations : [];
        const latestEvaluation = evaluations[evaluations.length - 1];
        if (latestEvaluation) {
            return this._renderGoalEvaluationCard(latestEvaluation, 'result');
        }
        return this._renderGoalLastEvaluationCard(goal);
    }

    private _renderGoalLastEvaluationCard(goal: GoalRenderSummaryLike): string {
        if (!goal.lastEvaluation) return '';
        return this._renderGoalEvaluationCard(
            {
                phase: 'end',
                status: goal.lastEvaluation.status,
                message: goal.lastEvaluation.reason,
                evaluatedAt: goal.lastEvaluation.evaluatedAt,
                updatedAt: goal.lastEvaluation.evaluatedAt,
                ...(goal.lastEvaluation.evaluationId ? { evaluationId: goal.lastEvaluation.evaluationId } : {}),
                ...(goal.lastEvaluation.goalId ? { goalId: goal.lastEvaluation.goalId } : {}),
                ...(typeof goal.lastEvaluation.goalRevision === 'number'
                    ? { goalRevision: goal.lastEvaluation.goalRevision }
                    : {}),
                ...(goal.lastEvaluation.evidence ? { evidence: goal.lastEvaluation.evidence } : {}),
                ...(goal.lastEvaluation.nextPrompt ? { nextPrompt: goal.lastEvaluation.nextPrompt } : {})
            },
            'result'
        );
    }

    private _renderGoalEvaluationStackContent(goal: GoalRenderSummaryLike): string {
        return this._renderGoalEvalProgressCard() || this._renderGoalLatestEvaluationCard(goal);
    }

    private _renderGoalEvaluationStack(): void {
        if (!this._goalState) return;
        const stack = this.shadowRoot?.querySelector<HTMLElement>('.goal-evaluation-stack');
        if (!stack) {
            this._renderTaskPlanPanel();
            return;
        }
        stack.innerHTML = this._renderGoalEvaluationStackContent(this._goalState);
    }

    private _renderGoalCreationForm(): string {
        const tt = this._getTOrCreate();
        return `
        <section class="goal-creation-section">
            <div class="goal-creation-header">
                <i class="fa-solid fa-bullseye" style="color:#7C4DFF;font-size:14px;"></i>
                <div>
                    <div style="font-weight:500;font-size:13px;color:var(--color-text-primary)">${escapeHtml(tt('goal.renderer.followup_create_title'))}</div>
                    <div class="goal-creation-subtitle">${escapeHtml(tt('goal.renderer.followup_create_description'))}</div>
                </div>
            </div>
            <div class="goal-creation-body">
                <div class="goal-form-group">
                    <label class="goal-form-label">${escapeHtml(tt('goal.renderer.objective_label'))}</label>
                    <textarea
                        class="goal-form-textarea"
                        data-goal-creation-input="objective"
                        placeholder="${escapeHtml(tt('goal.renderer.followup_placeholder'))}"
                        rows="3"
                    >${escapeHtml(this._goalCreationObjectiveDraft)}</textarea>
                </div>
            </div>
            <div class="goal-creation-footer">
                <button type="button" class="goal-action-btn" data-goal-action="creation-cancel">${escapeHtml(tt('common.cancel'))}</button>
                <button type="button" class="goal-action-btn goal-action-primary" data-goal-action="creation-create">${escapeHtml(tt('goal.renderer.start_followup'))}</button>
            </div>
        </section>`;
    }

    private _getTOrCreate(): any {
        return t;
    }

    private _renderGoalSection(goal: GoalRenderSummaryLike): string {
        const actionLabels: Record<GoalActionId, string> = {
            'edit-start': t('goal.renderer.edit'),
            pause: t('goal.renderer.pause'),
            resume: t('goal.renderer.resume'),
            'create-new': t('goal.renderer.create'),
            clear: t('goal.renderer.clear')
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
                <summary>${escapeHtml(t('goal.panel.latest_evaluation'))}</summary>
                <div class="goal-evaluation-stack">${evaluationStackContent}</div>
            </details>`
            : '';
        const timelineEvents =
            goal.objectiveEvents && goal.objectiveEvents.length > 0 ? goal.objectiveEvents : (goal.recentEvents ?? []);
        const timelineHtml =
            timelineEvents.length > 0
                ? `<details class="goal-timeline"${disclosureState.timelineOpen ? ' open' : ''}>
                    <summary>${escapeHtml(t('goal.renderer.timeline'))}</summary>
                    <div class="goal-timeline-list">${timelineEvents
                        .map((event) => {
                            const eventLabel = this._formatGoalLabel('goal.label.event', event.type);
                            const eventRevision = t('goal.label.revision', { revision: event.revision });
                            const objectiveLabel = t('goal.renderer.timeline.objective');
                            const previousLabel = t('goal.renderer.timeline.previous');
                            const noObjective = t('goal.renderer.timeline.no_objective');
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
                <label class="goal-form-label">${escapeHtml(t('goal.renderer.objective_label'))}</label>
                <textarea class="goal-objective-input" data-goal-edit-input="1">${escapeHtml(goal.objective || '')}</textarea>
                <div class="goal-editor-actions">
                    <button type="button" class="goal-action-btn" data-goal-action="edit-cancel">${escapeHtml(t('common.cancel'))}</button>
                    <button type="button" class="goal-action-btn" data-goal-action="edit-save"${this._goalEditPending ? ' disabled' : ''}>${escapeHtml(t('goal.renderer.save'))}</button>
                </div>
            </div>`
            : `<button type="button" class="goal-objective" data-goal-action="edit-start"${editUnavailableMessage ? ' aria-disabled="true"' : ''}>${escapeHtml(goal.objective || '')}</button>`;
        const statusLabel = this._formatGoalLabel('goal.label.status', goal.status);
        const revisionLabel = t('goal.label.revision', { revision: goal.revision });
        return `
        <section class="goal-section" data-goal-id="${escapeHtml(goal.id)}">
            <div class="goal-header">
                <div class="goal-title">
                    <span>${escapeHtml(t('goal.renderer.followup_title'))}</span>
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
                    <span>${escapeHtml(t('goal.renderer.attempts'))}</span>
                    <span>${escapeHtml(attemptsText)}</span>
                </div>
            </div>
            ${criteriaHtml}
            ${evaluationHtml}
            ${
                goal.pendingContinuation
                    ? `<div class="goal-continuation">${escapeHtml(t('goal.renderer.continuation_pending'))}</div>`
                    : ''
            }
            ${timelineHtml}
        </section>`;
    }

    private _getTaskId(): string {
        const attr = this.getAttribute('task-id');
        if (attr) return attr;
        const match = /^task-(.*)-artifacts$/.exec(this.id);
        return match?.[1] ?? '';
    }

    private _emitGoalTimelineAnchor(anchor: Element): void {
        const messageId = anchor.getAttribute('data-goal-message-id') || '';
        if (!messageId) return;
        this.dispatchEvent(
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
        if (!anchor || !this.shadowRoot?.contains(anchor)) return;
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
        const anchor = event.target instanceof Element ? event.target.closest('[data-goal-message-id]') : null;
        if (anchor && this.shadowRoot?.contains(anchor)) {
            event.preventDefault();
            this._emitGoalTimelineAnchor(anchor);
            return;
        }

        const target = event.target instanceof Element ? event.target.closest('[data-goal-action]') : null;
        if (!target || !this.shadowRoot?.contains(target)) return;
        event.preventDefault();
        const action = target.getAttribute('data-goal-action');
        const taskId = this._getTaskId();
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
                this._renderTaskPlanPanel();
                return;
            } else if (action === 'suggest-dismiss') {
                this._goalSuggestionDismissed = true;
                this._renderTaskPlanPanel();
                return;
            } else if (action === 'creation-cancel') {
                this._goalCreating = false;
                this._goalCreationObjectiveDraft = '';
                this._syncTaskPlanVisibility();
                this._renderTaskPlanPanel();
                return;
            } else if (action === 'creation-create') {
                const objectiveInput = this.shadowRoot?.querySelector<HTMLTextAreaElement>(
                    '[data-goal-creation-input="objective"]'
                );
                const rawObjective = objectiveInput?.value ?? this._goalCreationObjectiveDraft;
                this._goalCreationObjectiveDraft = rawObjective;
                const objective = rawObjective.trim();
                if (!objective) {
                    window.alert(t('goal.renderer.empty_objective'));
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
                            this._renderTaskPlanPanel();
                            this.dispatchEvent(
                                new CustomEvent('goal-state-changed', { bubbles: true, composed: true })
                            );
                            return;
                        }
                        window.alert(
                            t(createResult.messageKey || 'goal.error.unknown', createResult.messageArgs || {})
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
                    if (isRunningTaskArtifactsContext(this) && hasValidCreateEvent) {
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
                    this.dispatchEvent(new CustomEvent('goal-state-changed', { bubbles: true, composed: true }));
                    return;
                } catch (error: any) {
                    const message = error?.message || String(error);
                    window.alert(t('goal.renderer.action_failed', { message }));
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
                this._renderTaskPlanPanel();
                return;
            } else if (action === 'edit-cancel') {
                this._goalEditing = false;
                this._renderTaskPlanPanel();
                return;
            } else if (action === 'edit-save') {
                const editUnavailableMessage = this._getGoalEditUnavailableMessage();
                if (editUnavailableMessage) {
                    window.alert(editUnavailableMessage);
                    return;
                }
                const currentObjective = this._goalState?.objective || '';
                const input = this.shadowRoot?.querySelector<HTMLTextAreaElement>('[data-goal-edit-input="1"]');
                const trimmedObjective = input?.value.trim() ?? '';
                if (!trimmedObjective) {
                    window.alert(t('goal.renderer.empty_objective'));
                    return;
                }
                const objectiveChanged = trimmedObjective !== currentObjective.trim();
                if (!objectiveChanged) {
                    this._goalEditing = false;
                    this._renderTaskPlanPanel();
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
                window.alert(t(result.messageKey || 'goal.error.unknown', result.messageArgs || {}));
                return;
            }
            if (result?.summary) {
                // 终态（含 cleared）也保留显示，不再置 null
                this._goalState = result.summary;
                this._goalEditing = false;
                this._syncTaskPlanVisibility();
                this._renderTaskPlanPanel();
                if (
                    action === 'edit-save' &&
                    isRunningTaskArtifactsContext(this) &&
                    result.summary.status === 'active'
                ) {
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
            this.dispatchEvent(new CustomEvent('goal-state-changed', { bubbles: true, composed: true }));
            if (action === 'edit-save' && result?.summary) {
                const messageId = getLatestGoalDisplayMessageEvent(result.summary, 'edit')?.displayMessageId ?? '';
                if (messageId) {
                    this.dispatchEvent(
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
            window.alert(t('goal.renderer.action_failed', { message }));
        } finally {
            if (button) button.disabled = false;
        }
    };

    // ========================================================================
    // Main render
    // ========================================================================

    private render(): void {
        // 防止 innerHTML 替换期间出现白屏闪烁
        const isDark = this.dataset.theme === 'dark';
        if (isDark) {
            this.style.backgroundColor = '#1e1e1e';
        }

        const tabs = this._getTabs();
        const tabsHTML = tabs
            .map((tab) => {
                const isActive = tab.id === this._activeTab;
                const iconExtra = tab.id === 'browser' && this._browserVisible ? ' browser-icon-active' : '';
                const label = this._getTabLabel(tab);
                return `<button class="tab-btn ${isActive ? 'tab-active' : ''}" data-tab="${tab.id}">
                <i class="fas ${tab.icon} text-xs${iconExtra}"></i>
                <span>${escapeHtml(label)}</span>
            </button>`;
            })
            .join('');

        const placeholderLabel = (tab: TabSpec) => escapeHtml(this._getTabLabel(tab));
        const placeholderHTML = (tab: TabSpec) => `
            <div class="placeholder-content">
                <i class="fas ${tab.icon} placeholder-icon"></i>
                <p>${placeholderLabel(tab)}内容占位符</p>
            </div>`;

        const contentHTML = tabs
            .map((tab) => {
                const isActive = tab.id === this._activeTab;
                let inner = '';
                if (
                    tab.id === 'task-plan' ||
                    tab.id === 'workspace' ||
                    tab.id === 'browser' ||
                    tab.id === 'changes' ||
                    tab.id === 'session-memory'
                ) {
                    inner = '';
                } else {
                    inner = placeholderHTML(tab);
                }
                return `<div class="tab-content" data-tab="${tab.id}" style="display: ${isActive ? '' : 'none'}">
                ${inner}
            </div>`;
            })
            .join('');

        const faRules = extractFontAwesomeRulesText();

        this.shadowRoot!.innerHTML = `
        <style>
            ${faRules}

            :host {
                display: flex;
                flex-direction: column;
                height: 100%;
                width: 100%;
                background: #fafafa;
            }

            :host([data-theme="dark"]) {
                background: #1e1e1e !important;
                color: #cccccc !important;
            }

            .tab-bar {
                display: flex;
                padding: 0 4px;
                min-height: 40px;
                align-items: flex-end;
            }

            .tab-bar-container {
                display: flex;
                flex: 1;
                overflow: hidden;
                min-width: 0;
            }

            .tab-bar-scrollable {
                display: flex;
                overflow-x: auto;
                scrollbar-width: none; /* Firefox */
                -ms-overflow-style: none; /* IE and Edge */
                flex: 1;
                min-width: 0;
            }
            .tab-bar-scrollable::-webkit-scrollbar {
                display: none; /* Chrome, Safari, Opera */
            }

            .tab-header {
                display: flex;
                align-items: stretch;
                flex-shrink: 0;
                border-bottom: 1px solid #e5e7eb;
                background: white;
            }

            .tab-scroll-btn {
                display: none;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 100%;
                min-height: 40px;
                background: white;
                border: none;
                cursor: pointer;
                color: #6b7280;
                flex-shrink: 0;
                z-index: 10;
            }
            .tab-scroll-btn:hover {
                color: #374151;
                background: #f3f4f6;
            }
            .tab-scroll-btn-left {
                border-right: 1px solid #e5e7eb;
            }
            .tab-scroll-btn-right {
                border-left: 1px solid #e5e7eb;
            }

            .tab-btn {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 10px 12px;
                font-size: 12px;
                color: #6b7280;
                background: transparent;
                border: none;
                border-bottom: 2px solid transparent;
                cursor: pointer;
                transition: all 0.2s;
                white-space: nowrap;
                flex-shrink: 0; /* tab 按钮不收缩 */
            }
            .tab-btn:hover {
                color: #374151;
                background: #f3f4f6;
            }
            .tab-btn.tab-active {
                color: #2563eb;
                border-bottom-color: #2563eb;
                font-weight: 500;
            }

            @keyframes browser-pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.4; }
            }
            .browser-icon-active {
                animation: browser-pulse 1.5s ease-in-out infinite;
                color: #10b981;
            }
            .tab-btn.tab-active .browser-icon-active {
                color: #10b981;
            }

            .tab-content-wrapper {
                flex: 1;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                position: relative;
            }

            .tab-content {
                flex: 1;
                overflow-y: auto;
            }
            .tab-content[data-tab="browser"] {
                overflow: hidden;
            }

            .placeholder-content {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100%;
                color: #9ca3af;
                gap: 8px;
                padding: 16px;
                text-align: center;
            }
            .placeholder-icon {
                font-size: 32px;
                opacity: 0.4;
            }
            .placeholder-content p {
                font-size: 13px;
                margin: 0;
            }
            .placeholder-hint {
                font-size: 11px !important;
                color: #b0b6c0;
                max-width: 220px;
                line-height: 1.5;
            }
            .placeholder-hint code {
                background: #f1f5f9;
                padding: 1px 4px;
                border-radius: 3px;
                font-size: 10px;
                color: #6b7280;
            }

            /* Task progress panel — flat sections (no card wrapping) */
            .task-progress-section {
                margin: 0 12px;
                padding: 12px 0;
                border-top: 1px solid #e5e7eb;
            }

            .task-progress-section:first-child,
            .goal-section:first-child,
            .goal-creation-section:first-child,
            .goal-suggestion-section:first-child {
                border-top: 0;
            }

            .task-progress-heading {
                margin: 0 4px 6px;
                font-size: 12px;
                font-weight: 600;
                line-height: 1.4;
                color: #374151;
            }

            .task-plan-list {
                display: flex;
                flex-direction: column;
                padding: 0;
            }

            .todo-separator {
                height: 1px;
                background: #f1f5f9;
                margin: 0 4px;
            }

            .todo-item {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px 4px;
            }

            .todo-status-icon {
                flex-shrink: 0;
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .todo-body {
                flex: 1;
                min-width: 0;
            }
            .todo-title {
                font-size: 13px;
                font-weight: 500;
                line-height: 1.5;
                color: #1f2937;
                word-break: break-word;
            }
            .todo-completed .todo-title {
                text-decoration: line-through;
                color: #9ca3af;
                font-weight: 400;
            }

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

            .goal-evaluation-next-step {
                margin-top: 5px;
                padding: 4px 6px;
                background: #fefce8;
                border-radius: 4px;
                font-size: 10px;
                line-height: 1.4;
            }
            .goal-evaluation-next-step .next-step-label {
                font-weight: 600;
                color: #a16207;
            }
            .goal-evaluation-next-step .next-step-text {
                color: #713f12;
            }

            :host([data-theme="dark"]) .goal-evaluation-next-step {
                background: #2b2500;
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

            .todo-meta-row {
                display: flex;
                gap: 6px;
                margin-top: 4px;
                flex-wrap: wrap;
            }

            .todo-duration {
                display: inline-flex;
                align-items: center;
                font-size: 11px;
                line-height: 1;
                font-weight: 500;
                font-variant-numeric: tabular-nums;
            }
            .todo-duration-running {
                color: #3b82f6;
            }
            .todo-duration-done {
                color: #10b981;
            }

            /* Session memory styles */
            .session-memory-content {
                padding: 16px;
                font-size: 13px;
                line-height: 1.6;
                color: #1f2937;
                overflow-wrap: break-word;
            }
            .session-memory-content h1 {
                font-size: 16px;
                font-weight: 700;
                margin: 16px 0 8px;
                padding-bottom: 4px;
                border-bottom: 1px solid #e5e7eb;
                color: #111827;
            }
            .session-memory-content h1:first-child {
                margin-top: 0;
            }
            .session-memory-content h2 {
                font-size: 14px;
                font-weight: 600;
                margin: 12px 0 6px;
                color: #1f2937;
            }
            .session-memory-content p {
                margin: 4px 0;
            }
            .session-memory-content em {
                color: #6b7280;
                font-style: italic;
            }
            .session-memory-content ul, .session-memory-content ol {
                padding-left: 20px;
                margin: 4px 0;
            }
            .session-memory-content li {
                margin: 2px 0;
            }
            .session-memory-content code {
                background: #f1f5f9;
                padding: 1px 4px;
                border-radius: 3px;
                font-size: 12px;
                color: #334155;
            }
            .session-memory-content pre {
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                border-radius: 6px;
                padding: 10px 12px;
                overflow-x: auto;
                margin: 8px 0;
                font-size: 12px;
            }
            .session-memory-content pre code {
                background: none;
                padding: 0;
            }

            /* ── Changes panel (变更) ── */
            .changes-panel {
                display: flex;
                flex-direction: column;
                height: 100%;
                overflow: hidden;
            }
            .changes-summary {
                flex-shrink: 0;
                padding: 10px 12px;
                font-size: 12px;
                color: #374151;
                background: #f9fafb;
                border-bottom: 1px solid #e5e7eb;
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: 2px;
            }
            .changes-toggle-all-btn {
                margin-left: auto;
                padding: 2px 8px;
                font-size: 11px;
                line-height: 1.6;
                color: #6b7280;
                background: #fff;
                border: 1px solid #d1d5db;
                border-radius: 4px;
                cursor: pointer;
                white-space: nowrap;
                transition: all 0.15s;
            }
            .changes-toggle-all-btn:hover {
                color: #374151;
                border-color: #9ca3af;
                background: #f3f4f6;
            }
            .diff-stat-add {
                color: #16a34a;
                font-weight: 600;
            }
            .diff-stat-remove {
                color: #dc2626;
                font-weight: 600;
            }
            .changes-file-list {
                flex: 1;
                overflow-y: auto;
            }
            .changes-file-item {
                border-bottom: 1px solid #f1f5f9;
            }
            .changes-file-header {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 8px 12px;
                cursor: pointer;
                user-select: none;
                background: #fff;
                transition: background 0.15s;
                min-width: 0;
            }
            .changes-file-header:hover {
                background: #f9fafb;
            }
            .changes-chevron {
                width: 14px;
                height: 14px;
                flex-shrink: 0;
                color: #9ca3af;
                transition: transform 0.2s ease;
            }
            .changes-file-name {
                font-size: 12px;
                font-weight: 600;
                color: #1f2937;
                font-family: "Maple Mono", "Cascadia Code", "JetBrains Mono", "Fira Code", monospace;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                flex-shrink: 1;
                min-width: 0;
            }
            .changes-file-dir {
                font-size: 10px;
                color: #9ca3af;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                flex-shrink: 2;
                min-width: 0;
            }
            .changes-file-stats {
                margin-left: auto;
                font-size: 11px;
                flex-shrink: 0;
                display: flex;
                gap: 6px;
                font-family: "Maple Mono", "Cascadia Code", "JetBrains Mono", "Fira Code", monospace;
            }
            .changes-file-body {
                background: #fdfdfd;
                overflow: hidden;
            }
            .diff-change-block {
                border-top: 1px solid #f1f5f9;
            }
            .diff-change-label {
                padding: 4px 12px;
                font-size: 10px;
                color: #6b7280;
                background: #fafafa;
                border-bottom: 1px solid #f1f5f9;
            }
            .diff-hunk-body {
                overflow-x: auto;
                font-family: "Maple Mono", "Cascadia Code", "JetBrains Mono", "Fira Code", monospace;
                font-size: 11px;
                line-height: 1.55;
                tab-size: 4;
            }
            .diff-hunk-header {
                padding: 2px 8px;
                font-size: 10px;
                color: #6b7280;
                background: #f0f4ff;
                border-bottom: 1px solid #e5e7eb;
                font-family: "Maple Mono", "Cascadia Code", "JetBrains Mono", "Fira Code", monospace;
            }
            .diff-line {
                display: flex;
                align-items: stretch;
                min-width: max-content;
                white-space: pre;
            }
            .diff-line-added {
                background: #ecfdf5;
            }
            .diff-line-removed {
                background: #fef2f2;
            }
            .diff-line-context {
                background: #fff;
            }
            .diff-ln {
                display: inline-block;
                width: 36px;
                min-width: 36px;
                text-align: right;
                padding: 0 4px 0 2px;
                color: #9ca3af;
                user-select: none;
                flex-shrink: 0;
                font-size: 10px;
                line-height: inherit;
            }
            .diff-op {
                display: inline-block;
                width: 14px;
                min-width: 14px;
                text-align: center;
                user-select: none;
                flex-shrink: 0;
                font-weight: 600;
                font-size: 11px;
                line-height: inherit;
            }
            .diff-line-added .diff-op {
                color: #16a34a;
            }
            .diff-line-removed .diff-op {
                color: #dc2626;
            }
            .diff-line-context .diff-op {
                color: #d1d5db;
            }
            .diff-content {
                padding: 0 6px 0 0;
                color: #1f2937;
                line-height: inherit;
            }
            .diff-line-added .diff-content {
                color: #065f46;
            }
            .diff-line-removed .diff-content {
                color: #991b1b;
            }
            .diff-line-context .diff-content {
                color: #6b7280;
            }

            /* File explorer styles (imported from fileExplorer.ts) */
            ${getFileExplorerCSS()}

            /* ── 深色模式覆盖 ── */
            :host([data-theme="dark"]) .tab-header {
                background: #252526 !important;
                border-bottom-color: rgba(255, 255, 255, 0.12) !important;
            }
            :host([data-theme="dark"]) .tab-scroll-btn {
                background: #252526 !important;
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .tab-scroll-btn:hover {
                background: #333333 !important;
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .tab-scroll-btn-left {
                border-right-color: rgba(255, 255, 255, 0.12) !important;
            }
            :host([data-theme="dark"]) .tab-scroll-btn-right {
                border-left-color: rgba(255, 255, 255, 0.12) !important;
            }
            :host([data-theme="dark"]) .tab-btn {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .tab-btn:hover {
                color: #cccccc !important;
                background: #333333 !important;
            }
            :host([data-theme="dark"]) .tab-btn.tab-active {
                color: #93c5fd !important;
                border-bottom-color: #93c5fd !important;
            }
            :host([data-theme="dark"]) .placeholder-content {
                color: #787878 !important;
            }
            :host([data-theme="dark"]) .placeholder-hint {
                color: #787878 !important;
            }
            :host([data-theme="dark"]) .placeholder-hint code {
                background: #333333 !important;
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .todo-title {
                color: #e4e4e4 !important;
            }
            :host([data-theme="dark"]) .todo-completed .todo-title {
                color: #787878 !important;
            }
            :host([data-theme="dark"]) .todo-separator {
                background: rgba(255, 255, 255, 0.1) !important;
            }
            :host([data-theme="dark"]) .task-progress-section,
            :host([data-theme="dark"]) .goal-section,
            :host([data-theme="dark"]) .goal-creation-section,
            :host([data-theme="dark"]) .goal-suggestion-section {
                border-top-color: rgba(255, 255, 255, 0.12) !important;
            }
            :host([data-theme="dark"]) .task-progress-heading {
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .goal-suggestion-copy {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .goal-creation-subtitle {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .session-memory-content {
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .session-memory-content h1 {
                color: #e4e4e4 !important;
                border-bottom-color: rgba(255, 255, 255, 0.12) !important;
            }
            :host([data-theme="dark"]) .session-memory-content h2 {
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .session-memory-content em {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .session-memory-content code {
                background: #333333 !important;
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .session-memory-content pre {
                background: #252526 !important;
                border-color: rgba(255, 255, 255, 0.12) !important;
            }
            :host([data-theme="dark"]) .changes-summary {
                color: #cccccc !important;
                background: #252526 !important;
                border-bottom-color: rgba(255, 255, 255, 0.12) !important;
            }
            :host([data-theme="dark"]) .changes-toggle-all-btn {
                color: #ababab !important;
                background: #333333 !important;
                border-color: rgba(255, 255, 255, 0.18) !important;
            }
            :host([data-theme="dark"]) .changes-toggle-all-btn:hover {
                color: #cccccc !important;
                background: #3f3f46 !important;
                border-color: rgba(255, 255, 255, 0.28) !important;
            }
            :host([data-theme="dark"]) .changes-file-item {
                border-bottom-color: rgba(255, 255, 255, 0.08) !important;
            }
            :host([data-theme="dark"]) .changes-file-header {
                background: #1e1e1e !important;
            }
            :host([data-theme="dark"]) .changes-file-header:hover {
                background: #252526 !important;
            }
            :host([data-theme="dark"]) .changes-chevron {
                color: #787878 !important;
            }
            :host([data-theme="dark"]) .changes-file-name {
                color: #e4e4e4 !important;
            }
            :host([data-theme="dark"]) .changes-file-dir {
                color: #787878 !important;
            }
            :host([data-theme="dark"]) .changes-file-body {
                background: #1e1e1e !important;
            }
            :host([data-theme="dark"]) .diff-change-block {
                border-top-color: rgba(255, 255, 255, 0.08) !important;
            }
            :host([data-theme="dark"]) .diff-change-label {
                color: #ababab !important;
                background: #252526 !important;
                border-bottom-color: rgba(255, 255, 255, 0.08) !important;
            }
            :host([data-theme="dark"]) .diff-hunk-header {
                color: #ababab !important;
                background: rgba(96, 165, 250, 0.08) !important;
                border-bottom-color: rgba(255, 255, 255, 0.12) !important;
            }
            :host([data-theme="dark"]) .diff-line-added {
                background: rgba(16, 185, 129, 0.1) !important;
            }
            :host([data-theme="dark"]) .diff-line-removed {
                background: rgba(244, 63, 94, 0.1) !important;
            }
            :host([data-theme="dark"]) .diff-line-context {
                background: #1e1e1e !important;
            }
            :host([data-theme="dark"]) .diff-ln {
                color: #787878 !important;
            }
            :host([data-theme="dark"]) .diff-content {
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .diff-line-added .diff-content {
                color: #6ee7b7 !important;
            }
            :host([data-theme="dark"]) .diff-line-removed .diff-content {
                color: #fda4af !important;
            }
            :host([data-theme="dark"]) .diff-line-context .diff-content {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .diff-line-context .diff-op {
                color: rgba(255, 255, 255, 0.18) !important;
            }
            :host([data-theme="dark"]) .tab-content::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.18) !important;
            }
            :host([data-theme="dark"]) .tab-content::-webkit-scrollbar-thumb:hover {
                background: rgba(255, 255, 255, 0.28) !important;
            }
            :host([data-theme="dark"]) .changes-file-list::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.18) !important;
            }
            :host([data-theme="dark"]) .changes-file-list::-webkit-scrollbar-thumb:hover {
                background: rgba(255, 255, 255, 0.28) !important;
            }
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
        </style>

        <div class="tab-header">
            <button class="tab-scroll-btn tab-scroll-btn-left" aria-label="向左滚动">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
            </button>
            <div class="tab-bar-container">
                <div class="tab-bar tab-bar-scrollable">
                    ${tabsHTML}
                </div>
            </div>
            <button class="tab-scroll-btn tab-scroll-btn-right" aria-label="向右滚动">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
            </button>
        </div>
        <div class="tab-content-wrapper">
            ${contentHTML}
        </div>
        `;

        const tabBtns = this.shadowRoot!.querySelectorAll<HTMLButtonElement>('.tab-btn');
        tabBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                const next = btn.dataset.tab as TabSpec['id'] | undefined;
                if (next) this._switchTab(next);
            });
        });

        // 滚动按钮事件
        const leftBtn = this.shadowRoot!.querySelector<HTMLButtonElement>('.tab-scroll-btn-left');
        const rightBtn = this.shadowRoot!.querySelector<HTMLButtonElement>('.tab-scroll-btn-right');
        const tabBar = this.shadowRoot!.querySelector<HTMLElement>('.tab-bar-scrollable');

        if (leftBtn && tabBar) {
            leftBtn.addEventListener('click', () => {
                tabBar.scrollBy({ left: -100, behavior: 'smooth' });
            });
        }
        if (rightBtn && tabBar) {
            rightBtn.addEventListener('click', () => {
                tabBar.scrollBy({ left: 100, behavior: 'smooth' });
            });
        }

        // 鼠标滚轮横向滚动
        const tabHeader = this.shadowRoot!.querySelector<HTMLElement>('.tab-header');
        if (tabHeader && tabBar) {
            tabHeader.addEventListener('wheel', (e) => {
                if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
                    e.preventDefault();
                    tabBar.scrollBy({ left: e.deltaY, behavior: 'auto' });
                }
            });
        }

        // 监听滚动和大小变化来更新按钮显示状态
        this._initTabScrollObserver();

        this._renderTaskPlanPanel();

        if (this._activeTab === 'workspace') {
            this._mountFileExplorer();
        }
        if (this._activeTab === 'changes') {
            this._renderChangesPanel();
        }

        // 注入暗色主题样式
        syncShadowHostTheme(this);
        if (isDark) {
            this.style.backgroundColor = '';
        }
    }
}

if (!customElements.get('task-artifacts')) {
    customElements.define('task-artifacts', TaskArtifacts);
}

export type { TaskTodoLike, GlobalTodoLike };
export { TaskArtifacts };
