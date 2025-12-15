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

customElements.define('loading-view', LoadingView);