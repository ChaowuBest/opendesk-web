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

/**
 * Routes inbound channel messages to the task system and collects assistant replies.
 */

import { TaskManagerState, TaskState } from '../../states/tasks.js';
import { UserMessage, AssistantMessage } from '../../aikernel/messages.js';
import { ApplicationRegistry } from '../registry.js';
import { SkillRegistry } from '../../aikernel/skill.js';
import { createMemoryToolset } from '../../aikernel/memory/tools.js';
import { logger } from '../../utils/logger.js';
import type { InboundChannelMessage } from '../../aikernel/plugins/types.js';
import type { AgentDecl } from '../../aikernel/agent.js';


/**
 * Maps session keys (channelId:accountId:senderId) to active task IDs
 * so that follow-up messages from the same sender continue the same session.
 */
const sessionMap = new Map<string, string>();

export class ChannelMessageRouter {

    private taskManagerState: TaskManagerState;
    private agentDecl: AgentDecl;
    private model?: string;

    constructor(taskManagerState: TaskManagerState, agentDecl: AgentDecl, model?: string) {
        this.taskManagerState = taskManagerState;
        this.agentDecl = agentDecl;
        this.model = model;
    }

    /**
     * Route an inbound channel message to the task system.
     * Creates or reuses a session/task for the sender, runs the AI agent,
     * and returns the assistant's reply text.
     */
    async routeInboundMessage(message: InboundChannelMessage): Promise<string | null> {
        const sessionKey = `${message.channelId}:${message.accountId}:${message.senderId}`;

        // Find or create a task for this session
        let task: TaskState;
        try {
            task = this.findActiveTask(sessionKey) ?? await this.createSessionTask(sessionKey, message);
        } catch (err: any) {
            logger.error(`创建消息会话失败: ${err?.message || err}`);
            return `抱歉，系统在创建会话时遇到了问题：${err?.message || err}\n请联系管理员检查系统配置。`;
        }

        // Wait for any currently running interaction to complete
        if (task.task_status === 'running') {
            await task.waitUntilFinished();
        }

        // Prepare the user message with channel context
        const userText = this.formatInboundMessage(message);

        // Submit and wait for assistant reply
        try {
            const reply = await this.submitAndWaitForReply(task, userText);
            return reply;
        } catch (err: any) {
            logger.error(`消息插件处理失败: ${err?.message || err}`);
            return this.buildErrorReply(err);
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

    private findActiveTask(sessionKey: string): TaskState | undefined {
        const taskId = sessionMap.get(sessionKey);
        if (!taskId) return undefined;
        const task = this.taskManagerState.getTask(taskId);
        if (!task) {
            sessionMap.delete(sessionKey);
            return undefined;
        }
        return task;
    }

    private async createSessionTask(sessionKey: string, message: InboundChannelMessage): Promise<TaskState> {
        const task = this.taskManagerState.createTask(this.model);
        const systemPrompt = await this.agentDecl.createSystemPrompt();

        const channelContext = [
            systemPrompt,
            '',
            '--- Channel Context ---',
            `Channel: ${message.channelId}`,
            `Sender: ${message.senderName || message.senderId}`,
            message.chatType === 'group' ? `Group: ${message.groupName || message.groupId}` : '',
            'Please respond concisely and naturally, as this is a chat message from a messaging platform.',
        ].filter(Boolean).join('\n');

        await task.setSystemPrompt(channelContext);

        task.task_name = `消息: ${message.senderName || message.senderId}`;
        sessionMap.set(sessionKey, task.task_id);

        return task;
    }

    private formatInboundMessage(message: InboundChannelMessage): string {
        let text = message.text || '';
        if (message.senderName && message.chatType === 'group') {
            text = `[${message.senderName}] ${text}`;
        }
        return text;
    }

    private async submitAndWaitForReply(task: TaskState, userText: string): Promise<string | null> {
        task.task_status = 'running';
        task.started_at = new Date();
        task.finished_at = undefined;
        task.task_manager_state.publishTaskListUpdate();

        try {
            const userMessage = new UserMessage(userText);
            const assistantMessage = new AssistantMessage();
            task.chat_context.appendMessage(userMessage);
            task.chat_context.appendMessage(assistantMessage);

            const toolsets = await ApplicationRegistry.listAvailableToolsets();
            const skillToolset = SkillRegistry.getInstance().getToolset();
            const memoryToolset = createMemoryToolset();
            task.chat_context.attachToolsets(...toolsets);
            task.chat_context.attachToolsets(skillToolset);
            task.chat_context.attachToolsets(memoryToolset);

            task.processTask();
            await task.waitUntilFinished();

            const lastMsg = task.chat_context.lastMessage();
            if (lastMsg instanceof AssistantMessage) {
                const texts: string[] = [];
                for (const part of lastMsg.content) {
                    if (part.type === 'text' && (part as any).text) {
                        texts.push((part as any).text);
                    }
                }
                return texts.join('\n') || null;
            }
            return null;
        } catch (err) {
            task.task_status = 'stopped';
            task.finished_at = new Date();
            task.task_manager_state.publishTaskListUpdate();
            throw err;
        }
    }
}