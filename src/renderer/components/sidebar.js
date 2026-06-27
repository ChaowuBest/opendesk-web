/* eslint-disable no-console */
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
import { createRendererTranslator } from '../locale.ts';

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
        /** 正在等待用户确认的任务 ID 集合 */
        this._waitingTaskIds = new Set();
        /** 浏览器处于活跃状态的任务 ID 集合 */
        this._browserActiveTaskIds = new Set();
        /** 已收藏的任务 ID 集合 */
        this._favoritedTaskIds = new Set(JSON.parse(localStorage.getItem('od_favorited_tasks') || '[]'));
        this._appListUnsubscribe = null;
        this._settingUnsubscribe = null;
        this._taskListUnsubscribe = null;
        this._developerMode = false;
        this._experimentalFeature = false;
        this._t = createRendererTranslator();
    }

    connectedCallback() {
        this.render();
        window.taskManagerAPI.getTaskList().then((taskList) => {
            this.taskList = taskList;
            this.reloadTaskList();
            this.setUpEventListeners();
            this.subscribeToUnreadCounts();
        });

        document.addEventListener('task-waiting-state', (e) => {
            const { taskId, waiting } = e.detail;
            const changed = waiting
                ? !this._waitingTaskIds.has(taskId) && (this._waitingTaskIds.add(taskId), true)
                : this._waitingTaskIds.delete(taskId);
            if (changed) this._refreshWaitingTags();
        });

        document.addEventListener('browser-visibility-changed', (e) => {
            const { taskId, visible } = e.detail;
            const changed = visible
                ? !this._browserActiveTaskIds.has(taskId) && (this._browserActiveTaskIds.add(taskId), true)
                : this._browserActiveTaskIds.delete(taskId);
            if (changed) this._refreshBrowserIcons();
        });

        // 当打开其他应用时，清除任务高亮
        document.addEventListener('application-opened', () => {
            this.currentTaskId = null;
            this._updateTaskHighlight();
        });

        if (window.applicationRegistryAPI?.onApplicationListChanged) {
            this._appListUnsubscribe = window.applicationRegistryAPI.onApplicationListChanged(() => {
                this.reloadApplicationList();
            });
        }
        if (window.settingAPI?.loadSettingObject) {
            window.settingAPI
                .loadSettingObject()
                .then((setting) => {
                    this._developerMode = !!setting?.debug?.developer_mode;
                    this._experimentalFeature = !!setting?.debug?.experimental_feature;
                    this._t = createRendererTranslator(setting);
                    this._updateLocalizedChrome();
                    this.reloadTaskList();
                    this.reloadApplicationList();
                })
                .catch((err) => {
                    console.warn('Failed to load developer mode setting:', err);
                });
        }
        if (window.settingAPI?.onSettingChanged) {
            this._settingUnsubscribe = window.settingAPI.onSettingChanged((setting) => {
                this._developerMode = !!setting?.debug?.developer_mode;
                this._experimentalFeature = !!setting?.debug?.experimental_feature;
                this._t = createRendererTranslator(setting);
                this._updateLocalizedChrome();
                this.reloadTaskList();
                this.reloadApplicationList();
            });
        }

        // 监听深色模式切换，更新 banner 图片
        this._themeObserver = new MutationObserver(() => {
            this._updateBannerForTheme();
        });
        this._themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
    }

    disconnectedCallback() {
        if (this.unreadCountsUnsubscribe) {
            this.unreadCountsUnsubscribe();
        }
        if (this._appListUnsubscribe) {
            this._appListUnsubscribe();
            this._appListUnsubscribe = null;
        }
        if (this._settingUnsubscribe) {
            this._settingUnsubscribe();
            this._settingUnsubscribe = null;
        }
        if (this._taskListUnsubscribe) {
            this._taskListUnsubscribe();
            this._taskListUnsubscribe = null;
        }
        if (this._themeObserver) {
            this._themeObserver.disconnect();
            this._themeObserver = null;
        }
        if (this._appPopoverDismissHandler) {
            document.removeEventListener('click', this._appPopoverDismissHandler, true);
            this._appPopoverDismissHandler = null;
        }
        if (this._appPopoverBlurHandler) {
            window.removeEventListener('blur', this._appPopoverBlurHandler);
            this._appPopoverBlurHandler = null;
        }
    }

    /**
     * 根据当前主题更新左上角 icon 和 banner
     */
    _updateBannerForTheme() {
        const isDark = document.documentElement.dataset.theme === 'dark';
        const iconEl = this.querySelector('#sidebar-icon');
        if (iconEl) {
            iconEl.src = isDark ? './images/icon_round_dark.png' : './images/icon_round.png';
        }
    }

    setUpEventListeners() {
        let pendingRafId;
        window.taskManagerAPI
            .subscribeTaskListUpdate((taskList) => {
                this.taskList = taskList;
                // 窗口隐藏时跳过渲染以省电，等窗口恢复时由 visibility 事件触发刷新
                if (!window.__isWindowVisible) {
                    this._needsTaskListRefresh = true;
                    return;
                }
                if (pendingRafId === undefined) {
                    pendingRafId = requestAnimationFrame(() => {
                        pendingRafId = undefined;
                        this.reloadTaskList();
                    });
                }
                document.dispatchEvent(new CustomEvent('task-list-updated', { detail: taskList }));
            })
            .then((unsubscribe) => {
                this._taskListUnsubscribe = unsubscribe;
            })
            .catch((err) => {
                console.error('subscribing task list update failed', err);
            });

        // 窗口恢复可见时，如有待刷新的任务列表则刷新
        window.addEventListener('openDesk:visibilityChanged', (e) => {
            if (e.detail && this._needsTaskListRefresh) {
                this._needsTaskListRefresh = false;
                this.reloadTaskList();
            }
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
            const path = e.composedPath();
            if (!path.includes(popover) && !path.includes(appsBtn)) {
                this._dismissAppPopover();
            }
        };
        document.addEventListener('click', this._appPopoverDismissHandler, true);
        // iframe 内部点击不会冒泡到父窗口，需通过 window blur 兜底关闭
        this._appPopoverBlurHandler = () => {
            const popoverEl = this.querySelector('#app-popover');
            if (popoverEl && !popoverEl.classList.contains('sb-app-popover-hidden')) {
                this._dismissAppPopover();
            }
        };
        window.addEventListener('blur', this._appPopoverBlurHandler);
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
                <img id="sidebar-icon" src="./images/icon_round.png" alt="OpenDesk Icon" class="w-12 h-12 mr-3"/>
                <div class="flex flex-col items-start">
                    <span id="sidebar-banner" class="font-bold text-lg" style="color: var(--od-text);">OpenDesk</span>
                    <p class="text-xs mt-0.5 text-gray-500">一站式智慧办公空间</p>
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
                    <span data-sidebar-label="new-task">${this._t('renderer.sidebar.newTask')}</span>
                </button>
                <button
                    id="open-apps-btn"
                    class="sb-nav-btn"
                >
                    <i class="fa-solid fa-th-large" style="font-size: 12px;"></i>
                    <span data-sidebar-label="apps">${this._t('renderer.sidebar.apps')}</span>
                </button>
                <button
                    id="open-skills-btn"
                    class="sb-nav-btn"
                >
                    <i class="fa-solid fa-wand-magic-sparkles" style="font-size: 12px;"></i>
                    <span data-sidebar-label="skills">${this._t('renderer.sidebar.skills')}</span>
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
        this._updateBannerForTheme();
    }

    _getBottomToolbarButtons() {
        return [
            {
                id: 'open-memory-btn',
                icon: 'fa-hard-drive',
                label: this._t('renderer.toolbar.memory'),
                action: () => {
                    window.globalControlAPI.openMemory();
                }
            },
            {
                id: 'open-file-system-btn',
                icon: 'fa-folder-open',
                label: this._t('renderer.toolbar.fileSystem'),
                action: () => {
                    window.globalControlAPI.openApplication('filemgr');
                }
            },
            {
                id: 'open-setting-editor-btn',
                icon: 'fa-cog',
                label: this._t('renderer.toolbar.settings'),
                action: () => {
                    window.globalControlAPI.openSettingEditor();
                }
            },
            {
                id: 'open-dev-tools-btn',
                icon: 'fa-terminal',
                label: this._t('renderer.toolbar.devTools'),
                action: () => {
                    window.settingAPI.openDevTools();
                }
            },
            {
                id: 'open-log-view-btn',
                icon: 'fa-file-lines',
                label: this._t('renderer.toolbar.logs'),
                action: () => {
                    window.globalControlAPI.openLogView();
                }
            }
        ];
    }

    _createBottomToolbar() {
        const toolbar = new ElasticToolbarWidget(this._getBottomToolbarButtons());

        // 覆盖默认样式以匹配侧边栏毛玻璃风格
        toolbar.classList.add('sidebar-bottom');
        const container = this.querySelector('#sidebar-bottom-toolbar');
        if (container) {
            container.appendChild(toolbar);
        }
    }

    _updateLocalizedChrome() {
        const labelMap = {
            'new-task': this._t('renderer.sidebar.newTask'),
            apps: this._t('renderer.sidebar.apps'),
            skills: this._t('renderer.sidebar.skills')
        };
        for (const [key, label] of Object.entries(labelMap)) {
            const el = this.querySelector(`[data-sidebar-label="${key}"]`);
            if (el) {
                el.textContent = label;
            }
        }
        const toolbar = this.querySelector('elastic-toolbar-widget.sidebar-bottom');
        if (toolbar?.setButtons) {
            toolbar.setButtons(this._getBottomToolbarButtons());
        }
    }

    async reloadApplicationList() {
        const popover = this.querySelector('#app-popover');
        if (!popover) return;
        popover.innerHTML = '';
        const appList = await window.applicationRegistryAPI.getApplicationList();
        const visibleApps = appList.filter((app) => {
            if (app.showIcon === false) return false;
            if (app.isExperimental && !this._experimentalFeature) return false;
            return true;
        });

        let gridHtml = '<div class="sb-app-popover-grid">';
        for (const app of visibleApps) {
            const isMailbox = app.bundleName === 'mailbox';
            const iconUrl = app.iconUrl || `./applications/${app.bundleName}/icon.png`;
            const appSource = app.source || '';
            gridHtml += `
            <div class="sb-app-popover-item" data-bundle-name="${app.bundleName}" data-app-source="${appSource}">
                <div class="sb-app-popover-icon-wrap">
                    <img src="${iconUrl}" alt="${app.name}" onerror="this.src='./applications/default_icon.png'">
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
            item.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const bundleName = event.currentTarget.dataset.bundleName;
                const appSource = event.currentTarget.dataset.appSource;
                this._showAppContextMenu(event.clientX, event.clientY, bundleName, appSource);
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
        const list = this.taskList.filter((task) => this._isTaskVisible(task));
        // 搜索时显示全部（包括收藏的），否则从主列表中过滤掉已收藏的任务
        if (this._searchQuery) {
            const query = this._searchQuery.toLowerCase();
            return list.filter((task) => {
                const name = (task.task_name || '').toLowerCase();
                return name.includes(query);
            });
        }
        return list.filter((task) => !this._favoritedTaskIds.has(task.task_id));
    }

    _isTaskVisible(task) {
        return this._developerMode || !task?.internal;
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
        const task = item.task;
        const depth = item.depth;
        const isCurrentTask = task.task_id === this.currentTaskId;
        const isSubTask = depth > 0;

        if (isSubTask) {
            return this._buildSubTaskItemHtml(task, isCurrentTask);
        }

        const taskStyle = isCurrentTask
            ? 'bg-[#C94C40] text-white font-semibold'
            : 'bg-white text-[#1f2937] hover:bg-[#f9fafb]';
        const deleteColor = isCurrentTask ? 'text-white/60 hover:text-white' : 'text-[#9ca3af] hover:text-[#6b7280]';

        const channelTag = SideBar.buildChannelTag(task, isCurrentTask);
        const internalTag = SideBar.buildInternalTag(task, isCurrentTask, this._t);
        const goalTerminalTag = SideBar.buildGoalTerminalTag(task, isCurrentTask, this._t);
        const waitingTag = SideBar.buildWaitingTag(task.task_id, this._waitingTaskIds, isCurrentTask);
        const browserIcon = this._browserActiveTaskIds.has(task.task_id)
            ? '<i class="fas fa-globe sidebar-browser-icon"></i>'
            : '';
        return `
        <div
            class="task-item cursor-pointer rounded-xl px-3 py-2.5 mb-1.5 transition-colors duration-150 ${taskStyle}"
            data-task_id="${task.task_id}"
            data-parent_id=""
            data-depth="0"
        >
            <div class="flex items-center min-w-0 gap-2">
                <p class="text-[13px] truncate leading-tight flex-1 min-w-0">${task.task_name || '未命名任务'}</p>
                ${task.task_status === 'running' ? '<task-status-tag class="flex-shrink-0"></task-status-tag>' : ''}
                ${waitingTag}
                ${goalTerminalTag}
                ${internalTag}
                ${channelTag}
                ${browserIcon}
                <button class="delete-task-btn flex-shrink-0 ${deleteColor} text-sm" data-task_id="${task.task_id}" title="删除">×</button>
            </div>
        </div>`;
    }

    _buildSubTaskItemHtml(task, isCurrentTask) {
        const nameColor = isCurrentTask ? 'text-[#C94C40] font-medium' : 'text-[#64748b]';
        const statusMeta = SideBar.getSubTaskStatusMeta(task);

        return `
        <div
            class="task-item cursor-pointer flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-[#f8fafc] transition-colors duration-100"
            data-task_id="${task.task_id}"
            data-parent_id="${task.parent_id || ''}"
            data-depth="1"
            data-subtask-status="${statusMeta.key}"
            title="${statusMeta.label}"
        >
            <span class="w-1.5 h-1.5 rounded-full shrink-0 ${statusMeta.dotClass}"></span>
            <p class="text-[11px] truncate flex-1 min-w-0 ${nameColor}">${task.task_name || '未命名子任务'}</p>
            ${SideBar.buildInternalTag(task, isCurrentTask, this._t)}
            <button class="delete-task-btn shrink-0 text-[10px] text-[#cbd5e1] hover:text-[#94a3b8] transition-colors" data-task_id="${task.task_id}" title="删除">×</button>
        </div>`;
    }

    static getSubTaskStatusMeta(task) {
        if (task.task_status === 'running') {
            return { key: 'running', label: '运行中', dotClass: 'bg-[#64748b] animate-pulse', terminal: false };
        }
        if (task.task_status === 'waiting') {
            return { key: 'waiting', label: '等待中', dotClass: 'bg-[#cbd5e1]', terminal: false };
        }
        if (task.completion_status === 'fail') {
            return { key: 'fail', label: '失败', dotClass: 'bg-[#f87171]', terminal: true };
        }
        if (task.completion_status === 'ask') {
            return { key: 'ask', label: '需补充信息', dotClass: 'bg-[#f59e0b]', terminal: true };
        }
        if (task.completion_status === 'success') {
            return { key: 'success', label: '已完成', dotClass: 'bg-[#4ade80]', terminal: true };
        }
        if (task.task_status === 'stopped') {
            return { key: 'stopped', label: '已停止', dotClass: 'bg-[#94a3b8]', terminal: true };
        }
        return { key: 'pending', label: '待执行', dotClass: 'bg-[#cbd5e1]', terminal: false };
    }

    _refreshWaitingTags() {
        const container = this.querySelector('#task-list-container');
        if (!container) return;
        container.querySelectorAll('.task-item[data-task_id]').forEach((el) => {
            const taskId = el.dataset.task_id;
            const existing = el.querySelector('.waiting-tag');
            if (this._waitingTaskIds.has(taskId)) {
                if (!existing) {
                    const tag = document.createElement('span');
                    tag.className =
                        'waiting-tag inline-flex items-center px-2 py-1 rounded text-[10px] leading-none font-medium whitespace-nowrap bg-orange-100 text-orange-600 border border-orange-200 flex-shrink-0';
                    tag.textContent = '等待确认';
                    const flexRow = el.querySelector('.flex');
                    const deleteBtn = flexRow?.querySelector('.delete-task-btn');
                    if (deleteBtn) {
                        flexRow.insertBefore(tag, deleteBtn);
                    } else if (flexRow) {
                        flexRow.appendChild(tag);
                    }
                }
            } else if (existing) {
                existing.remove();
            }
        });
    }

    _refreshBrowserIcons() {
        const container = this.querySelector('#task-list-container');
        if (!container) return;
        container.querySelectorAll('.task-item[data-task_id]').forEach((el) => {
            const taskId = el.dataset.task_id;
            const existing = el.querySelector('.sidebar-browser-icon');
            if (this._browserActiveTaskIds.has(taskId)) {
                if (!existing) {
                    const icon = document.createElement('i');
                    icon.className = 'fas fa-globe sidebar-browser-icon';
                    const flexRow = el.querySelector('.flex');
                    const deleteBtn = flexRow?.querySelector('.delete-task-btn');
                    if (deleteBtn) {
                        flexRow.insertBefore(icon, deleteBtn);
                    } else if (flexRow) {
                        flexRow.appendChild(icon);
                    }
                }
            } else if (existing) {
                existing.remove();
            }
        });
    }

    static buildWaitingTag(taskId, waitingSet, isCurrentTask) {
        if (!waitingSet.has(taskId)) return '';
        const cls = isCurrentTask
            ? 'bg-white/25 text-white border-white/30'
            : 'bg-orange-100 text-orange-600 border-orange-200';
        return `<span class="waiting-tag inline-flex items-center px-2 py-1 rounded text-[10px] leading-none font-medium whitespace-nowrap ${cls} flex-shrink-0">等待确认</span>`;
    }

    static CHANNEL_META = {
        feishu: { label: '飞书', color: '#3370FF' },
        'openclaw-weixin': { label: '微信', color: '#09B83E' },
        whatsapp: { label: 'WhatsApp', color: '#25D366' },
        zalouser: { label: 'Zalo', color: null },
        telegram: { label: 'Telegram', color: '#26A5E4' },
        discord: { label: 'Discord', color: '#5865F2' },
        slack: { label: 'Slack', color: '#4A154B' },
        signal: { label: 'Signal', color: '#3A76F0' }
    };

    static buildChannelTag(task, isCurrentTask) {
        if (!task.origin || task.origin.type !== 'channel') return '';
        const channelId = task.origin.channel || '';
        const meta = SideBar.CHANNEL_META[channelId];
        const label = meta?.label || channelId;
        const brandColor = meta?.color;

        let style = '';
        let cls = '';
        if (brandColor && !isCurrentTask) {
            style = `style="background:${brandColor};color:#fff"`;
        } else if (isCurrentTask) {
            cls = 'bg-white/25 text-white';
        } else {
            cls = 'bg-[#f0f0f0] text-[#888]';
        }
        return `<span class="channel-tag inline-flex items-center px-2 py-1 rounded text-[11px] leading-none font-medium whitespace-nowrap transition-transform duration-200 ${cls}" ${style}>${label}</span>`;
    }

    static buildInternalTag(task, isCurrentTask, t) {
        if (!task.internal) return '';
        const label = t ? t('renderer.task.internal') : '内部';
        const cls = isCurrentTask ? 'bg-white/25 text-white' : 'bg-[#eef2ff] text-[#4f46e5]';
        return `<span class="channel-tag inline-flex items-center px-2 py-1 rounded text-[11px] leading-none font-medium whitespace-nowrap transition-transform duration-200 ${cls}">${label}</span>`;
    }

    static buildGoalTerminalTag(task, isCurrentTask, t) {
        const status = task.goal?.status;
        if (status !== 'complete' && status !== 'blocked') return '';
        const labelKey = status === 'complete' ? 'goal.label.status.complete' : 'goal.label.status.blocked';
        const label = t(labelKey);
        const cls = isCurrentTask
            ? 'bg-white/25 text-white border-white/30'
            : status === 'complete'
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-red-50 text-red-700 border-red-200';
        return `<span class="goal-terminal-tag inline-flex items-center px-2 py-1 rounded text-[10px] leading-none font-medium whitespace-nowrap border ${cls} flex-shrink-0">${label}</span>`;
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

            const htmlParts = [];
            let k = 0;
            while (k < newItems.length) {
                const item = newItems[k];
                if (item.depth === 0) {
                    const parentTask = item.task;
                    const groupChildren = [];
                    let m = k + 1;
                    while (m < newItems.length && newItems[m].depth > 0) {
                        groupChildren.push(newItems[m]);
                        m++;
                    }
                    if (groupChildren.length > 0) {
                        htmlParts.push(this._buildTaskCardWithChildren(parentTask, groupChildren));
                    } else {
                        htmlParts.push(this._buildTaskItemHtml(item));
                    }
                    k = m;
                } else {
                    htmlParts.push(this._buildTaskItemHtml(item));
                    k++;
                }
            }

            const fragment = document.createDocumentFragment();
            for (const html of htmlParts) {
                const wrapper = document.createElement('div');
                wrapper.innerHTML = html;
                const el = wrapper.firstElementChild;
                el.style.opacity = '0';
                el.style.transform = 'translateY(8px)';
                el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
                fragment.appendChild(el);
            }

            const currentSentinel = this.querySelector('#task-list-sentinel');
            if (currentSentinel?.parentElement === taskListContainer) {
                taskListContainer.insertBefore(fragment, currentSentinel);
            } else {
                taskListContainer.appendChild(fragment);
            }

            requestAnimationFrame(() => {
                taskListContainer.querySelectorAll('[style*="opacity: 0"], [style*="opacity:0"]').forEach((el) => {
                    el.style.opacity = '1';
                    el.style.transform = 'translateY(0)';
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

        container.querySelectorAll('.task-item[data-depth="1"]').forEach((item) => {
            const taskId = item.dataset.task_id;
            const isCurrentTask = taskId === this.currentTaskId;
            const nameEl = item.querySelector('p');
            if (nameEl) {
                nameEl.classList.toggle('text-[#C94C40]', isCurrentTask);
                nameEl.classList.toggle('font-medium', isCurrentTask);
                nameEl.classList.toggle('text-[#64748b]', !isCurrentTask);
            }
        });

        container.querySelectorAll(':scope > .task-item[data-depth="0"]').forEach((item) => {
            const taskId = item.dataset.task_id;
            const isCurrentTask = taskId === this.currentTaskId;
            item.classList.remove(
                'bg-[#C94C40]',
                'text-white',
                'font-semibold',
                'bg-white',
                'text-[#1f2937]',
                'hover:bg-[#f9fafb]'
            );
            if (isCurrentTask) {
                item.classList.add('bg-[#C94C40]', 'text-white', 'font-semibold');
            } else {
                item.classList.add('bg-white', 'text-[#1f2937]', 'hover:bg-[#f9fafb]');
            }

            // 同步更新 channel-tag 样式
            const channelTag = item.querySelector('.channel-tag');
            if (channelTag) {
                channelTag.classList.remove('bg-white/25', 'text-white', 'bg-[#f0f0f0]', 'text-[#888]');
                if (isCurrentTask) {
                    channelTag.removeAttribute('style');
                    channelTag.classList.add('bg-white/25', 'text-white');
                } else {
                    const task = this.taskList?.find((t) => t.task_id === taskId);
                    const channelId = task?.origin?.channel || '';
                    const meta = SideBar.CHANNEL_META[channelId];
                    if (meta?.color) {
                        channelTag.setAttribute('style', `background:${meta.color};color:#fff`);
                    } else {
                        channelTag.removeAttribute('style');
                        channelTag.classList.add('bg-[#f0f0f0]', 'text-[#888]');
                    }
                }
            }
        });

        container.querySelectorAll('.task-card-group').forEach((group) => {
            const parentId = group.dataset.parentId;
            const isCurrentParent = parentId === this.currentTaskId;
            const headerEl = group.querySelector('.task-item[data-depth="0"]');
            if (headerEl) {
                headerEl.classList.toggle('bg-[#C94C40]', isCurrentParent);
                const nameEl = headerEl.querySelector('p');
                if (nameEl) {
                    nameEl.classList.toggle('text-white', isCurrentParent);
                    nameEl.classList.toggle('font-semibold', isCurrentParent);
                    nameEl.classList.toggle('text-[#1f2937]', !isCurrentParent);
                }
                const delBtn = headerEl.querySelector('.delete-task-btn');
                if (delBtn) {
                    delBtn.classList.toggle('text-white/50', isCurrentParent);
                    delBtn.classList.toggle('text-[#cbd5e1]', !isCurrentParent);
                }
            }
        });

        this._renderFavoritesCard();
    }

    _dismissContextMenu() {
        const existing = this.querySelector('#task-context-menu');
        if (existing) existing.remove();
    }

    _dismissAppContextMenu() {
        const existing = this.querySelector('#app-context-menu');
        if (existing) existing.remove();
    }

    _showTaskInfoModal(taskId) {
        const ANIM_DURATION_OUT = 180;

        const overlay = document.createElement('div');
        overlay.className = 'od-taskinfo-overlay';
        overlay.innerHTML = `
<style>
    .od-taskinfo-overlay {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,0.3); backdrop-filter: blur(6px);
        display: flex; align-items: center; justify-content: center;
        animation: od-modal-fade-in 250ms ease-out forwards;
    }
    .od-taskinfo-overlay.od-modal-leaving {
        animation: od-modal-fade-out ${ANIM_DURATION_OUT}ms ease-in forwards;
    }
    .od-taskinfo-card {
        background: #fff; border-radius: 20px;
        box-shadow: 0 24px 80px rgba(0,0,0,0.18), 0 0 1px rgba(0,0,0,0.1);
        width: 480px; max-width: 92vw; overflow: hidden;
        animation: od-modal-scale-in 250ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
    }
    .od-taskinfo-overlay.od-modal-leaving .od-taskinfo-card {
        animation: od-modal-scale-out ${ANIM_DURATION_OUT}ms ease-in forwards;
    }
    .od-taskinfo-body { padding: 28px; }
    .od-taskinfo-header {
        display: flex; align-items: center; gap: 12px; margin-bottom: 20px;
    }
    .od-taskinfo-icon {
        width: 42px; height: 42px; border-radius: 12px;
        background: #EFF6FF; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .od-taskinfo-icon i { font-size: 18px; color: #2563EB; }
    .od-taskinfo-title {
        font-size: 16px; font-weight: 700; color: #1d1d1f; line-height: 1.3;
    }
    .od-taskinfo-rows { margin-bottom: 22px; }
    .od-taskinfo-row {
        display: flex; align-items: center; padding: 10px 0;
        border-bottom: 1px solid #F0F0F0;
    }
    .od-taskinfo-row:last-child { border-bottom: none; }
    .od-taskinfo-label {
        font-size: 12px; font-weight: 600; color: #86868b;
        min-width: 90px; flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .od-taskinfo-value {
        font-size: 13px; color: #1d1d1f; font-family: 'JetBrains Mono', 'SF Mono', monospace;
        flex: 1; word-break: break-all; margin-right: 6px;
    }
    .od-taskinfo-copy-btn {
        width: 28px; height: 28px; border-radius: 6px; border: none;
        background: transparent; cursor: pointer; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        color: #86868b; transition: all 0.15s;
    }
    .od-taskinfo-copy-btn:hover { background: #F0F0F0; color: #2563EB; }
    .od-taskinfo-copy-btn:active { transform: scale(0.92); }
    .od-taskinfo-copy-btn i { font-size: 13px; }
    .od-taskinfo-loading {
        text-align: center; padding: 32px; color: #86868b; font-size: 14px;
    }
    .od-taskinfo-error {
        text-align: center; padding: 32px; color: #DC2626; font-size: 14px;
    }
    .od-taskinfo-footer {
        display: flex; justify-content: flex-end; gap: 10px;
        padding-top: 16px; border-top: 1px solid #F0F0F0;
    }
    .od-taskinfo-close-btn {
        padding: 10px 24px; border-radius: 12px; border: none;
        font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s;
        background: #1d1d1f; color: #fff;
    }
    .od-taskinfo-close-btn:hover { background: #333; }
    .od-taskinfo-close-btn:active { transform: scale(0.97); }

    @keyframes od-modal-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes od-modal-fade-out { from { opacity: 1; } to { opacity: 0; } }
    @keyframes od-modal-scale-in {
        from { opacity: 0; transform: scale(0.95) translateY(10px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
    }
    @keyframes od-modal-scale-out {
        from { opacity: 1; transform: scale(1) translateY(0); }
        to { opacity: 0; transform: scale(0.95) translateY(10px); }
    }
</style>
<div class="od-taskinfo-card">
    <div class="od-taskinfo-body">
        <div class="od-taskinfo-header">
            <div class="od-taskinfo-icon">
                <i class="fas fa-circle-info"></i>
            </div>
            <div class="od-taskinfo-title">任务信息</div>
        </div>
        <div class="od-taskinfo-rows">
            <div class="od-taskinfo-loading">
                <i class="fas fa-spinner fa-spin"></i> 加载中...
            </div>
        </div>
        <div class="od-taskinfo-footer">
            <button class="od-taskinfo-close-btn" data-action="close">关闭</button>
        </div>
    </div>
</div>`;

        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            overlay.classList.add('od-modal-leaving');
            setTimeout(() => overlay.remove(), ANIM_DURATION_OUT);
            document.removeEventListener('keydown', escHandler);
        };

        const escHandler = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
        };
        document.addEventListener('keydown', escHandler);

        overlay.addEventListener('click', (e) => {
            if (e.target.classList.contains('od-taskinfo-overlay')) {
                close();
            }
        });

        overlay.querySelector('[data-action="close"]').addEventListener('click', close);

        document.body.appendChild(overlay);

        // 加载任务信息
        const rowsContainer = overlay.querySelector('.od-taskinfo-rows');
        window.taskManagerAPI
            .getTaskInfo(taskId)
            .then((info) => {
                if (closed) return;
                const rows = [
                    { label: '任务名称', value: info.task_name || '(未命名)' },
                    { label: '任务 ID', value: info.task_id },
                    { label: '状态', value: info.task_status },
                    { label: '数据文件', value: info.task_json_path },
                    { label: '模型', value: info.model || '(默认)' }
                ];
                if (info.parent_id) {
                    rows.splice(2, 0, { label: '父任务 ID', value: info.parent_id });
                }
                rowsContainer.innerHTML = rows
                    .map((row) => {
                        const escaped = row.value
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .replace(/"/g, '&quot;');
                        return `<div class="od-taskinfo-row">
                    <span class="od-taskinfo-label">${row.label}</span>
                    <span class="od-taskinfo-value">${escaped}</span>
                    <button class="od-taskinfo-copy-btn" data-copy="${escaped}" title="复制">
                        <i class="fa-regular fa-copy"></i>
                    </button>
                </div>`;
                    })
                    .join('');

                // 绑定复制按钮事件
                rowsContainer.querySelectorAll('.od-taskinfo-copy-btn').forEach((btn) => {
                    btn.addEventListener('click', async () => {
                        const text = btn.dataset.copy;
                        try {
                            await navigator.clipboard.writeText(text);
                            const icon = btn.querySelector('i');
                            icon.className = 'fa-solid fa-check';
                            icon.style.color = '#059669';
                            setTimeout(() => {
                                icon.className = 'fa-regular fa-copy';
                                icon.style.color = '';
                            }, 1500);
                        } catch {
                            // fallback: 选中文本让用户手动复制
                            const valueEl = btn.parentElement.querySelector('.od-taskinfo-value');
                            if (valueEl) {
                                const range = document.createRange();
                                range.selectNodeContents(valueEl);
                                const sel = window.getSelection();
                                sel.removeAllRanges();
                                sel.addRange(range);
                            }
                        }
                    });
                });
            })
            .catch((err) => {
                if (closed) return;
                rowsContainer.innerHTML = `<div class="od-taskinfo-error">
                <i class="fas fa-triangle-exclamation"></i> 加载失败：${err.message || String(err)}
            </div>`;
            });
    }

    _showAppContextMenu(x, y, bundleName, appSource) {
        this._dismissAppContextMenu();

        const menu = document.createElement('div');
        menu.id = 'app-context-menu';
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

        const isUserApp = appSource === 'user';
        const items = [
            { id: 'open', icon: 'fa-solid fa-arrow-right', label: '打开' },
            { id: 'new-window', icon: 'fa-solid fa-external-link-alt', label: '在新窗口中打开' }
        ];
        if (isUserApp) {
            items.push({ id: 'edit', icon: 'fa-solid fa-pen-to-square', label: '编辑应用' });
        }

        const btnStyle = `display:flex; align-items:center; gap:8px; width:100%; padding:6px 10px; border:none; border-radius:6px; background:transparent; font-size:12px; cursor:pointer; text-align:left; transition:background 0.1s;`;
        const iconStyle = 'width:16px; text-align:center; font-size:12px; flex-shrink:0;';

        menu.innerHTML = items
            .map((item, i) => {
                const needSep = i > 0 && item.id === 'edit';
                const sep = needSep
                    ? '<div style="height:1px; margin:3px 8px; background:rgba(0,0,0,0.06);"></div>'
                    : '';
                const color = '#1f2937';
                const iconColor = '#6b7280';
                return (
                    `${sep}<button data-action="${item.id}" style="${btnStyle} color:${color};">` +
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
            btn.addEventListener('mouseenter', () => {
                btn.style.background = '#3b82f6';
                btn.style.color = 'white';
                const icon = btn.querySelector('i');
                if (icon) icon.style.color = 'white';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.background = 'transparent';
                btn.style.color = '#1f2937';
                const icon = btn.querySelector('i');
                if (icon) icon.style.color = '#6b7280';
            });
        });

        menu.querySelector('[data-action="open"]').addEventListener('click', () => {
            this._dismissAppContextMenu();
            window.globalControlAPI.openApplication(bundleName);
            this._dismissAppPopover();
        });

        menu.querySelector('[data-action="new-window"]').addEventListener('click', () => {
            this._dismissAppContextMenu();
            this._dismissAppPopover();
            window.applicationRegistryAPI.openInNewWindow(bundleName);
        });

        if (isUserApp) {
            menu.querySelector('[data-action="edit"]').addEventListener('click', () => {
                this._dismissAppContextMenu();
                this._dismissAppPopover();
                window.globalControlAPI.openApplication('appmgr');
                // 延迟通知 appmgr 打开编辑界面
                setTimeout(() => {
                    document.dispatchEvent(new CustomEvent('appmgr:editApp', { detail: { bundleName } }));
                }, 300);
            });
        }

        const dismissHandler = (e) => {
            if (!menu.contains(e.target)) {
                this._dismissAppContextMenu();
                document.removeEventListener('click', dismissHandler, true);
            }
        };
        setTimeout(() => document.addEventListener('click', dismissHandler, true), 0);
    }

    _saveFavorites() {
        localStorage.setItem('od_favorited_tasks', JSON.stringify([...this._favoritedTaskIds]));
    }

    _toggleFavorite(taskId) {
        if (this._favoritedTaskIds.has(taskId)) {
            this._favoritedTaskIds.delete(taskId);
        } else {
            this._favoritedTaskIds.add(taskId);
        }
        this._saveFavorites();
        this.reloadTaskList();
        this._renderFavoritesCard();
    }

    _renderFavoritesCard() {
        const existing = this.querySelector('#favorites-card');
        if (existing) existing.remove();

        const favTasks = this.taskList.filter((t) => this._favoritedTaskIds.has(t.task_id) && this._isTaskVisible(t));
        if (favTasks.length === 0) return;

        const card = document.createElement('div');
        card.id = 'favorites-card';
        card.className = 'flex-shrink-0 w-full pr-2 mt-4';

        const maxVisible = 5;
        const itemHeight = 38;
        const maxHeight = maxVisible * itemHeight;

        let itemsHtml = '';
        for (const task of favTasks) {
            const isCurrentTask = task.task_id === this.currentTaskId;
            const taskStyle = isCurrentTask
                ? 'bg-[#C94C40] text-white font-semibold'
                : 'bg-white text-[#1f2937] hover:bg-[#f9fafb]';
            const goalTerminalTag = SideBar.buildGoalTerminalTag(task, isCurrentTask, this._t);
            itemsHtml += `
            <div class="fav-task-item task-item cursor-pointer rounded-xl px-3 py-2.5 mb-1.5 transition-colors duration-150 ${taskStyle}" data-task_id="${task.task_id}">
                <div class="flex items-center min-w-0 gap-2">
                    <i class="fa-solid fa-star text-[10px] ${isCurrentTask ? 'text-white/70' : 'text-amber-400'} shrink-0"></i>
                    <p class="text-[13px] truncate leading-tight flex-1 min-w-0">${task.task_name || '未命名任务'}</p>
                    ${goalTerminalTag}
                    ${SideBar.buildInternalTag(task, isCurrentTask, this._t)}
                </div>
            </div>`;
        }

        card.innerHTML = `
        <div class="overflow-hidden">
            <div class="fav-list overflow-y-auto" style="max-height:${maxHeight}px;">
                ${itemsHtml}
            </div>
        </div>`;

        const toolbar = this.querySelector('#sidebar-bottom-toolbar');
        if (toolbar) {
            toolbar.parentNode.insertBefore(card, toolbar);
        }

        card.querySelectorAll('.fav-task-item').forEach((item) => {
            item.addEventListener('click', (e) => {
                const tid = item.dataset.task_id;
                window.globalControlAPI.openTask(tid);
                this.currentTaskId = tid;
                this._updateTaskHighlight();
                this._renderFavoritesCard();
            });
            item.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const tid = event.currentTarget.dataset.task_id;
                this._showContextMenu(event.clientX, event.clientY, tid);
            });
        });
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

        const isFavorited = this._favoritedTaskIds.has(taskId);
        const items = [
            {
                id: 'favorite',
                icon: isFavorited ? 'fa-solid fa-star' : 'fa-regular fa-star',
                label: isFavorited ? '取消收藏' : '收藏任务',
                favoriteHighlight: !isFavorited
            },
            { id: 'fork', icon: 'fa-solid fa-code-fork', label: '复制并创建任务' },
            { id: 'rename', icon: 'fa-solid fa-pen', label: '重命名' },
            { id: 'delete', icon: 'fa-solid fa-trash-can', label: '删除任务', danger: true },
            { id: 'delete-all', icon: 'fa-solid fa-trash', label: '删除全部任务', danger: true }
        ];
        if (this._developerMode) {
            items.splice(3, 0, {
                id: 'developer-menu',
                icon: 'fa-solid fa-code',
                label: this._t('renderer.developer.menu'),
                submenu: true
            });
        }

        const btnStyle = `display:flex; align-items:center; gap:8px; width:100%; padding:6px 10px; border:none; border-radius:6px; background:transparent; font-size:12px; cursor:pointer; text-align:left; transition:background 0.1s;`;
        const iconStyle = 'width:16px; text-align:center; font-size:12px; flex-shrink:0;';
        const submenuStyle = `display:none; position:absolute; left:calc(100% + 4px); top:0; min-width:160px; padding:4px; border-radius:10px; background:rgba(255,255,255,0.94); backdrop-filter:blur(40px) saturate(1.8); -webkit-backdrop-filter:blur(40px) saturate(1.8); border:0.5px solid rgba(0,0,0,0.08); box-shadow:0 12px 40px -8px rgba(0,0,0,0.15), 0 0 0 0.5px rgba(0,0,0,0.04);`;

        menu.innerHTML = items
            .map((item, _i) => {
                const needSep = item.id === 'delete';
                const sep = needSep
                    ? '<div style="height:1px; margin:3px 8px; background:rgba(0,0,0,0.06);"></div>'
                    : '';
                const color = item.danger ? '#dc2626' : item.favoriteHighlight ? '#d97706' : '#1f2937';
                const iconColor = item.danger ? '#dc2626' : item.favoriteHighlight ? '#d97706' : '#6b7280';
                if (item.submenu) {
                    return (
                        `${sep}<div class="ctx-submenu-wrap" style="position:relative;">` +
                        `<button data-action="${item.id}" data-submenu="1" style="${btnStyle} color:${color};">` +
                        `<i class="${item.icon}" style="${iconStyle} color:${iconColor};"></i><span style="flex:1;">${item.label}</span>` +
                        '<i class="fa-solid fa-chevron-right" style="font-size:10px; color:#9ca3af;"></i></button>' +
                        `<div class="ctx-submenu" style="${submenuStyle}">` +
                        `<button data-action="trigger-task-review" style="${btnStyle} color:#1f2937;">` +
                        `<i class="fa-solid fa-clipboard-check" style="${iconStyle} color:#6b7280;"></i><span>${this._t('renderer.developer.triggerTaskReview')}</span></button>` +
                        `<button data-action="view-task-info" style="${btnStyle} color:#1f2937;">` +
                        `<i class="fa-solid fa-circle-info" style="${iconStyle} color:#6b7280;"></i><span>${this._t('renderer.developer.viewTaskInfo')}</span></button>` +
                        '</div></div>'
                    );
                }
                return (
                    `${sep}<button data-action="${item.id}" data-danger="${item.danger ? '1' : ''}" data-fav="${item.favoriteHighlight ? '1' : ''}" style="${btnStyle} color:${color};">` +
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
            const isFav = btn.dataset.fav === '1';
            const isSubmenuTrigger = btn.dataset.submenu === '1';
            btn.addEventListener('mouseenter', () => {
                btn.style.background = isDanger ? '#fef2f2' : isFav ? '#fffbeb' : '#3b82f6';
                btn.style.color = isDanger ? '#b91c1c' : isFav ? '#b45309' : 'white';
                const icon = btn.querySelector('i');
                if (icon) icon.style.color = isDanger ? '#b91c1c' : isFav ? '#b45309' : 'white';
                if (isSubmenuTrigger) {
                    const submenu = btn.parentElement?.querySelector('.ctx-submenu');
                    if (submenu) submenu.style.display = 'block';
                }
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.background = 'transparent';
                btn.style.color = isDanger ? '#dc2626' : isFav ? '#d97706' : '#1f2937';
                const icon = btn.querySelector('i');
                if (icon) icon.style.color = isDanger ? '#dc2626' : isFav ? '#d97706' : '#6b7280';
            });
        });
        menu.querySelectorAll('.ctx-submenu-wrap').forEach((wrap) => {
            wrap.addEventListener('mouseleave', () => {
                const submenu = wrap.querySelector('.ctx-submenu');
                if (submenu) submenu.style.display = 'none';
            });
        });

        menu.querySelector('[data-action="favorite"]').addEventListener('click', () => {
            this._dismissContextMenu();
            this._toggleFavorite(taskId);
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
        menu.querySelector('[data-action="rename"]').addEventListener('click', () => {
            this._dismissContextMenu();
            this._startInlineRename(taskId);
        });
        menu.querySelector('[data-action="trigger-task-review"]')?.addEventListener('click', async () => {
            this._dismissContextMenu();
            try {
                const result = await window.taskManagerAPI.triggerTaskReview(taskId);
                if (result?.triggered) {
                    window.notificationAPI?.sendNotification(
                        'info',
                        this._t('renderer.developer.menu'),
                        this._t('renderer.developer.reviewTriggered'),
                        this._t('renderer.developer.reviewTriggeredDetail')
                    );
                } else {
                    window.notificationAPI?.sendNotification(
                        'warning',
                        this._t('renderer.developer.menu'),
                        this._t('renderer.developer.reviewNotTriggered'),
                        this._t('renderer.developer.reviewNotTriggeredDetail')
                    );
                }
            } catch (error) {
                console.error('Failed to trigger task review:', error);
                window.notificationAPI?.sendNotification(
                    'error',
                    this._t('renderer.developer.menu'),
                    this._t('renderer.developer.triggerFailed'),
                    error.message || String(error)
                );
            }
        });
        menu.querySelector('[data-action="view-task-info"]')?.addEventListener('click', () => {
            this._dismissContextMenu();
            this._showTaskInfoModal(taskId);
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

    static SUBTASK_GROUP_MAX_HEIGHT = 340;

    _buildTaskCardWithChildren(parentTask, children) {
        const total = children.length;
        const statusCounts = children.reduce(
            (acc, c) => {
                const status = SideBar.getSubTaskStatusMeta(c.task);
                acc[status.key] = (acc[status.key] || 0) + 1;
                if (status.terminal) acc.done++;
                return acc;
            },
            { done: 0, running: 0, waiting: 0, success: 0, fail: 0, ask: 0, stopped: 0, pending: 0 }
        );
        const done = statusCounts.done;
        const running = statusCounts.running;
        const failed = statusCounts.fail + statusCounts.ask;
        const success = statusCounts.success;
        const percent = total > 0 ? Math.round((done / total) * 100) : 0;
        const isCurrentTask = parentTask.task_id === this.currentTaskId;

        let childrenHtml = '';
        for (const item of children) {
            childrenHtml += this._buildSubTaskItemHtml(item.task, item.task.task_id === this.currentTaskId);
        }

        const headerBg = isCurrentTask ? 'bg-[#C94C40]' : '';
        const titleColor = isCurrentTask ? 'text-white font-semibold' : 'text-[#1f2937]';
        const deleteColor = isCurrentTask ? 'text-white/50 hover:text-white' : 'text-[#cbd5e1] hover:text-[#94a3b8]';
        const internalTag = SideBar.buildInternalTag(parentTask, isCurrentTask, this._t);
        const goalTerminalTag = SideBar.buildGoalTerminalTag(parentTask, isCurrentTask, this._t);

        let statusSummary;
        let progressColor = 'bg-[#94a3b8]';
        if (running > 0) {
            progressColor = 'bg-[#64748b]';
            statusSummary = `<span class="flex items-center gap-1 text-[#64748b]"><span class="w-1 h-1 rounded-full bg-[#64748b] animate-pulse"></span>${running} 运行中</span>`;
        } else if (failed > 0) {
            progressColor = 'bg-[#f87171]';
            const failText = statusCounts.ask > 0 ? `${failed} 异常` : `${failed} 失败`;
            statusSummary = `<span class="text-[#b91c1c] font-medium">${done}/${total} 完成 · ${failText}</span>`;
        } else if (total > 0 && success === total) {
            progressColor = 'bg-[#4ade80]';
            statusSummary = `<span class="text-[#166534] font-medium">全部完成</span>`;
        } else if (total > 0 && done === total) {
            statusSummary = `<span class="text-[#64748b] font-medium">全部结束</span>`;
        } else {
            statusSummary = `<span>${done}/${total} 完成</span>`;
        }

        const shouldOpen = running > 0 || (isCurrentTask && parentTask.task_status === 'running');

        return `
        <div class="task-card-group mb-1.5 rounded-xl bg-white overflow-hidden" data-parent-id="${parentTask.task_id}">
            <!-- Card Header (parent task title) -->
            <div class="task-item cursor-pointer flex items-center justify-between px-3 py-2.5 gap-2 rounded-t-xl ${headerBg}" data-task_id="${parentTask.task_id}" data-parent_id="" data-depth="0">
                <div class="flex items-center flex-1 min-w-0 gap-2">
                    <p class="text-[13px] truncate leading-tight flex-1 min-w-0 ${titleColor}">${parentTask.task_name || '未命名任务'}</p>
                    ${parentTask.task_status === 'running' ? '<task-status-tag class="flex-shrink-0"></task-status-tag>' : ''}
                    ${SideBar.buildWaitingTag(parentTask.task_id, this._waitingTaskIds, isCurrentTask)}
                    ${goalTerminalTag}
                    ${internalTag}
                    ${this._browserActiveTaskIds.has(parentTask.task_id) ? '<i class="fas fa-globe sidebar-browser-icon"></i>' : ''}
                </div>
                <button class="delete-task-btn shrink-0 text-sm ${deleteColor} transition-colors" data-task_id="${parentTask.task_id}" title="删除">×</button>
            </div>

            <!-- Collapsible children section -->
            <details class="subtask-details"${shouldOpen ? ' open' : ''}>
                <summary class="flex items-center justify-between px-3 py-1.5 cursor-pointer select-none border-t border-[#f1f5f9] hover:bg-[#f8fafc] transition-colors">
                    <div class="flex items-center gap-2 text-[10px] text-[#94a3b8]">
                        <svg class="subtask-chevron w-3 h-3 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
                        <span>${total} 个子任务</span>
                    </div>
                    <div class="flex items-center gap-2 text-[10px] text-[#94a3b8]">
                        ${statusSummary}
                        <div class="w-10 h-1 rounded-full bg-[#f1f5f9] overflow-hidden">
                            <div class="h-full rounded-full ${progressColor} transition-all duration-300" style="width:${percent}%"></div>
                        </div>
                    </div>
                </summary>
                <div class="subtask-group-scroll overflow-y-auto px-1.5 pb-1.5" style="max-height:${SideBar.SUBTASK_GROUP_MAX_HEIGHT}px;">
                    ${childrenHtml}
                </div>
            </details>
        </div>`;
    }

    reloadTaskList() {
        const standardClass = 'cursor-pointer rounded-xl pr-2 py-2 mb-2 transition-colors duration-200';
        const taskListContainer = this.querySelector('#task-list-container');

        // FLIP animation: record old positions of existing task items before DOM update
        const oldPositions = new Map();
        taskListContainer
            .querySelectorAll('.task-item[data-task_id], .subtask-group-card[data-task_id]')
            .forEach((el) => {
                const taskId = el.dataset.task_id;
                if (taskId) {
                    oldPositions.set(taskId, el.getBoundingClientRect());
                }
            });

        taskListContainer.innerHTML = '';

        const fullRenderList = this.buildTaskRenderList();
        this._fullRenderList = fullRenderList;
        const totalRootTasks = this._countRootTasks(fullRenderList);

        const initialSlice = this._sliceRenderList(fullRenderList, TASK_PAGE_SIZE);
        this._displayedRootCount = Math.min(TASK_PAGE_SIZE, totalRootTasks);

        const htmlParts = [];
        let i = 0;
        while (i < initialSlice.length) {
            const item = initialSlice[i];
            if (item.depth === 0) {
                const parentTask = item.task;
                const groupChildren = [];
                let j = i + 1;
                while (j < initialSlice.length && initialSlice[j].depth > 0) {
                    groupChildren.push(initialSlice[j]);
                    j++;
                }
                if (groupChildren.length > 0) {
                    htmlParts.push(this._buildTaskCardWithChildren(parentTask, groupChildren));
                } else {
                    htmlParts.push(this._buildTaskItemHtml(item));
                }
                i = j;
            } else {
                htmlParts.push(this._buildTaskItemHtml(item));
                i++;
            }
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

        // FLIP animation: animate items that changed position
        if (oldPositions.size > 0) {
            taskListContainer
                .querySelectorAll('.task-item[data-task_id], .subtask-group-card[data-task_id]')
                .forEach((el) => {
                    const taskId = el.dataset.task_id;
                    if (!taskId || !oldPositions.has(taskId)) return;
                    const oldRect = oldPositions.get(taskId);
                    const newRect = el.getBoundingClientRect();
                    const deltaY = oldRect.top - newRect.top;
                    if (Math.abs(deltaY) < 2) return;
                    el.style.transform = `translateY(${deltaY}px)`;
                    el.style.transition = 'none';
                    requestAnimationFrame(() => {
                        el.style.transition = 'transform 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
                        el.style.transform = '';
                        el.addEventListener(
                            'transitionend',
                            () => {
                                el.style.transition = '';
                            },
                            { once: true }
                        );
                    });
                });
        }

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

        taskListContainer.querySelectorAll('.subtask-group-scroll').forEach((el) => {
            el.scrollTop = el.scrollHeight;
        });

        this._renderFavoritesCard();
    }

    _startInlineRename(taskId) {
        const taskItem = this.querySelector(`.task-item[data-task_id="${taskId}"]`);
        if (!taskItem) return;

        const nameEl = taskItem.querySelector('p');
        if (!nameEl) return;

        const originalName = nameEl.textContent;

        // Replace <p> with <input>
        const input = document.createElement('input');
        input.type = 'text';
        input.value = originalName === '未命名任务' ? '' : originalName;
        input.className = nameEl.className;
        input.style.cssText =
            'font-size:13px; background:transparent; border:1px solid #C94C40; border-radius:4px; padding:1px 4px; outline:none; width:100%; min-width:0; color:inherit; font-family:inherit;';

        // If the current task is the active one, match the active styles
        if (taskId === this.currentTaskId) {
            input.style.color = 'white';
        }

        nameEl.replaceWith(input);
        input.focus();
        input.select();

        const finishRename = async (save) => {
            if (save) {
                const newName = input.value.trim();
                if (newName && newName !== originalName) {
                    try {
                        await window.taskManagerAPI.renameTask(taskId, newName);
                    } catch (err) {
                        console.error('rename failed:', err);
                    }
                }
            }
            this.reloadTaskList();
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finishRename(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finishRename(false);
            }
        });

        input.addEventListener('blur', () => {
            finishRename(true);
        });
    }
}

customElements.define('main-sidebar', SideBar);
