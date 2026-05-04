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

import type { TaskManagerState, TaskState } from '../../aikernel/states/tasks.js';
import { UserMessage, AssistantMessage, ImageMessagePart, imageToDataUri } from '../../aikernel/messages.js';
import { ApplicationRegistry } from '../registry.js';
import { SkillRegistry } from '../../aikernel/skill.js';
import { createMemoryToolset } from '../../aikernel/memory/tools.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { logger } from '../../utils/logger.js';
import { LLM } from '../../aikernel/llm.js';
import type { InboundChannelMessage, Participant } from '../../aikernel/plugins/types.js';
import type { AgentDecl } from '../../aikernel/agents/common.js';
import { SEND_FILE_TOOL_NAME } from './tools.js';

export interface ChannelReply {
    text: string;
    mediaUrls: string[];
}

const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

interface TaskEntry {
    taskId: string;
    lastMessageAt: number;
}

/**
 * Maps task keys (channelId:accountId:senderId for DM, channelId:accountId:groupId for group) to active task entries.
 */
const taskMap = new Map<string, TaskEntry>();

export class ChannelMessageRouter {
    private taskManagerState: TaskManagerState;
    private agentDecl: AgentDecl;
    private model?: string;
    private extraToolsets: BaseToolset[] = [];

    /**
     * 当消息被路由到任务时的回调。
     * 在 AI 处理之前触发，以便前端可以切换到对应的任务并显示实时处理过程。
     */
    onTaskResolved?: (task: TaskState, message: InboundChannelMessage) => void;

    constructor(taskManagerState: TaskManagerState, agentDecl: AgentDecl, model?: string) {
        this.taskManagerState = taskManagerState;
        this.agentDecl = agentDecl;
        this.model = model;
    }

    addExtraToolset(toolset: BaseToolset): void {
        this.extraToolsets.push(toolset);
    }

    /**
     * Register a task in the task map so that subsequent messages from the same
     * participant will be routed to this task.
     * This is called after a cron/scheduled trigger sends a message to ensure
     * that user replies are routed to the correct task.
     *
     * @param taskId - The ID of the task to register
     * @param participant - The participant (channel/account/recipient) to register under
     * @param taskName - Optional name for the task (defaults to the recipient)
     */
    registerTaskForParticipant(taskId: string, participant: Participant, taskName?: string): void {
        // For channel tasks, the recipientId is the target (user ID for DM, group ID for group)
        // Use recipientId as the third part of the key to match how routeInboundMessage computes it
        const taskKey = `${participant.channel}:${participant.accountId}:${participant.recipientId}`;
        taskMap.set(taskKey, { taskId, lastMessageAt: Date.now() });
        logger.info(`[router] registered task ${taskId} for participant ${taskKey}${taskName ? ` (${taskName})` : ''}`);
    }

    /**
     * Route an inbound channel message to the task system.
     * Creates or reuses a session/task for the sender, runs the AI agent,
     * and returns the assistant's reply text.
     */
    async routeInboundMessage(message: InboundChannelMessage): Promise<ChannelReply | null> {
        // For group messages, use groupId as the conversation key so all members share the same task.
        // For direct messages, use senderId.
        const taskKey =
            message.chatType === 'group' && message.groupId
                ? `${message.channelId}:${message.accountId}:${message.groupId}`
                : `${message.channelId}:${message.accountId}:${message.senderId}`;

        let task: TaskState;
        try {
            task = await this.resolveSessionTask(taskKey, message);
        } catch (err: any) {
            logger.error(`创建消息会话失败: ${err?.message || err}`);
            return {
                text: `抱歉，系统在创建会话时遇到了问题：${err?.message || err}\n请联系管理员检查系统配置。`,
                mediaUrls: []
            };
        }

        if (task.task_status === 'running') {
            await task.waitUntilFinished();
        }

        // 通知前端切换到该任务（在 AI 处理之前，以便实时显示处理过程）
        try {
            this.onTaskResolved?.(task, message);
        } catch (err: any) {
            logger.warn(`onTaskResolved callback error: ${err?.message || err}`);
        }

        const userText = this.formatInboundMessage(message);

        try {
            const reply = await this.submitAndWaitForReply(task, userText, message.media);
            const entry = taskMap.get(taskKey);
            if (entry) entry.lastMessageAt = Date.now();
            return reply;
        } catch (err: any) {
            logger.error(`消息插件处理失败: ${err?.message || err}`);
            return { text: this.buildErrorReply(err), mediaUrls: [] };
        }
    }

    private buildErrorReply(err: any): string {
        const msg = err?.message || String(err);
        const lower = msg.toLowerCase();

        if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('api key')) {
            return `抱歉，处理消息时遇到了认证错误（API Key 无效或已过期）。\n\n错误详情：${msg}\n\n请联系管理员检查模型服务的 API Key 配置。`;
        }
        if (lower.includes('403') || lower.includes('forbidden') || lower.includes('permission')) {
            return `抱歉，处理消息时遇到了权限错误。\n\n错误详情：${msg}\n\n请联系管理员检查账户权限配置。`;
        }
        if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota')) {
            return `抱歉，当前请求过于频繁或已超出配额限制。\n\n错误详情：${msg}\n\n请稍后再试，或联系管理员检查配额设置。`;
        }
        if (lower.includes('timeout') || lower.includes('econnrefused') || lower.includes('network')) {
            return `抱歉，处理消息时遇到了网络错误。\n\n错误详情：${msg}\n\n请检查网络连接后重试。`;
        }
        if (lower.includes('model') || lower.includes('not found')) {
            return `抱歉，处理消息时遇到了模型配置错误。\n\n错误详情：${msg}\n\n请联系管理员检查模型配置是否正确。`;
        }

        return `抱歉，处理消息时遇到了错误。\n\n错误详情：${msg}\n\n请联系管理员查看日志以了解详情。`;
    }

    /**
     * Resolve a session task for the given key:
     * 1. If no existing session, create a new task.
     * 2. If existing session, check if it should expire:
     *    a. Ask LLM if the new message is related to the previous conversation.
     *    b. If LLM check fails, fall back to 15-minute timeout.
     *    c. If expired, create a new task; otherwise reuse.
     */
    private async resolveSessionTask(taskKey: string, message: InboundChannelMessage): Promise<TaskState> {
        const entry = taskMap.get(taskKey);
        if (!entry) {
            return this.createSessionTask(taskKey, message);
        }

        const task = this.taskManagerState.getTask(entry.taskId);
        if (!task) {
            taskMap.delete(taskKey);
            return this.createSessionTask(taskKey, message);
        }

        const timeSinceLastMsg = Date.now() - entry.lastMessageAt;
        const newText = message.text || '';

        // Try LLM-based relevance check (with timeout protection)
        try {
            const shouldContinue = await this.checkSessionRelevance(task, newText);
            if (!shouldContinue) {
                logger.info(`[router] 会话 ${taskKey} 被 LLM 判定为不相关，创建新任务`);
                return this.createSessionTask(taskKey, message);
            }
            // LLM check passed - update lastMessageAt before returning so that
            // if submitAndWaitForReply fails later, the timestamp is still correct.
            entry.lastMessageAt = Date.now();
            return task;
        } catch (err: any) {
            logger.warn(`[router] LLM 关联性检查失败，回退到超时判断: ${err?.message || err}`);
        }

        // Fallback: 15-minute timeout
        if (timeSinceLastMsg > SESSION_TIMEOUT_MS) {
            logger.info(`[router] 会话 ${taskKey} 超时 (${Math.floor(timeSinceLastMsg / 60000)}分钟)，创建新任务`);
            return this.createSessionTask(taskKey, message);
        }

        // Fallback path also reuses the task - update lastMessageAt
        entry.lastMessageAt = Date.now();
        return task;
    }

    /**
     * Use the LLM to determine whether a new message belongs to the same conversation.
     * Returns true if the conversation should continue, false if a new session should start.
     */
    private async checkSessionRelevance(task: TaskState, newMessageText: string): Promise<boolean> {
        const recentMessages = this.getRecentConversationSummary(task, 3);
        if (!recentMessages) return true; // No history to compare, keep session

        const prompt = [
            '你是一个会话管理助手。请判断用户的新消息是否与之前的对话相关。',
            '',
            '之前的对话摘要：',
            recentMessages,
            '',
            '用户的新消息：',
            newMessageText,
            '',
            '请仅回答 "相关" 或 "不相关"，不要包含其他内容。'
        ].join('\n');

        const answer = await Promise.race([
            LLM.ask(new UserMessage(prompt), this.model),
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error('LLM relevance check timeout')), 8000))
        ]);

        return !answer.includes('不相关');
    }

    /**
     * Extract a brief summary of recent messages from a task for relevance checking.
     */
    private getRecentConversationSummary(task: TaskState, maxPairs: number): string | null {
        const parts: string[] = [];
        let pairCount = 0;

        for (let i = task.chat_context.messages.length - 1; i >= 0 && pairCount < maxPairs; i--) {
            const msg = task.chat_context.messages[i];
            if (msg instanceof UserMessage) {
                for (const p of msg.content) {
                    if (p.type === 'text' && p.text) {
                        const text = p.text.length > 200 ? p.text.slice(0, 200) + '...' : p.text;
                        parts.unshift(`[用户]: ${text}`);
                    }
                }
                pairCount++;
            } else if (msg instanceof AssistantMessage) {
                for (const p of msg.content) {
                    if (p.type === 'text' && (p as any).text) {
                        const text =
                            (p as any).text.length > 200 ? (p as any).text.slice(0, 200) + '...' : (p as any).text;
                        parts.unshift(`[助手]: ${text}`);
                    }
                }
            }
        }

        return parts.length > 0 ? parts.join('\n') : null;
    }

    private async createSessionTask(taskKey: string, message: InboundChannelMessage): Promise<TaskState> {
        const task = this.taskManagerState.createTask(this.model);
        const systemPrompt = await this.agentDecl.createSystemPrompt();

        // Determine reply target: group ID for group chats, sender ID for direct messages
        const replyTarget = message.chatType === 'group' && message.groupId ? message.groupId : message.senderId;

        const channelContext = [
            systemPrompt,
            '',
            '--- Channel Context ---',
            `Channel: ${message.channelId}`,
            `Sender: ${message.senderName || message.senderId}`,
            message.chatType === 'group' ? `Group: ${message.groupName || message.groupId}` : '',
            'Please respond concisely and naturally, as this is a chat message from a messaging platform.'
        ]
            .filter(Boolean)
            .join('\n');

        await task.setSystemPrompt(channelContext);

        task.task_name = `消息: ${message.senderName || message.senderId}`;
        task.origin = {
            type: 'channel',
            channel: message.channelId,
            accountId: message.accountId,
            recipientId: replyTarget
        };
        taskMap.set(taskKey, { taskId: task.task_id, lastMessageAt: Date.now() });

        return task;
    }

    private formatInboundMessage(message: InboundChannelMessage): string {
        let text = message.text || '';
        if (message.senderName && message.chatType === 'group') {
            text = `[${message.senderName}] ${text}`;
        }
        return text;
    }

    private async submitAndWaitForReply(
        task: TaskState,
        userText: string,
        media?: Array<{ path: string; contentType?: string }>
    ): Promise<ChannelReply | null> {
        task.task_status = 'running';
        task.started_at = new Date();
        task.finished_at = undefined;
        task.task_manager_state.publishTaskListUpdate();

        try {
            const userMessage = new UserMessage(userText);

            if (media && media.length > 0) {
                const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
                for (const item of media) {
                    const ct = item.contentType?.toLowerCase() || '';
                    const isImage =
                        ct.startsWith('image/') || IMAGE_EXTS.some((ext) => item.path.toLowerCase().endsWith(ext));
                    if (!isImage) {
                        logger.info(`[router] skipping non-image media: ${item.path} (${ct})`);
                        continue;
                    }
                    try {
                        const dataUri = imageToDataUri(item.path);
                        userMessage.content.push(new ImageMessagePart(dataUri));
                        logger.info(`[router] attached inbound image: ${item.path} (${ct})`);
                    } catch (err: any) {
                        logger.warn(`[router] failed to read inbound image ${item.path}: ${err?.message || err}`);
                    }
                }
            }

            const assistantMessage = new AssistantMessage();
            task.chat_context.appendMessage(userMessage);
            task.chat_context.appendMessage(assistantMessage);

            const toolsets = await ApplicationRegistry.listAvailableToolsets();
            const skillToolset = SkillRegistry.getInstance().getToolset();
            const memoryToolset = createMemoryToolset();
            task.chat_context.attachToolsets(...toolsets);
            task.chat_context.attachToolsets(skillToolset);
            task.chat_context.attachToolsets(memoryToolset);
            for (const ts of this.extraToolsets) {
                task.chat_context.attachToolsets(ts);
            }

            task.processTaskTurn();
            await task.waitUntilFinished();

            return this.extractReply(task);
        } catch (err) {
            task.task_status = 'stopped';
            task.finished_at = new Date();
            task.task_manager_state.publishTaskListUpdate();
            throw err;
        }
    }

    /**
     * Extract reply text and media files from relevant AssistantMessages.
     *
     * "Relevant" AssistantMessages are those that come after the last non-internal
     * UserMessage (i.e., the last real user message, excluding internal messages
     * generated by hooks like reject messages).
     *
     * The return value consists of:
     * 1. All SendFile tool calls from relevant AssistantMessages (in order)
     * 2. The last TextMessagePart from the relevant AssistantMessages as reply text
     */
    private extractReply(task: TaskState): ChannelReply | null {
        const mediaUrls: string[] = [];

        logger.info(`[router] extractReply: total messages=${task.chat_context.messages.length}`);

        // Find the last non-internal UserMessage
        let lastUserMsgIdx = -1;
        for (let i = task.chat_context.messages.length - 1; i >= 0; i--) {
            const msg = task.chat_context.messages[i];
            if (msg instanceof UserMessage && !msg.internal) {
                lastUserMsgIdx = i;
                break;
            }
        }

        if (lastUserMsgIdx === -1) {
            logger.info(`[router] extractReply: no non-internal UserMessage found`);
            return null;
        }

        // Collect all AssistantMessages after the last UserMessage
        const relevantAssistantMessages: AssistantMessage[] = [];
        for (let i = lastUserMsgIdx + 1; i < task.chat_context.messages.length; i++) {
            const msg = task.chat_context.messages[i];
            if (msg instanceof AssistantMessage) {
                relevantAssistantMessages.push(msg);
            }
        }

        if (relevantAssistantMessages.length === 0) {
            logger.info(`[router] extractReply: no relevant AssistantMessages`);
            return null;
        }

        logger.info(`[router] extractReply: found ${relevantAssistantMessages.length} relevant AssistantMessages`);

        // Collect all SendFile tool calls from relevant AssistantMessages (in order)
        let lastTextPart: TextMessagePart | null = null;
        for (const msg of relevantAssistantMessages) {
            for (const part of msg.content) {
                if (part.type === 'tool_call') {
                    for (const tc of part.toolcalls) {
                        if (tc.tool_name === SEND_FILE_TOOL_NAME && tc.status === 'success') {
                            const filePath = tc.args_object?.filePath;
                            logger.info(`[router] SendFile success, filePath=${filePath}`);
                            if (filePath) {
                                mediaUrls.push(filePath);
                            }
                        }
                    }
                }
            }
            // Track the last text part (we scan in order, so later messages overwrite)
            for (let partIdx = msg.content.length - 1; partIdx >= 0; partIdx--) {
                const part = msg.content[partIdx];
                if (part.type === 'text' && (part as any).text) {
                    lastTextPart = part as TextMessagePart;
                    break;
                }
            }
        }

        const text = lastTextPart ? lastTextPart.text.trim() : '';
        logger.info(`[router] extractReply result: text_len=${text.length}, mediaUrls=${mediaUrls.length}`);

        if (!text && mediaUrls.length === 0) return null;
        return { text, mediaUrls };
    }
}
