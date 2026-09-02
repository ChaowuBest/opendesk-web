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
 * 消息渠道管理应用。
 * 加载原生插件系统（pluginmgr）注册的消息渠道，并在渠道与任务系统之间路由消息。
 */

import { z } from 'zod';
import { BaseApplication, EventDecl } from '../base.js';
import { t as tLocal } from './locale/index.js';
import type { SlashCommandHandler } from '../../tui/commands/index.js';
import { logger } from '../../utils/logger.js';
import { InfoOverlay, ProgressOverlay } from '../../tui/components/notice.js';
import { PluginsListOverlay } from './plugins-tui.js';
import {
    getPluginHost,
    installPlugin,
    uninstallPlugin,
    setPluginEnabled,
    reloadPluginHost
} from '../pluginmgr/index.js';
import type {
    PluginEntry,
    ChannelPlugin,
    ChannelAccountStatus,
    ChannelGatewayContext,
    InboundChannelMessage,
    Participant
} from '../../plugins/types.js';
import { recordContact, getContacts } from './contacts.js';
import { ChannelMessageRouter, type ChannelReply } from './router.js';
import { getTempDirectory } from '../filemgr/tools.js';
import os from 'os';
import { Skill } from '../../aikernel/skill.js';
import { BaseToolset, ToolResult } from '../../aikernel/tool.js';
import { GlobalHooks } from '../../aikernel/hooks.js';
import { AssistantMessage } from '../../aikernel/messages.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import { MANAGE_CHANNELS_SKILL } from './skills.js';
import path from 'path';
import {
    ListPairingRequestsTool,
    ApprovePairingTool,
    RevokePairingTool,
    ListApprovedUsersTool,
    ListChannelStatusTool,
    InstallChannelPluginTool,
    UninstallChannelPluginTool,
    ListChannelPluginsTool,
    ToggleChannelPluginTool,
    SetChannelConfigTool,
    GetChannelConfigTool,
    CreateFeishuBotTool,
    SendFileTool,
    SEND_FILE_TOOL_NAME,
    LoginChannelTool,
    type LoginChannelState
} from './tools.js';
import { feishuAuthInit, feishuAuthBegin, feishuAuthPoll } from './feishu-auth.js';
import { NotificationManager } from '../../utils/notificationmgr.js';
import { t } from '../../../locale/index.js';
import qrcodeTerminal from 'qrcode-terminal';
import chalk from 'chalk';
import { getAdaptiveGreen } from '../../tui/theme.js';

import { AgentRegistry } from '../../aikernel/agents/registry.js';
import { ApplicationRegistry } from '../registry.js';
import { getModeDisplayName } from '../../aikernel/agents/common.js';
import { Setting } from '../../utils/setting.js';
import { createNativeChannelPluginEntry, isNativeChannelEntry } from './native-channel.js';
import type { NativeChannelAdapter } from './native-channel.js';
import type { ChannelAccountLoginParam } from '../../../../packages/plugin-sdk/src/index.js';
import { ChannelInteractionService } from './interactions.js';
import {
    ChannelAskUserProvider,
    ChannelPermissionPromptProvider,
    createChannelDenyPermissionProvider
} from './channel-task-interactions.js';
import { createInteractionToolset } from '../../aikernel/interaction/tools.js';

export interface ChannelRuntimeState {
    channelId: string;
    pluginId: string;
    accountId: string;
    status: ChannelAccountStatus;
    label: string;
}

const CHANNEL_DISPLAY_NAMES: Record<string, string> = {
    weixin: '微信',
    feishu: '飞书',
    whatsapp: 'WhatsApp',
    zalouser: 'Zalo',
    telegram: 'Telegram',
    discord: 'Discord',
    slack: 'Slack',
    signal: 'Signal'
};

export function resolveChannelDisplayName(channelId: string, fallbackLabel?: string): string {
    return CHANNEL_DISPLAY_NAMES[channelId] ?? fallbackLabel ?? channelId;
}

/** 解析账号显示名：优先 accountName，缺失时回退 accountId。 */
export function resolveAccountDisplayName(
    account: { accountName?: string } | null | undefined,
    accountId: string
): string {
    return account?.accountName || accountId;
}

export type ChannelStateChangeCallback = (states: ChannelRuntimeState[]) => void;

export interface LoginResult {
    phase: 'success' | 'error';
    message?: string;
    appId?: string;
    appSecret?: string;
    error?: string;
}

export class ChannelMgrApplication extends BaseApplication {
    private workspace?: string;
    private plugins: PluginEntry[] = [];
    private channelStates: Map<string, ChannelRuntimeState> = new Map();
    private router?: ChannelMessageRouter;
    private initPromise?: Promise<void>;
    private started = false;
    private stateChangeCallbacks: ChannelStateChangeCallback[] = [];
    /** 监听 pluginmgr 插件变更事件（宿主重载后同步渠道运行时的退订句柄） */
    private disposePluginChangedBridge?: () => void;
    /** 标记本轮 turn 由渠道入站消息触发，afterFinishTurn 钩子无需回显用户消息到渠道 */
    private skipUserEchoTasks = new WeakSet<object>();

    /** 渠道结构化用户交互服务（权限审批 / askUser 透传与结算） */
    private readonly interactionService: ChannelInteractionService;

    /** 供外部（router / todomgr）标记当前 turn 的用户消息已在渠道侧可见 */
    markSkipUserEcho(task: object): void {
        this.skipUserEchoTasks.add(task);
    }

    constructor() {
        super('channelmgr', false);
        this.interactionService = new ChannelInteractionService((channelId) => this.findChannelPlugin(channelId));
    }

    getName(): string {
        return tLocal('app.name');
    }

    onChannelStateChange(callback: ChannelStateChangeCallback): void {
        this.stateChangeCallbacks.push(callback);
    }

    /** Returns the channel message router, if initialized. */
    getRouter(): ChannelMessageRouter | undefined {
        return this.router;
    }

    private notifyStateChange(): void {
        const states = this.getChannelStates();
        for (const cb of this.stateChangeCallbacks) {
            try {
                cb(states);
            } catch {
                /* ignore callback errors */
            }
        }
        this.noticeTUIStatusUpdate();
    }

    static getConfigSchema() {
        return z.object({}).loose().describe('消息插件配置（按插件 ID 设置各插件参数）');
    }

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [
            { eventName: 'channel:connected', eventDescription: tLocal('channel.event.connected') },
            { eventName: 'channel:disconnected', eventDescription: tLocal('channel.event.disconnected') },
            { eventName: 'channel:message', eventDescription: tLocal('channel.event.message') },
            { eventName: 'channel:contactsUpdated', eventDescription: tLocal('channel.event.contacts.updated') },
            { eventName: 'channel:error', eventDescription: tLocal('channel.event.error') },
            {
                eventName: 'channel:loginStatus',
                eventDescription: tLocal('channel.event.loginStatus')
            },
            {
                eventName: 'channel:interaction',
                eventDescription: tLocal('channel.event.interaction')
            }
        ];
    }

    async getSkills(): Promise<Skill[]> {
        const manageSkill = Skill.parseMd(MANAGE_CHANNELS_SKILL);

        const pairingToolset = new BaseToolset('channel-pairing');
        pairingToolset.addTool(new ListPairingRequestsTool());
        pairingToolset.addTool(new ApprovePairingTool());
        pairingToolset.addTool(new RevokePairingTool());
        pairingToolset.addTool(new ListApprovedUsersTool());
        pairingToolset.addTool(new ListChannelStatusTool(this));

        const pluginToolset = new BaseToolset('channel-plugin-management');
        pluginToolset.addTool(new InstallChannelPluginTool(this));
        pluginToolset.addTool(new UninstallChannelPluginTool(this));
        pluginToolset.addTool(new ListChannelPluginsTool());
        pluginToolset.addTool(new ToggleChannelPluginTool(this));
        pluginToolset.addTool(new SetChannelConfigTool(this));
        pluginToolset.addTool(new GetChannelConfigTool(this));
        pluginToolset.addTool(new CreateFeishuBotTool());
        pluginToolset.addTool(new LoginChannelTool(this));

        manageSkill.toolsets = [pairingToolset, pluginToolset];

        return [manageSkill];
    }

    /**
     * 初始化消息插件——加载插件并启动各 channel account。
     * 返回 Promise 以便外部能等待初始化完成。
     * @param router - 消息路由器
     * @param workspace - 工作目录路径，用于文件发送时验证文件路径
     */
    async initializeChannels(router: ChannelMessageRouter, workspace?: string): Promise<void> {
        this.configureRouter(router, workspace);
        return this.ensureLoaded();
    }

    /**
     * 配置消息路由器，但不启动插件。
     * 允许延迟启动：先配置路由器，后续通过 ensureLoaded() 触发实际初始化。
     */
    configureRouter(router: ChannelMessageRouter, workspace?: string): void {
        this.workspace = workspace;
        this.router = router;
        // 从该 account 进入的消息按 account 绑定的 workspace/agentId/model 路由
        router.setAccountRuntimeResolver((channelId, accountId) => this.getAccountRuntimeConfig(channelId, accountId));

        const outboundToolset = new BaseToolset('channel-outbound');
        outboundToolset.addTool(new SendFileTool());
        router.addExtraToolset(outboundToolset);
    }

    /** 确保初始化已完成（dashboard 等调用方可 await） */
    async ensureReady(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
        }
    }

    /**
     * 确保消息插件已完成加载。
     * 如果已配置路由器但尚未启动，触发 doInitialize()。
     */
    async ensureLoaded(): Promise<void> {
        if (this.initPromise) return this.initPromise;
        if (this.router) {
            this.initPromise = this.doInitialize();
            await this.initPromise;
        }
    }

    private async doInitialize(): Promise<void> {
        if (this.started) return;
        try {
            // 注册全局钩子：任何带渠道绑定的任务在 turn 结束后，
            // 自动将用户消息和 assistant 回复（文本 + 媒体）发送回渠道。
            GlobalHooks.afterFinishTurn(async ({ task }) => {
                if (task.origin?.type !== 'channel') return;

                const skipUserEcho = this.skipUserEchoTasks.has(task);
                this.skipUserEchoTasks.delete(task);

                // 若用户消息来自 PC 端（非渠道入站），先将其推送到渠道，
                // 使手机端也能看到完整的"有问有答"对话。
                if (!skipUserEcho) {
                    const userText = extractLastUserText(task);
                    if (userText) {
                        try {
                            await this.sendTextToParticipant(task.origin, `[用户] ${userText}`);
                        } catch (err: any) {
                            logger.error(
                                `[channelmgr] afterFinishTurn: 回显用户消息失败 ` +
                                    `${task.origin.channel}:${task.origin.accountId}` +
                                    `:${task.origin.recipientId}: ${err?.message || err}`
                            );
                        }
                    }
                }

                // 提取并发送回复（文本优先，媒体在后）
                const reply = extractChannelReply(task);
                if (reply) {
                    await this.sendChannelReply(task.origin, reply);
                }
            });

            /**
             * 从 task 消息历史中提取最后一条非 internal 的用户消息文本。
             */
            function extractLastUserText(task: TaskState): string {
                for (let i = task.chat_context.messages.length - 1; i >= 0; i--) {
                    const msg = task.chat_context.messages[i];
                    if (msg.role !== 'user') continue;
                    if ((msg as any).internal) continue;
                    for (let j = msg.content.length - 1; j >= 0; j--) {
                        const part = msg.content[j];
                        if (part.type === 'text' && (part as any).text) {
                            return (part as any).text;
                        }
                    }
                }
                return '';
            }

            /**
             * 从 task 消息历史中提取 ChannelReply（文本 + 媒体文件列表）。
             * 逻辑对齐 router.extractReply()。
             */
            function extractChannelReply(task: TaskState): ChannelReply | null {
                // 找到最后一条非 internal 的 UserMessage
                let lastUserMsgIdx = -1;
                for (let i = task.chat_context.messages.length - 1; i >= 0; i--) {
                    const msg = task.chat_context.messages[i];
                    if (msg.role === 'user' && !(msg as any).internal) {
                        lastUserMsgIdx = i;
                        break;
                    }
                }
                if (lastUserMsgIdx === -1) return null;

                // 收集该 UserMessage 之后的所有 AssistantMessage
                const relevantAssistantMessages: AssistantMessage[] = [];
                for (let i = lastUserMsgIdx + 1; i < task.chat_context.messages.length; i++) {
                    const msg = task.chat_context.messages[i];
                    if (msg instanceof AssistantMessage) {
                        relevantAssistantMessages.push(msg);
                    }
                }
                if (relevantAssistantMessages.length === 0) return null;

                // 收集 SendFile 工具调用中的成功文件路径
                const mediaUrls: string[] = [];
                let lastText = '';
                for (const msg of relevantAssistantMessages) {
                    for (const part of msg.content) {
                        if (part.type === 'tool_call') {
                            for (const tc of (part as any).toolcalls || []) {
                                if (tc.tool_name === SEND_FILE_TOOL_NAME && tc.status === 'success') {
                                    const filePath = tc.args_object?.filePath;
                                    if (filePath) mediaUrls.push(filePath);
                                }
                            }
                        }
                    }
                    // 最后一条文本覆盖前面的
                    for (let j = msg.content.length - 1; j >= 0; j--) {
                        const part = msg.content[j];
                        if (part.type === 'text' && (part as any).text) {
                            lastText = (part as any).text;
                            break;
                        }
                    }
                }

                const text = lastText.trim();
                if (!text && mediaUrls.length === 0) return null;
                return { text, mediaUrls };
            }

            // 加载原生插件系统（ctx.channels.register）注册的 channel
            this.loadNativeChannels();
            const channelPlugins = this.plugins.filter((p) => p.channelPlugin);
            logger.info(`已加载 ${this.plugins.length} 个消息渠道`);

            for (const plugin of channelPlugins) {
                await this.startChannelPlugin(plugin);
            }
            this.started = true;
            this.subscribePluginChangedBridge();
        } catch (err: any) {
            logger.error(`消息插件初始化失败: ${err?.message || err}`);
        }
    }

    /**
     * 监听 pluginmgr 的 pluginsChanged 事件，在插件宿主重载完成后同步渠道运行时。
     * 覆盖经 pluginmgr 应用 API（GUI 插件管理页 / installPlugin 等工具）安装、卸载、
     * 启停渠道类插件的入口：宿主侧注册的 channel 已更新，但本应用内存中的渠道列表
     * 与连接不会自动跟随，需在此重新加载，避免消息设置页/运行时显示过期状态。
     */
    private subscribePluginChangedBridge(): void {
        if (this.disposePluginChangedBridge) return;
        this.disposePluginChangedBridge = ApplicationRegistry.onApplicationEvent((bundleName, eventName) => {
            if (bundleName !== 'pluginmgr' || eventName !== 'pluginsChanged') return;
            this.reloadChannels().catch((err: any) => {
                logger.error(`[channelmgr] 插件变更后同步消息渠道失败: ${err?.message || err}`);
            });
        });
    }

    /**
     * 从原生插件系统（pluginmgr ctx.channels.register）加载 channel 实例，
     * 生成伪 PluginEntry 并入 plugins 数组，复用现有 channelmgr 启动/收发流程。
     */
    private loadNativeChannels(): void {
        const nativeChannels = getPluginHost().listChannels();
        for (const { channel } of nativeChannels) {
            const channelId = channel.meta.id;
            const { entry: created } = createNativeChannelPluginEntry(channel, {
                getConfig: (cid) => this.getChannelConfig(cid),
                dispatch: async (cid, accountId, message) => {
                    if (!created?.channelPlugin) return;
                    await this.handleInboundMessage(created.channelPlugin, accountId, message);
                },
                dispatchInteraction: async (cid, accountId, event) => {
                    await this.handleChannelInteractionEvent(cid, accountId, event);
                },
                setStatus: (cid, accountId, status) => {
                    const stateKey = `${cid}:${accountId}`;
                    const state = this.channelStates.get(stateKey);
                    if (state) {
                        state.status = { ...state.status, ...status };
                        this.notifyStateChange();
                    }
                },
                emit: (cid, event, payload) => {
                    this.emitEvent(event, { channelId: cid, ...payload });
                }
            });
            // 立即注入运行时上下文，确保登录/启动时 channel 的 ctx 已就绪
            (created.channelPlugin as unknown as NativeChannelAdapter).ensureRuntimeInjected();
            logger.info(`[channelmgr] 已加载原生 channel: ${channelId} (plugin: ${created.id})`);
            this.plugins.push(created);
        }
    }

    private async startChannelPlugin(entry: PluginEntry): Promise<void> {
        const cp = entry.channelPlugin!;
        const channelId = cp.id;
        const config = this.getChannelConfig(channelId);

        // 原生 channel：先同步账号缓存，再读取账号列表
        if (isNativeChannelEntry(entry)) {
            await (entry.channelPlugin as unknown as NativeChannelAdapter).syncAccounts();
        }

        logger.info(`[channelmgr] 正在启动消息插件: ${channelId} (${cp.meta.label}) ${JSON.stringify(config)}`);

        let accountIds: string[];
        try {
            accountIds = cp.config.listAccountIds(config);
        } catch {
            accountIds = ['default'];
        }

        for (const accountId of accountIds) {
            const stateKey = `${channelId}:${accountId}`;
            const state: ChannelRuntimeState = {
                channelId,
                pluginId: entry.id,
                accountId,
                status: { online: false, statusText: '启动中' },
                label: resolveChannelDisplayName(channelId, cp.meta.label)
            };
            this.channelStates.set(stateKey, state);

            if (cp.gateway?.startAccount) {
                try {
                    const account = cp.config.resolveAccount(config, accountId);
                    const ctx = this.createGatewayContext(cp, accountId, account, config);

                    const startPromise = cp.gateway.startAccount(ctx);

                    // Monitor for late runtime errors (plugin crash, connection lost, etc.)
                    startPromise.catch((err: any) => {
                        const s = this.channelStates.get(stateKey);
                        if (s && s.status.online) {
                            s.status = { online: false, statusText: '断开', error: err?.message };
                            this.notifyStateChange();
                            this.emitEvent('channel:error', {
                                channelId,
                                accountId,
                                error: err?.message
                            });
                            logger.error(`消息插件 ${channelId}:${accountId} 断开连接: ${err?.message || err}`);
                        }
                    });

                    // Many plugins (e.g. Feishu) start long-running event loops in startAccount
                    // that never resolve. Wait briefly for fast failures (config/auth errors),
                    // then assume the plugin is running.
                    await Promise.race([startPromise, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);

                    state.status = { online: true, statusText: t('channel.status.connected') };
                    this.notifyStateChange();
                    this.emitEvent('channel:connected', { channelId, accountId });
                    NotificationManager.getInstance().info(
                        t('plugin.system'),
                        t('message.channel'),
                        `${resolveChannelDisplayName(channelId, cp.meta.label)} ${resolveAccountDisplayName(
                            account,
                            accountId
                        )} ${t('channel.ready')}`
                    );
                } catch (err: any) {
                    state.status = { online: false, statusText: t('channel.status.error'), error: err?.message };
                    this.notifyStateChange();
                    this.emitEvent('channel:error', { channelId, accountId, error: err?.message });
                    logger.error(`消息插件 ${channelId}:${accountId} 启动失败: ${err?.message || err}`);
                }
            } else {
                state.status = { online: true, statusText: t('channel.status.ready') };
                this.notifyStateChange();
            }
        }
    }

    private createGatewayContext(
        cp: ChannelPlugin,
        accountId: string,
        account: any,
        config: any
    ): ChannelGatewayContext {
        const stateKey = `${cp.id}:${accountId}`;
        const tag = `[${cp.id}:${accountId}]`;
        const fmt = (...args: any[]) =>
            args
                .map((a) => {
                    if (typeof a === 'string') return a;
                    try {
                        return JSON.stringify(a, null, 2) ?? String(a);
                    } catch {
                        return String(a);
                    }
                })
                .join(' ');

        const pluginLogger = {
            info: (...args: any[]) => logger.info(`${tag} ${fmt(...args)}`),
            warn: (...args: any[]) => logger.warn(`${tag} ${fmt(...args)}`),
            error: (...args: any[]) => logger.error(`${tag} ${fmt(...args)}`),
            debug: (...args: any[]) => logger.info(`${tag}[debug] ${fmt(...args)}`)
        };

        return {
            accountId,
            account,
            cfg: config,
            logger: pluginLogger,
            dispatch: async (message: InboundChannelMessage) => {
                logger.info(`[${cp.id}:${accountId}] 收到消息: ${message.senderName || message.senderId}`);
                this.emitEvent('channel:message', {
                    channelId: cp.id,
                    accountId,
                    senderId: message.senderId,
                    senderName: message.senderName,
                    text: message.text
                });
                await this.handleInboundMessage(cp, accountId, message);
            },
            setStatus: (status: ChannelAccountStatus) => {
                const state = this.channelStates.get(stateKey);
                if (state) {
                    state.status = {
                        ...state.status,
                        ...status,
                        online: status.online ?? state.status.online
                    };
                    this.notifyStateChange();
                }
            }
        };
    }

    private async handleInboundMessage(
        cp: ChannelPlugin,
        accountId: string,
        message: InboundChannelMessage
    ): Promise<void> {
        if (!this.router) {
            logger.warn('消息路由未配置，丢弃入站消息');
            return;
        }

        const replyTo = message.chatType === 'group' && message.groupId ? message.groupId : message.senderId;

        // 记录联系人信息，用于自动化任务投递目标选择
        const contactName =
            message.chatType === 'group'
                ? message.groupName || message.groupId || ''
                : message.senderName || message.senderId || '';
        recordContact(cp.id, accountId, replyTo, contactName, message.chatType);
        this.emitEvent('channel:contactsUpdated', {
            channelId: cp.id,
            accountId,
            recipientId: replyTo,
            displayName: contactName || replyTo,
            chatType: message.chatType
        });
        const reply = await this.router.routeInboundMessage(message);
        if (!reply) return;

        logger.info(`[channelmgr] routeInboundMessage returned: "${reply?.text?.substring(0, 50)}..."`);

        // 文本和媒体回复已由 afterFinishTurn 全局钩子统一发送
    }

    /**
     * 为渠道来源的任务注入交互 provider（在 task.origin 设置后调用）。
     * - 渠道支持结构化交互：权限审批与 askUser 透传到渠道用户侧；
     * - 渠道不支持交互：权限请求自动拒绝，且不挂载交互工具集（askUser / exitPlanMode）。
     */
    applyChannelTaskProviders(task: TaskState): void {
        const origin = task.origin;
        if (!origin || origin.type !== 'channel') return;
        const entry = this.findChannelPlugin(origin.channel);
        const cp = entry?.channelPlugin;
        const interactive = Boolean(cp?.capabilities?.interactive === true && cp.sendInteraction);
        logger.info(
            `[channelmgr] applyChannelTaskProviders ${origin.channel}: found=${Boolean(cp)} native=${entry ? isNativeChannelEntry(entry) : false} interactive=${cp?.capabilities?.interactive} hasSendInteraction=${typeof cp?.sendInteraction} => ${interactive}`
        );
        if (interactive) {
            task.harnessContext.permissionPrompt = new ChannelPermissionPromptProvider(this.interactionService, origin);
            task.interactionToolset = createInteractionToolset(
                new ChannelAskUserProvider(this.interactionService, origin)
            );
            logger.info(
                '[channelmgr] channel task ' + task.task_id + ' uses channel interactions (' + origin.channel + ')'
            );
        } else {
            task.harnessContext.permissionPrompt = createChannelDenyPermissionProvider('no_prompt_provider');
            task.interactionToolset = null;
            logger.info(
                '[channelmgr] channel task ' +
                    task.task_id +
                    ' has no interaction capability (' +
                    origin.channel +
                    '), interaction tools not mounted'
            );
        }
    }

    /** 结算渠道入站交互事件（用户在渠道侧点击了权限审批/askUser 卡片）。 */
    async handleChannelInteractionEvent(channelId: string, accountId: string, event: unknown): Promise<void> {
        const e = event as {
            kind?: string;
            interactionId?: string;
            operator?: { id?: string; name?: string };
            decision?: string;
            answers?: Record<number, string[]>;
            cancelled?: boolean;
        };
        if (!e || (e.kind !== 'approval' && e.kind !== 'askUser') || !e.interactionId) {
            logger.warn('[channelmgr] invalid channel interaction event from ' + channelId + ':' + accountId);
            return;
        }
        const matched = this.interactionService.handleInteractionEvent(channelId, accountId, {
            kind: e.kind,
            interactionId: e.interactionId,
            accountId,
            operator: { id: e.operator?.id ?? '', name: e.operator?.name },
            decision: e.decision === 'deny' ? 'deny' : e.decision === 'allow' ? 'allow' : undefined,
            answers: e.answers,
            cancelled: e.cancelled,
            raw: event
        });
        this.emitEvent('channel:interaction', { channelId, accountId, matched, kind: e.kind });
    }

    /**
     * 获取某个消息插件的完整配置。
     * 用户在 OpenDesk 配置中写 applications.channelmgr.{channelId} 来设置参数。
     */
    // ── 账号运行时配置（workspace / agentId / model） ───────────────────────────

    /**
     * 读取指定渠道账号的运行时设定。存储于 applications.channelmgr.<channelId>.accountRuntime.<accountId>。
     * 从该账号进入的消息自动使用这些设定（workspace 工作目录 / agentId 模式 / model）。
     */
    getAccountRuntimeConfig(
        channelId: string,
        accountId: string
    ): { workspace?: string; agentId?: string; modeId?: string; model?: string } {
        const config = (this.getConfig() || {}) as Record<string, any>;
        const channelCfg = config[channelId] || {};
        const runtime = (channelCfg.accountRuntime || {})[accountId] || {};
        let model = typeof runtime.model === 'string' ? runtime.model : undefined;
        // 模型已不存在时回退为 undefined（路由时使用默认对话模型）
        if (model && !this.isValidChatModel(model)) {
            logger.info('[channelmgr] account runtime 模型不存在，回退默认: ' + model);
            model = undefined;
        }
        return {
            workspace: typeof runtime.workspace === 'string' ? runtime.workspace : undefined,
            agentId: typeof runtime.agentId === 'string' ? runtime.agentId : undefined,
            modeId: typeof runtime.modeId === 'string' ? runtime.modeId : undefined,
            model
        };
    }

    /** 校验模型是否为当前已配置的 chat 模型。 */
    private isValidChatModel(model: string): boolean {
        try {
            const data = Setting.getInstance().getData() || {};
            const models = data.models;
            if (!Array.isArray(models)) return false;
            return models.some((m: any) => m?.model_type === 'chat' && m?.alias === model);
        } catch {
            return false;
        }
    }

    /** 设置指定渠道账号的运行时设定（workspace / agentId / model），空值字段保持原样。 */
    setAccountRuntimeConfig(
        channelId: string,
        accountId: string,
        runtime: { workspace?: string; agentId?: string; modeId?: string; model?: string }
    ): void {
        const currentConfig = (this.getConfig() || {}) as Record<string, any>;
        const channelCfg = { ...(currentConfig[channelId] || {}) };
        const accountRuntime = { ...((channelCfg.accountRuntime as Record<string, unknown>) || {}) };
        accountRuntime[accountId] = { ...((accountRuntime[accountId] as object) || {}), ...runtime };
        channelCfg.accountRuntime = accountRuntime;
        this.setConfig({ ...currentConfig, [channelId]: channelCfg });
    }

    // ── 原生 channel 查询与登录（供 GUI 使用） ───────────────────────────────────

    /** 获取某渠道的账号列表（含账号级运行时配置）。 */
    getChannelAccounts(channelId: string): {
        accountId: string;
        accountName?: string;
        runtime: { workspace?: string; agentId?: string; model?: string };
    }[] {
        const entry = this.findChannelPlugin(channelId);
        if (!entry?.channelPlugin) return [];
        const cp = entry.channelPlugin;
        const native = isNativeChannelEntry(entry)
            ? (entry.channelPlugin as unknown as NativeChannelAdapter)
            : undefined;
        let accountIds: string[];
        try {
            accountIds = cp.config.listAccountIds(this.getChannelConfig(channelId));
        } catch {
            accountIds = [];
        }
        return accountIds.map((accountId) => ({
            accountId,
            // 原生 channel 从账号缓存透出可读名称（微信/飞书登录时设置）
            accountName: native?.getAccountName(accountId),
            runtime: this.getAccountRuntimeConfig(channelId, accountId)
        }));
    }

    /** 获取当前已配置的 chat 模型列表与默认模型（供 GUI 模型下拉选择）。 */
    getAvailableModels(): { models: string[]; defaultModel: string } {
        try {
            const data = Setting.getInstance().getData() || {};
            const rawModels = data.models as unknown as any[] | undefined;
            const models = (rawModels || [])
                .filter((m: any) => m?.model_type === 'chat')
                .map((m: any) => m?.alias)
                .filter((alias: unknown): alias is string => typeof alias === 'string' && alias.length > 0);
            return {
                models,
                defaultModel: typeof data.default_model === 'string' ? data.default_model : ''
            };
        } catch {
            return { models: [], defaultModel: '' };
        }
    }

    /** 获取指定 Agent 支持的模式列表（主 agent 仅暴露 只读/标准/效率）。 */
    getAgentModes(agentId: string): { id: string; name: string }[] {
        try {
            const agent = agentId === 'main' ? AgentRegistry.getMainAgent() : AgentRegistry.getAgent(agentId);
            if (!agent) return [];
            const modes = agent.supportedModes();
            // 主 agent 只展示只读/标准/效率三个模式
            const allowed = agentId === 'main' ? new Set(['readonly', 'standard', 'solo']) : null;
            return modes
                .filter((mode) => !allowed || allowed.has(mode.id))
                .map((mode) => ({ id: mode.id, name: getModeDisplayName(mode) }));
        } catch {
            return [];
        }
    }

    /** 获取某渠道支持的登录方式。 */
    getChannelLoginModes(channelId: string): { qr: boolean; params: boolean } {
        const entry = this.findChannelPlugin(channelId);
        if (!entry?.channelPlugin) return { qr: false, params: false };
        const cp = entry.channelPlugin;
        const native = isNativeChannelEntry(entry)
            ? (entry.channelPlugin as unknown as NativeChannelAdapter)
            : undefined;
        return {
            // 原生 channel 的 gateway 方法恒存在，qr 支持必须看 channel 真实能力
            qr: native ? native.supportQrLogin() : Boolean(cp.gateway?.loginWithQrStart && cp.gateway?.loginWithQrWait),
            params: Boolean(native?.supportParamsLogin())
        };
    }

    /** 获取参数登录的表单字段描述（原生 channel）。 */
    getChannelLoginParams(channelId: string): ChannelAccountLoginParam[] {
        const entry = this.findChannelPlugin(channelId);
        if (!entry?.channelPlugin || !isNativeChannelEntry(entry)) return [];
        return (entry.channelPlugin as unknown as NativeChannelAdapter).getLoginParams();
    }

    /** 登出指定渠道账号：停止连接、清理凭证并移除状态。 */
    async logoutChannelAccount(channelId: string, accountId: string): Promise<{ ok: boolean; message?: string }> {
        const entry = this.findChannelPlugin(channelId);
        if (!entry?.channelPlugin) {
            return { ok: false, message: '未找到渠道: ' + channelId };
        }
        const cp = entry.channelPlugin;
        try {
            // 1. 停止该账号的长连接并清理状态
            await this.stopChannelPluginAccounts(cp, [accountId]);
            // 2. 调用 channel 的登出（删除持久化凭证）
            const account = cp.config.resolveAccount(this.getChannelConfig(channelId), accountId);
            await cp.gateway?.logoutAccount?.({ accountId, account, cfg: this.getChannelConfig(channelId) });
            logger.info('[channelmgr] 账号已登出: ' + channelId + ':' + accountId);
            this.notifyStateChange();
            return { ok: true };
        } catch (err: any) {
            logger.error('[channelmgr] 登出账号失败 ' + channelId + ':' + accountId + ': ' + (err?.message || err));
            return { ok: false, message: err?.message || String(err) };
        }
    }

    /** 通过参数登录（原生 channel 的表单登录，如飞书 appId/appSecret）。登录成功后自动重启连接。 */
    async loginChannelWithParams(
        channelId: string,
        accountId: string,
        values: Record<string, string>
    ): Promise<LoginResult> {
        const entry = this.findChannelPlugin(channelId);
        if (!entry?.channelPlugin || !isNativeChannelEntry(entry)) {
            return { phase: 'error', error: '渠道 ' + channelId + ' 不支持参数登录' };
        }
        const adapter = entry.channelPlugin as unknown as NativeChannelAdapter;
        try {
            const account = await adapter.loginWithParams(values);
            logger.info('[loginChannel:' + channelId + '] 参数登录成功: ' + account.accountId);
        } catch (err: any) {
            logger.error('[loginChannel:' + channelId + '] 参数登录失败: ' + (err?.message || err));
            return { phase: 'error', error: err?.message || String(err) };
        }
        try {
            await this.restartChannelPlugin(channelId);
        } catch (err: any) {
            logger.error('[loginChannel] 登录成功但重启渠道失败: ' + (err?.message || err));
        }
        return { phase: 'success', message: resolveChannelDisplayName(channelId) + ' 登录成功' };
    }

    /**
     * GUI 专用的扫码登录：QR 进度通过 channel:loginStatus 事件推送，
     * 返回 Promise 在登录完成/失败时 resolve。
     */
    async startQrLogin(channelId: string, accountId = 'default'): Promise<LoginResult> {
        const entry = this.findChannelPlugin(channelId);
        if (!entry?.channelPlugin) {
            return { phase: 'error', error: '未找到渠道: ' + channelId };
        }
        const cp = entry.channelPlugin;
        if (!cp.gateway?.loginWithQrStart || !cp.gateway?.loginWithQrWait) {
            return { phase: 'error', error: '渠道 ' + channelId + ' 不支持扫码登录' };
        }
        const push = (state: Partial<LoginChannelState>) => {
            this.emitEvent('channel:loginStatus', { channelId, accountId, ...state } as any);
        };
        try {
            push({ phase: 'init' });
            const startResult = await cp.gateway.loginWithQrStart({
                accountId,
                force: false,
                timeoutMs: 60_000,
                verbose: false
            });
            const qrUrl = startResult?.qrDataUrl || startResult?.qrcodeUrl;
            if (!qrUrl) {
                return { phase: 'error', error: '渠道 ' + channelId + ' 未能生成二维码' };
            }
            push({ phase: 'polling', verification_url: qrUrl });
            const waitResult = await cp.gateway.loginWithQrWait({
                accountId,
                sessionKey: startResult?.sessionKey,
                timeoutMs: 480_000
            });
            if (waitResult?.connected) {
                push({ phase: 'success', message: resolveChannelDisplayName(channelId) + ' 登录成功' });
                // 立即重启连接，使消息收发与状态无需手动刷新即生效
                try {
                    await this.restartChannelPlugin(channelId);
                } catch (err: any) {
                    logger.error('[startQrLogin] 登录成功但重启渠道失败: ' + (err?.message || err));
                }
                return { phase: 'success', message: '登录成功' };
            }
            const message = waitResult?.message || '登录失败';
            push({ phase: 'error', error: message });
            return { phase: 'error', error: message };
        } catch (err: any) {
            const message = err?.message || String(err);
            push({ phase: 'error', error: message });
            return { phase: 'error', error: message };
        }
    }

    /** 获取账号可绑定的 agent 列表。当前仅主 agent（OpenDesk），未来可扩展数字员工。 */
    getAvailableAgents(): string[] {
        try {
            AgentRegistry.getMainAgent(); // 确保内置 agent 已初始化
            return ['main'];
        } catch {
            return [];
        }
    }

    private getChannelConfig(channelId: string): any {
        const config = this.getConfig() || {};
        return {
            channels: {
                [channelId]: config[channelId] || {}
            },
            ...config
        };
    }

    async getTUIStatusBlock(): Promise<string | null> {
        const states = this.getChannelStates();
        if (states.length === 0) return null;

        const parts = states.map((s) => {
            const green = getAdaptiveGreen();
            const dot = s.status.online ? chalk.hex(green)('●') : chalk.hex('#FF1744')('○');
            const name = s.status.online
                ? chalk.hex(green)(s.label || s.channelId)
                : chalk.hex('#FF1744')(s.label || s.channelId);
            return `${dot}${name}`;
        });
        return `💬 ${parts.join(' ')}`;
    }

    // ── 查询方法 ─────────────────────────────────────────────────────────────

    getChannelStates(): ChannelRuntimeState[] {
        return Array.from(this.channelStates.values());
    }

    getChannelPlugins(): { id: string; label: string; description?: string }[] {
        return this.plugins
            .filter((p) => p.channelPlugin)
            .map((p) => ({
                id: p.channelPlugin!.id,
                label: resolveChannelDisplayName(p.channelPlugin!.id, p.channelPlugin!.meta.label),
                description: p.channelPlugin!.meta.description
            }));
    }

    /**
     * 获取指定渠道/账号的已知联系人（从持久化存储中读取）。
     */
    getPersistedContacts(
        channelId: string,
        accountId: string
    ): { recipientId: string; displayName: string; chatType: string }[] {
        return getContacts(channelId, accountId).map((c) => ({
            recipientId: c.recipientId,
            displayName: c.displayName,
            chatType: c.chatType
        }));
    }

    /**
     * 向指定的 Participant 发送文本消息。
     * 用于定时任务等场景下根据 task.origin 发送回复。
     */
    async sendTextToParticipant(participant: Participant, text: string): Promise<void> {
        const { channel, accountId, recipientId } = participant;

        logger.info(
            `[channelmgr] sendTextToParticipant: channel=${channel}, accountId=${accountId}, recipientId=${recipientId}, text_len=${text.length}`
        );

        // Find the channel plugin
        const entry = this.plugins.find((p) => p.channelPlugin?.id === channel);
        if (!entry?.channelPlugin) {
            logger.error(`[channelmgr] 找不到 channel plugin: ${channel}`);
            return;
        }

        const cp = entry.channelPlugin;
        const config = this.getChannelConfig(channel);

        const baseCtx = {
            channelId: cp.id,
            accountId: accountId,
            to: recipientId,
            cfg: config
        };

        logger.info(`[channelmgr] sending via ${cp.id}, to=${recipientId}`);

        try {
            if (cp.outbound?.sendText) {
                await cp.outbound.sendText({ ...baseCtx, text });
                logger.info(`[channelmgr] sendText completed`);
            } else if (cp.outbound?.sendPayload) {
                await cp.outbound.sendPayload({ ...baseCtx, payload: { text } });
                logger.info(`[channelmgr] sendPayload completed`);
            } else {
                logger.warn(`[channelmgr] channel ${channel} 没有可用的发送方法`);
            }
        } catch (err: any) {
            logger.error(`[channelmgr] 发送消息失败: ${err?.message || err}`);
        }
    }

    /**
     * 向指定的 Participant 发送单个媒体文件。
     * 用于 afterFinishTurn 钩子中统一发送回复附件。
     */
    private async sendMediaToParticipant(participant: Participant, mediaUrl: string): Promise<void> {
        const { channel, accountId, recipientId } = participant;

        const entry = this.plugins.find((p) => p.channelPlugin?.id === channel);
        if (!entry?.channelPlugin) {
            logger.error(`[channelmgr] sendMediaToParticipant: 找不到 channel plugin: ${channel}`);
            return;
        }

        const cp = entry.channelPlugin;
        const config = this.getChannelConfig(channel);

        const mediaLocalRoots = [getTempDirectory(), os.tmpdir(), '/tmp'];
        if (this.workspace) {
            mediaLocalRoots.push(this.workspace);
        }

        const baseCtx = {
            channelId: cp.id,
            accountId,
            to: recipientId,
            cfg: config
        };

        const sendMediaFn = cp.outbound?.sendMedia || cp.outbound?.sendPayload;
        if (!sendMediaFn) {
            logger.warn(`[channelmgr] sendMediaToParticipant: channel ${channel} 没有可用的媒体发送方法`);
            return;
        }

        if (cp.outbound?.sendMedia) {
            await cp.outbound.sendMedia({
                ...baseCtx,
                text: '',
                mediaUrl,
                mediaLocalRoots
            });
        } else if (cp.outbound?.sendPayload) {
            await cp.outbound.sendPayload({
                ...baseCtx,
                payload: { text: '', mediaUrl, mediaUrls: [mediaUrl] },
                mediaLocalRoots
            });
        }
    }

    /**
     * 向指定 Participant 发送完整的渠道回复（文本优先，媒体在后）。
     * 媒体发送失败时收集失败文件名并通过文本发出警告。
     */
    private async sendChannelReply(participant: Participant, reply: ChannelReply): Promise<void> {
        // 1. 发送文本
        if (reply.text) {
            logger.info(
                `[channelmgr] afterFinishTurn: 发送回复到渠道 ` +
                    `${participant.channel}:${participant.accountId}:${participant.recipientId}`
            );
            try {
                await this.sendTextToParticipant(participant, reply.text);
            } catch (err: any) {
                logger.error(
                    `[channelmgr] afterFinishTurn: 发送文本回复失败 ` +
                        `${participant.channel}:${participant.accountId}` +
                        `:${participant.recipientId}: ${err?.message || err}`
                );
            }
        }

        // 2. 逐个发送媒体文件
        if (reply.mediaUrls.length > 0) {
            const failedFiles: string[] = [];
            for (const mediaUrl of reply.mediaUrls) {
                try {
                    await this.sendMediaToParticipant(participant, mediaUrl);
                } catch (err: any) {
                    const fileName = path.basename(mediaUrl.replace(/^file:\/\//, ''));
                    failedFiles.push(fileName);
                    logger.error(
                        `[channelmgr] afterFinishTurn: 发送媒体文件失败 ` +
                            `${participant.channel}:${participant.accountId} media=${mediaUrl}: ${err?.message || err}`
                    );
                }
            }

            if (failedFiles.length > 0) {
                const warning = `⚠️ 以下文件由于权限原因无法发送：${failedFiles.join('、')}`;
                try {
                    await this.sendTextToParticipant(participant, warning);
                } catch {
                    /* 警告发送失败不阻塞流程 */
                }
            }
        }
    }

    /**
     * 根据 Participant 获取 channel 和 account 信息。
     */
    getParticipantInfo(
        participant: Participant
    ): { channelId: string; accountId: string; recipientId: string; label: string } | null {
        const entry = this.plugins.find((p) => p.channelPlugin?.id === participant.channel);
        if (!entry?.channelPlugin) {
            return null;
        }
        return {
            channelId: participant.channel,
            accountId: participant.accountId,
            recipientId: participant.recipientId,
            label: resolveChannelDisplayName(participant.channel, entry.channelPlugin.meta.label)
        };
    }

    // ── Channel Login ──────────────────────────────────────────────────────────

    /**
     * 执行渠道登录流程。
     * 优先使用 gateway.loginWithQrStart + loginWithQrWait（返回 QR URL，可在 UI 显示）。
     * 若无 gateway QR 方法：对 Feishu 注入设备授权流程；对其他插件调用 auth.login（QR 输出到控制台）。
     */
    private findChannelPlugin(channelId: string): PluginEntry | undefined {
        return (
            this.plugins.find((p) => p.channelPlugin?.id === channelId) ||
            this.plugins.find((p) => p.channelPlugin && (p.id === channelId || p.installRecord?.id === channelId))
        );
    }

    async loginChannel(channelId: string, accountId = 'default', result?: ToolResult): Promise<LoginResult> {
        // 先在已加载的原生渠道中查找
        const entry = this.findChannelPlugin(channelId);

        if (!entry?.channelPlugin) {
            const loadedIds = this.plugins
                .filter((p) => p.channelPlugin)
                .map((p) => `${p.id}(channel=${p.channelPlugin!.id})`)
                .join(', ');
            return { phase: 'error', error: `未找到渠道: ${channelId}。已加载的渠道: [${loadedIds}]` };
        }

        const cp = entry.channelPlugin;

        let loginResult: LoginResult;

        // 路径 1：gateway.loginWithQrStart + loginWithQrWait（返回 QR URL，推荐）
        if (cp.gateway?.loginWithQrStart && cp.gateway?.loginWithQrWait) {
            logger.info(`[loginChannel] using gateway loginWithQr for ${channelId}`);
            loginResult = await this.loginWithQrGateway(cp, channelId, accountId, result);
        }
        // 路径 2：Feishu 特殊路径
        else if (channelId === 'feishu') {
            loginResult = await this.loginFeishuDeviceAuth(accountId, result);
        } else {
            return { phase: 'error', error: `渠道 ${channelId} 不支持 login` };
        }

        // 登录成功后自动重启该渠道的 gateway 连接，使消息收发立即生效
        if (loginResult.phase === 'success') {
            try {
                await this.restartChannelPlugin(channelId);
            } catch (err: any) {
                logger.error(`[loginChannel] 登录成功但重启渠道失败: ${err?.message || err}`);
            }
        }

        return loginResult;
    }

    /**
     * 通过 gateway.loginWithQrStart / loginWithQrWait 执行扫码登录（WeChat 等）。
     * 启动后立即推送 QR 状态，轮询等待扫码完成。
     */
    private async loginWithQrGateway(
        cp: ChannelPlugin,
        channelId: string,
        accountId: string,
        result?: ToolResult
    ): Promise<LoginResult> {
        const updateState = (state: Partial<LoginChannelState>) => {
            if (result) {
                result.updateResultObject({
                    phase: 'polling',
                    channelId,
                    accountId,
                    ...state
                } as LoginChannelState);
            }
        };

        // Step 1: 启动，获取 QR 码
        logger.info(`[loginChannel:${channelId}] Step 1: loginWithQrStart`);
        const startResult = await cp.gateway!.loginWithQrStart!({
            accountId,
            force: false,
            timeoutMs: 60_000,
            verbose: false
        });

        const qrUrl = (startResult as any).qrDataUrl || (startResult as any).qrcodeUrl;
        if (!qrUrl) {
            return {
                phase: 'error',
                error: `渠道 ${channelId} 未能生成二维码: ${startResult.message || '未知错误'}`
            };
        }

        // 推送 QR 码状态
        let qrAscii = '';
        try {
            const qrGen = (qrcodeTerminal as any).default || qrcodeTerminal;
            qrAscii = await new Promise<string>((resolve) => {
                qrGen.generate(qrUrl, { small: true }, (code: string) => resolve(code));
            });
        } catch (e: any) {
            qrAscii = `请打开链接扫码: ${qrUrl}`;
        }
        // CLI 渲染器仅在 polling 阶段打印二维码 ASCII。
        updateState({ qr_ascii: qrAscii, verification_url: qrUrl, phase: 'polling' });

        // 主动让出事件循环，让 TUI 完成一次渲染再进入阻塞等待。
        // 否则 requestStreamRender 的 100ms  throttle 导致渲染被延迟到 loginWithQrWait 返回之后，
        // 此时 phase 已变为 success，QR 码永远不会显示。
        await new Promise((resolve) => setImmediate(resolve));

        // Step 2: 轮询等待扫码完成
        const waitResult = await cp.gateway!.loginWithQrWait!({
            accountId,
            sessionKey: (startResult as any).sessionKey,
            timeoutMs: 480_000
        });

        if (waitResult.connected) {
            const dn = resolveChannelDisplayName(channelId);
            updateState({
                phase: 'success',
                message: `${dn} 登录成功！`
            });
            return { phase: 'success', message: `${dn} 登录成功` };
        }

        return { phase: 'error', error: waitResult.message || `${resolveChannelDisplayName(channelId)} 登录失败` };
    }

    /**
     * Feishu 设备授权登录流程。
     * 通过飞书设备授权扫码，一键创建机器人并配置凭证。
     */
    private async loginFeishuDeviceAuth(accountId: string, result?: ToolResult): Promise<LoginResult> {
        const FEISHU_BOT_POLL_TIMEOUT_SEC = 180;

        const updateState = (state: Partial<LoginChannelState>) => {
            if (result) {
                result.updateResultObject({
                    phase: 'polling',
                    channelId: 'feishu',
                    accountId,
                    ...state
                } as LoginChannelState);
            }
        };

        // Step 1: Init
        logger.info('[loginChannel:feishu] Step 1: init');
        const initRes = await feishuAuthInit();
        if (!initRes.supported_auth_methods?.includes('client_secret')) {
            return { phase: 'error', error: '当前飞书环境不支持扫码创建机器人' };
        }

        // Step 2: Begin — 获取 device_code 和 QR URL
        const beginRes = await feishuAuthBegin();
        const { device_code, verification_uri_complete } = beginRes;
        if (!device_code || !verification_uri_complete) {
            return { phase: 'error', error: `飞书 begin 返回异常` };
        }

        // Step 3: 生成 QR 码 ASCII
        let qrAscii = '';
        try {
            const qrGen = (qrcodeTerminal as any).default || qrcodeTerminal;
            qrAscii = await new Promise<string>((resolve) => {
                qrGen.generate(verification_uri_complete, { small: true }, (code: string) => resolve(code));
            });
        } catch (e: any) {
            logger.warn(`[loginChannel:feishu] QR 生成失败: ${e?.message}`);
            qrAscii = `请手动打开链接: ${verification_uri_complete}`;
        }

        updateState({
            qr_ascii: qrAscii,
            verification_url: verification_uri_complete,
            phase: 'generating_qr'
        });

        // 让出事件循环，确保 TUI 在进入轮询前先渲染一次（显示 QR 或初始提示）
        await new Promise((resolve) => setImmediate(resolve));

        // Step 4: 轮询等待扫码
        const startTime = Date.now();
        const pollIntervalSec = beginRes.interval || 5;
        const expireInSec = beginRes.expire_in || beginRes.expires_in || FEISHU_BOT_POLL_TIMEOUT_SEC;
        const deadlineMs = Math.min(expireInSec, FEISHU_BOT_POLL_TIMEOUT_SEC) * 1000;

        while (Date.now() - startTime < deadlineMs) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalSec * 1000));

            let pollRes;
            try {
                pollRes = await feishuAuthPoll(device_code);
            } catch (err: any) {
                logger.warn(`[loginChannel:feishu] Poll 网络错误: ${err?.message}`);
                continue;
            }

            if (pollRes.client_id && pollRes.client_secret) {
                const appId = pollRes.client_id;
                const appSecret = pollRes.client_secret;
                const openId = pollRes.user_info?.open_id || '';

                // 保存凭证到配置
                const currentConfig = this.getConfig() || {};
                const feishuConfig = currentConfig['feishu'] || {};
                const accounts = feishuConfig['accounts'] || {};
                accounts[accountId] = { appId, appSecret, enabled: true };

                this.setConfig({
                    ...currentConfig,
                    feishu: {
                        ...feishuConfig,
                        enabled: true,
                        accounts
                    }
                });

                logger.info(`[loginChannel:feishu] 登录成功: ${appId}`);

                updateState({
                    phase: 'success',
                    appId,
                    appSecret,
                    message: `飞书机器人创建成功，App ID: ${appId}`
                });

                return {
                    phase: 'success',
                    message: `飞书机器人创建成功（App ID: ${appId}，Open ID: ${openId}）`,
                    appId,
                    appSecret
                };
            }

            if (pollRes.error) {
                if (pollRes.error === 'authorization_pending' || pollRes.error === 'slow_down') {
                    updateState({ phase: 'polling' });
                    if (pollRes.error === 'slow_down') {
                        // 飞书要求降低轮询频率
                    }
                } else if (pollRes.error === 'access_denied') {
                    return { phase: 'error', error: '用户拒绝了授权' };
                } else if (pollRes.error === 'expired_token') {
                    return { phase: 'error', error: '二维码已过期，请重新调用' };
                } else {
                    return {
                        phase: 'error',
                        error: `${pollRes.error}${pollRes.error_description ? ': ' + pollRes.error_description : ''}`
                    };
                }
            }
        }

        return { phase: 'error', error: '等待超时，二维码已过期' };
    }

    /**
     * 停止单个插件的指定 account（或全部 account）的 gateway 连接。
     * 会清理 channelStates 并发出断连事件。
     */
    private async stopChannelPluginAccounts(cp: ChannelPlugin, accountIds: string[]): Promise<void> {
        const config = this.getChannelConfig(cp.id);
        for (const accountId of accountIds) {
            const stateKey = `${cp.id}:${accountId}`;
            try {
                if (cp.gateway?.stopAccount) {
                    const account = cp.config.resolveAccount(config, accountId);
                    await cp.gateway.stopAccount({
                        accountId,
                        account,
                        cfg: config,
                        logger: {
                            info: () => {},
                            warn: () => {},
                            error: () => {},
                            debug: () => {}
                        },
                        dispatch: async () => {},
                        setStatus: () => {}
                    });
                }

                this.channelStates.delete(stateKey);
                this.emitEvent('channel:disconnected', { channelId: cp.id, accountId });
            } catch (err: any) {
                logger.error(`停止消息插件 ${cp.id}:${accountId} 失败: ${err?.message || err}`);
                this.channelStates.delete(stateKey);
            }
        }
    }

    async stopAllChannels(): Promise<void> {
        for (const plugin of this.plugins) {
            const cp = plugin.channelPlugin;
            if (!cp) continue;
            const config = this.getChannelConfig(cp.id);
            let accountIds: string[];
            try {
                accountIds = cp.config.listAccountIds(config);
            } catch {
                accountIds = ['default'];
            }
            await this.stopChannelPluginAccounts(cp, accountIds);
        }
        this.started = false;
        this.notifyStateChange();
    }

    /**
     * 重启指定渠道插件的 gateway 连接（先停止该插件的所有 account，再重新启动）。
     * 用于 loginChannel 成功后立即建立消息收发通道。
     */
    async restartChannelPlugin(channelId: string): Promise<void> {
        const entry = this.plugins.find((p) => p.channelPlugin?.id === channelId);
        if (!entry?.channelPlugin) {
            logger.warn(`[channelmgr] restartChannelPlugin: 未找到渠道 ${channelId}`);
            return;
        }

        const cp = entry.channelPlugin;

        // Collect ALL running account IDs for this channel from the state map,
        // plus any that the config says should exist, to ensure full cleanup.
        const runningAccountIds = new Set<string>();
        for (const [key] of this.channelStates) {
            if (key.startsWith(channelId + ':')) {
                runningAccountIds.add(key.slice(channelId.length + 1));
            }
        }
        const config = this.getChannelConfig(channelId);
        try {
            for (const id of cp.config.listAccountIds(config)) {
                runningAccountIds.add(id);
            }
        } catch {
            /* best effort */
        }

        const allAccountIds = Array.from(runningAccountIds);
        if (allAccountIds.length === 0) allAccountIds.push('default');

        logger.info(`[channelmgr] 正在重启渠道 ${channelId} 的连接 (accounts: ${allAccountIds.join(', ')})...`);

        await this.stopChannelPluginAccounts(cp, allAccountIds);
        await this.startChannelPlugin(entry);

        this.notifyStateChange();
        logger.info(`[channelmgr] 渠道 ${channelId} 重启完成`);
    }

    // ── 热重载 ───────────────────────────────────────────────────────────────

    private reloadPromise?: Promise<void>;

    /**
     * 热重载所有消息渠道插件：停止旧插件 → 清除模块缓存 → 重新加载 → 启动新插件。
     * 安装、卸载、启停、修改配置后自动调用，无需重启 OpenDesk。
     * 内部有互斥保护，并发调用会等待前一次完成后再执行。
     */
    async reloadChannels(): Promise<void> {
        if (this.reloadPromise) {
            await this.reloadPromise;
        }
        this.reloadPromise = this.doReloadChannels();
        try {
            await this.reloadPromise;
        } finally {
            this.reloadPromise = undefined;
        }
    }

    private async doReloadChannels(): Promise<void> {
        logger.info('[channelmgr] 开始热重载消息渠道插件...');

        // 1. Stop all running channel plugins
        await this.stopAllChannels();

        // 2. Re-collect native channels from the plugin host and start them
        this.plugins = [];
        this.loadNativeChannels();

        const channelPlugins = this.plugins.filter((p) => p.channelPlugin);
        logger.info(`[channelmgr] 重新加载完成: ${this.plugins.length} 个消息渠道`);

        // 3. Start all channel plugins
        for (const plugin of channelPlugins) {
            await this.startChannelPlugin(plugin);
        }

        this.started = true;
        this.notifyStateChange();

        logger.info('[channelmgr] 热重载完成');
    }

    // ── CLI 斜杠命令 ─────────────────────────────────────────────────────────

    getCliSlashCommands(tui: any): SlashCommandHandler[] {
        return [
            {
                name: 'plugins',
                description: '插件管理: /plugins install <npm-spec|url>|uninstall|list|enable|disable',
                getArgumentCompletions: (argPrefix: string) => {
                    const options = ['install', 'uninstall', 'list', 'enable', 'disable'];
                    const parts = argPrefix.split(/\s+/);
                    if (parts.length <= 1) {
                        return options
                            .filter((opt) => opt.startsWith((parts[0] || '').toLowerCase()))
                            .map((opt) => ({
                                value: opt,
                                label: opt,
                                description:
                                    {
                                        install: '安装插件',
                                        uninstall: '卸载插件',
                                        list: '列出已安装插件',
                                        enable: '启用插件',
                                        disable: '禁用插件'
                                    }[opt] || ''
                            }));
                    }
                    return null;
                },
                execute: async (args: string) => {
                    await this.handlePluginsCommand(args, tui);
                }
            },
            {
                name: 'channels',
                description: '消息插件管理: /channels list|status',
                getArgumentCompletions: (argPrefix: string) => {
                    const options = ['list', 'status'];
                    return options
                        .filter((opt) => opt.startsWith(argPrefix.toLowerCase()))
                        .map((opt) => ({
                            value: opt,
                            label: opt,
                            description: opt === 'list' ? '列出所有消息插件' : '查看消息插件状态'
                        }));
                },
                execute: async (args: string) => {
                    await this.handleChannelsCommand(args, tui);
                }
            }
        ];
    }

    private async handlePluginsCommand(args: string, tui: any): Promise<void> {
        const parts = args.trim().split(/\s+/);
        const subCmd = (parts[0] || '').toLowerCase();
        const rest = parts.slice(1).join(' ').trim();

        const showInfo = (title: string, message: string) => {
            new InfoOverlay(tui, { title, message }).show();
        };

        switch (subCmd) {
            case 'install': {
                if (!rest) {
                    showInfo(t('plugin.usage.hint'), '/plugins install <npm-spec|url>');
                    return;
                }
                const progress = new ProgressOverlay(tui, {
                    title: '安装中',
                    message: `正在安装插件: ${rest} ...\n\n请稍候，安装完成后会自动提示。`
                });
                progress.show();
                try {
                    const result = await installPlugin(rest);
                    if (result.success) {
                        await reloadPluginHost();
                        await this.reloadChannels();
                        progress.hide();
                        showInfo(t('plugin.install.success'), t('channel.install.success', { id: result.id }));
                    } else {
                        progress.hide();
                        showInfo(t('plugin.install.fail'), `插件安装失败: ${result.error}`);
                    }
                } catch (err: any) {
                    progress.hide();
                    showInfo(t('plugin.install.fail'), `插件安装出错: ${err?.message ?? err}`);
                }
                break;
            }
            case 'uninstall': {
                if (!rest) {
                    showInfo(t('plugin.usage.hint'), '/plugins uninstall <plugin-id>');
                    return;
                }
                const progress = new ProgressOverlay(tui, {
                    title: '卸载中',
                    message: `正在卸载插件: ${rest} ...\n\n请稍候，卸载完成后会自动提示。`
                });
                progress.show();
                try {
                    const result = await uninstallPlugin(rest);
                    if (result.success) {
                        await reloadPluginHost();
                        await this.reloadChannels();
                        progress.hide();
                        showInfo(t('plugin.uninstall.success'), t('channel.uninstall.success', { id: rest }));
                    } else {
                        progress.hide();
                        showInfo(t('plugin.uninstall.fail'), `插件卸载失败: ${result.error}`);
                    }
                } catch (err: any) {
                    progress.hide();
                    showInfo(t('plugin.uninstall.fail'), `插件卸载出错: ${err?.message ?? err}`);
                }
                break;
            }
            case 'list': {
                // PluginsListOverlay 的启停/卸载同样先重载宿主（使启停与卸载立即生效、
                // channel 注册随之更新），再重新收集渠道
                new PluginsListOverlay(tui, async () => {
                    await reloadPluginHost();
                    await this.reloadChannels();
                }).show();
                break;
            }
            case 'enable': {
                if (!rest) {
                    showInfo(t('plugin.usage.hint'), '/plugins enable <plugin-id>');
                    return;
                }
                if (setPluginEnabled(rest, true)) {
                    await reloadPluginHost();
                    await this.reloadChannels();
                    showInfo(t('plugin.enable.success'), t('channel.enable.success', { id: rest }));
                } else {
                    showInfo(t('plugin.enable.fail'), `未找到插件: ${rest}`);
                }
                break;
            }
            case 'disable': {
                if (!rest) {
                    showInfo(t('plugin.usage.hint'), '/plugins disable <plugin-id>');
                    return;
                }
                if (setPluginEnabled(rest, false)) {
                    await reloadPluginHost();
                    await this.reloadChannels();
                    showInfo(t('plugin.disable.success'), t('channel.disable.success', { id: rest }));
                } else {
                    showInfo(t('plugin.disable.fail'), `未找到插件: ${rest}`);
                }
                break;
            }
            default:
                showInfo(t('plugin.usage.hint'), '用法: /plugins install|uninstall|list|enable|disable');
        }
    }

    private async handleChannelsCommand(args: string, tui: any): Promise<void> {
        const subCmd = args.trim().toLowerCase();

        const showInfo = (title: string, message: string) => {
            new InfoOverlay(tui, { title, message }).show();
        };

        switch (subCmd) {
            case 'list': {
                const channels = this.getChannelPlugins();
                if (channels.length === 0) {
                    showInfo('消息插件', '暂无已注册的消息插件');
                } else {
                    const lines = channels.map(
                        (ch) => `  ${ch.id}: ${ch.label}${ch.description ? ` - ${ch.description}` : ''}`
                    );
                    showInfo('消息插件列表', lines.join('\n'));
                }
                break;
            }
            case 'status': {
                const states = this.getChannelStates();
                if (states.length === 0) {
                    showInfo('消息插件状态', '暂无运行中的消息插件');
                } else {
                    const lines = states.map((s) => {
                        const icon = s.status.online ? '●' : '○';
                        const statusText = s.status.statusText || (s.status.online ? '在线' : '离线');
                        const errText = s.status.error ? ` (${s.status.error})` : '';
                        return `  ${icon} ${s.channelId}:${s.accountId} - ${s.label} [${statusText}]${errText}`;
                    });
                    showInfo('消息插件状态', lines.join('\n'));
                }
                break;
            }
            default:
                showInfo('用法提示', '用法: /channels list|status');
        }
    }
}
