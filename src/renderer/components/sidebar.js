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
import {
    showConfirmModal,
    bindOverlayDismiss,
    MODAL_CSS,
    renderIcon,
    CLOSE_SVG,
    detectDarkMode,
    MODAL_ANIM_DURATION_OUT
} from './confirmModal.ts';
import { showFeedbackModal } from './feedbackModal.ts';
import { createRendererTranslator } from '../locale.ts';
import { escapeHtml } from '../../common/utils/escape.js';
import { CHEVRON_DOWN_SVG, CHEVRON_RIGHT_SVG } from '../../common/ui-icons.js';
import { isApplicationVisibleInMenu } from '../utils/application-visibility.ts';
import { fixedLayerOrigin, visibleViewportRect } from '../utils/window-frame.js';
import {
    buildSidebarFavoritesResults,
    buildSidebarTaskGroups,
    countSidebarVisibleRootTasks,
    getSidebarRecentRootTasks,
    getSidebarRunningTasks,
    isSidebarTaskFailed,
    isSidebarTaskVisible,
    normalizeWorkspace
} from '../sidebarTaskGroups.js';
import { captureSidebarScrollState, restoreSidebarScrollState } from '../sidebarScrollState.js';
import { attachSidebarSwipeDelete } from '../sidebarSwipeDelete.js';
import { attachSidebarMultiSelect } from '../sidebarMultiSelectController.js';
import { ctrlToggleId, rangeByAnchor } from '../sidebarMultiSelect.js';
import { TaskListRefreshScheduler } from './taskListRefreshScheduler.js';
import { TaskSearchDialog } from './taskSearchDialog.js';

const TASK_PAGE_SIZE = 30;
const TASK_VIEW_STORAGE_KEY = 'opendesk-sidebar-task-view';
/** 默认品牌名；插件声明 appearance capability 后可通过 setAppTitle 覆盖 */
const DEFAULT_APP_TITLE = 'OpenDesk';

function generateChallengeCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}
const CHEVRON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
/** 多选形态下任务名左侧的圆形选择框选中态对勾 */
const CHECK_SVG = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
/** 任务行左滑露出的圆形删除按钮图标：细线方角造型，与关闭徽标风格一致 */
const TRASH_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter"><path d="M4 7h16"/><path d="M9.5 7V4h5v3"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v6M14 11v6"/></svg>`;
const THEME_SUN_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`;
const THEME_MOON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const THEME_CONTRAST_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18V3z" fill="currentColor" stroke="none"/></svg>`;
const FEEDBACK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.4V15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h9.6"/><circle class="sb-feedback-dot" cx="19.4" cy="5.6" r="2.9" stroke="none"/></svg>`;
const THEME_ICON_MAP = { light: THEME_SUN_SVG, dark: THEME_MOON_SVG, system: THEME_CONTRAST_SVG };
const THEME_CYCLE = ['light', 'dark', 'system'];
const THEME_LABEL_KEY = {
    light: 'renderer.sidebar.themeLight',
    dark: 'renderer.sidebar.themeDark',
    system: 'renderer.sidebar.themeSystem'
};

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
        this._experimentalFeatures = {};
        /** 安全网关总开关状态（决定 dock 图标是否显示） */
        this._agentgateEnabled = false;
        /** 安全网关运行状态：'ok' | 'warn'(AgentMoss 不可达) | 'err'(AgentGate 不可达) | null */
        this._agentgateStatus = null;
        this._agentgateStatusTimer = null;
        this._bottomToolbar = null;
        this._t = createRendererTranslator();
        this._collapsed = false;
        this._taskView = localStorage.getItem(TASK_VIEW_STORAGE_KEY) === 'workspace' ? 'workspace' : 'time';
        this._favoritesView = false;
        this._openTaskGroupId = null;
        this._groupDisplayLimits = new Map();
        this._groupScrollObservers = [];
        /** 任务列表触摸左滑删除手势控制器 */
        this._swipeDeleteController = null;
        /** 任务列表多选/框选控制器 */
        this._multiSelectController = null;
        /** 多选状态：当前处于多选形态 */
        this._multiSelect = false;
        /** 多选状态：已选中的任务 id 集合 */
        this._multiSelectIds = new Set();
        /** 多选状态：Shift 区间选的锚点任务 id */
        this._multiSelectAnchorId = null;
        this._loadingTaskGroups = new Set();
        this._runningZoneClearTimer = null;
        this._themePreference = 'system';
        this._themeUnsubscribe = null;
        /** 插件外观覆盖（{ appTitle?, appDescription?, appLogoUrl? 等 }），来自 pluginmgr 的 appearance capability */
        this._appearance = {};
        this._appearanceUnsubscribe = null;
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'data-collapsed') {
            const collapsed = newValue !== null;
            if (collapsed !== this._collapsed) {
                this._collapsed = collapsed;
                this._updateBannerForTheme();
                // 收起/展开状态切换时关闭最近任务菜单
                this._dismissRecentTasksMenu();
            }
        }
    }

    connectedCallback() {
        this.render();
        this._initTaskSwipeDelete();
        this._initMultiSelect();
        this.querySelector('#collapse-sidebar-btn')?.addEventListener('click', () => {
            this._dismissAppPopover();
            this.dispatchEvent(
                new CustomEvent('sidebar-collapse-request', {
                    detail: { collapsed: true },
                    bubbles: true
                })
            );
        });

        // 主题切换按钮：点击循环 light -> dark -> system -> light
        this.querySelector('#theme-toggle-btn')?.addEventListener('click', async () => {
            if (!window.themeAPI?.setPreference) return;
            const nextIdx = (THEME_CYCLE.indexOf(this._themePreference) + 1) % THEME_CYCLE.length;
            const next = THEME_CYCLE[nextIdx];
            try {
                const result = await window.themeAPI.setPreference(next);
                if (result.status === 'ok' && result.data) {
                    this._themePreference = result.data.preference;
                    this._updateThemeToggleIcon();
                    // 同步设置面板中的主题下拉框
                    const themeSelect = document.querySelector('#theme-preference-select');
                    if (themeSelect) themeSelect.value = next;
                }
            } catch (err) {
                console.warn('[sidebar] theme setPreference failed', err);
            }
        });

        // 初始化主题偏好，并监听变化（来自设置面板或系统切换）
        if (window.themeAPI?.getResolvedTheme) {
            window.themeAPI
                .getResolvedTheme()
                .then((result) => {
                    if (result.status === 'ok' && result.data) {
                        this._themePreference = result.data.preference;
                        this._updateThemeToggleIcon();
                    }
                })
                .catch(() => {});
        }
        if (window.themeAPI?.onThemeChanged) {
            this._themeUnsubscribe = window.themeAPI.onThemeChanged((resolved) => {
                if (resolved.preference !== this._themePreference) {
                    this._themePreference = resolved.preference;
                    this._updateThemeToggleIcon();
                }
            });
        }

        // 先建立订阅再获取列表，避免 getTaskList 返回与订阅建立之间的竞态窗口
        // 导致期间创建的任务更新被永久丢弃
        this.setUpEventListeners();
        window.taskManagerAPI.getTaskList().then((taskList) => {
            this.taskList = taskList;
            this.reloadTaskList();
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
            this._updateTaskHighlight(false);
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
                    this._experimentalFeatures = setting?.debug?.experimental_features || {};
                    this._agentgateEnabled = setting?.applications?.agentgate?.enabled === true;
                    this._t = createRendererTranslator(setting);
                    this._updateLocalizedChrome();
                    this.reloadTaskList();
                    this.reloadApplicationList();
                    this._syncAgentgateStatusPolling();
                })
                .catch((err) => {
                    console.warn('Failed to load developer mode setting:', err);
                });
        }
        if (window.settingAPI?.onSettingChanged) {
            this._settingUnsubscribe = window.settingAPI.onSettingChanged((setting) => {
                const agentgateEnabled = setting?.applications?.agentgate?.enabled === true;
                this._developerMode = !!setting?.debug?.developer_mode;
                this._experimentalFeatures = setting?.debug?.experimental_features || {};
                this._agentgateEnabled = agentgateEnabled;
                this._t = createRendererTranslator(setting);
                this._updateLocalizedChrome();
                this.reloadTaskList();
                this.reloadApplicationList();
                this._syncAgentgateStatusPolling();
            });
        }

        // 加载插件外观覆盖（自定义应用名/Logo），并订阅后续变化。
        // 先建立订阅再拉取当前值，避免拉取返回与订阅建立之间的变更被漏掉；
        // 整体 try/catch 防止 API 局部缺失时的同步异常中断后续初始化
        if (window.applicationRegistryAPI?.callMainWorld) {
            try {
                Promise.resolve(window.applicationRegistryAPI.ensureFullyLoaded?.())
                    .then(() =>
                        window.applicationRegistryAPI.subscribeEvent?.(
                            'pluginmgr',
                            'appearanceChanged',
                            (appearance) => {
                                this._applyAppearance(appearance);
                            }
                        )
                    )
                    .then((unsubscribe) => {
                        if (this.isConnected) this._appearanceUnsubscribe = unsubscribe;
                        else unsubscribe?.();
                        this._loadAppearance();
                    })
                    .catch((err) => console.warn('[sidebar] loading plugin appearance failed', err));
            } catch (err) {
                console.warn('[sidebar] subscribing plugin appearance failed', err);
            }
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
        this._swipeDeleteController?.destroy();
        this._swipeDeleteController = null;
        this._multiSelectController?.destroy();
        this._multiSelectController = null;
        this._dismissMultiSelectMenu();
        this._taskSearchDialog?.destroy();
        this._taskSearchDialog = null;
        this._dismissRecentTasksMenu();
        if (this._chatBadgeTimer) {
            clearTimeout(this._chatBadgeTimer);
            this._chatBadgeTimer = null;
        }
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
        if (this._themeUnsubscribe) {
            this._themeUnsubscribe();
            this._themeUnsubscribe = null;
        }
        if (this._appearanceUnsubscribe) {
            this._appearanceUnsubscribe();
            this._appearanceUnsubscribe = null;
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
        if (this._debugMenuDismissHandler) {
            document.removeEventListener('click', this._debugMenuDismissHandler, true);
            this._debugMenuDismissHandler = null;
        }
        this._disconnectGroupScrollObservers();
        if (this._runningZoneClearTimer !== null) {
            clearTimeout(this._runningZoneClearTimer);
            this._runningZoneClearTimer = null;
        }
        this._stopAgentgateStatusPolling();
    }

    /**
     * 当前生效的应用标题：插件外观覆盖优先，未覆盖时回退默认品牌名
     */
    _appTitle() {
        return this._appearance?.appTitle || DEFAULT_APP_TITLE;
    }

    /**
     * 当前生效的应用描述：插件外观覆盖优先，未覆盖时回退默认标语
     */
    _appDescription() {
        return this._appearance?.appDescription || this._t('renderer.sidebar.tagline');
    }

    /**
     * 拉取当前插件外观覆盖并应用。
     *
     * 标题/描述按当前界面语言在主进程解析，设置/语言切换后重新拉取即可切换译名。
     */
    _loadAppearance() {
        const api = window.applicationRegistryAPI;
        if (!api?.callMainWorld) return;
        Promise.resolve(api.callMainWorld('pluginmgr', 'getAppearance'))
            .then((appearance) => this._applyAppearance(appearance))
            .catch((err) => console.warn('[sidebar] loading plugin appearance failed', err));
    }

    /**
     * 应用插件外观覆盖（标题/描述/Logo），更新品牌区 DOM
     */
    _applyAppearance(appearance) {
        this._appearance = appearance && typeof appearance === 'object' ? appearance : {};
        const bannerEl = this.querySelector('#sidebar-banner');
        if (bannerEl) {
            bannerEl.textContent = this._appTitle();
        }
        const subtitleEl = this.querySelector('[data-sidebar-subtitle]');
        if (subtitleEl) {
            subtitleEl.textContent = this._appDescription();
        }
        this._updateBannerForTheme();
    }

    /**
     * 根据当前主题更新左上角 icon 和 banner；插件自定义 Logo 存在时不随主题切换，
     * 主题变体形式（appLogoDarkUrl/appLogoLightUrl）按主题选用，单图形式（appLogoUrl）兜底
     */
    _updateBannerForTheme() {
        const isDark = document.documentElement.dataset.theme === 'dark';
        const themedVariant = isDark ? this._appearance?.appLogoDarkUrl : this._appearance?.appLogoLightUrl;
        const logoSrc =
            themedVariant ||
            this._appearance?.appLogoUrl ||
            (isDark ? './images/icon_round_dark.png' : './images/icon_round.png');
        const iconEl = this.querySelector('#sidebar-icon');
        if (iconEl) {
            iconEl.src = logoSrc;
        }
        const collapsedIconEl = this.querySelector('#sidebar-icon-collapsed');
        if (collapsedIconEl) {
            collapsedIconEl.src = logoSrc;
        }
    }

    _updateThemeToggleIcon() {
        const btn = this.querySelector('#theme-toggle-btn');
        if (!btn) return;
        const svg = THEME_ICON_MAP[this._themePreference] || THEME_CONTRAST_SVG;
        const currentLabel = this._t(THEME_LABEL_KEY[this._themePreference] || THEME_LABEL_KEY.system);
        btn.innerHTML = `${svg}<span class="sb-hover-label">${currentLabel}</span>`;
        // tooltip 提示下一次点击将切换到的模式
        const nextIdx = (THEME_CYCLE.indexOf(this._themePreference) + 1) % THEME_CYCLE.length;
        const next = THEME_CYCLE[nextIdx];
        const labelKey =
            next === 'light'
                ? 'renderer.sidebar.themeToggleToLight'
                : next === 'dark'
                  ? 'renderer.sidebar.themeToggleToDark'
                  : 'renderer.sidebar.themeToggleToSystem';
        const label = this._t(labelKey);
        btn.setAttribute('title', label);
        btn.setAttribute('aria-label', label);
    }

    setUpEventListeners() {
        // 刷新调度（RAF 防抖 + setTimeout 兜底 + 隐藏期待刷新标记）抽到独立模块，便于单测
        this._refreshScheduler = new TaskListRefreshScheduler({
            refresh: () => this.reloadTaskList(),
            isWindowVisible: () => Boolean(window.__isWindowVisible),
            log: (level, message) => window.taskManagerAPI?.log?.(level, message)
        });
        window.taskManagerAPI
            .subscribeTaskListUpdate((taskList) => {
                this.taskList = taskList;
                // 多选态下剔除已消失的任务 id，避免菜单/确认弹窗计数虚高
                if (this._multiSelect && this._multiSelectIds.size > 0) {
                    const aliveIds = new Set(taskList.map((task) => task.task_id));
                    const pruned = new Set([...this._multiSelectIds].filter((id) => aliveIds.has(id)));
                    if (pruned.size !== this._multiSelectIds.size) {
                        this._multiSelectIds = pruned;
                        this._multiSelectController?.syncAfterRender();
                    }
                }
                this._refreshScheduler.schedule();
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
            if (e.detail && this._refreshScheduler?.consumePendingRefreshWhileHidden()) {
                this.reloadTaskList();
            }
        });
        this.querySelector('#create-task-btn').addEventListener('click', () => {
            window.globalControlAPI.openHomePage();
            this._updateTaskHighlight(null);
        });
        this.querySelector('#open-skills-btn').addEventListener('click', () => {
            window.globalControlAPI.openApplication('skillmgr');
        });

        const searchInput = this.querySelector('#task-search-input');
        const searchClear = this.querySelector('#task-search-clear');
        searchInput.readOnly = true;
        searchInput.setAttribute('aria-haspopup', 'dialog');
        searchClear.style.display = 'none';
        searchInput.addEventListener('click', () => {
            if (!this._taskSearchDialog) {
                this._taskSearchDialog = new TaskSearchDialog({
                    getTasks: () => this.taskList,
                    search: (query, limit) => window.taskManagerAPI.searchTasks(query, limit),
                    subscribe: (callback) => window.taskManagerAPI.subscribeSearchUpdates(callback),
                    translate: (key) => this._t(key),
                    open: async (hit) => {
                        await window.globalControlAPI.openTask(hit.taskId);
                        if (!hit.messageId) return;
                        const taskView = [...document.querySelectorAll('task-view')].find(
                            (view) => view.getAttribute('task_id') === hit.taskId
                        );
                        if (!taskView || !(await taskView.scrollToMessage(hit.messageId, { behavior: 'instant' }))) {
                            throw new Error('Search message is no longer available');
                        }
                    }
                });
            }
            this._taskSearchDialog.show();
        });

        const appsBtn = this.querySelector('#open-apps-btn');
        const popover = this.querySelector('#app-popover');
        appsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = !popover.classList.contains('sb-app-popover-hidden');
            if (isVisible) {
                this._dismissAppPopover();
            } else {
                this._showAppPopoverAt(appsBtn);
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

    _showAppPopoverAt(anchorBtn) {
        const popover = this.querySelector('#app-popover');
        if (!popover || !anchorBtn) return;

        popover.classList.remove('sb-app-popover-hidden');
        popover.classList.add('sb-app-popover-visible');
        anchorBtn.classList.add('sb-nav-btn-active');

        // 初始 offscreen 定位，避免 popover 在 DOM 默认位置闪现一帧
        popover.style.position = 'fixed';
        popover.style.left = '-9999px';
        popover.style.top = '-9999px';

        requestAnimationFrame(() => {
            // 以 taskview 区域（rightPanel 左边缘，即分隔线右侧）为基准，展开/收起间距一致，
            // 避免展开态被拖拽条（resizer）挤占导致菜单紧贴分割线
            const btnRect = anchorBtn.getBoundingClientRect();
            const popRect = popover.getBoundingClientRect();
            const rightPanel =
                this.closest?.('splitter-widget')?.querySelector?.('[slot="right"]') ||
                this.parentElement?.nextElementSibling;
            const panelEl = this.parentElement;
            const dividerX = rightPanel
                ? rightPanel.getBoundingClientRect().left
                : panelEl
                  ? panelEl.getBoundingClientRect().right
                  : btnRect.right;
            // 防溢出修正基于可视内容区，避免把菜单收进阴影边距（见 window-frame.ts）
            const view = visibleViewportRect();
            let left = dividerX + 8;
            if (left + popRect.width > view.right) {
                left = Math.max(view.left + 8, view.right - popRect.width - 8);
            }
            let top = btnRect.top;
            if (top + popRect.height > view.bottom) {
                top = view.bottom - popRect.height - 8;
            }
            if (top < view.top + 8) top = view.top + 8;
            // popover 挂在 #app-root 子树内，fixed 坐标原点是内容区而非视口（window-rounded
            // 下内缩一个阴影边距），视口坐标需换算后写入
            const origin = fixedLayerOrigin(popover);
            popover.style.left = `${left - origin.x}px`;
            popover.style.top = `${top - origin.y}px`;
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
        const collapsedAppsBtn = this.querySelector('#sb-collapsed-apps');
        if (collapsedAppsBtn) {
            collapsedAppsBtn.classList.remove('sb-nav-btn-active');
        }
    }

    render() {
        this.innerHTML = `
        <!-- 完整侧边栏 -->
        <div class="sb-full-wrapper h-full flex flex-col">
            <header class="sb-header flex flex-row items-center flex-shrink-0">
                <img id="sidebar-icon" src="./images/icon_round.png" alt="${escapeHtml(this._appTitle())}" class="sb-header-logo"/>
                <div class="sb-header-title flex flex-col items-start justify-center flex-1 min-w-0">
                    <span id="sidebar-banner" class="font-bold" style="color: var(--od-text);">${escapeHtml(this._appTitle())}</span>
                    <p data-sidebar-subtitle class="whitespace-nowrap">${escapeHtml(this._appDescription())}</p>
                </div>
                <div class="sb-header-actions flex flex-row flex-shrink-0">
                <button
                    id="theme-toggle-btn"
                    class="sidebar-collapse-btn"
                    type="button"
                    title="${this._t('renderer.sidebar.themeSystem')}"
                    aria-label="${this._t('renderer.sidebar.themeSystem')}"
                >
                    ${THEME_CONTRAST_SVG}
                    <span class="sb-hover-label">${this._t(THEME_LABEL_KEY[this._themePreference] || THEME_LABEL_KEY.system)}</span>
                </button>
                <button
                    id="collapse-sidebar-btn"
                    class="sidebar-collapse-btn"
                    type="button"
                    title="${this._t('renderer.sidebar.collapse')}"
                    aria-label="${this._t('renderer.sidebar.collapse')}"
                    aria-controls="leftPanel"
                    aria-expanded="true"
                >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6.5 3v10"/></svg>
                    <span class="sb-hover-label">${this._t('renderer.sidebar.collapse')}</span>
                </button>
                </div>
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
                    id="open-skills-btn"
                    class="sb-nav-btn"
                    title="${this._t('renderer.sidebar.skills')}"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>
                    <span data-sidebar-label="skills">${this._t('renderer.sidebar.skills')}</span>
                </button>
                <button
                    id="open-apps-btn"
                    class="sb-nav-btn"
                    title="${this._t('renderer.sidebar.apps')}"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="3.5"/><rect x="14" y="3" width="7" height="7" rx="3.5"/><rect x="14" y="14" width="7" height="7" rx="3.5"/><rect x="3" y="14" width="7" height="7" rx="3.5"/></svg>
                    <span data-sidebar-label="apps">${this._t('renderer.sidebar.apps')}</span>
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
                    <img id="sidebar-icon-collapsed" src="./images/icon_round.png" alt="${escapeHtml(this._appTitle())}" />
                </button>
                <button id="sb-collapsed-new-task" class="sb-collapsed-btn" title="${this._t('renderer.sidebar.newTask')}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5 12 3.5l8 7V20a1 1 0 0 1-1 1h-4v-6a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v6H5a1 1 0 0 1-1-1z"/></svg>
                </button>
                <button id="sb-collapsed-chat" class="sb-collapsed-btn" title="${this._t('renderer.sidebar.chat')}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 11h.01M12 11h.01M16 11h.01"/></svg>
                    <span class="sb-chat-badge"></span>
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
        const buttons = [
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
            }
        ];
        if (this._agentgateEnabled) {
            buttons.push({
                id: 'open-agentgate-btn',
                icon: '',
                iconSvg: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
                label: this._t('renderer.toolbar.securityGateway'),
                action: () => {
                    window.globalControlAPI.openApplication('agentgate');
                }
            });
        }
        if (this._developerMode) {
            buttons.push({
                id: 'open-debug-btn',
                icon: '',
                iconSvg: svg(
                    '<path d="M4 3v5a5 5 0 0 0 10 0V3"/><path d="M4 3H2M14 3h2"/><path d="M9 13v3a5 5 0 0 0 10 0v-2"/><circle cx="19" cy="11" r="2"/>'
                ),
                label: this._t('renderer.toolbar.debug'),
                action: (event) => {
                    this._showDebugMenu(event);
                }
            });
        }
        buttons.push({
            id: 'open-personal-center-btn',
            icon: '',
            iconSvg: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
            label: this._t('renderer.toolbar.personalCenter'),
            action: () => {
                window.globalControlAPI.openPersonalCenter();
            }
        });
        // 反馈按钮：文字常显 + 墨灰中性样式（与相邻导航图标一致），点击弹出反馈入口选择弹窗
        buttons.push({
            id: 'open-feedback-btn',
            icon: '',
            iconSvg: FEEDBACK_SVG,
            label: this._t('renderer.sidebar.feedback'),
            labelStayVisible: true,
            className: 'sb-feedback-btn',
            action: () => {
                showFeedbackModal(this._t);
            }
        });
        return buttons;
    }

    _createBottomToolbar() {
        const toolbar = new ElasticToolbarWidget(this._getBottomToolbarButtons());
        this._bottomToolbar = toolbar;

        // 覆盖默认样式以匹配侧边栏毛玻璃风格
        toolbar.classList.add('sidebar-bottom');
        const container = this.querySelector('#sidebar-bottom-toolbar');
        if (container) {
            container.appendChild(toolbar);
        }
        this._startAgentgateStatusPolling();
    }

    /**
     * 安全网关总开关开启时，轮询 Bridge 运行状态并为 dock 盾牌图标设置角标。
     * ok=正常，warn=AgentMoss 不可达，err=AgentGate 不可达。
     */
    _startAgentgateStatusPolling() {
        this._stopAgentgateStatusPolling();
        if (!this._agentgateEnabled) return;
        this._pollAgentgateStatus();
        this._agentgateStatusTimer = setInterval(() => this._pollAgentgateStatus(), 10000);
    }

    /** 根据总开关状态同步轮询启停（开关从配置页切换时调用） */
    _syncAgentgateStatusPolling() {
        if (this._agentgateEnabled) {
            this._startAgentgateStatusPolling();
        } else {
            this._stopAgentgateStatusPolling();
            this._agentgateStatus = null;
            if (this._bottomToolbar) this._bottomToolbar.setButtonBadge('open-agentgate-btn', null);
        }
    }

    async _pollAgentgateStatus() {
        try {
            const status = await window.applicationRegistryAPI?.callMainWorld('agentgate', 'getBridgeStatus');
            if (!status) {
                this._setAgentgateStatus(null);
                return;
            }
            if (status.gateRunning === false) {
                this._setAgentgateStatus('err');
            } else if (status.gateRunning === true && status.mossRunning === false) {
                this._setAgentgateStatus('warn');
            } else if (status.gateRunning === true && status.mossRunning === true && status.llmAvailable === false) {
                this._setAgentgateStatus('warn');
            } else {
                this._setAgentgateStatus('ok');
            }
        } catch {
            this._setAgentgateStatus('err');
        }
    }

    _setAgentgateStatus(status) {
        if (this._agentgateStatus === status) return;
        this._agentgateStatus = status;
        if (!this._bottomToolbar?.setButtonBadge) return;
        const titleKey = status ? `renderer.toolbar.securityGateway.${status}` : null;
        const title = titleKey ? this._t(titleKey) : null;
        this._bottomToolbar.setButtonBadge('open-agentgate-btn', this._agentgateStatus, title);
    }

    _stopAgentgateStatusPolling() {
        if (this._agentgateStatusTimer) {
            clearInterval(this._agentgateStatusTimer);
            this._agentgateStatusTimer = null;
        }
    }

    /** 根据当前视图更新底部导航栏的激活态 */
    _updateNavActive(view, appBundle) {
        const toolbar = this.querySelector('elastic-toolbar-widget.sidebar-bottom');
        if (!toolbar?.setActiveButton) return;

        // 映射视图到导航按钮 ID
        let activeId = null;
        if (view === 'application') {
            if (appBundle === 'filemgr') activeId = 'open-file-system-btn';
            else if (appBundle === 'agentgate') activeId = 'open-agentgate-btn';
        } else if (view === 'memory') activeId = 'open-memory-btn';
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
            window.globalControlAPI.openHomePage();
            this._updateTaskHighlight(false);
        });

        this.querySelector('#sb-collapsed-chat')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleRecentTasksMenu();
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

    /** 取最近更新的可见根任务（按 updated_at 降序，最多 limit 个；子任务并入父任务，不单独出现） */
    _getRecentTasks(limit) {
        return getSidebarRecentRootTasks(this.taskList, limit);
    }

    /**
     * 更新对话图标右上角角标状态：
     * - 有运行中的顶层任务：显示任务数
     * - 任务刚结束、仍在最近完成窗口内：显示 ✓（失败任务显示 ×），避免结束后失去视觉反馈
     * - 最近任务也消失后：隐藏角标
     */
    _updateChatBadge() {
        const badge = this.querySelector('#sb-collapsed-chat .sb-chat-badge');
        if (!badge) return;
        const runningZone = getSidebarRunningTasks(this.taskList);
        const runningCount = runningZone.filter((item) => !item.recentlyCompleted).length;
        const recentCompleted = runningZone.filter((item) => item.recentlyCompleted);

        if (runningCount > 0) {
            this._setChatBadge(badge, runningCount > 99 ? '99+' : String(runningCount));
        } else if (recentCompleted.length > 0) {
            this._setChatBadge(badge, recentCompleted.some((item) => isSidebarTaskFailed(item.task)) ? '×' : '✓');
        } else {
            this._hideChatBadge(badge);
        }
        this._scheduleChatBadgeRefresh(recentCompleted);
    }

    _setChatBadge(badge, text) {
        badge.classList.toggle('sb-chat-badge-check', text === '✓');
        badge.classList.toggle('sb-chat-badge-failed', text === '×');
        const wasVisible = badge.classList.contains('sb-chat-badge-show');
        const contentChanged = badge.textContent !== text;
        badge.textContent = text;
        if (!wasVisible) {
            badge.classList.add('sb-chat-badge-show');
        } else if (contentChanged) {
            // 内容变化（如数字↔对号）：强制重播从左下角展开的动画
            badge.classList.remove('sb-chat-badge-show');
            void badge.offsetWidth;
            badge.classList.add('sb-chat-badge-show');
        }
    }

    _hideChatBadge(badge) {
        badge.classList.remove('sb-chat-badge-show');
    }

    /** 最近完成窗口到期后重新计算角标（任务列表无更新时也要让 ✓ 自动消失） */
    _scheduleChatBadgeRefresh(recentCompleted) {
        if (this._chatBadgeTimer) {
            clearTimeout(this._chatBadgeTimer);
            this._chatBadgeTimer = null;
        }
        if (recentCompleted.length === 0) return;
        const WINDOW_MS = 5 * 60 * 1000;
        const now = Date.now();
        let remaining = WINDOW_MS;
        for (const item of recentCompleted) {
            const finishedAt = new Date(item.task.finished_at || 0).getTime();
            remaining = Math.min(remaining, WINDOW_MS - (now - finishedAt));
        }
        this._chatBadgeTimer = setTimeout(
            () => {
                this._chatBadgeTimer = null;
                // 窗口隐藏时遵循省电设计：只标记待刷新，由窗口恢复可见事件触发更新
                if (!window.__isWindowVisible) {
                    this._refreshScheduler?.markPendingRefreshWhileHidden();
                    return;
                }
                this._updateChatBadge();
            },
            Math.max(0, remaining)
        );
    }

    _toggleRecentTasksMenu() {
        const chatBtn = this.querySelector('#sb-collapsed-chat');
        if (!chatBtn) return;
        if (this.querySelector('#recent-tasks-menu')) {
            this._dismissRecentTasksMenu();
        } else {
            this._showRecentTasksMenu(chatBtn);
        }
    }

    _showRecentTasksMenu(anchorBtn) {
        this._dismissRecentTasksMenu();

        const menu = document.createElement('div');
        menu.id = 'recent-tasks-menu';
        menu.className = 'ctx-menu';
        menu.style.minWidth = '220px';

        const recentTasks = this._getRecentTasks(10);
        // 与菜单列表口径一致：仅根任务（子任务不单独出现）、排除自动化（internal）任务
        const totalCount = countSidebarVisibleRootTasks(this.taskList);

        if (recentTasks.length === 0) {
            menu.innerHTML = `<div class="ctx-empty">${this._t('renderer.sidebar.noTasks')}</div>`;
        } else {
            const rows = recentTasks
                .map((task) => {
                    const isRunning = task.task_status === 'running';
                    const failed = task.task_status === 'failed' || ['fail', 'ask'].includes(task.completion_status);
                    // 状态图标与完整侧边栏任务列表中的单个任务保持一致
                    const resultIcon = isRunning
                        ? '<span class="sb-running-spinner" aria-hidden="true"></span>'
                        : `<span class="sb-task-result${failed ? ' is-failed' : ''}" aria-hidden="true">${
                              failed ? '×' : '✓'
                          }</span>`;
                    const name = escapeHtml(task.task_name || this._t('renderer.sidebar.unnamedTask'));
                    return `<button class="ctx-item" data-task-id="${escapeHtml(task.task_id)}">
                        <span class="ctx-icon-sm">${resultIcon}</span>
                        <span class="ctx-label">${name}</span>
                    </button>`;
                })
                .join('');

            const viewMore =
                totalCount > 10
                    ? `<div class="ctx-divider"></div>
                       <button class="ctx-item" data-action="view-more">
                           <span class="ctx-icon-sm"><i class="fa-solid fa-angles-right"></i></span>
                           <span class="ctx-label">${this._t('renderer.sidebar.viewMoreTasks')}</span>
                       </button>`
                    : '';

            // 任务列表放入可滚动区域：窗口变矮时菜单内容在区域内滚动，不超出视口
            menu.innerHTML = `<div class="ctx-menu-list">${rows}</div>${viewMore}`;
        }

        this.appendChild(menu);

        // 定位：菜单左边越过分割线（侧边栏面板右边缘）一小段距离，使菜单主体不落在侧边栏区域内
        requestAnimationFrame(() => {
            const btnRect = anchorBtn.getBoundingClientRect();
            const panelEl = this.parentElement;
            const dividerX = panelEl ? panelEl.getBoundingClientRect().right : btnRect.right;
            // 防溢出修正基于可视内容区，坐标换算见 window-frame.ts（菜单挂在 #app-root 子树内）
            const view = visibleViewportRect();
            const origin = fixedLayerOrigin(menu);
            let left = dividerX + 8;
            if (left + menu.offsetWidth > view.right) {
                left = Math.max(view.left + 8, view.right - menu.offsetWidth - 8);
            }
            // 限制菜单最大高度：任务列表需要时出现滚动条，保证下边缘不超出窗口
            menu.style.maxHeight = `${Math.max(120, view.bottom - view.top - 16)}px`;
            let top = btnRect.top;
            if (top + menu.offsetHeight > view.bottom - 8) {
                top = view.bottom - menu.offsetHeight - 8;
            }
            if (top < view.top + 8) top = view.top + 8;
            menu.style.left = `${left - origin.x}px`;
            menu.style.top = `${top - origin.y}px`;
        });

        // 点击任务：直接切换到指定任务，不展开侧边栏
        menu.querySelectorAll('[data-task-id]').forEach((item) => {
            item.addEventListener('click', () => {
                const taskId = item.dataset.taskId;
                window.globalControlAPI.openTask(taskId);
                this._updateTaskHighlight(taskId);
                this._dismissRecentTasksMenu();
            });
        });

        // 查看更多任务：展开侧边栏
        menu.querySelector('[data-action="view-more"]')?.addEventListener('click', () => {
            this._dismissRecentTasksMenu();
            this.dispatchEvent(
                new CustomEvent('sidebar-collapse-request', { detail: { collapsed: false }, bubbles: true })
            );
        });

        // 点击菜单外部关闭（排除按钮自身，按钮负责开关）
        this._recentTasksMenuDismissHandler = (e) => {
            const path = e.composedPath();
            const chatBtn = this.querySelector('#sb-collapsed-chat');
            if (!path.includes(menu) && !(chatBtn && path.includes(chatBtn))) {
                this._dismissRecentTasksMenu();
            }
        };
        setTimeout(() => {
            if (this._recentTasksMenuDismissHandler) {
                document.addEventListener('click', this._recentTasksMenuDismissHandler, true);
            }
        }, 0);

        // Escape 关闭
        this._recentTasksMenuEscHandler = (e) => {
            if (e.key === 'Escape') this._dismissRecentTasksMenu();
        };
        document.addEventListener('keydown', this._recentTasksMenuEscHandler);
    }

    _dismissRecentTasksMenu() {
        const menu = this.querySelector('#recent-tasks-menu');
        if (menu) menu.remove();
        if (this._recentTasksMenuDismissHandler) {
            document.removeEventListener('click', this._recentTasksMenuDismissHandler, true);
            this._recentTasksMenuDismissHandler = null;
        }
        if (this._recentTasksMenuEscHandler) {
            document.removeEventListener('keydown', this._recentTasksMenuEscHandler);
            this._recentTasksMenuEscHandler = null;
        }
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
        this._updateThemeToggleIcon();
        const subtitle = this.querySelector('[data-sidebar-subtitle]');
        if (subtitle) {
            subtitle.textContent = this._appDescription();
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
        const toolbar = this._bottomToolbar ?? this.querySelector('elastic-toolbar-widget.sidebar-bottom');
        if (toolbar?.setButtons) {
            toolbar.setButtons(this._getBottomToolbarButtons());
            // setButtons 会整体重渲染，重渲染后需重新挂载安全网关角标及其状态说明
            if (this._agentgateStatus) {
                const titleKey = `renderer.toolbar.securityGateway.${this._agentgateStatus}`;
                toolbar.setButtonBadge('open-agentgate-btn', this._agentgateStatus, this._t(titleKey));
            }
        }
        // 界面语言可能已切换：本地化的插件应用名需按新语言重新解析
        this._loadAppearance();
    }

    async reloadApplicationList() {
        const popover = this.querySelector('#app-popover');
        if (!popover) return;
        popover.innerHTML = '';
        const appList = await window.applicationRegistryAPI.getApplicationList();
        // 技能中心已由侧边栏「技能」按钮直达，无需在应用菜单中重复展示
        const visibleApps = appList.filter(
            (app) => app.bundleName !== 'skillmgr' && isApplicationVisibleInMenu(app, this._experimentalFeatures)
        );

        let gridHtml = '<div class="sb-app-popover-grid">';
        for (const app of visibleApps) {
            const isMailbox = app.bundleName === 'mailbox';
            const iconUrl = app.iconUrl || `./applications/${app.bundleName}/icon.svg`;
            const appSource = app.source || '';
            gridHtml += `
            <div class="sb-app-popover-item" data-bundle-name="${app.bundleName}" data-app-source="${appSource}">
                <div class="sb-app-popover-icon-wrap">
                    <img src="${iconUrl}" alt="${app.name}" class="${/\.svg$/i.test(iconUrl) ? 'sb-app-icon-svg' : ''}" onerror="if(!this.dataset.fb1){this.dataset.fb1='1';this.src='./applications/${app.bundleName}/icon.png';}else if(!this.dataset.fb2){this.dataset.fb2='1';this.src='./applications/default_icon.png';}">
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
        return this.taskList.filter((task) => this._isTaskVisible(task));
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
        // task_status 'failed' 表示最后一次 turn 以模型错误终止（或崩溃恢复），优先于旧 turn 的 attempt_completion
        if (task.task_status === 'failed') {
            return { key: 'fail', label: '失败', dotClass: 'bg-[#f87171]', terminal: true };
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
        weixin: { label: '微信', color: '#09B83E' },
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

    /**
     * 同步侧边栏任务高亮。
     * 这是任务高亮的唯一入口：既兼容历史调用 `_updateTaskHighlight()`（同步当前实例状态），
     * 也支持统一由 openTask 传入 taskId 并通过 revealCurrentTask 展开分组、滚动到可见。
     * @param {string | number | null} [taskId] 省略时沿用 this.currentTaskId
     * @param {{ revealCurrentTask?: boolean }} [options]
     * @returns {boolean | undefined} reveal 时表示任务是否在任务列表中，否则 undefined
     */
    _updateTaskHighlight(taskId, options) {
        if (taskId !== undefined) {
            this.currentTaskId = taskId;
        }
        const container = this.querySelector('#task-list-container');
        if (!container) return false;

        container.querySelectorAll('.sb-task-row, .sb-running-subtask-row').forEach((item) => {
            item.classList.toggle('is-current', item.dataset.task_id === this.currentTaskId);
        });
        container.querySelectorAll('.sb-running-card').forEach((card) => {
            const taskId = card.querySelector('.sb-running-header')?.dataset.task_id;
            card.classList.toggle('is-current', taskId === this.currentTaskId);
        });
        if (!options?.revealCurrentTask) return undefined;
        return this._revealCurrentTask(container);
    }

    /**
     * 保证当前任务在任务列表中可见：
     * 1. 优先找运行区中的当前任务（运行区始终渲染，最多需要滚动）；
     * 2. 否则定位分组中的任务行：分组折叠时立即展开（手风琴式，一次只展开一组）；
     *    行不在 DOM（分页之外）时按需扩充分页展示数量并重渲染列表，滚动需等重渲染的
     *    滚动位置恢复（RAF）之后执行，否则会被覆盖；
     * 3. 行不在可视区时滚动到最近边缘。
     * @param {HTMLElement} container
     * @returns {boolean} 当前任务是否在任务列表中
     */
    _revealCurrentTask(container) {
        const taskId = this.currentTaskId;
        if (taskId === null || taskId === undefined) return false;
        const escapedTaskId =
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                ? CSS.escape(String(taskId))
                : String(taskId);
        const findRow = () =>
            container.querySelector(`.sb-running-header[data-task_id="${escapedTaskId}"]`) ||
            container.querySelector(`.sb-task-row[data-task_id="${escapedTaskId}"]`);

        const applyReveal = (row) => {
            if (!row.closest('.sb-running-list')) {
                const group = row.closest('.sb-task-group');
                if (group && group.tagName === 'DETAILS' && !group.open) {
                    // 先瞬时收起当前展开的组（不重放动画），再展开目标组；
                    // 若走 _closeTaskGroup 的动画回调重开目标组，会重播展开动画造成闪烁
                    const currentlyOpen = [...container.querySelectorAll('.sb-task-group[open]')].find(
                        (item) => item !== group
                    );
                    if (currentlyOpen) {
                        currentlyOpen.classList.remove('is-opening', 'is-closing');
                        currentlyOpen.removeAttribute('open');
                    }
                    this._openTaskGroup(group);
                }
            }
            // block: 'nearest' 对已在可视区内的元素是无操作，
            // 并会同时校正 .sb-task-group-body / .sb-running-list 等内层滚动容器的位置
            row.scrollIntoView?.({ block: 'nearest' });
        };

        let row = findRow();
        if (row) {
            applyReveal(row);
            return true;
        }
        if (!this._ensureTaskRowRendered(taskId)) return false;
        row = findRow();
        if (!row) return false;
        // reloadTaskList 会先同步恢复、再经 RAF 二次恢复旧的滚动位置，
        // 因此滚动到目标任务必须排在其后，否则会被旧位置覆盖
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => applyReveal(row));
        } else {
            applyReveal(row);
        }
        return true;
    }

    /**
     * 当前任务行不在 DOM 中（位于分页之外）时，定位其所属分组并扩充该组的分页展示数量，
     * 随后重渲染任务列表。会同时把 _openTaskGroupId 指向目标分组，让重渲染后目标组保持展开。
     * @param {string} taskId
     * @returns {boolean} 任务是否存在于当前任务列表口径内
     */
    _ensureTaskRowRendered(taskId) {
        const filteredTasks = this._getFilteredTaskList();
        let groupId = 'favorites';
        let items;
        if (this._favoritesView) {
            const favoritedTasks = filteredTasks.filter((t) => this._favoritedTaskIds.has(t.task_id));
            items = buildSidebarFavoritesResults(favoritedTasks);
        } else {
            const group = buildSidebarTaskGroups(filteredTasks, this._taskView).find((candidate) =>
                candidate.items.some((item) => item.task.task_id === taskId)
            );
            if (!group) return false;
            groupId = group.id;
            items = group.items;
        }
        const index = items.findIndex((item) => item.task.task_id === taskId);
        if (index < 0) return false;
        const limit = this._groupDisplayLimits.get(groupId) ?? TASK_PAGE_SIZE;
        if (index >= limit) {
            // 按整页扩充，避免目标行恰好压在分页边界上
            this._groupDisplayLimits.set(groupId, (Math.floor(index / TASK_PAGE_SIZE) + 1) * TASK_PAGE_SIZE);
        }
        this._openTaskGroupId = groupId;
        this.reloadTaskList();
        return true;
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

    _dismissDebugMenu() {
        const existing = this.querySelector('#debug-context-menu');
        if (existing) existing.remove();
        document.removeEventListener('click', this._debugMenuDismissHandler, true);
        this._debugMenuDismissHandler = null;
    }

    _showDebugMenu(event) {
        this._dismissDebugMenu();

        const targetEl = event.target?.closest?.('button') || event.target;
        const rect = targetEl.getBoundingClientRect();

        const menu = document.createElement('div');
        menu.id = 'debug-context-menu';
        menu.className = 'ctx-menu';
        menu.style.cssText = 'position:fixed;z-index:99999;min-width:180px;';

        const svgIcon = (path) =>
            `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

        const items = [
            {
                id: 'dev-tools',
                icon: svgIcon('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
                label: this._t('renderer.toolbar.developerTools'),
                action: () => {
                    window.settingAPI.openDevTools();
                }
            },
            {
                id: 'logs',
                icon: svgIcon(
                    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'
                ),
                label: this._t('renderer.toolbar.logs'),
                action: () => {
                    window.settingAPI.openLogWindow();
                }
            },
            {
                id: 'config-dir',
                icon: svgIcon(
                    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'
                ),
                label: this._t('renderer.toolbar.openConfigDir'),
                action: () => {
                    window.settingAPI.openConfigDirectory();
                }
            },
            {
                id: 'adminconsole',
                icon: svgIcon('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
                label: this._t('renderer.toolbar.admin'),
                action: () => {
                    // 管理后台是 showIcon=false 的应用：不进应用列表，只从调试菜单进入
                    window.globalControlAPI.openApplication('adminconsole');
                }
            }
        ];

        menu.innerHTML = items
            .map(
                (item) =>
                    `<button class="ctx-item" data-action="${item.id}">
                        <span class="ctx-icon-sm">${item.icon}</span>
                        <span class="ctx-label">${item.label}</span>
                    </button>`
            )
            .join('');

        this.appendChild(menu);

        // Position: above the button, aligned to its left edge
        requestAnimationFrame(() => {
            const view = visibleViewportRect();
            const origin = fixedLayerOrigin(menu);
            const menuRect = menu.getBoundingClientRect();
            let left = rect.left;
            let top = rect.top - menuRect.height - 4;
            if (left + menuRect.width > view.right) {
                left = view.right - menuRect.width - 8;
            }
            if (top < view.top) {
                top = rect.bottom + 4;
            }
            menu.style.left = `${left - origin.x}px`;
            menu.style.top = `${top - origin.y}px`;
        });

        // Bind actions
        items.forEach((item) => {
            menu.querySelector(`[data-action="${item.id}"]`).addEventListener('click', () => {
                this._dismissDebugMenu();
                item.action();
            });
        });

        // Dismiss on outside click
        this._debugMenuDismissHandler = (e) => {
            if (!menu.contains(e.target)) {
                this._dismissDebugMenu();
            }
        };
        setTimeout(() => {
            if (this._debugMenuDismissHandler) {
                document.addEventListener('click', this._debugMenuDismissHandler, true);
            }
        }, 0);
    }

    _showTaskInfoModal(taskId) {
        const t = (key) => this._t(key);
        const overlay = document.createElement('div');
        overlay.className = 'od-taskinfo-overlay od-confirm-modal-overlay';
        if (detectDarkMode()) {
            overlay.classList.add('od-modal-dark');
        }
        overlay.innerHTML = `
<style>${MODAL_CSS}
    /* 任务信息弹窗 · 基于 MODAL_CSS 顶部色带风格扩展（设计规范见 docs/designs/modal.html） */
    .od-taskinfo-overlay {
        /* 弹窗内显式声明 UI 字体，不依赖文档继承链 */
        font-family: var(--font-sans, 'HarmonyOS Sans', 'PingFang SC', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif);
        /* 复制成功反馈色（浅/深） */
        --ti-success: #1F9D66;
    }
    .od-taskinfo-overlay.od-modal-dark { --ti-success: #3DBF82; }
    .od-taskinfo-overlay .od-confirm-modal-card { width: 480px; }
    .od-taskinfo-rows { padding: 4px 0; }
    .od-taskinfo-row {
        display: flex; align-items: center; gap: 10px;
        padding: 9px 0;
        border-bottom: 1px solid var(--mc-line-soft);
    }
    .od-taskinfo-row:last-child { border-bottom: none; }
    .od-taskinfo-label {
        font-size: 11.5px; font-weight: 500; color: var(--mc-ink3);
        min-width: 76px; flex-shrink: 0;
    }
    .od-taskinfo-value {
        font-size: 12.5px; color: var(--mc-ink2); line-height: 1.5;
        /* 西文走全局等宽栈；等宽字体普遍缺中文字形，monospace 之前插入 UI 中文字体，
           避免任务名等中文内容回退到系统默认等宽字体（Windows 下为宋体） */
        font-family: 'Maple Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'HarmonyOS Sans', 'PingFang SC', 'Microsoft YaHei', monospace;
        flex: 1; min-width: 0; word-break: break-all; margin-right: 6px;
    }
    .od-taskinfo-copy-btn {
        width: 28px; height: 28px; border-radius: 7px; border: none; padding: 0;
        background: transparent; cursor: pointer; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        color: var(--mc-ink4); transition: background 0.15s, color 0.15s;
    }
    .od-taskinfo-copy-btn:hover { background: var(--mc-hover); color: var(--mc-ink2); }
    .od-taskinfo-copy-btn:active { transform: scale(0.92); }
    .od-taskinfo-copy-btn i { font-size: 13px; }
    .od-taskinfo-copy-btn.copied i { color: var(--ti-success); }
    .od-taskinfo-loading {
        text-align: center; padding: 28px; color: var(--mc-ink3); font-size: 12.5px;
    }
    .od-taskinfo-error {
        text-align: center; padding: 28px; color: var(--mc-red); font-size: 12.5px;
    }
</style>
<div class="od-confirm-modal-card">
    <div class="od-confirm-modal-banner info">
        <div class="od-confirm-modal-icon">${renderIcon('fa-circle-info')}</div>
        <div class="od-confirm-modal-banner-text">
            <div class="od-confirm-modal-title">${t('renderer.sidebar.taskInfoTitle')}</div>
        </div>
        <button class="od-confirm-modal-close" data-action="close" aria-label="${t('renderer.sidebar.taskInfoClose')}">${CLOSE_SVG}</button>
    </div>
    <div class="od-confirm-modal-body">
        <div class="od-taskinfo-rows">
            <div class="od-taskinfo-loading">
                <i class="fas fa-spinner fa-spin"></i> ${t('renderer.sidebar.taskInfoLoading')}
            </div>
        </div>
    </div>
    <div class="od-confirm-modal-footer">
        <button class="od-confirm-btn od-confirm-btn-primary" data-action="close">${t('renderer.sidebar.taskInfoClose')}</button>
    </div>
</div>`;

        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            overlay.classList.add('od-modal-leaving');
            setTimeout(() => overlay.remove(), MODAL_ANIM_DURATION_OUT);
            document.removeEventListener('keydown', escHandler);
        };

        const escHandler = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
        };
        document.addEventListener('keydown', escHandler);

        bindOverlayDismiss(
            overlay,
            close,
            (tgt) => !!(tgt && tgt.classList && tgt.classList.contains('od-confirm-modal-overlay'))
        );

        overlay.querySelectorAll('[data-action="close"]').forEach((btn) => {
            btn.addEventListener('click', close);
        });

        document.body.appendChild(overlay);

        // 加载任务信息
        const rowsContainer = overlay.querySelector('.od-taskinfo-rows');
        window.taskManagerAPI
            .getTaskInfo(taskId)
            .then((info) => {
                if (closed) return;
                const rows = [
                    {
                        label: t('renderer.sidebar.taskInfoName'),
                        value: info.task_name || t('renderer.sidebar.taskInfoUnnamed')
                    },
                    { label: t('renderer.sidebar.taskInfoId'), value: info.task_id },
                    { label: t('renderer.sidebar.taskInfoStatus'), value: info.task_status },
                    { label: t('renderer.sidebar.taskInfoDataFile'), value: info.task_json_path },
                    {
                        label: t('renderer.sidebar.taskInfoModel'),
                        value: info.model || t('renderer.sidebar.taskInfoDefaultModel')
                    }
                ];
                if (info.parent_id) {
                    rows.splice(2, 0, { label: t('renderer.sidebar.taskInfoParentId'), value: info.parent_id });
                }
                rowsContainer.innerHTML = rows
                    .map((row) => {
                        const escaped = escapeHtml(row.value);
                        return `<div class="od-taskinfo-row">
                    <span class="od-taskinfo-label">${row.label}</span>
                    <span class="od-taskinfo-value">${escaped}</span>
                    <button class="od-taskinfo-copy-btn" data-copy="${escaped}" title="${t('renderer.sidebar.taskInfoCopy')}">
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
                            btn.classList.add('copied');
                            const icon = btn.querySelector('i');
                            icon.className = 'fa-solid fa-check';
                            setTimeout(() => {
                                btn.classList.remove('copied');
                                icon.className = 'fa-regular fa-copy';
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
                <i class="fas fa-triangle-exclamation"></i> ${t('renderer.sidebar.taskInfoLoadFailed')}${escapeHtml(err.message || String(err))}
            </div>`;
            });
    }

    _showAppContextMenu(x, y, bundleName, appSource) {
        this._dismissAppContextMenu();

        const menu = document.createElement('div');
        menu.id = 'app-context-menu';
        menu.className = 'ctx-menu';
        menu.style.minWidth = '180px';

        const isUserApp = appSource === 'user';
        const items = [{ id: 'open', icon: 'fa-solid fa-arrow-right', label: '打开' }];
        // 浏览器应用依赖 webview（iframe 内不可用），只能内联挂载在主窗口，不提供独立窗口入口
        if (bundleName !== 'browser') {
            items.push({ id: 'new-window', icon: 'fa-solid fa-external-link-alt', label: '在新窗口中打开' });
        }
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

        // menu 挂在 #app-root 子树内，fixed 坐标原点是内容区而非视口（见 window-frame.ts）
        const origin = fixedLayerOrigin(menu);
        menu.style.left = `${x - origin.x}px`;
        menu.style.top = `${y - origin.y}px`;

        requestAnimationFrame(() => {
            const view = visibleViewportRect();
            const rect = menu.getBoundingClientRect();
            if (rect.right > view.right) {
                menu.style.left = `${view.right - rect.width - 8 - origin.x}px`;
            }
            if (rect.bottom > view.bottom) {
                menu.style.top = `${view.bottom - rect.height - 8 - origin.y}px`;
            }
        });

        menu.querySelector('[data-action="open"]').addEventListener('click', () => {
            this._dismissAppContextMenu();
            window.globalControlAPI.openApplication(bundleName);
            this._dismissAppPopover();
        });

        menu.querySelector('[data-action="new-window"]')?.addEventListener('click', () => {
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

    /**
     * 删除任务的唯一入口：确认弹窗 → 清任务视图缓存 → 当前任务回首页 → 删除。
     * 右键菜单、悬停删除按钮与触摸左滑删除共用，避免文案与流程分叉。
     */
    async _confirmAndDeleteTask(taskId) {
        const task = this.taskList.find((item) => item.task_id === taskId);
        const taskName = escapeHtml(task?.task_name || this._t('renderer.sidebar.unnamedTask'));
        const confirmed = await showConfirmModal({
            icon: 'fa-trash-can',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: this._t('renderer.sidebar.deleteTask'),
            message: this._t('renderer.sidebar.deleteTaskConfirm', { taskName }),
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
        this._exitMultiSelect();
    }

    /**
     * 批量删除多个任务：过滤收藏任务 → 确认弹窗 → 逐个清缓存删除 → 当前任务回首页 → 刷新。
     * 收藏任务不参与批量删除，与分组删除的口径一致；全部被滤除时不弹确认。
     */
    async _confirmAndDeleteTasks(taskIds) {
        const deletableIds = taskIds.filter((taskId) => !this._favoritedTaskIds.has(taskId));
        if (deletableIds.length === 0) {
            // 所选任务全部是收藏任务：无可删项，明确反馈而非静默
            window.notificationAPI?.sendNotification(
                'info',
                this._t('renderer.sidebar.deleteSelectedTasks'),
                this._t('renderer.sidebar.deleteSelectedTasksAllFavorited'),
                ''
            );
            return false;
        }
        const code = generateChallengeCode();
        const confirmed = await showConfirmModal({
            icon: 'fa-trash',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: this._t('renderer.sidebar.deleteSelectedTasks'),
            message: this._t('renderer.sidebar.deleteSelectedTasksConfirm', { count: deletableIds.length }),
            confirmText: this._t('common.delete'),
            cancelText: this._t('common.cancel'),
            danger: true,
            challenge: code,
            challengeHint: this._t('confirm.delete.challenge_hint', { code })
        });
        if (!confirmed) return false;
        // 当前任务在待删列表中：先回主页再开始删除，避免 taskview 挂在待删任务上闪现中间态
        if (deletableIds.includes(this.currentTaskId)) {
            window.globalControlAPI.openTask(null);
            this._updateTaskHighlight(null);
        }
        for (const taskId of deletableIds) {
            window.globalControlAPI.removeTaskViewCache(taskId);
            await window.taskManagerAPI.removeTask(taskId);
        }
        this._exitMultiSelect();
        this.reloadTaskList();
        return true;
    }

    /**
     * 任务列表多选/框选交互：状态在 this 上，DOM 交互在独立控制器里。
     */
    _initMultiSelect() {
        this._multiSelectController?.destroy();
        this._multiSelectController = null;
        const container = this.querySelector('#task-list-container');
        if (!container) return;
        this._multiSelectController = attachSidebarMultiSelect(container, {
            isMultiSelect: () => this._multiSelect,
            setMultiSelect: (on) => (on ? this._enterMultiSelect(this._multiSelectIds) : this._exitMultiSelect()),
            getSelection: () => this._multiSelectIds,
            setSelection: (ids, anchorId) => {
                this._multiSelectIds = ids;
                this._multiSelectAnchorId = anchorId;
                this._multiSelectController?.syncAfterRender();
            }
        });
    }

    /**
     * 进入多选形态：重渲染任务列表，任务名左侧的状态图标替换为圆形选择框。
     * 不预选任何任务；进入多选不弹菜单，等用户框选/点选。
     */
    _enterMultiSelect(initialIds) {
        this._multiSelect = true;
        this._multiSelectIds = initialIds instanceof Set ? initialIds : new Set();
        this._multiSelectAnchorId = null;
        this._dismissContextMenu();
        this.reloadTaskList();
    }

    /** 退出多选形态并恢复常规渲染 */
    _exitMultiSelect() {
        if (!this._multiSelect) return;
        this._multiSelect = false;
        this._multiSelectIds = new Set();
        this._multiSelectAnchorId = null;
        this._dismissMultiSelectMenu();
        this.reloadTaskList();
    }

    _dismissMultiSelectMenu() {
        this.querySelector('#task-multi-select-menu')?.remove();
        if (this._multiSelectMenuDismissHandler) {
            document.removeEventListener('click', this._multiSelectMenuDismissHandler, true);
            this._multiSelectMenuDismissHandler = null;
        }
    }

    /**
     * 多选形态的独立右键菜单：仅「删除 N 个已选任务」。
     * 菜单自身不展示选中行之外的项；退出多选的路径由多选控制器统一处理。
     */
    _showMultiSelectContextMenu(x, y) {
        this._dismissMultiSelectMenu();
        this._dismissContextMenu();
        const taskIds = Array.from(this._multiSelectIds);
        if (taskIds.length === 0) return;

        const menu = document.createElement('div');
        menu.id = 'task-multi-select-menu';
        menu.className = 'ctx-menu sb-multi-menu';
        menu.style.minWidth = '180px';
        menu.innerHTML =
            `<button class="ctx-item danger" data-action="delete-selected">` +
            `<span class="ctx-icon-sm"><i class="fa-solid fa-trash-can"></i></span>` +
            `<span class="ctx-label">${this._t('renderer.sidebar.deleteSelectedTasksWithCount', {
                count: taskIds.length
            })}</span></button>`;
        this.appendChild(menu);

        const origin = fixedLayerOrigin(menu);
        menu.style.left = `${x - origin.x}px`;
        menu.style.top = `${y - origin.y}px`;

        requestAnimationFrame(() => {
            const view = visibleViewportRect();
            const rect = menu.getBoundingClientRect();
            if (rect.right > view.right) {
                menu.style.left = `${view.right - rect.width - 8 - origin.x}px`;
            }
            if (rect.bottom > view.bottom) {
                menu.style.top = `${view.bottom - rect.height - 8 - origin.y}px`;
            }
        });

        menu.querySelector('[data-action="delete-selected"]').addEventListener('click', async () => {
            this._dismissMultiSelectMenu();
            // 菜单打开期间选区可能已被外部刷新剔除部分任务，点击时现取而非用快照
            await this._confirmAndDeleteTasks(Array.from(this._multiSelectIds));
        });

        // 菜单外点击关闭菜单但保持多选状态；退出多选由控制器的选区外点击逻辑负责。
        // 延迟注册是为吞掉「打开菜单的那次右键」自身冒泡；注册时必须校验句柄仍然有效，
        // 否则菜单若在 0ms 内被关闭，这里会把 null 注册进 document 污染后续 click。
        this._multiSelectMenuDismissHandler = (e) => {
            if (!menu.contains(e.target)) {
                this._dismissMultiSelectMenu();
            }
        };
        setTimeout(() => {
            if (this._multiSelectMenuDismissHandler) {
                document.addEventListener('click', this._multiSelectMenuDismissHandler, true);
            }
        }, 0);
    }

    /**
     * 多选形态下行点击：Shift 以锚点做区间选；普通点击（含 Ctrl/Cmd 点击、触屏轻点）都是
     * toggle——已选中则取消，未选中则加选，其余已选行保留（取消到空也保持多选形态）。
     */
    _handleMultiSelectRowClick(event, taskId) {
        if (event.shiftKey) {
            // 区间选按 DOM 渲染顺序取锚点到目标的连续区间；无锚点时退化为单选目标
            const rowIds = this._visibleRowTaskIds();
            const range = rangeByAnchor(rowIds, this._multiSelectAnchorId, taskId);
            this._multiSelectIds = range.size > 0 ? range : new Set([taskId]);
            this._multiSelectController?.syncAfterRender();
            return;
        }
        this._multiSelectIds = ctrlToggleId(this._multiSelectIds, taskId);
        this._multiSelectAnchorId = taskId;
        this._multiSelectController?.syncAfterRender();
    }

    /**
     * 当前列表渲染顺序中的任务 id（Shift 区间选的基准）。
     * 只取展开分组内的行：折叠 details 的行不可见，纳入区间会选中看不见的任务。
     * 收藏视图的分组是 div（无折叠语义），始终参与。
     */
    _visibleRowTaskIds() {
        const collapsedRows = new Set(
            Array.from(
                this.querySelectorAll(
                    '#task-list-container .sb-task-group:not([open]):not(.is-search) .task-item.sb-task-row'
                )
            )
        );
        return Array.from(this.querySelectorAll('#task-list-container .task-item.sb-task-row'))
            .filter((row) => !collapsedRows.has(row))
            .map((row) => row.dataset.task_id);
    }

    /**
     * 任务列表触摸左滑删除：监听以委托方式挂在列表容器上，行由 innerHTML 重渲染不影响监听。
     */
    _initTaskSwipeDelete() {
        this._swipeDeleteController?.destroy();
        this._swipeDeleteController = null;
        const container = this.querySelector('#task-list-container');
        if (!container) return;
        this._swipeDeleteController = attachSidebarSwipeDelete(container, {
            onDelete: (taskId) => this._confirmAndDeleteTask(taskId),
            // 多选形态下挂起左滑手势，避免其 click 捕获拦截选择点击
            isSuspended: () => this._multiSelect
        });
    }

    _showContextMenu(x, y, taskId) {
        this._dismissContextMenu();
        this._dismissMultiSelectMenu();

        const menu = document.createElement('div');
        menu.id = 'task-context-menu';
        menu.className = 'ctx-menu';
        menu.style.minWidth = '180px';

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
            { id: 'file-trash', icon: 'fa-solid fa-trash-arrow-up', label: this._t('renderer.sidebar.fileTrash') },
            { id: 'delete', icon: 'fa-solid fa-trash-can', label: this._t('renderer.sidebar.deleteTask'), danger: true }
        ];
        // 删除任务与删除全部任务之间：删除当前分类（分组）的全部任务
        const group = this._findGroupByTaskId(taskId);
        if (group) {
            items.push({
                id: 'delete-group',
                icon: 'fa-solid fa-trash-can',
                label: this._groupDeleteLabel(group),
                danger: true
            });
        }
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
        items.push({
            id: 'multi-select',
            icon: 'fa-regular fa-circle-check',
            label: this._t('renderer.sidebar.selectMultipleTasks')
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
                        `<span class="ctx-arrow">${CHEVRON_RIGHT_SVG}</span></button>` +
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

        // menu 挂在 #app-root 子树内，fixed 坐标原点是内容区而非视口（见 window-frame.ts）
        const origin = fixedLayerOrigin(menu);
        menu.style.left = `${x - origin.x}px`;
        menu.style.top = `${y - origin.y}px`;

        requestAnimationFrame(() => {
            const view = visibleViewportRect();
            const rect = menu.getBoundingClientRect();
            if (rect.right > view.right) {
                menu.style.left = `${view.right - rect.width - 8 - origin.x}px`;
            }
            if (rect.bottom > view.bottom) {
                menu.style.top = `${view.bottom - rect.height - 8 - origin.y}px`;
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
                this._updateTaskHighlight(forkedTaskId);
                this.reloadTaskList();
            } catch (error) {
                console.error('Failed to fork task:', error);
            }
        });

        menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
            this._dismissContextMenu();
            await this._confirmAndDeleteTask(taskId);
        });

        menu.querySelector('[data-action="delete-all"]').addEventListener('click', async () => {
            this._dismissContextMenu();
            const code = generateChallengeCode();
            const confirmed = await showConfirmModal({
                icon: 'fa-trash',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('renderer.sidebar.deleteAllTasks'),
                message: this._t('renderer.sidebar.deleteAllTasksConfirm'),
                confirmText: this._t('renderer.sidebar.confirmDeleteAll'),
                cancelText: this._t('common.cancel'),
                danger: true,
                challenge: code,
                challengeHint: this._t('confirm.delete.challenge_hint', { code })
            });
            if (!confirmed) return;
            window.globalControlAPI.clearAllTaskViewCache();
            window.globalControlAPI.openHomePage();
            this._updateTaskHighlight(false);
            await window.taskManagerAPI.clearAllTasks();
            this.reloadTaskList();
        });
        menu.querySelector('[data-action="delete-workspace"]')?.addEventListener('click', async () => {
            this._dismissContextMenu();
            const task = this.taskList.find((t) => t.task_id === taskId);
            const workspacePath = task?.workspace || '';
            await this._deleteTasksInWorkspace(workspacePath);
        });
        menu.querySelector('[data-action="delete-group"]')?.addEventListener('click', async () => {
            this._dismissContextMenu();
            const group = this._findGroupByTaskId(taskId);
            if (!group) return;
            await this._deleteTasksInGroup(group);
        });
        menu.querySelector('[data-action="multi-select"]')?.addEventListener('click', () => {
            this._dismissContextMenu();
            // 已处于多选态（如从运行区卡片菜单进入）时保留既有选择
            this._enterMultiSelect(this._multiSelect ? this._multiSelectIds : undefined);
        });
        menu.querySelector('[data-action="rename"]').addEventListener('click', () => {
            this._dismissContextMenu();
            this._startInlineRename(taskId);
        });
        menu.querySelector('[data-action="file-trash"]')?.addEventListener('click', () => {
            this._dismissContextMenu();
            document.getElementById('trash-floating-window')?.open({ taskId });
        });
        menu.querySelector('[data-action="trigger-task-review"]')?.addEventListener('click', async () => {
            this._dismissContextMenu();
            try {
                await window.taskManagerAPI.triggerTaskReview(taskId);
                window.notificationAPI?.sendNotification(
                    'info',
                    this._t('renderer.developer.menu'),
                    this._t('renderer.developer.reviewTriggered'),
                    this._t('renderer.developer.reviewTriggeredDetail')
                );
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

        // 子菜单（如"开发者"）：触摸/点击显式展开——桌面 Chromium 触摸不产生
        // :hover，:focus-within 也不可靠；click 冒泡还可能被上层关闭逻辑误吞。
        // 用 class 切换 + 阻断冒泡，保证触摸与鼠标行为一致（再次点击收起）。
        const submenuBtn = menu.querySelector('[data-submenu="1"]');
        submenuBtn?.addEventListener('click', (event) => {
            event.stopPropagation();
            submenuBtn.parentElement?.classList.toggle('is-submenu-open');
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

        // menu 挂在 #app-root 子树内，fixed 坐标原点是内容区而非视口（见 window-frame.ts）
        const origin = fixedLayerOrigin(menu);
        menu.style.left = `${x - origin.x}px`;
        menu.style.top = `${y - origin.y}px`;

        requestAnimationFrame(() => {
            const view = visibleViewportRect();
            const rect = menu.getBoundingClientRect();
            if (rect.right > view.right) {
                menu.style.left = `${view.right - rect.width - 8 - origin.x}px`;
            }
            if (rect.bottom > view.bottom) {
                menu.style.top = `${view.bottom - rect.height - 8 - origin.y}px`;
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
                this._updateTaskHighlight(taskId);
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
        const code = generateChallengeCode();
        const confirmed = await showConfirmModal({
            icon: 'fa-trash',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: this._t('renderer.sidebar.deleteWorkspaceAllTasks'),
            message: this._t('renderer.sidebar.deleteWorkspaceTasksConfirm', { count: tasksToDelete.length }),
            confirmText: this._t('common.delete'),
            cancelText: this._t('common.cancel'),
            danger: true,
            challenge: code,
            challengeHint: this._t('confirm.delete.challenge_hint', { code })
        });
        if (!confirmed) return;
        // 当前任务在待删列表中：先回主页再开始删除，避免 taskview 挂在待删任务上闪现中间态
        if (tasksToDelete.some((task) => task.task_id === this.currentTaskId)) {
            window.globalControlAPI.openTask(null);
            this._updateTaskHighlight(null);
        }
        for (const task of tasksToDelete) {
            window.globalControlAPI.removeTaskViewCache(task.task_id);
            await window.taskManagerAPI.removeTask(task.task_id);
        }
        this._exitMultiSelect();
        this.reloadTaskList();
    }

    /**
     * 找到任务当前所属的分组（按当前视图构建，找不到返回 null）。
     * 「删除当前分类全部任务」的文案与范围都来自这个分组。
     */
    _findGroupByTaskId(taskId) {
        const groups = buildSidebarTaskGroups(this._getFilteredTaskList(), this._taskView);
        return groups.find((g) => g.items.some((item) => item.task.task_id === taskId)) || null;
    }

    /**
     * 「删除当前分类全部任务」的菜单文案：时间视图用独立短语（如"删除近7天的任务"），
     * 工作空间视图用工作空间名拼模板。
     */
    _groupDeleteLabel(group) {
        const keyByGroup = {
            today: 'renderer.sidebar.groupDeleteToday',
            'this-week': 'renderer.sidebar.groupDeleteThisWeek',
            earlier: 'renderer.sidebar.groupDeleteEarlier',
            'other-workspaces': 'renderer.sidebar.groupDeleteOtherWorkspaces',
            automatic: 'renderer.sidebar.groupDeleteAutomatic'
        };
        const key = keyByGroup[group.id];
        if (key) return this._t(key);
        return this._t('renderer.sidebar.groupDeleteWorkspace', { name: this._taskGroupLabel(group) });
    }

    /**
     * 删除当前分组下的全部任务（右键菜单「删除 xx 的任务」）。
     * 时间视图：今天/近7天/更早/自动任务；工作空间视图：对应工作空间。
     */
    async _deleteTasksInGroup(group) {
        const taskIds = group.items.map((item) => item.task.task_id).filter((id) => !this._favoritedTaskIds.has(id));
        if (taskIds.length === 0) {
            // 分组内全部是收藏任务：无可删项，明确反馈而非静默
            window.notificationAPI?.sendNotification(
                'info',
                this._groupDeleteLabel(group),
                this._t('renderer.sidebar.deleteGroupTasksAllFavorited'),
                ''
            );
            return;
        }
        const groupLabel = this._taskGroupLabel(group);
        const code = generateChallengeCode();
        const confirmed = await showConfirmModal({
            icon: 'fa-trash',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: this._groupDeleteLabel(group),
            message: this._t('renderer.sidebar.deleteGroupTasksConfirm', { group: groupLabel, count: taskIds.length }),
            confirmText: this._t('common.delete'),
            cancelText: this._t('common.cancel'),
            danger: true,
            challenge: code,
            challengeHint: this._t('confirm.delete.challenge_hint', { code })
        });
        if (!confirmed) return;
        // 当前任务在待删列表中：先回主页再开始删除，避免 taskview 挂在待删任务上闪现中间态
        if (taskIds.includes(this.currentTaskId)) {
            window.globalControlAPI.openTask(null);
            this._updateTaskHighlight(null);
        }
        for (const taskId of taskIds) {
            window.globalControlAPI.removeTaskViewCache(taskId);
            await window.taskManagerAPI.removeTask(taskId);
        }
        this._exitMultiSelect();
        this.reloadTaskList();
    }

    _bindTaskItemEvents(container) {
        container.querySelectorAll('.task-item').forEach((item) => {
            if (item._bound) return;
            item._bound = true;
            // 运行区卡片不参与多选：不渲染圆形选择框、不在渲染顺序里（Shift 区间选
            // 找不到它），多选态下保留「点击打开任务」的原语义。
            const inMultiSelectScope = item.classList.contains('sb-task-row');
            item.addEventListener('click', (event) => {
                const taskId = event.currentTarget.dataset.task_id;
                if (this._multiSelect && inMultiSelectScope) {
                    // 多选形态下点击行是选择手势，不再打开任务
                    event.stopPropagation();
                    this._handleMultiSelectRowClick(event, taskId);
                    return;
                }
                window.globalControlAPI.openTask(taskId);
                this._updateTaskHighlight(taskId);
            });
            item.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const taskId = event.currentTarget.dataset.task_id;
                if (this._multiSelect && inMultiSelectScope) {
                    // macOS 上 Ctrl+左键会派发 contextmenu（系统右键语义）且不派发
                    // mouseup/click。多选态下这是 Ctrl 点选手势：直接执行 toggle 并吞掉
                    // 菜单；右键（无 Ctrl）才弹多选菜单。
                    if (event.ctrlKey && !event.metaKey && !event.shiftKey) {
                        this._handleMultiSelectRowClick({ ctrlKey: true, metaKey: false, shiftKey: false }, taskId);
                        return;
                    }
                    this._showMultiSelectContextMenu(event.clientX, event.clientY);
                    return;
                }
                this._showContextMenu(event.clientX, event.clientY, taskId);
            });
        });

        container.querySelectorAll('.delete-task-btn').forEach((btn) => {
            if (btn._bound) return;
            btn._bound = true;
            btn.addEventListener('click', async (event) => {
                event.stopPropagation();
                await this._confirmAndDeleteTask(event.currentTarget.dataset.task_id);
            });
        });
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
        const failed = isSidebarTaskFailed(task);
        const taskName = escapeHtml(task.task_name || this._t('renderer.sidebar.unnamedTask'));
        const time = escapeHtml(this._formatTaskTime(task));
        const waitingTag = SideBar.buildWaitingTag(task.task_id, this._waitingTaskIds, isCurrentTask);
        const browserIcon = this._browserActiveTaskIds.has(task.task_id)
            ? '<i class="fas fa-globe sidebar-browser-icon"></i>'
            : '';
        const favoriteIcon = this._favoritedTaskIds.has(task.task_id)
            ? '<i class="fa-solid fa-star sb-task-favorite" aria-hidden="true"></i>'
            : '';
        // 多选形态：状态图标换成圆形选择框（radio button 样式，可多选）
        const resultIcon = this._multiSelect
            ? `<span class="sb-multi-checkbox${this._multiSelectIds.has(task.task_id) ? ' is-checked' : ''}" aria-hidden="true">${CHECK_SVG}</span>`
            : isRunning
              ? '<span class="sb-running-spinner" aria-hidden="true"></span>'
              : `<span class="sb-task-result${failed ? ' is-failed' : ''}" aria-hidden="true">${failed ? '×' : '✓'}</span>`;
        return `
        <div
            class="task-item sb-task-row${isCurrentTask ? ' is-current' : ''}"
            data-task_id="${escapeHtml(task.task_id)}"
            data-parent_id=""
            data-depth="0"
        >
            <button
                type="button"
                class="sb-swipe-delete"
                data-task_id="${escapeHtml(task.task_id)}"
                tabindex="-1"
                aria-label="${this._t('renderer.sidebar.deleteTask')}"
            >${TRASH_SVG}</button>
            <div class="sb-task-row-main">
                ${resultIcon}
                <span class="sb-task-name">${taskName}</span>
                ${favoriteIcon}
                ${waitingTag}
                ${browserIcon}
                <span class="sb-task-time">${time}</span>
            </div>
        </div>`;
    }

    _buildRunningTaskCard(item) {
        const task = item.task;
        const isCurrentTask = task.task_id === this.currentTaskId;
        const recentlyCompleted = item.recentlyCompleted === true;
        const recentlyFailed = recentlyCompleted && isSidebarTaskFailed(task);
        const children = item.children;
        const completed = children.filter((child) => SideBar.getSubTaskStatusMeta(child).terminal).length;
        const childRows = children.map((child) => this._buildRunningSubtaskRow(child)).join('');
        const childrenSection =
            !recentlyCompleted && children.length > 0
                ? `
                <details class="sb-running-subtasks"${children.some((child) => child.task_status === 'running') ? ' open' : ''}>
                    <summary>
                        <span class="sb-running-chevron" aria-hidden="true">${CHEVRON_SVG}</span>
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
            <div class="task-item sb-running-header" data-task_id="${escapeHtml(task.task_id)}" data-depth="0">
                ${
                    recentlyCompleted
                        ? `<i class="sb-completed-dot${recentlyFailed ? ' is-failed' : ''}" aria-hidden="true"></i>`
                        : ''
                }
                <span class="sb-running-title">${escapeHtml(
                    task.task_name || this._t('renderer.sidebar.unnamedTask')
                )}</span>
                ${SideBar.buildWaitingTag(task.task_id, this._waitingTaskIds, isCurrentTask)}
                ${this._browserActiveTaskIds.has(task.task_id) ? '<i class="fas fa-globe sidebar-browser-icon"></i>' : ''}
                ${
                    recentlyCompleted
                        ? `<span class="sb-running-completed-status${recentlyFailed ? ' is-failed' : ''}">${this._t(
                              recentlyFailed ? 'renderer.sidebar.justFailed' : 'renderer.sidebar.justCompleted'
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
            data-task_id="${escapeHtml(task.task_id)}"
            data-parent_id="${escapeHtml(task.parent_id || '')}"
            data-depth="1"
            data-subtask-status="${status.key}"
            title="${escapeHtml(status.label)}"
        >
            <i class="sb-subtask-dot is-${status.key}" aria-hidden="true"></i>
            <span class="sb-subtask-name">${escapeHtml(
                task.task_name || this._t('renderer.sidebar.unnamedSubtask')
            )}</span>
            ${statusLabel ? `<span class="sb-subtask-status">${statusLabel}</span>` : ''}
        </div>`;
    }

    _workspaceGroupSummary(group, index) {
        const label = escapeHtml(this._taskGroupLabel(group));
        const workspace = group.workspace || '';
        const normalizedWorkspace = workspace.replace(/\\/g, '/');
        const pathSeparatorIndex = normalizedWorkspace.lastIndexOf('/');
        const pathPrefix =
            pathSeparatorIndex >= 0 ? normalizedWorkspace.slice(0, pathSeparatorIndex + 1) : normalizedWorkspace;
        const pathTail =
            pathSeparatorIndex >= 0 ? normalizedWorkspace.slice(pathSeparatorIndex + 1) : normalizedWorkspace;
        const initial = escapeHtml((group.label || this._t('renderer.sidebar.defaultWorkspace')).charAt(0));
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
                <span class="sb-workspace-path" title="${escapeHtml(
                    workspace || this._t('renderer.sidebar.defaultWorkspace')
                )}">
                    ${
                        workspace
                            ? `<span class="sb-workspace-path-prefix">${escapeHtml(
                                  pathPrefix
                              )}</span><span class="sb-workspace-path-tail">${escapeHtml(pathTail)}</span>`
                            : escapeHtml(this._t('renderer.sidebar.defaultWorkspace'))
                    }
                </span>
            </span>
            <span class="sb-group-count">${group.items.length}</span>
            <span class="sb-group-caret" aria-hidden="true">${CHEVRON_SVG}</span>`;
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
            : `${escapeHtml(this._taskGroupLabel(group))}
               <span class="sb-group-count">${group.items.length}</span>
               <span class="sb-group-caret" aria-hidden="true">${CHEVRON_SVG}</span>`;
        return `
        <details class="sb-task-group${isWorkspace ? ' is-workspace' : ''}" data-group-id="${escapeHtml(
            group.id
        )}"${this._openTaskGroupId === group.id ? ' open' : ''}>
            <summary>${summary}</summary>
            <div class="sb-task-group-body">
                ${taskRows}
                ${
                    hasMore
                        ? `<div class="sb-load-more" data-group-id="${escapeHtml(group.id)}">
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
        details.setAttribute('open', '');
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
            // 视图切换后选中集合跨口径残留，直接退出多选
            this._exitMultiSelect();
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
                this._exitMultiSelect();
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
        taskListContainer.classList.toggle('is-multi-select', this._multiSelect);

        let groups;
        let favoritesResults;
        let historyCount;

        if (this._favoritesView) {
            const favoritedTasks = filteredTasks.filter((t) => this._favoritedTaskIds.has(t.task_id));
            favoritesResults = buildSidebarFavoritesResults(favoritedTasks);
            historyCount = favoritesResults.length;
        } else {
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

        if (this._favoritesView) {
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
                        <span class="sb-view-menu-caret" aria-hidden="true">${CHEVRON_DOWN_SVG}</span>
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
                        <span class="sb-view-menu-caret" aria-hidden="true">${CHEVRON_DOWN_SVG}</span>
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
        this._updateChatBadge();
        // 多选态在重渲染后保持：行节点被重建，需重新标注选中行
        this._multiSelectController?.syncAfterRender();
        // 行是 innerHTML 重建的，把左滑展开态迁移到新节点，避免刷新把删除按钮收走；
        // 多选态下删除按钮被 CSS 隐藏且手势挂起，恢复展开只会留下错位行，直接丢弃
        if (!this._multiSelect) {
            this._swipeDeleteController?.restoreOpenRow();
        }
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
            'font-size:var(--fs-md); font-weight:inherit; background:transparent; border:1px solid var(--od-border); border-radius:4px; padding:1px 4px; outline:none; width:100%; min-width:0; color:inherit; font-family:inherit;';

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
