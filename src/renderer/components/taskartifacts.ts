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

import { FileExplorer, getFileExplorerCSS, isHtmlFile } from './fileExplorer';
import { WORKSPACE_FOCUS_LAYOUT_CHANGE_EVENT, type WorkspaceFocusLayoutState } from './workspaceFocusLayout.js';
import { EmbeddedBrowser, type BrowserRestoreState } from '../browser';
import { syncShadowHostTheme } from '../theme/theme-shadow-overrides';
import { createRendererTranslator } from '../locale';
import goalCss from '../styles/goal.css?inline';
import {
    TaskArtifactsGoalController,
    type GoalEvalProgressLike,
    type GoalRenderSummaryLike
} from './taskartifacts-goal/controller.js';
import { formatCompactDuration } from '../../common/goal/format.js';
import { filePathToFileUrl } from '../../common/file-url.js';
import { dispatchAgentInputRequest } from '../input/agentInputRequest.js';
import { browserAutoRevealState } from '../browserAutoRevealState.js';

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
const WORKSPACE_TAB: TabSpec = {
    id: 'workspace',
    label: '工作空间',
    labelKey: 'renderer.taskartifacts.tab.workspace',
    icon: 'fa-folder-open'
};
const BROWSER_TAB: TabSpec = {
    id: 'browser',
    label: '浏览器',
    labelKey: 'renderer.taskartifacts.tab.browser',
    icon: 'fa-globe'
};
const CHANGES_TAB: TabSpec = {
    id: 'changes',
    label: '变更',
    labelKey: 'renderer.taskartifacts.tab.changes',
    icon: 'fa-code-compare'
};
const SESSION_MEMORY_TAB: TabSpec = {
    id: 'session-memory',
    label: '任务摘要',
    labelKey: 'renderer.taskartifacts.tab.sessionMemory',
    icon: 'fa-brain',
    dynamic: true
};
let t = createRendererTranslator();

// ============================================================================
// Helpers
// ============================================================================

import { escapeHtml } from '../../common/utils/escape.js';

function statusIcon(status: TodoStatus): string {
    switch (status) {
        case 'completed':
            return '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="6" fill="currentColor"/><path d="M3.4 6.3l1.8 1.8L8.8 4.5" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        case 'in_progress':
            return '<svg class="todo-dot-spin" width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.8" stroke="currentColor" stroke-width="1.6" stroke-dasharray="15 8" stroke-linecap="round"/></svg>';
        case 'pending':
        default:
            return '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5.2" stroke="currentColor" stroke-width="1.4"/></svg>';
    }
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
    private _browserRestoreState: BrowserRestoreState | null = null;
    private _browserRevealPendingContent = false;
    private _settingUnsubscribe: (() => void) | null = null;
    private _workspaceFocusLayoutState: WorkspaceFocusLayoutState = { active: false, fullscreen: false };
    private _reportedWorkspaceFocusLayoutState: WorkspaceFocusLayoutState = { active: false, fullscreen: false };
    private _browserFocusLayoutActive = false;

    private _taskPlanVisible = false;
    private _taskRunning = false;
    private _goalController: TaskArtifactsGoalController;
    private _browserVisible = false;
    private _sessionMemoryHtml: string | null = null;
    private _sessionMemoryVisible = false;
    private _sessionMemoryRefreshTimer: number | null = null;
    private _tabScrollResizeObserver: ResizeObserver | null = null;
    private _tabScrollInitTimer: number | null = null;

    // Changes panel
    private _changesData: any = null; // TaskChangesResult | null

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._goalController = new TaskArtifactsGoalController({
            element: this,
            getShadowRoot: () => this.shadowRoot,
            getTaskId: () => this._getTaskId(),
            isTaskRunning: () => this.isTaskRunning(),
            switchToTaskPlan: () => this._switchTab('task-plan'),
            syncTaskPlanVisibility: () => this._syncTaskPlanVisibility(),
            renderTaskPlanPanel: (options) => this._renderTaskPlanPanel(options),
            translate: (key, params) => t(key, params)
        });
        this._fileExplorer.onOpenInBrowser = (filePath: string) => {
            this.forceBrowserActive();
            this.browserAddTab(filePathToFileUrl(filePath));
        };
        this._fileExplorer.onWorkspaceFocusLayoutChange = (state) => {
            this._workspaceFocusLayoutState = state;
            this._syncWorkspaceFocusLayout();
        };
        this._fileExplorer.onAgentInputRequest = (request) => {
            dispatchAgentInputRequest(this, request);
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
        if (this._tabScrollInitTimer !== null) {
            window.clearTimeout(this._tabScrollInitTimer);
        }
        this._tabScrollInitTimer = window.setTimeout(() => {
            this._tabScrollInitTimer = null;
            this._updateTabScrollButtons();
        }, 100);
    }

    private _destroyTabScrollObserver(): void {
        if (this._tabScrollResizeObserver) {
            this._tabScrollResizeObserver.disconnect();
            this._tabScrollResizeObserver = null;
        }
        if (this._tabScrollInitTimer !== null) {
            window.clearTimeout(this._tabScrollInitTimer);
            this._tabScrollInitTimer = null;
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
        this._goalController.connect();
        void this._initializeLocale();
        this._scheduleTick();
        // 监听主题变化
        document.addEventListener('opendesk-theme-changed', this._onThemeChange as EventListener);
    }

    disconnectedCallback(): void {
        this._goalController.disconnect();
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
        // Settings updates must not reselect the active tab and reactivate its preview layout.
        for (const tab of this._getTabs()) {
            const label = this.shadowRoot?.querySelector<HTMLElement>(`.tab-btn[data-tab="${tab.id}"] span`);
            if (label) label.textContent = this._getTabLabel(tab);
        }
        this._updateSlider();
        if (this._activeTab === 'changes') {
            this._renderChangesPanel();
        }
        if (this._activeTab === 'task-plan') {
            this._renderTaskPlanPanel();
        }
    }

    setTaskTodos(todos: TaskTodoLike[] | null | undefined, options: SetTaskTodosOptions = {}): void {
        const nextTodos = Array.isArray(todos) ? todos : [];
        const { autoCollapseCurrentGoalDetails } = this._goalController.updateTaskTodos(
            nextTodos,
            options.source ?? 'refresh'
        );
        this._taskTodos = nextTodos;
        this._syncTaskPlanVisibility();
        if (this._goalController.shouldPreserveEditorDom()) {
            this._renderTaskTodosOnly();
        } else {
            this._renderTaskPlanPanel({ autoCollapseCurrentGoalDetails });
        }
        this._scheduleTick();
    }

    setGlobalTodos(todos: GlobalTodoLike[] | null | undefined): void {
        this._globalTodos = Array.isArray(todos) ? todos : [];
        this._syncTaskPlanVisibility();
        if (!this._goalController.shouldPreserveEditorDom()) {
            this._renderTaskPlanPanel();
        }
        this._scheduleTick();
    }

    setGoalState(goal: GoalRenderSummaryLike | null | undefined): void {
        this._goalController.setGoalState(goal);
    }

    setGoalEditPending(pending: boolean): void {
        this._goalController.setGoalEditPending(pending);
    }

    setTaskRunning(running: boolean): void {
        this._taskRunning = running === true;
    }

    isTaskRunning(): boolean {
        if (this._taskRunning) return true;
        const taskView = this.closest('task-view') as { task_status?: string } | null;
        return taskView?.task_status === 'running';
    }

    setGoalEvalProgress(progress: GoalEvalProgressLike | null | undefined): void {
        this._goalController.setGoalEvalProgress(progress);
    }

    /**
     * 打开 goal 创建表单（由外部"创建目标"按钮触发）。
     */
    showGoalCreationForm(): void {
        void this._goalController.showGoalCreationForm();
    }

    private _syncTaskPlanVisibility(): void {
        const hasTodos = this._taskTodos.length > 0;
        const hasGoal = this._goalController.hasGoalContent();
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
        return this._goalController.hasGoalSuggestion();
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
     * @param line 可选行号，打开后跳转到该行（仅对使用编辑器预览的文件生效）
     */
    openFilePreview(filePath: string, line?: number, onSwitchBlocked?: () => void): void {
        if (isHtmlFile(filePath)) {
            this._fileExplorer.onOpenInBrowser?.(filePath);
            return;
        }
        this._switchTab('workspace');
        this._fileExplorer.selectFile(filePath, line, onSwitchBlocked);
    }

    /** Backward-compatible alias for callers that previously closed only the editor. */
    closeEditor(): void {
        this._fileExplorer.closeEditor();
    }

    /** Leave the enlarged preview layout without changing the user's selected tab. */
    suspendPreviewLayout(): void {
        this.closeEditor();
        if (!this._browserFocusLayoutActive) return;
        this._browserFocusLayoutActive = false;
        this._syncWorkspaceFocusLayout();
    }

    /** Exit either a workspace file preview/editor or the focused browser preview. */
    exitPreview(): void {
        this.closeEditor();
        if (this._activeTab === 'browser') {
            this._switchTab('workspace');
        }
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
        this._fileExplorer.setTaskId(taskId);
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
                <p>${t('renderer.taskartifacts.changes.empty')}</p>
                <p class="placeholder-hint">${t('renderer.taskartifacts.changes.emptyHint')}</p>
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
                <strong>${data.totalFiles}</strong> ${t('renderer.taskartifacts.changes.fileCount')}
                <span class="diff-stat-add">+${data.totalAdded}</span>
                <span class="diff-stat-remove">-${data.totalRemoved}</span>
                <button class="changes-toggle-all-btn">${t('renderer.taskartifacts.changes.collapseAll')}</button>
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
            if (btn)
                btn.textContent = hasCollapsed()
                    ? t('renderer.taskartifacts.changes.expandAll')
                    : t('renderer.taskartifacts.changes.collapseAll');
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
                <p>${t('renderer.taskartifacts.sessionMemory.empty')}</p>
            </div>`;
        }
    }

    private _rebuildTabBar(): void {
        const root = this.shadowRoot;
        if (!root) return;
        const tabBar = root.querySelector<HTMLElement>('.tab-bar');
        if (!tabBar) return;
        const tabs = this._getTabs();
        tabBar.innerHTML =
            '<div class="tab-slider"></div>' +
            tabs
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
        this._browserFocusLayoutActive = tabId === 'browser';
        if (tabId === 'browser') {
            this._browserRevealPendingContent = !this._browser || !this._browser.hasActiveContent();
        } else {
            this._browserRevealPendingContent = false;
        }
        const root = this.shadowRoot;
        if (!root) return;
        root.querySelectorAll<HTMLElement>('.tab-btn').forEach((btn) => {
            btn.classList.toggle('tab-active', btn.dataset.tab === tabId);
        });
        root.querySelectorAll<HTMLElement>('.tab-content').forEach((panel) => {
            panel.style.display = panel.dataset.tab === tabId ? '' : 'none';
        });
        this._updateSlider();
        if (tabId === 'workspace') {
            this._mountFileExplorer();
        } else if (tabId === 'browser') {
            this.consumeInitialBrowserAutoReveal();
            this.restoreBrowserPanelLayout();
            this._mountBrowser();
        } else if (tabId === 'changes') {
            this.refreshChanges();
        }
        this._syncWorkspaceFocusLayout();
    }

    private _syncWorkspaceFocusLayout(): void {
        const hostVisible = this._isHostTaskVisible();
        const wsFocusActive = hostVisible && this._activeTab === 'workspace' && this._workspaceFocusLayoutState.active;
        const browserFocusActive =
            hostVisible && this._browserFocusLayoutActive && this._activeTab === 'browser' && this._browserVisible;
        const active = wsFocusActive || browserFocusActive;
        const fullscreen = active && (browserFocusActive || this._workspaceFocusLayoutState.fullscreen);
        this.toggleAttribute('data-workspace-focus-fullscreen', fullscreen);

        if (
            this._reportedWorkspaceFocusLayoutState.active === active &&
            this._reportedWorkspaceFocusLayoutState.fullscreen === fullscreen
        ) {
            return;
        }
        this._reportedWorkspaceFocusLayoutState = { active, fullscreen };
        this._browser?.setPreviewMode(active);
        this.dispatchEvent(
            new CustomEvent<WorkspaceFocusLayoutState>(WORKSPACE_FOCUS_LAYOUT_CHANGE_EVENT, {
                detail: this._reportedWorkspaceFocusLayoutState,
                bubbles: true,
                composed: true
            })
        );
    }

    private _updateSlider(): void {
        const root = this.shadowRoot;
        if (!root) return;
        const slider = root.querySelector<HTMLElement>('.tab-slider');
        const activeBtn = root.querySelector<HTMLElement>('.tab-btn.tab-active');
        if (!slider || !activeBtn) return;
        slider.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
        slider.style.width = `${activeBtn.offsetWidth}px`;
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
        this._browser = new EmbeddedBrowser(panel, this._taskId || '', this._browserRestoreState ?? undefined);
        this._browserRestoreState = null;

        // Register with the preload bridge so main process IPC can reach this instance
        const browserAPI = (window as any).browserAPI;
        if (browserAPI) {
            this._browser.register(browserAPI);
        }

        // 退出网页预览：切回工作空间 tab
        panel.addEventListener('browser-exit-preview', () => {
            this.exitPreview();
        });

        // 标签页状态变更时同步浏览器活跃状态
        this._browser.onTabsChanged = () => {
            this._syncBrowserActiveState();
        };
    }

    /** 外部可设置的标志：为 true 时 ensureBrowserReady 不自动切换 tab */
    public _suppressBrowserAutoSwitch = false;

    private _isHostTaskVisible(): boolean {
        const taskView = this.closest('task-view') as HTMLElement | null;
        return !taskView || (!taskView.hasAttribute('data-background') && taskView.style.display !== 'none');
    }

    /** Consume this task's single automatic Browser Use layout reveal opportunity. */
    consumeInitialBrowserAutoReveal(): boolean {
        return browserAutoRevealState.consume(this._taskId || this._getTaskId());
    }

    /**
     * 后台首次 Browser Use 时记录本任务期望的大屏预览状态：
     * 不立即生效，待用户切回本任务时由 syncRightSidebarState 应用。
     */
    markPendingBrowserAutoReveal(): void {
        browserAutoRevealState.markPendingReveal(this._taskId || this._getTaskId());
    }

    /** 任务对用户可见时调用：返回是否应立即进入浏览器大屏布局，并消费该待应用状态。 */
    applyPendingBrowserAutoReveal(): boolean {
        return browserAutoRevealState.takePendingReveal(this._taskId || this._getTaskId());
    }

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
        const shouldSwitch = autoSwitch && !this._suppressBrowserAutoSwitch && this._isHostTaskVisible();
        if (shouldSwitch && this._activeTab !== 'browser') {
            this._switchTab('browser');
        }
        if (!this._browser) {
            this._mountBrowser();
        }
    }

    /**
     * 外部调用：由 use-browser 触发时强制右侧栏显示浏览器 tab。
     */
    forceBrowserActive(): void {
        this._suppressBrowserAutoSwitch = false;
        this.restoreBrowserPanelLayout();
        this.ensureBrowserReady(true);
    }

    /**
     * 完整销毁浏览器实例和逻辑会话。idle 回收应使用 recycleBrowser()，
     * 避免把仍可恢复的任务无提示重置为空白页。
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
        // 完整销毁后，若当前正在浏览器 tab 上则切到工作空间。
        if (this._activeTab === 'browser') {
            this._switchTab('workspace');
        }
        this._browserRestoreState = null;
        this._browserRevealPendingContent = false;
        // 浏览器已不存在，后台记录的待应用大屏预览状态随之失效。
        browserAutoRevealState.clearPendingReveal(this._taskId || this._getTaskId());
    }

    /**
     * Release only the idle physical WebViews while retaining the task's logical
     * tabs and selected Browser tab for a later invisible or user-requested restore.
     */
    recycleBrowser(): void {
        if (!this._browser) return;
        this._browserRestoreState = this._browser.getSessionState();
        this._browser.onTabsChanged = null;
        const browserAPI = (window as any).browserAPI;
        if (browserAPI) {
            this._browser.unregister(browserAPI);
        }
        this._browser.destroy();
        this._browser = null;
    }

    /** Whether recycling now would visibly replace content the user is reading. */
    isBrowserPresentedToUser(): boolean {
        return this._activeTab === 'browser' && this._browserVisible && this._isHostTaskVisible();
    }

    /** Restore a recycled Browser only when this task already had that tab selected. */
    restoreSelectedBrowser(): void {
        if (this._activeTab === 'browser' && this._browserVisible && !this._browser) {
            this._mountBrowser();
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
     * 是否展示浏览器标签由调用方的宿主展示策略决定。
     */
    async browserNavigate(url: string): Promise<void> {
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
    async browserAddTab(url: string): Promise<number> {
        this.ensureBrowserReady();
        if (!this._browser) return -1;
        const tabId = this._browser.addTab(url);
        return tabId;
    }

    /**
     * 外部调用：获取当前活动 webview 的 webContentsId，供 main process 通过 CDP 控制。
     */
    browserGetWebContentsId(): number | null {
        this.ensureBrowserReady();
        if (!this._browser) return null;
        return this._browser.getWebContentsId();
    }

    /** 外部调用：只查询焦点归属，绝不主动改变用户焦点。 */
    browserHasActiveWebviewFocus(): boolean {
        if (!this._isHostTaskVisible()) {
            return false;
        }
        return this._browser?.hasActiveWebviewFocus() ?? false;
    }

    /**
     * 外部调用：截取当前活动标签页的截图（data URL）。
     */
    async browserCapturePage(): Promise<string | null> {
        if (!this._browser) return null;
        return this._browser.capturePage();
    }

    /**
     * 外部调用：切换 webview 视口模式。
     * 画中画浮窗显示时固定为 16:9，隐藏时恢复正常自适应容器。
     */
    browserSetViewportFixed(fixed: boolean): void {
        this._browser?.setViewportFixed(fixed);
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
        if (hasContent) {
            this._browserRevealPendingContent = false;
        } else if (this._browserRevealPendingContent) {
            // A newly mounted webview reports its initial about:blank asynchronously.
            // Do not let that transient event undo an explicit Browser reveal before
            // the first Browser Use navigation has reached the guest.
            return;
        }
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
        browserPanel.style.width = '1280px';
        browserPanel.style.height = '800px';
        browserPanel.style.opacity = '0';
        browserPanel.style.pointerEvents = 'none';
        browserPanel.style.zIndex = '-1';
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
        browserPanel.style.width = '';
        browserPanel.style.height = '';
        browserPanel.style.opacity = '';
        browserPanel.style.pointerEvents = '';
        browserPanel.style.zIndex = '';
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
            node.innerHTML = `${escapeHtml(formatCompactDuration(now - start))} · ${escapeHtml(t('renderer.taskartifacts.todo.inProgress'))}`;
        });
    }

    // ----- Task Plan rendering -----

    private _renderTodoItem(todo: TaskTodoLike | GlobalTodoLike, _opts: { showPriority?: boolean } = {}): string {
        const isCompleted = todo.status === 'completed';
        const isInProgress = todo.status === 'in_progress';
        const isPending = todo.status === 'pending';
        const title = todo.title || todo.content || '';

        const now = Date.now();
        const durationMs = computeDurationMs(todo, now);
        let durationHtml = '';
        if (isInProgress) {
            const startIso = todo.started_at || todo.updated_at || todo.created_at || '';
            const durText = durationMs !== null ? formatCompactDuration(durationMs) : '';
            durationHtml = `<span class="todo-duration todo-duration-running todo-time"
                data-running="1" data-start="${escapeHtml(startIso)}"
                title="${escapeHtml(t('renderer.taskartifacts.todo.elapsed', { duration: durText }))}">${escapeHtml(durText)} · ${escapeHtml(t('renderer.taskartifacts.todo.inProgress'))}</span>`;
        } else if (isCompleted && durationMs !== null) {
            const durText = formatCompactDuration(durationMs);
            durationHtml = `<span class="todo-duration todo-duration-done todo-time"
                title="${escapeHtml(t('renderer.taskartifacts.todo.took', { duration: durText }))}">${escapeHtml(durText)}</span>`;
        } else if (isPending) {
            durationHtml = `<span class="todo-duration todo-duration-pending todo-time">${escapeHtml(t('renderer.taskartifacts.todo.notStarted'))}</span>`;
        }

        const statusCls = isInProgress ? 'todo-in-progress' : isCompleted ? 'todo-completed' : 'todo-pending';
        const bodyClass = isInProgress ? 'todo-running-block' : 'todo-body';

        return `
        <div class="todo-item ${statusCls}">
            <span class="todo-status-icon">${statusIcon(todo.status)}</span>
            <div class="${bodyClass}">
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
        this._goalController.prepareTaskPlanRender(panel, options.autoCollapseCurrentGoalDetails);

        if (this._taskTodos.length === 0 && !this._goalController.hasGoalContent()) {
            panel.innerHTML = '';
            return;
        }

        const todoHtml = this._renderTaskTodoListHtml();
        const goalHtml = this._goalController.renderTaskPlanContent();
        const html = `
        ${todoHtml}
        ${goalHtml}`;
        panel.innerHTML = html;
    }

    private _renderTaskTodoListHtml(): string {
        if (this._taskTodos.length === 0) return '';

        const total = this._taskTodos.length;
        const completed = this._taskTodos.filter((td) => td.status === 'completed').length;
        const inProgress = this._taskTodos.filter((td) => td.status === 'in_progress').length;
        const pending = this._taskTodos.filter((td) => td.status === 'pending').length;
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

        const itemsHtml = this._taskTodos
            .map((td) => this._renderTodoItem(td))
            .join('<div class="todo-connector"></div>');

        return `<section class="task-progress-section task-todo-section">
            <div class="progress-summary">
                <div class="progress-summary-label-row">
                    <span class="progress-summary-label">${escapeHtml(t('renderer.taskartifacts.todo.title'))}</span>
                    <span class="progress-summary-caption">${escapeHtml(t('renderer.taskartifacts.todo.totalItems', { count: total }))}</span>
                </div>
                <div class="progress-summary-num-row">
                    <span class="progress-summary-big">${completed}</span>
                    <span class="progress-summary-sub">/${total} ${escapeHtml(t('renderer.taskartifacts.todo.completed'))}</span>
                </div>
                <div class="progress-summary-bar"><i style="width:${percent}%"></i></div>
                <div class="progress-summary-meta">${escapeHtml(t('renderer.taskartifacts.todo.summary', { completed, inProgress, pending }))}</div>
            </div>
            <div class="tl-card">
                <div class="task-plan-list">
                    ${itemsHtml}
                </div>
            </div>
        </section>`;
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

    private _getTaskId(): string {
        const attr = this.getAttribute('task-id');
        if (attr) return attr;
        const match = /^task-(.*)-artifacts$/.exec(this.id);
        return match?.[1] ?? '';
    }

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
                <p>${placeholderLabel(tab)}${t('renderer.taskartifacts.placeholder')}</p>
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
                background: #fff;
                --brand-red: #DE4433;
                --brand-red-soft: #FBEDEA;
                --brand-red-gradient: linear-gradient(90deg, #E6512F, #D53D24);
                --tl-card-shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 32px rgba(0,0,0,.06);
                --tl-line: #ECECE8;
                --tl-conn: #ECECE8;
            }

            :host([data-theme="dark"]) {
                background: #1e1e1e !important;
                color: #cccccc !important;
                --brand-red: #FF6B5A;
                --brand-red-soft: rgba(222, 68, 51, 0.12);
                --brand-red-gradient: linear-gradient(90deg, #FF6B5A, #E85A4A);
                --tl-card-shadow: 0 1px 2px rgba(0,0,0,.2), 0 12px 32px rgba(0,0,0,.3);
                --tl-line: rgba(255,255,255,0.1);
                --tl-conn: rgba(255,255,255,0.1);
            }

            .tab-header {
                display: flex;
                align-items: center;
                flex-shrink: 0;
                margin: 14px 16px 12px;
                padding: 4px;
                background: #F5F4F1;
                border-radius: 999px;
                max-height: 36px;
                overflow: hidden;
                transition:
                    opacity 160ms ease,
                    max-height 240ms cubic-bezier(0.4, 0, 0.2, 1),
                    margin 240ms cubic-bezier(0.4, 0, 0.2, 1),
                    padding 240ms cubic-bezier(0.4, 0, 0.2, 1);
            }

            :host([data-workspace-focus-fullscreen]) .tab-header {
                max-height: 0;
                margin-top: 0;
                margin-bottom: 0;
                padding-top: 0;
                padding-bottom: 0;
                opacity: 0;
                pointer-events: none;
            }

            @media (prefers-reduced-motion: reduce) {
                .tab-header {
                    transition: none;
                }
            }

            .tab-bar {
                display: flex;
                gap: 2px;
                align-items: stretch;
                position: relative;
            }

            .tab-slider {
                position: absolute;
                top: 0;
                left: 0;
                height: 100%;
                width: 0;
                background: #fff;
                border-radius: 999px;
                box-shadow: 0 1px 3px rgba(0,0,0,.08);
                transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1),
                            width 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                z-index: 0;
                pointer-events: none;
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

            .tab-scroll-btn {
                display: none;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 100%;
                background: transparent;
                border: none;
                cursor: pointer;
                color: #6b7280;
                flex-shrink: 0;
                z-index: 10;
            }
            .tab-scroll-btn:hover {
                color: #374151;
            }

            .tab-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                padding: 0 14px;
                height: 28px;
                line-height: 1;
                font-size: var(--fs-md);
                color: #6F6F74;
                background: transparent;
                border: none;
                border-radius: 999px;
                cursor: pointer;
                transition: color 0.2s;
                white-space: nowrap;
                flex-shrink: 0;
                position: relative;
                z-index: 1;
            }
            .tab-btn:hover {
                color: #374151;
            }
            .tab-btn.tab-active {
                color: var(--brand-red);
                font-weight: 600;
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
                font-size: var(--fs-base);
                margin: 0;
            }
            .placeholder-hint {
                font-size: var(--fs-sm) !important;
                color: #b0b6c0;
                max-width: 220px;
                line-height: 1.5;
            }
            .placeholder-hint code {
                background: #f1f5f9;
                padding: 1px 4px;
                border-radius: 3px;
                font-size: var(--fs-xs);
                color: #6b7280;
            }

            /* Task progress panel */
            .task-progress-section {
                padding: 0 16px;
            }

            .task-progress-section:first-child,
            .goal-section:first-child,
            .goal-creation-section:first-child,
            .goal-suggestion-section:first-child {
                padding-top: 10px;
                margin-bottom: 10px;
            }

            .task-progress-heading {
                margin: 0 0 8px;
                font-size: var(--fs-sm);
                font-weight: 500;
                line-height: 1.4;
                color: #A5A5AA;
            }

            /* Progress summary */
            .progress-summary {
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 8px 4px 12px;
            }
            .progress-summary-label-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .progress-summary-label {
                font-size: var(--fs-sm);
                font-weight: 500;
                color: #A5A5AA;
            }
            .progress-summary-caption {
                font-size: var(--fs-sm);
                color: #A5A5AA;
            }
            .progress-summary-num-row {
                display: flex;
                align-items: baseline;
                gap: 6px;
            }
            .progress-summary-big {
                font-size: 26px;
                font-weight: 600;
                color: #26262B;
                line-height: 1;
            }
            .progress-summary-sub {
                font-size: var(--fs-md);
                color: #A5A5AA;
            }
            .progress-summary-bar {
                height: 6px;
                border-radius: 3px;
                background: #F1F1EE;
                overflow: hidden;
            }
            .progress-summary-bar i {
                display: block;
                height: 100%;
                background: var(--brand-red-gradient);
                border-radius: 3px;
                transition: width 0.4s ease;
            }
            .progress-summary-meta {
                font-size: var(--fs-sm);
                color: #A5A5AA;
            }

            .task-plan-list {
                display: flex;
                flex-direction: column;
                padding: 0;
            }

            /* Timeline card */
            .tl-card {
                background: #fff;
                border: 1px solid #E7E7E3;
                border-radius: 14px;
                box-shadow: var(--tl-card-shadow);
                padding: 14px;
            }

            .todo-connector {
                width: 2px;
                height: 9px;
                background: var(--tl-conn);
                border-radius: 1px;
                margin: 3px 0 3px 5px;
            }

            .todo-item {
                display: flex;
                gap: 10px;
                align-items: flex-start;
                padding: 0;
            }

            .todo-status-icon {
                flex-shrink: 0;
                width: 12px;
                height: 12px;
                margin-top: 2px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .todo-completed .todo-status-icon { color: #43A26A; }
            .todo-in-progress .todo-status-icon { color: var(--brand-red); }
            .todo-pending .todo-status-icon { color: #D5D5CF; }

            @keyframes tl-dot-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
            .todo-dot-spin {
                animation: tl-dot-spin 1.5s linear infinite;
                transform-origin: center;
            }

            .todo-body {
                flex: 1;
                min-width: 0;
                display: flex;
                flex-direction: column;
                gap: 3px;
            }
            .todo-title {
                font-size: var(--fs-md);
                font-weight: 400;
                line-height: 17px;
                color: #3A3A3F;
                word-break: break-word;
            }
            .todo-completed .todo-title {
                text-decoration: line-through;
                color: #A5A5AA;
                font-weight: 400;
            }
            .todo-in-progress .todo-title {
                font-weight: 500;
                color: #26262B;
            }
            .todo-pending .todo-title {
                color: #A5A5AA;
            }

            /* Running block for in-progress items */
            .todo-running-block {
                flex: 1;
                min-width: 0;
                background: var(--brand-red-soft);
                border-radius: 10px;
                padding: 10px;
                display: flex;
                flex-direction: column;
                gap: 3px;
            }
            .todo-running-block .todo-title {
                font-weight: 500;
                color: #26262B;
            }
            ${goalCss}

            .todo-meta-row {
                display: flex;
                gap: 6px;
                margin-top: 4px;
                flex-wrap: wrap;
            }

            .todo-duration {
                display: inline-flex;
                align-items: center;
                font-size: var(--fs-sm);
                line-height: 1;
                font-weight: 500;
                font-variant-numeric: tabular-nums;
            }
            .todo-duration-running {
                color: var(--brand-red);
            }
            .todo-duration-done {
                color: #43A26A;
            }
            .todo-duration-pending {
                color: #C4C4C9;
            }
            .todo-time {
                font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
                font-size: var(--fs-xs);
                line-height: 1;
            }
            .todo-pending .todo-time {
                font-family: inherit;
            }

            /* Session memory styles */
            .session-memory-content {
                padding: 16px;
                font-size: var(--fs-base);
                line-height: 1.6;
                color: #1f2937;
                overflow-wrap: break-word;
            }
            .session-memory-content h1 {
                font-size: var(--fs-xl);
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
                font-size: var(--fs-lg);
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
                font-size: var(--fs-md);
                color: #334155;
            }
            .session-memory-content pre {
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                border-radius: 6px;
                padding: 10px 12px;
                overflow-x: auto;
                margin: 8px 0;
                font-size: var(--fs-md);
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
                font-size: var(--fs-md);
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
                font-size: var(--fs-sm);
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
                font-size: var(--fs-md);
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
                font-size: var(--fs-xs);
                color: #9ca3af;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                flex-shrink: 2;
                min-width: 0;
            }
            .changes-file-stats {
                margin-left: auto;
                font-size: var(--fs-sm);
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
                font-size: var(--fs-xs);
                color: #6b7280;
                background: #fafafa;
                border-bottom: 1px solid #f1f5f9;
            }
            .diff-hunk-body {
                overflow-x: auto;
                font-family: "Maple Mono", "Cascadia Code", "JetBrains Mono", "Fira Code", monospace;
                font-size: var(--fs-sm);
                line-height: 1.55;
                tab-size: 4;
            }
            .diff-hunk-header {
                padding: 2px 8px;
                font-size: var(--fs-xs);
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
                font-size: var(--fs-xs);
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
                font-size: var(--fs-sm);
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
                background: rgba(255, 255, 255, 0.08) !important;
            }
            :host([data-theme="dark"]) .tab-scroll-btn {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .tab-scroll-btn:hover {
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .tab-btn {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .tab-btn:hover {
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .tab-slider {
                background: #2a2a2a !important;
                box-shadow: 0 1px 3px rgba(0,0,0,.3) !important;
            }
            :host([data-theme="dark"]) .tab-btn.tab-active {
                color: var(--brand-red) !important;
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
            :host([data-theme="dark"]) .todo-in-progress .todo-title {
                color: #e4e4e4 !important;
            }
            :host([data-theme="dark"]) .todo-pending .todo-title {
                color: #787878 !important;
            }
            :host([data-theme="dark"]) .todo-connector {
                background: rgba(255, 255, 255, 0.1) !important;
            }
            :host([data-theme="dark"]) .task-progress-heading {
                color: #787878 !important;
            }
            :host([data-theme="dark"]) .tl-card {
                background: #252526 !important;
                border-color: rgba(255, 255, 255, 0.08) !important;
            }
            :host([data-theme="dark"]) .progress-summary-big {
                color: #e4e4e4 !important;
            }
            :host([data-theme="dark"]) .progress-summary-label,
            :host([data-theme="dark"]) .progress-summary-caption,
            :host([data-theme="dark"]) .progress-summary-sub,
            :host([data-theme="dark"]) .progress-summary-meta {
                color: #787878 !important;
            }
            :host([data-theme="dark"]) .progress-summary-bar {
                background: rgba(255, 255, 255, 0.08) !important;
            }
            :host([data-theme="dark"]) .todo-running-block {
                background: rgba(222, 68, 51, 0.12) !important;
            }
            :host([data-theme="dark"]) .todo-running-block .todo-title {
                color: #e4e4e4 !important;
            }
            :host([data-theme="dark"]) .todo-pending .todo-status-icon {
                color: rgba(255, 255, 255, 0.2) !important;
            }
            :host([data-theme="dark"]) .todo-duration-pending {
                color: rgba(255, 255, 255, 0.2) !important;
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
        </style>

        <div class="tab-header">
            <button class="tab-scroll-btn tab-scroll-btn-left" aria-label="${t('renderer.taskartifacts.scrollLeft')}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
            </button>
            <div class="tab-bar-container">
                <div class="tab-bar tab-bar-scrollable">
                    <div class="tab-slider"></div>
                    ${tabsHTML}
                </div>
            </div>
            <button class="tab-scroll-btn tab-scroll-btn-right" aria-label="${t('renderer.taskartifacts.scrollRight')}">
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

        // 滑块初始定位
        requestAnimationFrame(() => this._updateSlider());

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
