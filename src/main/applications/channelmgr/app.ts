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
 * 消息插件管理应用。
 * 加载、管理 OpenClaw 兼容的消息插件，并在插件与任务系统之间路由消息。
 */

import { z } from 'zod';
import { BaseApplication, EventDecl } from '../base.js';
import type { SlashCommandHandler } from '../../tui/commands/index.js';
import { logger } from '../../utils/logger.js';
import { InfoOverlay, ProgressOverlay } from '../../tui/components/notice.js';
import { PluginsListOverlay } from './plugins-tui.js';
import {
    loadPlugins,
    installPlugin,
    uninstallPlugin,
    setPluginEnabled,
} from '../../aikernel/plugins/index.js';
import type {
    PluginEntry,
    PluginLoadError,
    ChannelPlugin,
    ChannelAccountStatus,
    ChannelGatewayContext,
    InboundChannelMessage,
    ChannelAccountSnapshot,
    Participant,
} from '../../aikernel/plugins/types.js';
import { registerChannelDispatch } from '../../aikernel/plugins/openclaw/api.js';
import { ChannelMessageRouter, type ChannelReply } from './router.js';
import { getTempDirectory } from '../filemgr/tools.js';
import os from 'os';
import { Skill } from '../../aikernel/skill.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { MANAGE_CHANNELS_SKILL } from './skills.js';
import path from 'path';
import fs from 'fs';
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
} from './tools.js';
import { NotificationManager } from '../../utils/notificationmgr.js';

export interface ChannelRuntimeState {
    channelId: string;
    pluginId: string;
    accountId: string;
    status: ChannelAccountStatus;
    label: string;
}

export type ChannelStateChangeCallback = (states: ChannelRuntimeState[]) => void;

export class ChannelMgrApplication extends BaseApplication {

    private workspace?: string;
    private plugins: PluginEntry[] = [];
    private pluginLoadErrors: PluginLoadError[] = [];
    private channelStates: Map<string, ChannelRuntimeState> = new Map();
    private router?: ChannelMessageRouter;
    private initPromise?: Promise<void>;
    private started = false;
    private stateChangeCallbacks: ChannelStateChangeCallback[] = [];

    constructor() {
        super('channelmgr', '消息', false);
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
            try { cb(states); } catch { /* ignore callback errors */ }
        }
    }

    static getConfigSchema() {
        return z.object({}).loose().describe('消息插件配置（按插件 ID 设置各插件参数）');
    }

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [
            { eventName: 'channel:connected', eventDescription: '消息插件已连接' },
            { eventName: 'channel:disconnected', eventDescription: '消息插件已断开' },
            { eventName: 'channel:message', eventDescription: '收到消息插件消息' },
            { eventName: 'channel:error', eventDescription: '消息插件发生错误' },
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
        pluginToolset.addTool(new InstallChannelPluginTool());
        pluginToolset.addTool(new UninstallChannelPluginTool());
        pluginToolset.addTool(new ListChannelPluginsTool());
        pluginToolset.addTool(new ToggleChannelPluginTool());
        pluginToolset.addTool(new SetChannelConfigTool(this));
        pluginToolset.addTool(new GetChannelConfigTool(this));
        pluginToolset.addTool(new CreateFeishuBotTool());

        manageSkill.toolsets = [pairingToolset, pluginToolset];

        const skills: Skill[] = [manageSkill];

        // Load skills from installed channel plugins
        const pluginSkills = this.loadPluginSkills();
        skills.push(...pluginSkills);

        return skills;
    }

    /**
     * Scan all loaded plugins for SKILL.md files declared in their manifests.
     */
    private loadPluginSkills(): Skill[] {
        const skills: Skill[] = [];
        for (const plugin of this.plugins) {
            const manifest = plugin.manifest;
            const rootDir = plugin.rootDir;
            if (!manifest.skills?.length || !rootDir) continue;

            for (const skillPath of manifest.skills) {
                const resolvedDir = path.resolve(rootDir, skillPath);
                if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
                    logger.warn(`插件 ${plugin.id} 的 skills 路径不存在: ${resolvedDir}`);
                    continue;
                }

                try {
                    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (!entry.isDirectory()) continue;
                        const skillMdPath = path.join(resolvedDir, entry.name, 'SKILL.md');
                        if (!fs.existsSync(skillMdPath)) continue;

                        try {
                            const raw = fs.readFileSync(skillMdPath, 'utf-8');
                            const skill = Skill.parseMd(raw);
                            skill.directory = path.join(resolvedDir, entry.name);
                            logger.info(`已加载插件 ${plugin.id} 的 skill: ${skill.frontmatter.name}`);
                            skills.push(skill);
                        } catch (err: any) {
                            logger.warn(`解析插件 ${plugin.id} 的 skill ${entry.name} 失败: ${err?.message || err}`);
                        }
                    }
                } catch (err: any) {
                    logger.warn(`读取插件 ${plugin.id} 的 skills 目录失败: ${err?.message || err}`);
                }
            }
        }
        return skills;
    }

    /**
     * 初始化消息插件——加载插件并启动各 channel account。
     * 返回 Promise 以便外部能等待初始化完成。
     * @param router - 消息路由器
     * @param workspace - 工作目录路径，用于文件发送时验证文件路径
     */
    async initializeChannels(router: ChannelMessageRouter, workspace?: string): Promise<void> {
        this.workspace = workspace;
        this.router = router;

        const outboundToolset = new BaseToolset('channel-outbound');
        outboundToolset.addTool(new SendFileTool());
        router.addExtraToolset(outboundToolset);

        if (this.initPromise) return this.initPromise;

        this.initPromise = this.doInitialize();
        return this.initPromise;
    }

    /** 确保初始化已完成（dashboard 等调用方可 await） */
    async ensureReady(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
        }
    }

    private async doInitialize(): Promise<void> {
        if (this.started) return;
        try {
            const loadResult = await loadPlugins();
            this.plugins = loadResult.entries;
            this.pluginLoadErrors = loadResult.errors;
            const channelPlugins = this.plugins.filter(p => p.channelPlugin);
            logger.info(`已加载 ${this.plugins.length} 个插件，其中 ${channelPlugins.length} 个消息插件`);
            if (this.pluginLoadErrors.length > 0) {
                for (const e of this.pluginLoadErrors) {
                    logger.error(`插件 ${e.id} 加载失败: ${e.error}`);
                }
            }

            for (const plugin of channelPlugins) {
                await this.startChannelPlugin(plugin);
            }
            this.started = true;
        } catch (err: any) {
            logger.error(`消息插件初始化失败: ${err?.message || err}`);
        }
    }

    private async startChannelPlugin(entry: PluginEntry): Promise<void> {
        const cp = entry.channelPlugin!;
        const channelId = cp.id;
        const config = this.getChannelConfig(channelId);

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
                label: cp.meta.label,
            };
            this.channelStates.set(stateKey, state);

            if (cp.gateway?.startAccount) {
                try {
                    const account = cp.config.resolveAccount(config, accountId);
                    const ctx = this.createGatewayContext(cp, accountId, account, config);

                    registerChannelDispatch(channelId, accountId, async (message) => {
                        await this.handleInboundMessage(cp, accountId, message);
                    });

                    const startPromise = cp.gateway.startAccount(ctx);

                    // Monitor for late runtime errors (plugin crash, connection lost, etc.)
                    startPromise.catch((err: any) => {
                        const s = this.channelStates.get(stateKey);
                        if (s && s.status.online) {
                            s.status = { online: false, statusText: '断开', error: err?.message };
                            this.notifyStateChange();
                            this.emitEvent('channel:error', { channelId, accountId, error: err?.message });
                            logger.error(`消息插件 ${channelId}:${accountId} 断开连接: ${err?.message || err}`);
                        }
                    });

                    // Many plugins (e.g. Feishu) start long-running event loops in startAccount
                    // that never resolve. Wait briefly for fast failures (config/auth errors),
                    // then assume the plugin is running.
                    await Promise.race([
                        startPromise,
                        new Promise<void>(resolve => setTimeout(resolve, 5000)),
                    ]);

                    state.status = { online: true, statusText: '已连接' };
                    this.notifyStateChange();
                    this.emitEvent('channel:connected', { channelId, accountId });
                    NotificationManager.getInstance().info('插件系统', '消息渠道', `${channelId}:${accountId} 已就绪`);
                } catch (err: any) {
                    state.status = { online: false, statusText: '错误', error: err?.message };
                    this.notifyStateChange();
                    this.emitEvent('channel:error', { channelId, accountId, error: err?.message });
                    logger.error(`消息插件 ${channelId}:${accountId} 启动失败: ${err?.message || err}`);
                }
            } else {
                state.status = { online: true, statusText: '就绪' };
                this.notifyStateChange();
            }
        }
    }

    private abortControllers: Map<string, AbortController> = new Map();

    private createGatewayContext(
        cp: ChannelPlugin,
        accountId: string,
        account: any,
        config: any,
    ): ChannelGatewayContext {
        const stateKey = `${cp.id}:${accountId}`;
        const tag = `[${cp.id}:${accountId}]`;
        const fmt = (...args: any[]) => args.map(a => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a, null, 2) ?? String(a); }
            catch { return String(a); }
        }).join(' ');

        const pluginLogger = {
            info: (...args: any[]) => logger.info(`${tag} ${fmt(...args)}`),
            warn: (...args: any[]) => logger.warn(`${tag} ${fmt(...args)}`),
            error: (...args: any[]) => logger.error(`${tag} ${fmt(...args)}`),
            debug: (...args: any[]) => logger.info(`${tag}[debug] ${fmt(...args)}`),
        };

        // Create an AbortController for this channel account
        const abortController = new AbortController();
        this.abortControllers.set(stateKey, abortController);

        return {
            accountId,
            account,
            cfg: config,
            logger: pluginLogger,
            log: pluginLogger,
            runtime: {
                log: (...args: any[]) => logger.info(`${tag} ${fmt(...args)}`),
                error: (...args: any[]) => logger.error(`${tag} ${fmt(...args)}`),
                warn: (...args: any[]) => logger.warn(`${tag} ${fmt(...args)}`),
                platform: 'opendesk',
            },
            abortSignal: abortController.signal,
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
                    state.status = status;
                    this.notifyStateChange();
                }
            },
        };
    }

    private async handleInboundMessage(
        cp: ChannelPlugin,
        accountId: string,
        message: InboundChannelMessage,
    ): Promise<void> {
        if (!this.router) {
            logger.warn('消息路由未配置，丢弃入站消息');
            return;
        }

        const replyTo = (message.chatType === 'group' && message.groupId)
            ? message.groupId
            : message.senderId;
        const cfg = this.getChannelConfig(cp.id);
        const baseCtx = {
            channelId: cp.id, accountId,
            to: replyTo,
            threadId: message.threadId,
            replyToMessageId: message.messageId,
            cfg,
        };

        const reply = await this.router.routeInboundMessage(message);
        if (!reply) return;

        logger.info(`[channelmgr] routeInboundMessage returned: "${reply?.text?.substring(0, 50)}..."`);
        const mediaLocalRoots = [getTempDirectory()];
        if (this.workspace) {
            mediaLocalRoots.push(this.workspace);
        }
        const hasMedia = reply.mediaUrls.length > 0;
        logger.info(`[channelmgr] hasMedia=${hasMedia}, mediaUrls=${JSON.stringify(reply.mediaUrls)}`);

        try {
            if (hasMedia && cp.outbound?.sendPayload) {
                logger.info(`[channelmgr] using sendPayload with text="${reply.text?.substring(0, 50)}...", media=${reply.mediaUrls[0]}`);
                await cp.outbound.sendPayload({
                    ...baseCtx,
                    payload: {
                        text: reply.text,
                        mediaUrl: reply.mediaUrls[0],
                        mediaUrls: reply.mediaUrls,
                    },
                    mediaLocalRoots,
                });
            } else if (hasMedia && cp.outbound?.sendMedia) {
                logger.info(`[channelmgr] using sendMedia, ${reply.mediaUrls.length} files`);
                // Send first media with text, rest without
                for (let i = 0; i < reply.mediaUrls.length; i++) {
                    await cp.outbound.sendMedia({
                        ...baseCtx,
                        text: i === 0 ? reply.text : '',
                        mediaUrl: reply.mediaUrls[i],
                        mediaLocalRoots,
                    });
                }
            } else if (reply.text && cp.outbound?.sendText) {
                logger.info(`[channelmgr] using sendText, text="${reply.text?.substring(0, 50)}..."`);
                await cp.outbound.sendText({ ...baseCtx, text: reply.text });
            } else if (reply.text && cp.outbound?.sendPayload) {
                logger.info(`[channelmgr] using sendPayload (text only), text="${reply.text?.substring(0, 50)}..."`);
                await cp.outbound.sendPayload({ ...baseCtx, payload: { text: reply.text } });
            } else {
                logger.warn(`[channelmgr] no suitable send method: hasMedia=${hasMedia}, hasText=${!!reply.text}, sendPayload=${!!cp.outbound?.sendPayload}, sendMedia=${!!cp.outbound?.sendMedia}, sendText=${!!cp.outbound?.sendText}`);
            }
        } catch (err: any) {
            logger.error(`发送回复失败 ${cp.id}:${accountId}: ${err?.message || err}`);
        }
    }

    /**
     * 获取某个消息插件的完整配置。
     * 用户在 OpenDesk 配置中写 applications.channelmgr.{channelId} 来设置参数。
     */
    private getChannelConfig(channelId: string): any {
        const config = this.getConfig() || {};
        return {
            channels: {
                [channelId]: config[channelId] || {},
            },
            ...config,
        };
    }

    // ── 查询方法 ─────────────────────────────────────────────────────────────

    getChannelStates(): ChannelRuntimeState[] {
        return Array.from(this.channelStates.values());
    }

    getChannelPlugins(): { id: string; label: string; description?: string }[] {
        return this.plugins
            .filter(p => p.channelPlugin)
            .map(p => ({
                id: p.channelPlugin!.id,
                label: p.channelPlugin!.meta.label,
                description: p.channelPlugin!.meta.description,
            }));
    }

    getPluginLoadErrors(): PluginLoadError[] {
        return this.pluginLoadErrors;
    }

    /**
     * 向指定的 Participant 发送文本消息。
     * 用于定时任务等场景下根据 task.origin 发送回复。
     */
    async sendTextToParticipant(participant: Participant, text: string): Promise<void> {
        const { channel, accountId, recipientId } = participant;

        logger.info(`[channelmgr] sendTextToParticipant: channel=${channel}, accountId=${accountId}, recipientId=${recipientId}, text_len=${text.length}`);

        // Find the channel plugin
        const entry = this.plugins.find(p => p.channelPlugin?.id === channel);
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
            cfg: config,
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
     * 根据 Participant 获取 channel 和 account 信息。
     */
    getParticipantInfo(participant: Participant): { channelId: string; accountId: string; recipientId: string; label: string } | null {
        const entry = this.plugins.find(p => p.channelPlugin?.id === participant.channel);
        if (!entry?.channelPlugin) {
            return null;
        }
        return {
            channelId: participant.channel,
            accountId: participant.accountId,
            recipientId: participant.recipientId,
            label: entry.channelPlugin.meta.label,
        };
    }

    async stopAllChannels(): Promise<void> {
        for (const plugin of this.plugins) {
            const cp = plugin.channelPlugin;
            if (!cp?.gateway?.stopAccount) continue;
            const config = this.getChannelConfig(cp.id);
            let accountIds: string[];
            try { accountIds = cp.config.listAccountIds(config); } catch { accountIds = ['default']; }

            for (const accountId of accountIds) {
                try {
                    const account = cp.config.resolveAccount(config, accountId);
                    await cp.gateway.stopAccount({
                        accountId, account, cfg: config,
                        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
                        dispatch: async () => {}, setStatus: () => {},
                    });
                    const state = this.channelStates.get(`${cp.id}:${accountId}`);
                    if (state) {
                        state.status = { online: false, statusText: '已停止' };
                        this.notifyStateChange();
                    }
                    this.emitEvent('channel:disconnected', { channelId: cp.id, accountId });
                } catch (err: any) {
                    logger.error(`停止消息插件 ${cp.id}:${accountId} 失败: ${err?.message || err}`);
                }
            }
        }
        this.started = false;
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
                            .filter(opt => opt.startsWith((parts[0] || '').toLowerCase()))
                            .map(opt => ({
                                value: opt, label: opt,
                                description: { install: '安装插件', uninstall: '卸载插件', list: '列出已安装插件', enable: '启用插件', disable: '禁用插件' }[opt] || '',
                            }));
                    }
                    return null;
                },
                execute: async (args: string) => { await this.handlePluginsCommand(args, tui); },
            },
            {
                name: 'channels',
                description: '消息插件管理: /channels list|status',
                getArgumentCompletions: (argPrefix: string) => {
                    const options = ['list', 'status'];
                    return options
                        .filter(opt => opt.startsWith(argPrefix.toLowerCase()))
                        .map(opt => ({
                            value: opt, label: opt,
                            description: opt === 'list' ? '列出所有消息插件' : '查看消息插件状态',
                        }));
                },
                execute: async (args: string) => { await this.handleChannelsCommand(args, tui); },
            },
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
                if (!rest) { showInfo('用法提示', '/plugins install <npm-spec|url>'); return; }
                const progress = new ProgressOverlay(tui, {
                    title: '安装中',
                    message: `正在安装插件: ${rest} ...\n\n请稍候，安装完成后会自动提示。`,
                });
                progress.show();
                try {
                    const result = await installPlugin(rest);
                    progress.hide();
                    if (result.success) {
                        showInfo('安装成功', `插件安装成功: ${result.id}\n\n请重启 OpenDesk 以加载新插件`);
                    } else {
                        showInfo('安装失败', `插件安装失败: ${result.error}`);
                    }
                } catch (err: any) {
                    progress.hide();
                    showInfo('安装失败', `插件安装出错: ${err?.message ?? err}`);
                }
                break;
            }
            case 'uninstall': {
                if (!rest) { showInfo('用法提示', '/plugins uninstall <plugin-id>'); return; }
                const progress = new ProgressOverlay(tui, {
                    title: '卸载中',
                    message: `正在卸载插件: ${rest} ...\n\n请稍候，卸载完成后会自动提示。`,
                });
                progress.show();
                try {
                    const result = await uninstallPlugin(rest);
                    progress.hide();
                    if (result.success) showInfo('卸载成功', `插件已卸载: ${rest}`);
                    else showInfo('卸载失败', `插件卸载失败: ${result.error}`);
                } catch (err: any) {
                    progress.hide();
                    showInfo('卸载失败', `插件卸载出错: ${err?.message ?? err}`);
                }
                break;
            }
            case 'list': {
                new PluginsListOverlay(tui).show();
                break;
            }
            case 'enable': {
                if (!rest) { showInfo('用法提示', '/plugins enable <plugin-id>'); return; }
                if (setPluginEnabled(rest, true)) showInfo('启用成功', `插件已启用: ${rest}\n\n请重启 OpenDesk 以生效`);
                else showInfo('启用失败', `未找到插件: ${rest}`);
                break;
            }
            case 'disable': {
                if (!rest) { showInfo('用法提示', '/plugins disable <plugin-id>'); return; }
                if (setPluginEnabled(rest, false)) showInfo('禁用成功', `插件已禁用: ${rest}\n\n请重启 OpenDesk 以生效`);
                else showInfo('禁用失败', `未找到插件: ${rest}`);
                break;
            }
            default:
                showInfo('用法提示', '用法: /plugins install|uninstall|list|enable|disable');
        }
    }

    private async handleChannelsCommand(args: string, tui: any): Promise<void> {
        const subCmd = args.trim().toLowerCase();

        const showInfo = (title: string, message: string) => {
            new InfoOverlay(tui, { title, message }).show();
        };

        const errorLines = this.pluginLoadErrors.map(e =>
            `  ✗ ${e.id}: 加载失败 - ${e.error}`
        );
        const errorSection = errorLines.length > 0
            ? `\n\n加载失败的插件:\n${errorLines.join('\n')}`
            : '';

        switch (subCmd) {
            case 'list': {
                const channels = this.getChannelPlugins();
                if (channels.length === 0 && errorLines.length === 0) {
                    showInfo('消息插件', '暂无已注册的消息插件');
                } else {
                    const lines = channels.map(ch =>
                        `  ${ch.id}: ${ch.label}${ch.description ? ` - ${ch.description}` : ''}`
                    );
                    const body = channels.length > 0 ? lines.join('\n') : '暂无已成功加载的消息插件';
                    showInfo('消息插件列表', body + errorSection);
                }
                break;
            }
            case 'status': {
                const states = this.getChannelStates();
                if (states.length === 0 && errorLines.length === 0) {
                    showInfo('消息插件状态', '暂无运行中的消息插件');
                } else {
                    const lines = states.map(s => {
                        const icon = s.status.online ? '●' : '○';
                        const statusText = s.status.statusText || (s.status.online ? '在线' : '离线');
                        const errText = s.status.error ? ` (${s.status.error})` : '';
                        return `  ${icon} ${s.channelId}:${s.accountId} - ${s.label} [${statusText}]${errText}`;
                    });
                    const body = states.length > 0 ? lines.join('\n') : '暂无运行中的消息插件';
                    showInfo('消息插件状态', body + errorSection);
                }
                break;
            }
            default:
                showInfo('用法提示', '用法: /channels list|status');
        }
    }
}