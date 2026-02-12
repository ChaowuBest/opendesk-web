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
        `
    }
}

class ContentLoadingView extends HTMLElement {
    constructor() {
        super();
        this.type = this.dataset.type || 'tb'
    }

    connectedCallback() {
        this.render();
    }

    render() {
        const animationHTML = `
        <div class="flex items-end space-x-2 h-12">
            <!-- 每一根线条都有不同的延迟 -->
            <div class="w-2 bg-blue-500 rounded-full animate-[bounce_1s_ease-in-out_infinite] h-8"></div>
            <div class="w-2 bg-indigo-500 rounded-full animate-[bounce_1s_ease-in-out_infinite_0.1s] h-12"></div>
            <div class="w-2 bg-purple-500 rounded-full animate-[bounce_1s_ease-in-out_infinite_0.2s] h-10"></div>
            <div class="w-2 bg-pink-500 rounded-full animate-[bounce_1s_ease-in-out_infinite_0.3s] h-6"></div>
            <div class="w-2 bg-red-500 rounded-full animate-[bounce_1s_ease-in-out_infinite_0.4s] h-9"></div>
            <div class="w-2 bg-orange-500 rounded-full animate-[bounce_1s_ease-in-out_infinite_0.5s] h-12"></div>
        </div>
        `;

        if (this.type === 'tb') {
            this.innerHTML = `
            <div class="w-full h-full flex items-center justify-center">
                <div class="flex flex-col items-center justify-center w-full h-48 bg-transparent">
                    ${animationHTML}
                    <div class="mt-6 text-gray-400 text-sm font-light uppercase tracking-[0.3em]">${this.dataset.message}</div>
                </div>
            </div>
            `
        } else if (this.type === 'lr') {
            this.innerHTML = `
            <div class="w-full h-full flex items-center justify-center">
                <div class="flex items-center justify-center w-full h-32 bg-transparent">
                    ${animationHTML}
                    <div class="ml-6 text-gray-400 text-sm font-light uppercase tracking-[0.3em]">${this.dataset.message}</div>
                </div>
            </div>
            `
        }
    }
}

customElements.define('loading-view', LoadingView);
customElements.define('content-loading-view', ContentLoadingView);