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
    }

    getHistoryContainer() {
        if (this.history_container === null) {
            this.history_container = this.querySelector('#taskview-chat-history');
        }
        return this.history_container;
    }

    renderUserMessage(user_message) {
        var content = "";
        for (let part of user_message.content) {
            if (part.type === 'text') {
                content += part.text_rendered;
            } else {
                throw new Error(`unsupported part type ${part.type}`);
            }
        }
        var html = `
        <div class="flex items-start space-x-3 flex-row-reverse">
            <div class="bg-blue-500 text-white rounded-xl p-3 shadow-sm max-w-4xl">
                ${content}
                <span class="text-xs text-blue-200 mt-2 block">10:31</span>
            </div>
        </div>
        `
        return html
    }

    renderAssistantMessage(assistant_message) {
        var content = "";
        for (let part of assistant_message.content) {
            if (part.type === 'text') {
                content += part.text_rendered;
            } else {
                throw new Error(`unsupported part type ${part.type}`);
            }
        }
        var html = `
        <div class="flex items-start space-x-3">
            <div class="p-3">
                <div id='message-${assistant_message.message_id}'>${content}</div>
                <span class="text-xs text-gray-500 mt-2 block">10:30</span>
            </div>
        </div>
        `
        return html
    }

    scrollToEnd(domElement) {
        setTimeout(() => {
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
            this.scrollToEnd(history_container)
        }
    }

    connectedCallback() {
        this.render();
        this.setUpEventListeners();
        this.reload().then(async () => {
            this.subscription_id = await window.taskManagerAPI.subscribeTaskUpdate(this.task_id, progress => {
                this.querySelector(`#message-${progress.message_id}`).innerHTML = progress.last_part.text_rendered;
                this.scrollToEnd(this.getHistoryContainer())
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
            <header class="bg-white border-b border-gray-200 px-4 py-3 flex items-center shadow-sm">
                <div class="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center mr-3">
                    <span class="text-white text-sm font-semibold">AI</span>
                </div>
                <h1 class="text-lg font-semibold text-gray-800">AI Assistant</h1>
            </header>

            <!-- 对话历史区域 - 可滚动 -->
            <div class="flex-1 overflow-y-auto p-4 space-y-4" id="taskview-chat-history"></div>

            <!-- 输入区域 -->
            <div class="p-4">
                <agent-input id="task-${this.task_id}-input" />
            </div>
        </div>
        `
    }

    setUpEventListeners() {
        // 为输入框添加事件监听器
        var input_widget = this.querySelector(`#task-${this.task_id}-input`)
        input_widget.addEventListener('submit', async (event) => {
            await window.taskManagerAPI.submitMessage(this.task_id, event.detail.message)
            await this.reload()
        })
    }
}

customElements.define('task-view', TaskView)