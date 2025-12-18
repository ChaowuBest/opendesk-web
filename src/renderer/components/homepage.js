class HomePage extends HTMLElement {
    constructor() {
        super();

        /** @type {NodeJS.Timeout | null} */
        this.__search_timeout = null;
    }

    connectedCallback() {
        this.render();
        this.setUpEventListeners();
    }

    setUpEventListeners() {
        const agentInput = this.querySelector('#agent-input-main');
        const fileListView = this.querySelector('#home-file-list');

        agentInput.addEventListener('submit', async (event) => {
            const task = await window.taskManagerAPI.createTask();
            await window.taskManagerAPI.submitMessage(task, event.detail.message);
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
    }

    render() {
        this.innerHTML = `
        <!-- 主内容居中 -->
        <div class="w-full h-full px-8 flex flex-col items-center justify-center min-h-[80vh]">
            <!-- 问候语 -->
            <div class="mb-12 text-center">
                <h1 class="text-3xl font-medium text-gray-800 mb-2">
                    晚上好
                </h1>
            </div>

            <!-- 输入框区域 -->
            <div class="w-full max-w-4xl mb-8">
                <agent-input id="agent-input-main"></agent-input>
                <div class="w-full h-2"></div>
                <agent-files-view id="home-file-list"></agent-files-view>
            </div>

            <!-- 功能按钮区域 -->
            <div class="w-full max-w-4xl">
                <div class="flex flex-wrap justify-center gap-3">
                    <!-- 编程 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-white rounded-full shadow-sm hover:shadow-md border border-gray-200 transition-all">
                        <i class="fas fa-code text-orange-500 text-sm"></i>
                        <span class="text-sm text-gray-700">编程</span>
                    </button>

                    <!-- 图像生成 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-white rounded-full shadow-sm hover:shadow-md border border-gray-200 transition-all">
                        <i class="fas fa-image text-yellow-500 text-sm"></i>
                        <span class="text-sm text-gray-700">图像生成</span>
                    </button>

                    <!-- 帮我写作 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-white rounded-full shadow-sm hover:shadow-md border border-gray-200 transition-all">
                        <i class="fas fa-check text-green-500 text-sm"></i>
                        <span class="text-sm text-gray-700">帮我写作</span>
                    </button>

                    <!-- 视频生成 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-white rounded-full shadow-sm hover:shadow-md border border-gray-200 transition-all">
                        <i class="fas fa-play text-red-500 text-sm"></i>
                        <span class="text-sm text-gray-700">视频生成</span>
                    </button>

                    <!-- 翻译 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-white rounded-full shadow-sm hover:shadow-md border border-gray-200 transition-all">
                        <i class="fas fa-language text-purple-500 text-sm"></i>
                        <span class="text-sm text-gray-700">翻译</span>
                    </button>

                    <!-- 深入研究 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-white rounded-full shadow-sm hover:shadow-md border border-gray-200 transition-all">
                        <i class="fas fa-search text-blue-500 text-sm"></i>
                        <span class="text-sm text-gray-700">深入研究</span>
                    </button>

                    <!-- 更多 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-white rounded-full shadow-sm hover:shadow-md border border-gray-200 transition-all">
                        <i class="fas fa-th text-gray-500 text-sm"></i>
                        <span class="text-sm text-gray-700">更多</span>
                    </button>
                </div>
            </div>
        </div>
        `;
    }
}

customElements.define('home-page', HomePage);