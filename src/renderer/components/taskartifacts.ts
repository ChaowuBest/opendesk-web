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
 *   - 工作空间 / 变更：占位，后续扩展。
 *
 * 每个待办项会展示执行耗时：
 *   - in_progress：显示 "已执行 xxx"，组件内 1s 刷新一次计时徽章；
 *   - completed：显示 "用时 xxx"（started_at → completed_at）；
 *   - pending：不展示耗时。
 */

type TodoStatus = 'pending' | 'in_progress' | 'completed';
type TodoPriority = 'low' | 'medium' | 'high';

/** 与主进程 TaskTodo 一致的最小字段集；其它字段允许存在但不要求 */
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
            return '✅';
        case 'in_progress':
            return '🔄';
        case 'pending':
        default:
            return '⭕';
    }
}

/**
 * 将毫秒格式化成紧凑可读的耗时，例如 "3s"、"1m02s"、"1h02m"。
 */
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

/**
 * 计算单个待办的执行耗时（ms）。
 * - completed：started_at → completed_at；若没有 started_at，退化为 created_at → completed_at。
 * - in_progress：started_at → now；若没有 started_at，退化为 updated_at → now。
 * - 其它：返回 null。
 */
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

class TaskArtifacts extends HTMLElement {
    private _activeTab: TabSpec['id'] = 'task-plan';
    private _taskTodos: TaskTodoLike[] = [];
    private _globalTodos: GlobalTodoLike[] = [];
    /** 进行中项计时刷新定时器 */
    private _tickTimer: number | null = null;

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

    /** 更新任务级待办 */
    setTaskTodos(todos: TaskTodoLike[] | null | undefined): void {
        this._taskTodos = Array.isArray(todos) ? todos : [];
        this._renderTaskPlanPanel();
        this._scheduleTick();
    }

    /** 更新全局待办 */
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
    }

    /** 如果存在进行中项，则启动 1s 级别的计时刷新；否则停止 */
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

    /**
     * 只更新 in_progress 项的耗时徽章文本，避免每秒整块重绘闪烁。
     */
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
            node.textContent = `已执行 ${formatDuration(now - start)}`;
        });
    }

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
                    title="已执行 ${escapeHtml(formatDuration(durationMs))}">
                    已执行 ${escapeHtml(formatDuration(durationMs))}
                </span>`;
            } else if (todo.status === 'completed') {
                durationHtml = `<span class="todo-duration todo-duration-done"
                    title="用时 ${escapeHtml(formatDuration(durationMs))}">
                    用时 ${escapeHtml(formatDuration(durationMs))}
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
                <p>暂无任务计划</p>
                <p class="placeholder-hint">当 Agent 调用 <code>TodoWrite</code> 创建任务计划后，
                    或通过全局待办添加新任务时，将在此展示。</p>
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
                        当前任务待办
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
                        全局待办
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
                <p>${tab.label}内容占位符</p>
            </div>`;

        const contentHTML = TABS.map((tab) => {
            const isActive = tab.id === this._activeTab;
            const inner = tab.id === 'task-plan' ? '' : placeholderHTML(tab);
            return `<div class="tab-content" data-tab="${tab.id}" style="display: ${isActive ? '' : 'none'}">
                ${inner}
            </div>`;
        }).join('');

        this.shadowRoot!.innerHTML = `
        <style>
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

            /* 任务计划面板 */
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
    }
}

if (!customElements.get('task-artifacts')) {
    customElements.define('task-artifacts', TaskArtifacts);
}

export type { TaskTodoLike, GlobalTodoLike };
export { TaskArtifacts };
