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

class HomePage extends HTMLElement {
    constructor() {
        super();

        /** @type {NodeJS.Timeout | null} */
        this.__search_timeout = null;
        this.unreadCount = 0;
    }

    connectedCallback() {
        this.render();
        this.setUpEventListeners();
        this.subscribeToUnreadCounts();
    }

    disconnectedCallback() {
        // 清理订阅
        if (this.unreadCountsUnsubscribe) {
            this.unreadCountsUnsubscribe();
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
        const fileListView = this.querySelector('#home-file-list');
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
            if (this.__search_timeout) {
                clearTimeout(this.__search_timeout);
                this.__search_timeout = null;
            }
            if (event.detail.value.trim() === '') {
                fileListView.clearSearchResults();
                return;
            }
            this.__search_timeout = setTimeout(() => {
                fileListView.startSearch(event.detail.value);
            }, 800);
        });
        fileListView.addEventListener('addFileToSession', (event) => {
            const file_path = event.detail.file_path;
            agentInput.attachFilePath(file_path);
        });
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
                <div class="w-full h-2"></div>
                <agent-files-view id="home-file-list"></agent-files-view>
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
