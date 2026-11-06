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
 * 渠道斜杠命令层：在入站消息进入任务路由之前拦截渠道侧命令（/new、/list、/switch 等）。
 *
 * TUI 的斜杠命令注册表与渠道路径相互独立，本层只服务渠道入站消息：
 * 命令命中后不再进入 AI 任务路由，回执经来源会话原路发回。
 */

import type { InboundChannelMessage } from './types.js';
import type { ChannelMessageRouter } from './router.js';
import type { ChannelInteractionService } from './interactions.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { Participant } from '../../aikernel/types/index.js';
import { logger } from '../../utils/logger.js';
import { t as tLocal } from './locale/index.js';

/** 命令名匹配：/new、/list、/switch 等；参数为命令名后的剩余文本 */
const COMMAND_PATTERN = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/;

/** /list 编号列表的有效期：超过后 /switch 的编号失效，需重新 /list */
const TASK_LIST_TTL_MS = 10 * 60_000;

/** /list 默认展示的最近对话数量 */
const TASK_LIST_DEFAULT = 10;

/** /list N 可指定的最大数量（防止渠道消息过长） */
const TASK_LIST_LIMIT_MAX = 100;

/** 严格正整数解析：只接受纯数字参数，避免 "3abc" 被 parseInt 宽松截断成 3 */
function parsePositiveInt(text: string): number | undefined {
    if (!/^\d+$/.test(text)) return undefined;
    const value = Number.parseInt(text, 10);
    return value > 0 ? value : undefined;
}

export interface ChannelCommandContext {
    /** 触发命令的入站消息（含 channel/account/sender 上下文） */
    message: InboundChannelMessage;
    /** 回执目标（私聊 = senderId，群聊 = groupId） */
    recipientId: string;
    /** 发送文本回执到来源会话 */
    reply: (text: string) => Promise<void>;
}

export interface ChannelCommand {
    name: string;
    /**
     * 执行命令。restText 为命令名后的剩余文本（已去首尾空白）。
     * 抛错由 bus 捕获并向用户回执执行失败。
     */
    execute(ctx: ChannelCommandContext, restText: string): Promise<void>;
}

export class ChannelCommandBus {
    private commands = new Map<string, ChannelCommand>();

    register(command: ChannelCommand): void {
        this.commands.set(command.name, command);
    }

    /**
     * 尝试把入站消息解析为渠道命令。
     * 返回 true 表示命令已消费（不再进入任务路由）；false 表示普通消息，继续走任务路由。
     * 以 `/name` 开头但 name 未注册的消息（如 `/etc/hosts`）按普通消息处理。
     */
    async tryHandle(message: InboundChannelMessage, reply: (text: string) => Promise<void>): Promise<boolean> {
        const text = (message.text || '').trim();
        const match = text.match(COMMAND_PATTERN);
        if (!match) return false;

        const command = this.commands.get(match[1]);
        if (!command) return false;

        const recipientId = message.chatType === 'group' && message.groupId ? message.groupId : message.senderId;
        try {
            await command.execute({ message, recipientId, reply }, (match[2] || '').trim());
        } catch (err: any) {
            logger.error(`[commands] /${command.name} 执行失败: ${err?.message || err}`);
            try {
                await reply(`${tLocal('channel.command.executeFailed')}: ${err?.message || err}`);
            } catch (replyErr: any) {
                logger.error(`[commands] 命令回执发送失败: ${replyErr?.message || replyErr}`);
            }
        }
        return true;
    }
}

/** /new：无参时解绑当前会话激活任务；带参时创建新任务并把参数文本作为首条消息投递。 */
export function createNewTaskCommand(deps: { router: ChannelMessageRouter }): ChannelCommand {
    return {
        name: 'new',
        async execute(ctx, restText) {
            const { message, recipientId } = ctx;
            if (!restText) {
                deps.router.unbindActiveTask(message.channelId, message.accountId, recipientId);
                await ctx.reply(tLocal('channel.command.newSessionStarted'));
                return;
            }
            // /new xxx：xxx 作为新任务的首条用户消息，走完整路由（创建、命名、回复回传）
            const reply = await deps.router.startNewTaskWithMessage({ ...message, text: restText });
            // 正常回复由 afterFinishTurn 发回渠道；只有「任务没跑起来」的错误回执需要在这里补发
            if (reply?.error) await ctx.reply(reply.text);
        }
    };
}

/** 文本回退路径的 /list 编号映射：binding key → 最近一次推送的任务 id 列表。 */
export interface PendingTaskListStore {
    set(key: string, taskIds: string[], expiresAt: number): void;
    /** 读取未过期的编号映射；过期或不存在的 key 返回 undefined（并顺手清理过期项） */
    get(key: string, now: number): string[] | undefined;
}

export class InMemoryPendingTaskListStore implements PendingTaskListStore {
    private lists = new Map<string, { taskIds: string[]; expiresAt: number }>();

    set(key: string, taskIds: string[], expiresAt: number): void {
        this.lists.set(key, { taskIds, expiresAt });
    }

    get(key: string, now: number): string[] | undefined {
        for (const [k, list] of [...this.lists.entries()]) {
            if (list.expiresAt <= now) this.lists.delete(k);
        }
        const list = this.lists.get(key);
        if (!list || list.expiresAt <= now) return undefined;
        return list.taskIds;
    }
}

function taskListKey(message: InboundChannelMessage, recipientId: string): string {
    return `${message.channelId}:${message.accountId}:${recipientId}`;
}

function taskDisplayName(task: TaskState): string {
    return task.task_name || tLocal('channel.task.unnamed');
}

/** 切换会话绑定到指定任务并回执。 */
async function switchSessionTask(
    deps: { router: ChannelMessageRouter },
    ctx: ChannelCommandContext,
    task: TaskState
): Promise<void> {
    deps.router.bindSessionTask(ctx.message.channelId, ctx.message.accountId, ctx.recipientId, task.task_id);
    await ctx.reply(`${tLocal('channel.command.switchedTo')}${taskDisplayName(task)}`);
}

/**
 * /list 的任务可见性。
 *
 * 私聊：放开全局最近任务，支持从手机接管桌面端或其他渠道的对话。
 * 群聊：只列本群自己的对话——群成员不能借 /list 看到主人的私聊任务，
 * 更不能 /switch 过去把私聊内容带进群。
 */
function isTaskVisibleInSession(task: TaskState, message: InboundChannelMessage, recipientId: string): boolean {
    if (message.chatType !== 'group') return true;
    const origin = task.origin;
    return (
        origin?.type === 'channel' &&
        origin.channel === message.channelId &&
        origin.accountId === message.accountId &&
        origin.recipientId === recipientId
    );
}

/** /list：推送最近对话列表（卡片优先，渠道不支持交互时回退编号文本 + /switch 切换）。 */
export function createListCommand(deps: {
    router: ChannelMessageRouter;
    interactionService: ChannelInteractionService;
    pendingTaskLists: PendingTaskListStore;
}): ChannelCommand {
    /** 推送编号文本列表（渠道不支持交互时的主路径，卡片发送失败时的兜底共用）。 */
    const replyTaskList = async (
        ctx: ChannelCommandContext,
        tasks: TaskState[],
        optionLabel: (task: TaskState) => string
    ): Promise<void> => {
        const lines = tasks.map((task, i) => `${i + 1}. ${optionLabel(task)}`);
        await ctx.reply(
            `${tLocal('channel.command.listHeader')}:\n${lines.join('\n')}\n\n${tLocal('channel.command.listHint')}`
        );
    };
    return {
        name: 'list',
        async execute(ctx, restText) {
            const { message, recipientId } = ctx;
            // /list N：指定展示条数（1~100）；无参或非法参数按默认 10 条
            const limit = Math.min(parsePositiveInt(restText) ?? TASK_LIST_DEFAULT, TASK_LIST_LIMIT_MAX);
            // 与桌面端任务列表同源，可见范围按会话类型收敛（见 isTaskVisibleInSession）
            const tasks = deps.router.listRecentTasks(limit, (task) =>
                isTaskVisibleInSession(task, message, recipientId)
            );

            // 当前激活任务总在列表中：不在最近列表里时追加到末尾，并在名称后标注
            const activeTaskId = deps.router.getActiveSessionTaskId(message.channelId, message.accountId, recipientId);
            if (activeTaskId && !tasks.some((task) => task.task_id === activeTaskId)) {
                const activeTask = deps.router.getTaskById(activeTaskId);
                if (activeTask) tasks.push(activeTask);
            }
            if (tasks.length === 0) {
                await ctx.reply(tLocal('channel.command.listEmpty'));
                return;
            }

            // 编号映射与渲染路径无关：卡片渠道（含微信等文本模拟渠道）同样记录，
            // 保证 /switch N 在任何渠道都可用（微信侧回复纯序号走 selection 结算，/switch N 走此处）
            deps.pendingTaskLists.set(
                taskListKey(message, recipientId),
                tasks.map((task) => task.task_id),
                Date.now() + TASK_LIST_TTL_MS
            );
            const optionLabel = (task: TaskState): string => {
                const base = taskDisplayName(task);
                return task.task_id === activeTaskId ? base + tLocal('channel.command.listCurrentMark') : base;
            };

            // 卡片路径：渠道支持结构化交互时推单选卡片。点选最长可等待 5 分钟（卡片 TTL），
            // 入站消息按渠道维度串行处理，因此这里不能 await——否则会阻塞该账号的后续消息。
            if (deps.interactionService.supportsInteractive(message.channelId)) {
                // chatType 决定渠道选择接收方类型（群聊 = 群 ID，私聊 = 用户 ID）
                const participant: Participant = {
                    type: 'channel',
                    channel: message.channelId,
                    accountId: message.accountId,
                    recipientId,
                    chatType: message.chatType
                };
                void deps.interactionService
                    .requestSelection(participant, {
                        header: tLocal('channel.command.listHeader'),
                        hint: tLocal('channel.command.listHint'),
                        options: tasks.map((task) => ({
                            label: optionLabel(task),
                            value: task.task_id
                        }))
                    })
                    .then(async (outcome) => {
                        if (outcome.error) {
                            // 卡片发送失败（如选项数量超出平台限制）：回退文本列表，保证用户仍能 /switch
                            logger.warn(
                                `[commands] /list selection card failed, falling back to text list: ${outcome.error}`
                            );
                            await replyTaskList(ctx, tasks, optionLabel);
                            return;
                        }
                        if (!outcome.selected) return; // 用户取消或卡片超时：不回执不打扰
                        const task = deps.router.getTaskById(outcome.selected);
                        // 卡片最长可挂 5 分钟：目标可能已被删除，或已被别的会话接管而不再可见
                        if (!task || !isTaskVisibleInSession(task, ctx.message, ctx.recipientId)) {
                            await ctx.reply(tLocal('channel.command.invalidSwitchTarget'));
                            return;
                        }
                        await switchSessionTask(deps, ctx, task);
                    })
                    .catch(async (err: unknown) => {
                        logger.error(`[commands] /list selection failed: ${err instanceof Error ? err.message : err}`);
                        // 卡片链路整体异常时也要让用户拿到可用列表；兜底回执再失败就只记日志，
                        // 不能让 promise 链尾部留下未处理的拒绝
                        try {
                            await replyTaskList(ctx, tasks, optionLabel);
                        } catch (replyErr: unknown) {
                            logger.error(
                                `[commands] /list fallback reply failed: ${replyErr instanceof Error ? replyErr.message : replyErr}`
                            );
                        }
                    });
                return;
            }

            // 文本回退：推送编号列表（附 /list N 与 /switch 提示），用户以 /switch N 切换（仅匹配本次推送）
            await replyTaskList(ctx, tasks, optionLabel);
        }
    };
}

/** /switch N：切换到最近一次 /list 编号列表中的第 N 项（仅文本回退路径使用）。 */
export function createSwitchCommand(deps: {
    router: ChannelMessageRouter;
    pendingTaskLists: PendingTaskListStore;
}): ChannelCommand {
    return {
        name: 'switch',
        async execute(ctx, restText) {
            const index = parsePositiveInt(restText);
            const taskIds =
                index === undefined
                    ? undefined
                    : deps.pendingTaskLists.get(taskListKey(ctx.message, ctx.recipientId), Date.now());
            const task =
                taskIds && index !== undefined && index <= taskIds.length
                    ? deps.router.getTaskById(taskIds[index - 1])
                    : undefined;
            // 编号列表有 10 分钟有效期，期间任务可能已被别的会话接管而不再对本会话可见：
            // 切之前按当前可见性再校验一次，避免拿过期列表绕过 /list 的范围收敛
            if (!task || !isTaskVisibleInSession(task, ctx.message, ctx.recipientId)) {
                await ctx.reply(tLocal('channel.command.invalidSwitchIndex'));
                return;
            }
            await switchSessionTask(deps, ctx, task);
        }
    };
}
