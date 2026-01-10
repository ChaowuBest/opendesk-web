import { BaseWorker } from "../../base.js";
import { A2ARegistryClient } from "./client.js";
import { LLM } from "../../../agents/llm.js";
import { ChatContext, UserMessage, AssistantMessage, SystemMessage } from "../../../agents/messages.js";
import { logger } from "../../../utils/logger.js";
import { parentPort } from "worker_threads";

// 硬编码的服务器地址
const GATEWAY_URL = "http://1.92.70.52:8080";

class A2AWorker extends BaseWorker {
    constructor() {
        super();
        this.client = new A2ARegistryClient(GATEWAY_URL);
        /** @type {Map<string, ChatContext>} */
        this.conversations = new Map();
    }

    async initialize() {
        await super.initialize();
    }

    async startService() {
        // 服务启动逻辑（如果需要）
    }

    async stopService() {
        // 服务停止逻辑（如果需要）
    }

    async listAgents(options = {}) {
        try {
            const result = await this.client.listAgents(options);
            return result;
        } catch (error) {
            throw new Error(`Failed to list agents: ${error.message}`);
        }
    }

    /**
     * 创建新对话
     * @returns {Promise<{conversationId: string}>}
     */
    async createConversation() {
        const conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const chatContext = new ChatContext();
        this.conversations.set(conversationId, chatContext);
        logger.info(`Created conversation: ${conversationId}`);
        return { conversationId };
    }

    /**
     * 清空对话历史
     * @param {string} conversationId
     * @returns {Promise<{success: boolean}>}
     */
    async clearConversation(conversationId) {
        if (this.conversations.has(conversationId)) {
            const chatContext = new ChatContext();
            this.conversations.set(conversationId, chatContext);
            logger.info(`Cleared conversation: ${conversationId}`);
            return { success: true };
        }
        throw new Error(`Conversation ${conversationId} not found`);
    }

    /**
     * 发送聊天消息并获取 AI 响应（流式）
     * @param {string} conversationId
     * @param {string} message
     * @param {string} requestId - 用于标识流式响应
     * @returns {Promise<{success: boolean}>}
     */
    async sendChatMessage(conversationId, message, requestId) {
        if (!this.conversations.has(conversationId)) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        const chatContext = this.conversations.get(conversationId);
        
        // 添加用户消息
        const userMessage = new UserMessage(message);
        chatContext.appendMessage(userMessage);

        // 创建助手消息用于累积响应
        const assistantMessage = new AssistantMessage();
        chatContext.appendMessage(assistantMessage);

        try {
            // 使用流式完成
            for await (const chunkResponse of LLM.streamComplete(chatContext)) {
                // 合并 chunk 到 assistant message
                assistantMessage.mergeChunk(chunkResponse.content);

                // 发送流式数据块到前端
                // 使用特殊的消息类型来发送流式数据
                parentPort.postMessage({
                    type: 'stream_chunk',
                    requestId: requestId,
                    conversationId: conversationId,
                    chunk: {
                        content: assistantMessage.content.map(part => {
                            if (part.type === 'text') {
                                return { type: 'text', text: part.text };
                            }
                            return null;
                        }).filter(p => p !== null),
                        finishReason: chunkResponse.finish_reason
                    }
                });
            }

            // 发送完成信号
            parentPort.postMessage({
                type: 'stream_complete',
                requestId: requestId,
                conversationId: conversationId,
                success: true
            });

            return { success: true };
        } catch (error) {
            logger.error(`Error in sendChatMessage: ${error.message}`);
            
            // 发送错误信号
            parentPort.postMessage({
                type: 'stream_error',
                requestId: requestId,
                conversationId: conversationId,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * 获取对话历史
     * @param {string} conversationId
     * @returns {Promise<Array>}
     */
    async getConversationHistory(conversationId) {
        if (!this.conversations.has(conversationId)) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        const chatContext = this.conversations.get(conversationId);
        const history = [];

        for (const msg of chatContext.messages) {
            if (msg instanceof UserMessage) {
                history.push({
                    role: 'user',
                    content: msg.content.map(part => part.text).join('')
                });
            } else if (msg instanceof AssistantMessage) {
                const textParts = msg.content
                    .filter(part => part.type === 'text')
                    .map(part => part.text)
                    .join('');
                history.push({
                    role: 'assistant',
                    content: textParts
                });
            }
        }

        return history;
    }
}

const worker = new A2AWorker();
worker.initialize();
