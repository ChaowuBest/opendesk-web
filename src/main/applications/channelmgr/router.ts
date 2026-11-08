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

import type { TaskManagerState, TaskState, TurnInteractionBinding } from '../../aikernel/states/tasks.js';
import {
    UserMessage,
    AssistantMessage,
    ImageMessagePart,
    imageToDataUri,
    type TextMessagePart
} from '../../aikernel/messages.js';
import { ApplicationRegistry } from '../registry.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { logger } from '../../utils/logger.js';
import { LLM } from '../../aikernel/llm.js';
import { Setting } from '../../utils/setting.js';
import type { Participant } from '../../aikernel/types/index.js';
import type { InboundChannelMessage } from './types.js';
import { switchTaskMode } from '../../aikernel/task/mode.js';
import { createChannelDenyPermissionProvider } from './channel-task-interactions.js';
import { SEND_FILE_TOOL_NAME } from './tools.js';
import {
    createDispatchPolicy,
    normalizeDispatchPolicy,
    type DispatchPolicyConfig,
    type TaskDispatchPolicy
} from './dispatch/policy.js';
import { ActiveTaskRegistry } from './dispatch/registry.js';

export interface ChannelReply {
    text: string;
    mediaUrls: string[];
    /**
     * 会话没能跑起来时生成的错误回执（建会话失败 / 提交消息失败）。
     *
     * 这类回复不会有 turn 结束事件，afterFinishTurn 钩子不会回传，必须由调用方直接投递，
     * 否则渠道用户只会看到「已读不回」。
     */
    error?: boolean;
}

/** 渠道账号的运行时设定：从该账号进入的消息自动使用这些配置 */
export interface AccountRuntime {
    workspace?: string;
    agentId?: string;
    modeId?: string;
    model?: string;
    /** 消息分发策略（复用当前激活任务 / 超时切换 / 智能投递），未配置时使用默认策略 */
    dispatchPolicy?: DispatchPolicyConfig;
}

/** smart 策略 LLM 关联性判定的超时保护 */
const RELEVANCE_CHECK_TIMEOUT_MS = 8000;

/** 智能投递摘要的单条消息文本截断长度 */
const SUMMARY_TEXT_TRUNCATE = 200;

/**
 * 任务最近一次活动的时间戳：取 updated_at / finished_at / created_at 的最大值。
 *
 * 任务可能被桌面端或其他会话继续对话（复用同一个 task），只看渠道绑定的活动时间
 * 会把「刚聊过的任务」判成空闲已久的旧会话。
 */
function taskActivityAt(task: TaskState): number {
    return Math.max(task.updated_at?.getTime() ?? 0, task.finished_at?.getTime() ?? 0, task.created_at?.getTime() ?? 0);
}

export class ChannelMessageRouter {
    private taskManagerState: TaskManagerState;
    private model?: string;
    private workspace: string;
    private extraToolsets: BaseToolset[] = [];

    /** 渠道会话 → 激活任务绑定；默认内存态，宿主可注入持久化实现 */
    private registry = new ActiveTaskRegistry();

    /**
     * 解析指定渠道账号的运行时设定（workspace / agentId / model）。
     * 从该 account 进入的消息自动使用这些设定；未配置时回退到全局值。
     */
    private getAccountRuntime?: (channelId: string, accountId: string) => AccountRuntime | undefined;

    /**
     * 当消息被路由到任务时的回调。
     * 在 AI 处理之前触发，以便前端可以切换到对应的任务并显示实时处理过程。
     */
    onTaskResolved?: (task: TaskState, message: InboundChannelMessage) => void;

    constructor(
        taskManagerState: TaskManagerState,
        workspace: string,
        model?: string,
        getAccountRuntime?: (channelId: string, accountId: string) => AccountRuntime | undefined
    ) {
        this.taskManagerState = taskManagerState;
        this.workspace = workspace;
        this.model = model;
        this.getAccountRuntime = getAccountRuntime;
    }

    addExtraToolset(toolset: BaseToolset): void {
        this.extraToolsets.push(toolset);
    }

    /** 由 channelmgr 注入账号级运行时设定解析器（workspace/agentId/model）。 */
    setAccountRuntimeResolver(resolver: (channelId: string, accountId: string) => AccountRuntime | undefined): void {
        this.getAccountRuntime = resolver;
    }

    /** 由宿主注入带持久化存储的激活任务注册表（未注入时为纯内存态，重启丢失）。 */
    setActiveTaskRegistry(registry: ActiveTaskRegistry): void {
        this.registry = registry;
    }

    /**
     * 渠道命令 /new <消息>：解绑当前会话的激活任务，创建新任务并把消息作为首条对话投递。
     * 解绑后走正常路由流程，任务创建、命名、回复回传等全部复用现有管道。
     */
    async startNewTaskWithMessage(message: InboundChannelMessage): Promise<ChannelReply | null> {
        const recipientId = message.chatType === 'group' && message.groupId ? message.groupId : message.senderId;
        this.registry.unbind(message.channelId, message.accountId, recipientId);
        return this.routeInboundMessage(message);
    }

    /** 渠道命令 /new：解绑当前会话的激活任务，下一条消息将创建新任务。 */
    unbindActiveTask(channelId: string, accountId: string, recipientId: string): void {
        this.registry.unbind(channelId, accountId, recipientId);
    }

    /** 渠道命令 /list /switch：把会话绑定切换到指定任务；回复出口在下一条消息复用时接管。 */
    bindSessionTask(channelId: string, accountId: string, recipientId: string, taskId: string): void {
        this.registry.bind(channelId, accountId, recipientId, taskId);
    }

    /** 渠道命令 /list：按 id 查找任务（找不到返回 undefined）。 */
    getTaskById(taskId: string): TaskState | undefined {
        return this.taskManagerState.getTask(taskId);
    }

    /** 渠道命令 /list：读取会话当前绑定的激活任务 id（未绑定返回 undefined）。 */
    getActiveSessionTaskId(channelId: string, accountId: string, recipientId: string): string | undefined {
        return this.registry.getActiveTaskId(channelId, accountId, recipientId);
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
        this.registry.bind(participant.channel, participant.accountId, participant.recipientId, taskId);
        logger.info(
            `[router] registered task ${taskId} for participant ${participant.channel}:${participant.accountId}:${participant.recipientId}${taskName ? ` (${taskName})` : ''}`
        );
    }

    /**
     * 获取指定渠道/账号下所有已知的会话接收者列表。
     * 从激活任务注册表中提取，用于 UI 选择投递目标时枚举可选联系人/群组。
     */
    getKnownRecipients(channelId: string, accountId: string): { recipientId: string; taskName?: string }[] {
        const recipients: { recipientId: string; taskName?: string }[] = [];
        for (const bound of this.registry.listChannelEntries(channelId)) {
            if (bound.accountId !== accountId || !bound.recipientId) continue;
            const task = this.taskManagerState.getTask(bound.entry.taskId);
            recipients.push({ recipientId: bound.recipientId, taskName: task?.task_name || undefined });
        }
        return recipients;
    }

    /**
     * Route an inbound channel message to the task system.
     * Creates or reuses a session/task for the sender, runs the AI agent,
     * and returns the assistant's reply text.
     */
    async routeInboundMessage(message: InboundChannelMessage): Promise<ChannelReply | null> {
        // For group messages, use groupId as the conversation key so all members share the same task.
        // For direct messages, use senderId.
        const recipientId = message.chatType === 'group' && message.groupId ? message.groupId : message.senderId;
        const taskKey = `${message.channelId}:${message.accountId}:${recipientId}`;

        let task: TaskState;
        try {
            task = await this.resolveSessionTask(taskKey, message);
        } catch (err: any) {
            logger.error(`创建消息会话失败: ${err?.message || err}`);
            return {
                text: `抱歉，系统在创建会话时遇到了问题：${err?.message || err}\n请联系管理员检查系统配置。`,
                mediaUrls: [],
                error: true
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
            this.registry.touch(message.channelId, message.accountId, recipientId);
            return reply;
        } catch (err: any) {
            logger.error(`消息插件处理失败: ${err?.message || err}`);
            return { text: this.buildErrorReply(err), mediaUrls: [], error: true };
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
     * 1. 公共前置：无绑定或绑定任务已失效 → 一律新建任务。
     * 2. 存在有效激活任务 → 按账号的分发策略（sticky/timeout/smart）判定复用或新建。
     */
    private async resolveSessionTask(taskKey: string, message: InboundChannelMessage): Promise<TaskState> {
        const recipientId = message.chatType === 'group' && message.groupId ? message.groupId : message.senderId;
        const activeTaskId = this.registry.getActiveTaskId(message.channelId, message.accountId, recipientId);

        // 绑定指向的任务已不存在（被删除等）：清除绑定后新建
        if (activeTaskId) {
            this.registry.evictIfInvalid(
                message.channelId,
                message.accountId,
                recipientId,
                (taskId) => !!this.taskManagerState.getTask(taskId)
            );
        }

        const entry = this.registry.getEntry(message.channelId, message.accountId, recipientId);
        if (!entry) {
            return this.createSessionTask(message);
        }

        const task = this.taskManagerState.getTask(entry.taskId);
        if (!task) {
            // evictIfInvalid 与 getTask 之间的窄窗口兜底
            this.registry.unbind(message.channelId, message.accountId, recipientId);
            return this.createSessionTask(message);
        }
        // 重启后任务通常只是 task_list.json 里的轻量壳：策略要读对话摘要、复用要改 origin，
        // 不先加载会拿到空历史（smart 判定退化成「无历史」），origin 改动还会被脏标记保护丢弃。
        task.ensureLoaded();

        const policy = this.getDispatchPolicy(message.channelId, message.accountId);
        const decision = await policy.decide({
            // 任务自身也可能在桌面端 / 其他会话被继续，活动时间取两者的较大值
            lastActivityAt: Math.max(entry.updatedAt, taskActivityAt(task)),
            inboundText: message.text || '',
            recentTurnsText: this.getRecentConversationSummary(task),
            now: Date.now()
        });

        if (decision.action === 'create') {
            logger.info(`[router] 会话 ${taskKey} 按策略 ${policy.id} 创建新任务: ${decision.reason}`);
            return this.createSessionTask(message);
        }

        // 复用时先刷新绑定活动时间，即使后续 submitAndWaitForReply 失败时间基准仍正确
        this.registry.touch(message.channelId, message.accountId, recipientId);
        // 本次消息所属的会话成为任务的渠道出口：渠道回复由 afterFinishTurn 按 task.origin 投递，
        // 复用到桌面端或其他会话的任务（/switch 之后）时若不接管，用户只会看到沉默。
        await this.adoptChannelOrigin(task, {
            channel: message.channelId,
            accountId: message.accountId,
            recipientId,
            chatType: message.chatType
        });
        await this.syncTaskMode(task, message);
        return task;
    }

    /** 按账号运行时配置解析分发策略；未配置时使用默认策略（timeout / 1 天）。 */
    private getDispatchPolicy(channelId: string, accountId: string): TaskDispatchPolicy {
        const runtime = this.getAccountRuntime?.(channelId, accountId);
        const config = normalizeDispatchPolicy(runtime?.dispatchPolicy);
        return createDispatchPolicy(config, {
            judge: (input) => this.judgeRelevance(input),
            onJudgeError: (err) =>
                logger.warn(`[router] 智能投递关联性判定失败，回退到超时判断: ${(err as Error)?.message || err}`)
        });
    }

    /**
     * 智能投递的关联性判定：使用与对话命名一致的轻量模型（default_quick_model），
     * 根据激活任务最近的对话判断新消息属于已有任务还是新任务。
     * 返回 true = 已有任务（复用），false = 新任务；抛错由 SmartPolicy 兜底。
     */
    private async judgeRelevance(input: { recentTurnsText: string | null; inboundText: string }): Promise<boolean> {
        if (!input.recentTurnsText) return true; // 无历史可比较，保持会话

        // 与 generateTaskName 同源的模型选择：default_quick_model 优先，回退任务默认模型
        const model = Setting.getInstance().getData().default_quick_model || this.model;
        const prompt = [
            '你是一个会话管理助手。请判断用户的新消息是要继续之前的对话，还是要开启一个新话题。',
            '',
            '之前的对话记录：',
            input.recentTurnsText,
            '',
            '用户的新消息：',
            input.inboundText,
            '',
            '请仅回答 "已有任务" 或 "新任务"，不要包含其他内容。'
        ].join('\n');

        // 超时保护：race 结束后清理定时器，避免无谓挂起
        let timeoutId: NodeJS.Timeout | undefined;
        const answer = await Promise.race([
            LLM.ask(prompt, model, {
                // 与对话命名一致：取模型支持的最低推理档位（glm-5.3 等不支持关闭思考）
                reasoningEffort: LLM.getMinimalReasoningEffort(model)
            }),
            new Promise<string>((_, reject) => {
                timeoutId = setTimeout(
                    () => reject(new Error('LLM relevance check timeout')),
                    RELEVANCE_CHECK_TIMEOUT_MS
                );
            })
        ]).finally(() => clearTimeout(timeoutId));

        // 模型只应回答「已有任务」或「新任务」；「新任务」是唯一的新建信号，
        // 回答不可解析时保守复用当前会话（与判定失败时的兜底一致，避免误开新任务）
        return !answer.includes('新任务');
    }

    /**
     * 将任务运行模式同步为账号当前运行时设定（modeId）。
     *
     * 同一 channel 会话（taskKey 相同、时间接近）会复用同一个任务；若用户在两轮消息之间
     * 修改了账号的运行模式（如 标准模式→效率模式），复用时不更新会导致用户设置的模式失效。
     * 仅当账号显式配置了 modeId 且与任务当前模式不一致时才切换；未配置时不干预任务模式。
     */
    private async syncTaskMode(task: TaskState, message: InboundChannelMessage): Promise<void> {
        const runtime = this.getAccountRuntime?.(message.channelId, message.accountId);
        const modeId = runtime?.modeId;
        if (!modeId) return;

        const currentModeId = task.activeModeId || task.getAgentMode().id;
        if (currentModeId === modeId) return;

        // 模式切换发生在 turn 起点之前：重建的 harness 只沿用任务默认 provider，
        // 渠道 provider 由随后本轮 turn 的绑定覆盖（见 submitAndWaitForReply），不写进任务默认。
        // 任务默认缺失时用 deny 兜底，避免权限请求悬挂等待。
        try {
            const switched = await switchTaskMode(task, modeId, () => createChannelDenyPermissionProvider());
            if (switched) {
                logger.info(`[router] 任务 ${task.task_id} 模式已随账号设定同步: ${currentModeId} -> ${modeId}`);
            } else {
                logger.warn(`[router] 任务 ${task.task_id} 模式同步失败（无效模式或 agent 不支持）: ${modeId}`);
            }
        } catch (err: any) {
            logger.warn(`[router] 任务 ${task.task_id} 模式同步异常: ${err?.message || err}`);
        }
    }

    /**
     * 提取激活任务最近的对话文本摘要（供 smart 策略判定）：
     * 最近 2 条用户消息 + 最近 2 条助手文本回复，按消息时间顺序交错输出。
     */
    private getRecentConversationSummary(task: TaskState, maxUser = 2, maxAssistant = 2): string | null {
        const userParts: { index: number; label: string; text: string }[] = [];
        const assistantParts: { index: number; label: string; text: string }[] = [];

        for (let i = task.chat_context.messages.length - 1; i >= 0; i--) {
            if (userParts.length >= maxUser && assistantParts.length >= maxAssistant) break;
            const msg = task.chat_context.messages[i];
            if (msg instanceof UserMessage && userParts.length < maxUser) {
                const text = this.extractTextPart(msg.content);
                if (text) userParts.push({ index: i, label: '[用户]', text });
            } else if (msg instanceof AssistantMessage && assistantParts.length < maxAssistant) {
                const text = this.extractTextPart(msg.content);
                if (text) assistantParts.push({ index: i, label: '[助手]', text });
            }
        }

        const merged = [...userParts, ...assistantParts].sort((a, b) => a.index - b.index);
        if (merged.length === 0) return null;
        return merged.map((part) => `${part.label}: ${part.text}`).join('\n');
    }

    /** 合并消息中的全部 text part 并截断；无文本时返回 null。 */
    private extractTextPart(content: Array<{ type: string; text?: string }>): string | null {
        let text = '';
        for (const part of content) {
            if (part.type === 'text' && part.text) {
                text += (text ? '\n' : '') + part.text;
            }
        }
        text = text.trim();
        if (!text) return null;
        return text.length > SUMMARY_TEXT_TRUNCATE ? text.slice(0, SUMMARY_TEXT_TRUNCATE) + '...' : text;
    }

    /**
     * 渠道命令 /list：列出全局最近 maxCount 个主任务（与桌面端任务列表同源：
     * 排除子任务与 internal 任务，按最近活动时间 updated_at / finished_at /
     * created_at 取最大值降序），供用户在渠道侧切换到任意最近对话。
     *
     * @param filter 可选的可见性过滤，在截断前生效（调用方按会话类型收窄范围）
     */
    listRecentTasks(maxCount: number, filter?: (task: TaskState) => boolean): TaskState[] {
        return this.taskManagerState.tasks
            .filter((task) => !task.parent_id && task.internal !== true)
            .filter((task) => (filter ? filter(task) : true))
            .sort((a, b) => taskActivityAt(b) - taskActivityAt(a))
            .slice(0, maxCount);
    }

    /**
     * 从已持久化的渠道任务恢复会话绑定（应用启动时调用一次）。
     * 同一会话命中多个任务时取最近活跃的一个；不覆盖内存中已有的绑定（运行中会话优先）。
     */
    restoreSessionBindings(): void {
        const latest = new Map<
            string,
            { channelId: string; accountId: string; recipientId: string; taskId: string; at: number }
        >();
        for (const task of this.taskManagerState.tasks) {
            const origin = task.origin;
            if (origin?.type !== 'channel') continue;
            const at = taskActivityAt(task);
            const key = `${origin.channel}:${origin.accountId}:${origin.recipientId}`;
            const existing = latest.get(key);
            if (!existing || at > existing.at) {
                latest.set(key, {
                    channelId: origin.channel,
                    accountId: origin.accountId,
                    recipientId: origin.recipientId,
                    taskId: task.task_id,
                    at
                });
            }
        }
        for (const entry of latest.values()) {
            if (this.registry.getActiveTaskId(entry.channelId, entry.accountId, entry.recipientId)) continue;
            this.registry.bind(entry.channelId, entry.accountId, entry.recipientId, entry.taskId);
            logger.info(
                `[router] restored session binding ${entry.channelId}:${entry.accountId}:${entry.recipientId} -> ${entry.taskId}`
            );
        }
    }

    private async createSessionTask(message: InboundChannelMessage): Promise<TaskState> {
        // 账号级运行时设定：workspace / agentId / model 优先于全局值
        const runtime = this.getAccountRuntime?.(message.channelId, message.accountId);
        const model = runtime?.model || this.model;
        const workspace = runtime?.workspace || this.workspace;

        const task = this.taskManagerState.createTask(model);

        // 未指定或选择 main 时保留 TaskState 默认的主 Agent；无效 agentId 由 TaskState 回退主 Agent。
        const effectiveAgentId = runtime?.agentId && runtime.agentId !== 'main' ? runtime.agentId : undefined;
        if (effectiveAgentId) {
            task.agentId = effectiveAgentId;
        }
        // 指定 agent 的运行模式（只读/标准/效率），无效时 TaskState 回退该 agent 默认模式
        if (runtime?.modeId) {
            task.activeModeId = runtime.modeId;
        }

        // 渠道任务不走 GUI 的 initHarness 路径，必须自行初始化带权限执行器的 harness。
        // 若沿用 createEmpty()（permission 为 null），handleToolPermissionsForTask 会
        // 在 `if (!enforcer) return false` 处直接跳过权限检查，导致工作空间外的
        // 敏感操作被直接放行。这里按任务的 agent/mode 构建 enforcer 并授予 artifacts 权限。
        await this.initChannelHarness(task, workspace);

        // Determine reply target: group ID for group chats, sender ID for direct messages
        const replyTarget = message.chatType === 'group' && message.groupId ? message.groupId : message.senderId;

        const channelContext = [
            '--- Channel Context ---',
            `Channel: ${message.channelId}`,
            `Sender: ${message.senderName || message.senderId}`,
            message.chatType === 'group' ? `Group: ${message.groupName || message.groupId}` : '',
            'Please respond concisely and naturally, as this is a chat message from a messaging platform.'
        ]
            .filter(Boolean)
            .join('\n');

        task.setSystemPrompt(channelContext);

        task.origin = {
            type: 'channel',
            channel: message.channelId,
            accountId: message.accountId,
            recipientId: replyTarget,
            // 群聊的 recipientId 是群 ID：后续审批 / askUser 卡片要按它选接收方类型
            chatType: message.chatType
        };
        // 渠道交互归属由本轮 turn 现场声明（见 submitAndWaitForReply），此处只登记出口。
        this.registry.bind(message.channelId, message.accountId, replyTarget, task.task_id);

        return task;
    }

    /**
     * 为渠道任务初始化 harness：复用 GUI 路径的 TaskManagerState.initHarness，
     * 一并获得权限引擎、mode 的工具白/黑名单（allowedTools/disabledTools）、
     * 持久化的 workspace 与平台 harness 注入——这些缺一项都会让渠道任务与桌面端行为不一致。
     *
     * initHarness 内部已兜底异常（退化为空 harness，不阻断会话）。
     */
    private async initChannelHarness(task: TaskState, workspace: string): Promise<void> {
        await this.taskManagerState.initHarness(task, workspace, task.getAgentMode());
    }

    /** 把任务的渠道出口（origin）改为指定会话；已有相同 origin 时不做任何事。 */
    private async adoptChannelOrigin(task: TaskState, origin: Omit<Participant, 'type'>): Promise<void> {
        const current = task.origin;
        if (
            current?.type === 'channel' &&
            current.channel === origin.channel &&
            current.accountId === origin.accountId &&
            current.recipientId === origin.recipientId &&
            current.chatType === origin.chatType
        ) {
            return;
        }
        // 被接管的任务可能是桌面端建好但还没跑过 turn 的空壳（permission 为空）：
        // 那种 harness 会让权限检查整段跳过，必须在接管时补齐。
        // workspace 以任务自身为准（它可能属于别的工作目录），没有再回落到账号/全局设定。
        if (!task.harnessContext?.permission) {
            const runtime = this.getAccountRuntime?.(origin.channel, origin.accountId);
            await this.initChannelHarness(task, task.workspace || runtime?.workspace || this.workspace);
        }
        task.origin = { type: 'channel', ...origin };
        task.persistLater();
        logger.info(
            `[router] 任务 ${task.task_id} 的渠道出口切换为 ${origin.channel}:${origin.accountId}:${origin.recipientId}`
        );
    }

    /** 按渠道交互能力解析本轮 turn 的交互归属（渠道插件可能在运行期启停，每次 turn 重新解析）。 */
    private resolveTurnInteractionBinding(task: TaskState): TurnInteractionBinding | null {
        try {
            const channelMgr = ApplicationRegistry.getApplication('channelmgr') as any;
            return channelMgr?.resolveTurnInteractionBinding?.(task) ?? null;
        } catch (err: any) {
            logger.warn(`[router] resolveTurnInteractionBinding failed: ${err?.message || err}`);
            return null;
        }
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
        task.recordTaskInteraction();
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
                        // 入站图片已下载到本地文件：携带 file_path 以文本引用形式交给模型
                        // （与 GUI 粘贴图片、rewind 重新生成路径一致，模型可通过 readImage/askImage 工具读取）。
                        // 若不带 file_path，supportsVision=false 时该图片 part 会被 toOpenAIMessage 过滤，
                        // 导致模型只收到空文本而误报"用户消息内容为空"。
                        userMessage.content.push(new ImageMessagePart(dataUri, item.path));
                        logger.info(`[router] attached inbound image: ${item.path} (${ct})`);
                    } catch (err: any) {
                        logger.warn(`[router] failed to read inbound image ${item.path}: ${err?.message || err}`);
                    }
                }
            }

            task.chat_context.appendMessage(userMessage);
            for (let i = 0; i < userMessage.content.length; i++) {
                await task.sendSubscriptionFeedback(i);
            }

            const assistantMessage = new AssistantMessage();
            task.chat_context.appendMessage(assistantMessage);

            if (task.task_name === null) {
                task.task_name = '未命名任务';
                task.generateTaskName(userText).then(() => {
                    task.persistLater();
                    task.task_manager_state.publishTaskListUpdate();
                });
            }

            // 本 turn 由渠道入站消息发起：现场声明审批与 askUser 的归属。渠道支持交互则透传到
            // 用户侧，否则直接拒绝且不挂载交互工具。用户回到桌面继续该任务时，
            // submitUserMessage 会重置绑定，权限审批重新回到桌面。
            task.setTurnInteractionBinding(this.resolveTurnInteractionBinding(task));
            const toolsets = await task.buildToolsets();
            await task.rebuildSystemPrompt(toolsets);
            // 非交互渠道本轮不挂载交互工具集，同时清掉上一个交互 turn 残留的那一份
            task.syncManagedToolsets(toolsets);
            for (const ts of this.extraToolsets) {
                task.chat_context.attachToolsets(ts);
            }

            // 标记此 turn 由渠道入站消息触发，用户消息已在渠道侧可见，
            // afterFinishTurn 钩子无需回显用户消息到渠道。
            const channelMgr = ApplicationRegistry.getApplication('channelmgr') as any;
            channelMgr?.markSkipUserEcho?.(task);

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
