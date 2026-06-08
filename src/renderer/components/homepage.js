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

import { showWorkspacePicker } from './workspacePicker.ts';

const HOME_SEARCH_DEBOUNCE_MS = 800;
const HOME_SEARCH_TOP_K = 50;
const HOME_SEARCH_FAST_ROUTES = ['keyword'];
const HOME_SEARCH_SLOW_ROUTES = ['name_semantic', 'content_semantic'];
const SEARCH_CODES = {
    INDEX_NOT_READY: 'INDEX_NOT_READY',
    EMBED_UNAVAILABLE: 'EMBED_UNAVAILABLE',
    SEMANTIC_PARTIAL: 'SEMANTIC_PARTIAL',
    SEARCH_FAILED: 'SEARCH_FAILED'
};
const SEARCH_WARNING_TEXT = {
    [SEARCH_CODES.INDEX_NOT_READY]: '文件搜索正在准备中',
    [SEARCH_CODES.EMBED_UNAVAILABLE]: '智能内容搜索未开启，当前只搜索文件名',
    [SEARCH_CODES.SEMANTIC_PARTIAL]: '部分智能内容搜索暂不可用，已显示可用结果',
    [SEARCH_CODES.SEARCH_FAILED]: '文件搜索暂不可用，请稍后重试'
};
const EMPTY_HOME_SEARCH_STATE = Object.freeze({
    enabled: false,
    query: '',
    results: [],
    warning: null,
    error: null
});
let homeSearchState = { ...EMPTY_HOME_SEARCH_STATE };

function normalizeSearchResultPath(item) {
    return String(item?.path ?? '')
        .replace(/\\/g, '/')
        .toLowerCase();
}

function mergeMatchTypes(primary = [], supplement = []) {
    const order = ['keyword', 'name_semantic', 'content_semantic'];
    const existing = new Set([...(primary ?? []), ...(supplement ?? [])]);
    return order.filter((type) => existing.has(type));
}

function mergeSearchResultItem(primary, supplement) {
    const primaryScore = typeof primary?.score === 'number' ? primary.score : 0;
    const supplementScore = typeof supplement?.score === 'number' ? supplement.score : 0;
    return {
        ...primary,
        matchTypes: mergeMatchTypes(primary?.matchTypes, supplement?.matchTypes),
        snippet: supplement?.snippet ?? primary?.snippet ?? null,
        score: Math.max(primaryScore, supplementScore)
    };
}

function mergeHomepageSearchStages(fastResults, slowResults, limit) {
    const fast = Array.isArray(fastResults) ? fastResults : [];
    const slow = Array.isArray(slowResults) ? slowResults : [];
    const slowByPath = new Map(slow.map((item) => [normalizeSearchResultPath(item), item]));
    const seen = new Set();
    const merged = [];

    for (const item of fast) {
        const key = normalizeSearchResultPath(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(slowByPath.has(key) ? mergeSearchResultItem(item, slowByPath.get(key)) : item);
        if (merged.length >= limit) return merged;
    }

    for (const item of slow) {
        const key = normalizeSearchResultPath(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
        if (merged.length >= limit) break;
    }

    return merged;
}

class HomePage extends HTMLElement {
    constructor() {
        super();

        /** @type {NodeJS.Timeout | null} */
        this.__search_timeout = null;
        this.__searchMode = false;
        this.__searchRequestId = 0;
        this.__lastSearchResults = [];
        this.unreadCount = 0;
    }

    connectedCallback() {
        this.render();
        this.setUpEventListeners();
        if (homeSearchState.enabled) {
            this._setSearchMode(true);
        }
        this.subscribeToUnreadCounts();
    }

    disconnectedCallback() {
        // 清理订阅
        if (this.unreadCountsUnsubscribe) {
            this.unreadCountsUnsubscribe();
        }
        if (this.__search_timeout) {
            clearTimeout(this.__search_timeout);
            this.__search_timeout = null;
        }
    }

    async subscribeToUnreadCounts() {
        try {
            await window.applicationRegistryAPI.subscribeEvent('mailbox', 'newEmailCountsUpdated', (counts) => {
                this.updateNewEmailCount(counts);
            });
            // 初始加载新邮件数量
            try {
                const counts = await window.applicationRegistryAPI.call('mailbox', 'getAllNewEmailCounts');
                this.updateNewEmailCount(counts);
            } catch (error) {
                console.error('Failed to get initial new email counts:', error);
            }
        } catch (error) {
            console.error('Failed to subscribe to new email counts:', error);
        }
    }

    updateNewEmailCount(counts) {
        // 计算总新邮件数量
        const total = Object.values(counts || {}).reduce((sum, count) => sum + (count || 0), 0);
        this.unreadCount = total;
        this.updateBadge();
    }

    updateBadge() {
        const inboxButton = this.querySelector('[onclick*="mailbox"]');
        if (!inboxButton) return;

        // 移除现有的标记
        const existingBadge = inboxButton.querySelector('.unread-badge');
        if (existingBadge) {
            existingBadge.remove();
        }

        // 如果有未读邮件，添加标记
        if (this.unreadCount > 0) {
            const badge = document.createElement('span');
            badge.className =
                'unread-badge absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1';
            badge.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount.toString();
            inboxButton.style.position = 'relative';
            inboxButton.appendChild(badge);
        }
    }

    setUpEventListeners() {
        const agentInput = this.querySelector('#agent-input-main');
        const recommendation = this.querySelector('#home-recommendation');

        recommendation?.addEventListener('select', (event) => {
            const { item } = event.detail;
            if (item?.prompt) {
                const textarea = agentInput?.querySelector('#agent-input-textarea');
                if (textarea) {
                    textarea.value = item.prompt;
                    textarea.focus();
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        });

        agentInput.addEventListener('submit', async (event) => {
            if (this.__searchMode) {
                return;
            }

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

            const task = await window.taskManagerAPI.createTask();
            await window.taskManagerAPI.submitMessage(task, event.detail);
            window.globalControlAPI.openTask(task);
        });
        agentInput.addEventListener('contentChanged', (event) => {
            if (!this.__searchMode) return;
            this._scheduleHomepageSearch(event.detail.value);
        });
        agentInput.addEventListener('searchModeChanged', (event) => {
            this._setSearchMode(Boolean(event.detail?.enabled), { useCurrentInput: Boolean(event.detail?.enabled) });
        });
        recommendation?.addEventListener('homepage-search-open', (event) => {
            const filePath = event.detail?.path;
            if (filePath) window.fsAPI?.openPath?.(filePath)?.catch?.(() => {});
        });
        recommendation?.addEventListener('homepage-search-reveal', (event) => {
            const filePath = event.detail?.path;
            if (filePath) window.fsAPI?.openPath?.(this._parentOf(filePath))?.catch?.(() => {});
        });
    }

    _setSearchMode(enabled, options = {}) {
        const recommendation = this.querySelector('#home-recommendation');
        const agentInput = this.querySelector('#agent-input-main');
        this.__searchMode = Boolean(enabled);
        if (this.__search_timeout) {
            clearTimeout(this.__search_timeout);
            this.__search_timeout = null;
        }
        this.__searchRequestId += 1;

        if (agentInput?.isSearchMode?.() !== this.__searchMode) {
            agentInput?.setSearchMode?.(this.__searchMode);
        }

        if (this.__searchMode) {
            homeSearchState = { ...homeSearchState, enabled: true };
            this.__lastSearchResults = Array.isArray(homeSearchState.results) ? homeSearchState.results : [];
            recommendation?.showSearchTab?.({
                query: homeSearchState.query,
                results: this.__lastSearchResults,
                loading: false,
                warning: homeSearchState.warning,
                error: homeSearchState.error
            });
            if (options.useCurrentInput) {
                this._scheduleHomepageSearch(agentInput?.getCurrentText?.() ?? '');
            }
            return;
        }

        this.__lastSearchResults = [];
        homeSearchState = { ...EMPTY_HOME_SEARCH_STATE };
        recommendation?.hideSearchTab?.();
        agentInput?.clearInput?.();
    }

    _scheduleHomepageSearch(query) {
        if (this.__search_timeout) {
            clearTimeout(this.__search_timeout);
            this.__search_timeout = null;
        }

        const trimmed = String(query ?? '').trim();
        const recommendation = this.querySelector('#home-recommendation');
        if (trimmed === '') {
            this.__searchRequestId += 1;
            this.__lastSearchResults = [];
            homeSearchState = {
                ...homeSearchState,
                query: '',
                results: [],
                warning: null,
                error: null
            };
            recommendation?.updateSearchTab?.({ query: '', results: [], loading: false, warning: null, error: null });
            return;
        }

        const requestId = this.__searchRequestId + 1;
        this.__searchRequestId = requestId;
        homeSearchState = {
            ...homeSearchState,
            query: trimmed,
            error: null
        };
        recommendation?.updateSearchTab?.({
            query: trimmed,
            results: this.__lastSearchResults,
            loading: true,
            warning: null,
            error: null
        });
        this.__search_timeout = setTimeout(() => {
            this._runHomepageSearch(trimmed, requestId);
        }, HOME_SEARCH_DEBOUNCE_MS);
    }

    async _runHomepageSearch(query, requestId) {
        const recommendation = this.querySelector('#home-recommendation');
        let fastWarning = null;
        let fastResults = [];
        try {
            const result = await window.fsAPI.searchIndexedFiles(query, {
                topK: HOME_SEARCH_TOP_K,
                routes: HOME_SEARCH_FAST_ROUTES
            });
            if (!this.__searchMode || requestId !== this.__searchRequestId) return;
            fastResults = Array.isArray(result?.results) ? result.results : [];
            this.__lastSearchResults = fastResults;
            fastWarning = this._mapSearchWarning(result);
            homeSearchState = {
                ...homeSearchState,
                query,
                results: fastResults,
                warning: fastWarning,
                error: null
            };
            recommendation?.updateSearchTab?.({
                query,
                results: fastResults,
                loading: true,
                loadingText: '正在搜索文件内容...',
                warning: fastWarning,
                error: null
            });
        } catch {
            if (!this.__searchMode || requestId !== this.__searchRequestId) return;
            homeSearchState = {
                ...homeSearchState,
                query,
                results: this.__lastSearchResults,
                warning: null,
                error: '文件搜索暂不可用，请稍后重试'
            };
            recommendation?.updateSearchTab?.({
                query,
                results: this.__lastSearchResults,
                loading: false,
                warning: null,
                error: '文件搜索暂不可用，请稍后重试'
            });
            return;
        }

        try {
            const result = await window.fsAPI.searchIndexedFiles(query, {
                topK: HOME_SEARCH_TOP_K,
                routes: HOME_SEARCH_SLOW_ROUTES
            });
            if (!this.__searchMode || requestId !== this.__searchRequestId) return;
            const slowResults = Array.isArray(result?.results) ? result.results : [];
            const results = mergeHomepageSearchStages(fastResults, slowResults, HOME_SEARCH_TOP_K);
            const warning = this._mapSearchWarning(result) ?? fastWarning;
            this.__lastSearchResults = results;
            homeSearchState = {
                ...homeSearchState,
                query,
                results,
                warning,
                error: null
            };
            recommendation?.updateSearchTab?.({
                query,
                results,
                loading: false,
                warning,
                error: null
            });
        } catch {
            if (!this.__searchMode || requestId !== this.__searchRequestId) return;
            const warning = SEARCH_WARNING_TEXT[SEARCH_CODES.SEMANTIC_PARTIAL] ?? fastWarning;
            homeSearchState = {
                ...homeSearchState,
                query,
                results: this.__lastSearchResults,
                warning,
                error: null
            };
            recommendation?.updateSearchTab?.({
                query,
                results: this.__lastSearchResults,
                loading: false,
                warning,
                error: null
            });
        }
    }

    _mapSearchWarning(result) {
        const code = result?.code;
        if (code && SEARCH_WARNING_TEXT[code]) return SEARCH_WARNING_TEXT[code];
        return null;
    }

    _parentOf(filePath) {
        const value = String(filePath ?? '');
        const slash = value.lastIndexOf('/');
        const backslash = value.lastIndexOf('\\');
        const index = Math.max(slash, backslash);
        if (index === 2 && /^[A-Za-z]:\\/.test(value)) return value.slice(0, 3);
        if (index === 0) return value[0] === '/' ? '/' : value;
        return index < 0 ? value : value.slice(0, index);
    }

    render() {
        const greeting = this._getGreeting();
        this.innerHTML = `
        <!-- 主内容居中 -->
        <div class="w-full h-full px-8 flex flex-col items-center justify-center min-h-[80vh]">
            <!-- 问候语 -->
            <div class="mb-4 text-center">
                <h1 class="text-3xl font-medium text-gray-800 mb-3">
                    ${greeting}
                </h1>
                <button id="hp-workspace-bar" class="hp-workspace-bar" title="点击切换工作空间">
                    <i class="fa-solid fa-briefcase"></i>
                    <span style="font-size:11px;color:#6b7280;white-space:nowrap;flex-shrink:0;">当前工作空间</span>
                    <span id="hp-workspace-path" class="hp-workspace-path">加载中...</span>
                    <i class="fa-solid fa-chevron-down hp-workspace-switch"></i>
                </button>
            </div>

            <!-- 输入框区域 -->
            <div class="w-full max-w-4xl mb-4">
                <agent-input id="agent-input-main" hide-disclaimer></agent-input>
            </div>

            <!-- 推荐场景 -->
            <div class="w-full max-w-4xl">
                <recommendation-panel id="home-recommendation"></recommendation-panel>
            </div>
        </div>
        `;
        this._initWorkspaceBar();
    }

    _getGreeting() {
        const hour = new Date().getHours();
        if (hour < 6) return '夜深了';
        if (hour < 12) return '早上好';
        if (hour < 14) return '中午好';
        if (hour < 18) return '下午好';
        return '晚上好';
    }

    async _initWorkspaceBar() {
        try {
            const workspacePath = await window.workspaceAPI.getEffectiveWorkspace();
            const pathLabel = this.querySelector('#hp-workspace-path');
            if (pathLabel) {
                pathLabel.textContent = workspacePath;
                pathLabel.title = workspacePath;
            }
        } catch (error) {
            console.error('Failed to get workspace path:', error);
        }

        const wsBar = this.querySelector('#hp-workspace-bar');
        if (wsBar) {
            wsBar.addEventListener('click', async () => {
                const selected = await showWorkspacePicker();
                if (selected) {
                    await window.workspaceAPI.setWorkspaceDirectory(selected);
                    const pathLabel = this.querySelector('#hp-workspace-path');
                    if (pathLabel) {
                        pathLabel.textContent = selected;
                        pathLabel.title = selected;
                    }
                    document.dispatchEvent(new CustomEvent('workspace-changed'));
                }
            });
        }
    }
}

customElements.define('home-page', HomePage);
