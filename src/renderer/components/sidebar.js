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
import { isApplicationVisibleInMenu } from '../utils/application-visibility.ts';
import {
    buildSidebarTaskGroups,
    buildSidebarSearchResults,
    getSidebarRunningTasks,
    isSidebarTaskVisible,
    normalizeWorkspace
} from '../sidebarTaskGroups.js';
import { captureSidebarScrollState, restoreSidebarScrollState } from '../sidebarScrollState.js';

const TASK_PAGE_SIZE = 30;
const TASK_VIEW_STORAGE_KEY = 'opendesk-sidebar-task-view';

class SideBar extends HTMLElement {
    static get observedAttributes() {
        return ['data-collapsed'];
    }

    constructor() {
        super();

        /**
         * The current task id
         * @type {string | null}
         */
        this.currentTaskId = null;
        this.taskList = [];
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
        this._collapsed = false;
        this._taskView = localStorage.getItem(TASK_VIEW_STORAGE_KEY) === 'workspace' ? 'workspace' : 'time';
        this._favoritesView = false;
        this._openTaskGroupId = null;
        this._groupDisplayLimits = new Map();
        this._groupScrollObservers = [];
        this._loadingTaskGroups = new Set();
        this._runningZoneClearTimer = null;
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'data-collapsed') {
            const collapsed = newValue !== null;
            if (collapsed !== this._collapsed) {
                this._collapsed = collapsed;
                this._updateBannerForTheme();
            }
        }
    }

    connectedCallback() {
        this.render();
        this.querySelector('#collapse-sidebar-btn')?.addEventListener('click', () => {
            this._dismissAppPopover();
            this.dispatchEvent(
                new CustomEvent('sidebar-collapse-request', {
                    detail: { collapsed: true },
                    bubbles: true
                })
            );
        });
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

        // 监听视图切换，更新底部导航栏激活态
        this._viewChangedHandler = (e) => {
            this._updateNavActive(e.detail?.view, e.detail?.appBundle);
        };
        window.addEventListener('od-view-changed', this._viewChangedHandler);
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
        if (this._viewChangedHandler) {
            window.removeEventListener('od-view-changed', this._viewChangedHandler);
            this._viewChangedHandler = null;
        }
        if (this._appPopoverDismissHandler) {
            document.removeEventListener('click', this._appPopoverDismissHandler, true);
            this._appPopoverDismissHandler = null;
        }
        if (this._appPopoverBlurHandler) {
            window.removeEventListener('blur', this._appPopoverBlurHandler);
            this._appPopoverBlurHandler = null;
        }
        this._disconnectGroupScrollObservers();
        if (this._runningZoneClearTimer !== null) {
            clearTimeout(this._runningZoneClearTimer);
            this._runningZoneClearTimer = null;
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
        const collapsedIconEl = this.querySelector('#sidebar-icon-collapsed');
        if (collapsedIconEl) {
            collapsedIconEl.src = isDark ? './images/icon_round_dark.png' : './images/icon_round.png';
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
            const collapsedAppsBtn = this.querySelector('#sb-collapsed-apps');
            if (
                !path.includes(popover) &&
                !path.includes(appsBtn) &&
                !(collapsedAppsBtn && path.includes(collapsedAppsBtn))
            ) {
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

        // 初始 offscreen 定位，避免 popover 在 DOM 默认位置闪现一帧
        popover.style.position = 'fixed';
        popover.style.left = '-9999px';
        popover.style.top = '-9999px';

        requestAnimationFrame(() => {
            // 在同一帧内获取按钮和 popover 的 rect，避免 CSS transition 时序差
            const btnRect = appsBtn.getBoundingClientRect();
            const popRect = popover.getBoundingClientRect();
            let left = btnRect.left;
            let top = btnRect.bottom + 4;
            if (left + popRect.width > window.innerWidth) {
                left = window.innerWidth - popRect.width - 8;
            }
            if (top + popRect.height > window.innerHeight) {
                top = btnRect.top - popRect.height - 4;
            }
            popover.style.left = `${left}px`;
            popover.style.top = `${top}px`;
        });
    }

    _showAppPopoverAt(anchorBtn) {
        const popover = this.querySelector('#app-popover');
        if (!popover || !anchorBtn) return;

        popover.classList.remove('sb-app-popover-hidden');
        popover.classList.add('sb-app-popover-visible');

        // 初始 offscreen 定位，避免 popover 在 DOM 默认位置闪现一帧
        popover.style.position = 'fixed';
        popover.style.left = '-9999px';
        popover.style.top = '-9999px';

        requestAnimationFrame(() => {
            // 在同一帧内获取按钮和 popover 的 rect，避免 CSS transition 时序差
            const btnRect = anchorBtn.getBoundingClientRect();
            const popRect = popover.getBoundingClientRect();
            let left = btnRect.right + 4;
            let top = btnRect.top;
            if (left + popRect.width > window.innerWidth) {
                left = btnRect.left - popRect.width - 4;
            }
            if (top + popRect.height > window.innerHeight) {
                top = window.innerHeight - popRect.height - 8;
            }
            popover.style.left = `${left}px`;
            popover.style.top = `${top}px`;
        });
    }

    _dismissAppPopover() {
        const popover = this.querySelector('#app-popover');
        const appsBtn = this.querySelector('#open-apps-btn');
        if (popover) {
            popover.classList.add('sb-app-popover-hidden');
            popover.classList.remove('sb-app-popover-visible');
            // 清除 inline style，避免残留影响下次定位
            popover.style.position = '';
            popover.style.left = '';
            popover.style.top = '';
        }
        if (appsBtn) {
            appsBtn.classList.remove('sb-nav-btn-active');
        }
    }

    render() {
        this.innerHTML = `
        <!-- 完整侧边栏 -->
        <div class="sb-full-wrapper h-full flex flex-col">
            <header class="sb-header flex flex-row items-center flex-shrink-0">
                <img id="sidebar-icon" src="./images/icon_round.png" alt="OpenDesk Icon" class="sb-header-logo"/>
                <div class="sb-header-title flex flex-col items-start flex-1 min-w-0">
                    <span id="sidebar-banner" class="font-bold" style="color: var(--od-text);">OpenDesk</span>
                    <p data-sidebar-subtitle class="whitespace-nowrap">${this._t('renderer.sidebar.tagline')}</p>
                </div>
                <button
                    id="collapse-sidebar-btn"
                    class="sidebar-collapse-btn flex-shrink-0"
                    type="button"
                    title="${this._t('renderer.sidebar.collapse')}"
                    aria-label="${this._t('renderer.sidebar.collapse')}"
                    aria-controls="leftPanel"
                    aria-expanded="true"
                >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6.5 3v10"/></svg>
                </button>
            </header>

            <!-- Search -->
            <div class="sb-search-v2">
                <i class="fa-solid fa-magnifying-glass sb-search-v2-icon"></i>
                <input type="text" id="task-search-input" placeholder="${this._t('renderer.sidebar.search')}" class="sb-search-v2-input" />
                <button id="task-search-clear" class="sb-search-v2-clear" style="display:none;" title="${this._t('renderer.sidebar.clearSearch')}" aria-label="${this._t('renderer.sidebar.clearSearch')}">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <div class="sb-nav-row flex flex-row gap-1.5 flex-shrink-0">
                <button
                    id="create-task-btn"
                    class="sb-nav-btn"
                    title="${this._t('renderer.sidebar.newTask')}"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5 12 3.5l8 7V20a1 1 0 0 1-1 1h-4v-6a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v6H5a1 1 0 0 1-1-1z"/></svg>
                    <span data-sidebar-label="new-task">${this._t('renderer.sidebar.newTask')}</span>
                </button>
                <button
                    id="open-apps-btn"
                    class="sb-nav-btn"
                    title="${this._t('renderer.sidebar.apps')}"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="3.5"/><rect x="14" y="3" width="7" height="7" rx="3.5"/><rect x="14" y="14" width="7" height="7" rx="3.5"/><rect x="3" y="14" width="7" height="7" rx="3.5"/></svg>
                    <span data-sidebar-label="apps">${this._t('renderer.sidebar.apps')}</span>
                </button>
                <button
                    id="open-skills-btn"
                    class="sb-nav-btn"
                    title="${this._t('renderer.sidebar.skills')}"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>
                    <span data-sidebar-label="skills">${this._t('renderer.sidebar.skills')}</span>
                </button>
            </div>

            <div id="task-list-container" class="sb-task-container">
            </div>

            <div id="sidebar-bottom-toolbar" class="flex-shrink-0 w-full flex justify-start items-center pt-0 pb-3">
            </div>
        </div>

        <!-- App popover（独立于展开/折叠容器，避免折叠时父容器 display:none 导致不可见） -->
        <div id="app-popover" class="sb-app-popover sb-app-popover-hidden"></div>

        <!-- 折叠窄条 -->
        <div class="sb-collapsed-wrapper h-full flex flex-col items-center">
            <div class="sb-collapsed-top flex flex-col items-center gap-3 flex-1 pt-4">
                <button id="sb-collapsed-logo" class="sb-collapsed-logo-btn" title="${this._t('renderer.sidebar.expand')}">
                    <img id="sidebar-icon-collapsed" src="./images/icon_round.png" alt="OpenDesk" />
                </button>
                <button id="sb-collapsed-new-task" class="sb-collapsed-btn" title="${this._t('renderer.sidebar.newTask')}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5 12 3.5l8 7V20a1 1 0 0 1-1 1h-4v-6a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v6H5a1 1 0 0 1-1-1z"/></svg>
                </button>
                <button id="sb-collapsed-apps" class="sb-collapsed-btn" title="${this._t('renderer.sidebar.apps')}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="3.5"/><rect x="14" y="3" width="7" height="7" rx="3.5"/><rect x="14" y="14" width="7" height="7" rx="3.5"/><rect x="3" y="14" width="7" height="7" rx="3.5"/></svg>
                </button>
                <button id="sb-collapsed-skills" class="sb-collapsed-btn" title="${this._t('renderer.sidebar.skills')}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>
                </button>
            </div>
            <div class="sb-collapsed-bottom flex flex-col items-center gap-3 pb-4">
                <button id="sb-collapsed-settings" class="sb-collapsed-btn" title="${this._t('renderer.toolbar.settings')}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                </button>
                <button id="sb-collapsed-personal" class="sb-collapsed-btn" title="${this._t('renderer.toolbar.personalCenter')}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </button>
            </div>
        </div>
        `;
        this._createBottomToolbar();
        this.reloadApplicationList();
        this._updateBannerForTheme();
        this._bindCollapsedButtons();
    }

    _getBottomToolbarButtons() {
        const svg = (path) =>
            `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
        return [
            {
                id: 'open-memory-btn',
                icon: '',
                iconSvg: svg(
                    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>'
                ),
                label: this._t('renderer.toolbar.memory'),
                action: () => {
                    window.globalControlAPI.openMemory();
                }
            },
            {
                id: 'open-file-system-btn',
                icon: '',
                iconSvg: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
                label: this._t('renderer.toolbar.fileSystem'),
                action: () => {
                    window.globalControlAPI.openApplication('filemgr');
                }
            },
            {
                id: 'open-setting-editor-btn',
                icon: '',
                iconSvg: svg(
                    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
                ),
                label: this._t('renderer.toolbar.settings'),
                action: () => {
                    window.globalControlAPI.openSettingEditor();
                }
            },
            {
                id: 'open-dev-tools-btn',
                icon: '',
                iconSvg: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
                label: this._t('renderer.toolbar.devTools'),
                action: () => {
                    window.settingAPI.openDevTools();
                }
            },
            {
                id: 'open-personal-center-btn',
                icon: '',
                iconSvg: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
                label: this._t('renderer.toolbar.personalCenter'),
                action: () => {
                    window.globalControlAPI.openPersonalCenter();
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

    /** 根据当前视图更新底部导航栏的激活态 */
    _updateNavActive(view, appBundle) {
        const toolbar = this.querySelector('elastic-toolbar-widget.sidebar-bottom');
        if (!toolbar?.setActiveButton) return;

        // 映射视图到导航按钮 ID
        let activeId = null;
        if (view === 'memory') activeId = 'open-memory-btn';
        else if (appBundle === 'filemgr') activeId = 'open-file-system-btn';
        else if (view === 'setting' || view === 'wizard') activeId = 'open-setting-editor-btn';
        else if (view === 'personal-center') activeId = 'open-personal-center-btn';

        toolbar.setActiveButton(activeId);
    }

    _bindCollapsedButtons() {
        this.querySelector('#sb-collapsed-logo')?.addEventListener('click', () => {
            this.dispatchEvent(
                new CustomEvent('sidebar-collapse-request', {
                    detail: { collapsed: false },
                    bubbles: true
                })
            );
        });

        this.querySelector('#sb-collapsed-new-task')?.addEventListener('click', () => {
            this.currentTaskId = null;
            window.globalControlAPI.openHomePage();
        });

        this.querySelector('#sb-collapsed-apps')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const popover = this.querySelector('#app-popover');
            const btn = this.querySelector('#sb-collapsed-apps');
            if (!popover || !btn) return;
            const isVisible = !popover.classList.contains('sb-app-popover-hidden');
            if (isVisible) {
                this._dismissAppPopover();
            } else {
                this._showAppPopoverAt(btn);
            }
        });

        this.querySelector('#sb-collapsed-skills')?.addEventListener('click', () => {
            window.globalControlAPI.openApplication('skillmgr');
        });

        this.querySelector('#sb-collapsed-settings')?.addEventListener('click', () => {
            window.globalControlAPI.openSettingEditor();
        });

        this.querySelector('#sb-collapsed-personal')?.addEventListener('click', () => {
            window.globalControlAPI.openPersonalCenter();
        });
    }

    _updateLocalizedChrome() {
        const labelMap = {
            'new-task': this._t('renderer.sidebar.newTask'),
            apps: this._t('renderer.sidebar.apps'),
            skills: this._t('renderer.sidebar.skills')
        };
        const btnIdMap = {
            'new-task': 'create-task-btn',
            apps: 'open-apps-btn',
            skills: 'open-skills-btn'
        };
        for (const [key, label] of Object.entries(labelMap)) {
            const el = this.querySelector(`[data-sidebar-label="${key}"]`);
            if (el) {
                el.textContent = label;
            }
            const btn = this.querySelector(`#${btnIdMap[key]}`);
            if (btn) {
                btn.setAttribute('title', label);
            }
        }
        const collapseButton = this.querySelector('#collapse-sidebar-btn');
        if (collapseButton) {
            const label = this._t('renderer.sidebar.collapse');
            collapseButton.setAttribute('title', label);
            collapseButton.setAttribute('aria-label', label);
        }
        const subtitle = this.querySelector('[data-sidebar-subtitle]');
        if (subtitle) {
            subtitle.textContent = this._t('renderer.sidebar.tagline');
        }
        const searchInput = this.querySelector('#task-search-input');
        if (searchInput) {
            searchInput.setAttribute('placeholder', this._t('renderer.sidebar.search'));
        }
        const searchClear = this.querySelector('#task-search-clear');
        if (searchClear) {
            const label = this._t('renderer.sidebar.clearSearch');
            searchClear.setAttribute('title', label);
            searchClear.setAttribute('aria-label', label);
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
        const visibleApps = appList.filter((app) => isApplicationVisibleInMenu(app, this._experimentalFeature));

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
        if (this._searchQuery) {
            const query = this._searchQuery.toLowerCase();
            return list.filter((task) => {
                const name = (task.task_name || '').toLowerCase();
                const workspace = (task.workspace || '').toLowerCase();
                return name.includes(query) || workspace.includes(query);
            });
        }
        return list;
    }

    _isTaskVisible(task) {
        return isSidebarTaskVisible(task);
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
        this.reloadTaskList();
    }

    _refreshBrowserIcons() {
        this.reloadTaskList();
    }

    static buildWaitingTag(taskId, waitingSet, isCurrentTask) {
        if (!waitingSet.has(taskId)) return '';
        const cls = isCurrentTask
            ? 'bg-white/25 text-white border-white/30'
            : 'bg-orange-100 text-orange-600 border-orange-200';
        return `<span class="waiting-tag inline-flex items-center px-2 py-1 rounded fs-xs leading-none font-medium whitespace-nowrap ${cls} flex-shrink-0">等待确认</span>`;
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
        return `<span class="channel-tag inline-flex items-center px-2 py-1 rounded fs-sm leading-none font-medium whitespace-nowrap transition-transform duration-200 ${cls}" ${style}>${label}</span>`;
    }

    static buildGoalTerminalTag(task, isCurrentTask, t) {
        if (task.goal?.status !== 'blocked') return '';
        const label = t('goal.label.status.blocked');
        const cls = isCurrentTask ? 'bg-white/25 text-white border-white/30' : 'bg-red-50 text-red-700 border-red-200';
        return `<span class="goal-terminal-tag inline-flex items-center px-2 py-1 rounded fs-xs leading-none font-medium whitespace-nowrap border ${cls} flex-shrink-0">${label}</span>`;
    }

    _updateTaskHighlight() {
        const container = this.querySelector('#task-list-container');
        if (!container) return;

        container.querySelectorAll('.sb-task-row, .sb-running-subtask-row').forEach((item) => {
            item.classList.toggle('is-current', item.dataset.task_id === this.currentTaskId);
        });
        container.querySelectorAll('.sb-running-card').forEach((card) => {
            const taskId = card.querySelector('.sb-running-header')?.dataset.task_id;
            card.classList.toggle('is-current', taskId === this.currentTaskId);
        });
    }

    _dismissContextMenu() {
        const existing = this.querySelector('#task-context-menu');
        if (existing) existing.remove();
        const wsMenu = this.querySelector('#workspace-context-menu');
        if (wsMenu) wsMenu.remove();
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
        font-size: var(--fs-xl); font-weight: 700; color: #1d1d1f; line-height: 1.3;
    }
    .od-taskinfo-rows { margin-bottom: 22px; }
    .od-taskinfo-row {
        display: flex; align-items: center; padding: 10px 0;
        border-bottom: 1px solid #F0F0F0;
    }
    .od-taskinfo-row:last-child { border-bottom: none; }
    .od-taskinfo-label {
        font-size: var(--fs-md); font-weight: 600; color: #86868b;
        min-width: 90px; flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .od-taskinfo-value {
        font-size: var(--fs-base); color: #1d1d1f; font-family: 'JetBrains Mono', 'SF Mono', monospace;
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
    .od-taskinfo-copy-btn i { font-size: var(--icon-lg); }
    .od-taskinfo-loading {
        text-align: center; padding: 32px; color: #86868b; font-size: var(--fs-lg);
    }
    .od-taskinfo-error {
        text-align: center; padding: 32px; color: #DC2626; font-size: var(--fs-lg);
    }
    .od-taskinfo-footer {
        display: flex; justify-content: flex-end; gap: 10px;
        padding-top: 16px; border-top: 1px solid #F0F0F0;
    }
    .od-taskinfo-close-btn {
        padding: 10px 24px; border-radius: 12px; border: none;
        font-size: var(--fs-lg); font-weight: 600; cursor: pointer; transition: all 0.15s;
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
        menu.className = 'ctx-menu';
        menu.style.minWidth = '180px';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        const isUserApp = appSource === 'user';
        const items = [
            { id: 'open', icon: 'fa-solid fa-arrow-right', label: '打开' },
            { id: 'new-window', icon: 'fa-solid fa-external-link-alt', label: '在新窗口中打开' }
        ];
        if (isUserApp) {
            items.push({ id: 'edit', icon: 'fa-solid fa-pen-to-square', label: '编辑应用' });
        }

        menu.innerHTML = items
            .map((item, i) => {
                const needSep = i > 0 && item.id === 'edit';
                const sep = needSep ? '<div class="ctx-divider"></div>' : '';
                return (
                    `${sep}<button class="ctx-item" data-action="${item.id}">` +
                    `<span class="ctx-icon-sm"><i class="${item.icon}"></i></span>` +
                    `<span class="ctx-label">${item.label}</span></button>`
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
    }

    _showContextMenu(x, y, taskId) {
        this._dismissContextMenu();

        const menu = document.createElement('div');
        menu.id = 'task-context-menu';
        menu.className = 'ctx-menu';
        menu.style.minWidth = '180px';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        const isFavorited = this._favoritedTaskIds.has(taskId);
        const items = [
            {
                id: 'favorite',
                icon: isFavorited ? 'fa-solid fa-star' : 'fa-regular fa-star',
                label: isFavorited ? this._t('renderer.sidebar.unfavorite') : this._t('renderer.sidebar.favorite'),
                favoriteHighlight: !isFavorited
            },
            { id: 'fork', icon: 'fa-solid fa-code-fork', label: this._t('renderer.sidebar.forkTask') },
            { id: 'rename', icon: 'fa-solid fa-pen', label: this._t('renderer.sidebar.rename') },
            { id: 'delete', icon: 'fa-solid fa-trash-can', label: this._t('renderer.sidebar.deleteTask'), danger: true }
        ];
        if (this._taskView === 'workspace') {
            items.push({
                id: 'delete-workspace',
                icon: 'fa-solid fa-folder-tree',
                label: this._t('renderer.sidebar.deleteWorkspaceTasks'),
                danger: true
            });
        }
        items.push({
            id: 'delete-all',
            icon: 'fa-solid fa-trash',
            label: this._t('renderer.sidebar.deleteAllTasks'),
            danger: true
        });
        if (this._developerMode) {
            items.splice(3, 0, {
                id: 'developer-menu',
                icon: 'fa-solid fa-code',
                label: this._t('renderer.developer.menu'),
                submenu: true
            });
        }

        menu.innerHTML = items
            .map((item, _i) => {
                const needSep = item.id === 'delete';
                const sep = needSep ? '<div class="ctx-divider"></div>' : '';
                const itemCls = `ctx-item${item.danger ? ' danger' : ''}${item.favoriteHighlight ? ' favorite' : ''}`;
                if (item.submenu) {
                    return (
                        `${sep}<div class="ctx-submenu-wrap">` +
                        `<button class="${itemCls}" data-action="${item.id}" data-submenu="1">` +
                        `<span class="ctx-icon-sm"><i class="${item.icon}"></i></span><span class="ctx-label">${item.label}</span>` +
                        '<span class="ctx-arrow">▶</span></button>' +
                        `<div class="ctx-submenu">` +
                        `<button class="ctx-item" data-action="trigger-task-review">` +
                        `<span class="ctx-icon-sm"><i class="fa-solid fa-clipboard-check"></i></span><span class="ctx-label">${this._t('renderer.developer.triggerTaskReview')}</span></button>` +
                        `<button class="ctx-item" data-action="view-task-info">` +
                        `<span class="ctx-icon-sm"><i class="fa-solid fa-circle-info"></i></span><span class="ctx-label">${this._t('renderer.developer.viewTaskInfo')}</span></button>` +
                        '</div></div>'
                    );
                }
                return (
                    `${sep}<button class="${itemCls}" data-action="${item.id}">` +
                    `<span class="ctx-icon-sm"><i class="${item.icon}"></i></span>` +
                    `<span class="ctx-label">${item.label}</span></button>`
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
                title: this._t('renderer.sidebar.deleteTask'),
                message: this._t('renderer.sidebar.deleteTaskConfirm'),
                confirmText: this._t('common.delete'),
                cancelText: this._t('common.cancel'),
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
                title: this._t('renderer.sidebar.deleteAllTasks'),
                message: this._t('renderer.sidebar.deleteAllTasksConfirm'),
                confirmText: this._t('renderer.sidebar.confirmDeleteAll'),
                cancelText: this._t('common.cancel'),
                danger: true
            });
            if (!confirmed) return;
            window.globalControlAPI.clearAllTaskViewCache();
            window.globalControlAPI.openHomePage();
            this.currentTaskId = null;
            await window.taskManagerAPI.clearAllTasks();
            this.reloadTaskList();
        });
        menu.querySelector('[data-action="delete-workspace"]')?.addEventListener('click', async () => {
            this._dismissContextMenu();
            const task = this.taskList.find((t) => t.task_id === taskId);
            const workspacePath = task?.workspace || '';
            await this._deleteTasksInWorkspace(workspacePath);
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

    _showWorkspaceContextMenu(x, y, workspacePath) {
        this._dismissContextMenu();

        const menu = document.createElement('div');
        menu.id = 'workspace-context-menu';
        menu.className = 'ctx-menu';
        menu.style.minWidth = '180px';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        const items = [
            { id: 'create-task', icon: 'fa-solid fa-plus', label: this._t('renderer.sidebar.createTaskHere') }
        ];
        if (workspacePath) {
            items.push({
                id: 'open-workspace',
                icon: 'fa-solid fa-folder-open',
                label: this._t('renderer.sidebar.openWorkspace')
            });
        }
        items.push({
            id: 'delete-workspace-tasks',
            icon: 'fa-solid fa-trash',
            label: this._t('renderer.sidebar.deleteWorkspaceAllTasks'),
            danger: true
        });

        menu.innerHTML = items
            .map((item, index) => {
                const needSep = index > 0 && item.id === 'delete-workspace-tasks';
                const sep = needSep ? '<div class="ctx-divider"></div>' : '';
                const itemCls = `ctx-item${item.danger ? ' danger' : ''}`;
                return (
                    `${sep}<button class="${itemCls}" data-action="${item.id}">` +
                    `<span class="ctx-icon-sm"><i class="${item.icon}"></i></span>` +
                    `<span class="ctx-label">${item.label}</span></button>`
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

        menu.querySelector('[data-action="create-task"]').addEventListener('click', async () => {
            this._dismissContextMenu();
            try {
                const taskId = await window.taskManagerAPI.createTask();
                if (workspacePath) {
                    await window.taskManagerAPI.updateTaskWorkspace(taskId, workspacePath);
                }
                window.globalControlAPI.openTask(taskId);
                this.currentTaskId = taskId;
                this.reloadTaskList();
            } catch (error) {
                console.error('Failed to create task in workspace:', error);
            }
        });

        menu.querySelector('[data-action="open-workspace"]')?.addEventListener('click', () => {
            this._dismissContextMenu();
            if (workspacePath) {
                window.fsAPI?.openPath?.(workspacePath)?.catch?.(() => {});
            }
        });

        menu.querySelector('[data-action="delete-workspace-tasks"]').addEventListener('click', async () => {
            this._dismissContextMenu();
            await this._deleteTasksInWorkspace(workspacePath);
        });

        const dismissHandler = (e) => {
            if (!menu.contains(e.target)) {
                this._dismissContextMenu();
                document.removeEventListener('click', dismissHandler, true);
            }
        };
        setTimeout(() => document.addEventListener('click', dismissHandler, true), 0);
    }

    async _deleteTasksInWorkspace(workspacePath) {
        const targetWs = normalizeWorkspace(workspacePath);
        const tasksToDelete = this.taskList.filter((task) => {
            if (task.internal) return false;
            if (task.parent_id) return false;
            if (this._favoritedTaskIds.has(task.task_id)) return false;
            return normalizeWorkspace(task.workspace) === targetWs;
        });
        if (tasksToDelete.length === 0) return;
        const confirmed = await showConfirmModal({
            icon: 'fa-trash',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: this._t('renderer.sidebar.deleteWorkspaceAllTasks'),
            message: this._t('renderer.sidebar.deleteWorkspaceTasksConfirm', { count: tasksToDelete.length }),
            confirmText: this._t('common.delete'),
            cancelText: this._t('common.cancel'),
            danger: true
        });
        if (!confirmed) return;
        let needOpenHome = false;
        for (const task of tasksToDelete) {
            window.globalControlAPI.removeTaskViewCache(task.task_id);
            if (this.currentTaskId === task.task_id) {
                needOpenHome = true;
            }
            await window.taskManagerAPI.removeTask(task.task_id);
        }
        if (needOpenHome) {
            window.globalControlAPI.openTask(null);
            this.currentTaskId = null;
        }
        this.reloadTaskList();
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
                    title: this._t('renderer.sidebar.deleteTask'),
                    message: this._t('renderer.sidebar.deleteTaskConfirm'),
                    confirmText: this._t('common.delete'),
                    cancelText: this._t('common.cancel'),
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

    static escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    _taskGroupLabel(group) {
        if (group.id.startsWith('workspace:')) {
            return group.label || this._t('renderer.sidebar.defaultWorkspace');
        }
        const labels = {
            today: 'renderer.sidebar.today',
            'this-week': 'renderer.sidebar.thisWeek',
            earlier: 'renderer.sidebar.earlier',
            'other-workspaces': 'renderer.sidebar.otherWorkspaces',
            automatic: 'renderer.sidebar.automaticTasks'
        };
        return this._t(labels[group.id]);
    }

    _formatTaskTime(task) {
        const value = task.updated_at || task.finished_at || task.created_at;
        const date = value ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '';
        const now = new Date();
        const sameDay =
            date.getFullYear() === now.getFullYear() &&
            date.getMonth() === now.getMonth() &&
            date.getDate() === now.getDate();
        if (sameDay) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    _buildSidebarTaskRow(item) {
        const task = item.task;
        const isCurrentTask = task.task_id === this.currentTaskId;
        const isRunning = task.task_status === 'running';
        const failed = task.task_status === 'failed' || ['fail', 'ask'].includes(task.completion_status);
        const taskName = SideBar.escapeHtml(task.task_name || this._t('renderer.sidebar.unnamedTask'));
        const time = SideBar.escapeHtml(this._formatTaskTime(task));
        const waitingTag = SideBar.buildWaitingTag(task.task_id, this._waitingTaskIds, isCurrentTask);
        const browserIcon = this._browserActiveTaskIds.has(task.task_id)
            ? '<i class="fas fa-globe sidebar-browser-icon"></i>'
            : '';
        const favoriteIcon = this._favoritedTaskIds.has(task.task_id)
            ? '<i class="fa-solid fa-star sb-task-favorite" aria-hidden="true"></i>'
            : '';
        const resultIcon = isRunning
            ? '<span class="sb-running-spinner" aria-hidden="true"></span>'
            : `<span class="sb-task-result${failed ? ' is-failed' : ''}" aria-hidden="true">${failed ? '×' : '✓'}</span>`;
        return `
        <div
            class="task-item sb-task-row${isCurrentTask ? ' is-current' : ''}"
            data-task_id="${SideBar.escapeHtml(task.task_id)}"
            data-parent_id=""
            data-depth="0"
        >
            ${resultIcon}
            <span class="sb-task-name">${taskName}</span>
            ${favoriteIcon}
            ${waitingTag}
            ${browserIcon}
            <span class="sb-task-time">${time}</span>
        </div>`;
    }

    _buildRunningTaskCard(item) {
        const task = item.task;
        const isCurrentTask = task.task_id === this.currentTaskId;
        const recentlyCompleted = item.recentlyCompleted === true;
        const children = item.children;
        const completed = children.filter((child) => SideBar.getSubTaskStatusMeta(child).terminal).length;
        const childRows = children.map((child) => this._buildRunningSubtaskRow(child)).join('');
        const childrenSection =
            !recentlyCompleted && children.length > 0
                ? `
                <details class="sb-running-subtasks"${children.some((child) => child.task_status === 'running') ? ' open' : ''}>
                    <summary>
                        <span class="sb-running-chevron" aria-hidden="true">▶</span>
                        <span>${this._t('renderer.sidebar.subtaskCount', { count: children.length })}</span>
                        <span class="sb-running-progress-text">${this._t('renderer.sidebar.completedCount', {
                            completed,
                            total: children.length
                        })}</span>
                        <span class="sb-mini-progress"><i style="width:${children.length ? Math.round((completed / children.length) * 100) : 0}%"></i></span>
                    </summary>
                    <div class="sb-running-subtask-list">${childRows}</div>
                </details>`
                : '';
        return `
        <div class="sb-running-card${isCurrentTask ? ' is-current' : ''}${
            recentlyCompleted ? ' is-recently-completed' : ''
        }">
            <div class="task-item sb-running-header" data-task_id="${SideBar.escapeHtml(task.task_id)}" data-depth="0">
                ${recentlyCompleted ? '<i class="sb-completed-dot" aria-hidden="true"></i>' : ''}
                <span class="sb-running-title">${SideBar.escapeHtml(
                    task.task_name || this._t('renderer.sidebar.unnamedTask')
                )}</span>
                ${SideBar.buildWaitingTag(task.task_id, this._waitingTaskIds, isCurrentTask)}
                ${this._browserActiveTaskIds.has(task.task_id) ? '<i class="fas fa-globe sidebar-browser-icon"></i>' : ''}
                ${
                    recentlyCompleted
                        ? `<span class="sb-running-completed-status">${this._t(
                              'renderer.sidebar.justCompleted'
                          )}</span>`
                        : `<span class="sb-running-spinner" aria-label="${this._t('renderer.sidebar.running')}"></span>`
                }
            </div>
            ${childrenSection}
        </div>`;
    }

    _buildRunningSubtaskRow(task) {
        const status = SideBar.getSubTaskStatusMeta(task);
        const statusLabels = {
            running: 'renderer.sidebar.running',
            waiting: 'renderer.sidebar.waiting'
        };
        const statusLabel = statusLabels[status.key] ? this._t(statusLabels[status.key]) : '';
        return `
        <div
            class="task-item sb-running-subtask-row${status.key === 'running' ? ' is-running' : ''}"
            data-task_id="${SideBar.escapeHtml(task.task_id)}"
            data-parent_id="${SideBar.escapeHtml(task.parent_id || '')}"
            data-depth="1"
            data-subtask-status="${status.key}"
            title="${SideBar.escapeHtml(status.label)}"
        >
            <i class="sb-subtask-dot is-${status.key}" aria-hidden="true"></i>
            <span class="sb-subtask-name">${SideBar.escapeHtml(
                task.task_name || this._t('renderer.sidebar.unnamedSubtask')
            )}</span>
            ${statusLabel ? `<span class="sb-subtask-status">${statusLabel}</span>` : ''}
        </div>`;
    }

    _workspaceGroupSummary(group, index) {
        const label = SideBar.escapeHtml(this._taskGroupLabel(group));
        const workspace = group.workspace || '';
        const normalizedWorkspace = workspace.replace(/\\/g, '/');
        const pathSeparatorIndex = normalizedWorkspace.lastIndexOf('/');
        const pathPrefix =
            pathSeparatorIndex >= 0 ? normalizedWorkspace.slice(0, pathSeparatorIndex + 1) : normalizedWorkspace;
        const pathTail =
            pathSeparatorIndex >= 0 ? normalizedWorkspace.slice(pathSeparatorIndex + 1) : normalizedWorkspace;
        const initial = SideBar.escapeHtml((group.label || this._t('renderer.sidebar.defaultWorkspace')).charAt(0));
        const iconPalette = [
            { background: 'rgba(201, 76, 64, 0.12)', color: '#c94c40' },
            { background: '#eef2ff', color: '#4f46e5' },
            { background: '#fef3e2', color: '#b45309' },
            { background: '#e7f7f2', color: '#047857' }
        ];
        const iconColor = iconPalette[index % iconPalette.length];
        return `
            <span class="sb-workspace-icon" style="background:${iconColor.background};color:${iconColor.color}">${initial}</span>
            <span class="sb-workspace-info">
                <span class="sb-workspace-name">${label}</span>
                <span class="sb-workspace-path" title="${SideBar.escapeHtml(
                    workspace || this._t('renderer.sidebar.defaultWorkspace')
                )}">
                    ${
                        workspace
                            ? `<span class="sb-workspace-path-prefix">${SideBar.escapeHtml(
                                  pathPrefix
                              )}</span><span class="sb-workspace-path-tail">${SideBar.escapeHtml(pathTail)}</span>`
                            : SideBar.escapeHtml(this._t('renderer.sidebar.defaultWorkspace'))
                    }
                </span>
            </span>
            <span class="sb-group-count">${group.items.length}</span>
            <span class="sb-group-caret" aria-hidden="true">▶</span>`;
    }

    _buildSearchResultList(items) {
        const limit = this._groupDisplayLimits.get('search-results') ?? TASK_PAGE_SIZE;
        const visibleItems = items.slice(0, limit);
        const taskRows = visibleItems.map((item) => this._buildSidebarTaskRow(item)).join('');
        const hasMore = visibleItems.length < items.length;
        return `
        <div class="sb-task-group is-search" data-group-id="search-results">
            <div class="sb-task-group-body">
                ${taskRows}
                ${
                    hasMore
                        ? `<div class="sb-load-more" data-group-id="search-results">
                               <i aria-hidden="true"></i>
                               ${this._t('renderer.sidebar.loadMore')}
                           </div>`
                        : ''
                }
            </div>
        </div>`;
    }

    _buildFavoritesList(items) {
        const limit = this._groupDisplayLimits.get('favorites') ?? TASK_PAGE_SIZE;
        const visibleItems = items.slice(0, limit);
        const taskRows = visibleItems.map((item) => this._buildSidebarTaskRow(item)).join('');
        const hasMore = visibleItems.length < items.length;
        return `
        <div class="sb-task-group is-search" data-group-id="favorites">
            <div class="sb-task-group-body">
                ${taskRows}
                ${
                    hasMore
                        ? `<div class="sb-load-more" data-group-id="favorites">
                               <i aria-hidden="true"></i>
                               ${this._t('renderer.sidebar.loadMore')}
                           </div>`
                        : ''
                }
            </div>
        </div>`;
    }

    _buildTaskGroup(group, index) {
        const limit = this._groupDisplayLimits.get(group.id) ?? TASK_PAGE_SIZE;
        const visibleItems = group.items.slice(0, limit);
        const taskRows = visibleItems.map((item) => this._buildSidebarTaskRow(item)).join('');
        const hasMore = visibleItems.length < group.items.length;
        const isWorkspace = group.id.startsWith('workspace:');
        const summary = isWorkspace
            ? this._workspaceGroupSummary(group, index)
            : `${SideBar.escapeHtml(this._taskGroupLabel(group))}
               <span class="sb-group-count">${group.items.length}</span>
               <span class="sb-group-caret" aria-hidden="true">▶</span>`;
        return `
        <details class="sb-task-group${isWorkspace ? ' is-workspace' : ''}" data-group-id="${SideBar.escapeHtml(
            group.id
        )}"${this._openTaskGroupId === group.id ? ' open' : ''}>
            <summary>${summary}</summary>
            <div class="sb-task-group-body">
                ${taskRows}
                ${
                    hasMore
                        ? `<div class="sb-load-more" data-group-id="${SideBar.escapeHtml(group.id)}">
                               <i aria-hidden="true"></i>
                               ${this._t('renderer.sidebar.loadMore')}
                           </div>`
                        : ''
                }
            </div>
        </details>`;
    }

    _disconnectGroupScrollObservers() {
        this._groupScrollObservers.forEach((observer) => observer.disconnect());
        this._groupScrollObservers = [];
    }

    _openTaskGroup(details) {
        if (!details.isConnected) return;
        details.open = true;
        details.classList.remove('is-closing');
        details.classList.add('is-opening');
        this._openTaskGroupId = details.dataset.groupId;
        setTimeout(() => details.classList.remove('is-opening'), 180);
    }

    _closeTaskGroup(details, onClosed) {
        if (!details.open) {
            onClosed?.();
            return;
        }
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            details.open = false;
            onClosed?.();
            return;
        }
        details.classList.remove('is-opening');
        details.classList.add('is-closing');
        setTimeout(() => {
            if (!details.isConnected) return;
            details.open = false;
            details.classList.remove('is-closing');
            onClosed?.();
        }, 160);
    }

    _loadMoreTaskGroup(groupId, scrollTop, groupScrollTop) {
        if (this._loadingTaskGroups.has(groupId)) return;
        this._loadingTaskGroups.add(groupId);
        this._openTaskGroupId = groupId;
        this._groupDisplayLimits.set(
            groupId,
            (this._groupDisplayLimits.get(groupId) ?? TASK_PAGE_SIZE) + TASK_PAGE_SIZE
        );
        this.reloadTaskList();

        const restoreScrollPosition = () => {
            const group = [...this.querySelectorAll('.sb-task-group')].find((item) => item.dataset.groupId === groupId);
            const body = group?.querySelector('.sb-task-group-body');
            if (body) body.scrollTop = scrollTop;
            const groupsContainer = this.querySelector('.sb-task-groups');
            if (groupsContainer) groupsContainer.scrollTop = groupScrollTop;
            this._loadingTaskGroups.delete(groupId);
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(restoreScrollPosition);
        } else {
            setTimeout(restoreScrollPosition, 0);
        }
    }

    _bindSidebarTaskControls(container) {
        const viewMenu = container.querySelector('#sidebar-task-view-menu');
        container.querySelector('[data-favorites-toggle]')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this._favoritesView = !this._favoritesView;
            if (!this._favoritesView) {
                this._groupDisplayLimits.delete('favorites');
            }
            this._openTaskGroupId = null;
            this.reloadTaskList();
        });
        container.querySelectorAll('[data-task-view]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const nextView = event.currentTarget.dataset.taskView;
                if (nextView === this._taskView && !this._favoritesView) {
                    viewMenu?.removeAttribute('open');
                    return;
                }
                this._taskView = nextView;
                this._favoritesView = false;
                this._openTaskGroupId = null;
                this._groupDisplayLimits.clear();
                localStorage.setItem(TASK_VIEW_STORAGE_KEY, nextView);
                this.reloadTaskList();
            });
        });
        container.querySelectorAll('.sb-task-group').forEach((details) => {
            details.querySelector(':scope > summary')?.addEventListener('click', (event) => {
                event.preventDefault();
                if (details.classList.contains('is-closing')) return;
                if (details.open) {
                    this._closeTaskGroup(details, () => {
                        if (this._openTaskGroupId === details.dataset.groupId) {
                            this._openTaskGroupId = null;
                        }
                    });
                    return;
                }
                const currentlyOpen = container.querySelector('.sb-task-group[open]');
                if (currentlyOpen && currentlyOpen !== details) {
                    this._closeTaskGroup(currentlyOpen, () => this._openTaskGroup(details));
                } else {
                    this._openTaskGroup(details);
                }
            });
            // 工作空间分组右键菜单
            if (details.classList.contains('is-workspace')) {
                const ws = details.dataset.groupId?.replace(/^workspace:/, '') || '';
                details.querySelector(':scope > summary')?.addEventListener('contextmenu', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this._showWorkspaceContextMenu(event.clientX, event.clientY, ws);
                });
            }
        });
        container.querySelectorAll('.sb-load-more').forEach((sentinel) => {
            const groupId = sentinel.dataset.groupId;
            const body = sentinel.closest('.sb-task-group-body');
            if (!groupId || !body) return;
            const groupsContainer = container.querySelector('.sb-task-groups');
            const loadMore = () => this._loadMoreTaskGroup(groupId, body.scrollTop, groupsContainer?.scrollTop ?? 0);
            const Observer = window.IntersectionObserver ?? globalThis.IntersectionObserver;
            if (typeof Observer === 'function') {
                const observer = new Observer(
                    (entries) => {
                        if (entries.some((entry) => entry.isIntersecting)) loadMore();
                    },
                    { root: body, threshold: 0.1 }
                );
                observer.observe(sentinel);
                this._groupScrollObservers.push(observer);
                return;
            }
            body.addEventListener(
                'scroll',
                () => {
                    if (body.scrollHeight - body.scrollTop - body.clientHeight <= 24) loadMore();
                },
                { passive: true }
            );
        });
    }

    _updateRunningZone(zone, runningTasks) {
        const label = zone.querySelector('.sb-section-label');
        const list = zone.querySelector('.sb-running-list');
        if (!label || !list) return;

        if (this._runningZoneClearTimer !== null) {
            clearTimeout(this._runningZoneClearTimer);
            this._runningZoneClearTimer = null;
        }

        if (runningTasks.length === 0) {
            zone.dataset.hasTasks = 'false';
            zone.setAttribute('aria-hidden', 'true');
            const wasEmpty = zone.classList.contains('is-empty');
            zone.classList.add('is-empty');
            const clearContent = () => {
                if (zone.dataset.hasTasks !== 'false') return;
                label.textContent = '';
                list.innerHTML = '';
                this._runningZoneClearTimer = null;
            };
            if (wasEmpty) {
                clearContent();
            } else {
                this._runningZoneClearTimer = setTimeout(clearContent, 220);
            }
            return;
        }

        const wasEmpty = zone.classList.contains('is-empty');
        zone.dataset.hasTasks = 'true';
        zone.setAttribute('aria-hidden', 'false');
        label.textContent = `${this._t('renderer.sidebar.runningTasks')} · ${runningTasks.length}`;
        list.innerHTML = runningTasks.map((item) => this._buildRunningTaskCard(item)).join('');
        const showZone = () => {
            if (zone.dataset.hasTasks === 'true') {
                zone.classList.remove('is-empty');
            }
        };
        if (wasEmpty && typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(showZone);
        } else {
            showZone();
        }
    }

    reloadTaskList() {
        const taskListContainer = this.querySelector('#task-list-container');
        if (!taskListContainer) return;
        const scrollState = captureSidebarScrollState(taskListContainer);
        this._disconnectGroupScrollObservers();
        const filteredTasks = this._getFilteredTaskList();
        const runningTasks = getSidebarRunningTasks(filteredTasks);
        const isSearching = Boolean(this._searchQuery);

        let groups;
        let searchResults;
        let favoritesResults;
        let historyCount;

        if (isSearching) {
            searchResults = buildSidebarSearchResults(filteredTasks);
            historyCount = searchResults.length;
        } else if (this._favoritesView) {
            this._groupDisplayLimits.delete('search-results');
            const favoritedTasks = filteredTasks.filter((t) => this._favoritedTaskIds.has(t.task_id));
            favoritesResults = buildSidebarSearchResults(favoritedTasks);
            historyCount = favoritesResults.length;
        } else {
            this._groupDisplayLimits.delete('search-results');
            this._groupDisplayLimits.delete('favorites');
            groups = buildSidebarTaskGroups(filteredTasks, this._taskView);
            historyCount = groups.reduce((total, group) => total + group.items.length, 0);
            const availableGroupIds = new Set(groups.map((group) => group.id));
            if (!this._openTaskGroupId || !availableGroupIds.has(this._openTaskGroupId)) {
                this._openTaskGroupId = groups.find((group) => group.items.length > 0)?.id ?? groups[0]?.id ?? null;
            }
        }

        const viewIsTime = this._taskView === 'time';
        if (!taskListContainer.querySelector('.sb-running-zone')) {
            taskListContainer.innerHTML = `
                <section class="sb-running-zone is-empty" data-has-tasks="false" aria-hidden="true">
                    <div class="sb-section-label"></div>
                    <div class="sb-running-list"></div>
                </section>
                <header class="sb-task-list-header"></header>
                <div class="sb-task-groups"></div>`;
        }

        const runningZone = taskListContainer.querySelector('.sb-running-zone');
        const listHeader = taskListContainer.querySelector('.sb-task-list-header');
        const groupsContainer = taskListContainer.querySelector('.sb-task-groups');
        this._updateRunningZone(runningZone, runningTasks);

        if (isSearching) {
            listHeader.innerHTML = `<span>${this._t('renderer.sidebar.searchResults')} · ${historyCount}</span>`;
            groupsContainer.className = 'sb-task-groups is-search-view';
            groupsContainer.innerHTML = this._buildSearchResultList(searchResults);
        } else if (this._favoritesView) {
            listHeader.innerHTML = `
                <span>${this._t('renderer.sidebar.favorites')} · ${historyCount}</span>
                <button class="sb-fav-toggle is-active" data-favorites-toggle aria-label="收藏夹">
                    <i class="fa-solid fa-star" aria-hidden="true"></i>
                </button>
                <details id="sidebar-task-view-menu" class="sb-view-menu">
                    <summary>
                        ${this._t(
                            viewIsTime ? 'renderer.sidebar.viewByTimeShort' : 'renderer.sidebar.viewByWorkspaceShort'
                        )}
                        <span class="sb-view-menu-caret" aria-hidden="true">▾</span>
                    </summary>
                    <div class="sb-view-menu-popover">
                        <button class="${viewIsTime ? 'is-current' : ''}" data-task-view="time">
                            ${this._t('renderer.sidebar.viewByTime')}
                            ${viewIsTime ? '<i class="fa-solid fa-check"></i>' : ''}
                        </button>
                        <button class="${viewIsTime ? '' : 'is-current'}" data-task-view="workspace">
                            ${this._t('renderer.sidebar.viewByWorkspace')}
                            ${viewIsTime ? '' : '<i class="fa-solid fa-check"></i>'}
                        </button>
                    </div>
                </details>`;
            groupsContainer.className = 'sb-task-groups is-search-view';
            groupsContainer.innerHTML = this._buildFavoritesList(favoritesResults);
        } else {
            listHeader.innerHTML = `
                <span>${this._t('renderer.sidebar.taskList')} · ${historyCount}</span>
                <button class="sb-fav-toggle" data-favorites-toggle aria-label="收藏夹">
                    <i class="fa-regular fa-star" aria-hidden="true"></i>
                </button>
                <details id="sidebar-task-view-menu" class="sb-view-menu">
                    <summary>
                        ${this._t(
                            viewIsTime ? 'renderer.sidebar.viewByTimeShort' : 'renderer.sidebar.viewByWorkspaceShort'
                        )}
                        <span class="sb-view-menu-caret" aria-hidden="true">▾</span>
                    </summary>
                    <div class="sb-view-menu-popover">
                        <button class="${viewIsTime ? 'is-current' : ''}" data-task-view="time">
                            ${this._t('renderer.sidebar.viewByTime')}
                            ${viewIsTime ? '<i class="fa-solid fa-check"></i>' : ''}
                        </button>
                        <button class="${viewIsTime ? '' : 'is-current'}" data-task-view="workspace">
                            ${this._t('renderer.sidebar.viewByWorkspace')}
                            ${viewIsTime ? '' : '<i class="fa-solid fa-check"></i>'}
                        </button>
                    </div>
                </details>`;
            groupsContainer.className = `sb-task-groups ${viewIsTime ? 'is-time-view' : 'is-workspace-view'}`;
            groupsContainer.innerHTML = groups.map((group, index) => this._buildTaskGroup(group, index)).join('');
        }

        this._bindTaskItemEvents(taskListContainer);
        this._bindSidebarTaskControls(taskListContainer);
        restoreSidebarScrollState(taskListContainer, scrollState);
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                if (taskListContainer.isConnected) {
                    restoreSidebarScrollState(taskListContainer, scrollState);
                }
            });
        }
    }

    _startInlineRename(taskId) {
        const taskItem = this.querySelector(`.task-item[data-task_id="${taskId}"]`);
        if (!taskItem) return;

        const nameEl = taskItem.querySelector('.sb-task-name, .sb-running-title, p');
        if (!nameEl) return;

        const originalName = nameEl.textContent;

        // Replace <p> with <input>
        const input = document.createElement('input');
        input.type = 'text';
        input.value = originalName === this._t('renderer.sidebar.unnamedTask') ? '' : originalName;
        input.className = nameEl.className;
        input.style.cssText =
            'font-size:var(--fs-base); background:transparent; border:1px solid #C94C40; border-radius:4px; padding:1px 4px; outline:none; width:100%; min-width:0; color:inherit; font-family:inherit;';

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
            if (e.key === 'Enter' && !e.isComposing) {
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
