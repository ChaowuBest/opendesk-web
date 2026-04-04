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
 * Recall 入口组件
 * 路由选择：根据 query 参数切换录制页 vs 浏览页
 */
class RecallEntryWidget extends HTMLElement {
    constructor() {
        super();
        /** @type {'recording' | 'browser'} */
        this.currentPage = 'recording';
    }

    connectedCallback() {
        this.getCurrentPage();
        this.render();
        this.startStatusCheck();
    }

    disconnectedCallback() {
        if (this.statusCheckInterval) {
            clearInterval(this.statusCheckInterval);
        }
    }

    async startStatusCheck() {
        // 定时检查录制状态并更新按钮样式
        const checkStatus = async () => {
            try {
                const status = await window.applicationAPI.call('getRecallStatus');
                const statusIcon = this.querySelector('#recording-status-icon');
                const statusCircle = statusIcon?.querySelector('circle');
                if (statusIcon && statusCircle) {
                    if (status.status === 'recording') {
                        statusCircle.setAttribute('fill', '#ef4444'); // red-500
                        statusIcon.classList.add('animate-pulse');
                    } else {
                        statusCircle.setAttribute('fill', '#9ca3af'); // gray-400
                        statusIcon.classList.remove('animate-pulse');
                    }
                }
            } catch (error) {
                console.error('Failed to check recall status:', error);
            }
        };

        checkStatus();
        this.statusCheckInterval = setInterval(checkStatus, 2000);
    }

    getCurrentPage() {
        this.currentPage = localStorage.getItem('recall_page') || 'recording';
    }

    switchPage(page) {
        this.currentPage = page;
        localStorage.setItem('recall_page', page);
        this.render();
    }

    render() {
        this.innerHTML = `
            <div class="flex flex-col h-full">
                <!-- 顶部图标选择栏 -->
                <div class="flex gap-2 p-3 bg-gray-100 border-b border-gray-200">
                    <button id="btn-recording" 
                            class="flex items-center justify-center gap-2 px-4 py-2 rounded-lg transition-all ${this.currentPage === 'recording' ? 'bg-blue-500 text-white' : 'bg-white text-gray-700 hover:bg-gray-200'}"
                            onclick="document.querySelector('recall-entry-widget').switchPage('recording')">
                        <svg id="recording-status-icon" class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="8" fill="#9ca3af"/>
                        </svg>
                        <span class="font-medium">实时捕获</span>
                    </button>
                    <button id="btn-browser" 
                            class="flex items-center justify-center gap-2 px-4 py-2 rounded-lg transition-all ${this.currentPage === 'browser' ? 'bg-blue-500 text-white' : 'bg-white text-gray-700 hover:bg-gray-200'}"
                            onclick="document.querySelector('recall-entry-widget').switchPage('browser')">
                        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <rect x="2" y="4" width="20" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>
                            <path d="M2 8h20" stroke="currentColor" stroke-width="2"/>
                        </svg>
                        <span class="font-medium">活动回顾</span>
                    </button>
                </div>
                <!-- 内容区域 -->
                <div class="flex-1 overflow-auto">
                    ${this.currentPage === 'browser' ? '<recall-browser-page></recall-browser-page>' : '<recall-recording-page></recall-recording-page>'}
                </div>
            </div>
        `;
    }
}

customElements.define('recall-entry-widget', RecallEntryWidget);
