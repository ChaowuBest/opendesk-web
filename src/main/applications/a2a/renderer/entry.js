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
    }

    async connectedCallback() {
        this.render();
        this.setUpEventListeners();
        // 创建初始对话
        await this.createConversation();
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

        const sendMessage = async () => {
            const text = input.value.trim();
            if (text === '' || this.isSending) {
                return;
            }

            if (!this.conversationId) {
                await this.createConversation();
            }

            // 添加用户消息到历史
            const userMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            this.conversationHistory.push({
                role: 'user',
                content: text,
                id: userMessageId
            });

            // 添加占位的 AI 响应
            const assistantMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            this.conversationHistory.push({
                role: 'assistant',
                content: '',
                id: assistantMessageId,
                isStreaming: true
            });

            // 清空输入框
            input.value = '';
            this.isSending = true;
            sendButton.disabled = true;
            sendButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 发送中...';

            // 更新显示
            this.updateMessages();

            try {
                // 发送消息并获取 requestId
                const result = await window.applicationAPI.sendMessageToApplication('sendChatMessage', this.conversationId, text);
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
        const { type, chunk, error, success } = data;

        if (type === 'stream_chunk' && chunk) {
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
                                            <div class="flex flex-wrap gap-1">
                                                ${skills.slice(0, 5).map(skill => `
                                                    <span class="text-xs px-2 py-1 bg-purple-50 text-purple-700 rounded">
                                                        ${this.escapeHtml(skill.name || skill.id || 'N/A')}
                                                    </span>
                                                `).join('')}
                                                ${skills.length > 5 ? `<span class="text-xs text-gray-400">+${skills.length - 5} 更多</span>` : ''}
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
                            if (msg.role === 'user') {
                                return `
                                    <div class="flex justify-end">
                                        <div class="max-w-[80%] p-3 bg-purple-500 text-white rounded-lg shadow-sm">
                                            <div class="text-sm">${this.escapeHtml(msg.content)}</div>
                                        </div>
                                    </div>
                                `;
                            } else {
                                const isStreaming = msg.isStreaming ? '<span class="inline-block w-2 h-2 bg-gray-400 rounded-full animate-pulse ml-1"></span>' : '';
                                const errorClass = msg.isError ? 'border-red-300 bg-red-50' : 'bg-gray-50';
                                return `
                                    <div class="flex justify-start">
                                        <div class="max-w-[80%] p-3 ${errorClass} rounded-lg border border-gray-200 shadow-sm">
                                            <div class="text-sm text-gray-800 whitespace-pre-wrap">${this.escapeHtml(msg.content || '')}${isStreaming}</div>
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

    render() {
        this.innerHTML = `
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
            <footer class="border-t border-gray-200 p-4 bg-white">
                <div class="flex gap-3 items-end">
                    <textarea
                        id="a2a-input"
                        class="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none"
                        rows="3"
                        placeholder="输入消息..."
                    ></textarea>
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
