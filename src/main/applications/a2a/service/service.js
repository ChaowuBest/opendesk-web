import { BaseService } from "../../base.js";
import path from 'path';
import { EventEmitter } from 'events';

const __dirname = import.meta.dirname;

class A2AService extends BaseService {

    constructor() {
        super();
    }

    static getWorkerPath() {
        return path.join(__dirname, 'worker.js');
    }

    static async initializeWorker() {
        if (this.worker) {
            return; // 已经初始化
        }
        
        await super.initializeWorker();
        
        // 监听流式消息（在父类初始化后添加额外的监听器）
        if (this.worker) {
            // 添加流式消息处理（使用 prependListener 确保先处理流式消息）
            this.worker.prependListener('message', (message) => {
                const { type, requestId, conversationId, chunk, error, success } = message;
                
                if (type === 'stream_chunk' || type === 'stream_complete' || type === 'stream_error') {
                    // 发射流式事件
                    this.streamEmitter.emit(`stream:${requestId}`, {
                        type,
                        conversationId,
                        chunk,
                        error,
                        success
                    });
                } else if (type === 'agent_selection') {
                    // 发射 agent 选择事件
                    this.streamEmitter.emit(`stream:${requestId}`, {
                        type: 'agent_selection',
                        conversationId,
                        agentName: message.agentName,
                        agentId: message.agentId,
                        skillName: message.skillName,
                        skillId: message.skillId,
                        reason: message.reason,
                        message: message.message
                    });
                }
            });
        }
    }

    /** @type {EventEmitter} */
    static streamEmitter = new EventEmitter();

    static async listAgents(options = {}) {
        return await this.sendMessage('listAgents', options);
    }

    /**
     * 创建新对话
     * @returns {Promise<{conversationId: string}>}
     */
    static async createConversation() {
        return await this.sendMessage('createConversation', {});
    }

    /**
     * 清空对话历史
     * @param {string} conversationId
     * @returns {Promise<{success: boolean}>}
     */
    static async clearConversation(conversationId) {
        return await this.sendMessage('clearConversation', conversationId);
    }

    /**
     * 发送聊天消息（流式响应）
     * @param {string} conversationId
     * @param {string | {text: string, attachments: Array}} message - 可以是字符串（向后兼容）或消息对象
     * @returns {Promise<{requestId: string, success: boolean}>}
     */
    static async sendChatMessage(conversationId, message) {
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        // 异步发送消息，不等待响应
        this.sendMessage('sendChatMessage', conversationId, message, requestId).catch(err => {
            console.error('Error sending chat message:', err);
        });
        return { requestId, success: true };
    }

    /**
     * 获取对话历史
     * @param {string} conversationId
     * @returns {Promise<Array>}
     */
    static async getConversationHistory(conversationId) {
        return await this.sendMessage('getConversationHistory', conversationId);
    }

    /**
     * 订阅流式响应
     * @param {string} requestId
     * @param {Function} callback
     * @returns {Function} 取消订阅的函数
     */
    static subscribeStream(requestId, callback) {
        const eventName = `stream:${requestId}`;
        this.streamEmitter.on(eventName, callback);
        
        // 返回取消订阅函数
        return () => {
            this.streamEmitter.removeListener(eventName, callback);
        };
    }
}

export { A2AService };
