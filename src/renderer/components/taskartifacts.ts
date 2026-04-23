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
    id: 'task-plan' | 'workspace' | 'changes';
    label: string;
    icon: string;
}

// ============================================================================
// Constants
// ============================================================================

const TABS: TabSpec[] = [
    { id: 'task-plan', label: '任务计划', icon: 'fa-list-check' },
    { id: 'workspace', label: '工作空间', icon: 'fa-folder-open' },
    { id: 'changes', label: '变更', icon: 'fa-code-compare' }
];

const PRIORITY_STYLE: Record<TodoPriority, { cls: string; label: string }> = {
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
            return '\u2705';
        case 'in_progress':
            return '\uD83D\uDD04';
        case 'pending':
        default:
            return '\u2B55';
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
                    /\.fa-/.test(text)
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
    private _activeTab: TabSpec['id'] = 'task-plan';
    private _taskTodos: TaskTodoLike[] = [];
    private _globalTodos: GlobalTodoLike[] = [];
    private _tickTimer: number | null = null;

    private _fileExplorer = new FileExplorer();

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    connectedCallback(): void {
        this.render();
        this._scheduleTick();
    }

    disconnectedCallback(): void {
        this._stopTick();
    }

    // ----- Public API -----

    setTaskTodos(todos: TaskTodoLike[] | null | undefined): void {
        this._taskTodos = Array.isArray(todos) ? todos : [];
        this._renderTaskPlanPanel();
        this._scheduleTick();
    }

    setGlobalTodos(todos: GlobalTodoLike[] | null | undefined): void {
        this._globalTodos = Array.isArray(todos) ? todos : [];
        this._renderTaskPlanPanel();
        this._scheduleTick();
    }

    hasAnyTodos(): boolean {
        return this._taskTodos.length > 0 || this._globalTodos.length > 0;
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
     * 外部调用：切换到指定的 tab。
     * 例如当任务计划为空时自动切到工作空间。
     */
    switchToTab(tabId: TabSpec['id']): void {
        this._switchTab(tabId);
    }

    // ----- Tab switching -----

    private _switchTab(tabId: TabSpec['id']): void {
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
        }
    }

    private _mountFileExplorer(): void {
        const root = this.shadowRoot;
        if (!root) return;
        const panel = root.querySelector<HTMLElement>('.tab-content[data-tab="workspace"]');
        if (!panel) return;
        this._fileExplorer.mount(panel, root);
    }

    // ----- Timer (for in_progress durations) -----

    private _scheduleTick(): void {
        const hasInProgress =
            this._taskTodos.some((t) => t.status === 'in_progress') ||
            this._globalTodos.some((t) => t.status === 'in_progress');

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
            node.textContent = `\u5DF2\u6267\u884C ${formatDuration(now - start)}`;
        });
    }

    // ----- Task Plan rendering -----

    private _renderTodoItem(todo: TaskTodoLike | GlobalTodoLike, opts: { showPriority?: boolean } = {}): string {
        const isCompleted = todo.status === 'completed';
        const title = todo.title || todo.content || '';

        let priorityBadge = '';
        const priority = (todo as GlobalTodoLike).priority;
        if (opts.showPriority && priority) {
            const conf = PRIORITY_STYLE[priority] || PRIORITY_STYLE.medium;
            priorityBadge = `<span class="todo-badge ${conf.cls}">${conf.label}</span>`;
        }

        const now = Date.now();
        const durationMs = computeDurationMs(todo, now);
        let durationHtml = '';
        if (durationMs !== null) {
            if (todo.status === 'in_progress') {
                const startIso = todo.started_at || todo.updated_at || todo.created_at || '';
                durationHtml = `<span class="todo-duration todo-duration-running"
                    data-running="1" data-start="${escapeHtml(startIso)}"
                    title="\u5DF2\u6267\u884C ${escapeHtml(formatDuration(durationMs))}">
                    \u5DF2\u6267\u884C ${escapeHtml(formatDuration(durationMs))}
                </span>`;
            } else if (todo.status === 'completed') {
                durationHtml = `<span class="todo-duration todo-duration-done"
                    title="\u7528\u65F6 ${escapeHtml(formatDuration(durationMs))}">
                    \u7528\u65F6 ${escapeHtml(formatDuration(durationMs))}
                </span>`;
            }
        }

        const inProgressCls = todo.status === 'in_progress' ? 'todo-in-progress' : '';
        const completedCls = isCompleted ? 'todo-completed' : '';

        return `
        <div class="todo-item ${inProgressCls} ${completedCls}">
            <span class="todo-status-icon">${statusIcon(todo.status)}</span>
            <div class="todo-body">
                <div class="todo-title-row">
                    ${priorityBadge}
                    <span class="todo-title">${escapeHtml(title)}</span>
                </div>
                ${durationHtml ? `<div class="todo-meta-row">${durationHtml}</div>` : ''}
            </div>
        </div>`;
    }

    private _renderTaskPlanPanel(): void {
        const root = this.shadowRoot;
        if (!root) return;
        const panel = root.querySelector<HTMLElement>('.tab-content[data-tab="task-plan"]');
        if (!panel) return;

        const hasTask = this._taskTodos.length > 0;
        const hasGlobal = this._globalTodos.length > 0;

        if (!hasTask && !hasGlobal) {
            panel.innerHTML = `
            <div class="placeholder-content">
                <i class="fas fa-list-check placeholder-icon"></i>
                <p>\u6682\u65E0\u4EFB\u52A1\u8BA1\u5212</p>
                <p class="placeholder-hint">\u5F53 Agent \u8C03\u7528 <code>TodoWrite</code> \u521B\u5EFA\u4EFB\u52A1\u8BA1\u5212\u540E\uFF0C
                    \u6216\u901A\u8FC7\u5168\u5C40\u5F85\u529E\u6DFB\u52A0\u65B0\u4EFB\u52A1\u65F6\uFF0C\u5C06\u5728\u6B64\u5C55\u793A\u3002</p>
            </div>`;
            return;
        }

        let html = '<div class="task-plan-sections">';

        if (hasTask) {
            const completed = this._taskTodos.filter((t) => t.status === 'completed').length;
            html += `
            <section class="plan-section">
                <header class="plan-section-header">
                    <span class="plan-section-title">
                        <i class="fas fa-diagram-project"></i>
                        \u5F53\u524D\u4EFB\u52A1\u5F85\u529E
                    </span>
                    <span class="plan-section-count">${completed}/${this._taskTodos.length}</span>
                </header>
                <div class="plan-section-body">
                    ${this._taskTodos.map((t) => this._renderTodoItem(t)).join('')}
                </div>
            </section>`;
        }

        if (hasGlobal) {
            const completed = this._globalTodos.filter((t) => t.status === 'completed').length;
            html += `
            <section class="plan-section">
                <header class="plan-section-header">
                    <span class="plan-section-title">
                        <i class="fas fa-globe"></i>
                        \u5168\u5C40\u5F85\u529E
                    </span>
                    <span class="plan-section-count">${completed}/${this._globalTodos.length}</span>
                </header>
                <div class="plan-section-body">
                    ${this._globalTodos.map((t) => this._renderTodoItem(t, { showPriority: true })).join('')}
                </div>
            </section>`;
        }

        html += '</div>';
        panel.innerHTML = html;
    }

    // ========================================================================
    // Main render
    // ========================================================================

    private render(): void {
        const tabsHTML = TABS.map((tab) => {
            const isActive = tab.id === this._activeTab;
            return `<button class="tab-btn ${isActive ? 'tab-active' : ''}" data-tab="${tab.id}">
                <i class="fas ${tab.icon} text-xs"></i>
                <span>${tab.label}</span>
            </button>`;
        }).join('');

        const placeholderHTML = (tab: TabSpec) => `
            <div class="placeholder-content">
                <i class="fas ${tab.icon} placeholder-icon"></i>
                <p>${tab.label}\u5185\u5BB9\u5360\u4F4D\u7B26</p>
            </div>`;

        const contentHTML = TABS.map((tab) => {
            const isActive = tab.id === this._activeTab;
            let inner = '';
            if (tab.id === 'task-plan' || tab.id === 'workspace') {
                inner = '';
            } else {
                inner = placeholderHTML(tab);
            }
            return `<div class="tab-content" data-tab="${tab.id}" style="display: ${isActive ? '' : 'none'}">
                ${inner}
            </div>`;
        }).join('');

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

            .tab-content-wrapper {
                flex: 1;
                overflow: hidden;
                display: flex;
                flex-direction: column;
            }

            .tab-content {
                flex: 1;
                overflow-y: auto;
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

            /* Task plan panel */
            .task-plan-sections {
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 12px;
            }

            .plan-section {
                background: white;
                border: 1px solid #eef0f3;
                border-radius: 10px;
                overflow: hidden;
            }

            .plan-section-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 12px;
                background: #f8fafc;
                border-bottom: 1px solid #eef0f3;
            }
            .plan-section-title {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 12px;
                font-weight: 600;
                color: #334155;
            }
            .plan-section-title i {
                color: #64748b;
                font-size: 11px;
            }
            .plan-section-count {
                font-size: 11px;
                color: #64748b;
                background: white;
                border: 1px solid #e2e8f0;
                border-radius: 999px;
                padding: 1px 8px;
            }

            .plan-section-body {
                display: flex;
                flex-direction: column;
                gap: 2px;
                padding: 6px 6px;
            }

            .todo-item {
                display: flex;
                align-items: flex-start;
                gap: 8px;
                padding: 7px 8px;
                border-radius: 6px;
                transition: background 0.15s;
            }
            .todo-item:hover {
                background: #f8fafc;
            }
            .todo-item.todo-in-progress {
                background: #eff6ff;
            }
            .todo-item.todo-in-progress:hover {
                background: #dbeafe;
            }

            .todo-status-icon {
                font-size: 13px;
                line-height: 1.5;
                flex-shrink: 0;
                margin-top: 1px;
            }

            .todo-body {
                flex: 1;
                min-width: 0;
            }
            .todo-title-row {
                display: flex;
                align-items: center;
                gap: 6px;
                flex-wrap: wrap;
            }
            .todo-title {
                font-size: 12px;
                line-height: 1.5;
                color: #1f2937;
                word-break: break-word;
            }
            .todo-completed .todo-title {
                text-decoration: line-through;
                color: #9ca3af;
            }

            .todo-meta-row {
                display: flex;
                gap: 6px;
                margin-top: 2px;
                flex-wrap: wrap;
            }

            .todo-duration {
                display: inline-flex;
                align-items: center;
                font-size: 10px;
                line-height: 1;
                padding: 2px 6px;
                border-radius: 999px;
                border: 1px solid transparent;
                font-variant-numeric: tabular-nums;
            }
            .todo-duration-running {
                color: #1d4ed8;
                background: #dbeafe;
                border-color: #bfdbfe;
            }
            .todo-duration-done {
                color: #047857;
                background: #ecfdf5;
                border-color: #a7f3d0;
            }

            .todo-badge {
                display: inline-flex;
                align-items: center;
                font-size: 10px;
                line-height: 1;
                padding: 2px 6px;
                border: 1px solid transparent;
                border-radius: 999px;
                flex-shrink: 0;
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
