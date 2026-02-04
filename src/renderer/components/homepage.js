const SYSTEM_PROMPT = () => `
你是一个有用的助手，请根据用户的问题给出回答。你被赋予了丰富的工具来帮用户解决问题，
你可以自由使用它们。

## 补充信息
- 现在的日期和时间：${new Date().toLocaleString()}
- 当用户提到“文件”的时候，这通常是指本地AI文件系统中的文件，而不是互联网上的文件
- 不要过度使用搜索类工具
`;

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
            badge.className = 'unread-badge absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1';
            badge.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount.toString();
            inboxButton.style.position = 'relative';
            inboxButton.appendChild(badge);
        }
    }

    setUpEventListeners() {
        const agentInput = this.querySelector('#agent-input-main');
        const fileListView = this.querySelector('#home-file-list');

        agentInput.addEventListener('submit', async (event) => {
            const task = await window.taskManagerAPI.createTask();
            await window.taskManagerAPI.setSystemPrompt(task, SYSTEM_PROMPT());
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
                    <button class="flex items-center space-x-2 px-3 py-2 bg-white rounded-full shadow-sm hover:shadow-md border border-gray-200 transition-all relative"
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
