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

const DANGEROUS_TAGS = new Set(['STYLE', 'SCRIPT', 'LINK', 'META', 'IFRAME', 'OBJECT', 'EMBED', 'APPLET', 'BASE']);

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

class TaskView extends HTMLElement {
    // 全局侧边栏状态：跨任务共享
    static rightSidebarExpanded = false;
    static rightSidebarWidth = 380;

    constructor() {
        super();

        this.task_id = null;
        this.widget_id = crypto.randomUUID();
        /** @type {HTMLDivElement | null} */
        this.history_container = null;
        /** @type {string | null} */
        this.subscription_id = null;
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
        /** @type {number} 当前模型上下文窗口大小（tokens） */
        this._modelContextSize = 0;
        /** @type {string | null} 当前已加载上下文大小的模型别名 */
        this._contextSizeModel = null;
        /** @type {Map<string, HTMLElement>} 缓存活跃的 message container 元素 */
        this._messageContainerCache = new Map();
        /** @type {number | null} 节流滚动的 rAF id */
        this._scrollRafId = null;
    }

    static isCompactBoundaryMessage(message) {
        return Boolean(message) && message.role === 'compact_separator';
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

    renderUserMessage(user_message) {
        let content = '';
        let hasTextPart = false;
        for (const part of user_message.content) {
            content += `<div class="${TaskView.USER_PART_CLASS_MAP[part.type]}">${part.rendered}</div>`;
            if (part.type === 'text') {
                hasTextPart = true;
            }
        }
        if (hasTextPart) {
            return `
            <div class="flex items-start flex-row-reverse">
                <div class="bg-white text-gray-900 rounded-lg px-3 py-1.5 max-w-3xl border border-gray-200">
                    ${content}
                </div>
            </div>
            `;
        } else {
            return `
            <div class="flex items-start flex-row-reverse">
                ${content}
            </div>
            `;
        }
    }

    static USER_PART_CLASS_MAP = {
        text: 'bg-transparent text-[11px] text-black markdown-body'
    };

    static ASSISTANT_PART_CLASS_MAP = {
        text: 'bg-transparent text-[11px] text-black markdown-body',
        reasoning: '',
        tool_call: ''
    };

    static SPINNER_SVG = `<i class="fa-solid fa-circle-notch fa-spin"></i>`;

    static formatUsageHtml(usage, contextSize, isStreaming = false) {
        const promptTokens = usage ? usage.prompt_tokens : 0;
        const completionTokens = usage ? usage.completion_tokens : 0;
        const totalTokens = usage ? usage.total_tokens : 0;
        const titleParts = usage ? `输入: ${promptTokens}, 输出: ${completionTokens}, 总计: ${totalTokens}` : '';
        let ratioText = '';
        if (contextSize > 0 && totalTokens > 0) {
            const pct = ((totalTokens / contextSize) * 100).toFixed(1);
            ratioText = `, 上下文占比 ${pct}%`;
        }
        const spinnerDisplay = isStreaming ? '' : 'display:none;';
        return `<span class="message-usage text-xs text-gray-400 mt-1 flex items-center gap-1" title="${titleParts}" data-prompt-tokens="${promptTokens}" data-completion-tokens="${completionTokens}" data-total-tokens="${totalTokens}" data-streaming="${isStreaming}"><span class="usage-spinner" style="${spinnerDisplay}">${TaskView.SPINNER_SVG}</span><span class="usage-text">已输出 ${completionTokens} 词, 总计 ${totalTokens} 词${ratioText}</span></span>`;
    }

    static createReasoningPartHtml(rendered, isOpen = false) {
        return `
        <div class="reasoning-wrapper">
            <details class="reasoning-block bg-gray-50/60 rounded-lg mb-1.5" ${isOpen ? 'open' : ''}>
                <summary class="flex items-center gap-1.5 px-2.5 py-1 cursor-pointer select-none text-gray-400 hover:text-gray-500 text-[11px] font-medium">
                    <svg class="reasoning-arrow w-3 h-3 shrink-0 transition-transform duration-200" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd"/>
                    </svg>
                    深度思考
                </summary>
                <div class="reasoning-content px-3 pb-2 text-gray-500 text-[11px] leading-relaxed">
                    ${rendered || ''}
                </div>
            </details>
        </div>`;
    }

    renderAssistantMessage(assistant_message, isLast = false) {
        let content = '';
        for (const part of assistant_message.content) {
            if (part.type === 'reasoning') {
                const isShort = (part.contentLength || 0) <= 200;
                content += TaskView.createReasoningPartHtml(part.rendered, isShort);
            } else {
                content += `<div class="${TaskView.ASSISTANT_PART_CLASS_MAP[part.type]}">${part.rendered}</div>`;
            }
        }
        const usageHtml = isLast ? TaskView.formatUsageHtml(assistant_message.usage, this._modelContextSize) : '';
        const html = `
        <div class="flex items-start">
            <div id='message-container-${assistant_message.message_id}' class="p-2 bg-transparent w-full">
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
        <div class="flex items-start">
            <div id='message-container-${message_id}' class="p-2 bg-transparent w-full">
                <div id='message-content-${message_id}'>
                </div>
                ${TaskView.formatUsageHtml(null, this._modelContextSize, true)}
            </div>
        </div>
        `;
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
            this._programmaticScrolling = true;
            domElement.scrollTop = domElement.scrollHeight;
            // 延长程序化滚动保护窗口——内容插入导致的布局重排可能在多帧后
            // 才触发 scroll 事件，单帧保护不够
            if (this._programmaticScrollTimer) clearTimeout(this._programmaticScrollTimer);
            this._programmaticScrollTimer = setTimeout(() => {
                this._programmaticScrolling = false;
                this._programmaticScrollTimer = null;
            }, 150);
        });
    }

    async reload() {
        const task_state = await window.taskManagerAPI.getFullTask(this.task_id);
        this.task_status = task_state.task_status || 'waiting';
        this.updateStopButtonVisibility();
        this._messageContainerCache.clear();

        if (this._toolbar && task_state.task_name) {
            this._toolbar.setToolbarTitle(task_state.task_name);
        }

        const input_widget = this.querySelector(`#task-${this.task_id}-input`);
        if (input_widget) {
            if (task_state.model) {
                input_widget.setModel(task_state.model);
            }
            if (task_state.reasoningEffort !== undefined) {
                input_widget.setReasoningEffort(task_state.reasoningEffort);
            }
        }

        // 非阻塞获取上下文大小，避免延迟首次渲染
        this._refreshModelContextSize(task_state.model).then(() => this._updateLastUsageRatio());

        const history_container = this.getHistoryContainer();
        const htmlParts = [];
        const messages = task_state.chat_context.messages;
        const lastAssistantIdx = (() => {
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'assistant') return i;
            }
            return -1;
        })();
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (message.role === 'user') {
                if (message.internal) continue;
                htmlParts.push(this.renderUserMessage(message));
            } else if (message.role === 'assistant') {
                htmlParts.push(this.renderAssistantMessage(message, i === lastAssistantIdx));
            } else if (TaskView.isCompactBoundaryMessage(message)) {
                htmlParts.push(TaskView.renderCompactBoundary());
            }
        }
        history_container.innerHTML = htmlParts.join('');

        // 任务正在运行但还没有 assistant 消息时，显示带动画的 usage 面板
        if (this.task_status === 'running' && lastAssistantIdx === -1) {
            history_container.insertAdjacentHTML(
                'beforeend',
                `
                <div class="waiting-usage-placeholder flex items-start">
                    <div class="p-2 bg-transparent w-full">
                        ${TaskView.formatUsageHtml(null, this._modelContextSize, true)}
                    </div>
                </div>
            `
            );
        }

        this.tryScrollToEnd();

        // 刷新任务计划面板数据（不影响侧边栏展开状态）
        this._refreshTaskTodos();
        this._refreshGlobalTodos();
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

    static renderCompactSeparator() {
        return TaskView.renderCompactBoundary();
    }

    updateStopButtonVisibility() {
        const inputWidget = this.querySelector(`#task-${this.task_id}-input`);
        if (inputWidget) {
            if (this.task_status === 'running') {
                inputWidget.setDisabled(true);
                inputWidget.setStopMode(true, async () => {
                    try {
                        await window.taskManagerAPI.stopTask(this.task_id);
                        this.task_status = 'stopped';
                        this.updateStopButtonVisibility();
                    } catch (error) {
                        console.error('Failed to stop task:', error);
                    }
                });
            } else {
                inputWidget.setDisabled(false);
                inputWidget.setStopMode(false);
            }
        }
    }

    _toggleRightSidebar() {
        const rightSidebar = this.querySelector(`#task-${this.task_id}-artifacts`);
        const resizer = this.querySelector(`#task-${this.task_id}-resizer`);
        if (!rightSidebar) return;

        const isExpanded = rightSidebar.style.display !== 'none';
        if (isExpanded) {
            this._collapseRightSidebar(rightSidebar, resizer);
        } else {
            this._expandRightSidebar(rightSidebar, resizer);
        }
        this._updateSidebarToggleIcon(!isExpanded);
    }

    _expandRightSidebar(rightSidebar, resizer) {
        const targetWidth = TaskView.rightSidebarWidth || 380;
        rightSidebar.style.display = '';
        rightSidebar.style.width = '0px';
        rightSidebar.style.opacity = '0';
        rightSidebar.style.overflow = 'hidden';
        rightSidebar.style.transition =
            'width 280ms cubic-bezier(0.4, 0, 0.2, 1), opacity 280ms cubic-bezier(0.4, 0, 0.2, 1)';
        if (resizer) {
            resizer.style.display = '';
            resizer.style.opacity = '0';
            resizer.style.transition = 'opacity 280ms ease';
        }

        requestAnimationFrame(() => {
            rightSidebar.style.width = targetWidth + 'px';
            rightSidebar.style.opacity = '1';
            if (resizer) resizer.style.opacity = '1';
        });

        const onEnd = (e) => {
            if (e.propertyName !== 'width') return;
            rightSidebar.removeEventListener('transitionend', onEnd);
            rightSidebar.style.overflow = '';
            rightSidebar.style.transition = '';
            if (resizer) resizer.style.transition = '';
        };
        rightSidebar.addEventListener('transitionend', onEnd);

        TaskView.rightSidebarExpanded = true;
        this._autoSwitchTabIfEmpty(rightSidebar);
    }

    _collapseRightSidebar(rightSidebar, resizer) {
        TaskView.rightSidebarWidth = parseInt(rightSidebar.style.width) || 380;
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
            rightSidebar.style.display = 'none';
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

        TaskView.rightSidebarExpanded = false;
    }

    _autoSwitchTabIfEmpty(sidebar) {
        // Tab visibility is now managed dynamically inside TaskArtifacts
    }

    /**
     * 确保右侧边栏处于展开状态。若原本未展开则展开它
     */
    _ensureRightSidebarOpen() {
        const rightSidebar = this.querySelector(`#task-${this.task_id}-artifacts`);
        const resizer = this.querySelector(`#task-${this.task_id}-resizer`);
        if (!rightSidebar) return;
        if (rightSidebar.style.display !== 'none') return;

        this._expandRightSidebar(rightSidebar, resizer);
        this._updateSidebarToggleIcon(true);
    }

    _getRightSidebarEl() {
        return this.querySelector(`#task-${this.task_id}-artifacts`);
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
            const sidebar = this._getRightSidebarEl();
            if (sidebar && typeof sidebar.setTaskTodos === 'function') {
                sidebar.setTaskTodos(this._taskTodos);
            }
            if (opts.autoExpand && !prevHasTodos && this._taskTodos.length > 0) {
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
                    const sidebar = this._getRightSidebarEl();
                    if (sidebar && typeof sidebar.setTaskTodos === 'function') {
                        sidebar.setTaskTodos(this._taskTodos);
                    }
                    // 仅在从"无任务计划"变为"有任务计划"时自动展开右侧栏，
                    // 避免每次 TodoWrite 都强制展开，干扰用户手动折叠的偏好
                    if (!prevHasTodos && this._taskTodos.length > 0) {
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
        sidebar[method](...args);
        // Auto-expand sidebar when browser action is triggered
        this._ensureRightSidebarOpen();
    }

    /** 同步全局侧边栏状态到当前任务视图（切换任务时调用） */
    syncRightSidebarState() {
        const rightSidebar = this.querySelector(`#task-${this.task_id}-artifacts`);
        const resizer = this.querySelector(`#task-${this.task_id}-resizer`);
        if (!rightSidebar) return;

        if (TaskView.rightSidebarExpanded) {
            rightSidebar.style.display = '';
            rightSidebar.style.width = TaskView.rightSidebarWidth + 'px';
            if (resizer) resizer.style.display = '';
            this._autoSwitchTabIfEmpty(rightSidebar);
        } else {
            rightSidebar.style.display = 'none';
            if (resizer) resizer.style.display = 'none';
        }
        this._updateSidebarToggleIcon(TaskView.rightSidebarExpanded);

        if (typeof rightSidebar.refreshWorkspace === 'function') {
            rightSidebar.refreshWorkspace();
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
            const workspacePath = await window.workspaceAPI.getEffectiveWorkspace();
            this._toolbar.setToolbarSubtitle(workspacePath, async () => {
                const newPath = await window.workspaceAPI.selectWorkspaceDirectory();
                if (newPath) {
                    this._toolbar.setToolbarSubtitle(newPath, this._toolbar._subtitleClickHandler);
                    document.dispatchEvent(new CustomEvent('workspace-changed'));
                }
            });
        } catch (error) {
            console.error('Failed to init toolbar workspace:', error);
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
                        icon: TaskView.rightSidebarExpanded ? 'fa-table-columns' : 'fa-table-columns',
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
                sidebar.refreshWorkspace();
            }
            if (this._toolbar && window.workspaceAPI) {
                try {
                    const p = await window.workspaceAPI.getEffectiveWorkspace();
                    this._toolbar.setToolbarSubtitle(p, this._toolbar._subtitleClickHandler);
                } catch (_) {}
            }
        };
        document.addEventListener('workspace-changed', this._workspaceChangedHandler);

        this._taskListUpdateHandler = (event) => {
            if (!this._toolbar) return;
            const taskList = event.detail;
            if (!Array.isArray(taskList)) return;
            const myTask = taskList.find((t) => t.task_id === this.task_id);
            if (myTask && myTask.task_name) {
                this._toolbar.setToolbarTitle(myTask.task_name);
            }
        };
        document.addEventListener('task-list-updated', this._taskListUpdateHandler);

        this.reload().then(async () => {
            this.subscription_id = await window.taskManagerAPI.subscribeTaskUpdate(this.task_id, (progress) => {
                const history_container = this.getHistoryContainer();

                if (progress.type === 'user') {
                    if (progress.internal) return;
                    const userMsg = {
                        content: [
                            {
                                type: progress.last_part.type,
                                rendered: progress.last_part.rendered || ''
                            }
                        ]
                    };
                    // 新用户消息出现时，移除上一条 assistant 消息的 usage 行（不再是最后一条了）
                    const prevUsageEls = history_container.querySelectorAll('.message-usage');
                    prevUsageEls.forEach((el) => el.remove());
                    history_container.insertAdjacentHTML('beforeend', this.renderUserMessage(userMsg));
                } else {
                    let message_container =
                        this._messageContainerCache.get(progress.message_id) ||
                        this.querySelector(`#message-container-${progress.message_id}`);
                    const isNewMessage = !message_container;
                    if (isNewMessage) {
                        // 移除等待占位容器
                        const waitingPlaceholder = history_container.querySelector('.waiting-usage-placeholder');
                        if (waitingPlaceholder) {
                            waitingPlaceholder.remove();
                        }
                        // 新 assistant 消息到来，移除旧的 usage 行
                        const prevUsageEls = history_container.querySelectorAll('.message-usage');
                        prevUsageEls.forEach((el) => el.remove());
                        history_container.insertAdjacentHTML(
                            'beforeend',
                            this.createEmptyAssistantContainer(progress.message_id)
                        );
                        message_container = this.querySelector(`#message-container-${progress.message_id}`);
                        this._messageContainerCache.set(progress.message_id, message_container);
                    }
                    const message_content = message_container.querySelector(`#message-content-${progress.message_id}`);

                    if (message_content.children.length <= progress.last_part_index) {
                        if (progress.last_part.type === 'reasoning') {
                            message_content.insertAdjacentHTML('beforeend', TaskView.createReasoningPartHtml('', true));
                        } else {
                            message_content.insertAdjacentHTML(
                                'beforeend',
                                `<div class='${TaskView.ASSISTANT_PART_CLASS_MAP[progress.last_part.type]}'></div>`
                            );
                            message_content.querySelectorAll('details.reasoning-block[open]').forEach((el) => {
                                const contentEl = el.querySelector('.reasoning-content');
                                const textLength = contentEl ? contentEl.textContent.length : 0;
                                if (textLength > 200) {
                                    el.removeAttribute('open');
                                }
                            });
                        }
                    }
                    const last_part_element = message_content.children[progress.last_part_index];
                    if (progress.last_part.type === 'reasoning') {
                        const reasoningContent = last_part_element.querySelector('.reasoning-content');
                        if (reasoningContent) {
                            reasoningContent.innerHTML = progress.last_part.rendered || '';
                        }
                    } else {
                        last_part_element.innerHTML = progress.last_part.rendered || '';
                    }

                    if (progress.last_part.type === 'tool_call') {
                        last_part_element.querySelectorAll('.terminal-tool-scroll').forEach((el) => {
                            el.scrollTop = el.scrollHeight;
                        });
                    }

                    const isStreaming = progress.task_status === 'running';
                    const usageEl = message_container.querySelector('.message-usage');
                    if (usageEl) {
                        const usage = progress.usage || null;
                        // 模型尚未返回新的 usage 时，沿用之前已显示的数值，避免闪回 0
                        const prevPrompt = parseInt(usageEl.dataset.promptTokens || '0', 10);
                        const prevCompletion = parseInt(usageEl.dataset.completionTokens || '0', 10);
                        const prevTotal = parseInt(usageEl.dataset.totalTokens || '0', 10);
                        const promptTokens = usage ? usage.prompt_tokens : prevPrompt;
                        const completionTokens = usage ? usage.completion_tokens : prevCompletion;
                        const totalTokens = usage ? usage.total_tokens : prevTotal;
                        const titleParts =
                            totalTokens > 0
                                ? `输入: ${promptTokens}, 输出: ${completionTokens}, 总计: ${totalTokens}`
                                : '';
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
                    }
                }

                if (progress.task_status !== this.task_status) {
                    this.task_status = progress.task_status;
                    this.updateStopButtonVisibility();
                    if (this.task_status !== 'running') {
                        // 流式结束：移除等待占位，隐藏 spinner
                        const waitingPlaceholder = history_container.querySelector('.waiting-usage-placeholder');
                        if (waitingPlaceholder) waitingPlaceholder.remove();
                        history_container.querySelectorAll('.usage-spinner').forEach((el) => {
                            el.style.display = 'none';
                        });
                        this.getHistoryContainer()
                            .querySelectorAll('details.reasoning-block[open]')
                            .forEach((el) => {
                                const contentEl = el.querySelector('.reasoning-content');
                                const textLength = contentEl ? contentEl.textContent.length : 0;
                                if (textLength > 200) {
                                    el.removeAttribute('open');
                                }
                            });
                    }
                }

                // 任务级待办的实时更新已通过 todomgr.taskTodosUpdated 事件单独订阅，
                // 这里无需再从工具调用进度里反推 TodoWrite 的执行状态。

                // 文件操作工具完成后，增量刷新工作空间文件浏览器
                if (progress.last_part && progress.last_part.type === 'tool_call') {
                    const FILE_TOOLS = new Set(['writeFile', 'editFile', 'searchReplace', 'applyPatch']);
                    const toolcalls = progress.last_part.toolcalls || [];
                    const hasFileOp = toolcalls.some(
                        (tc) => FILE_TOOLS.has(tc.tool_name) && (tc.status === 'success' || tc.status === 'error')
                    );
                    if (hasFileOp) {
                        const sidebar = this._getRightSidebarEl();
                        if (sidebar && typeof sidebar.softRefreshWorkspace === 'function') {
                            sidebar.softRefreshWorkspace();
                        }
                    }
                }

                this.tryScrollToEnd();
            });
        });
    }

    disconnectedCallback() {
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
                } catch (_) {}
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
            <div id="task-${this.task_id}-content-row" class="flex-1 flex flex-row min-h-0">
                <div class="flex-1 flex flex-col min-w-0">
                    <div class="relative flex-1 overflow-y-auto">
                        <!-- 对话历史区域 - 可滚动 -->
                        <div id="taskview-chat-history" class="w-full h-full space-y-2 overflow-y-auto px-3 pt-4" style="contain: layout style; will-change: transform;">
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

                    <!-- 输入区域 -->
                    <div class="px-3 pb-3 pt-1">
                        <agent-input id="task-${this.task_id}-input" />
                    </div>
                </div>

                <!-- 右侧边栏拖拽条 -->
                <div id="task-${this.task_id}-resizer"
                    class="resizer-group relative shrink-0"
                    style="background: linear-gradient(to right, transparent 40%, #e0e0e0 50%, transparent 60%); width: 4px; cursor: col-resize; display: ${TaskView.rightSidebarExpanded ? '' : 'none'};"
                >
                    <div class="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none">
                        <div class="resizer-handle-indicator resizer-blue" style="width: 2px; height: 3rem; border-radius: 9999px; background: #e5e7eb;"></div>
                    </div>
                </div>

                <!-- 右侧边栏（任务产物 / 任务计划 / 变更） -->
                <task-artifacts id="task-${this.task_id}-artifacts" style="display: ${TaskView.rightSidebarExpanded ? '' : 'none'}; width: ${TaskView.rightSidebarWidth}px;"></task-artifacts>
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
                TaskView.rightSidebarWidth = newWidth;
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
        input_widget.addEventListener('model-changed', async (event) => {
            const modelAlias = event.detail?.model;
            if (modelAlias) {
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
                        const { name, hasApplications } = await window.quickpassAPI.importQuickPass(message);
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

            this.task_status = 'running';
            this.updateStopButtonVisibility();

            // 立即显示带动画图标的 usage 面板
            const hc = this.getHistoryContainer();
            const existingPlaceholder = hc.querySelector('.waiting-usage-placeholder');
            if (!existingPlaceholder) {
                const prevUsageEls = hc.querySelectorAll('.message-usage');
                prevUsageEls.forEach((el) => el.remove());
                hc.insertAdjacentHTML(
                    'beforeend',
                    `
                    <div class="waiting-usage-placeholder flex items-start">
                        <div class="p-2 bg-transparent w-full">
                            ${TaskView.formatUsageHtml(null, this._modelContextSize, true)}
                        </div>
                    </div>
                `
                );
                this.tryScrollToEnd();
            }

            await window.taskManagerAPI.submitMessage(this.task_id, event.detail);
        });
        const chatHistory = this.querySelector('#taskview-chat-history');
        chatHistory.addEventListener('scroll', () => {
            if (this._programmaticScrolling) return;
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

        const scrollButton = this.querySelector('#taskview-scroll-to-bottom-button');
        scrollButton.addEventListener('click', () => {
            this.setAutoScrollingToBottom(true);
            this.tryScrollToEnd();
        });
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
    }

    getHistoryContainer() {
        if (this.history_container === null) {
            this.history_container = this.querySelector('#taskview-chat-history');
        }
        return this.history_container;
    }

    renderUserMessage(user_message) {
        if (user_message.content.length === 0) {
            return '';
        }

        let content = '';
        let hasTextPart = false;
        for (const part of user_message.content) {
            content += `<div class="${EmbeddedTaskView.USER_PART_CLASS_MAP[part.type]}">${part.rendered}</div>`;
            if (part.type === 'text') {
                hasTextPart = true;
            }
        }
        if (hasTextPart) {
            return `
            <div class="flex items-start flex-row-reverse">
                <div class="bg-white text-gray-900 rounded-lg px-3 py-1 max-w-3xl border border-gray-200">
                    ${content}
                </div>
            </div>
            `;
        } else {
            return `
            <div class="flex items-start flex-row-reverse">
                ${content}
            </div>
            `;
        }
    }

    static USER_PART_CLASS_MAP = {
        text: 'bg-transparent text-[13px] text-black markdown-body'
    };

    static ASSISTANT_PART_CLASS_MAP = {
        text: 'bg-transparent text-[13px] text-black markdown-body',
        reasoning: '',
        tool_call: ''
    };

    renderAssistantMessage(assistant_message) {
        let content = '';
        for (const part of assistant_message.content) {
            if (part.type === 'reasoning') {
                const isShort = (part.contentLength || 0) <= 200;
                content += TaskView.createReasoningPartHtml(part.rendered, isShort);
            } else {
                content += `<div class="${EmbeddedTaskView.ASSISTANT_PART_CLASS_MAP[part.type]}">${part.rendered}</div>`;
            }
        }
        const html = `
        <div class="flex items-start">
            <div class="p-2 bg-transparent w-full">
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
        <div class="flex items-start">
            <div class="p-2 bg-transparent w-full">
                <div id='message-${message_id}'>
                </div>
            </div>
        </div>
        `;
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
        for (const message of task_state.chat_context.messages) {
            if (message.role === 'user') {
                if (message.internal) continue;
                htmlParts.push(this.renderUserMessage(message));
            } else if (message.role === 'assistant') {
                htmlParts.push(this.renderAssistantMessage(message));
            } else if (TaskView.isCompactBoundaryMessage(message)) {
                htmlParts.push(TaskView.renderCompactBoundary());
            }
        }
        history_container.innerHTML = htmlParts.join('');
        this.tryScrollToEnd();
    }

    connectedCallback() {
        const task_id = this.getAttribute('task_id');
        if (task_id === null) {
            throw new Error('task_id is required');
        }
        this.task_id = task_id;

        this.render();
        this.reload().then(async () => {
            // 在首次加载完成后，发送一次初始状态事件
            this.emitTaskStatusChanged(this.task_status);

            this.subscription_id = await window.taskManagerAPI.subscribeTaskUpdate(this.task_id, (progress) => {
                const history_container = this.getHistoryContainer();

                if (progress.type === 'user') {
                    if (progress.internal) return;
                    const userMsg = {
                        content: [
                            {
                                type: progress.last_part.type,
                                rendered: progress.last_part.rendered || ''
                            }
                        ]
                    };
                    history_container.insertAdjacentHTML('beforeend', this.renderUserMessage(userMsg));
                } else {
                    let message_element = this.querySelector(`#message-${progress.message_id}`);
                    if (!message_element) {
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
                            message_element.insertAdjacentHTML(
                                'beforeend',
                                `<div class='${EmbeddedTaskView.ASSISTANT_PART_CLASS_MAP[progress.last_part.type]}'></div>`
                            );
                            message_element.querySelectorAll('details.reasoning-block[open]').forEach((el) => {
                                const contentEl = el.querySelector('.reasoning-content');
                                const textLength = contentEl ? contentEl.textContent.length : 0;
                                if (textLength > 200) {
                                    el.removeAttribute('open');
                                }
                            });
                        }
                    }
                    if (message_element) {
                        const last_part_element = message_element.children[progress.last_part_index];
                        if (last_part_element) {
                            if (progress.last_part.type === 'reasoning') {
                                const reasoningContent = last_part_element.querySelector('.reasoning-content');
                                if (reasoningContent) {
                                    reasoningContent.innerHTML = progress.last_part.rendered || '';
                                }
                            } else {
                                last_part_element.innerHTML = progress.last_part.rendered || '';
                            }

                            if (progress.last_part.type === 'tool_call') {
                                last_part_element.querySelectorAll('.terminal-tool-scroll').forEach((el) => {
                                    el.scrollTop = el.scrollHeight;
                                });
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
                            .querySelectorAll('details.reasoning-block[open]')
                            .forEach((el) => {
                                const contentEl = el.querySelector('.reasoning-content');
                                const textLength = contentEl ? contentEl.textContent.length : 0;
                                if (textLength > 200) {
                                    el.removeAttribute('open');
                                }
                            });
                    }
                }
            });
        });
    }

    disconnectedCallback() {
        window.taskManagerAPI.unsubscribeTaskUpdate(this.task_id, this.subscription_id);
        this.subscription_id = null;
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
        this.querySelector('#taskview-chat-history').addEventListener('scroll', (event) => {
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

        const hc = this.getHistoryContainer();
        if (hc) {
            this._domSanitizer = installDOMSanitizer(hc);
        }
    }
}

customElements.define('task-view', TaskView);
customElements.define('embedded-task-view', EmbeddedTaskView);
