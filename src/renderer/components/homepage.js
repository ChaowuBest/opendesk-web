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

                    <!-- 收件箱 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-white rounded-full shadow-sm hover:shadow-md border border-gray-200 transition-all"
                        onclick="window.globalControlAPI.openApplication('mailbox')">
                        <i class="fas fa-inbox text-indigo-500 text-sm"></i>
                        <span class="text-sm text-gray-700">收件箱</span>
                    </button>

                    <!-- 新闻快讯 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-white rounded-full shadow-sm hover:shadow-md border border-gray-200 transition-all"
                        onclick="window.globalControlAPI.openApplication('news')">
                        <i class="fas fa-newspaper text-blue-500 text-sm"></i>
                        <span class="text-sm text-gray-700">即时新闻</span>
                    </button>

                    <!-- 快速记录 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-white rounded-full shadow-sm hover:shadow-md border border-gray-200 transition-all"
                        onclick="window.globalControlAPI.openApplication('recall')">
                        <i class="fas fa-video text-red-500 text-sm"></i>
                        <span class="text-sm text-gray-700">快速记录</span>
                    </button>

                    <!-- A2A -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-white rounded-full shadow-sm hover:shadow-md border border-gray-200 transition-all"
                        onclick="window.globalControlAPI.openApplication('a2a')">
                        <i class="fas fa-comments text-purple-500 text-sm"></i>
                        <span class="text-sm text-gray-700">A2A</span>
                    </button>

                    <!-- 同步 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-white rounded-full shadow-sm hover:shadow-md border border-gray-200 transition-all"
                        onclick="window.globalControlAPI.openApplication('synchronizer')">
                        <i class="fas fa-sync text-green-500 text-sm"></i>
                        <span class="text-sm text-gray-700">同步</span>
                    </button>

                    <!-- 编程 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-gray-100 rounded-full shadow-none border border-gray-100 cursor-not-allowed opacity-50" disabled>
                        <i class="fas fa-code text-orange-300 text-sm"></i>
                        <span class="text-sm text-gray-400">编程</span>
                    </button>

                    <!-- 图像生成 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-gray-100 rounded-full shadow-none border border-gray-100 cursor-not-allowed opacity-50" disabled>
                        <i class="fas fa-image text-yellow-300 text-sm"></i>
                        <span class="text-sm text-gray-400">图像生成</span>
                    </button>

                    <!-- 帮我写作 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-gray-100 rounded-full shadow-none border border-gray-100 cursor-not-allowed opacity-50" disabled>
                        <i class="fas fa-check text-green-300 text-sm"></i>
                        <span class="text-sm text-gray-400">帮我写作</span>
                    </button>

                    <!-- 深入研究 -->
                    <button class="flex items-center space-x-2 px-3 py-2 bg-gray-100 rounded-full shadow-none border border-gray-100 cursor-not-allowed opacity-50" disabled>
                        <i class="fas fa-search text-blue-300 text-sm"></i>
                        <span class="text-sm text-gray-400">深入研究</span>
                    </button>

                </div>
            </div>
        </div>
        `;
    }
}

customElements.define('home-page', HomePage);
