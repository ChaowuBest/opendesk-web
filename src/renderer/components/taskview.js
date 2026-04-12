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

import { ElasticToolbarWidget } from './toolbar.ts';

class TaskView extends HTMLElement {
    constructor() {
        super();

        this.task_id = null;
        this.widget_id = crypto.randomUUID();
        /** @type {HTMLDivElement | null} */
        this.history_container = null;
        /** @type {string | null} */
        this.subscription_id = null;
        this.auto_scrolling_to_bottom = true;
        this.task_status = 'waiting';
    }

    static isCompactBoundaryMessage(message) {
        return Boolean(message) && message.role === 'compact_separator';
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
        let content = '';
        let hasTextPart = false;
        for (const part of user_message.content) {
            content += `<div class="${TaskView.USER_PART_CLASS_MAP[part.type]}">${part.rendered}</div>`;
            if (part.type === 'text') {
                hasTextPart = true;
            }
        }
        if (hasTextPart) {
            return `
            <div class="flex items-start flex-row-reverse">
                <div class="bg-white text-gray-900 rounded-2xl px-3 py-1.5 shadow-sm max-w-3xl border border-gray-200">
                    ${content}
                </div>
            </div>
            `;
        } else {
            return `
            <div class="flex items-start flex-row-reverse">
                ${content}
            </div>
            `;
        }
    }

    static USER_PART_CLASS_MAP = {
        text: 'bg-transparent text-[11px] text-black markdown-body'
    };

    static ASSISTANT_PART_CLASS_MAP = {
        text: 'bg-transparent text-[11px] text-black markdown-body',
        reasoning: '',
        tool_call: ''
    };

    static createReasoningPartHtml(rendered, isOpen = false) {
        return `
        <div class="reasoning-wrapper">
            <details class="reasoning-block bg-gray-50/60 rounded-lg mb-1.5" ${isOpen ? 'open' : ''}>
                <summary class="flex items-center gap-1.5 px-2.5 py-1 cursor-pointer select-none text-gray-400 hover:text-gray-500 text-[11px] font-medium">
                    <svg class="reasoning-arrow w-3 h-3 shrink-0 transition-transform duration-200" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd"/>
                    </svg>
                    深度思考
                </summary>
                <div class="reasoning-content px-3 pb-2 text-gray-500 text-[11px] leading-relaxed">
                    ${rendered || ''}
                </div>
            </details>
        </div>`;
    }

    renderAssistantMessage(assistant_message) {
        let content = '';
        for (const part of assistant_message.content) {
            if (part.type === 'reasoning') {
                content += TaskView.createReasoningPartHtml(part.rendered, false);
            } else {
                content += `<div class="${TaskView.ASSISTANT_PART_CLASS_MAP[part.type]}">${part.rendered}</div>`;
            }
        }
        const html = `
        <div class="flex items-start">
            <div id='message-container-${assistant_message.message_id}' class="p-2 bg-transparent w-full">
                <div id='message-content-${assistant_message.message_id}'>
                    ${content}
                </div>
                <span
                    class="message-usage text-xs text-gray-400 mt-1 block"
                    title="${assistant_message.usage ? `输入: ${assistant_message.usage.prompt_tokens}, 输出: ${assistant_message.usage.completion_tokens}, 总计: ${assistant_message.usage.total_tokens}` : ''}"
                >
                    已输出 ${assistant_message.usage ? assistant_message.usage.completion_tokens : 0} 词,
                    总计 ${assistant_message.usage ? assistant_message.usage.total_tokens : 0} 词
                </span>
            </div>
        </div>
        `;
        return html;
    }

    createEmptyAssistantContainer(message_id) {
        return `
        <div class="flex items-start">
            <div id='message-container-${message_id}' class="p-2 bg-transparent w-full">
                <div id='message-content-${message_id}'>
                </div>
                <span class="message-usage text-xs text-gray-400 mt-1 block">已输出 0 词, 总计 0 词</span>
            </div>
        </div>
        `;
    }

    tryScrollToEnd() {
        if (!this.auto_scrolling_to_bottom) {
            return;
        }
        const domElement = this.getHistoryContainer();
        setTimeout(() => {
            if (!this.auto_scrolling_to_bottom) {
                return;
            }
            domElement.scroll({
                top: domElement.scrollHeight,
                behavior: 'smooth'
            });
        }, 100);
    }

    async reload() {
        const task_state = await window.taskManagerAPI.getFullTask(this.task_id);
        this.task_status = task_state.task_status || 'waiting';
        this.updateStopButtonVisibility();

        const input_widget = this.querySelector(`#task-${this.task_id}-input`);
        if (input_widget) {
            if (task_state.model) {
                input_widget.setModel(task_state.model);
            }
            if (task_state.reasoningEffort !== undefined) {
                input_widget.setReasoningEffort(task_state.reasoningEffort);
            }
        }

        const history_container = this.getHistoryContainer();
        const htmlParts = [];
        for (const message of task_state.chat_context.messages) {
            if (message.role === 'user') {
                htmlParts.push(this.renderUserMessage(message));
            } else if (message.role === 'assistant') {
                htmlParts.push(this.renderAssistantMessage(message));
            } else if (TaskView.isCompactBoundaryMessage(message)) {
                htmlParts.push(TaskView.renderCompactBoundary());
            }
        }
        history_container.innerHTML = htmlParts.join('');
        this.tryScrollToEnd();
    }

    static renderCompactBoundary() {
        return `
        <div class="flex items-center my-6 select-none">
            <div class="flex-grow border-t border-dashed border-amber-300/60"></div>
            <span class="mx-4 text-xs text-amber-500/80 font-medium tracking-wide flex items-center gap-1.5">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 9l6 6 6-6"/>
                </svg>
                上下文已压缩
            </span>
            <div class="flex-grow border-t border-dashed border-amber-300/60"></div>
        </div>`;
    }

    static renderCompactSeparator() {
        return TaskView.renderCompactBoundary();
    }

    updateStopButtonVisibility() {
        const inputWidget = this.querySelector(`#task-${this.task_id}-input`);
        if (inputWidget) {
            if (this.task_status === 'running') {
                inputWidget.setDisabled(true);
                inputWidget.setStopMode(true, async () => {
                    try {
                        await window.taskManagerAPI.stopTask(this.task_id);
                        this.task_status = 'stopped';
                        this.updateStopButtonVisibility();
                    } catch (error) {
                        console.error('Failed to stop task:', error);
                    }
                });
            } else {
                inputWidget.setDisabled(false);
                inputWidget.setStopMode(false);
            }
        }
    }

    async exportTask() {
        try {
            const timestamp = new Date().toISOString().slice(0, 10);
            const defaultFileName = `conversation-${timestamp}.html`;

            // 1. 显示保存文件对话框（Electron 会自动处理文件覆盖确认）
            const saveResult = await window.fsAPI.saveFile({
                title: '导出会话',
                defaultPath: defaultFileName,
                filters: [
                    { name: 'HTML Files', extensions: ['html'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });

            if (saveResult.canceled || !saveResult.filePath) {
                return; // 用户取消了操作
            }

            const filePath = saveResult.filePath;

            // 2. 保存文件
            await window.taskManagerAPI.exportTask(this.task_id, filePath);
        } catch (error) {
            console.error('Failed to export task:', error);
            alert('导出失败：' + error.message);
        }
    }

    connectedCallback() {
        const task_id = this.getAttribute('task_id');
        if (task_id === null) {
            throw new Error('task_id is required');
        }
        this.task_id = task_id;

        this.render();

        // Initialize toolbar
        const toolbarContainer = this.querySelector('#taskview-toolbar');
        if (toolbarContainer) {
            const toolbar = new ElasticToolbarWidget(
                [
                    {
                        id: 'taskview-export-btn',
                        icon: 'fa-download',
                        label: '导出',
                        labelStayVisible: false,
                        action: () => {
                            this.exportTask();
                        }
                    }
                ],
                '智能体对话'
            );
            toolbarContainer.appendChild(toolbar);
        }

        this.setUpEventListeners();
        this.reload().then(async () => {
            this.subscription_id = await window.taskManagerAPI.subscribeTaskUpdate(this.task_id, (progress) => {
                const history_container = this.getHistoryContainer();

                if (progress.type === 'user') {
                    const userMsg = {
                        content: [
                            {
                                type: progress.last_part.type,
                                rendered: progress.last_part.rendered || ''
                            }
                        ]
                    };
                    history_container.insertAdjacentHTML('beforeend', this.renderUserMessage(userMsg));
                } else {
                    let message_container = this.querySelector(`#message-container-${progress.message_id}`);
                    if (!message_container) {
                        history_container.insertAdjacentHTML(
                            'beforeend',
                            this.createEmptyAssistantContainer(progress.message_id)
                        );
                        message_container = this.querySelector(`#message-container-${progress.message_id}`);
                    }
                    const message_content = message_container.querySelector(`#message-content-${progress.message_id}`);
                    if (message_content.children.length <= progress.last_part_index) {
                        if (progress.last_part.type === 'reasoning') {
                            message_content.insertAdjacentHTML('beforeend', TaskView.createReasoningPartHtml('', true));
                        } else {
                            message_content.insertAdjacentHTML(
                                'beforeend',
                                `<div class='${TaskView.ASSISTANT_PART_CLASS_MAP[progress.last_part.type]}'></div>`
                            );
                            message_content
                                .querySelectorAll('details.reasoning-block[open]')
                                .forEach((el) => el.removeAttribute('open'));
                        }
                    }
                    const last_part_element = message_content.children[progress.last_part_index];
                    if (progress.last_part.type === 'reasoning') {
                        const reasoningContent = last_part_element.querySelector('.reasoning-content');
                        if (reasoningContent) {
                            reasoningContent.innerHTML = progress.last_part.rendered || '';
                        }
                    } else {
                        last_part_element.innerHTML = progress.last_part.rendered || '';
                    }
                    if (progress.usage) {
                        const usageEl = message_container.querySelector('.message-usage');
                        if (usageEl) {
                            usageEl.title = `输入: ${progress.usage.prompt_tokens}, 输出: ${progress.usage.completion_tokens}, 总计: ${progress.usage.total_tokens}`;
                            usageEl.innerHTML = `已输出 ${progress.usage.completion_tokens} 词, 总计 ${progress.usage.total_tokens} 词`;
                        }
                    }
                }

                if (progress.task_status !== this.task_status) {
                    this.task_status = progress.task_status;
                    this.updateStopButtonVisibility();
                    if (this.task_status !== 'running') {
                        this.getHistoryContainer()
                            .querySelectorAll('details.reasoning-block[open]')
                            .forEach((el) => el.removeAttribute('open'));
                    }
                }
                this.tryScrollToEnd();
            });
        });
    }

    disconnectedCallback() {
        window.taskManagerAPI.unsubscribeTaskUpdate(this.task_id, this.subscription_id);
        this.subscription_id = null;
    }

    render() {
        this.innerHTML = `
        <div class="bg-gray-30 h-full flex flex-col">
            <header id="taskview-toolbar" class="w-full pt-1"></header>

            <div class="relative flex-1 overflow-y-auto">
                <!-- 对话历史区域 - 可滚动 -->
                <div id="taskview-chat-history" class="w-full h-full space-y-2 overflow-y-auto px-3">
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

            <!-- 权限确认浮窗 -->
            <permission-prompt id="task-${this.task_id}-permission" data-task-id="${this.task_id}" class="block px-4"></permission-prompt>

            <!-- 输入区域 -->
            <div class="px-3 pb-3 pt-1">
                <agent-input id="task-${this.task_id}-input" />
            </div>
        </div>
        `;
    }

    setUpEventListeners() {
        // 为输入框添加事件监听器
        const input_widget = this.querySelector(`#task-${this.task_id}-input`);
        input_widget.addEventListener('submit', async (event) => {
            this.task_status = 'running';
            this.updateStopButtonVisibility();
            await window.taskManagerAPI.submitMessage(this.task_id, event.detail);
            await this.reload();
        });
        const chatHistory = this.querySelector('#taskview-chat-history');
        chatHistory.addEventListener('scroll', (event) => {
            const scrollBottom = chatHistory.scrollTop + chatHistory.clientHeight;
            const distanceToBottom = Math.abs(chatHistory.scrollHeight - scrollBottom);
            this.setAutoScrollingToBottom(distanceToBottom < 50);
        });
        const scrollButton = this.querySelector('#taskview-scroll-to-bottom-button');
        scrollButton.addEventListener('click', () => {
            this.setAutoScrollingToBottom(true);
            this.tryScrollToEnd();
        });
    }
}

class EmbeddedTaskView extends HTMLElement {
    constructor() {
        super();

        this.task_id = null;
        this.widget_id = crypto.randomUUID();
        /** @type {HTMLDivElement | null} */
        this.history_container = null;
        /** @type {string | null} */
        this.subscription_id = null;
        /**
         * Whether to auto scroll to bottom when new messages are added
         * @type {boolean}
         */
        this.auto_scrolling_to_bottom = true;
        /**
         * Current task status
         * @type {string}
         */
        this.task_status = 'waiting';
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

        let content = '';
        let hasTextPart = false;
        for (const part of user_message.content) {
            content += `<div class="${EmbeddedTaskView.USER_PART_CLASS_MAP[part.type]}">${part.rendered}</div>`;
            if (part.type === 'text') {
                hasTextPart = true;
            }
        }
        if (hasTextPart) {
            return `
            <div class="flex items-start flex-row-reverse">
                <div class="bg-white text-gray-900 rounded-2xl px-3 py-1 shadow-sm max-w-3xl border border-gray-200">
                    ${content}
                </div>
            </div>
            `;
        } else {
            return `
            <div class="flex items-start flex-row-reverse">
                ${content}
            </div>
            `;
        }
    }

    static USER_PART_CLASS_MAP = {
        text: 'bg-transparent text-[13px] text-black markdown-body'
    };

    static ASSISTANT_PART_CLASS_MAP = {
        text: 'bg-transparent text-[13px] text-black markdown-body',
        reasoning: '',
        tool_call: ''
    };

    renderAssistantMessage(assistant_message) {
        let content = '';
        for (const part of assistant_message.content) {
            if (part.type === 'reasoning') {
                content += TaskView.createReasoningPartHtml(part.rendered, false);
            } else {
                content += `<div class="${EmbeddedTaskView.ASSISTANT_PART_CLASS_MAP[part.type]}">${part.rendered}</div>`;
            }
        }
        const html = `
        <div class="flex items-start">
            <div class="p-2 bg-transparent w-full">
                <div id='message-${assistant_message.message_id}'>
                    ${content}
                </div>
            </div>
        </div>
        `;
        return html;
    }

    createEmptyAssistantContainer(message_id) {
        return `
        <div class="flex items-start">
            <div class="p-2 bg-transparent w-full">
                <div id='message-${message_id}'>
                </div>
            </div>
        </div>
        `;
    }

    tryScrollToEnd() {
        const domElement = this.getHistoryContainer();
        setTimeout(() => {
            if (!this.auto_scrolling_to_bottom) {
                return;
            }
            domElement.scroll({
                top: domElement.scrollHeight,
                behavior: 'smooth'
            });
        }, 100);
    }

    updateStopButtonVisibility() {
        // EmbeddedTaskView 没有输入框，不需要停止按钮
        // 停止功能由应用层面的输入框控制
    }

    /**
     * 发送任务状态变化事件
     * @param {string} status 任务状态
     */
    emitTaskStatusChanged(status) {
        const event = new CustomEvent('task-status-changed', {
            detail: {
                taskId: this.task_id,
                status: status
            },
            bubbles: true
        });
        this.dispatchEvent(event);
    }

    async reload() {
        const task_state = await window.taskManagerAPI.getFullTask(this.task_id);
        const previous_status = this.task_status;
        this.task_status = task_state.task_status || 'waiting';
        this.updateStopButtonVisibility();

        // 如果状态发生变化，发送事件
        if (previous_status !== this.task_status) {
            this.emitTaskStatusChanged(this.task_status);
        }

        const history_container = this.getHistoryContainer();
        const htmlParts = [];
        for (const message of task_state.chat_context.messages) {
            if (message.role === 'user') {
                htmlParts.push(this.renderUserMessage(message));
            } else if (message.role === 'assistant') {
                htmlParts.push(this.renderAssistantMessage(message));
            } else if (TaskView.isCompactBoundaryMessage(message)) {
                htmlParts.push(TaskView.renderCompactBoundary());
            }
        }
        history_container.innerHTML = htmlParts.join('');
        this.tryScrollToEnd();
    }

    connectedCallback() {
        const task_id = this.getAttribute('task_id');
        if (task_id === null) {
            throw new Error('task_id is required');
        }
        this.task_id = task_id;

        this.render();
        this.reload().then(async () => {
            // 在首次加载完成后，发送一次初始状态事件
            this.emitTaskStatusChanged(this.task_status);

            this.subscription_id = await window.taskManagerAPI.subscribeTaskUpdate(this.task_id, (progress) => {
                const history_container = this.getHistoryContainer();

                if (progress.type === 'user') {
                    const userMsg = {
                        content: [
                            {
                                type: progress.last_part.type,
                                rendered: progress.last_part.rendered || ''
                            }
                        ]
                    };
                    history_container.insertAdjacentHTML('beforeend', this.renderUserMessage(userMsg));
                } else {
                    let message_element = this.querySelector(`#message-${progress.message_id}`);
                    if (!message_element) {
                        history_container.insertAdjacentHTML(
                            'beforeend',
                            this.createEmptyAssistantContainer(progress.message_id)
                        );
                        message_element = this.querySelector(`#message-${progress.message_id}`);
                    }
                    if (message_element && message_element.children.length <= progress.last_part_index) {
                        if (progress.last_part.type === 'reasoning') {
                            message_element.insertAdjacentHTML('beforeend', TaskView.createReasoningPartHtml('', true));
                        } else {
                            message_element.insertAdjacentHTML(
                                'beforeend',
                                `<div class='${EmbeddedTaskView.ASSISTANT_PART_CLASS_MAP[progress.last_part.type]}'></div>`
                            );
                            message_element
                                .querySelectorAll('details.reasoning-block[open]')
                                .forEach((el) => el.removeAttribute('open'));
                        }
                    }
                    if (message_element) {
                        const last_part_element = message_element.children[progress.last_part_index];
                        if (last_part_element) {
                            if (progress.last_part.type === 'reasoning') {
                                const reasoningContent = last_part_element.querySelector('.reasoning-content');
                                if (reasoningContent) {
                                    reasoningContent.innerHTML = progress.last_part.rendered || '';
                                }
                            } else {
                                last_part_element.innerHTML = progress.last_part.rendered || '';
                            }
                        }
                    }
                }
                this.tryScrollToEnd();

                if (progress.task_status && progress.task_status !== this.task_status) {
                    this.task_status = progress.task_status;
                    this.emitTaskStatusChanged(this.task_status);
                    if (this.task_status !== 'running') {
                        this.getHistoryContainer()
                            .querySelectorAll('details.reasoning-block[open]')
                            .forEach((el) => el.removeAttribute('open'));
                    }
                }
            });
        });
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
            <div class="relative flex-1 overflow-y-auto p-3 space-y-1" id="taskview-chat-history"></div>

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
        `;

        this.querySelector('#taskview-scroll-to-bottom-button').addEventListener('click', () => {
            this.setAutoScrollingToBottom(true);
            this.tryScrollToEnd();
        });
        this.querySelector('#taskview-chat-history').addEventListener('scroll', (event) => {
            const scrollBottom = event.target.scrollTop + event.target.clientHeight;
            const distanceToBottom = Math.abs(event.target.scrollHeight - scrollBottom);
            this.setAutoScrollingToBottom(distanceToBottom < 50);
        });
    }
}

customElements.define('task-view', TaskView);
customElements.define('embedded-task-view', EmbeddedTaskView);
