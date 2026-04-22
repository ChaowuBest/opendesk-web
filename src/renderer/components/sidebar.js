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

import './statustags';
import { ElasticToolbarWidget } from './toolbar.ts';

const TASK_PAGE_SIZE = 30;

class SideBar extends HTMLElement {
    constructor() {
        super();

        /**
         * The current task id
         * @type {string | null}
         */
        this.currentTaskId = null;
        this.taskList = [];
        /** 当前已显示的根任务数量（子任务不计入） */
        this._displayedRootCount = 0;
        /** 是否正在加载更多 */
        this._loadingMore = false;
        /** 完整渲染列表的缓存 */
        this._fullRenderList = [];
    }

    connectedCallback() {
        this.render();
        window.taskManagerAPI.getTaskList().then((taskList) => {
            this.taskList = taskList;
            this.reloadTaskList();
            this.setUpEventListeners();
        });
    }

    disconnectedCallback() {
        if (this.unreadCountsUnsubscribe) {
            this.unreadCountsUnsubscribe();
        }
    }

    setUpEventListeners() {
        window.taskManagerAPI.subscribeTaskListUpdate((taskList) => {
            console.info('task list updated', taskList);
            this.taskList = taskList;
            this.reloadTaskList();
        });
        this.querySelector('#create-task-btn').addEventListener('click', async () => {
            const taskId = await window.taskManagerAPI.createTask();
            window.globalControlAPI.openTask(taskId);
            this.currentTaskId = taskId;
            this.reloadTaskList();
        });
        this.querySelector('#open-home-btn').addEventListener('click', () => {
            this.currentTaskId = null;
            window.globalControlAPI.openHomePage();
            this._updateTaskHighlight();
        });

        this._initWorkspaceBar();
    }

    async _initWorkspaceBar() {
        await this._refreshWorkspacePath();

        this.querySelector('#workspace-open-btn').addEventListener('click', async () => {
            const newPath = await window.workspaceAPI.selectWorkspaceDirectory();
            if (newPath) {
                await this._refreshWorkspacePath();
            }
        });

        const pathLabel = this.querySelector('#workspace-path-label');
        pathLabel.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this._showWorkspaceContextMenu(event.clientX, event.clientY);
        });
    }

    async _refreshWorkspacePath() {
        try {
            const workspacePath = await window.workspaceAPI.getEffectiveWorkspace();
            const pathLabel = this.querySelector('#workspace-path-label');
            if (pathLabel) {
                pathLabel.textContent = workspacePath;
                pathLabel.title = workspacePath;
            }
        } catch (error) {
            console.error('Failed to get workspace path:', error);
        }
    }

    _showWorkspaceContextMenu(x, y) {
        this._dismissWorkspaceContextMenu();

        const menu = document.createElement('div');
        menu.id = 'workspace-context-menu';
        menu.className =
            'fixed z-[9999] bg-white rounded-xl shadow-xl border border-gray-200 py-1 min-w-[180px] text-sm text-gray-700 animate-in fade-in';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        menu.innerHTML = `
            <button data-action="copy" class="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-gray-100 transition-colors duration-150">
                <i class="fa-solid fa-copy w-4 text-center"></i>
                <span>复制工作空间路径</span>
            </button>
            <button data-action="open" class="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-gray-100 transition-colors duration-150">
                <i class="fa-solid fa-folder-open w-4 text-center"></i>
                <span>打开工作空间目录</span>
            </button>
        `;

        this.appendChild(menu);

        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                menu.style.left = `${window.innerWidth - rect.width - 8}px`;
            }
            if (rect.bottom > window.innerHeight) {
                menu.style.top = `${window.innerHeight - rect.height - 8}px`;
            }
        });

        menu.querySelector('[data-action="copy"]').addEventListener('click', async () => {
            this._dismissWorkspaceContextMenu();
            try {
                await window.workspaceAPI.copyWorkspacePath();
            } catch (error) {
                console.error('Failed to copy workspace path:', error);
            }
        });

        menu.querySelector('[data-action="open"]').addEventListener('click', async () => {
            this._dismissWorkspaceContextMenu();
            try {
                await window.workspaceAPI.openWorkspaceDirectory();
            } catch (error) {
                console.error('Failed to open workspace directory:', error);
            }
        });

        const dismissHandler = (e) => {
            if (!menu.contains(e.target)) {
                this._dismissWorkspaceContextMenu();
                document.removeEventListener('click', dismissHandler, true);
            }
        };
        setTimeout(() => document.addEventListener('click', dismissHandler, true), 0);
    }

    _dismissWorkspaceContextMenu() {
        const existing = this.querySelector('#workspace-context-menu');
        if (existing) existing.remove();
    }

    render() {
        this.innerHTML = `
        <style>
            [x-cloak] {
                display: none !important;
            }
        </style>

        <div class="h-full flex flex-col" x-data="{ showApps: false }">
            <header class="py-2 px-1 flex flex-row items-start flex-shrink-0">
                <img src="./images/icon_round.png" alt="OpenDesk Icon" class="w-12 h-12 mr-3"/>
                <div class="flex flex-col items-start">
                    <img src="./images/banner.png" alt="OpenDesk Banner" class="w-32 h-auto"/>
                    <p class="text-xs mt-1 text-gray-500">一站式智慧办公空间</p>
                </div>
            </header>
            <div class="py-2 flex flex-row gap-2 flex-shrink-0">
                <button
                    id="open-home-btn"
                    class="flex-1 flex items-center justify-center gap-1 px-2 py-3 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-2xl text-gray-700 font-normal text-sm transition-colors duration-200"
                >
                    <i class="fa-solid fa-house"></i>
                    <span>主页</span>
                </button>
                <button
                    id="open-apps-btn"
                    @click="showApps = !showApps"
                        :class="showApps ? 'ring-2 ring-orange-400 bg-orange-50' : ''"
                    class="flex-1 flex items-center justify-center gap-1 px-2 py-3 bg-green-50 hover:bg-green-100 border border-green-200 rounded-2xl text-green-700 font-normal text-sm transition-colors duration-200"
                >
                    <i class="fa-solid fa-th-large"></i>
                    <span>应用</span>
                </button>
                <button
                    id="create-task-btn"
                    class="flex-1 flex items-center justify-center gap-1 px-2 py-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-2xl text-blue-700 font-normal text-sm transition-colors duration-200"
                >
                    <i class="fa-solid fa-comments"></i>
                    <span>新任务</span>
                </button>
            </div>

            <div
                x-cloak
                x-show="showApps"
                x-transition:enter="transition ease-out duration-300"
                x-transition:enter-start="opacity-0 transform translate-y-4"
                x-transition:enter-end="opacity-100 transform translate-y-0"
                class="bg-white/90 backdrop-blur-xl rounded-2xl p-4 border border-white/50 shadow-sm my-1"
            >
                <div id="app-container" class="flex flex-wrap gap-y-5 gap-x-2 items-center justify-left">

                </div>
            </div>

            <div id="workspace-bar" class="flex items-center gap-1.5 px-2 py-1.5 my-1 mx-0 bg-white/60 backdrop-blur-sm rounded-xl border border-gray-100 flex-shrink-0">
                <i class="fa-solid fa-briefcase text-[10px] text-gray-400 flex-shrink-0"></i>
                <span
                    id="workspace-path-label"
                    class="flex-1 text-[11px] text-gray-500 truncate cursor-default select-none leading-tight"
                    title=""
                ></span>
                <button
                    id="workspace-open-btn"
                    class="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50/80 transition-colors duration-150"
                    title="选择工作空间"
                >
                    <i class="fa-solid fa-folder-open text-[10px]"></i>
                </button>
            </div>

            <div id="task-list-container" class="flex-1 overflow-y-auto py-2 pr-2">
            </div>

            <div id="sidebar-bottom-toolbar" class="flex-shrink-0 w-full flex justify-center items-center py-3">
            </div>
        </div>
        `;
        this._createBottomToolbar();
        this.reloadApplicationList();
    }

    _createBottomToolbar() {
        const toolbar = new ElasticToolbarWidget([
            {
                id: 'open-memory-btn',
                icon: 'fa-hard-drive',
                label: '记忆',
                action: () => {
                    // window.globalControlAPI.openMemory();
                }
            },
            {
                id: 'open-file-system-btn',
                icon: 'fa-folder-open',
                label: '文件系统',
                action: () => {
                    window.globalControlAPI.openApplication('filemgr');
                }
            },
            {
                id: 'open-setting-editor-btn',
                icon: 'fa-cog',
                label: '设置',
                action: () => {
                    window.globalControlAPI.openSettingEditor();
                }
            },
            {
                id: 'open-dev-tools-btn',
                icon: 'fa-terminal',
                label: '开发工具',
                action: () => {
                    window.settingAPI.openDevTools();
                }
            },
            {
                id: 'open-log-view-btn',
                icon: 'fa-file-lines',
                label: '日志',
                action: () => {
                    window.globalControlAPI.openLogView();
                }
            }
        ]);

        // 覆盖默认样式以匹配侧边栏毛玻璃风格
        toolbar.classList.add('sidebar-bottom');
        const container = this.querySelector('#sidebar-bottom-toolbar');
        if (container) {
            container.appendChild(toolbar);
        }

        // 禁用记忆按钮
        const memoryBtn = toolbar.querySelector(`[id^="open-memory-btn"]`);
        if (memoryBtn) {
            memoryBtn.disabled = true;
        }
    }

    async reloadApplicationList() {
        const app_container = this.querySelector('#app-container');
        app_container.innerHTML = '';
        const appList = await window.applicationRegistryAPI.getApplicationList();
        for (const app of appList) {
            if (app.showIcon === false) continue;
            const isMailbox = app.bundleName === 'mailbox';
            app_container.innerHTML += `
            <div class="flex flex-col items-center group cursor-pointer relative" onclick="window.globalControlAPI.openApplication('${app.bundleName}')" data-bundle-name="${app.bundleName}">
                <div class="rounded-full w-12 h-12 shadow-lg transform transition duration-200 group-hover:brightness-90 group-active:scale-95 flex items-center justify-center relative">
                    <img src="./applications/${app.bundleName}/icon.png" alt="${app.name}" class="w-full h-full object-cover">
                    ${isMailbox ? '<span class="mailbox-unread-badge absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 hidden">0</span>' : ''}
                </div>
                <span class="mt-2 text-xs font-medium text-gray-800 drop-shadow-sm w-16 text-center truncate">${app.name}</span>
            </div>
            `;
        }
        // 更新邮箱应用的未读数量标记
        this.updateMailboxBadge();
    }

    async updateMailboxBadge() {
        try {
            const counts = await window.applicationRegistryAPI.call('mailbox', 'getAllNewEmailCounts');
            const total = Object.values(counts || {}).reduce((sum, count) => sum + (count || 0), 0);
            const mailboxApp = this.querySelector('[data-bundle-name="mailbox"]');
            if (mailboxApp) {
                const badge = mailboxApp.querySelector('.mailbox-unread-badge');
                if (badge) {
                    if (total > 0) {
                        badge.textContent = total > 99 ? '99+' : total.toString();
                        badge.classList.remove('hidden');
                    } else {
                        badge.classList.add('hidden');
                    }
                }
            }
        } catch (error) {
            console.error('Failed to update mailbox badge:', error);
        }
    }

    connectedCallback() {
        this.render();
        window.taskManagerAPI.getTaskList().then((taskList) => {
            this.taskList = taskList;
            this.reloadTaskList();
            this.setUpEventListeners();
            this.subscribeToUnreadCounts();
        });
    }

    disconnectedCallback() {
        if (this.unreadCountsUnsubscribe) {
            this.unreadCountsUnsubscribe();
        }
    }

    async subscribeToUnreadCounts() {
        // 订阅新邮件数量更新事件
        try {
            this.unreadCountsUnsubscribe = await window.applicationRegistryAPI.subscribeEvent(
                'mailbox',
                'newEmailCountsUpdated',
                (counts) => {
                    const total = Object.values(counts || {}).reduce((sum, count) => sum + (count || 0), 0);
                    const mailboxApp = this.querySelector('[data-bundle-name="mailbox"]');
                    if (mailboxApp) {
                        const badge = mailboxApp.querySelector('.mailbox-unread-badge');
                        if (badge) {
                            if (total > 0) {
                                badge.textContent = total > 99 ? '99+' : total.toString();
                                badge.classList.remove('hidden');
                            } else {
                                badge.classList.add('hidden');
                            }
                        }
                    }
                }
            );
            // 初始加载新邮件数量
            this.updateMailboxBadge();
        } catch (error) {
            console.error('Failed to subscribe to new email counts:', error);
        }
    }

    buildTaskRenderList() {
        const childrenByParent = new Map();
        const rootTasks = [];

        for (const task of this.taskList) {
            if (task.parent_id) {
                if (!childrenByParent.has(task.parent_id)) {
                    childrenByParent.set(task.parent_id, []);
                }
                childrenByParent.get(task.parent_id).push(task);
            } else {
                rootTasks.push(task);
            }
        }

        const renderList = [];
        const visited = new Set();
        const appendTask = (task, depth) => {
            if (!task || visited.has(task.task_id)) return;
            visited.add(task.task_id);
            renderList.push({ task, depth });
            const children = childrenByParent.get(task.task_id) || [];
            for (const child of [...children].reverse()) {
                appendTask(child, depth + 1);
            }
        };

        for (const rootTask of [...rootTasks].reverse()) {
            appendTask(rootTask, 0);
        }

        for (const task of [...this.taskList].reverse()) {
            if (!visited.has(task.task_id)) {
                appendTask(task, 0);
            }
        }

        return renderList;
    }

    _buildTaskItemHtml(item) {
        const standardClass = 'cursor-pointer rounded-xl pr-2 py-2 mb-2 transition-colors duration-200';
        const task = item.task;
        const depth = item.depth;
        const indentPx = 12 + Math.min(depth, 5) * 14;

        let taskStyle = '';
        let connectorHtml = '';
        const isCurrentTask = task.task_id === this.currentTaskId;
        const isSubTask = depth > 0;

        if (isSubTask) {
            const connectorColor = isCurrentTask ? 'bg-[#C94C40]' : 'bg-gray-300';
            const connectorLineColor = isCurrentTask ? 'bg-[#C94C40]' : 'bg-gray-300';
            connectorHtml = `<span class="inline-block w-4 h-full mr-1 relative flex-shrink-0">
                <span class="absolute left-0 top-0 bottom-0 ${connectorLineColor}" style="height:calc(100% - 0.5rem);top:0.5rem;width:2px;"></span>
                <span class="absolute left-0 top-1/2 -translate-y-1/2 ${connectorColor}" style="width:8px;height:8px;border-radius:50%;left:0;"></span>
            </span>`;
            if (isCurrentTask) {
                taskStyle = 'text-[#C94C40] font-semibold border border-[#C94C40]';
            } else {
                taskStyle = 'bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200';
            }
        } else if (isCurrentTask) {
            taskStyle = 'bg-[#C94C40] text-white font-semibold';
        } else {
            taskStyle = 'bg-white text-gray-700 hover:shadow-sm hover:border-l-2 hover:border-l-[#C94C40]';
        }

        const taskNameClass = isSubTask ? 'text-xs truncate' : 'text-sm truncate';
        const subTaskBadge = isSubTask
            ? '<span class="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-600 font-medium">子</span>'
            : '';

        return `
        <div
            class="task-item ${taskStyle} ${standardClass} ${isSubTask ? 'py-1.5' : ''}"
            style="padding-left:${indentPx}px"
            data-task_id="${task.task_id}"
            data-parent_id="${task.parent_id || ''}"
            data-depth="${depth}"
        >
            <div class="flex items-center justify-between min-w-0 gap-2">
                <div class="flex items-center flex-1 min-w-0 overflow-hidden gap-1">
                    ${connectorHtml}
                    <p class="${taskNameClass} flex-shrink-0">${task.task_name || '未命名任务'}</p>
                    ${subTaskBadge}
                    ${task.task_status === 'running' ? '<task-status-tag class="flex-shrink-0 ml-1"></task-status-tag>' : ''}
                </div>
                <button
                    class="delete-task-btn flex-shrink-0 ${isSubTask ? 'w-4 h-4' : 'w-5 h-5'} flex items-center justify-center rounded-full bg-white hover:bg-[#FFF8E7] transition-colors duration-200"
                    data-task_id="${task.task_id}"
                    title="删除"
                >
                    <span class="${isSubTask ? 'text-xs' : 'text-sm'} text-gray-600 pointer-events-none hover:text-white transition-colors duration-200" style="line-height:1;">×</span>
                </button>
            </div>
        </div>
        `;
    }

    /**
     * 获取截止到第 rootLimit 个根任务（含其所有子任务）的渲染列表
     */
    _sliceRenderList(renderList, rootLimit) {
        const result = [];
        let rootCount = 0;
        for (const item of renderList) {
            if (item.depth === 0) {
                rootCount++;
                if (rootCount > rootLimit) break;
            }
            result.push(item);
        }
        return result;
    }

    _countRootTasks(renderList) {
        let count = 0;
        for (const item of renderList) {
            if (item.depth === 0) count++;
        }
        return count;
    }

    _loadMoreTasks() {
        if (this._loadingMore) return;
        const fullRenderList = this._fullRenderList;
        const totalRootTasks = this._countRootTasks(fullRenderList);
        if (this._displayedRootCount >= totalRootTasks) return;

        this._loadingMore = true;
        const taskListContainer = this.querySelector('#task-list-container');
        const sentinel = this.querySelector('#task-list-sentinel');

        // 插入加载动画
        const loadingEl = document.createElement('div');
        loadingEl.id = 'task-list-loading';
        loadingEl.className = 'flex items-center justify-center py-3';
        loadingEl.innerHTML = `
            <div class="flex items-center gap-2 text-gray-400 text-xs">
                <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"/>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                <span>加载更多任务...</span>
            </div>
        `;
        if (sentinel) {
            taskListContainer.insertBefore(loadingEl, sentinel);
        } else {
            taskListContainer.appendChild(loadingEl);
        }

        setTimeout(() => {
            const nextLimit = this._displayedRootCount + TASK_PAGE_SIZE;
            const slicedBefore = this._sliceRenderList(fullRenderList, this._displayedRootCount);
            const slicedAfter = this._sliceRenderList(fullRenderList, nextLimit);
            const newItems = slicedAfter.slice(slicedBefore.length);

            const loadingIndicator = this.querySelector('#task-list-loading');
            if (loadingIndicator) loadingIndicator.remove();

            const fragment = document.createDocumentFragment();
            for (const item of newItems) {
                const wrapper = document.createElement('div');
                wrapper.innerHTML = this._buildTaskItemHtml(item);
                const el = wrapper.firstElementChild;
                el.style.opacity = '0';
                el.style.transform = 'translateY(8px)';
                el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
                fragment.appendChild(el);
            }

            if (sentinel) {
                taskListContainer.insertBefore(fragment, sentinel);
            } else {
                taskListContainer.appendChild(fragment);
            }

            // 触发入场动画
            requestAnimationFrame(() => {
                const allItems = taskListContainer.querySelectorAll('.task-item');
                allItems.forEach((el) => {
                    if (el.style.opacity === '0') {
                        el.style.opacity = '1';
                        el.style.transform = 'translateY(0)';
                    }
                });
            });

            this._displayedRootCount = nextLimit;
            this._loadingMore = false;

            this._bindTaskItemEvents(taskListContainer);
        }, 400);
    }

    /**
     * 仅更新任务列表中的选中高亮样式，不做 DOM 重建
     */
    _updateTaskHighlight() {
        const container = this.querySelector('#task-list-container');
        if (!container) return;

        container.querySelectorAll('.task-item').forEach((item) => {
            const taskId = item.dataset.task_id;
            const depth = parseInt(item.dataset.depth || '0', 10);
            const isCurrentTask = taskId === this.currentTaskId;
            const isSubTask = depth > 0;

            // 清除所有可能的选中/非选中样式
            item.classList.remove(
                'bg-[#C94C40]',
                'text-white',
                'font-semibold',
                'text-[#C94C40]',
                'border',
                'border-[#C94C40]',
                'bg-gray-50',
                'text-gray-700',
                'hover:bg-gray-100',
                'border-gray-200',
                'bg-white',
                'hover:shadow-sm',
                'hover:border-l-2',
                'hover:border-l-[#C94C40]'
            );

            if (isSubTask) {
                if (isCurrentTask) {
                    item.classList.add('text-[#C94C40]', 'font-semibold', 'border', 'border-[#C94C40]');
                } else {
                    item.classList.add('bg-gray-50', 'text-gray-700', 'hover:bg-gray-100', 'border', 'border-gray-200');
                }
                // 更新连接器颜色
                const connectorDot = item.querySelector('span > span:last-child');
                const connectorLine = item.querySelector('span > span:first-child');
                if (connectorDot) {
                    connectorDot.classList.toggle('bg-[#C94C40]', isCurrentTask);
                    connectorDot.classList.toggle('bg-gray-300', !isCurrentTask);
                }
                if (connectorLine) {
                    connectorLine.classList.toggle('bg-[#C94C40]', isCurrentTask);
                    connectorLine.classList.toggle('bg-gray-300', !isCurrentTask);
                }
            } else if (isCurrentTask) {
                item.classList.add('bg-[#C94C40]', 'text-white', 'font-semibold');
            } else {
                item.classList.add(
                    'bg-white',
                    'text-gray-700',
                    'hover:shadow-sm',
                    'hover:border-l-2',
                    'hover:border-l-[#C94C40]'
                );
            }
        });
    }

    _dismissContextMenu() {
        const existing = this.querySelector('#task-context-menu');
        if (existing) existing.remove();
    }

    _showContextMenu(x, y, taskId) {
        this._dismissContextMenu();

        const menu = document.createElement('div');
        menu.id = 'task-context-menu';
        menu.className =
            'fixed z-[9999] bg-white rounded-xl shadow-xl border border-gray-200 py-1 min-w-[160px] text-sm text-gray-700 animate-in fade-in';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        const items = [
            { id: 'fork', icon: 'fa-solid fa-code-fork', label: '复制并创建任务' },
            { id: 'delete-all', icon: 'fa-solid fa-trash', label: '删除全部任务', danger: true }
        ];

        menu.innerHTML = items
            .map(
                (item) => `
            <button
                data-action="${item.id}"
                class="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-gray-100 transition-colors duration-150 ${item.danger ? 'text-red-500 hover:bg-red-50' : ''}"
            >
                <i class="${item.icon} w-4 text-center"></i>
                <span>${item.label}</span>
            </button>`
            )
            .join('');

        this.appendChild(menu);

        // 确保菜单不超出视口
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                menu.style.left = `${window.innerWidth - rect.width - 8}px`;
            }
            if (rect.bottom > window.innerHeight) {
                menu.style.top = `${window.innerHeight - rect.height - 8}px`;
            }
        });

        menu.querySelector('[data-action="fork"]').addEventListener('click', async () => {
            this._dismissContextMenu();
            try {
                const forkedTaskId = await window.taskManagerAPI.forkTask(taskId);
                window.globalControlAPI.openTask(forkedTaskId);
                this.currentTaskId = forkedTaskId;
                this.reloadTaskList();
            } catch (error) {
                console.error('Failed to fork task:', error);
            }
        });

        menu.querySelector('[data-action="delete-all"]').addEventListener('click', async () => {
            this._dismissContextMenu();
            if (!window.confirm('确定要删除所有任务吗？删除后无法恢复。')) return;
            window.globalControlAPI.clearAllTaskViewCache();
            window.globalControlAPI.openHomePage();
            this.currentTaskId = null;
            await window.taskManagerAPI.clearAllTasks();
            this.reloadTaskList();
        });

        const dismissHandler = (e) => {
            if (!menu.contains(e.target)) {
                this._dismissContextMenu();
                document.removeEventListener('click', dismissHandler, true);
            }
        };
        setTimeout(() => document.addEventListener('click', dismissHandler, true), 0);
    }

    _bindTaskItemEvents(container) {
        container.querySelectorAll('.task-item').forEach((item) => {
            if (item._bound) return;
            item._bound = true;
            item.addEventListener('click', (event) => {
                const taskId = event.currentTarget.dataset.task_id;
                window.globalControlAPI.openTask(taskId);
                this.currentTaskId = taskId;
                this._updateTaskHighlight();
            });
            item.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const taskId = event.currentTarget.dataset.task_id;
                this._showContextMenu(event.clientX, event.clientY, taskId);
            });
        });

        container.querySelectorAll('.delete-task-btn').forEach((btn) => {
            if (btn._bound) return;
            btn._bound = true;
            btn.addEventListener('click', async (event) => {
                event.stopPropagation();
                const confirmDelete = window.confirm('确定要删除这个任务吗？删除后无法恢复。');
                if (!confirmDelete) return;

                const taskId = event.currentTarget.dataset.task_id;
                window.globalControlAPI.removeTaskViewCache(taskId);
                if (this.currentTaskId === taskId) {
                    window.globalControlAPI.openTask(null);
                }
                await window.taskManagerAPI.removeTask(taskId);
            });
        });
    }

    reloadTaskList() {
        const standardClass = 'cursor-pointer rounded-xl pr-2 py-2 mb-2 transition-colors duration-200';
        const taskListContainer = this.querySelector('#task-list-container');
        taskListContainer.innerHTML = '';

        const fullRenderList = this.buildTaskRenderList();
        this._fullRenderList = fullRenderList;
        const totalRootTasks = this._countRootTasks(fullRenderList);

        const initialSlice = this._sliceRenderList(fullRenderList, TASK_PAGE_SIZE);
        this._displayedRootCount = Math.min(TASK_PAGE_SIZE, totalRootTasks);

        const htmlParts = [];
        for (const item of initialSlice) {
            htmlParts.push(this._buildTaskItemHtml(item));
        }

        if (totalRootTasks > TASK_PAGE_SIZE) {
            htmlParts.push(`
            <div id="task-list-sentinel" class="flex items-center justify-center py-2 text-gray-400 text-xs">
                <span>↓ 滚动加载更多（共 ${totalRootTasks} 个任务）</span>
            </div>
            `);
        }

        if (this.taskList.length > 0) {
            htmlParts.push(`
            <div id="delete-all-tasks-btn" class="${standardClass} bg-white text-sm text-gray-700 hover:bg-[#C94C40] hover:text-white flex items-center justify-center gap-2">
                <i class="fa-solid fa-trash"></i>
                <span>全部删除</span>
            </div>
            `);
        }

        taskListContainer.innerHTML = htmlParts.join('');

        this._bindTaskItemEvents(taskListContainer);

        this.querySelector('#delete-all-tasks-btn')?.addEventListener('click', async (event) => {
            event.stopPropagation();
            if (!window.confirm('确定要删除所有任务吗？删除后无法恢复。')) return;
            window.globalControlAPI.clearAllTaskViewCache();
            window.globalControlAPI.openHomePage();
            this.currentTaskId = null;
            await window.taskManagerAPI.clearAllTasks();
            this.reloadTaskList();
        });

        // IntersectionObserver 实现下拉到底延迟加载
        const sentinel = this.querySelector('#task-list-sentinel');
        if (sentinel) {
            if (this._scrollObserver) {
                this._scrollObserver.disconnect();
            }
            this._scrollObserver = new IntersectionObserver(
                (entries) => {
                    for (const entry of entries) {
                        if (entry.isIntersecting) {
                            this._loadMoreTasks();
                            const totalRoot = this._countRootTasks(this._fullRenderList);
                            if (this._displayedRootCount >= totalRoot) {
                                this._scrollObserver.disconnect();
                                const s = this.querySelector('#task-list-sentinel');
                                if (s) s.remove();
                            }
                        }
                    }
                },
                { root: taskListContainer, threshold: 0.1 }
            );
            this._scrollObserver.observe(sentinel);
        }
    }
}

customElements.define('main-sidebar', SideBar);
