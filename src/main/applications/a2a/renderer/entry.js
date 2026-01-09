class A2AEntryWidget extends HTMLElement {
    constructor() {
        super();
        /** @type {string[]} */
        this.messages = [];
        /** @type {Array} */
        this.agents = [];
    }

    connectedCallback() {
        this.render();
        this.setUpEventListeners();
    }

    setUpEventListeners() {
        const input = this.querySelector('#a2a-input');
        const sendButton = this.querySelector('#a2a-send-btn');
        const loadButton = this.querySelector('#a2a-load-btn');
        const messagesContainer = this.querySelector('#a2a-messages');

        const sendMessage = () => {
            const text = input.value.trim();
            if (text === '') {
                return;
            }
            
            // 添加消息到列表
            this.messages.push(text);
            
            // 清空输入框
            input.value = '';
            
            // 更新显示
            this.updateMessages();
        };

        const loadAgents = async () => {
            loadButton.disabled = true;
            loadButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 加载中...';
            
            try {
                const result = await window.applicationAPI.sendMessageToApplication('listAgents', {});
                if (result && result.registryEntries) {
                    this.agents = result.registryEntries;
                    this.updateAgentsDisplay();
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
        
        input.addEventListener('keypress', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });
    }

    updateMessages() {
        const messagesContainer = this.querySelector('#a2a-messages');
        if (this.messages.length === 0 && this.agents.length === 0) {
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
        
        // 显示消息列表
        if (this.messages.length > 0) {
            html += `
                <div class="mb-6">
                    <h2 class="text-lg font-semibold text-gray-700 mb-3 flex items-center gap-2">
                        <i class="fas fa-comments text-gray-500"></i>
                        消息 (${this.messages.length})
                    </h2>
                    ${this.messages.map((msg, index) => `
                        <div class="mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                            <div class="text-sm text-gray-600 mb-1">消息 ${index + 1}</div>
                            <div class="text-gray-800">${this.escapeHtml(msg)}</div>
                        </div>
                    `).join('')}
                </div>
            `;
        }
        
        messagesContainer.innerHTML = html;
        
        // 滚动到底部
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    updateAgentsDisplay() {
        this.updateMessages();
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
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full flex flex-col bg-white">
            <!-- 头部 -->
            <header class="h-14 border-b border-gray-200 flex items-center justify-between px-6 bg-white/70 backdrop-blur-xl z-20">
                <h1 class="font-medium text-md tracking-tight text-center">A2A</h1>
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
                            class="px-6 py-2 bg-purple-500 hover:bg-purple-600 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
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
