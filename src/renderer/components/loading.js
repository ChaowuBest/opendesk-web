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

import { escapeHtml } from '../../common/utils/escape.js';

class LoadingView extends HTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        this.render();
    }

    render() {
        this.innerHTML = `
        <div class="max-w-4xl mx-auto">
            <!-- 骨架屏内容 -->
            <div class="animate-pulse">
                <!-- 头部 -->
                <div class="h-8 bg-gray-300 rounded mb-6 w-1/3"></div>

                <!-- 卡片骨架 -->
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    <div class="bg-white p-6 rounded-lg shadow">
                        <div class="h-4 bg-gray-300 rounded mb-4"></div>
                        <div class="h-4 bg-gray-300 rounded mb-2 w-5/6"></div>
                        <div class="h-4 bg-gray-300 rounded w-4/6"></div>
                    </div>
                    <div class="bg-white p-6 rounded-lg shadow">
                        <div class="h-4 bg-gray-300 rounded mb-4"></div>
                        <div class="h-4 bg-gray-300 rounded mb-2 w-5/6"></div>
                        <div class="h-4 bg-gray-300 rounded w-4/6"></div>
                    </div>
                    <div class="bg-white p-6 rounded-lg shadow">
                        <div class="h-4 bg-gray-300 rounded mb-4"></div>
                        <div class="h-4 bg-gray-300 rounded mb-2 w-5/6"></div>
                        <div class="h-4 bg-gray-300 rounded w-4/6"></div>
                    </div>
                </div>
            </div>

            <!-- 加载提示 -->
            <div class="fixed bottom-6 right-6 bg-blue-500 text-white px-4 py-2 rounded-lg shadow-lg">
                <div class="flex items-center space-x-2">
                    <div class="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                    <span class="text-sm">加载中...</span>
                </div>
            </div>
        </div>
        `;
    }
}

class ContentLoadingView extends HTMLElement {
    // 宿主可能在元素插入之后才补上（或切换）本地化文案与布局，属性变化时重绘
    static get observedAttributes() {
        return ['data-type', 'data-message'];
    }

    connectedCallback() {
        this._connected = true;
        this.render();
    }

    disconnectedCallback() {
        this._connected = false;
    }

    attributeChangedCallback() {
        if (this._connected) this.render();
    }

    render() {
        const delays = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.4, 0.3, 0.2, 0.1];
        const bars = delays.map((d) => `<div class="od-clv-bar" style="animation-delay:${d}s"></div>`).join('');

        // 用 getAttribute 而不是 dataset：宿主可能在任何时刻设置属性，attributeChangedCallback
        // 重绘时要读到最新值，直接读属性最稳（不依赖 dataset 的反射同步）
        const message = this.getAttribute('data-message');
        const msg = message ? `<div class="od-clv-msg">${escapeHtml(message)}</div>` : '';

        const layout = (this.getAttribute('data-type') || 'tb') === 'lr' ? 'od-clv-lr' : 'od-clv-tb';

        this.innerHTML = `<style>${ContentLoadingView.STYLES}</style>
            <div class="od-clv-wrap ${layout}">
                <div class="od-clv-bars">${bars}</div>
                ${msg}
            </div>`;
    }
}

ContentLoadingView.STYLES = `
.od-clv-wrap {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
}
.od-clv-tb { flex-direction: column; gap: 20px; }
.od-clv-lr { flex-direction: row; gap: 24px; }
.od-clv-bars {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 40px;
}
.od-clv-bar {
    width: 4px;
    border-radius: 999px;
    background: var(--chat-accent, #e8563f);
    animation: od-clv-wave 1s ease-in-out infinite;
}
@keyframes od-clv-wave {
    0%, 100% { height: 8px; opacity: 0.5; }
    50% { height: 32px; opacity: 1; }
}
.od-clv-msg {
    font-size: 11px;
    color: var(--chat-ink3, #9b968f);
    letter-spacing: 0.15em;
    white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
    .od-clv-bar { animation-duration: 0.01ms; }
}
`;

customElements.define('loading-view', LoadingView);
customElements.define('content-loading-view', ContentLoadingView);
