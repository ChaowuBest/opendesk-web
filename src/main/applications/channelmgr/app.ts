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
    invalidatePluginRequireCache
} from '../../plugins/index.js';
import type {
    PluginEntry,
    PluginLoadError,
    ChannelPlugin,
    ChannelAccountStatus,
    ChannelGatewayContext,
    InboundChannelMessage,
    ChannelAccountSnapshot,
    Participant
} from '../../plugins/types.js';
import {
    registerChannelDispatch,
    unregisterChannelDispatch,
    getChannelDispatcher,
    setPairingProvider
} from '../../plugins/openclaw/api.js';
import * as pairing from './pairing.js';
import { recordContact, getContacts } from './contacts.js';
import { ChannelMessageRouter, type ChannelReply } from './router.js';
import { getTempDirectory } from '../filemgr/tools.js';
import os from 'os';
import { Skill } from '../../aikernel/skill.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { MANAGE_CHANNELS_SKILL } from './skills.js';
import path from 'path';
import fs from 'fs';
import { getTempDir } from '../../utils/temp.js';
import { getPlatform } from '../../../platforms/base.js';
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
    LoginChannelTool,
    type LoginChannelState
} from './tools.js';
import { feishuAuthInit, feishuAuthBegin, feishuAuthPoll } from './feishu-auth.js';
import { NotificationManager } from '../../utils/notificationmgr.js';
import { ToolResult } from '../../aikernel/tool.js';
import { t } from '../../../locale/index.js';
import qrcodeTerminal from 'qrcode-terminal';
import chalk from 'chalk';
import { getAdaptiveGreen } from '../../tui/theme.js';

export interface ChannelRuntimeState {
    channelId: string;
    pluginId: string;
    accountId: string;
    status: ChannelAccountStatus;
    label: string;
}

const CHANNEL_DISPLAY_NAMES: Record<string, string> = {
    feishu: '飞书',
    'openclaw-weixin': '微信',
    whatsapp: 'WhatsApp',
    zalouser: 'Zalo',
    telegram: 'Telegram',
    discord: 'Discord',
    slack: 'Slack',
    signal: 'Signal'
};

function resolveChannelDisplayName(channelId: string, fallbackLabel: string): string {
    return CHANNEL_DISPLAY_NAMES[channelId] ?? fallbackLabel;
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
            { eventName: 'channel:connected', eventDescription: t('channel.event.connected') },
            { eventName: 'channel:disconnected', eventDescription: t('channel.event.disconnected') },
            { eventName: 'channel:message', eventDescription: t('channel.event.message') },
            { eventName: 'channel:error', eventDescription: t('channel.event.error') }
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
            setPairingProvider(pairing);
            const loadResult = await loadPlugins();
            this.plugins = loadResult.entries;
            this.pluginLoadErrors = loadResult.errors;
            const channelPlugins = this.plugins.filter((p) => p.channelPlugin);
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
                label: resolveChannelDisplayName(channelId, cp.meta.label)
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
                        `${channelId}:${accountId} ${t('channel.ready')}`
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

    private abortControllers: Map<string, AbortController> = new Map();

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
                platform: 'opendesk'
            },
            // ── OpenClaw session / store ─────────────────────────────────────
            session: {
                resolveStorePath: (sessionCfg: any, opts: any) => {
                    const sessionKey = `${cp.id}:${accountId}:${opts?.to || ''}`;
                    return sessionKey;
                },
                recordInboundSession: async (params: any) => {
                    logger.debug(
                        `recordInboundSession: storePath=${params?.storePath}, sessionKey=${params?.sessionKey}`
                    );
                }
            },
            // ── OpenClaw reply / inbound ─────────────────────────────────────
            reply: {
                finalizeInboundContext: (ctx: any) => ctx || {},
                resolveHumanDelayConfig: (cfg: any, agentId: any) => ({ delayMs: 0 })
            },
            // ── OpenClaw routing ───────────────────────────────────────────────
            routing: {
                resolveAgentRoute: (params: any) => {
                    const sessionKey = `${cp.id}:${accountId}:${params?.peer?.id || ''}`;
                    return {
                        agentId: params?.agentId || null,
                        sessionKey,
                        mainSessionKey: sessionKey
                    };
                }
            },
            // ── OpenClaw commands runtime ──────────────────────────────────────
            commands: {
                resolveSenderCommandAuthorizationWithRuntime: async (params: any) => {
                    return { senderAllowedForCommands: true, commandAuthorized: true };
                }
            },
            abortSignal: abortController.signal,

            // OpenClaw compat: channelRuntime surface for newer plugins
            // (weixin >= 2.4, feishu >= 2026.5) that access helpers via
            // ctx.channelRuntime.media / .routing / .session / .reply / .commands etc.
            channelRuntime: {
                media: {
                    saveMediaBuffer: async (
                        buffer: Buffer,
                        contentType: string,
                        _dir?: string,
                        _maxBytes?: number,
                        fileName?: string
                    ) => {
                        const ext = contentType?.split('/')[1]?.split(';')[0] || 'bin';
                        const name = fileName || `media-${Date.now()}.${ext}`;
                        const mediaDir = path.join(getTempDir(), 'opendesk-media');
                        if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
                        const filePath = path.join(mediaDir, name);
                        fs.writeFileSync(filePath, buffer);
                        return { path: filePath, contentType: contentType || 'application/octet-stream' };
                    },
                    fetchRemoteMedia: async (url: string) => {
                        const resp = await getPlatform().fetch(url);
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                        const buffer = Buffer.from(await resp.arrayBuffer());
                        const ct =
                            resp.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
                        return { buffer, contentType: ct };
                    }
                },
                routing: {
                    buildAgentSessionKey: (params: any) => `${cp.id}:${accountId}:${params?.peer?.id || ''}`,
                    resolveAgentRoute: (params: any) => {
                        const sessionKey = `${cp.id}:${accountId}:${params?.peer?.id || ''}`;
                        return {
                            agentId: params?.agentId || null,
                            sessionKey,
                            mainSessionKey: sessionKey
                        };
                    }
                },
                session: {
                    resolveStorePath: (_sessionCfg: any, opts: any) => `${opts?.agentId || 'default'}`,
                    recordInboundSession: async (_params: any) => {},
                    readSessionUpdatedAt: async () => null,
                    recordSessionMetaFromInbound: async () => {},
                    updateLastRoute: async () => {}
                },
                reply: {
                    finalizeInboundContext: (ctx: any) => ctx || {},
                    resolveHumanDelayConfig: (_cfg?: any, _agentId?: string) => ({
                        enabled: false,
                        minMs: 0,
                        maxMs: 0,
                        delayMs: 0
                    }),
                    resolveEffectiveMessagesConfig: (_cfg?: any) => ({}),
                    createReplyDispatcherWithTyping: (params: any) => {
                        const deliver = params.deliver || (async () => {});
                        return {
                            dispatcher: { deliver, onIdle: params.onIdle, onCleanup: params.onCleanup },
                            replyOptions: {},
                            markDispatchIdle: () => {
                                params.onIdle?.();
                                params.onCleanup?.();
                            }
                        };
                    },
                    withReplyDispatcher: async (params: any) => {
                        try {
                            await params.run();
                        } finally {
                            params.onSettled?.();
                        }
                        return { queuedFinal: true, counts: { final: 1 } };
                    },
                    settleReplyDispatcher: async () => {},
                    dispatchReplyFromConfig: async (params: any) => {
                        const ctx = params.ctx;
                        if (!ctx) return;
                        const channelId = ctx.Provider || ctx.OriginatingChannel || cp.id;
                        const acctId = ctx.AccountId || accountId;
                        const dispatch = getChannelDispatcher(channelId, acctId);
                        if (!dispatch) {
                            logger.warn(`[channelRuntime] no dispatch registered for ${channelId}:${acctId}`);
                            return;
                        }
                        const body: string = ctx.Body || ctx.RawBody || '';
                        const isGroup = ctx.ChatType === 'group';
                        const mediaPaths: string[] = ctx.MediaPaths || ctx.MediaUrls || [];
                        if (mediaPaths.length === 0 && (ctx.MediaPath || ctx.MediaUrl)) {
                            mediaPaths.push(ctx.MediaPath || ctx.MediaUrl);
                        }
                        const mediaTypes: string[] = ctx.MediaTypes || [];
                        if (mediaTypes.length === 0 && ctx.MediaType) mediaTypes.push(ctx.MediaType);
                        const media = mediaPaths.map((p: string, i: number) => ({
                            path: p,
                            contentType: mediaTypes[i] || undefined
                        }));
                        const message: InboundChannelMessage = {
                            channelId,
                            accountId: acctId,
                            senderId: ctx.SenderId || ctx.From || '',
                            senderName: ctx.SenderName,
                            text: body,
                            chatType: isGroup ? 'group' : 'direct',
                            groupId: isGroup ? ctx.GroupSubject : undefined,
                            threadId: ctx.RootMessageId,
                            messageId: ctx.MessageSid,
                            replyToMessageId: ctx.ReplyToId,
                            media: media.length > 0 ? media : undefined,
                            raw: ctx
                        };
                        await dispatch(message);
                    },
                    formatAgentEnvelope: (params: any) => params.body || '',
                    resolveEnvelopeFormatOptions: () => ({ includeTimestamp: false, includeChannel: false }),
                    formatInboundEnvelope: (params: any) => params.body || ''
                },
                commands: {
                    resolveCommandAuthorizedFromAuthorizers: (_params?: any) => true,
                    isControlCommandMessage: (text: string) => {
                        if (!text) return false;
                        const t = text.trim();
                        return t.startsWith('/') || t === '!stop' || t === '!reset';
                    },
                    shouldComputeCommandAuthorized: (text: string) => {
                        if (!text) return false;
                        const t = text.trim();
                        return t.startsWith('/') || t.startsWith('!');
                    },
                    shouldHandleTextCommands: () => true
                },
                pairing: {
                    buildPairingReply: (params: any) => {
                        return `配对码: ${params.code || ''}`;
                    },
                    readAllowFromStore: () => [],
                    upsertPairingRequest: () => ({ code: '', created: false })
                },
                text: {
                    chunkByNewline: (text: string) => (text ? text.split('\n') : []),
                    chunkMarkdownText: (text: string, limit?: number) => {
                        if (!text || text.length <= (limit || 4000)) return [text];
                        return [text.slice(0, limit || 4000)];
                    },
                    chunkMarkdownTextWithMode: (text: string, limit?: number) => {
                        if (!text || text.length <= (limit || 4000)) return [text];
                        return [text.slice(0, limit || 4000)];
                    },
                    chunkText: (text: string, limit?: number) => {
                        if (!text || text.length <= (limit || 4000)) return [text];
                        return [text.slice(0, limit || 4000)];
                    },
                    chunkTextWithMode: (text: string, limit?: number) => {
                        if (!text || text.length <= (limit || 4000)) return [text];
                        return [text.slice(0, limit || 4000)];
                    },
                    resolveChunkMode: () => 'text' as const,
                    resolveTextChunkLimit: () => 4000,
                    hasControlCommand: (text: string) => {
                        if (!text) return false;
                        const t = text.trim();
                        return t.startsWith('/') || t === '!stop' || t === '!reset';
                    },
                    resolveMarkdownTableMode: () => 'native' as const,
                    convertMarkdownTables: (text: string) => text
                },
                debounce: {
                    resolveInboundDebounceMs: () => 1500,
                    createInboundDebouncer: (opts: any) => ({
                        enqueue: (event: any) => opts.onFlush?.([event])
                    })
                },
                activity: {
                    record: () => {},
                    get: () => null
                },
                groups: {
                    resolveGroupPolicy: () => 'open',
                    resolveRequireMention: () => false
                },
                mentions: {
                    buildMentionRegexes: () => [],
                    matchesMentionPatterns: () => false,
                    matchesMentionWithExplicit: () => false,
                    implicitMentionKindWhen: () => undefined,
                    resolveInboundMentionDecision: () => ({ allowed: true })
                },
                reactions: {
                    createAckReactionHandle: () => null,
                    shouldAckReaction: () => false,
                    removeAckReactionAfterReply: async () => {},
                    removeAckReactionHandleAfterReply: async () => {}
                },
                outbound: {
                    loadAdapter: () => null
                },
                turn: {
                    run: async () => {},
                    runAssembled: async () => {},
                    runResolved: async () => {},
                    buildContext: () => ({}),
                    runPrepared: async () => {},
                    dispatchAssembled: async () => {}
                },
                threadBindings: {
                    setIdleTimeoutBySessionKey: () => [],
                    setMaxAgeBySessionKey: () => []
                },
                runtimeContexts: {
                    register: () => ({ dispose: () => {} }),
                    get: () => undefined,
                    watch: () => () => {}
                }
            },

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
        const cfg = this.getChannelConfig(cp.id);
        const baseCtx = {
            channelId: cp.id,
            accountId,
            to: replyTo,
            threadId: message.threadId,
            replyToMessageId: message.messageId,
            cfg
        };

        const reply = await this.router.routeInboundMessage(message);
        if (!reply) return;

        logger.info(`[channelmgr] routeInboundMessage returned: "${reply?.text?.substring(0, 50)}..."`);
        const mediaLocalRoots = [getTempDirectory(), os.tmpdir(), '/tmp'];
        if (this.workspace) {
            mediaLocalRoots.push(this.workspace);
        }
        const hasMedia = reply.mediaUrls.length > 0;
        logger.info(`[channelmgr] hasMedia=${hasMedia}, mediaUrls=${JSON.stringify(reply.mediaUrls)}`);

        // 1. 先发送文本部分（确保文本消息始终送达）
        try {
            if (reply.text) {
                if (cp.outbound?.sendText) {
                    logger.info(`[channelmgr] sending text: "${reply.text?.substring(0, 50)}..."`);
                    await cp.outbound.sendText({ ...baseCtx, text: reply.text });
                } else if (cp.outbound?.sendPayload) {
                    logger.info(`[channelmgr] sending text via sendPayload: "${reply.text?.substring(0, 50)}..."`);
                    await cp.outbound.sendPayload({ ...baseCtx, payload: { text: reply.text } });
                }
            }
        } catch (err: any) {
            logger.error(`发送文本回复失败 ${cp.id}:${accountId}: ${err?.message || err}`);
        }

        // 2. 逐个发送媒体文件，失败时通知用户而非中断
        if (hasMedia) {
            const failedFiles: string[] = [];
            const sendMediaFn = cp.outbound?.sendMedia || cp.outbound?.sendPayload;
            if (!sendMediaFn) {
                logger.warn(`[channelmgr] no media send method for ${cp.id}, skipping ${reply.mediaUrls.length} files`);
            } else {
                for (const mediaUrl of reply.mediaUrls) {
                    try {
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
                    } catch (mediaErr: any) {
                        const fileName = path.basename(mediaUrl.replace(/^file:\/\//, ''));
                        failedFiles.push(fileName);
                        logger.error(
                            `[channelmgr] 发送媒体文件失败 ${cp.id}:${accountId} media=${mediaUrl}: ${mediaErr?.message || mediaErr}`
                        );
                    }
                }
            }
            if (failedFiles.length > 0) {
                const warning = `⚠️ 以下文件由于权限原因无法发送：${failedFiles.join('、')}`;
                try {
                    if (cp.outbound?.sendText) {
                        await cp.outbound.sendText({ ...baseCtx, text: warning });
                    } else if (cp.outbound?.sendPayload) {
                        await cp.outbound.sendPayload({ ...baseCtx, payload: { text: warning } });
                    }
                } catch {
                    /* 警告发送失败不阻塞流程 */
                }
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

    getPluginLoadErrors(): PluginLoadError[] {
        return this.pluginLoadErrors;
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
        // 先在已加载的插件中查找
        let entry = this.findChannelPlugin(channelId);

        // 如果未找到，尝试（重新）加载插件——可能是安装后未重启，或首次调用
        if (!entry?.channelPlugin) {
            logger.info(
                `[loginChannel] channel ${channelId} not found in ${this.plugins.length} loaded plugins, reloading...`
            );
            const loadResult = await loadPlugins();
            this.plugins = loadResult.entries;
            this.pluginLoadErrors = loadResult.errors;
            logger.info(`[loginChannel] reloaded ${this.plugins.length} plugins`);
            entry = this.findChannelPlugin(channelId);
        }

        if (!entry?.channelPlugin) {
            const loadedIds = this.plugins
                .filter((p) => p.channelPlugin)
                .map((p) => `${p.id}(channel=${p.channelPlugin!.id})`)
                .join(', ');
            return { phase: 'error', error: `未找到渠道: ${channelId}。已加载的渠道: [${loadedIds}]` };
        }

        const cp = entry.channelPlugin;
        const config = this.getChannelConfig(channelId);

        let loginResult: LoginResult;

        // 路径 1：gateway.loginWithQrStart + loginWithQrWait（返回 QR URL，推荐）
        if (cp.gateway?.loginWithQrStart && cp.gateway?.loginWithQrWait) {
            logger.info(`[loginChannel] using gateway loginWithQr for ${channelId}`);
            loginResult = await this.loginWithQrGateway(cp, channelId, accountId, result);
        }
        // 路径 2：Feishu 特殊路径
        else if (channelId === 'feishu') {
            loginResult = await this.loginFeishuDeviceAuth(accountId, result);
        }
        // 路径 3：plugin 有自己的 auth.login（Zalo/WhatsApp 等，QR 输出到控制台）
        else if (cp.auth?.login) {
            logger.info(`[loginChannel] using plugin auth.login for ${channelId}`);
            const runtime = this.buildRuntimeEnv(channelId);
            await cp.auth.login({
                cfg: config,
                accountId,
                runtime,
                verbose: false,
                channelInput: channelId
            });
            loginResult = { phase: 'success', message: `${channelId} 登录完成` };
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
            updateState({
                phase: 'success',
                message: `${channelId} 登录成功！`
            });
            return { phase: 'success', message: `${channelId} 登录成功` };
        }

        return { phase: 'error', error: waitResult.message || `${channelId} 登录失败` };
    }

    /**
     * 为指定渠道构建 runtime 环境。
     */
    private buildRuntimeEnv(channelId: string) {
        return {
            log: (...args: any[]) =>
                logger.info(
                    `[${channelId}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
                ),
            error: (...args: any[]) =>
                logger.error(
                    `[${channelId}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
                ),
            warn: (...args: any[]) =>
                logger.warn(
                    `[${channelId}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
                ),
            platform: 'opendesk'
        };
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
     * 会清理 abortController、dispatch 注册、channelStates。
     */
    private async stopChannelPluginAccounts(cp: ChannelPlugin, accountIds: string[]): Promise<void> {
        const config = this.getChannelConfig(cp.id);
        for (const accountId of accountIds) {
            const stateKey = `${cp.id}:${accountId}`;
            try {
                const ac = this.abortControllers.get(stateKey);
                if (ac) {
                    ac.abort();
                    this.abortControllers.delete(stateKey);
                }

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

                unregisterChannelDispatch(cp.id, accountId);
                this.channelStates.delete(stateKey);
                this.emitEvent('channel:disconnected', { channelId: cp.id, accountId });
            } catch (err: any) {
                logger.error(`停止消息插件 ${cp.id}:${accountId} 失败: ${err?.message || err}`);
                this.abortControllers.delete(stateKey);
                unregisterChannelDispatch(cp.id, accountId);
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

        // 2. Invalidate CJS module cache so plugins are re-evaluated
        invalidatePluginRequireCache();

        // 3. Reload plugin list from disk
        const loadResult = await loadPlugins();
        this.plugins = loadResult.entries;
        this.pluginLoadErrors = loadResult.errors;

        const channelPlugins = this.plugins.filter((p) => p.channelPlugin);
        logger.info(`[channelmgr] 重新加载完成: ${this.plugins.length} 个插件, ${channelPlugins.length} 个消息插件`);

        if (this.pluginLoadErrors.length > 0) {
            for (const e of this.pluginLoadErrors) {
                logger.error(`插件 ${e.id} 加载失败: ${e.error}`);
            }
        }

        // 4. Start all channel plugins
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
                new PluginsListOverlay(tui, () => this.reloadChannels()).show();
                break;
            }
            case 'enable': {
                if (!rest) {
                    showInfo(t('plugin.usage.hint'), '/plugins enable <plugin-id>');
                    return;
                }
                if (setPluginEnabled(rest, true)) {
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

        const errorLines = this.pluginLoadErrors.map((e) => `  ✗ ${e.id}: 加载失败 - ${e.error}`);
        const errorSection = errorLines.length > 0 ? `\n\n加载失败的插件:\n${errorLines.join('\n')}` : '';

        switch (subCmd) {
            case 'list': {
                const channels = this.getChannelPlugins();
                if (channels.length === 0 && errorLines.length === 0) {
                    showInfo('消息插件', '暂无已注册的消息插件');
                } else {
                    const lines = channels.map(
                        (ch) => `  ${ch.id}: ${ch.label}${ch.description ? ` - ${ch.description}` : ''}`
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
                    const lines = states.map((s) => {
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
