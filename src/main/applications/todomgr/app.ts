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

import { BaseApplication } from '../base';
import { t } from './locale/index.js';
import { BaseToolset } from '../../aikernel/tool';
import { Skill } from '../../aikernel/skill.js';
import { z } from 'zod';
import {
    TodoWriteTool,
    AddGlobalTodoTool,
    UpdateGlobalTodoTool,
    ListGlobalTodoDeliverTargetsTool,
    ListGlobalTodosTool,
    DeleteGlobalTodoTool,
    GetCurrentTimeTool,
    GetSupportedEventsTool
} from './tools';
import { getAdaptiveGreen } from '../../tui/theme.js';
import TodoMgrWorker from './worker';
import { MANAGE_GLOBAL_TODOS_SKILL } from './skills.js';
import { ApplicationRegistry } from '../registry.js';
import { GlobalState } from '../../aikernel/states/global.js';
import { AgentRegistry } from '../../aikernel/agents/registry.js';
import { buildTriggerMessage } from './trigger.js';
import { resolveTodoWorkspace } from './workspace.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';
import type { Participant } from '../../plugins/types.js';
import type { TodoWorkspaceConfig } from './common.js';

export class TodoMgrApplication extends BaseApplication {
    constructor() {
        super('todomgr', true);
    }

    getName(): string {
        return t('app.name');
    }

    async getTUIStatusBlock(): Promise<string | null> {
        try {
            const res = await this.callWorker('listGlobalTodos', 'all');
            if (res?.status === 'ok' && Array.isArray(res.data)) {
                const todos = res.data;
                const enabled = todos.filter((t: any) => t.enabled !== false).length;
                const total = todos.length;
                if (total === 0) return null;
                const filled = Math.round((enabled / total) * 8);
                const bar =
                    chalk.hex(getAdaptiveGreen())('█'.repeat(filled)) + chalk.hex('#4a4a4a')('░'.repeat(8 - filled));
                return `📋 ${bar} ${enabled}/${total}`;
            }
            return null;
        } catch {
            return null;
        }
    }

    static getWorkerClass() {
        return TodoMgrWorker;
    }

    static getConfigSchema(): z.ZodObject<any> {
        return z.object({});
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('todomgr');

        toolset.addTool(new GetCurrentTimeTool());
        toolset.addTool(new TodoWriteTool(this));

        return [toolset];
    }

    async getSkills(): Promise<Skill[]> {
        const manageGlobalTodosSkill = Skill.parseMd(MANAGE_GLOBAL_TODOS_SKILL);
        const globalTodosToolset = new BaseToolset('global-todos');

        globalTodosToolset.addTool(new AddGlobalTodoTool(this));
        globalTodosToolset.addTool(new UpdateGlobalTodoTool(this));
        globalTodosToolset.addTool(new ListGlobalTodoDeliverTargetsTool(this));
        globalTodosToolset.addTool(new ListGlobalTodosTool(this));
        globalTodosToolset.addTool(new DeleteGlobalTodoTool(this));
        globalTodosToolset.addTool(new GetSupportedEventsTool(this));

        manageGlobalTodosSkill.toolsets = [globalTodosToolset];

        return [manageGlobalTodosSkill];
    }

    /**
     * 供 UI 调用：获取所有应用已注册的事件，附带应用名称
     */
    async getAllEventsForUI(): Promise<
        { bundleName: string; appName: string; eventName: string; eventDescription: string }[]
    > {
        if (!this.registry) return [];
        const eventsMap = await this.registry.getAllSupportedEvents();
        const result: { bundleName: string; appName: string; eventName: string; eventDescription: string }[] = [];
        for (const [bundleName, events] of eventsMap) {
            const app = ApplicationRegistry.getApplication(bundleName);
            const appName = app?.getName() || bundleName;
            for (const event of events) {
                result.push({
                    bundleName,
                    appName,
                    eventName: event.eventName,
                    eventDescription: event.eventDescription
                });
            }
        }
        return result;
    }

    /**
     * 供 UI 调用：获取当前已连接的消息渠道列表及已知联系人，用于投递目标选择。
     * 优先使用持久化的联系人列表（来自历史消息记录），确保重启后仍然可用。
     */
    async getConnectedChannelsForUI(): Promise<
        {
            channelId: string;
            accountId: string;
            label: string;
            online: boolean;
            recipients: { recipientId: string; displayName: string; chatType: string }[];
        }[]
    > {
        const channelMgr = ApplicationRegistry.getApplication('channelmgr') as any;
        if (!channelMgr?.getChannelStates) return [];

        const states = channelMgr.getChannelStates();

        return states.map((s: any) => ({
            channelId: s.channelId,
            accountId: s.accountId,
            label: s.label || s.channelId,
            online: s.status?.online ?? false,
            recipients: channelMgr.getPersistedContacts?.(s.channelId, s.accountId) || []
        }));
    }

    /**
     * 供 UI 调用：立即触发指定的全局待办
     */
    async triggerGlobalTodoNowFromUI(todoId: string): Promise<void> {
        await this.callWorker('triggerGlobalTodoNow', todoId);
    }

    /**
     * 处理触发器产生的任务：通过 dispatchPromptToAgent 分发给 main agent，处理投递。
     * 由 TodoMgrWorker 通过 callApp 调用，实现 todomgr 内部闭环。
     */
    async triggerTodoTask(
        todoId: string,
        todoTitle: string,
        todoContent: string,
        trigger: any,
        deliver?: Participant | null,
        workspace?: TodoWorkspaceConfig
    ): Promise<void> {
        try {
            const prompt = buildTriggerMessage(todoId, todoTitle, todoContent, trigger);
            const taskManager = GlobalState.getInstance().taskManagerState;
            const resolvedWorkspace = resolveTodoWorkspace(todoId, workspace);

            logger.info(`触发器创建任务: ${todoId}, workspace=${resolvedWorkspace}`);

            // 标志为自动触发任务（无交互 UI），禁用 askUser 等交互工具
            // 有 deliver 时使用 deliver 作为 origin，投递回复到对应 channel
            const origin = deliver || ({ type: 'automation' } as any);
            const mainAgent = AgentRegistry.getMainAgent();
            const task = await taskManager.dispatchPromptToAgent(mainAgent, undefined, prompt, {
                workspace: resolvedWorkspace,
                origin
            });

            if (deliver) {
                logger.info(
                    `触发器 deliver 已设置: channel=${deliver.channel}, accountId=${deliver.accountId}, recipientId=${deliver.recipientId}`
                );

                const channelMgr = ApplicationRegistry.getApplication('channelmgr') as any;

                // 自动化触发的 prompt 不应回显到渠道，标记跳过。
                channelMgr?.markSkipUserEcho?.(task);

                // task.origin 在类型上可缺省（未携带来源时）；此分支 deliver 已存在，
                // 正常运行时 origin 与 deliver 同源，缺失时仅日志打印空占位而不抛错
                logger.info(`触发器任务等待完成: origin=${task.origin?.channel ?? ''}:${task.origin?.accountId ?? ''}`);
                await task.waitUntilFinished();
                logger.info(`触发器任务已完成`);

                // 检查 assistant 是否产生了文本回复
                let hasReplyText = false;
                for (let i = task.chat_context.messages.length - 1; i >= 0; i--) {
                    const msg = task.chat_context.messages[i];
                    if (msg.role !== 'assistant') continue;
                    for (const part of msg.content) {
                        if (part.type === 'text' && (part as any).text) {
                            hasReplyText = true;
                            break;
                        }
                    }
                    if (hasReplyText) break;
                }
                if (!hasReplyText) {
                    logger.warn(`触发器任务: 没有找到可发送的文本回复`);
                }

                // 文本回复已由 afterFinishTurn 全局钩子统一发送，
                // 这里仅需在 taskMap 中注册，确保后续渠道回复能复用同一任务。
                const router = channelMgr.getRouter?.();
                if (router) {
                    router.registerTaskForParticipant(task.task_id, task.origin, task.task_name);
                } else {
                    logger.warn(`触发器任务: 无法获取 router，用户的回复将创建新任务`);
                }
            }
        } catch (err) {
            logger.error(`触发器任务创建失败: ${err}`);
        }
    }

    /**
     * 获取应用能够注册的事件
     */
    async getSupportedEvents(): Promise<{ eventName: string; eventDescription: string }[]> {
        return [
            {
                eventName: 'globalTodosUpdated',
                eventDescription: t('appEvent.globalTodosUpdated')
            },
            {
                eventName: 'taskTodosUpdated',
                eventDescription: t('appEvent.taskTodosUpdated')
            }
        ];
    }
}
