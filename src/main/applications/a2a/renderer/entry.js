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
    }

    async connectedCallback() {
        // 动态加载 markdown 相关资源
        await this.loadMarkdownResources();
        this.render();
        this.updateAttachmentsPreview(); // 初始化附件预览区域
        this.setUpEventListeners();
        // 创建初始对话
        await this.createConversation();
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
            { type: 'js', url: 'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/highlight.min.js' }
        ];

        const loadPromises = resources.map(resource => {
            return new Promise((resolve, reject) => {
                // 检查是否已经存在
                const existing = document.querySelector(
                    resource.type === 'css' 
                        ? `link[href="${resource.url}"]`
                        : `script[src="${resource.url}"]`
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
            const result = await window.applicationAPI.sendMessageToApplication('createConversation', {});
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
            await window.applicationAPI.sendMessageToApplication('clearConversation', this.conversationId);
            this.conversationHistory = [];
            this.updateMessages();
        } catch (error) {
            console.error('清空对话失败:', error);
            this.showError(`清空对话失败: ${error.message}`);
        }
    }

    setUpEventListeners() {
        const input = this.querySelector('#a2a-input');
        const sendButton = this.querySelector('#a2a-send-btn');
        const loadButton = this.querySelector('#a2a-load-btn');
        const clearButton = this.querySelector('#a2a-clear-btn');
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
                attachments: this.attachments.map(att => ({
                    type: att.type,
                    data: att.data,
                    mimeType: att.mimeType,
                    name: att.name,
                    filePath: att.filePath
                }))
            };

            // 添加用户消息到历史（显示文本和附件信息）
            const userMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const userMessageContent = text || (this.attachments.length > 0 ? `[${this.attachments.length} 个附件]` : '');
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
                const result = await window.applicationAPI.sendMessageToApplication('sendChatMessage', this.conversationId, messageData);
                const requestId = result.requestId;

                // 订阅流式响应
                if (window.a2aAPI) {
                    await window.a2aAPI.subscribeStream(requestId, (data) => {
                        this.handleStreamChunk(data, assistantMessageId);
                    });
                } else {
                    // 如果没有流式 API，等待一段时间后获取完整响应
                    setTimeout(async () => {
                        try {
                            const history = await window.applicationAPI.sendMessageToApplication('getConversationHistory', this.conversationId);
                            this.conversationHistory = history.map((msg, idx) => ({
                                role: msg.role,
                                content: msg.content,
                                id: `msg_${idx}_${Date.now()}`
                            }));
                            this.updateMessages();
                        } catch (error) {
                            console.error('获取对话历史失败:', error);
                        }
                    }, 2000);
                }
            } catch (error) {
                console.error('发送消息失败:', error);
                // 移除占位的 AI 响应
                this.conversationHistory = this.conversationHistory.filter(msg => msg.id !== assistantMessageId);
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

        const loadAgents = async () => {
            loadButton.disabled = true;
            loadButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 加载中...';
            
            try {
                const result = await window.applicationAPI.sendMessageToApplication('listAgents', {});
                if (result && result.registryEntries) {
                    this.agents = result.registryEntries;
                    this.updateMessages();
                } else {
                    this.showError('未获取到 agents 数据');
                }
            } catch (error) {
                console.error('加载 agents 失败:', error);
                this.showError(`加载失败: ${error.message}`);
            } finally {
                loadButton.disabled = false;
                loadButton.innerHTML = '<i class="fas fa-download"></i> 加载';
            }
        };

        sendButton.addEventListener('click', sendMessage);
        loadButton.addEventListener('click', loadAgents);
        if (clearButton) {
            clearButton.addEventListener('click', () => this.clearConversation());
        }
        
        input.addEventListener('keypress', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });
    }

    handleStreamChunk(data, assistantMessageId) {
        const { type, chunk, error, success, message, agentName, skillName } = data;

        if (type === 'agent_selection') {
            // 处理 Agent 选择提示消息
            const selectionMessageId = `selection_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            // 在用户消息和 AI 响应之间插入系统提示消息
            const userMessageIndex = this.conversationHistory.findIndex(msg => msg.id === assistantMessageId) - 1;
            if (userMessageIndex >= 0) {
                // 检查是否已经存在选择提示（避免重复）
                const existingSelection = this.conversationHistory.find(msg => 
                    msg.role === 'system' && msg.isAgentSelection && msg.relatedAssistantId === assistantMessageId
                );
                if (!existingSelection) {
                    this.conversationHistory.splice(userMessageIndex + 1, 0, {
                        role: 'system',
                        content: message || `已选择 Agent: **${agentName}**${skillName ? `，Skill: **${skillName}**` : ''}`,
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
            const assistantMessage = this.conversationHistory.find(msg => msg.id === assistantMessageId);
            if (assistantMessage) {
                // 提取文本内容
                const textParts = chunk.content
                    .filter(part => part.type === 'text')
                    .map(part => part.text)
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
            const assistantMessage = this.conversationHistory.find(msg => msg.id === assistantMessageId);
            if (assistantMessage) {
                assistantMessage.isStreaming = false;
                this.updateMessages(true); // 立即更新
            }
        } else if (type === 'stream_error') {
            // 流式错误，立即更新
            const assistantMessage = this.conversationHistory.find(msg => msg.id === assistantMessageId);
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
            html += `
                <div class="mb-6">
                    <h2 class="text-lg font-semibold text-gray-700 mb-3 flex items-center gap-2">
                        <i class="fas fa-robot text-purple-500"></i>
                        Agents 列表 (${this.agents.length})
                    </h2>
                    <div class="space-y-3">
                        ${this.agents.map((entry, index) => {
                            const agentName = entry.name || '';
                            const agentId = agentName.includes('/') 
                                ? agentName.split('/').pop() 
                                : agentName;
                            const card = entry.card || {};
                            const skills = card.skills || [];
                            const supportedInterfaces = card.supportedInterfaces || [];
                            
                            return `
                                <div class="p-4 bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
                                    <div class="flex items-start justify-between mb-2">
                                        <div class="flex-1">
                                            <h3 class="font-semibold text-gray-800">${this.escapeHtml(card.name || agentId)}</h3>
                                            <p class="text-xs text-gray-500 mt-1">ID: ${this.escapeHtml(agentId)}</p>
                                            ${card.version ? `<p class="text-xs text-gray-500">版本: ${this.escapeHtml(card.version)}</p>` : ''}
                                        </div>
                                    </div>
                                    ${card.description ? `
                                        <p class="text-sm text-gray-600 mt-2 mb-3">${this.escapeHtml(card.description)}</p>
                                    ` : ''}
                                    ${supportedInterfaces.length > 0 ? `
                                        <div class="mt-2 mb-2">
                                            <p class="text-xs font-medium text-gray-500 mb-1">支持的接口:</p>
                                            <div class="space-y-2">
                                                ${supportedInterfaces.map(iface => `
                                                    <div class="p-2 bg-blue-50 rounded border border-blue-100">
                                                        <div class="flex items-center gap-2 mb-1">
                                                            <span class="text-xs font-semibold text-blue-700">
                                                                ${this.escapeHtml(iface.protocolBinding || 'N/A')}
                                                            </span>
                                                        </div>
                                                        <div class="text-xs text-blue-600 break-all">
                                                            ${this.escapeHtml(iface.url || 'N/A')}
                                                        </div>
                                                    </div>
                                                `).join('')}
                                            </div>
                                        </div>
                                    ` : ''}
                                    ${skills.length > 0 ? `
                                        <div class="mt-2">
                                            <p class="text-xs font-medium text-gray-500 mb-1">技能 (${skills.length}):</p>
                                            <div class="space-y-2">
                                                ${skills.slice(0, 10).map(skill => {
                                                    const skillName = skill.name || skill.id || 'N/A';
                                                    const skillDescription = skill.description || '';
                                                    const skillTags = skill.tags || [];
                                                    const skillExamples = skill.examples || [];
                                                    
                                                    return `
                                                        <div class="p-2 bg-purple-50 rounded border border-purple-100">
                                                            <div class="font-semibold text-xs text-purple-700 mb-1">
                                                                ${this.escapeHtml(skillName)}
                                                            </div>
                                                            ${skillDescription ? `
                                                                <p class="text-xs text-gray-600 mb-1">${this.escapeHtml(skillDescription)}</p>
                                                            ` : ''}
                                                            ${skillTags.length > 0 ? `
                                                                <div class="flex flex-wrap gap-1 mb-1">
                                                                    ${skillTags.map(tag => `
                                                                        <span class="text-xs px-1.5 py-0.5 bg-purple-100 text-purple-600 rounded">
                                                                            ${this.escapeHtml(tag)}
                                                                        </span>
                                                                    `).join('')}
                                                                </div>
                                                            ` : ''}
                                                            ${skillExamples.length > 0 ? `
                                                                <div class="mt-1">
                                                                    <p class="text-xs font-medium text-gray-500 mb-0.5">示例:</p>
                                                                    <div class="space-y-0.5">
                                                                        ${skillExamples.map(example => `
                                                                            <div class="text-xs text-gray-700 bg-white px-2 py-1 rounded border border-gray-200">
                                                                                ${this.escapeHtml(example)}
                                                                            </div>
                                                                        `).join('')}
                                                                    </div>
                                                                </div>
                                                            ` : ''}
                                                        </div>
                                                    `;
                                                }).join('')}
                                                ${skills.length > 10 ? `<div class="text-xs text-gray-400 text-center py-1">+${skills.length - 10} 更多技能</div>` : ''}
                                            </div>
                                        </div>
                                    ` : ''}
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }
        
        // 显示对话历史
        if (this.conversationHistory.length > 0) {
            html += `
                <div class="mb-6">
                    <h2 class="text-lg font-semibold text-gray-700 mb-3 flex items-center gap-2">
                        <i class="fas fa-comments text-gray-500"></i>
                        对话历史
                    </h2>
                    <div class="space-y-4">
                        ${this.conversationHistory.map((msg) => {
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
                                    msg.attachments.forEach(att => {
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
                                const isStreaming = msg.isStreaming ? '<span class="inline-block w-2 h-2 bg-gray-400 rounded-full animate-pulse ml-1"></span>' : '';
                                const errorClass = msg.isError ? 'border-red-300 bg-red-50' : 'bg-gray-50';
                                // 渲染 markdown 内容
                                const renderedContent = msg.isError 
                                    ? this.escapeHtml(msg.content || '')
                                    : this.renderMarkdown(msg.content || '');
                                
                                return `
                                    <div class="flex justify-start">
                                        <div class="max-w-[80%] p-3 ${errorClass} rounded-lg border border-gray-200 shadow-sm">
                                            <div class="text-sm text-gray-800 a2a-markdown-body markdown-body">${renderedContent}${isStreaming}</div>
                                        </div>
                                    </div>
                                `;
                            }
                        }).join('')}
                    </div>
                </div>
            `;
        }
        
        messagesContainer.innerHTML = html;
        
        // 滚动到底部
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
     * 渲染 markdown 内容为 HTML
     * @param {string} markdown - markdown 文本
     * @returns {string} 渲染后的 HTML
     */
    renderMarkdown(markdown) {
        if (!markdown || typeof markdown !== 'string') {
            return '';
        }

        // 检查 marked 是否可用
        if (typeof marked === 'undefined') {
            // 如果 marked 不可用，返回转义的文本（保留换行）
            return this.escapeHtml(markdown).replace(/\n/g, '<br>');
        }

        try {
            // 配置 marked（兼容不同版本）
            const markedOptions = {
                breaks: true, // 支持换行
                gfm: true, // GitHub Flavored Markdown
            };

            // 如果 highlight.js 可用，添加代码高亮
            if (typeof hljs !== 'undefined') {
                markedOptions.highlight = function(code, lang) {
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
            if (typeof marked.parse === 'function') {
                return marked.parse(markdown);
            } else if (typeof marked === 'function') {
                return marked(markdown);
            } else {
                // 如果都不支持，返回转义的文本
                return this.escapeHtml(markdown).replace(/\n/g, '<br>');
            }
        } catch (error) {
            console.error('Markdown rendering error:', error);
            // 如果渲染失败，返回转义的文本（保留换行）
            return this.escapeHtml(markdown).replace(/\n/g, '<br>');
        }
    }

    renderAttachments() {
        if (this.attachments.length === 0) {
            return '<div class="text-xs text-gray-400 flex items-center"><i class="fas fa-info-circle mr-1"></i> 可以添加图片、音频或其他文件</div>';
        }
        
        return this.attachments.map((attachment, index) => {
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
        }).join('');
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
        removeButtons.forEach(btn => {
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

    render() {
        this.innerHTML = `
        <style>
            #application-agent-input {
                display: none !important;
            }
        </style>
        <div class="w-full h-full flex flex-col bg-white">
            <!-- 头部 -->
            <header class="h-14 border-b border-gray-200 flex items-center justify-between px-6 bg-white/70 backdrop-blur-xl z-20">
                <h1 class="font-medium text-md tracking-tight">A2A</h1>
                <button
                    id="a2a-clear-btn"
                    class="px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded transition-colors"
                    title="清空对话"
                >
                    <i class="fas fa-trash-alt"></i> 清空
                </button>
            </header>

            <!-- 消息显示区域 -->
            <main id="a2a-messages" class="flex-1 overflow-y-auto p-6">
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
                
                <div class="flex gap-3 items-end">
                    <div class="flex-1 flex flex-col gap-2">
                        <textarea
                            id="a2a-input"
                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none"
                            rows="3"
                            placeholder="输入消息..."
                        ></textarea>
                        
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
                    </div>
                    
                    <div class="flex flex-col gap-2">
                        <button
                            id="a2a-load-btn"
                            class="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
                        >
                            <i class="fas fa-download"></i>
                            <span>加载</span>
                        </button>
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
