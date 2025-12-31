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
                <div class="bg-[#8D6E63] text-white rounded-2xl p-3 shadow-sm max-w-4xl">
                    ${content}
                    <span class="text-xs mt-2 block">10:31</span>
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
        'text': 'bg-transparent text-base text-white markdown-body'
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
            <div class="p-3 bg-transparent w-full">
                <div id='message-${assistant_message.message_id}'>
                    ${content}
                </div>
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
                const message_element = this.querySelector(`#message-${progress.message_id}`);
                if (message_element.children.length <= progress.last_part_index) {
                    message_element.innerHTML += `<div class='${TaskView.ASSISTANT_PART_CLASS_MAP[progress.last_part.type]}'></div>`
                }
                const last_part_element = message_element.children[progress.last_part_index];
                last_part_element.innerHTML = progress.last_part.rendered;
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
            <header class="w-full px-4 py-3 flex justify-center items-center text-center">
                <div class="inline-block rounded-full bg-white px-5 py-2 shadow font-semibold text-gray-800 text-sm">智能体对话</div>
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
            await window.taskManagerAPI.submitMessage(this.task_id, event.detail)
            await this.reload()
        })
    }
}

customElements.define('task-view', TaskView)