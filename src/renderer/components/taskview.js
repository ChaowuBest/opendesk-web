class TaskView extends HTMLElement {
    constructor() {
        super();

        const task_id = this.getAttribute('task_id')
        if (task_id === null) {
            throw new Error('task_id is required');
        }

        /**
         * The task id to load in this task view
         * @type {string}
         */
        this.task_id = task_id;
        /**
         * The widget id to identify this widget
         * @type {string}
         */
        this.widget_id = crypto.randomUUID();
        /**
         * The history container to display the chat history
         * @type {HTMLDivElement | null}
         */
        this.history_container = null;
        /**
         * The subscription id for task update
         * @type {string | null}
         */
        this.subscription_id = null;
        /**
         * Whether to auto scroll to bottom when new messages are added
         * @type {boolean}
         */
        this.auto_scrolling_to_bottom = true;
    }

    setAutoScrollingToBottom(auto_scrolling_to_bottom) {
        this.auto_scrolling_to_bottom = auto_scrolling_to_bottom;
        const scrollButton = this.querySelector('#taskview-scroll-to-bottom-button');
        if (auto_scrolling_to_bottom) {
            scrollButton.classList.add('hidden');
        } else {
            scrollButton.classList.remove('hidden');
        }
    }

    getHistoryContainer() {
        if (this.history_container === null) {
            this.history_container = this.querySelector('#taskview-chat-history');
        }
        return this.history_container;
    }

    renderUserMessage(user_message) {
        var content = "";
        var hasTextPart = false;
        for (let part of user_message.content) {
            content += `<div class="${TaskView.USER_PART_CLASS_MAP[part.type]}">${part.rendered}</div>`;
            if (part.type === 'text') {
                hasTextPart = true;
            }
        }
        if (hasTextPart) {
            return `
            <div class="flex items-start space-x-3 flex-row-reverse">
                <div class="bg-white text-gray-900 rounded-2xl px-4 py-2 shadow-md max-w-3xl border border-gray-200" style="backdrop-filter: blur(8px);">
                    ${content}
                    <!-- <span class="text-xs text-gray-500 mt-1 block">10:31</span> -->
                </div>
            </div>
            `
        } else {
            return `
            <div class="flex items-start space-x-3 flex-row-reverse">
                ${content}
            </div>
            `
        }
    }

    static USER_PART_CLASS_MAP = {
        'text': 'bg-transparent text-base text-black markdown-body'
    }

    static ASSISTANT_PART_CLASS_MAP = {
        'text': 'bg-transparent text-base text-black markdown-body',
        'reasoning': 'bg-gray-200 rounded-xl text-gray-500 text-xs p-3 mb-3',
        'tool_call': ''
    }

    renderAssistantMessage(assistant_message) {
        var content = "";
        for (let part of assistant_message.content) {
            content += `<div class="${TaskView.ASSISTANT_PART_CLASS_MAP[part.type]}">${part.rendered}</div>`;
        }
        var html = `
        <div class="flex items-start space-x-3">
            <div id='message-container-${assistant_message.message_id}' class="p-3 bg-transparent w-full">
                <div id='message-content-${assistant_message.message_id}'>
                    ${content}
                </div>
                <span
                    class="message-usage text-xs text-gray-500 mt-2 block"
                    title="${assistant_message.usage ? `输入: ${assistant_message.usage.prompt_tokens}, 输出: ${assistant_message.usage.completion_tokens}, 总计: ${assistant_message.usage.total_tokens}` : ''}"
                >
                    已输出 ${assistant_message.usage ? assistant_message.usage.completion_tokens : 0} 词,
                    总计 ${assistant_message.usage ? assistant_message.usage.total_tokens : 0} 词
                </span>
            </div>
        </div>
        `
        return html
    }

    tryScrollToEnd() {
        if (!this.auto_scrolling_to_bottom) { return; }
        const domElement = this.getHistoryContainer();
        setTimeout(() => {
            if (!this.auto_scrolling_to_bottom) { return; }
            domElement.scroll({
                top: domElement.scrollHeight,
                behavior: 'smooth'
            })
        }, 100)
    }

    async reload() {
        var task_state = await window.taskManagerAPI.getFullTask(this.task_id);
        var history_container = this.getHistoryContainer();
        history_container.innerHTML = '';
        for (const message of task_state.chat_context.messages) {
            if (message.role === 'user') {
                history_container.innerHTML += this.renderUserMessage(message);
            } else if (message.role === 'assistant') {
                history_container.innerHTML += this.renderAssistantMessage(message);
            }
            this.tryScrollToEnd()
        }
    }

    connectedCallback() {
        this.render();
        this.setUpEventListeners();
        this.reload().then(async () => {
            this.subscription_id = await window.taskManagerAPI.subscribeTaskUpdate(this.task_id, progress => {
                const message_container = this.querySelector(`#message-container-${progress.message_id}`);
                const message_content = message_container.querySelector(`#message-content-${progress.message_id}`);
                if (message_content.children.length <= progress.last_part_index) {
                    message_content.innerHTML += `<div class='${TaskView.ASSISTANT_PART_CLASS_MAP[progress.last_part.type]}'></div>`
                }
                const last_part_element = message_content.children[progress.last_part_index];
                last_part_element.innerHTML = progress.last_part.rendered;
                if (progress.usage) {
                    message_container.querySelector('.message-usage').title = `输入: ${progress.usage.prompt_tokens}, 输出: ${progress.usage.completion_tokens}, 总计: ${progress.usage.total_tokens}`;
                    message_container.querySelector('.message-usage').innerHTML = `
                    已输出 ${progress.usage.completion_tokens} 词,
                    总计 ${progress.usage.total_tokens} 词
                    `;
                }
                this.tryScrollToEnd()
            })
        })
    }

    disconnectedCallback() {
        window.taskManagerAPI.unsubscribeTaskUpdate(this.task_id, this.subscription_id);
        this.subscription_id = null;
    }

    render() {
        this.innerHTML = `
        <div class="bg-gray-30 h-full flex flex-col">
            <header class="w-full px-4 py-3 flex justify-center items-center text-center">
                <div class="inline-block rounded-full bg-white px-5 py-2 shadow font-semibold text-gray-800 text-sm">智能体对话</div>
            </header>

            <div class="relative flex-1 overflow-y-auto">
                <!-- 对话历史区域 - 可滚动 -->
                <div id="taskview-chat-history" class="w-full h-full space-y-4 overflow-y-auto px-4">
                </div>
                <!-- 滚动到底部按钮, 按需显示 -->
                <button
                    id="taskview-scroll-to-bottom-button"
                    class="absolute bottom-3 right-8 flex items-center justify-center px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow transition-all focus:outline-none active:scale-95 text-xs hidden"
                    style="min-width: unset; height: 2rem;"
                    title="滚动到底部"
                >
                    <i class="fas fa-arrow-down text-sm"></i>
                    <span class="ml-1">滚动到底部</span>
                </button>
            </div>

            <!-- 输入区域 -->
            <div class="p-4">
                <agent-input id="task-${this.task_id}-input" />
            </div>
        </div>
        `
    }

    setUpEventListeners() {
        // 为输入框添加事件监听器
        const input_widget = this.querySelector(`#task-${this.task_id}-input`)
        input_widget.addEventListener('submit', async (event) => {
            await window.taskManagerAPI.submitMessage(this.task_id, event.detail)
            await this.reload()
        })
        const chatHistory = this.querySelector('#taskview-chat-history');
        chatHistory.addEventListener('scroll', (event) => {
            const scrollBottom = chatHistory.scrollTop + chatHistory.clientHeight;
            const distanceToBottom = Math.abs(chatHistory.scrollHeight - scrollBottom);
            this.setAutoScrollingToBottom(distanceToBottom < 50);
        })
        const scrollButton = this.querySelector('#taskview-scroll-to-bottom-button');
        scrollButton.addEventListener('click', () => {
            this.setAutoScrollingToBottom(true);
            this.tryScrollToEnd();
        })
    }
}

class EmbeddedTaskView extends HTMLElement {

    constructor() {
        super();

        const task_id = this.getAttribute('task_id')
        if (task_id === null) {
            throw new Error('task_id is required');
        }

        /**
         * The task id to load in this task view
         * @type {string}
         */
        this.task_id = task_id;
        /**
         * The widget id to identify this widget
         * @type {string}
         */
        this.widget_id = crypto.randomUUID();
        /**
         * The history container to display the chat history
         * @type {HTMLDivElement | null}
         */
        this.history_container = null;
        /**
         * The subscription id for task update
         * @type {string | null}
         */
        this.subscription_id = null;
        /**
         * Whether to auto scroll to bottom when new messages are added
         * @type {boolean}
         */
        this.auto_scrolling_to_bottom = true;
    }

    getHistoryContainer() {
        if (this.history_container === null) {
            this.history_container = this.querySelector('#taskview-chat-history');
        }
        return this.history_container;
    }

    renderUserMessage(user_message) {
        if (user_message.content.length === 0) {
            return '';
        }

        var content = "";
        var hasTextPart = false;
        for (let part of user_message.content) {
            content += `<div class="${EmbeddedTaskView.USER_PART_CLASS_MAP[part.type]}">${part.rendered}</div>`;
            if (part.type === 'text') {
                hasTextPart = true;
            }
        }
        if (hasTextPart) {
            return `
            <div class="flex items-start space-x-3 flex-row-reverse">
                <div class="bg-white text-gray-900 rounded-2xl px-3 py-1 shadow-md max-w-3xl border border-gray-200" style="backdrop-filter: blur(8px);">
                    ${content}
                </div>
            </div>
            `
        } else {
            return `
            <div class="flex items-start space-x-3 flex-row-reverse">
                ${content}
            </div>
            `
        }
    }

    static USER_PART_CLASS_MAP = {
        'text': 'bg-transparent text-sm text-black markdown-body'
    }

    static ASSISTANT_PART_CLASS_MAP = {
        'text': 'bg-transparent text-sm text-black markdown-body',
        'reasoning': 'bg-gray-200 rounded-xl text-gray-500 text-xs p-3 mb-1',
        'tool_call': ''
    }

    renderAssistantMessage(assistant_message) {
        var content = "";
        for (let part of assistant_message.content) {
            content += `<div class="${EmbeddedTaskView.ASSISTANT_PART_CLASS_MAP[part.type]}">${part.rendered}</div>`;
        }
        var html = `
        <div class="flex items-start space-x-3">
            <div class="p-3 bg-transparent w-full">
                <div id='message-${assistant_message.message_id}'>
                    ${content}
                </div>
            </div>
        </div>
        `
        return html
    }

    tryScrollToEnd() {
        const domElement = this.getHistoryContainer();
        setTimeout(() => {
            if (!this.auto_scrolling_to_bottom) { return; }
            domElement.scroll({
                top: domElement.scrollHeight,
                behavior: 'smooth'
            })
        }, 100)
    }

    async reload() {
        var task_state = await window.taskManagerAPI.getFullTask(this.task_id);
        var history_container = this.getHistoryContainer();
        history_container.innerHTML = '';
        for (const message of task_state.chat_context.messages) {
            if (message.role === 'user') {
                history_container.innerHTML += this.renderUserMessage(message);
            } else if (message.role === 'assistant') {
                history_container.innerHTML += this.renderAssistantMessage(message);
            }
            this.tryScrollToEnd()
        }
    }

    connectedCallback() {
        this.render();
        this.reload().then(async () => {
            this.subscription_id = await window.taskManagerAPI.subscribeTaskUpdate(this.task_id, progress => {
                const message_element = this.querySelector(`#message-${progress.message_id}`);
                if (message_element.children.length <= progress.last_part_index) {
                    message_element.innerHTML += `<div class='${EmbeddedTaskView.ASSISTANT_PART_CLASS_MAP[progress.last_part.type]}'></div>`
                }
                const last_part_element = message_element.children[progress.last_part_index];
                last_part_element.innerHTML = progress.last_part.rendered;
                this.tryScrollToEnd()
            })
        })
    }

    disconnectedCallback() {
        window.taskManagerAPI.unsubscribeTaskUpdate(this.task_id, this.subscription_id);
        this.subscription_id = null;
    }

    setAutoScrollingToBottom(auto_scrolling_to_bottom) {
        this.auto_scrolling_to_bottom = auto_scrolling_to_bottom;
        const scrollButton = this.querySelector('#taskview-scroll-to-bottom-button');
        if (auto_scrolling_to_bottom) {
            scrollButton.classList.add('hidden');
        } else {
            scrollButton.classList.remove('hidden');
        }
    }

    render() {
        this.innerHTML = `
        <div class="bg-gray-30 h-full flex flex-col">
            <div class="flex-1 overflow-y-auto p-4 space-y-1" id="taskview-chat-history"></div>

            <!-- 滚动到底部按钮, 按需显示 -->
            <button
                id="taskview-scroll-to-bottom-button"
                class="absolute bottom-20 left-1/2 -translate-x-1/2 flex items-center justify-center px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow transition-all focus:outline-none active:scale-95 text-xs hidden"
                style="min-width: unset; height: 2rem;"
                title="滚动到底部"
            >
                <i class="fas fa-arrow-down text-sm"></i>
                <span class="ml-1">滚动到底部</span>
            </button>
        </div>
        `

        this.querySelector('#taskview-scroll-to-bottom-button').addEventListener('click', () => {
            this.setAutoScrollingToBottom(true);
            this.tryScrollToEnd();
        })
        this.querySelector('#taskview-chat-history').addEventListener('scroll', (event) => {
            const scrollBottom = event.target.scrollTop + event.target.clientHeight;
            const distanceToBottom = Math.abs(event.target.scrollHeight - scrollBottom);
            this.setAutoScrollingToBottom(distanceToBottom < 50);
        })
    }

}

customElements.define('task-view', TaskView)
customElements.define('embedded-task-view', EmbeddedTaskView)