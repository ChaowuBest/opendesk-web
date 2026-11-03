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
 * 原生 Channel（plugin-sdk 的 ctx.channels.register 注册的类实例）到
 * 内部 ChannelPlugin 描述符的桥接适配器。
 *
 * 设计目标：把原生 Channel 实例适配成 ChannelPlugin，从而复用 channelmgr
 * 现有的启动 / 状态 / 热重载 / 收发消息全套流程，无需重写 channelmgr 主干。
 *
 * 适配要点：
 * - 账号由 channel 自管（listAccounts 异步），adapter 在 syncAccounts() 中预取缓存，
 *   config adapter 基于缓存同步返回。
 * - 入站消息（ChannelInboundMessage）映射为内部 InboundChannelMessage 并记录
 *   recipient → chatType 映射，供出站消息推断 direct/group。
 * - 登录：loginWithQrStart/Wait 映射到 channel.getAccountLoginQr/loginAccountWithQrWait；
 *   参数登录经 loginWithParams() 暴露给 channelmgr。
 */

import path from 'path';
import fs from 'fs';
import type {
    Channel,
    ChannelAccount,
    ChannelAccountLoginParam,
    ChannelInboundMessage,
    ChannelRuntimeContext
} from '../../../../packages/plugin-sdk/src/index.js';
import type {
    ChannelPlugin,
    ChannelAccountStatus,
    ChannelMeta,
    ChannelCapabilities,
    InboundChannelMessage
} from './types.js';
import { getOpendeskDirectory } from '../../utils/setting.js';
import { getPlatform } from '../../../platforms/base.js';

export interface NativeChannelHostDeps {
    /** 返回指定 channel 的 OpenDesk 侧配置（applications.channelmgr.<channelId>） */
    getConfig: (channelId: string) => any;
    /** 入站消息投递（channelmgr.handleInboundMessage） */
    dispatch: (channelId: string, accountId: string, message: InboundChannelMessage) => Promise<void>;
    /** 入站交互事件投递（channelmgr.handleChannelInteractionEvent），用于结算权限审批/askUser */
    dispatchInteraction: (channelId: string, accountId: string, event: any) => Promise<void>;
    /** 更新指定账号的连接状态 */
    setStatus: (channelId: string, accountId: string, status: ChannelAccountStatus) => void;
    /** 向 OpenDesk 应用事件总线发送扩展事件 */
    emit: (channelId: string, event: string, payload: Record<string, unknown>) => void;
}

/**
 * channelmgr 内部的渠道容器：只承载渠道适配器本身。
 *
 * 历史版本把原生 channel 包装成 PluginEntry（附带伪造的 manifest / installRecord），
 * 那些字段从未被读取；插件安装信息统一由 pluginmgr 管理，这里不再重复承载。
 */
export interface NativeChannelEntry {
    /** 与 channelPlugin.id 一致，供状态展示与日志使用 */
    id: string;
    channelPlugin: ChannelPlugin;
}

/** 缓存的账号条目 */
interface CachedAccount {
    account: ChannelAccount;
}

function resolveDisplayLabel(label: string | Record<string, string>, fallback: string): string {
    if (typeof label === 'string') return label;
    return label.en || label.zh || fallback;
}

/** 将原生入站消息映射为内部 InboundChannelMessage，并记录 target → chatType。 */
function mapInboundMessage(
    channelId: string,
    accountId: string,
    message: ChannelInboundMessage
): InboundChannelMessage {
    const mapped: InboundChannelMessage = {
        channelId,
        accountId,
        senderId: message.sender.id,
        senderName: message.sender.name,
        text: message.text || '',
        chatType: message.chatType,
        groupId: message.group?.id,
        groupName: message.group?.name,
        threadId: message.threadId,
        messageId: message.messageId,
        replyToMessageId: message.replyToMessageId,
        raw: message.raw
    };
    if (message.media?.length) {
        mapped.media = message.media
            .filter((m) => m.path)
            .map((m) => ({ path: m.path as string, contentType: m.contentType }));
    }
    return mapped;
}

export class NativeChannelAdapter implements ChannelPlugin {
    readonly id: string;
    readonly meta: ChannelMeta;
    readonly capabilities: ChannelCapabilities;

    /** recipientId → 会话形态，入站时记录，出站时推断 chatType */
    private readonly targetTypes = new Map<string, { chatType: 'direct' | 'group'; groupId?: string }>();
    private cachedAccounts: CachedAccount[] = [];
    private runtimeCtxInjected = false;
    private pendingQrSession: { qrUrl: string; sessionKey: string } | undefined;

    constructor(
        private readonly channel: Channel,
        private readonly deps: NativeChannelHostDeps
    ) {
        this.id = channel.meta.id;
        this.meta = {
            label: resolveDisplayLabel(channel.meta.label, channel.meta.id),
            description: channel.meta.description,
            aliases: channel.meta.aliases
        };
        this.capabilities = {
            chatTypes: channel.capabilities.chatTypes,
            media: channel.capabilities.media,
            threading: channel.capabilities.threading,
            interactive: channel.capabilities.interactive
        };
    }

    getNativeChannel(): Channel {
        return this.channel;
    }

    /** 该 channel 是否真正支持扫码登录（适配层 gateway 方法恒存在，需按能力判断）。 */
    supportQrLogin(): boolean {
        return (
            this.channel.supportLoginWithQr === true &&
            typeof this.channel.getAccountLoginQr === 'function' &&
            typeof this.channel.loginAccountWithQrWait === 'function'
        );
    }

    /** 返回账号显示名（来自 channel.listAccounts 的 accountName），未知时返回 undefined。 */
    getAccountName(accountId: string): string | undefined {
        return this.cachedAccounts.find((c) => c.account.accountId === accountId)?.account.accountName;
    }

    /**
     * 确保运行时上下文已注入（登录/启动前调用，避免 channel 使用 ctx 时为 null）。
     * 幂等：已注入过则直接返回。
     */
    ensureRuntimeInjected(accountId = 'default'): void {
        if (!this.runtimeCtxInjected) {
            this.channel.setChannelRuntimeContext(this.buildRuntimeContext(accountId));
            this.runtimeCtxInjected = true;
        }
    }

    /**
     * 预取账号列表并缓存。必须在 startChannelPlugin 之前调用一次，
     * 登录成功后也应再次调用以刷新账号缓存。
     */
    async syncAccounts(): Promise<string[]> {
        try {
            const accounts = (await this.channel.listAccounts()) || [];
            this.cachedAccounts = accounts.map((account) => ({ account }));
            return accounts.map((a) => a.accountId);
        } catch (err: any) {
            this.cachedAccounts = [];
            return [];
        }
    }

    // ── config adapter（基于缓存） ────────────────────────────────────────────

    config = {
        listAccountIds: () => this.cachedAccounts.map((c) => c.account.accountId),
        resolveAccount: (_cfg: any, accountId?: string | null) => {
            const target = accountId ?? this.cachedAccounts[0]?.account.accountId;
            return this.cachedAccounts.find((c) => c.account.accountId === target)?.account;
        },
        defaultAccountId: () => this.cachedAccounts[0]?.account.accountId || 'default'
    };

    // ── gateway adapter ───────────────────────────────────────────────────────

    gateway = {
        startAccount: async (ctx: any) => {
            // 注入该账号的运行时上下文（含 accountId，channel 可据此区分多账号）
            this.channel.setChannelRuntimeContext(this.buildRuntimeContext(ctx.accountId));
            const account = this.cachedAccounts.find((c) => c.account.accountId === ctx.accountId)?.account;
            if (!account) {
                // 缓存过期（如插件在启动前才注册账号），尝试重新同步
                await this.syncAccounts();
                const refreshed = this.cachedAccounts.find((c) => c.account.accountId === ctx.accountId)?.account;
                if (!refreshed) {
                    throw new Error(`channel ${this.id}: account ${ctx.accountId} not found`);
                }
                await this.channel.start(refreshed);
                return;
            }
            await this.channel.start(account);
        },
        stopAccount: async (ctx: any) => {
            try {
                await this.channel.stop(ctx.accountId);
            } catch {
                /* stop 失败不阻塞清理 */
            }
        },
        loginWithQrStart: async () => {
            if (!this.channel.supportLoginWithQr || !this.channel.getAccountLoginQr) {
                throw new Error(`channel ${this.id} does not support QR login`);
            }
            this.ensureRuntimeInjected('default');
            const session = await this.channel.getAccountLoginQr();
            this.pendingQrSession = { qrUrl: session.qrUrl, sessionKey: session.sessionKey };
            return { qrDataUrl: session.qrUrl, sessionKey: session.sessionKey };
        },
        loginWithQrWait: async (params: any) => {
            if (!this.channel.loginAccountWithQrWait) {
                throw new Error(`channel ${this.id} does not support QR login wait`);
            }
            const session = this.pendingQrSession ?? { qrUrl: '', sessionKey: params?.sessionKey || '' };
            try {
                await this.channel.loginAccountWithQrWait(session, (progress) => {
                    params?.onProgress?.(progress);
                });
            } catch (err: any) {
                return { connected: false, message: err?.message || String(err) };
            }
            await this.syncAccounts();
            return { connected: true };
        },
        logoutAccount: async (ctx: any) => {
            await this.channel.logoutAccount(ctx.accountId);
            this.cachedAccounts = this.cachedAccounts.filter((c) => c.account.accountId !== ctx.accountId);
        }
    };

    // ── outbound adapter ──────────────────────────────────────────────────────

    private resolveTarget(to: string): { chatType: 'direct' | 'group'; groupId?: string } {
        return this.targetTypes.get(to) ?? { chatType: 'direct' };
    }

    outbound = {
        deliveryMode: 'direct' as const,
        sendText: async (ctx: any) => {
            const target = this.resolveTarget(ctx.to);
            await this.channel.sendOutboundMessage({
                to: { chatType: target.chatType, recipientId: ctx.to, groupId: target.groupId },
                accountId: ctx.accountId,
                message: { text: ctx.text ?? '' }
            });
        },
        sendMedia: async (ctx: any) => {
            const target = this.resolveTarget(ctx.to);
            const mediaUrl = ctx.mediaUrl || ctx.mediaUrls?.[0];
            if (!mediaUrl) return;
            await this.channel.sendOutboundMessage({
                to: { chatType: target.chatType, recipientId: ctx.to, groupId: target.groupId },
                accountId: ctx.accountId,
                message: {
                    text: ctx.text ?? '',
                    media: [{ path: mediaUrl, url: mediaUrl, contentType: ctx.contentType }]
                }
            });
        }
    };

    // ── interaction adapter（结构化交互：权限审批 / askUser 卡片） ───────────

    /** 透传结构化交互请求到原生 channel（channel 未实现时抛错，host 据此判定能力）。 */
    sendInteraction = async (request: any) => {
        if (typeof this.channel.sendInteraction !== 'function') {
            throw new Error(`channel ${this.id} does not support sendInteraction`);
        }
        return this.channel.sendInteraction(request);
    };

    // ── status adapter ────────────────────────────────────────────────────────

    status = {
        buildChannelSummary: async (params: any) => {
            const accountId = params.accountId;
            try {
                const status = await this.channel.checkAccountStatus(accountId);
                return {
                    channelId: this.id,
                    accountId,
                    online: status.ok,
                    statusText: status.message
                };
            } catch {
                return { channelId: this.id, accountId, online: false };
            }
        }
    };

    messaging = {
        normalizeTarget: (raw: string) => raw
    };

    // ── 参数登录（供 channelmgr 新增路径使用） ────────────────────────────────

    getLoginParams(): ChannelAccountLoginParam[] {
        return this.channel.getAccountLoginParams?.() ?? [];
    }

    supportParamsLogin(): boolean {
        return typeof this.channel.loginAccountWithParams === 'function';
    }

    async loginWithParams(values: Record<string, string>): Promise<ChannelAccount> {
        this.ensureRuntimeInjected('default');
        const account = await this.channel.loginAccountWithParams(values);
        await this.syncAccounts();
        return account;
    }

    // ── 运行时上下文构造 ──────────────────────────────────────────────────────

    private buildRuntimeContext(accountId: string): ChannelRuntimeContext {
        const channelId = this.id;
        const dataDir = path.join(getOpendeskDirectory(), 'channels', channelId);
        try {
            fs.mkdirSync(dataDir, { recursive: true });
        } catch {
            /* 目录创建失败不阻塞，channel 自行决定如何处理 */
        }
        const tag = `[native:${channelId}:${accountId}]`;
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
        const logger = {
            info: (...args: any[]) => console.info(`${tag} ${fmt(...args)}`),
            warn: (...args: any[]) => console.warn(`${tag} ${fmt(...args)}`),
            error: (...args: any[]) => console.error(`${tag} ${fmt(...args)}`),
            debug: (...args: any[]) => console.info(`${tag}[debug] ${fmt(...args)}`)
        };

        const runtimeCtx: ChannelRuntimeContext = {
            channelId,
            accountId,
            config: Object.freeze({ ...(this.deps.getConfig(channelId)?.channels?.[channelId] ?? {}) }),
            dataDir,
            resolvePath: (input: string) => path.resolve(dataDir, input),
            dispatch: async (message: ChannelInboundMessage) => {
                // 消息所属账号：channel 显式声明优先，否则回退到注入该上下文时的账号
                const resolvedAccountId = message.accountId || accountId;
                logger.info(
                    'dispatch: from=' +
                        (message.sender?.id || '') +
                        ' chatType=' +
                        message.chatType +
                        ' text_len=' +
                        (message.text || '').length +
                        ' accountId=' +
                        resolvedAccountId
                );
                // 记录 target 形态，供出站消息推断 chatType
                const recipientId =
                    message.chatType === 'group' && message.group?.id ? message.group.id : message.sender.id;
                this.targetTypes.set(recipientId, {
                    chatType: message.chatType,
                    groupId: message.group?.id
                });
                const mapped = mapInboundMessage(channelId, resolvedAccountId, message);
                await this.deps.dispatch(channelId, resolvedAccountId, mapped);
            },
            dispatchInteraction: async (event: any) => {
                // 事件所属账号：channel 显式声明优先，否则回退到注入该上下文时的账号
                const resolvedAccountId = event.accountId || accountId;
                logger.info(
                    'dispatchInteraction: kind=' +
                        (event.kind || '') +
                        ' interactionId=' +
                        (event.interactionId || '') +
                        ' operator=' +
                        (event.operator?.id || '') +
                        ' accountId=' +
                        resolvedAccountId
                );
                await this.deps.dispatchInteraction(channelId, resolvedAccountId, event);
            },
            setStatus: (status, accountIdOverride) => {
                // channel 显式声明的 accountId 优先（多账号下 ctx 可能属于其他账号）
                const resolvedAccountId = accountIdOverride ?? accountId;
                this.deps.setStatus(channelId, resolvedAccountId, {
                    online: status.online,
                    statusText: status.statusText,
                    error: status.error
                });
            },
            emit: (event: string, payload?: unknown, accountIdOverride?: string) => {
                this.deps.emit(channelId, event, {
                    accountId: accountIdOverride ?? accountId,
                    payload
                });
            },
            fetch: (input, init) => getPlatform().fetch(input, init),
            logger
        };
        return runtimeCtx;
    }
}

/** 为原生 Channel 构造 channelmgr 内部条目，塞入 plugins 数组以复用现有流程。 */
export function createNativeChannelPluginEntry(channel: Channel, deps: NativeChannelHostDeps): NativeChannelEntry {
    return {
        id: channel.meta.id,
        channelPlugin: new NativeChannelAdapter(channel, deps)
    };
}

/** 便捷断言：entry.channelPlugin 是否为原生 channel 适配器。 */
export function isNativeChannelEntry(entry: NativeChannelEntry): boolean {
    return entry.channelPlugin instanceof NativeChannelAdapter;
}
