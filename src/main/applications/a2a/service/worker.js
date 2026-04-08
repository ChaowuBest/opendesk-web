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

import { BaseWorker } from '../../base';
import { A2ARegistryClient } from './client.js';
import fs from 'fs';
import { LLM } from '../../../aikernel/llm.js';
import { ChatContext, UserMessage, AssistantMessage, FileMessagePart } from '../../../aikernel/messages';
import { logger } from '../../../utils/logger.js';
import { z } from 'zod';
import { ClientFactory } from '@a2a-js/sdk/client';
import { randomUUID } from 'crypto';
import { A2UIToHTMLConverter } from '../../../services/a2ui/a2ui-to-html.js';
import { isJSON, jsonToHTML } from '../../../services/a2ui/json-to-html.js';

// 硬编码的服务器地址
const GATEWAY_URL = 'http://1.92.70.52:8080';

class A2AWorker extends BaseWorker {
    constructor(bundleName, appDataDirectory) {
        super(bundleName, appDataDirectory);
        this.client = new A2ARegistryClient(GATEWAY_URL);
        /** @type {Map<string, ChatContext>} */
        this.conversations = new Map();
    }

    async initialize() {
        await super.initialize();
    }

    async applicationConfigChanged(config) {
        super.applicationConfigChanged(config);
        logger.info(`A2A config updated: ${JSON.stringify(config)}`);
    }

    async getA2AModelInstance() {
        if (!this.config || !this.config.default_a2a_model || this.config.default_a2a_model.trim() === '') {
            return null;
        }

        const { Setting } = await import('../../../utils/setting.js');
        const modelInstance = Setting.getInstance().getModelInstance(this.config.default_a2a_model.trim());

        if (!modelInstance) {
            logger.warn(`A2A model '${this.config.default_a2a_model}' not found, using default model`);
            return null;
        }

        return modelInstance;
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
     * 根据用户提示和 agent cards 选择最合适的 agent
     * @param {string} userPrompt - 用户输入提示
     * @param {Array} agentCards - Agent card 数组
     * @returns {Promise<{agentId: string, agentName: string, confidence: number, reason: string}>}
     */
    async selectAgent(userPrompt, agentCards) {
        if (!agentCards || agentCards.length === 0) {
            throw new Error('No agents available for selection');
        }

        const a2aModelInstance = await this.getA2AModelInstance();
        if (a2aModelInstance) {
            logger.info(`Using A2A specific model: ${a2aModelInstance.model_name}`);
        } else {
            logger.info(`No A2A model configured, using default model`);
        }

        // 构建 agent cards 的详细描述
        const agentsDescription = agentCards
            .map((entry, index) => {
                const agentName = entry.name || '';
                const agentId = agentName.includes('/') ? agentName.split('/').pop() : agentName;
                const card = entry.card || {};
                const skills = card.skills || [];
                const supportedInterfaces = card.supportedInterfaces || [];

                let description = `\n## Agent ${index + 1}: ${card.name || agentId}\n`;
                description += `- Agent ID: ${agentId}\n`;
                if (card.version) {
                    description += `- 版本: ${card.version}\n`;
                }
                if (card.description) {
                    description += `- 描述: ${card.description}\n`;
                }

                if (skills.length > 0) {
                    description += `- 支持的技能 (${skills.length} 个):\n`;
                    skills.forEach((skill, skillIndex) => {
                        description += `  ${skillIndex + 1}. ${skill.name || skill.id || 'N/A'}`;
                        if (skill.description) {
                            description += `: ${skill.description}`;
                        }
                        if (skill.tags && skill.tags.length > 0) {
                            description += ` [标签: ${skill.tags.join(', ')}]`;
                        }
                        if (skill.examples && skill.examples.length > 0) {
                            description += ` [示例: ${skill.examples.join(', ')}]`;
                        }
                        description += '\n';
                    });
                }

                if (supportedInterfaces.length > 0) {
                    description += `- 支持的接口:\n`;
                    supportedInterfaces.forEach((iface, ifaceIndex) => {
                        description += `  ${ifaceIndex + 1}. ${iface.url || 'N/A'} (${iface.protocolBinding || 'N/A'})\n`;
                    });
                }

                return description;
            })
            .join('\n');

        // 构建 prompt
        const prompt = `你是一个智能 agent 选择助手。根据用户的需求，从提供的 agent 列表中选择最合适的 agent 和 skill。

## 用户需求
${userPrompt}

## 可用的 Agents
${agentsDescription}

## 任务要求
请仔细分析每个 agent 的以下信息：
1. 名称和描述
2. 支持的技能（skills）及其描述、标签和示例
3. 支持的接口（supportedInterfaces）
4. 与用户需求的匹配度

请选择最匹配用户需求的 agent 和该 agent 中最合适的 skill，并用JSON格式返回以下信息：

<example>
{
  "agentId": 选中的 agent ID（从 agent name 中提取，如果包含 "/" 则取最后一部分）
  "agentName": 选中的 agent 完整名称（entry.name）
  "skillId": 选中的 skill ID 或名称（从 agent 的 skills 列表中选择，如果 agent 没有 skills 则返回空字符串）
  "skillName": 选中的 skill 名称（如果 skillId 存在，则返回对应的 skill.name，否则返回空字符串）
  "confidence": 匹配度置信度，范围 0-1 之间的数字
  "reason": 选择该 agent 和 skill 的原因，用中文简要说明
}
</example>

请确保返回的 agentId 和 agentName 与提供的 agent 列表中的信息完全匹配。如果选中的 agent 有 skills，必须选择一个 skill。`;

        // 定义返回的 Zod schema
        const selectionSchema = z.object({
            agentId: z.string().describe('选中的 agent ID（从 agent name 中提取）'),
            agentName: z.string().describe('选中的 agent 完整名称（entry.name）'),
            skillId: z.string().optional().describe('选中的 skill ID 或名称（从 agent 的 skills 列表中选择）'),
            skillName: z.string().optional().describe('选中的 skill 名称'),
            confidence: z.number().min(0).max(1).describe('匹配度置信度 (0-1)'),
            reason: z.string().describe('选择该 agent 和 skill 的原因')
        });

        try {
            const question = new UserMessage(prompt);
            const result = await LLM.askForObjectWithSchema(question, selectionSchema, a2aModelInstance);

            logger.info(`Selected agent: ${result.agentId} (confidence: ${result.confidence})`);
            logger.info(`Selection reason: ${result.reason}`);

            return result;
        } catch (error) {
            logger.error(`Error in selectAgent: ${error.message}`);
            throw new Error(`Failed to select agent: ${error.message}`);
        }
    }

    /**
     * 使用 A2A 协议调用选中的 agent
     * @param {string} agentUrl - Agent 的 provider URL
     * @param {string | {text: string, attachments: Array}} message - 用户消息（字符串或消息对象）
     * @returns {Promise<string>} Agent 的响应文本
     */
    async callAgentViaA2A(agentUrl, message) {
        try {
            const factory = new ClientFactory();
            // createFromUrl 会自动处理 /.well-known/agent-card.json 路径
            const client = await factory.createFromUrl(agentUrl);

            // 构建 A2A parts
            const parts = [];

            // 处理消息：支持字符串（向后兼容）或消息对象
            let textContent = '';
            let attachments = [];

            if (typeof message === 'string') {
                textContent = message;
            } else if (message && typeof message === 'object') {
                textContent = message.text || '';
                attachments = message.attachments || [];
            }

            // 添加文本 part
            if (textContent) {
                parts.push({ kind: 'text', text: textContent });
            }

            // 添加附件 parts
            for (const attachment of attachments) {
                if (attachment.type === 'image' || attachment.type === 'audio') {
                    // 从 data URL 中提取 base64 数据
                    let base64Data = attachment.data;
                    if (base64Data.startsWith('data:')) {
                        // 提取 base64 部分（去掉 data:mime/type;base64, 前缀）
                        const base64Match = base64Data.match(/^data:[^;]+;base64,(.+)$/);
                        if (base64Match) {
                            base64Data = base64Match[1];
                        }
                    }

                    // 转换FilePart格式：{kind: "file", file: {bytes, mimeType}}
                    parts.push({
                        kind: 'file',
                        file: {
                            bytes: base64Data,
                            mimeType: attachment.mimeType || (attachment.type === 'image' ? 'image/png' : 'audio/mpeg')
                        }
                    });
                } else if (attachment.type === 'file') {
                    let base64Data = attachment.data;

                    if (!base64Data && attachment.filePath) {
                        try {
                            const fileBuffer = fs.readFileSync(attachment.filePath);
                            base64Data = fileBuffer.toString('base64');
                        } catch (err) {
                            logger.error(`暴力读取本地文件失败: ${err.message}`);
                        }
                    }

                    if (base64Data) {
                        // 处理前缀
                        if (base64Data.startsWith('data:')) {
                            const base64Match = base64Data.match(/^data:[^;]+;base64,(.+)$/);
                            if (base64Match) base64Data = base64Match[1];
                        }
                        parts.push({
                            kind: 'file',
                            file: {
                                bytes: base64Data,
                                mimeType: attachment.mimeType || 'text/plain'
                            }
                        });
                    } else {
                        parts.push({
                            kind: 'text',
                            text: `[文件附件: ${attachment.name}]`
                        });
                    }
                }
            }

            const sendParams = {
                message: {
                    messageId: randomUUID(),
                    role: 'user',
                    parts: parts,
                    kind: 'message'
                }
            };

            const response = await client.sendMessage(sendParams);

            // 提取响应文本
            if (response && response.parts && response.parts.length > 0) {
                const textParts = response.parts
                    .filter((part) => part.kind === 'text')
                    .map((part) => part.text)
                    .join('');

                // 检测是否是 JSON 格式，如果是则转换为 HTML
                if (isJSON(textParts)) {
                    try {
                        const html = jsonToHTML(textParts);
                        return html;
                    } catch (error) {
                        logger.warn(`Failed to convert JSON to HTML: ${error.message}`);
                        // 如果转换失败，返回原始文本
                        return textParts;
                    }
                }

                return textParts;
            }

            // 提取a2ui data转换为html
            if (response.status.message.parts) {
                const converter = new A2UIToHTMLConverter();
                const messages = converter.extractA2UIData(response.status.message.parts);

                if (messages !== 'undefined') {
                    const html = converter.convertFromJSON(messages);
                    return html;
                } else {
                    return 'Agent 获取Data响应失败';
                }
            }

            return 'Agent 返回了空响应';
        } catch (error) {
            logger.error(`Error calling agent via A2A: ${error.message}`);
            throw new Error(`Failed to call agent: ${error.message}`);
        }
    }

    /**
     * 发送聊天消息并获取 AI 响应（流式）
     * @param {string} conversationId
     * @param {string | {text: string, attachments: Array}} message - 用户消息（字符串或消息对象）
     * @returns {AsyncGenerator<object>}
     */
    async *sendChatMessage(conversationId, message) {
        if (!this.conversations.has(conversationId)) {
            throw new Error(`Conversation ${conversationId} not found`);
        }

        const chatContext = this.conversations.get(conversationId);

        // 处理消息：支持字符串（向后兼容）或消息对象
        let textContent = '';
        let attachments = [];
        let targetAgentId = null;

        if (typeof message === 'string') {
            textContent = message;
        } else if (message && typeof message === 'object') {
            textContent = message.text || '';
            attachments = message.attachments || [];
            targetAgentId = message.targetAgentId;
        }

        // 构建用于 agent 选择的提示文本（包含文本和附件描述）
        let agentSelectionPrompt = textContent;
        if (attachments.length > 0) {
            const attachmentDescriptions = attachments
                .map((att) => {
                    if (att.type === 'image') return '图片';
                    if (att.type === 'audio') return '音频';
                    return '文件';
                })
                .join('、');
            agentSelectionPrompt = `${textContent} [包含${attachments.length}个附件: ${attachmentDescriptions}]`.trim();
        }

        // 在发送消息前，先选择最合适的 agent
        let selectedAgentEntry = null;
        try {
            // 获取所有可用的 agents
            const agentsResult = await this.listAgents({ view: 'AGENT_VIEW_FULL' });
            const agentCards = agentsResult?.registryEntries || [];

            if (agentCards.length > 0) {
                let selectedAgent = null;
                if (targetAgentId) {
                    logger.info(`[Sticky Routing] 前端指定了 Agent: ${targetAgentId}`);
                    // 在现有列表中查找该 Agent
                    const foundEntry = agentCards.find((entry) => {
                        const name = entry.name || '';
                        const id = name.includes('/') ? name.split('/').pop() : name;
                        return id === targetAgentId;
                    });

                    if (foundEntry) {
                        // 伪造一个 selectedAgent 对象，假装是 LLM 选出来的
                        const card = foundEntry.card || {};
                        selectedAgent = {
                            agentId: targetAgentId,
                            agentName: card.name,
                            skillId: '', // 保持默认，或者你可以从 message 中透传 skillId
                            skillName: '',
                            reason: '用户连续操作，自动保持会话 (Sticky Session)'
                        };
                    }
                }

                if (!selectedAgent) {
                    selectedAgent = await this.selectAgent(agentSelectionPrompt, agentCards);
                }
                // 选择最合适的 agent（使用包含附件信息的提示）
                //const selectedAgent = await this.selectAgent(agentSelectionPrompt, agentCards);

                // 找到对应的 agent entry
                selectedAgentEntry = agentCards.find((entry) => {
                    const agentName = entry.name || '';
                    const agentId = agentName.includes('/') ? agentName.split('/').pop() : agentName;
                    return agentId === selectedAgent.agentId || agentName === selectedAgent.agentName;
                });

                if (selectedAgentEntry) {
                    const card = selectedAgentEntry.card || {};
                    const providerUrl = card.provider?.url;

                    if (providerUrl) {
                        logger.info(`Calling agent via A2A: ${selectedAgent.agentName} at ${providerUrl}`);

                        // 获取选中的 skill 信息
                        const skills = card.skills || [];
                        let selectedSkill = null;
                        if (selectedAgent.skillId && skills.length > 0) {
                            selectedSkill = skills.find(
                                (skill) =>
                                    skill.id === selectedAgent.skillId ||
                                    skill.name === selectedAgent.skillId ||
                                    skill.name === selectedAgent.skillName
                            );
                        }

                        // 构建提示消息
                        const agentDisplayName = card.name || selectedAgent.agentId;
                        let selectionMessage = `已选择 Agent: **${agentDisplayName}**`;
                        if (selectedSkill) {
                            const skillDisplayName =
                                selectedSkill.name || selectedAgent.skillName || selectedAgent.skillId;
                            selectionMessage += `，Skill: **${skillDisplayName}**`;
                        } else if (selectedAgent.skillName) {
                            selectionMessage += `，Skill: **${selectedAgent.skillName}**`;
                        }
                        if (selectedAgent.reason) {
                            selectionMessage += `\n\n选择原因: ${selectedAgent.reason}`;
                        }

                        // 发送系统提示消息到前端
                        yield {
                            type: 'agent_selection',
                            conversationId: conversationId,
                            agentName: agentDisplayName,
                            agentId: selectedAgent.agentId,
                            skillName: selectedSkill
                                ? selectedSkill.name || selectedAgent.skillName
                                : selectedAgent.skillName || '',
                            skillId: selectedSkill
                                ? selectedSkill.id || selectedAgent.skillId
                                : selectedAgent.skillId || '',
                            reason: selectedAgent.reason || '',
                            message: selectionMessage
                        };

                        // 使用 A2A 协议调用 agent（传递完整的消息对象）
                        const messageData = typeof message === 'string' ? { text: message, attachments: [] } : message;
                        const agentResponse = await this.callAgentViaA2A(providerUrl, messageData);

                        // A2A 已返回完整响应，直接整段发送，无需模拟流式（避免人为延迟）
                        const responseText = agentResponse;

                        yield {
                            type: 'stream_chunk',
                            conversationId: conversationId,
                            chunk: {
                                content: [{ type: 'text', text: responseText }],
                                finishReason: 'stop'
                            }
                        };

                        yield {
                            type: 'stream_complete',
                            conversationId: conversationId,
                            success: true
                        };

                        try {
                            // 保存对话历史
                            const userMessage = new UserMessage(textContent);
                            // 如果有附件，添加到消息中
                            if (attachments.length > 0) {
                                for (const attachment of attachments) {
                                    if (attachment.type === 'image') {
                                        userMessage.appendImageURL(attachment.data);
                                    } else if (attachment.type === 'file') {
                                        // FileMessagePart 需要文件路径和内容，这里先只添加路径
                                        // 如果需要提取内容，可以在这里处理
                                        userMessage.content.push(
                                            new FileMessagePart(attachment.filePath || attachment.name, '')
                                        );
                                    }
                                }
                            }
                            chatContext.appendMessage(userMessage);

                            const assistantMessage = new AssistantMessage();
                            assistantMessage.content = [{ type: 'text', text: responseText }];
                            chatContext.appendMessage(assistantMessage);
                        } catch (histErr) {
                            logger.error(`保存历史记录异常 (已安全拦截): ${histErr.message}`);
                        }

                        return { success: true };
                    } else {
                        logger.warn(`Agent ${selectedAgent.agentName} has no provider URL, falling back to LLM`);
                    }
                } else {
                    logger.warn(`Could not find agent entry for ${selectedAgent.agentName}, falling back to LLM`);
                }
            } else {
                logger.warn('No agents available, proceeding without agent selection');
            }
        } catch (error) {
            logger.error(`Error selecting/calling agent: ${error.message}`);
            yield {
                type: 'stream_error',
                conversationId: conversationId,
                error: `Agent 调用失败: ${error.message}`
            };
            return { success: false };
        }

        // 回退方案：使用 LLM 生成响应
        // 添加用户消息
        const userMessage = new UserMessage(textContent);
        // 如果有附件，添加到消息中
        if (attachments.length > 0) {
            for (const attachment of attachments) {
                if (attachment.type === 'image') {
                    userMessage.appendImageURL(attachment.data);
                } else if (attachment.type === 'file') {
                    userMessage.content.push(new FileMessagePart(attachment.filePath || attachment.name, ''));
                }
            }
        }
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
                yield {
                    type: 'stream_chunk',
                    conversationId: conversationId,
                    chunk: {
                        content: assistantMessage.content
                            .map((part) => {
                                if (part.type === 'text') {
                                    return { type: 'text', text: part.text };
                                }
                                return null;
                            })
                            .filter((p) => p !== null),
                        finishReason: chunkResponse.finish_reason
                    }
                };
            }

            // 发送完成信号
            yield {
                type: 'stream_complete',
                conversationId: conversationId,
                success: true
            };

            return { success: true };
        } catch (error) {
            logger.error(`Error in sendChatMessage: ${error.message}`);

            // 发送错误信号
            yield {
                type: 'stream_error',
                conversationId: conversationId,
                error: error.message
            };

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
                    content: msg.content.map((part) => part.text).join('')
                });
            } else if (msg instanceof AssistantMessage) {
                const textParts = msg.content
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
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

export default A2AWorker;
