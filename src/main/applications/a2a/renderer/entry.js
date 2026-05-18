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

import { A2UIToHTMLConverter } from '../../../services/a2ui/a2ui-to-html.js';
import { isJSON, jsonToHTML } from '../../../services/a2ui/json-to-html.js';

class A2AEntryWidget extends HTMLElement {
    constructor() {
        super();
        /** @type {Array} */
        this.agents = [];
        /** @type {string | null} */
        this.conversationId = null;
        /** @type {Array<{role: 'user' | 'assistant', content: string, id: string}>} */
        this.conversationHistory = [];
        /** @type {boolean} */
        this.isSending = false;
        /** @type {number | null} */
        this.updateTimer = null;
        /** @type {Array<{type: 'image' | 'audio' | 'file', data: string, mimeType: string, name: string, filePath?: string}>} */
        this.attachments = [];
        /** @type {A2UIToHTMLConverter} */
        this.a2uiConverter = new A2UIToHTMLConverter();
        /** @type {boolean} */
        this.agentsListExpanded = false; // Agents 列表是否展开
        this.lastAgentId = null; // [新增] 记录最后一次服务的 Agent ID
    }

    async connectedCallback() {
        // 动态加载 markdown 相关资源
        await this.loadMarkdownResources();
        this.render();
        this.updateAttachmentsPreview(); // 初始化附件预览区域
        this.setUpEventListeners();
        // 创建初始对话
        await this.createConversation();
        // 自动加载 Agents 列表
        await this.loadAgents();
    }

    /**
     * 动态加载 markdown 渲染所需的 CSS 和 JS 资源
     */
    async loadMarkdownResources() {
        // 检查是否已经加载过
        if (this.markdownResourcesLoaded) {
            return;
        }

        const resources = [
            // CSS 文件
            { type: 'css', url: '../renderer/styles/highlight-vs.min.css' },
            { type: 'css', url: '../renderer/styles/github-markdown-light.min.css' },
            { type: 'css', url: 'https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css' },
            // JS 文件
            { type: 'js', url: 'https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js' },
            {
                type: 'js',
                url: 'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/highlight.min.js'
            },
            { type: 'js', url: 'https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js' }
        ];

        const loadPromises = resources.map((resource) => {
            return new Promise((resolve, reject) => {
                // 检查是否已经存在
                const existing = document.querySelector(
                    resource.type === 'css' ? `link[href="${resource.url}"]` : `script[src="${resource.url}"]`
                );
                if (existing) {
                    resolve();
                    return;
                }

                if (resource.type === 'css') {
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = resource.url;
                    link.onload = () => resolve();
                    link.onerror = () => reject(new Error(`Failed to load CSS: ${resource.url}`));
                    document.head.appendChild(link);
                } else {
                    const script = document.createElement('script');
                    script.src = resource.url;
                    script.onload = () => resolve();
                    script.onerror = () => reject(new Error(`Failed to load JS: ${resource.url}`));
                    document.head.appendChild(script);
                }
            });
        });

        try {
            await Promise.all(loadPromises);
            this.markdownResourcesLoaded = true;
        } catch (error) {
            console.warn('Failed to load some markdown resources:', error);
            // 即使部分资源加载失败，也继续执行
        }
    }

    async createConversation() {
        try {
            const result = await window.applicationAPI.call('createConversation', {});
            this.conversationId = result.conversationId;
            this.conversationHistory = [];
            this.updateMessages();
        } catch (error) {
            console.error('创建对话失败:', error);
            this.showError(`创建对话失败: ${error.message}`);
        }
    }

    async clearConversation() {
        if (!this.conversationId) {
            return;
        }
        try {
            await window.applicationAPI.call('clearConversation', this.conversationId);
            this.conversationHistory = [];
            this.updateMessages();
        } catch (error) {
            console.error('清空对话失败:', error);
            this.showError(`清空对话失败: ${error.message}`);
        }
    }

    /**
     * 处理 A2UI 按钮点击
     * @param {HTMLElement} btn
     */
    async handleA2UIAction(btn) {
        try {
            const messageContainer = btn.closest('[data-agent-id]');
            const boundAgentId = messageContainer ? messageContainer.getAttribute('data-agent-id') : null;
            const targetAgentId = boundAgentId || this.lastAgentId;
            console.log(
                `[A2UI Action] Button clicked. Bound Agent: ${boundAgentId}, Global Last Agent: ${this.lastAgentId}, Target: ${targetAgentId}`
            );
            const actionDef = JSON.parse(btn.dataset.a2uiAction);
            const actionName = actionDef.name;
            const contextDefs = actionDef.context || [];
            console.log(`[A2UI] 触发动作: ${actionName}`, contextDefs);

            let messageToSend = '';
            // 生成题目 (start_quiz) ---
            if (actionName === 'start_quiz') {
                let articleId = null;
                // 1. 先尝试从 contextDefs 中获取
                if (Array.isArray(contextDefs)) {
                    for (const ctx of contextDefs) {
                        if (ctx.key === 'articleId') {
                            articleId = ctx.value?.literalString || (typeof ctx.value === 'string' ? ctx.value : null);
                        }
                    }
                }
                // 2. 如果没取到，则从 data-a2ui-model 属性中提取
                if (!articleId) {
                    const messageBubble = btn.closest('.a2ui-root') || document;
                    try {
                        const rawModelStr = messageBubble.getAttribute('data-a2ui-model');
                        if (rawModelStr) {
                            const decodedStr = decodeURIComponent(rawModelStr);
                            const parsedMessages = JSON.parse(decodedStr);
                            const updates = Array.isArray(parsedMessages) ? parsedMessages : [parsedMessages];

                            for (const update of updates) {
                                if (update.dataModelUpdate && update.dataModelUpdate.contents) {
                                    // 查找 key 为 articleId 或 id 的数据
                                    const idData = update.dataModelUpdate.contents.find(
                                        (c) => c.key === 'articleId' || c.key === 'id'
                                    );
                                    if (idData && idData.valueString) {
                                        articleId = idData.valueString;
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.error('[Debug] 读取 articleId 失败:', e);
                    }
                }
                // 3. 构建规范的 ACTION 消息发送给 Agent
                if (articleId) {
                    messageToSend = `ACTION: start_quiz with data: ${JSON.stringify({ articleId })}`;
                } else {
                    messageToSend = "The user clicked 'Generate Quiz'.";
                }
            } else if (actionName === 'submit_quiz') {
                if (btn.disabled || btn.classList.contains('a2ui-btn-disabled')) {
                    return;
                }

                const messageBubble = btn.closest('.a2ui-root') || document;
                const answers = [];
                const allRadios = messageBubble.querySelectorAll('input[type="radio"]');
                const seenGroups = new Set();
                let originalQuestionsMap = [];
                let currentArticleTitle = '';
                let currentArticleContent = '';
                try {
                    const rawModelStr = messageBubble.getAttribute('data-a2ui-model');
                    if (rawModelStr) {
                        const decodedStr = decodeURIComponent(rawModelStr);
                        const parsedMessages = JSON.parse(decodedStr);

                        const updates = Array.isArray(parsedMessages) ? parsedMessages : [parsedMessages];
                        for (const update of updates) {
                            if (update.dataModelUpdate && update.dataModelUpdate.contents) {
                                const qData = update.dataModelUpdate.contents.find((c) => c.key === 'questions');
                                if (qData && qData.valueMap) {
                                    originalQuestionsMap = qData.valueMap;
                                }
                                const contentData = update.dataModelUpdate.contents.find(
                                    (c) => c.key === 'articleContent'
                                );
                                if (contentData && contentData.valueString) {
                                    currentArticleContent = contentData.valueString;
                                }
                                const titleData = update.dataModelUpdate.contents.find((c) => c.key === 'articleTitle');
                                if (titleData && titleData.valueString) {
                                    currentArticleTitle = titleData.valueString;
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error('[Debug] 读取原始数据失败:', e);
                }

                let groupIndex = 0;
                allRadios.forEach((radio) => {
                    radio.disabled = true;
                    radio.setAttribute('disabled', 'disabled');
                    if (radio.checked) {
                        radio.setAttribute('checked', 'checked');
                    } else {
                        radio.removeAttribute('checked');
                    }
                    if (seenGroups.has(radio.name)) return;
                    seenGroups.add(radio.name);
                    const checked = messageBubble.querySelector(`input[name="${radio.name}"]:checked`);
                    const qIndex = answers.length + 1;
                    const qId = `question${qIndex}`;
                    const userSelection = checked ? checked.value : 'OptionA';

                    const answerObj = {
                        questionId: qId,
                        userSelection: `Option${userSelection}`
                    };
                    if (originalQuestionsMap.length > groupIndex) {
                        const originalQ = originalQuestionsMap[groupIndex];
                        if (originalQ && originalQ.valueMap) {
                            const getValue = (key) => {
                                const item = originalQ.valueMap.find((v) => v.key === key);
                                return item ? item.valueString || '' : '';
                            };

                            answerObj.question = getValue('question');
                            answerObj.correctAnswer = getValue('correctAnswer');
                            answerObj.optionA = getValue('optionA');
                            answerObj.optionB = getValue('optionB');
                            answerObj.optionC = getValue('optionC');
                            answerObj.optionD = getValue('optionD');
                        }
                    }

                    answers.push(answerObj);
                    groupIndex++;
                });
                btn.disabled = true;
                btn.setAttribute('disabled', 'disabled');
                btn.textContent = '已提交';
                btn.classList.add('a2ui-btn-disabled');
                const updatedHtml = messageBubble.outerHTML;
                const messageContainer = btn.closest('[data-message-id]');
                if (messageContainer) {
                    const targetMsgId = messageContainer.getAttribute('data-message-id');
                    const targetMsg = this.conversationHistory.find((m) => m.id === targetMsgId);
                    if (targetMsg) {
                        targetMsg.content = updatedHtml;
                        console.log(`[UI Update] Updated specific message: ${targetMsgId}`);
                    }
                }
                const payload = {
                    results: {
                        questions: answers
                    },
                    articleTitle: currentArticleTitle,
                    articleContent: currentArticleContent
                };
                messageToSend = `ACTION: submit_quiz with data: ${JSON.stringify(payload)}`;
            }
            // 处理打开链接 (open_url) ---
            else if (actionName === 'open_url') {
                let url = actionDef.context ? actionDef.context.url : null;
                if (!url && Array.isArray(contextDefs)) {
                    for (const ctx of contextDefs) {
                        if (ctx.key === 'url') {
                            url = ctx.value && ctx.value.literalString ? ctx.value.literalString : ctx.value;
                            break;
                        }
                    }
                }
                if (url) {
                    console.log(`[A2UI] 打开链接: ${url}`);
                    window.open(url, '_blank'); // 在新标签页打开
                } else {
                    console.warn('[A2UI] open_url 动作未找到有效的 url 参数');
                }

                return;
            }
            //  点击 Done (完成) ---
            else if (['done', 'finish', 'close', 'complete', 'close_result'].includes(actionName.toLowerCase())) {
                btn.style.display = 'none';
                btn.insertAdjacentHTML(
                    'afterend',
                    `
                    <div style="
                        text-align: center;
                        color: #8b5cf6;
                        font-weight: 600;
                        padding: 12px 0;
                        font-size: 14px;
                        animation: fadeIn 0.5s;
                    ">
                        Thank you for your use and support
                    </div>
                    <style>@keyframes fadeIn { from { opacity:0; } to { opacity:1; } }</style>
                `
                );
                const root = btn.closest('.a2ui-root');
                if (root) {
                    const newHtml = root.outerHTML;
                    for (let i = this.conversationHistory.length - 1; i >= 0; i--) {
                        if (this.conversationHistory[i].role === 'assistant') {
                            this.conversationHistory[i].content = newHtml;
                            break;
                        }
                    }
                }
                return;
            } else {
                console.log(`[A2UI] 执行通用动作: ${actionName}`);
                // 1. 动态提取并组装所有上下文参数 (context)
                const actionPayload = {};
                if (Array.isArray(contextDefs)) {
                    for (const ctx of contextDefs) {
                        if (ctx.key) {
                            // 兼容获取数据，处理 literalString 嵌套的情况
                            let val = ctx.value;
                            if (val && typeof val === 'object' && val.literalString !== undefined) {
                                val = val.literalString;
                            }
                            actionPayload[ctx.key] = val;
                        }
                    }
                } else if (typeof contextDefs === 'object' && contextDefs !== null) {
                    // 兼容 context 直接是一个对象的情况
                    Object.assign(actionPayload, contextDefs);
                }
                // 2. 将动作名称和参数结构化，交给 sendMessage 统一发给后端/Agent
                messageToSend = `ACTION: ${actionName} with data: ${JSON.stringify(actionPayload)}`;
            }
            if (messageToSend) {
                this.sendMessage(messageToSend, true, targetAgentId);
            }
        } catch (error) {
            console.error('处理 A2UI 动作失败:', error);
            this.showError('无法执行操作: ' + error.message);
        }
    }
    async sendMessage(text, isSystemAction = false, targetAgentId = null) {
        if (!this.conversationId) await this.createConversation();

        const messageData = { text: text, attachments: [], targetAgentId: targetAgentId };
        window.applicationAPI.streamCall(
            'sendChatMessage',
            (chunk) => {
                const assistantMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            },
            this.conversationId,
            messageData
        );
        this.isSending = true;
        if (!isSystemAction) {
        } else {
            let displayAction = '执行操作';

            if (text.includes('submit_quiz')) {
                displayAction = '提交答案';
            } else if (text.includes('start_quiz')) {
                displayAction = '生成题目';
            } else {
                const match = text.match(/ACTION:\s*([^\s]+)/);
                if (match) {
                    displayAction = `触发动作: ${match[1]}`;
                }
            }

            this.conversationHistory.push({
                role: 'user',
                content: `[系统指令] ${displayAction}...`,
                id: `sys_${Date.now()}`,
                isSystem: true
            });
        }

        const assistantMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.conversationHistory.push({
            role: 'assistant',
            content: '',
            id: assistantMessageId,
            isStreaming: true
        });
        this.updateMessages();

        try {
            window.applicationAPI.streamCall(
                'sendChatMessage',
                (chunk) => this.handleStreamChunk(chunk, assistantMessageId),
                this.conversationId,
                messageData
            );
        } catch (e) {
            /*...*/
        } finally {
            this.isSending = false;
        }
    }

    setUpEventListeners() {
        const input = this.querySelector('#a2a-input');
        const sendButton = this.querySelector('#a2a-send-btn');
        const imageInput = this.querySelector('#a2a-image-input');
        const audioInput = this.querySelector('#a2a-audio-input');
        const fileInput = this.querySelector('#a2a-file-input');
        const imageBtn = this.querySelector('#a2a-image-btn');
        const audioBtn = this.querySelector('#a2a-audio-btn');
        const fileBtn = this.querySelector('#a2a-file-btn');
        const footer = this.querySelector('footer');

        // 文件选择按钮事件
        imageBtn.addEventListener('click', () => imageInput.click());
        audioBtn.addEventListener('click', () => audioInput.click());
        fileBtn.addEventListener('click', () => fileInput.click());
        const messagesContainer = this.querySelector('#a2a-messages');
        messagesContainer.addEventListener('click', (e) => {
            // 查找最近的带有 data-a2ui-action 的按钮
            const btn = e.target.closest('.a2ui-interactive-btn');
            if (btn && btn.dataset.a2uiAction) {
                e.preventDefault();
                e.stopPropagation();
                this.handleA2UIAction(btn);
            }
        });

        // 文件选择事件
        imageInput.addEventListener('change', async (e) => {
            for (const file of e.target.files) {
                await this.addAttachment(file);
            }
            e.target.value = ''; // 重置input，允许重复选择同一文件
        });

        audioInput.addEventListener('change', async (e) => {
            for (const file of e.target.files) {
                await this.addAttachment(file);
            }
            e.target.value = '';
        });

        fileInput.addEventListener('change', async (e) => {
            for (const file of e.target.files) {
                await this.addAttachment(file);
            }
            e.target.value = '';
        });

        // 拖拽支持
        footer.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            footer.classList.add('bg-gray-50');
        });

        footer.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            footer.classList.remove('bg-gray-50');
        });

        footer.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            footer.classList.remove('bg-gray-50');

            const files = e.dataTransfer.files;
            for (const file of files) {
                await this.addAttachment(file);
            }
        });

        const sendMessage = async () => {
            const text = input.value.trim();
            // 允许只发送附件，不发送文本
            if ((text === '' && this.attachments.length === 0) || this.isSending) {
                return;
            }

            if (!this.conversationId) {
                await this.createConversation();
            }

            // 构建消息对象
            const messageData = {
                text: text || '',
                attachments: this.attachments.map((att) => ({
                    type: att.type,
                    data: att.data,
                    mimeType: att.mimeType,
                    name: att.name,
                    filePath: att.filePath
                }))
            };

            // 添加用户消息到历史（显示文本和附件信息）
            const userMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const userMessageContent =
                text || (this.attachments.length > 0 ? `[${this.attachments.length} 个附件]` : '');
            this.conversationHistory.push({
                role: 'user',
                content: userMessageContent,
                id: userMessageId,
                attachments: this.attachments.length > 0 ? [...this.attachments] : undefined
            });

            // 添加占位的 AI 响应
            const assistantMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            this.conversationHistory.push({
                role: 'assistant',
                content: '',
                id: assistantMessageId,
                isStreaming: true
            });

            // 清空输入框和附件
            input.value = '';
            this.clearAttachments();
            this.isSending = true;
            sendButton.disabled = true;
            sendButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 发送中...';

            // 更新显示
            this.updateMessages();

            try {
                // 发送消息并获取 requestId
                window.applicationAPI.streamCall(
                    'sendChatMessage',
                    (chunk) => {
                        // console.info('received', chunk);
                        this.handleStreamChunk(chunk, assistantMessageId);
                    },
                    this.conversationId,
                    messageData
                );
            } catch (error) {
                console.error('发送消息失败:', error);
                // 移除占位的 AI 响应
                this.conversationHistory = this.conversationHistory.filter((msg) => msg.id !== assistantMessageId);
                this.conversationHistory.push({
                    role: 'assistant',
                    content: `错误: ${error.message}`,
                    id: assistantMessageId,
                    isError: true
                });
                this.updateMessages();
                this.showError(`发送失败: ${error.message}`);
            } finally {
                this.isSending = false;
                sendButton.disabled = false;
                sendButton.innerHTML = '<i class="fas fa-paper-plane"></i> 发送';
            }
        };

        const updateAgents = async () => {
            const updateButton = this.querySelector('#a2a-update-btn');
            if (updateButton) {
                updateButton.disabled = true;
                updateButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 更新中...';
            }

            try {
                await this.loadAgents();
            } finally {
                if (updateButton) {
                    updateButton.disabled = false;
                    updateButton.innerHTML = '<i class="fas fa-sync-alt"></i> 更新';
                }
            }
        };

        sendButton.addEventListener('click', sendMessage);
        const updateButton = this.querySelector('#a2a-update-btn');
        if (updateButton) {
            updateButton.addEventListener('click', updateAgents);
        }

        input.addEventListener('keypress', (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                sendMessage();
            }
        });
    }

    handleStreamChunk(data, assistantMessageId) {
        const { type, agentId, chunk, error, success, message, agentName, skillName } = data;

        if (type === 'agent_selection') {
            const currentAssistantMsg = this.conversationHistory.find((msg) => msg.id === assistantMessageId);
            if (agentId) {
                this.lastAgentId = agentId; // [新增] 记住这个 Agent
                console.log('Current active agent:', this.lastAgentId);
                if (currentAssistantMsg) {
                    currentAssistantMsg.agentId = agentId;
                    console.log(`[Binding] 消息 ${assistantMessageId} 绑定 Agent: ${agentId}`);
                }
            }
            // 处理 Agent 选择提示消息
            const selectionMessageId = `selection_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            // 在用户消息和 AI 响应之间插入系统提示消息
            const userMessageIndex = this.conversationHistory.findIndex((msg) => msg.id === assistantMessageId) - 1;
            if (userMessageIndex >= 0) {
                // 检查是否已经存在选择提示（避免重复）
                const existingSelection = this.conversationHistory.find(
                    (msg) =>
                        msg.role === 'system' && msg.isAgentSelection && msg.relatedAssistantId === assistantMessageId
                );
                if (!existingSelection) {
                    this.conversationHistory.splice(userMessageIndex + 1, 0, {
                        role: 'system',
                        content:
                            message || `已选择 Agent: **${agentName}**${skillName ? `，Skill: **${skillName}**` : ''}`,
                        id: selectionMessageId,
                        isAgentSelection: true,
                        relatedAssistantId: assistantMessageId,
                        agentName: agentName,
                        skillName: skillName
                    });
                    this.updateMessages(true);
                }
            }
        } else if (type === 'stream_chunk' && chunk) {
            // 更新 AI 响应内容
            const assistantMessage = this.conversationHistory.find((msg) => msg.id === assistantMessageId);
            if (assistantMessage) {
                // 提取文本内容
                const textParts = chunk.content
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join('');

                const currentContent = assistantMessage.content || '';

                // 判断是增量块还是完整内容：
                // 1. 如果新文本包含现有内容，说明是完整内容（LLM 回退情况），应该替换
                // 2. 如果新文本是现有内容的扩展（现有内容是新文本的前缀），也是完整内容，应该替换
                // 3. 否则是增量块（A2A agent 情况），应该追加
                if (textParts.includes(currentContent) || textParts.startsWith(currentContent)) {
                    // 完整内容，替换
                    assistantMessage.content = textParts;
                } else if (currentContent && textParts.length > currentContent.length * 2) {
                    // 新文本比现有内容长很多，可能是完整内容，替换
                    assistantMessage.content = textParts;
                } else {
                    // 增量块，追加
                    assistantMessage.content = currentContent + textParts;
                }

                assistantMessage.isStreaming = true;
                this.updateMessages();
            }
        } else if (type === 'stream_complete' && success) {
            // 流式完成，立即更新
            const assistantMessage = this.conversationHistory.find((msg) => msg.id === assistantMessageId);
            if (assistantMessage) {
                assistantMessage.isStreaming = false;
                this.updateMessages(true); // 立即更新
            }
        } else if (type === 'stream_error') {
            // 流式错误，立即更新
            const assistantMessage = this.conversationHistory.find((msg) => msg.id === assistantMessageId);
            if (assistantMessage) {
                assistantMessage.content = `错误: ${error || '未知错误'}`;
                assistantMessage.isStreaming = false;
                assistantMessage.isError = true;
                this.updateMessages(true); // 立即更新
            }
        }
    }

    updateMessages(immediate = false) {
        // 使用节流，减少更新频率
        if (immediate) {
            // 立即更新，清除待处理的定时器
            if (this.updateTimer) {
                clearTimeout(this.updateTimer);
                this.updateTimer = null;
            }
            this._updateMessagesImmediate();
        } else {
            // 节流更新
            if (this.updateTimer) {
                clearTimeout(this.updateTimer);
            }
            this.updateTimer = setTimeout(() => {
                this._updateMessagesImmediate();
                this.updateTimer = null;
            }, 50); // 每 50ms 最多更新一次
        }
    }

    _updateMessagesImmediate() {
        const messagesContainer = this.querySelector('#a2a-messages');
        if (this.conversationHistory.length === 0 && this.agents.length === 0) {
            messagesContainer.innerHTML = `
                <div class="text-center text-gray-400 mt-8">
                    <i class="fas fa-comments text-4xl mb-2"></i>
                    <p>还没有消息，开始输入吧！</p>
                </div>
            `;
            return;
        }

        let html = '';

        // 显示 agents 列表
        if (this.agents.length > 0) {
            html += this.renderAgentsList();
        }

        // 显示对话历史
        if (this.conversationHistory.length > 0) {
            html += `
                <div class="mb-6">
                    <div class="flex items-center gap-3 mb-3">
                        <h2 class="text-lg font-semibold text-gray-700 flex items-center gap-2">
                            <i class="fas fa-comments text-gray-500"></i>
                            对话历史
                        </h2>
                        <!-- 清空对话按钮（仅在对话历史存在时显示） -->
                        <button
                            id="a2a-clear-btn"
                            class="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-all shadow-sm hover:shadow-md"
                            title="清空对话"
                        >
                            <i class="fas fa-trash-alt"></i> 清空
                        </button>
                    </div>
                    <div class="space-y-4">
                        ${this.conversationHistory
                            .map((msg) => {
                                if (msg.role === 'system' && msg.isAgentSelection) {
                                    // 系统提示消息：Agent 选择提示
                                    const renderedContent = this.renderMarkdown(msg.content || '');
                                    return `
                                    <div class="flex justify-center">
                                        <div class="max-w-[80%] p-3 bg-blue-50 border border-blue-200 rounded-lg shadow-sm">
                                            <div class="flex items-center gap-2 mb-1">
                                                <i class="fas fa-robot text-blue-600"></i>
                                                <span class="text-xs font-semibold text-blue-700">Agent 选择</span>
                                            </div>
                                             <div class="text-sm text-blue-800 a2a-markdown-body markdown-body">${renderedContent}</div>
                                        </div>
                                    </div>
                                `;
                                } else if (msg.role === 'user') {
                                    let attachmentsHtml = '';
                                    if (msg.attachments && msg.attachments.length > 0) {
                                        attachmentsHtml = '<div class="mt-2 flex flex-wrap gap-2">';
                                        msg.attachments.forEach((att) => {
                                            if (att.type === 'image') {
                                                attachmentsHtml += `
                                                <img src="${att.data}" alt="${this.escapeHtml(att.name)}"
                                                     class="max-w-[200px] max-h-[200px] object-cover rounded border border-white/30" />
                                            `;
                                            } else if (att.type === 'audio') {
                                                attachmentsHtml += `
                                                <div class="bg-white/20 rounded p-2 flex items-center gap-2">
                                                    <i class="fas fa-music"></i>
                                                    <span class="text-xs">${this.escapeHtml(att.name)}</span>
                                                </div>
                                            `;
                                            } else {
                                                attachmentsHtml += `
                                                <div class="bg-white/20 rounded p-2 flex items-center gap-2">
                                                    <i class="fas fa-file"></i>
                                                    <span class="text-xs">${this.escapeHtml(att.name)}</span>
                                                </div>
                                            `;
                                            }
                                        });
                                        attachmentsHtml += '</div>';
                                    }

                                    return `
                                    <div class="flex justify-end">
                                        <div class="max-w-[80%] p-3 bg-purple-500 text-white rounded-lg shadow-sm">
                                            ${msg.content ? `<div class="text-sm">${this.escapeHtml(msg.content)}</div>` : ''}
                                            ${attachmentsHtml}
                                        </div>
                                    </div>
                                `;
                                } else {
                                    const isStreaming = msg.isStreaming
                                        ? '<span class="inline-block w-2 h-2 bg-gray-400 rounded-full animate-pulse ml-1"></span>'
                                        : '';
                                    const errorClass = msg.isError ? 'border-red-300 bg-red-50' : 'bg-gray-50';
                                    // 渲染 markdown 内容
                                    const renderedContent = msg.isError
                                        ? this.escapeHtml(msg.content || '')
                                        : this.renderMarkdown(msg.content || '');

                                    // 检测是否是 HTML 内容（a2ui）
                                    const isHTMLContent = this.isHTML(msg.content || '');
                                    // 对于 HTML 内容，不使用 markdown-body 类，避免样式覆盖
                                    const contentClass = isHTMLContent
                                        ? 'a2a-html-content'
                                        : 'text-sm text-gray-800 a2a-markdown-body markdown-body';
                                    const boundAgentId = msg.agentId || '';
                                    return `
                                    <div class="flex justify-start" data-agent-id="${boundAgentId}" data-message-id="${msg.id}">
                                        <div class="max-w-[80%] p-3 ${errorClass} rounded-lg border border-gray-200 shadow-sm">
                                            <div class="${contentClass}">${renderedContent}${isStreaming}</div>
                                        </div>
                                    </div>
                                `;
                                }
                            })
                            .join('')}
                    </div>
                </div>
            `;
        }

        messagesContainer.innerHTML = html;

        // 设置 Agents 列表展开/收起事件监听器
        this.setupAgentsListToggle();

        // 设置更新按钮事件监听器
        this.setupUpdateButton();

        // 设置清空按钮事件监听器（如果存在）
        this.setupClearButton();

        // 滚动到底部
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    /**
     * 设置清空按钮事件监听器
     */
    setupClearButton() {
        const clearButton = this.querySelector('#a2a-clear-btn');
        if (clearButton) {
            // 移除可能存在的旧事件监听器
            const newButton = clearButton.cloneNode(true);
            clearButton.parentNode.replaceChild(newButton, clearButton);

            // 添加新的事件监听器
            newButton.addEventListener('click', () => {
                this.clearConversation();
            });
        }
    }

    /**
     * 加载 Agents 列表
     */
    async loadAgents() {
        try {
            const result = await window.applicationAPI.call('listAgents', {});
            if (result && result.registryEntries) {
                this.agents = result.registryEntries;
                this.updateMessages();
            } else {
                console.warn('未获取到 agents 数据');
            }
        } catch (error) {
            console.error('加载 agents 失败:', error);
            // 不显示错误提示，避免干扰用户体验
        }
    }

    /**
     * 设置更新按钮事件监听器
     */
    setupUpdateButton() {
        const updateButton = this.querySelector('#a2a-update-btn');
        if (updateButton) {
            // 移除可能存在的旧事件监听器
            const newButton = updateButton.cloneNode(true);
            updateButton.parentNode.replaceChild(newButton, updateButton);

            // 添加新的事件监听器
            newButton.addEventListener('click', async () => {
                newButton.disabled = true;
                newButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 更新中...';

                try {
                    await this.loadAgents();
                } finally {
                    newButton.disabled = false;
                    newButton.innerHTML = '<i class="fas fa-sync-alt"></i> 更新';
                }
            });
        }
    }

    /**
     * 设置 Agents 列表展开/收起功能
     */
    setupAgentsListToggle() {
        const toggleButtons = this.querySelectorAll('[data-action="toggle-agents-list"]');
        toggleButtons.forEach((button) => {
            // 移除可能存在的旧事件监听器
            const newButton = button.cloneNode(true);
            button.parentNode.replaceChild(newButton, button);

            // 添加新的事件监听器
            newButton.addEventListener('click', () => {
                this.agentsListExpanded = !this.agentsListExpanded;
                this.updateMessages(true); // 立即更新
            });
        });
    }

    showError(message) {
        const messagesContainer = this.querySelector('#a2a-messages');
        messagesContainer.innerHTML = `
            <div class="text-center text-red-400 mt-8">
                <i class="fas fa-exclamation-triangle text-4xl mb-2"></i>
                <p>${this.escapeHtml(message)}</p>
            </div>
        `;
    }

    escapeHtml(text) {
        if (text === null || text === undefined) {
            return '';
        }
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * 检测内容是否是 HTML
     * @param {string} content - 内容文本
     * @returns {boolean} 是否是 HTML
     */
    isHTML(content) {
        if (!content || typeof content !== 'string') {
            return false;
        }
        // 检查是否包含 HTML 标签（特别是 a2ui-root 类）
        const trimmed = content.trim();
        return (
            trimmed.startsWith('<') &&
            (trimmed.includes('<div') ||
                trimmed.includes('<span') ||
                trimmed.includes('<h1') ||
                trimmed.includes('<h2') ||
                trimmed.includes('<h3') ||
                trimmed.includes('<p') ||
                trimmed.includes('class="a2ui-root"') ||
                trimmed.includes("class='a2ui-root'"))
        );
    }

    /**
     * 渲染 LaTeX 数学公式
     * @param {string} text - 包含 LaTeX 公式的文本
     * @returns {string} 渲染后的 HTML
     */
    renderLatex(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }

        // 先过滤掉文本中的 <br> 标签（作为纯文本出现的）
        // 这些标签应该被移除，因为它们会干扰渲染
        text = text.replace(/&lt;br&gt;|&lt;br\s*\/&gt;|<br>|<br\s*\/>/gi, '');

        // 检查 katex 是否可用
        if (typeof katex === 'undefined') {
            return text;
        }

        try {
            // 先处理块级公式 $$...$$（避免与内联公式冲突）
            // 支持跨行公式
            const blockFormulaRegex = /\$\$([\s\S]*?)\$\$/g;
            const blockPlaceholders = [];
            let blockIndex = 0;

            text = text.replace(blockFormulaRegex, (match, formula) => {
                try {
                    // 清理公式中的换行和多余空格，但保留必要的空格
                    const cleanedFormula = formula.trim().replace(/\s+/g, ' ');
                    const placeholder = `__BLOCK_LATEX_${blockIndex}__`;
                    // 使用 displayMode: false 使其左对齐，或者使用 displayMode: true 但添加左对齐样式
                    const katexHtml = katex.renderToString(cleanedFormula, {
                        displayMode: false, // 改为 false 使其左对齐而不是居中
                        throwOnError: false
                    });
                    blockPlaceholders.push({
                        placeholder: placeholder,
                        html: katexHtml
                    });
                    blockIndex++;
                    return placeholder;
                } catch (error) {
                    console.warn('KaTeX block formula error:', error, formula);
                    return match; // 如果渲染失败，返回原始内容
                }
            });

            // 处理内联公式 $...$
            // 先找到所有可能的 $...$ 模式，然后过滤掉块级公式
            const inlinePlaceholders = [];
            let inlineIndex = 0;

            // 使用更简单的方法：查找所有 $...$ 模式，但排除 $$...$$
            // 通过检查前后字符来确保是内联公式
            text = text.replace(/\$([^$\n]+?)\$/g, (match, formula, offset, fullText) => {
                // 检查前后字符，确保不是块级公式的一部分
                const beforeChar = offset > 0 ? fullText[offset - 1] : '';
                const afterChar = offset + match.length < fullText.length ? fullText[offset + match.length] : '';

                // 如果前后都是 $，说明是块级公式，跳过（应该已经被处理了）
                if (beforeChar === '$' || afterChar === '$') {
                    return match;
                }

                // 检查是否是占位符
                if (match.includes('__BLOCK_LATEX_') || match.includes('__INLINE_LATEX_')) {
                    return match;
                }

                try {
                    const cleanedFormula = formula.trim();
                    // 跳过空公式
                    if (!cleanedFormula) {
                        return match;
                    }
                    const placeholder = `__INLINE_LATEX_${inlineIndex}__`;
                    inlinePlaceholders.push({
                        placeholder: placeholder,
                        html: katex.renderToString(cleanedFormula, {
                            displayMode: false,
                            throwOnError: false
                        })
                    });
                    inlineIndex++;
                    return placeholder;
                } catch (error) {
                    console.warn('KaTeX inline formula error:', error, formula);
                    return match; // 如果渲染失败，返回原始内容
                }
            });

            // 替换所有占位符
            blockPlaceholders.forEach((item) => {
                text = text.replace(item.placeholder, item.html);
            });
            inlinePlaceholders.forEach((item) => {
                text = text.replace(item.placeholder, item.html);
            });

            return text;
        } catch (error) {
            console.error('LaTeX rendering error:', error);
            return text;
        }
    }

    /**
     * 渲染 markdown 内容为 HTML
     * @param {string} markdown - markdown 文本
     * @returns {string} 渲染后的 HTML
     */
    renderMarkdown(markdown) {
        if (!markdown || typeof markdown !== 'string') {
            return '';
        }

        // 如果是 HTML 内容，直接返回（不进行 markdown 渲染）
        if (this.isHTML(markdown)) {
            return markdown;
        }

        // 检测是否是 JSON 格式，如果是则渲染为 HTML
        if (isJSON(markdown)) {
            return jsonToHTML(markdown);
        }

        // 在 markdown 渲染之前，先过滤掉文本中的 <br> 标签（作为纯文本出现的）
        // 这些标签应该被移除，因为它们会干扰渲染
        markdown = markdown.replace(/&lt;br&gt;|&lt;br\s*\/&gt;|<br>|<br\s*\/>/gi, '');

        // 检查 marked 是否可用
        if (typeof marked === 'undefined') {
            // 如果 marked 不可用，返回转义的文本（保留换行），并尝试渲染 LaTeX
            const escaped = this.escapeHtml(markdown).replace(/\n/g, '<br>');
            return this.renderLatex(escaped);
        }

        try {
            // 配置 marked（兼容不同版本）
            const markedOptions = {
                breaks: true, // 支持换行
                gfm: true // GitHub Flavored Markdown
            };

            // 如果 highlight.js 可用，添加代码高亮
            if (typeof hljs !== 'undefined') {
                markedOptions.highlight = function (code, lang) {
                    if (lang && hljs.getLanguage(lang)) {
                        try {
                            return hljs.highlight(code, { language: lang }).value;
                        } catch (err) {
                            console.warn('Highlight error:', err);
                        }
                    }
                    return hljs.highlightAuto(code).value;
                };
            }

            // 尝试配置 marked（新版本使用 setOptions，旧版本可能不支持）
            if (typeof marked.setOptions === 'function') {
                marked.setOptions(markedOptions);
            } else if (typeof marked.configure === 'function') {
                marked.configure(markedOptions);
            }

            // 尝试解析 markdown（新版本使用 parse，旧版本直接调用）
            let html;
            if (typeof marked.parse === 'function') {
                html = marked.parse(markdown);
            } else if (typeof marked === 'function') {
                html = marked(markdown);
            } else {
                // 如果都不支持，返回转义的文本
                html = this.escapeHtml(markdown).replace(/\n/g, '<br>');
            }

            // 在 markdown 渲染后，渲染 LaTeX 公式
            return this.renderLatex(html);
        } catch (error) {
            console.error('Markdown rendering error:', error);
            // 如果渲染失败，返回转义的文本（保留换行），并尝试渲染 LaTeX
            const escaped = this.escapeHtml(markdown).replace(/\n/g, '<br>');
            return this.renderLatex(escaped);
        }
    }

    renderAttachments() {
        if (this.attachments.length === 0) {
            return '<div class="text-xs text-gray-400 flex items-center"><i class="fas fa-info-circle mr-1"></i> 可以添加图片、音频或其他文件</div>';
        }

        return this.attachments
            .map((attachment, index) => {
                let preview = '';
                if (attachment.type === 'image') {
                    preview = `
                    <div class="relative group">
                        <img src="${attachment.data}" alt="${this.escapeHtml(attachment.name)}"
                             class="w-16 h-16 object-cover rounded border border-gray-300" />
                        <button data-attachment-index="${index}"
                                class="a2a-remove-attachment absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                `;
                } else if (attachment.type === 'audio') {
                    preview = `
                    <div class="relative group bg-blue-50 border border-blue-200 rounded p-2 flex items-center gap-2">
                        <i class="fas fa-music text-blue-600"></i>
                        <div class="flex-1 min-w-0">
                            <div class="text-xs font-medium text-gray-700 truncate">${this.escapeHtml(attachment.name)}</div>
                            <div class="text-xs text-gray-500">音频文件</div>
                        </div>
                        <button data-attachment-index="${index}"
                                class="a2a-remove-attachment w-5 h-5 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                `;
                } else {
                    preview = `
                    <div class="relative group bg-gray-100 border border-gray-300 rounded p-2 flex items-center gap-2">
                        <i class="fas fa-file text-gray-600"></i>
                        <div class="flex-1 min-w-0">
                            <div class="text-xs font-medium text-gray-700 truncate">${this.escapeHtml(attachment.name)}</div>
                            <div class="text-xs text-gray-500">文件</div>
                        </div>
                        <button data-attachment-index="${index}"
                                class="a2a-remove-attachment w-5 h-5 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                `;
                }
                return preview;
            })
            .join('');
    }

    updateAttachmentsPreview() {
        const previewContainer = this.querySelector('#a2a-attachments-preview');
        if (previewContainer) {
            previewContainer.innerHTML = this.renderAttachments();
            this.setupAttachmentRemoveButtons();
        }
    }

    setupAttachmentRemoveButtons() {
        const removeButtons = this.querySelectorAll('.a2a-remove-attachment');
        removeButtons.forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(btn.dataset.attachmentIndex);
                this.removeAttachment(index);
            });
        });
    }

    async addAttachment(file) {
        const filePath = window.fsAPI ? window.fsAPI.getFilePath(file) : null;
        const fileName = file.name;
        const fileType = file.type;

        // 判断文件类型
        let attachmentType = 'file';
        if (fileType.startsWith('image/')) {
            attachmentType = 'image';
        } else if (fileType.startsWith('audio/')) {
            attachmentType = 'audio';
        }

        // 转换为 base64 data URL
        try {
            const dataUrl = await this.fileToDataURL(file);
            this.attachments.push({
                type: attachmentType,
                data: dataUrl,
                mimeType: fileType,
                name: fileName,
                filePath: filePath
            });
            this.updateAttachmentsPreview();
        } catch (error) {
            console.error('处理文件失败:', error);
            this.showError(`处理文件失败: ${error.message}`);
        }
    }

    fileToDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(new Error('读取文件失败'));
            reader.readAsDataURL(file);
        });
    }

    removeAttachment(index) {
        this.attachments.splice(index, 1);
        this.updateAttachmentsPreview();
    }

    clearAttachments() {
        this.attachments = [];
        this.updateAttachmentsPreview();
    }

    /**
     * 使用 a2ui 模块渲染 Agents 列表
     * @returns {string} 渲染后的 HTML
     */
    renderAgentsList() {
        try {
            const converter = this.a2uiConverter;

            // 获取主题样式类
            const cardClasses = converter.getComponentStyleClasses('Card').join(' ');
            const cardStyles = converter.getAdditionalStyles('Card');
            const columnClasses = converter.getComponentStyleClasses('Column').join(' ');
            const columnStyles = converter.getAdditionalStyles('Column');
            const rowClasses = converter.getComponentStyleClasses('Row').join(' ');
            const rowStyles = converter.getAdditionalStyles('Row');
            const listClasses = converter.getComponentStyleClasses('List').join(' ');
            const listStyles = converter.getAdditionalStyles('List');

            // 获取文本样式
            const h2Styles = converter.getAdditionalStyles('Text', 'h2');
            const h3Styles = converter.getAdditionalStyles('Text', 'h3');
            const h4Styles = converter.getAdditionalStyles('Text', 'h4');
            const bodyStyles = converter.getAdditionalStyles('Text', 'body');
            const captionStyles = converter.getAdditionalStyles('Text', 'caption');

            // 获取图标样式
            const iconClasses = converter.getComponentStyleClasses('Icon').join(' ');
            const iconStyles = converter.getAdditionalStyles('Icon');

            // 获取 Root 背景样式（用于整个列表容器）
            const rootStyles = converter.getAdditionalStyles('Root');

            // 获取按钮样式
            const buttonClasses = converter.getComponentStyleClasses('Button').join(' ');
            const buttonStyles = converter.getAdditionalStyles('Button');

            // 构建 Agents 卡片 HTML
            const agentsHtml = this.agents
                .map((entry) => {
                    const agentName = entry.name || '';
                    const agentId = agentName.includes('/') ? agentName.split('/').pop() : agentName;
                    const card = entry.card || {};
                    const skills = card.skills || [];

                    // 构建技能列表 HTML
                    let skillsHtml = '';
                    if (skills.length > 0) {
                        const skillsList = skills
                            .map((skill) => {
                                const skillName = skill.name || skill.id || 'N/A';
                                const skillExamples = skill.examples || [];
                                const firstExample = skillExamples.length > 0 ? skillExamples[0] : null;

                                // 使用主题样式构建技能卡片
                                return `
                            <div class="a2ui-card ${cardClasses}" style="${cardStyles}; background: linear-gradient(135deg, rgba(139, 92, 246, 0.1) 0%, rgba(167, 139, 250, 0.05) 100%); border: 1px solid rgba(139, 92, 246, 0.2); margin-bottom: 4px;">
                                <div class="a2ui-column ${columnClasses}" style="${columnStyles}">
                                    <h4 style="${h4Styles}; margin: 0 0 4px 0; color: #7c3aed;">
                                        ${this.escapeHtml(skillName)}
                                    </h4>
                                    ${
                                        firstExample
                                            ? `
                                        <p style="${captionStyles}; margin: 0; background: rgba(255, 255, 255, 0.8); padding: 4px 6px; border-radius: 4px; border: 1px solid rgba(0, 0, 0, 0.05);">
                                            ${this.escapeHtml(firstExample)}
                                        </p>
                                    `
                                            : ''
                                    }
                                </div>
                            </div>
                        `;
                            })
                            .join('');

                        skillsHtml = `
                        <div class="a2ui-column ${columnClasses}" style="${columnStyles}; margin-top: 8px;">
                            <p style="${captionStyles}; margin: 0 0 4px 0; font-weight: 500;">
                                技能 (${skills.length}):
                            </p>
                            <div class="a2ui-list ${listClasses}" style="${listStyles}">
                                ${skillsList}
                            </div>
                        </div>
                    `;
                    }

                    // 使用主题样式构建 Agent 卡片
                    return `
                    <div class="a2ui-card ${cardClasses} agents-card-item" style="${cardStyles}; margin-bottom: 8px; transition: all 0.2s ease; cursor: default;">
                        <div class="a2ui-column ${columnClasses}" style="${columnStyles}">
                            <h3 style="${h3Styles}; margin: 0;">
                                ${this.escapeHtml(card.name || agentId)}
                            </h3>
                            ${
                                card.description
                                    ? `
                                <p style="${bodyStyles}; margin: 4px 0 0 0;">
                                    ${this.escapeHtml(card.description)}
                                </p>
                            `
                                    : ''
                            }
                            ${skillsHtml}
                        </div>
                    </div>
                `;
                })
                .join('');

            // 使用主题样式构建完整的列表
            const isExpanded = this.agentsListExpanded;
            const expandIcon = isExpanded ? '▼' : '▶';

            const additionalStyles = `
                <style>
                    ${converter.generateBaseStyles()}
                    /* Agents 列表特定样式 */
                    .agents-list-container {
                        ${rootStyles}
                    }
                    .agents-card-item:hover {
                        box-shadow: 0 2px 8px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05) !important;
                        transform: translateY(-1px);
                        border-color: rgba(139, 92, 246, 0.2) !important;
                    }
                    .agents-list-header {
                        cursor: pointer;
                        user-select: none;
                        transition: opacity 0.2s ease, background-color 0.2s ease;
                        padding: 4px 8px;
                        margin: -4px -8px;
                        border-radius: 4px;
                    }
                    .agents-list-header:hover {
                        opacity: 0.8;
                        background-color: rgba(0, 0, 0, 0.02);
                    }
                    .agents-list-content {
                        overflow: hidden;
                        transition: max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1),
                                    opacity 0.3s ease,
                                    margin-top 0.3s ease;
                        max-height: ${isExpanded ? '5000px' : '0'};
                        opacity: ${isExpanded ? '1' : '0'};
                        margin-top: ${isExpanded ? '8px' : '0'};
                    }
                    .agents-expand-icon {
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        width: 16px;
                        height: 16px;
                        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        transform: rotate(${isExpanded ? '90deg' : '0deg'});
                        margin-right: 6px;
                        font-size: 10px;
                        color: #64748b;
                        flex-shrink: 0;
                    }
                    .agents-collapse-button {
                        margin-top: 8px;
                        opacity: ${isExpanded ? '1' : '0'};
                        pointer-events: ${isExpanded ? 'auto' : 'none'};
                        transition: opacity 0.3s ease;
                        display: flex;
                        justify-content: center;
                    }
                </style>
            `;

            return `
                <div class="mb-6">
                    ${additionalStyles}
                    <div class="a2ui-root agents-list-container" style="${rootStyles}">
                        <div class="a2ui-column ${columnClasses}" style="${columnStyles}">
                            <div class="a2ui-row ${rowClasses} agents-list-header" style="${rowStyles}; align-items: center; justify-content: space-between;" data-action="toggle-agents-list">
                                <div class="a2ui-row ${rowClasses}" style="${rowStyles}; align-items: center; flex: 1;">
                                    <span class="agents-expand-icon">${expandIcon}</span>
                                    <span class="a2ui-icon ${iconClasses}" style="${iconStyles}; font-size: 16px;">🤖</span>
                                    <h2 style="${h2Styles}; margin: 0;">
                                        Agents 列表 (${this.agents.length})
                                    </h2>
                                </div>
                                <!-- 更新按钮 -->
                                <button
                                    id="a2a-update-btn"
                                    class="${buttonClasses}"
                                    style="${buttonStyles}; margin-left: 8px; flex-shrink: 0;"
                                    title="更新 Agents 列表"
                                    onclick="event.stopPropagation();"
                                >
                                    <i class="fas fa-sync-alt"></i> 更新
                                </button>
                            </div>
                            <div class="agents-list-content">
                                <div class="a2ui-list ${listClasses}" style="${listStyles}">
                                    ${agentsHtml}
                                </div>
                                <div class="agents-collapse-button">
                                    <button class="${buttonClasses}" style="${buttonStyles}" data-action="toggle-agents-list">
                                        <span style="margin-right: 4px;">▲</span>
                                        收起列表
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        } catch (error) {
            console.error('Error rendering agents list with a2ui:', error);
            // 如果出错，回退到传统渲染方式
            return this.renderAgentsListTraditional();
        }
    }

    /**
     * 传统方式渲染 Agents 列表（作为回退方案）
     * @returns {string} 渲染后的 HTML
     */
    renderAgentsListTraditional() {
        return `
            <div class="mb-6">
                <h2 class="text-lg font-semibold text-gray-700 mb-3 flex items-center gap-2">
                    <i class="fas fa-robot text-purple-500"></i>
                    Agents 列表 (${this.agents.length})
                </h2>
                <div class="space-y-3">
                    ${this.agents
                        .map((entry, index) => {
                            const agentName = entry.name || '';
                            const agentId = agentName.includes('/') ? agentName.split('/').pop() : agentName;
                            const card = entry.card || {};
                            const skills = card.skills || [];

                            return `
                            <div class="p-4 bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
                                <div class="flex items-start justify-between mb-2">
                                    <div class="flex-1">
                                        <h3 class="font-semibold text-gray-800">${this.escapeHtml(card.name || agentId)}</h3>
                                    </div>
                                </div>
                                ${
                                    card.description
                                        ? `
                                    <p class="text-sm text-gray-600 mt-2 mb-3">${this.escapeHtml(card.description)}</p>
                                `
                                        : ''
                                }
                                ${
                                    skills.length > 0
                                        ? `
                                    <div class="mt-2">
                                        <p class="text-xs font-medium text-gray-500 mb-1">技能 (${skills.length}):</p>
                                        <div class="space-y-2">
                                            ${skills
                                                .map((skill) => {
                                                    const skillName = skill.name || skill.id || 'N/A';
                                                    const skillExamples = skill.examples || [];
                                                    const firstExample =
                                                        skillExamples.length > 0 ? skillExamples[0] : null;

                                                    return `
                                                    <div class="p-2 bg-purple-50 rounded border border-purple-100">
                                                        <div class="font-semibold text-xs text-purple-700 mb-1">
                                                            ${this.escapeHtml(skillName)}
                                                        </div>
                                                        ${
                                                            firstExample
                                                                ? `
                                                            <div class="mt-1">
                                                                <div class="text-xs text-gray-700 bg-white px-2 py-1 rounded border border-gray-200">
                                                                    ${this.escapeHtml(firstExample)}
                                                                </div>
                                                            </div>
                                                        `
                                                                : ''
                                                        }
                                                    </div>
                                                `;
                                                })
                                                .join('')}
                                        </div>
                                    </div>
                                `
                                        : ''
                                }
                            </div>
                        `;
                        })
                        .join('')}
                </div>
            </div>
        `;
    }

    render() {
        this.innerHTML = `
        <style>
            #application-agent-input {
                display: none !important;
            }
            /* 确保 a2ui HTML 内容的样式不被覆盖 */
            /* 移除可能覆盖内联样式的默认样式 */
            .a2a-html-content {
                /* 不设置 font-size，让内联样式生效 */
            }
            /* 确保内联样式优先级最高，不被 markdown-body 等类覆盖 */
            .a2a-html-content * {
                /* 内联样式会自动覆盖，这里不需要额外设置 */
            }
            /* JSON 渲染样式 - 与 a2ui 主题统一 */
            .json-container {
                font-family: "Maple Mono", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                font-size: 11px;
                line-height: 1.35;
                color: #1e293b;
                -webkit-font-smoothing: antialiased;
                word-wrap: break-word;
                overflow-wrap: break-word;
                word-break: break-word;
                background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 50%, #e2e8f0 100%);
                border-radius: 8px;
                padding: 10px 12px;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.03);
            }
            .json-container * {
                box-sizing: border-box;
            }
            .json-article-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .json-article-item {
                background: rgba(255, 255, 255, 0.7);
                border: 1px solid rgba(226, 232, 240, 0.8);
                border-radius: 6px;
                padding: 8px 10px;
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
                transition: all 0.15s ease;
            }
            .json-article-item:hover {
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
                border-color: rgba(139, 92, 246, 0.2);
                transform: translateY(-1px);
            }
            .json-article-content {
                flex: 1;
            }
            .json-article-title {
                margin: 0 0 4px 0;
                font-size: 12px;
                font-weight: 600;
                line-height: 1.25;
                color: transparent;
                background: linear-gradient(135deg, #818cf8 0%, #a78bfa 100%);
                -webkit-background-clip: text;
                background-clip: text;
                -webkit-text-fill-color: transparent;
            }
            .json-article-title a {
                color: transparent;
                background: linear-gradient(135deg, #818cf8 0%, #a78bfa 100%);
                -webkit-background-clip: text;
                background-clip: text;
                -webkit-text-fill-color: transparent;
                text-decoration: none;
                font-weight: 600;
            }
            .json-article-title a:hover {
                text-decoration: underline;
                opacity: 0.9;
            }
            .json-article-date {
                font-size: 10px;
                color: #64748b;
                margin-bottom: 4px;
            }
            .json-article-summary {
                color: #475569;
                font-size: 11px;
                line-height: 1.45;
                margin-bottom: 4px;
            }
            .json-article-meta {
                margin-top: 6px;
                padding-top: 6px;
                border-top: 1px solid rgba(226, 232, 240, 0.6);
                font-size: 10px;
            }
            .json-article-meta-item {
                margin: 2px 0;
                color: #64748b;
            }
            .json-article-meta-item strong {
                color: #475569;
                font-weight: 500;
            }
            .json-article-image {
                margin-bottom: 6px;
            }
            .json-article-image img {
                max-width: 100%;
                height: auto;
                border-radius: 4px;
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
            }
            .json-table {
                width: 100%;
                border-collapse: collapse;
                margin: 6px 0;
                font-size: 10px;
                background: rgba(255, 255, 255, 0.7);
                border-radius: 6px;
                overflow: hidden;
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
            }
            .json-table th,
            .json-table td {
                border: 1px solid rgba(226, 232, 240, 0.8);
                padding: 6px 8px;
                text-align: left;
            }
            .json-table th {
                background: linear-gradient(135deg, rgba(129, 140, 248, 0.1) 0%, rgba(167, 139, 250, 0.1) 100%);
                font-weight: 500;
                color: #475569;
                font-size: 10px;
            }
            .json-table tr:nth-child(even) {
                background-color: rgba(248, 250, 252, 0.5);
            }
            .json-table tr:hover {
                background-color: rgba(129, 140, 248, 0.05);
            }
            .json-card-list {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                gap: 8px;
            }
            .json-card {
                background: rgba(255, 255, 255, 0.7);
                border: 1px solid rgba(226, 232, 240, 0.8);
                border-radius: 6px;
                padding: 8px 10px;
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
                transition: all 0.15s ease;
            }
            .json-card:hover {
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
                border-color: rgba(139, 92, 246, 0.2);
                transform: translateY(-1px);
            }
            .json-card-field {
                margin-bottom: 4px;
            }
            .json-card-field:last-child {
                margin-bottom: 0;
            }
            .json-card-key {
                font-weight: 500;
                color: #64748b;
                margin-bottom: 1px;
                font-size: 10px;
            }
            .json-card-value {
                color: #334155;
                font-size: 11px;
            }
            .json-string {
                color: #059669;
            }
            .json-number {
                color: #2563eb;
            }
            .json-boolean {
                color: #7c3aed;
            }
            .json-null {
                color: #94a3b8;
                font-style: italic;
            }
            .json-key {
                color: #64748b;
                font-weight: 500;
            }
            .json-object,
            .json-array {
                font-family: "Maple Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
                font-size: 10px;
            }
            .json-property,
            .json-item {
                padding-left: 12px;
                border-left: 1px solid rgba(226, 232, 240, 0.6);
                margin: 2px 0;
            }
            .json-display {
                background: rgba(248, 250, 252, 0.8);
                border: 1px solid rgba(226, 232, 240, 0.8);
                border-radius: 6px;
                padding: 8px 10px;
                overflow-x: auto;
                margin: 6px 0;
            }
            .json-display code {
                font-family: "Maple Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
                font-size: 10px;
                color: #334155;
            }
            .json-error {
                color: #dc2626;
                padding: 6px 8px;
                background: rgba(254, 226, 226, 0.5);
                border: 1px solid rgba(248, 113, 113, 0.3);
                border-radius: 4px;
                font-size: 10px;
            }
        </style>
        <div class="w-full h-full flex flex-col bg-white">
            <!-- 头部 -->
            <header class="h-14 border-b border-gray-200 flex items-center justify-between px-6 bg-white/70 backdrop-blur-xl z-20">
                <h1 class="font-medium text-md tracking-tight">A2A</h1>
            </header>

            <!-- 消息显示区域 -->
            <main id="a2a-messages" class="flex-1 overflow-y-auto p-6 relative">
                <div class="text-center text-gray-400 mt-8">
                    <i class="fas fa-comments text-4xl mb-2"></i>
                    <p>还没有消息，开始输入吧！</p>
                </div>
            </main>

            <!-- 输入区域 -->
            <footer class="border-t border-gray-200 p-4 bg-white" id="a2a-footer">
                <!-- 附件预览区域 -->
                <div id="a2a-attachments-preview" class="mb-2 flex flex-wrap gap-2 min-h-[60px] p-2 bg-gray-50 rounded-lg border border-gray-200">
                    ${this.renderAttachments()}
                </div>

                <div class="flex gap-3 items-center">
                    <div class="flex-1">
                        <textarea
                            id="a2a-input"
                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none"
                            rows="1"
                            placeholder="输入消息..."
                            style="height: 40px; min-height: 40px; max-height: 40px; line-height: 1.5; overflow-y: hidden;"
                        ></textarea>
                    </div>

                    <!-- 工具栏 -->
                    <div class="flex items-center gap-2">
                            <!-- 图片选择 -->
                            <input
                                type="file"
                                id="a2a-image-input"
                                accept="image/*"
                                multiple
                                style="display: none;"
                            />
                            <button
                                id="a2a-image-btn"
                                class="p-2 text-gray-600 hover:text-purple-600 hover:bg-purple-50 rounded-lg transition-colors"
                                title="添加图片"
                            >
                                <i class="fas fa-image"></i>
                            </button>

                            <!-- 音频选择 -->
                            <input
                                type="file"
                                id="a2a-audio-input"
                                accept="audio/*"
                                multiple
                                style="display: none;"
                            />
                            <button
                                id="a2a-audio-btn"
                                class="p-2 text-gray-600 hover:text-purple-600 hover:bg-purple-50 rounded-lg transition-colors"
                                title="添加音频"
                            >
                                <i class="fas fa-microphone"></i>
                            </button>

                            <!-- 文件选择 -->
                            <input
                                type="file"
                                id="a2a-file-input"
                                multiple
                                style="display: none;"
                            />
                            <button
                                id="a2a-file-btn"
                                class="p-2 text-gray-600 hover:text-purple-600 hover:bg-purple-50 rounded-lg transition-colors"
                                title="添加文件"
                            >
                                <i class="fas fa-paperclip"></i>
                            </button>
                    </div>

                    <div>
                        <button
                            id="a2a-send-btn"
                            class="px-6 py-2 bg-purple-500 hover:bg-purple-600 text-white rounded-lg font-medium transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <i class="fas fa-paper-plane"></i>
                            <span>发送</span>
                        </button>
                    </div>
                </div>
            </footer>
        </div>
        `;
    }
}

customElements.define('a2a-entry-widget', A2AEntryWidget);
