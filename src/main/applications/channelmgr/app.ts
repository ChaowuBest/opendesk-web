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
import type { SlashCommandHandler } from '../../tui/commands.js';
import { logger } from '../../utils/logger.js';
import {
    loadPlugins,
    installPlugin,
    uninstallPlugin,
    listInstalledPlugins,
    setPluginEnabled,
} from '../../aikernel/plugins/index.js';
import type {
    PluginEntry,
    ChannelPlugin,
    ChannelAccountStatus,
    ChannelGatewayContext,
    InboundChannelMessage,
    ChannelAccountSnapshot,
} from '../../aikernel/plugins/types.js';
import { registerChannelDispatch } from '../../aikernel/plugins/openclaw/api.js';
import { ChannelMessageRouter } from './router.js';
import { Skill } from '../../aikernel/skill.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { MANAGE_CHANNELS_SKILL } from './skills.js';
import {
    ListPairingRequestsTool,
    ApprovePairingTool,
    RevokePairingTool,
    ListApprovedUsersTool,
    ListChannelStatusTool,
} from './tools.js';

export interface ChannelRuntimeState {
    channelId: string;
    pluginId: string;
    accountId: string;
    status: ChannelAccountStatus;
    label: string;
}

export class ChannelMgrApplication extends BaseApplication {

    private plugins: PluginEntry[] = [];
    private channelStates: Map<string, ChannelRuntimeState> = new Map();
    private router?: ChannelMessageRouter;
    private initPromise?: Promise<void>;
    private started = false;

    constructor() {
        super('channelmgr', '消息', false);
    }

    static getConfigSchema() {
        return z.object({}).passthrough().describe('消息插件配置（按插件 ID 设置各插件参数）');
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
        const skill = Skill.parseMd(MANAGE_CHANNELS_SKILL);
        const toolset = new BaseToolset('channel-pairing');
        toolset.addTool(new ListPairingRequestsTool());
        toolset.addTool(new ApprovePairingTool());
        toolset.addTool(new RevokePairingTool());
        toolset.addTool(new ListApprovedUsersTool());
        toolset.addTool(new ListChannelStatusTool(this));
        skill.toolsets = [toolset];
        return [skill];
    }

    /**
     * 初始化消息插件——加载插件并启动各 channel account。
     * 返回 Promise 以便外部能等待初始化完成。
     */
    async initializeChannels(router: ChannelMessageRouter): Promise<void> {
        this.router = router;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this.doInitialize();
        return this.initPromise;
    }

    /** 确保初始化已完成（dashboard 等调用方可 await） */
    async ensureReady(): Promise<void> {
        if (this.initPromise) await this.initPromise;
    }

    private async doInitialize(): Promise<void> {
        if (this.started) return;
        try {
            this.plugins = await loadPlugins();
            const channelPlugins = this.plugins.filter(p => p.channelPlugin);
            logger.info(`已加载 ${this.plugins.length} 个插件，其中 ${channelPlugins.length} 个消息插件`);

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
                    this.emitEvent('channel:connected', { channelId, accountId });
                    logger.info(`消息插件 ${channelId}:${accountId} 启动成功`);
                } catch (err: any) {
                    state.status = { online: false, statusText: '错误', error: err?.message };
                    this.emitEvent('channel:error', { channelId, accountId, error: err?.message });
                    logger.error(`消息插件 ${channelId}:${accountId} 启动失败: ${err?.message || err}`);
                }
            } else {
                state.status = { online: true, statusText: '就绪' };
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
                    text: message.text?.substring(0, 100),
                });
                await this.handleInboundMessage(cp, accountId, message);
            },
            setStatus: (status: ChannelAccountStatus) => {
                const state = this.channelStates.get(stateKey);
                if (state) state.status = status;
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

        const reply = await this.router.routeInboundMessage(message);
        if (!reply) return;

        const replyTo = (message.chatType === 'group' && message.groupId)
            ? message.groupId
            : message.senderId;

        if (cp.outbound?.sendText) {
            try {
                await cp.outbound.sendText({
                    channelId: cp.id, accountId,
                    to: replyTo, text: reply,
                    threadId: message.threadId,
                    replyToMessageId: message.messageId,
                    cfg: this.getChannelConfig(cp.id),
                });
            } catch (err: any) {
                logger.error(`发送回复失败 ${cp.id}:${accountId}: ${err?.message || err}`);
            }
        } else if (cp.outbound?.sendPayload) {
            try {
                await cp.outbound.sendPayload({
                    channelId: cp.id, accountId,
                    to: replyTo, payload: { text: reply },
                    threadId: message.threadId,
                    replyToMessageId: message.messageId,
                    cfg: this.getChannelConfig(cp.id),
                });
            } catch (err: any) {
                logger.error(`发送回复失败 ${cp.id}:${accountId}: ${err?.message || err}`);
            }
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
                    if (state) state.status = { online: false, statusText: '已停止' };
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
                execute: async (args: string) => { await this.handlePluginsCommand(args); },
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
                execute: async (args: string) => { await this.handleChannelsCommand(args); },
            },
        ];
    }

    private async handlePluginsCommand(args: string): Promise<void> {
        const parts = args.trim().split(/\s+/);
        const subCmd = (parts[0] || '').toLowerCase();
        const rest = parts.slice(1).join(' ').trim();

        switch (subCmd) {
            case 'install': {
                if (!rest) { logger.warn('用法: /plugins install <npm-spec|url>'); return; }
                logger.info(`正在安装插件: ${rest} ...`);
                const result = await installPlugin(rest);
                if (result.success) {
                    logger.info(`插件安装成功: ${result.id}`);
                    logger.info('请重启 OpenDesk 以加载新插件');
                } else {
                    logger.error(`插件安装失败: ${result.error}`);
                }
                break;
            }
            case 'uninstall': {
                if (!rest) { logger.warn('用法: /plugins uninstall <plugin-id>'); return; }
                const result = await uninstallPlugin(rest);
                if (result.success) logger.info(`插件已卸载: ${rest}`);
                else logger.error(`插件卸载失败: ${result.error}`);
                break;
            }
            case 'list': {
                const records = listInstalledPlugins();
                if (records.length === 0) {
                    logger.info('暂无已安装的插件');
                } else {
                    for (const r of records) {
                        const status = r.enabled ? '✓ 已启用' : '✗ 已禁用';
                        logger.info(`  ${r.id} (${r.npmSpec}) [${status}]`);
                    }
                }
                break;
            }
            case 'enable': {
                if (!rest) { logger.warn('用法: /plugins enable <plugin-id>'); return; }
                if (setPluginEnabled(rest, true)) logger.info(`插件已启用: ${rest}，请重启 OpenDesk 以生效`);
                else logger.error(`未找到插件: ${rest}`);
                break;
            }
            case 'disable': {
                if (!rest) { logger.warn('用法: /plugins disable <plugin-id>'); return; }
                if (setPluginEnabled(rest, false)) logger.info(`插件已禁用: ${rest}，请重启 OpenDesk 以生效`);
                else logger.error(`未找到插件: ${rest}`);
                break;
            }
            default:
                logger.warn('用法: /plugins install|uninstall|list|enable|disable');
        }
    }

    private async handleChannelsCommand(args: string): Promise<void> {
        const subCmd = args.trim().toLowerCase();
        switch (subCmd) {
            case 'list': {
                const channels = this.getChannelPlugins();
                if (channels.length === 0) {
                    logger.info('暂无已注册的消息插件');
                } else {
                    for (const ch of channels) {
                        logger.info(`  ${ch.id}: ${ch.label}${ch.description ? ` - ${ch.description}` : ''}`);
                    }
                }
                break;
            }
            case 'status': {
                const states = this.getChannelStates();
                if (states.length === 0) {
                    logger.info('暂无运行中的消息插件');
                } else {
                    for (const s of states) {
                        const icon = s.status.online ? '●' : '○';
                        const statusText = s.status.statusText || (s.status.online ? '在线' : '离线');
                        const errorText = s.status.error ? ` (${s.status.error})` : '';
                        logger.info(`  ${icon} ${s.channelId}:${s.accountId} - ${s.label} [${statusText}]${errorText}`);
                    }
                }
                break;
            }
            default:
                logger.warn('用法: /channels list|status');
        }
    }
}