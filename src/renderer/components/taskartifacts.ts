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

interface TabSpec {
    id: 'task-plan' | 'workspace' | 'browser' | 'changes' | 'session-memory';
    label: string;
    icon: string;
    dynamic?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const TASK_PLAN_TAB: TabSpec = { id: 'task-plan', label: '任务计划', icon: 'fa-list-check', dynamic: true };
const WORKSPACE_TAB: TabSpec = { id: 'workspace', label: '工作空间', icon: 'fa-folder-open' };
const BROWSER_TAB: TabSpec = { id: 'browser', label: '浏览器', icon: 'fa-globe' };
const CHANGES_TAB: TabSpec = { id: 'changes', label: '变更', icon: 'fa-code-compare' };
const SESSION_MEMORY_TAB: TabSpec = { id: 'session-memory', label: '任务记忆', icon: 'fa-brain', dynamic: true };

const _PRIORITY_STYLE: Record<TodoPriority, { cls: string; label: string }> = {
    low: { cls: 'bg-blue-50 text-blue-600 border-blue-100', label: '低' },
    medium: { cls: 'bg-amber-50 text-amber-600 border-amber-100', label: '中' },
    high: { cls: 'bg-red-50 text-red-600 border-red-100', label: '高' }
};

// ============================================================================
// Helpers
// ============================================================================

function escapeHtml(str: unknown): string {
    if (str === undefined || str === null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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
    private _savedWidthBeforeFullscreen: string = '';

    private _taskPlanVisible = false;
    private _browserVisible = false;
    private _sessionMemoryHtml: string | null = null;
    private _sessionMemoryVisible = false;
    private _sessionMemoryRefreshTimer: number | null = null;

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
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

    connectedCallback(): void {
        this.render();
        this._scheduleTick();
    }

    disconnectedCallback(): void {
        this._stopTick();
        this._stopSessionMemoryRefresh();
    }

    // ----- Public API -----

    setTaskTodos(todos: TaskTodoLike[] | null | undefined): void {
        this._taskTodos = Array.isArray(todos) ? todos : [];
        this._syncTaskPlanVisibility();
        this._renderTaskPlanPanel();
        this._scheduleTick();
    }

    setGlobalTodos(todos: GlobalTodoLike[] | null | undefined): void {
        this._globalTodos = Array.isArray(todos) ? todos : [];
        this._syncTaskPlanVisibility();
        this._renderTaskPlanPanel();
        this._scheduleTick();
    }

    private _syncTaskPlanVisibility(): void {
        const hasTodos = this._taskTodos.length > 0;
        if (hasTodos && !this._taskPlanVisible) {
            this._taskPlanVisible = true;
            this._rebuildTabBar();
            this._switchTab('task-plan');
        } else if (!hasTodos && this._taskPlanVisible) {
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

    /**
     * 外部调用：当工作空间路径可能已变化时（如用户切换工作空间、切换任务），
     * 重新拉取 workspace 路径并刷新文件浏览器。
     */
    refreshWorkspace(): void {
        this._fileExplorer.refresh();
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
     * 外部调用：切换到工作空间 tab 并在编辑器中打开指定文件。
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
                return `<button class="tab-btn ${isActive ? 'tab-active' : ''}" data-tab="${tab.id}">
                <i class="fas ${tab.icon} text-xs${iconExtra}"></i>
                <span>${tab.label}</span>
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

    private _renderTaskPlanPanel(): void {
        const root = this.shadowRoot;
        if (!root) return;
        const panel = root.querySelector<HTMLElement>('.tab-content[data-tab="task-plan"]');
        if (!panel) return;

        if (this._taskTodos.length === 0) {
            panel.innerHTML = '';
            return;
        }

        const html = `
        <div class="task-plan-list">
            ${this._taskTodos.map((t) => this._renderTodoItem(t)).join('<div class="todo-separator"></div>')}
        </div>`;
        panel.innerHTML = html;
    }

    // ========================================================================
    // Main render
    // ========================================================================

    private render(): void {
        const tabs = this._getTabs();
        const tabsHTML = tabs
            .map((tab) => {
                const isActive = tab.id === this._activeTab;
                const iconExtra = tab.id === 'browser' && this._browserVisible ? ' browser-icon-active' : '';
                return `<button class="tab-btn ${isActive ? 'tab-active' : ''}" data-tab="${tab.id}">
                <i class="fas ${tab.icon} text-xs${iconExtra}"></i>
                <span>${tab.label}</span>
            </button>`;
            })
            .join('');

        const placeholderHTML = (tab: TabSpec) => `
            <div class="placeholder-content">
                <i class="fas ${tab.icon} placeholder-icon"></i>
                <p>${tab.label}内容占位符</p>
            </div>`;

        const contentHTML = tabs
            .map((tab) => {
                const isActive = tab.id === this._activeTab;
                let inner = '';
                if (
                    tab.id === 'task-plan' ||
                    tab.id === 'workspace' ||
                    tab.id === 'browser' ||
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

            .tab-bar {
                display: flex;
                border-bottom: 1px solid #e5e7eb;
                padding: 0 4px;
                background: white;
                flex-shrink: 0;
                min-height: 40px;
                align-items: flex-end;
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

            /* Task plan panel — flat list (no card wrapping) */
            .task-plan-list {
                display: flex;
                flex-direction: column;
                padding: 8px 12px;
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

            /* File explorer styles (imported from fileExplorer.ts) */
            ${getFileExplorerCSS()}
        </style>

        <div class="tab-bar">
            ${tabsHTML}
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

        this._renderTaskPlanPanel();

        if (this._activeTab === 'workspace') {
            this._mountFileExplorer();
        }
    }
}

if (!customElements.get('task-artifacts')) {
    customElements.define('task-artifacts', TaskArtifacts);
}

export type { TaskTodoLike, GlobalTodoLike };
export { TaskArtifacts };
