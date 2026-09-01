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
 * Plugin system type definitions.
 * Core types for the plugin infrastructure.
 */

// ── Plugin Manifest & Install Records ────────────────────────────────────────

export interface PluginManifest {
    id: string;
    name?: string;
    description?: string;
    version?: string;
    kind?: string;
    channels?: string[];
    skills?: string[];
    configSchema?: object;
}

export interface PluginInstallRecord {
    id: string;
    npmSpec: string;
    installedAt: string;
    enabled: boolean;
    source: 'npm' | 'local' | 'url';
    path?: string;
    /** Original URL if source is 'url' */
    url?: string;
}

export interface PluginEntry {
    id: string;
    manifest: PluginManifest;
    installRecord: PluginInstallRecord;
    module?: any;
    channelPlugin?: ChannelPlugin;
    rootDir?: string;
}

export interface PluginLoadError {
    id: string;
    npmSpec: string;
    error: string;
}

export interface PluginLoadResult {
    entries: PluginEntry[];
    errors: PluginLoadError[];
}

export interface PluginsConfig {
    enabled: boolean;
    installs: PluginInstallRecord[];
}

// ── Participant (for task origin/deliver) ─────────────────────────────────────

export interface Participant {
    type: 'channel';
    /** Channel identifier, e.g. 'feishu', 'slack' */
    channel: string;
    /** Bot's account within the channel (used as accountId in sendText) */
    accountId: string;
    /** Message recipient - senderId for direct messages, groupId for group chats */
    recipientId: string;
}

// ── Channel Plugin Types ──────────────────────────────────────────────────────

export type ChannelId = string;

export interface ChannelMeta {
    label: string;
    description?: string;
    aliases?: string[];
    docsPath?: string;
    blurb?: string;
}

export interface ChannelCapabilities {
    chatTypes: ('direct' | 'group')[];
    media?: boolean;
    threading?: boolean;
    reactions?: boolean;
    editing?: boolean;
    mentionGating?: boolean;
    /** 是否支持结构化用户交互（权限审批 / askUser 卡片）。true 时需实现 sendInteraction */
    interactive?: boolean;
}

export interface ChannelConfigAdapter<ResolvedAccount = any> {
    listAccountIds: (cfg: any) => string[];
    resolveAccount: (cfg: any, accountId?: string | null) => ResolvedAccount | undefined;
    defaultAccountId: (cfg: any) => string;
    isConfigured?: (params: { cfg: any; accountId?: string | null }) => Promise<boolean>;
    setAccountEnabled?: (params: { cfg: any; accountId: string; enabled: boolean }) => any;
}

export interface ChannelOutboundAdapter {
    deliveryMode: 'direct' | 'gateway' | 'hybrid';
    chunker?: ((text: string, limit: number) => string[]) | null;
    chunkerMode?: 'text' | 'markdown';
    textChunkLimit?: number;
    sendPayload?: (ctx: any) => Promise<any>;
    sendText?: (ctx: any) => Promise<any>;
    sendMedia?: (ctx: any) => Promise<any>;
}

export interface ChannelGatewayAdapter<ResolvedAccount = any> {
    startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
    stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
    loginWithQrStart?: (params: any) => Promise<any>;
    loginWithQrWait?: (params: any) => Promise<any>;
    logoutAccount?: (ctx: any) => Promise<any>;
}

export interface ChannelGatewayContext<ResolvedAccount = any> {
    accountId: string;
    account: ResolvedAccount;
    cfg: any;
    logger: PluginLogger;
    /** OpenClaw compat: some plugins use ctx.log instead of ctx.logger */
    log?: PluginLogger;
    /** OpenClaw compat: runtime environment */
    runtime?: {
        log?: (...args: any[]) => void;
        error?: (...args: any[]) => void;
        warn?: (...args: any[]) => void;
        [key: string]: any;
    };
    /** OpenClaw compat: abort signal for long-running connections */
    abortSignal?: AbortSignal;
    /**
     * OpenClaw compat: channel runtime surface injected per gateway call.
     * Newer plugins (e.g. weixin >= 2.4, feishu >= 2026.5) require this
     * for media, routing, session, reply, and command helpers.
     */
    channelRuntime?: any;
    dispatch: ChannelDispatchFn;
    setStatus: (status: any) => void;
}

export type ChannelDispatchFn = (message: InboundChannelMessage) => Promise<void>;

export interface InboundChannelMessage {
    channelId: string;
    accountId: string;
    senderId: string;
    senderName?: string;
    text: string;
    chatType: 'direct' | 'group';
    groupId?: string;
    groupName?: string;
    threadId?: string;
    messageId?: string;
    replyToMessageId?: string;
    media?: Array<{ path: string; contentType?: string }>;
    raw?: any;
}

export interface ChannelAccountStatus {
    online: boolean;
    statusText?: string;
    error?: string;
    lastSeen?: Date;
}

export interface ChannelStatusAdapter<ResolvedAccount = any, Probe = unknown, Audit = unknown> {
    buildChannelSummary: (params: any) => Promise<ChannelAccountSnapshot>;
    collectIssues?: (params: any) => Promise<ChannelStatusIssue[]>;
}

export interface ChannelAccountSnapshot {
    channelId: string;
    accountId: string;
    online: boolean;
    statusText?: string;
    accountName?: string;
}

export interface ChannelStatusIssue {
    severity: 'error' | 'warning' | 'info';
    message: string;
}

export interface ChannelHeartbeatAdapter {
    resolveRecipients: (params: { cfg: any; accountId?: string | null }) => Promise<string[]>;
}

export interface ChannelMessagingAdapter {
    normalizeTarget: (raw: string) => string;
    parseReplyToMessageId?: (raw: string) => string | undefined;
}

export interface ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> {
    id: ChannelId;
    meta: ChannelMeta;
    capabilities: ChannelCapabilities;
    defaults?: { queue?: { debounceMs?: number } };
    config: ChannelConfigAdapter<ResolvedAccount>;
    configSchema?: any;
    setup?: any;
    pairing?: any;
    security?: any;
    groups?: any;
    mentions?: any;
    outbound?: ChannelOutboundAdapter;
    status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
    gateway?: ChannelGatewayAdapter<ResolvedAccount>;
    auth?: any;
    elevated?: any;
    commands?: any;
    streaming?: any;
    threading?: any;
    messaging?: ChannelMessagingAdapter;
    agentPrompt?: any;
    directory?: any;
    resolver?: any;
    actions?: any;
    heartbeat?: ChannelHeartbeatAdapter;
    agentTools?: any;
    onboarding?: any;
    reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
    gatewayMethods?: string[];
    /** 原生 channel 的结构化交互（权限审批 / askUser 卡片）发送入口 */
    sendInteraction?: (request: any) => Promise<any>;
}

// ── Pairing Provider (decouples aikernel from applications layer) ─────────────

export interface PairingProvider {
    getApprovedUserIds(channel: string, accountId: string): string[];
    isUserApproved(channel: string, accountId: string, userId: string): boolean;
    upsertPairingRequest(
        channel: string,
        accountId: string,
        userId: string,
        meta?: any
    ): { code: string; created: boolean };
    removePairingRequest(channel: string, accountId: string, userId: string): boolean;
    getPendingRequests(channel?: string, accountId?: string): any[];
    approveUser(channel: string, accountId: string, userId: string, meta?: any): void;
    revokeUser(channel: string, accountId: string, userId: string): boolean;
}

// ── Plugin Logger & API ───────────────────────────────────────────────────────

export interface PluginLogger {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug: (...args: any[]) => void;
}

export interface OpenClawPluginApi {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    config: any;
    pluginConfig?: Record<string, unknown>;
    runtime: any;
    logger: PluginLogger;
    registerTool: (tool: any, opts?: any) => void;
    registerHook: (events: string | string[], handler: any, opts?: any) => void;
    registerHttpHandler: (handler: any) => void;
    registerHttpRoute: (params: { path: string; handler: any }) => void;
    registerChannel: (registration: any) => void;
    registerGatewayMethod: (method: string, handler: any) => void;
    registerCli: (registrar: any, opts?: any) => void;
    registerService: (service: any) => void;
    registerProvider: (provider: any) => void;
    registerCommand: (command: any) => void;
    resolvePath: (input: string) => string;
    on: (hookName: string, handler: any, opts?: any) => void;
}
