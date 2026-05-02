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
import { showConfirmModal } from './confirmModal.ts';

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
        this._searchQuery = '';
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

    setUpEventListeners() {
        window.taskManagerAPI.subscribeTaskListUpdate((taskList) => {
            console.info('task list updated', taskList);
            this.taskList = taskList;
            this.reloadTaskList();
            document.dispatchEvent(new CustomEvent('task-list-updated', { detail: taskList }));
        });
        this.querySelector('#create-task-btn').addEventListener('click', () => {
            this.currentTaskId = null;
            window.globalControlAPI.openHomePage();
            this._updateTaskHighlight();
        });
        this.querySelector('#open-skills-btn').addEventListener('click', () => {
            window.globalControlAPI.openApplication('skillmgr');
        });

        const searchInput = this.querySelector('#task-search-input');
        const searchClear = this.querySelector('#task-search-clear');
        searchInput.addEventListener('input', () => {
            this._searchQuery = searchInput.value.trim();
            searchClear.style.display = this._searchQuery ? 'flex' : 'none';
            this.reloadTaskList();
        });
        searchClear.addEventListener('click', () => {
            searchInput.value = '';
            this._searchQuery = '';
            searchClear.style.display = 'none';
            this.reloadTaskList();
            searchInput.focus();
        });

        const appsBtn = this.querySelector('#open-apps-btn');
        const popover = this.querySelector('#app-popover');
        appsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = !popover.classList.contains('sb-app-popover-hidden');
            if (isVisible) {
                this._dismissAppPopover();
            } else {
                this._showAppPopover();
            }
        });
        this._appPopoverDismissHandler = (e) => {
            if (!popover.contains(e.target) && !appsBtn.contains(e.target)) {
                this._dismissAppPopover();
            }
        };
        document.addEventListener('click', this._appPopoverDismissHandler, true);
    }

    _showAppPopover() {
        const popover = this.querySelector('#app-popover');
        const appsBtn = this.querySelector('#open-apps-btn');
        if (!popover || !appsBtn) return;

        popover.classList.remove('sb-app-popover-hidden');
        popover.classList.add('sb-app-popover-visible');
        appsBtn.classList.add('sb-nav-btn-active');

        const btnRect = appsBtn.getBoundingClientRect();
        popover.style.position = 'fixed';
        popover.style.left = `${btnRect.left}px`;
        popover.style.top = `${btnRect.bottom + 4}px`;

        requestAnimationFrame(() => {
            const popRect = popover.getBoundingClientRect();
            if (popRect.right > window.innerWidth) {
                popover.style.left = `${window.innerWidth - popRect.width - 8}px`;
            }
            if (popRect.bottom > window.innerHeight) {
                popover.style.top = `${btnRect.top - popRect.height - 4}px`;
            }
        });
    }

    _dismissAppPopover() {
        const popover = this.querySelector('#app-popover');
        const appsBtn = this.querySelector('#open-apps-btn');
        if (popover) {
            popover.classList.add('sb-app-popover-hidden');
            popover.classList.remove('sb-app-popover-visible');
        }
        if (appsBtn) {
            appsBtn.classList.remove('sb-nav-btn-active');
        }
    }

    render() {
        this.innerHTML = `
        <div class="h-full flex flex-col">
            <header class="py-2 px-1 flex flex-row items-start flex-shrink-0">
                <img src="./images/icon_round.png" alt="OpenDesk Icon" class="w-12 h-12 mr-3"/>
                <div class="flex flex-col items-start">
                    <img src="./images/banner.png" alt="OpenDesk Banner" class="w-32 h-auto"/>
                    <p class="text-xs mt-1 text-gray-500">一站式智慧办公空间</p>
                </div>
            </header>

            <!-- Search -->
            <div class="sb-search-v2">
                <i class="fa-solid fa-magnifying-glass sb-search-v2-icon"></i>
                <input type="text" id="task-search-input" placeholder="搜索..." class="sb-search-v2-input" />
                <button id="task-search-clear" class="sb-search-v2-clear" style="display:none;">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <div class="sb-nav-row flex flex-row gap-1.5 flex-shrink-0" style="margin: 4px 0; position: relative;">
                <button
                    id="create-task-btn"
                    class="sb-nav-btn"
                >
                    <i class="fa-solid fa-house" style="font-size: 12px;"></i>
                    <span>新任务</span>
                </button>
                <button
                    id="open-apps-btn"
                    class="sb-nav-btn"
                >
                    <i class="fa-solid fa-th-large" style="font-size: 12px;"></i>
                    <span>应用</span>
                </button>
                <button
                    id="open-skills-btn"
                    class="sb-nav-btn"
                >
                    <i class="fa-solid fa-wand-magic-sparkles" style="font-size: 12px;"></i>
                    <span>技能</span>
                </button>
            </div>

            <div id="app-popover" class="sb-app-popover sb-app-popover-hidden"></div>

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
        const popover = this.querySelector('#app-popover');
        if (!popover) return;
        popover.innerHTML = '';
        const appList = await window.applicationRegistryAPI.getApplicationList();
        const visibleApps = appList.filter((app) => app.showIcon !== false);

        let gridHtml = '<div class="sb-app-popover-grid">';
        for (const app of visibleApps) {
            const isMailbox = app.bundleName === 'mailbox';
            gridHtml += `
            <div class="sb-app-popover-item" data-bundle-name="${app.bundleName}">
                <div class="sb-app-popover-icon-wrap">
                    <img src="./applications/${app.bundleName}/icon.png" alt="${app.name}">
                    ${isMailbox ? '<span class="mailbox-unread-badge">0</span>' : ''}
                </div>
                <span class="sb-app-popover-label">${app.name}</span>
            </div>
            `;
        }
        gridHtml += '</div>';
        popover.innerHTML = gridHtml;

        popover.querySelectorAll('.sb-app-popover-item').forEach((item) => {
            item.addEventListener('click', () => {
                const bundleName = item.dataset.bundleName;
                window.globalControlAPI.openApplication(bundleName);
                this._dismissAppPopover();
            });
        });

        this.updateMailboxBadge();
    }

    async updateMailboxBadge() {
        try {
            const counts = await window.applicationRegistryAPI.call('mailbox', 'getAllNewEmailCounts');
            const total = Object.values(counts || {}).reduce((sum, count) => sum + (count || 0), 0);
            this._applyMailboxBadge(total);
        } catch (error) {
            console.error('Failed to update mailbox badge:', error);
        }
    }

    _applyMailboxBadge(total) {
        const mailboxApp = this.querySelector('[data-bundle-name="mailbox"]');
        if (!mailboxApp) return;
        const badge = mailboxApp.querySelector('.mailbox-unread-badge');
        if (!badge) return;
        if (total > 0) {
            badge.textContent = total > 99 ? '99+' : total.toString();
            badge.classList.add('visible');
        } else {
            badge.classList.remove('visible');
        }
    }

    async subscribeToUnreadCounts() {
        try {
            this.unreadCountsUnsubscribe = await window.applicationRegistryAPI.subscribeEvent(
                'mailbox',
                'newEmailCountsUpdated',
                (counts) => {
                    const total = Object.values(counts || {}).reduce((sum, count) => sum + (count || 0), 0);
                    this._applyMailboxBadge(total);
                }
            );
            this.updateMailboxBadge();
        } catch (error) {
            console.error('Failed to subscribe to new email counts:', error);
        }
    }

    _getFilteredTaskList() {
        if (!this._searchQuery) return this.taskList;
        const query = this._searchQuery.toLowerCase();
        return this.taskList.filter((task) => {
            const name = (task.task_name || '').toLowerCase();
            return name.includes(query);
        });
    }

    buildTaskRenderList() {
        const list = this._getFilteredTaskList();
        const childrenByParent = new Map();
        const rootTasks = [];

        for (const task of list) {
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

        for (const task of [...list].reverse()) {
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

    _updateTaskHighlight() {
        const container = this.querySelector('#task-list-container');
        if (!container) return;

        container.querySelectorAll('.task-item').forEach((item) => {
            const taskId = item.dataset.task_id;
            const depth = parseInt(item.dataset.depth || '0', 10);
            const isCurrentTask = taskId === this.currentTaskId;
            const isSubTask = depth > 0;

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
        Object.assign(menu.style, {
            position: 'fixed',
            zIndex: '9999',
            minWidth: '180px',
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
            { id: 'fork', icon: 'fa-solid fa-code-fork', label: '复制并创建任务' },
            { id: 'delete', icon: 'fa-solid fa-trash-can', label: '删除任务', danger: true },
            { id: 'delete-all', icon: 'fa-solid fa-trash', label: '删除全部任务', danger: true }
        ];

        const btnStyle = `display:flex; align-items:center; gap:8px; width:100%; padding:6px 10px; border:none; border-radius:6px; background:transparent; font-size:12px; cursor:pointer; text-align:left; transition:background 0.1s;`;
        const iconStyle = 'width:16px; text-align:center; font-size:12px; flex-shrink:0;';

        menu.innerHTML = items
            .map((item, i) => {
                const needSep = item.id === 'delete';
                const sep = needSep
                    ? '<div style="height:1px; margin:3px 8px; background:rgba(0,0,0,0.06);"></div>'
                    : '';
                const color = item.danger ? '#dc2626' : '#1f2937';
                const iconColor = item.danger ? '#dc2626' : '#6b7280';
                return (
                    `${sep}<button data-action="${item.id}" data-danger="${item.danger ? '1' : ''}" style="${btnStyle} color:${color};">` +
                    `<i class="${item.icon}" style="${iconStyle} color:${iconColor};"></i><span>${item.label}</span></button>`
                );
            })
            .join('');

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

        menu.querySelectorAll('[data-action]').forEach((btn) => {
            const isDanger = btn.dataset.danger === '1';
            btn.addEventListener('mouseenter', () => {
                btn.style.background = isDanger ? '#fef2f2' : '#3b82f6';
                btn.style.color = isDanger ? '#b91c1c' : 'white';
                const icon = btn.querySelector('i');
                if (icon) icon.style.color = isDanger ? '#b91c1c' : 'white';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.background = 'transparent';
                btn.style.color = isDanger ? '#dc2626' : '#1f2937';
                const icon = btn.querySelector('i');
                if (icon) icon.style.color = isDanger ? '#dc2626' : '#6b7280';
            });
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

        menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
            this._dismissContextMenu();
            const confirmed = await showConfirmModal({
                icon: 'fa-trash-can',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: '删除任务',
                message: '确定要删除这个任务吗？<b>删除后无法恢复。</b>',
                confirmText: '删除',
                cancelText: '取消',
                danger: true
            });
            if (!confirmed) return;
            window.globalControlAPI.removeTaskViewCache(taskId);
            if (this.currentTaskId === taskId) {
                window.globalControlAPI.openTask(null);
            }
            await window.taskManagerAPI.removeTask(taskId);
        });

        menu.querySelector('[data-action="delete-all"]').addEventListener('click', async () => {
            this._dismissContextMenu();
            const confirmed = await showConfirmModal({
                icon: 'fa-trash',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: '删除全部任务',
                message: '确定要删除所有任务吗？<b>删除后无法恢复。</b>',
                confirmText: '全部删除',
                cancelText: '取消',
                danger: true
            });
            if (!confirmed) return;
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
                const taskId = event.currentTarget.dataset.task_id;
                const confirmed = await showConfirmModal({
                    icon: 'fa-trash-can',
                    iconBg: '#FEF2F2',
                    iconColor: '#DC2626',
                    title: '删除任务',
                    message: '确定要删除这个任务吗？<b>删除后无法恢复。</b>',
                    confirmText: '删除',
                    cancelText: '取消',
                    danger: true
                });
                if (!confirmed) return;

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

        if (this._getFilteredTaskList().length > 0) {
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
            const confirmed = await showConfirmModal({
                icon: 'fa-trash',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: '删除全部任务',
                message: '确定要删除所有任务吗？<b>删除后无法恢复。</b>',
                confirmText: '全部删除',
                cancelText: '取消',
                danger: true
            });
            if (!confirmed) return;
            window.globalControlAPI.clearAllTaskViewCache();
            window.globalControlAPI.openHomePage();
            this.currentTaskId = null;
            await window.taskManagerAPI.clearAllTasks();
            this.reloadTaskList();
        });

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
