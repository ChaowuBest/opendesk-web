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

import { BaseTool, ToolResult } from '../../aikernel/tool.js';
import { ToolCall } from '../../aikernel/messages.js';
import { z } from 'zod';
import fs from 'fs';
import pathLib from 'path';
import {
    getPendingRequests,
    getApprovedUsers,
    approveUser,
    revokeUser,
    removePairingRequest,
} from './pairing.js';
import type { ChannelMgrApplication } from './app.js';
import {
    installPlugin,
    uninstallPlugin,
    listInstalledPlugins,
    setPluginEnabled,
} from '../../aikernel/plugins/index.js';
import {
    feishuAuthInit,
    feishuAuthBegin,
    feishuAuthPoll,
} from './feishu-auth.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';
import qrcodeTerminal from 'qrcode-terminal';

// ── List Pairing Requests ───────────────────────────────────────────────────

const ListPairingRequestsSchema = z.object({
    channel: z.string().optional().describe('Filter by channel name, e.g. "feishu". Omit to show all channels.'),
});

export class ListPairingRequestsTool extends BaseTool<typeof ListPairingRequestsSchema> {
    constructor() {
        super(
            'listPairingRequests',
            'List all pending pairing requests from external users. Shows user ID, display name, channel, and pairing code.',
            ListPairingRequestsSchema,
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof ListPairingRequestsSchema>): Promise<string> {
        const requests = getPendingRequests(args.channel);
        if (requests.length === 0) {
            return '当前没有待审批的配对请求。';
        }
        const lines = requests.map((r, i) =>
            `${i + 1}. 用户ID: ${r.id}\n   名称: ${r.meta?.name || '未知'}\n   渠道: ${r.channel}\n   账户: ${r.accountId}\n   配对码: ${r.code}\n   请求时间: ${r.createdAt}`,
        );
        return `共 ${requests.length} 个待审批的配对请求：\n\n${lines.join('\n\n')}`;
    }
}

// ── Approve Pairing ─────────────────────────────────────────────────────────

const ApprovePairingSchema = z.object({
    userId: z.string().describe('The user ID to approve (shown in pairing request list)'),
    channel: z.string().describe('The channel name, e.g. "feishu"'),
    accountId: z.string().default('default').describe('The account ID, defaults to "default"'),
});

export class ApprovePairingTool extends BaseTool<typeof ApprovePairingSchema> {
    constructor() {
        super(
            'approvePairing',
            'Approve a pending pairing request. The user will then be able to send messages that are routed to the agent.',
            ApprovePairingSchema,
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof ApprovePairingSchema>): Promise<string> {
        const pending = getPendingRequests(args.channel, args.accountId);
        const match = pending.find(r => r.id === args.userId);
        if (!match) {
            const approved = getApprovedUsers(args.channel, args.accountId);
            if (approved.some(u => u.id === args.userId)) {
                return `用户 ${args.userId} 已经是已配对状态，无需重复审批。`;
            }
        }
        approveUser(args.channel, args.accountId, args.userId, match?.meta);
        const name = match?.meta?.name || args.userId;
        return `已批准用户 ${name} (${args.userId}) 在 ${args.channel}:${args.accountId} 上的配对请求。该用户后续的消息将正常路由到 Agent。`;
    }
}

// ── Revoke Pairing ──────────────────────────────────────────────────────────

const RevokePairingSchema = z.object({
    userId: z.string().describe('The user ID to revoke or reject'),
    channel: z.string().describe('The channel name, e.g. "feishu"'),
    accountId: z.string().default('default').describe('The account ID, defaults to "default"'),
});

export class RevokePairingTool extends BaseTool<typeof RevokePairingSchema> {
    constructor() {
        super(
            'revokePairing',
            'Revoke an approved user or reject a pending pairing request. The user will no longer be able to send messages.',
            RevokePairingSchema,
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof RevokePairingSchema>): Promise<string> {
        const revokedApproved = revokeUser(args.channel, args.accountId, args.userId);
        const removedPending = removePairingRequest(args.channel, args.accountId, args.userId);

        if (revokedApproved) {
            return `已撤销用户 ${args.userId} 在 ${args.channel}:${args.accountId} 上的配对权限。该用户后续消息将不再被路由。`;
        }
        if (removedPending) {
            return `已拒绝用户 ${args.userId} 在 ${args.channel}:${args.accountId} 上的配对请求。`;
        }
        return `未找到用户 ${args.userId} 在 ${args.channel}:${args.accountId} 上的配对记录。`;
    }
}

// ── List Approved Users ─────────────────────────────────────────────────────

const ListApprovedUsersSchema = z.object({
    channel: z.string().optional().describe('Filter by channel name. Omit to show all channels.'),
});

export class ListApprovedUsersTool extends BaseTool<typeof ListApprovedUsersSchema> {
    constructor() {
        super(
            'listApprovedUsers',
            'List all approved/paired users across all channels.',
            ListApprovedUsersSchema,
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof ListApprovedUsersSchema>): Promise<string> {
        const users = getApprovedUsers(args.channel);
        if (users.length === 0) {
            return '当前没有已配对的用户。';
        }
        const lines = users.map((u, i) =>
            `${i + 1}. 用户ID: ${u.id}\n   名称: ${u.meta?.name || '未知'}\n   渠道: ${u.channel}\n   账户: ${u.accountId}\n   批准时间: ${u.approvedAt}`,
        );
        return `共 ${users.length} 个已配对用户：\n\n${lines.join('\n\n')}`;
    }
}

// ── List Channel Status ─────────────────────────────────────────────────────

const ListChannelStatusSchema = z.object({});

export class ListChannelStatusTool extends BaseTool<typeof ListChannelStatusSchema> {
    private app: ChannelMgrApplication;

    constructor(app: ChannelMgrApplication) {
        super(
            'listChannelStatus',
            'List all channel plugins and their current connection status.',
            ListChannelStatusSchema,
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(): Promise<string> {
        const states = this.app.getChannelStates();
        if (states.length === 0) {
            return '当前没有运行中的消息渠道插件。';
        }
        const lines = states.map((s, i) => {
            const icon = s.status.online ? '🟢' : '🔴';
            const statusText = s.status.statusText || (s.status.online ? '在线' : '离线');
            const err = s.status.error ? `\n   错误: ${s.status.error}` : '';
            return `${i + 1}. ${icon} ${s.label} (${s.channelId}:${s.accountId})\n   状态: ${statusText}${err}`;
        });
        return `共 ${states.length} 个渠道插件：\n\n${lines.join('\n\n')}`;
    }
}

// ── Plugin Management Tools (for configure-channels skill) ──────────────────

const InstallChannelPluginSchema = z.object({
    spec: z.string().describe('要安装的插件包名或 URL，例如 "@openclaw/feishu" 或 .tgz 文件的下载链接'),
});

export class InstallChannelPluginTool extends BaseTool<typeof InstallChannelPluginSchema> {
    constructor() {
        super(
            'installChannelPlugin',
            'Install a channel plugin by npm package name or .tgz URL. Example: "@openclaw/feishu"',
            InstallChannelPluginSchema,
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof InstallChannelPluginSchema>): Promise<string> {
        const result = await installPlugin(args.spec);
        if (result.success) {
            return `插件安装成功: ${result.id}\n\n请注意：需要重启 OpenDesk 才能加载新安装的插件。`;
        }
        return `插件安装失败: ${result.error}`;
    }
}

const UninstallChannelPluginSchema = z.object({
    id: z.string().describe('要卸载的插件 ID（可通过 listChannelPlugins 工具获取）'),
});

export class UninstallChannelPluginTool extends BaseTool<typeof UninstallChannelPluginSchema> {
    constructor() {
        super(
            'uninstallChannelPlugin',
            'Uninstall a previously installed channel plugin by its ID.',
            UninstallChannelPluginSchema,
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof UninstallChannelPluginSchema>): Promise<string> {
        const result = await uninstallPlugin(args.id);
        if (result.success) {
            return `插件已卸载: ${args.id}`;
        }
        return `插件卸载失败: ${result.error}`;
    }
}

const ListChannelPluginsSchema = z.object({});

export class ListChannelPluginsTool extends BaseTool<typeof ListChannelPluginsSchema> {
    constructor() {
        super(
            'listChannelPlugins',
            'List all installed channel plugins with their status (enabled/disabled).',
            ListChannelPluginsSchema,
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(): Promise<string> {
        const records = listInstalledPlugins();
        if (records.length === 0) {
            return '当前没有已安装的插件。';
        }
        const lines = records.map((r, i) => {
            const status = r.enabled ? '✓ 已启用' : '✗ 已禁用';
            return `${i + 1}. ${r.id} (${r.npmSpec}) [${status}]\n   安装时间: ${r.installedAt}`;
        });
        return `共 ${records.length} 个已安装的插件：\n\n${lines.join('\n\n')}`;
    }
}

const ToggleChannelPluginSchema = z.object({
    id: z.string().describe('插件 ID'),
    enabled: z.boolean().describe('true 为启用，false 为禁用'),
});

export class ToggleChannelPluginTool extends BaseTool<typeof ToggleChannelPluginSchema> {
    constructor() {
        super(
            'toggleChannelPlugin',
            'Enable or disable a channel plugin. Requires restart to take effect.',
            ToggleChannelPluginSchema,
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof ToggleChannelPluginSchema>): Promise<string> {
        const ok = setPluginEnabled(args.id, args.enabled);
        if (ok) {
            const action = args.enabled ? '启用' : '禁用';
            return `插件已${action}: ${args.id}\n\n请重启 OpenDesk 以使更改生效。`;
        }
        return `未找到插件: ${args.id}`;
    }
}

const SetChannelConfigSchema = z.object({
    channelId: z.string().describe('消息渠道的 ID，例如 "feishu"'),
    config: z.any().describe('要设置的渠道配置 JSON 对象，将写入 settings.json 的 applications.channelmgr.<channelId> 中'),
});

export class SetChannelConfigTool extends BaseTool<typeof SetChannelConfigSchema> {
    private app: ChannelMgrApplication;

    constructor(app: ChannelMgrApplication) {
        super(
            'setChannelConfig',
            'Set the configuration for a channel plugin. The config will be saved to settings.json under applications.channelmgr.<channelId>.',
            SetChannelConfigSchema,
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof SetChannelConfigSchema>): Promise<string> {
        try {
            const currentConfig = this.app.getConfig() || {};
            const updatedConfig = {
                ...currentConfig,
                [args.channelId]: args.config,
            };
            this.app.setConfig(updatedConfig);
            return `渠道 ${args.channelId} 的配置已保存到 settings.json。\n\n请重启 OpenDesk 以使配置生效。\n\n已保存的配置:\n${JSON.stringify(args.config, null, 2)}`;
        } catch (err: any) {
            return `保存配置失败: ${err?.message || err}`;
        }
    }
}

const GetChannelConfigSchema = z.object({
    channelId: z.string().describe('消息渠道的 ID，例如 "feishu"'),
});

export class GetChannelConfigTool extends BaseTool<typeof GetChannelConfigSchema> {
    private app: ChannelMgrApplication;

    constructor(app: ChannelMgrApplication) {
        super(
            'getChannelConfig',
            'Get the configuration JSON for a specific channel plugin. Useful for debugging.',
            GetChannelConfigSchema,
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof GetChannelConfigSchema>): Promise<string> {
        try {
            const currentConfig = this.app.getConfig() || {};
            const channelConfig = currentConfig[args.channelId];
            if (channelConfig === undefined) {
                return `渠道 ${args.channelId} 暂无配置。`;
            }
            return `渠道 ${args.channelId} 的配置:\n${JSON.stringify(channelConfig, null, 2)}`;
        } catch (err: any) {
            return `获取配置失败: ${err?.message || err}`;
        }
    }
}

// ── Login Channel Tool ───────────────────────────────────────────────────────

export interface LoginChannelState {
    phase: 'init' | 'generating_qr' | 'polling' | 'success' | 'error';
    channelId?: string;
    accountId?: string;
    qr_ascii?: string;
    verification_url?: string;
    appId?: string;
    appSecret?: string;
    message?: string;
    error?: string;
}

const LoginChannelSchema = z.object({
    channelId: z.string().describe('消息渠道的 ID。有效值：\n  - "openclaw-weixin"（微信）\n  - "feishu"（飞书）\n  - "zalouser"（Zalo）\n  - "whatsapp"（WhatsApp）\n注意：微信的 ID 是 "openclaw-weixin"，不是 "weixin" 或 "tencent-weixin"'),
    accountId: z.string().default('default').describe('账户 ID，默认为 "default"'),
});

export class LoginChannelTool extends BaseTool<typeof LoginChannelSchema> {
    private app: ChannelMgrApplication;

    constructor(app: ChannelMgrApplication) {
        super(
            'loginChannel',
            '触发消息渠道的登录流程。支持的 channelId：\n  - "openclaw-weixin"：微信登录（扫码）\n  - "feishu"：飞书登录（扫码创建机器人）\n  - "zalouser"：Zalo 登录（扫码）\n  - "whatsapp"：WhatsApp 登录（扫码）\n登录成功后会返回结果。注意：微信 channelId 必须使用 "openclaw-weixin"。',
            LoginChannelSchema,
        );
        this.app = app;
        this.setUniversalExecutor(this.run.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const state = toolcall.result_object as LoginChannelState | undefined;
        if (!state) return undefined;

        if (state.phase === 'generating_qr' || state.phase === 'polling') {
            const channelLabel = state.channelId || '未知渠道';
            const escUrl = this.escHtml(state.verification_url || '');
            const qrImageUrl = state.verification_url
                ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(state.verification_url)}`
                : '';

            return `
            <div class="mt-3 mb-3 p-5 bg-white/90 backdrop-blur-md border border-slate-200 rounded-2xl shadow-sm" style="max-width: 320px;">
                <div class="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                    <div class="h-2 w-2 rounded-full bg-blue-500 animate-pulse ring-4 ring-blue-100/50"></div>
                    ${channelLabel} 扫码登录
                </div>
                ${qrImageUrl ? `<div class="flex justify-center p-3 bg-white rounded-xl border border-slate-100">
                    <img src="${qrImageUrl}" alt="${channelLabel} 二维码" width="200" height="200" style="display: block;" />
                </div>` : ''}
                <p class="text-xs text-slate-500 mt-3 text-center">请使用对应 App 扫描上方二维码</p>
                ${escUrl ? `<a href="${escUrl}" target="_blank" class="block mt-2 text-xs text-blue-500 hover:text-blue-600 text-center break-all">${escUrl}</a>` : ''}
                <div class="flex items-center justify-center gap-1.5 mt-3">
                    <div class="h-1.5 w-1.5 rounded-full bg-blue-400 animate-bounce" style="animation-delay: 0ms;"></div>
                    <div class="h-1.5 w-1.5 rounded-full bg-blue-400 animate-bounce" style="animation-delay: 150ms;"></div>
                    <div class="h-1.5 w-1.5 rounded-full bg-blue-400 animate-bounce" style="animation-delay: 300ms;"></div>
                    <span class="ml-1 text-xs text-slate-400">等待扫码中...</span>
                </div>
            </div>`;
        }

        if (state.phase === 'success') {
            const lines: string[] = [];
            lines.push(`渠道 ${state.channelId} 登录成功！`);
            if (state.message) lines.push(state.message);
            if (state.appId) lines.push(`App ID: ${state.appId}`);
            if (state.appSecret) lines.push(`App Secret: ${state.appSecret.slice(0, 6)}****`);
            return `
            <div class="mt-3 mb-3 p-5 bg-white/90 backdrop-blur-md border border-emerald-200 rounded-2xl shadow-sm" style="max-width: 320px;">
                <div class="text-sm font-semibold text-emerald-700 mb-3 flex items-center gap-2">
                    <div class="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"></div>
                    登录成功
                </div>
                <div class="text-xs text-slate-600 space-y-1">${lines.map(l => `<p>${this.escHtml(l)}</p>`).join('')}</div>
            </div>`;
        }

        if (state.phase === 'error') {
            return `
            <div class="mt-3 mb-3 p-4 bg-white/90 backdrop-blur-md border border-rose-200 rounded-2xl shadow-sm" style="max-width: 320px;">
                <div class="text-sm font-semibold text-rose-600 flex items-center gap-2">
                    <div class="h-2.5 w-2.5 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]"></div>
                    登录失败
                </div>
                <p class="text-xs text-rose-500 mt-2">${this.escHtml(state.error || '未知错误')}</p>
            </div>`;
        }

        return undefined;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const state = toolcall.result_object as LoginChannelState | undefined;
        if (!state) return undefined;

        if (state.phase === 'init' || state.phase === 'generating_qr') {
            return [`  ⏳ 正在启动 ${state.channelId} 登录流程...`];
        }

        if (state.phase === 'polling') {
            const lines: string[] = [];
            lines.push(`  📱 请使用 ${state.channelId} App 扫描下方二维码登录:`);
            lines.push('');
            if (state.qr_ascii) {
                for (const line of state.qr_ascii.split('\n')) {
                    lines.push('  ' + line);
                }
            }
            lines.push('');
            if (state.verification_url) lines.push('  🔗 ' + state.verification_url);
            lines.push('  ⏳ 等待扫码中...');
            return lines;
        }

        if (state.phase === 'success') {
            const lines: string[] = [`  ✅ ${state.channelId} 登录成功！`];
            if (state.message) lines.push(`     ${state.message}`);
            if (state.appId) lines.push(`     App ID: ${state.appId}`);
            return lines;
        }

        if (state.phase === 'error') {
            return [`  ❌ 登录失败: ${state.error || '未知错误'}`];
        }

        return undefined;
    }

    private async run(args: z.output<typeof LoginChannelSchema>, result: ToolResult): Promise<void> {
        const { channelId, accountId } = args;

        logger.info(`[loginChannel] channel=${channelId}, account=${accountId}`);

        result.updateResultObject({ phase: 'init', channelId, accountId } satisfies LoginChannelState);

        try {
            // 尝试通过 ChannelMgrApplication 执行登录
            const loginResult = await this.app.loginChannel(channelId, accountId, result);

            if (loginResult.phase === 'success') {
                result.updateResultObject({
                    phase: 'success',
                    channelId,
                    accountId,
                    message: loginResult.message,
                    appId: loginResult.appId,
                    appSecret: loginResult.appSecret,
                } satisfies LoginChannelState);
                result.updateResult(loginResult.message || `${channelId} 登录成功`);
            } else if (loginResult.phase === 'error') {
                result.updateResultObject({
                    phase: 'error',
                    channelId,
                    accountId,
                    error: loginResult.error,
                } satisfies LoginChannelState);
                throw new Error(loginResult.error);
            }
        } catch (err: any) {
            result.updateResultObject({
                phase: 'error',
                channelId,
                accountId,
                error: err?.message || String(err),
            } satisfies LoginChannelState);
            throw err;
        }
    }

    private escHtml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}

// ── Create Feishu Bot via QR Code Scan ──────────────────────────────────────

interface FeishuBotToolState {
    phase: 'init' | 'qr_code' | 'polling' | 'success' | 'error';
    qr_ascii?: string;
    verification_url?: string;
    appId?: string;
    appSecret?: string;
    openId?: string;
    error?: string;
}

const FEISHU_BOT_POLL_TIMEOUT_SEC = 180;

const CreateFeishuBotSchema = z.object({});

export class CreateFeishuBotTool extends BaseTool<typeof CreateFeishuBotSchema> {
    constructor() {
        super(
            'createFeishuBot',
            '通过手机扫码一键创建飞书机器人。会在界面上生成二维码供用户使用飞书 App 扫描，扫码完成后自动创建飞书应用并返回 App ID、App Secret 和用户 Open ID。',
            CreateFeishuBotSchema,
        );
        this.setUniversalExecutor(this.run.bind(this));
    }

    // ── Electron 渲染 ─────────────────────────────────────────────────────

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const state = toolcall.result_object as FeishuBotToolState | undefined;
        if (!state) return undefined;

        if (state.phase === 'qr_code' || state.phase === 'polling') {
            const escUrl = this.escHtml(state.verification_url || '');
            // 使用在线二维码 API 生成真正的二维码图片
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(state.verification_url || '')}`;
            return `
            <div class="mt-3 mb-3 p-5 bg-white/90 backdrop-blur-md border border-slate-200 rounded-2xl shadow-sm" style="max-width: 320px;">
                <div class="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                    <div class="h-2 w-2 rounded-full bg-blue-500 animate-pulse ring-4 ring-blue-100/50"></div>
                    飞书机器人扫码创建
                </div>
                <div class="flex justify-center p-3 bg-white rounded-xl border border-slate-100">
                    <img src="${qrImageUrl}" alt="飞书机器人二维码" width="200" height="200" style="display: block;" />
                </div>
                <p class="text-xs text-slate-500 mt-3 text-center">请使用飞书 App 扫描上方二维码</p>
                <a href="${escUrl}" target="_blank" class="block mt-2 text-xs text-blue-500 hover:text-blue-600 text-center break-all">${escUrl}</a>
                <div class="flex items-center justify-center gap-1.5 mt-3">
                    <div class="h-1.5 w-1.5 rounded-full bg-blue-400 animate-bounce" style="animation-delay: 0ms;"></div>
                    <div class="h-1.5 w-1.5 rounded-full bg-blue-400 animate-bounce" style="animation-delay: 150ms;"></div>
                    <div class="h-1.5 w-1.5 rounded-full bg-blue-400 animate-bounce" style="animation-delay: 300ms;"></div>
                    <span class="ml-1 text-xs text-slate-400">等待扫码中</span>
                </div>
            </div>`;
        }

        if (state.phase === 'success') {
            const masked = state.appSecret
                ? state.appSecret.slice(0, 6) + '****' + state.appSecret.slice(-4)
                : '';
            return `
            <div class="mt-3 mb-3 p-5 bg-white/90 backdrop-blur-md border border-emerald-200 rounded-2xl shadow-sm" style="max-width: 320px;">
                <div class="text-sm font-semibold text-emerald-700 mb-3 flex items-center gap-2">
                    <div class="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"></div>
                    飞书机器人创建成功
                </div>
                <div class="text-xs text-slate-600 space-y-1.5 bg-slate-50 p-3 rounded-lg font-mono">
                    <p><span class="text-slate-400">App ID:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>${this.escHtml(state.appId || '')}</p>
                    <p><span class="text-slate-400">App Secret:&nbsp;</span>${this.escHtml(masked)}</p>
                    <p><span class="text-slate-400">Open ID:&nbsp;&nbsp;&nbsp;&nbsp;</span>${this.escHtml(state.openId || 'N/A')}</p>
                </div>
            </div>`;
        }

        if (state.phase === 'error') {
            return `
            <div class="mt-3 mb-3 p-4 bg-white/90 backdrop-blur-md border border-rose-200 rounded-2xl shadow-sm" style="max-width: 320px;">
                <div class="text-sm font-semibold text-rose-600 flex items-center gap-2">
                    <div class="h-2.5 w-2.5 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]"></div>
                    ${this.escHtml(state.error || '创建失败')}
                </div>
            </div>`;
        }

        return undefined;
    }

    // ── CLI TUI 渲染 ──────────────────────────────────────────────────────

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const state = toolcall.result_object as FeishuBotToolState | undefined;
        if (!state) return undefined;

        if (state.phase === 'init') {
            return ['  ⏳ 正在连接飞书服务器...'];
        }

        if (state.phase === 'qr_code' || state.phase === 'polling') {
            const lines: string[] = [];
            lines.push('  📱 请使用飞书 App 扫描下方二维码创建机器人:');
            lines.push('');
            if (state.qr_ascii) {
                for (const line of state.qr_ascii.split('\n')) {
                    lines.push('  ' + line);
                }
            }
            lines.push('');
            if (state.verification_url) {
                lines.push('  🔗 ' + state.verification_url);
            }
            lines.push('');
            lines.push('  ⏳ 等待扫码中...');
            return lines;
        }

        if (state.phase === 'success') {
            return [
                '  ✅ 飞书机器人创建成功！',
                `     App ID:     ${state.appId}`,
                `     App Secret: ${state.appSecret ? state.appSecret.slice(0, 6) + '****' : ''}`,
                `     Open ID:    ${state.openId || 'N/A'}`,
            ];
        }

        if (state.phase === 'error') {
            return [`  ❌ ${state.error || '创建失败'}`];
        }

        return undefined;
    }

    // ── 执行逻辑 ─────────────────────────────────────────────────────────

    private async run(_args: z.output<typeof CreateFeishuBotSchema>, result: ToolResult): Promise<void> {
        // Step 1: Init
        logger.info('[createFeishuBot] Step 1: init');
        result.updateResultObject({ phase: 'init' } satisfies FeishuBotToolState);

        const initRes = await feishuAuthInit();
        logger.info(`[createFeishuBot] init response: ${JSON.stringify(initRes)}`);

        if (!initRes.supported_auth_methods?.includes('client_secret')) {
            const errState: FeishuBotToolState = { phase: 'error', error: '当前飞书环境不支持扫码创建机器人 (client_secret 方式不可用)' };
            result.updateResultObject(errState);
            throw new Error(errState.error);
        }

        // Step 2: Begin — get device_code and QR code URL
        logger.info('[createFeishuBot] Step 2: begin');
        const beginRes = await feishuAuthBegin();
        logger.info(`[createFeishuBot] begin response: device_code=${beginRes.device_code}, interval=${beginRes.interval}, expire_in=${beginRes.expire_in ?? beginRes.expires_in}`);

        const deviceCode = beginRes.device_code;
        const verificationUrl = beginRes.verification_uri_complete;
        if (!deviceCode || !verificationUrl) {
            const errState: FeishuBotToolState = { phase: 'error', error: `飞书 begin 返回异常: device_code=${deviceCode}, uri=${verificationUrl}` };
            result.updateResultObject(errState);
            throw new Error(errState.error);
        }

        const pollIntervalSec = beginRes.interval || 5;
        const expireInSec = beginRes.expire_in || beginRes.expires_in || FEISHU_BOT_POLL_TIMEOUT_SEC;

        // Step 3: Generate QR code for display
        let qrAscii = '';
        try {
            const qrGen = (qrcodeTerminal as any).default || qrcodeTerminal;
            qrAscii = await new Promise<string>((resolve) => {
                qrGen.generate(verificationUrl, { small: true }, (code: string) => {
                    resolve(code);
                });
            });
        } catch (e: any) {
            logger.warn(`[createFeishuBot] QR code generation failed: ${e?.message}`);
            qrAscii = `请手动打开链接: ${verificationUrl}`;
        }
        logger.info(`[createFeishuBot] Step 3: QR ready, url=${verificationUrl}`);

        // Push QR code to UI immediately
        const qrState: FeishuBotToolState = {
            phase: 'qr_code',
            qr_ascii: qrAscii,
            verification_url: verificationUrl,
        };
        result.updateResultObject(qrState);

        // Step 4: Poll until user scans or timeout
        const startTime = Date.now();
        let currentInterval = pollIntervalSec;
        const deadlineMs = Math.min(expireInSec, FEISHU_BOT_POLL_TIMEOUT_SEC) * 1000;
        logger.info(`[createFeishuBot] Step 4: polling, interval=${currentInterval}s, deadline=${deadlineMs}ms`);

        while (Date.now() - startTime < deadlineMs) {
            await new Promise(resolve => setTimeout(resolve, currentInterval * 1000));

            let pollRes;
            try {
                pollRes = await feishuAuthPoll(deviceCode);
            } catch (err: any) {
                logger.warn(`[createFeishuBot] Poll network error: ${err?.message}`);
                continue;
            }

            logger.info(`[createFeishuBot] poll response: ${JSON.stringify(pollRes)}`);

            if (pollRes.client_id && pollRes.client_secret) {
                const successState: FeishuBotToolState = {
                    phase: 'success',
                    appId: pollRes.client_id,
                    appSecret: pollRes.client_secret,
                    openId: pollRes.user_info?.open_id || '',
                };
                result.updateResultObject(successState);
                result.updateResult(JSON.stringify({
                    appId: successState.appId,
                    appSecret: successState.appSecret,
                    openId: successState.openId,
                }));
                logger.info(`[createFeishuBot] 机器人创建成功: ${successState.appId}`);
                return;
            }

            if (pollRes.error) {
                if (pollRes.error === 'authorization_pending') {
                    result.updateResultObject({ ...qrState, phase: 'polling' });
                } else if (pollRes.error === 'slow_down') {
                    currentInterval += 5;
                } else if (pollRes.error === 'access_denied') {
                    const errState: FeishuBotToolState = { phase: 'error', error: '用户拒绝了授权，机器人未创建。' };
                    result.updateResultObject(errState);
                    throw new Error(errState.error);
                } else if (pollRes.error === 'expired_token') {
                    const errState: FeishuBotToolState = { phase: 'error', error: '二维码已过期，请重新调用此工具重试。' };
                    result.updateResultObject(errState);
                    throw new Error(errState.error);
                } else {
                    const msg = `${pollRes.error}${pollRes.error_description ? ': ' + pollRes.error_description : ''}`;
                    const errState: FeishuBotToolState = { phase: 'error', error: msg };
                    result.updateResultObject(errState);
                    throw new Error(msg);
                }
            }
        }

        // Timeout
        const errState: FeishuBotToolState = { phase: 'error', error: '等待超时，二维码已过期。请重新调用此工具重试。' };
        result.updateResultObject(errState);
        throw new Error(errState.error);
    }

    private escHtml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}

// ── Send File Tool ──────────────────────────────────────────────────────────

export const SEND_FILE_TOOL_NAME = 'channel-outbound-SendFile';

const SendFileSchema = z.object({
    filePath: z.string().describe('要发送的文件的绝对路径'),
    fileName: z.string().optional().describe('可选的文件显示名称，默认使用文件本身的名字'),
});

export class SendFileTool extends BaseTool<typeof SendFileSchema> {
    constructor() {
        super(
            'SendFile',
            '发送文件给用户。在消息渠道中该文件会作为附件发送，而非以文本形式发送文件内容。',
            SendFileSchema,
        );
        this.setExecutor(this.run.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof SendFileSchema> | undefined;
        if (!args?.filePath) return undefined;
        const name = args.fileName || pathLib.basename(args.filePath);
        const ext = pathLib.extname(name).toUpperCase().slice(1) || '文件';

        if (toolcall.status === 'success') {
            return `
            <div class="flex items-center group w-fit min-w-[280px] max-w-sm
                bg-emerald-50/80 backdrop-blur-xl rounded-xl px-3.5 py-2.5 mt-2 mb-2
                border border-emerald-200/60 shadow-sm select-none">
                <div class="relative w-10 h-10 flex items-center justify-center
                            bg-white rounded-lg shadow-[0_2px_5px_rgba(0,0,0,0.08)] mr-3 shrink-0">
                    <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none"><path d="M14 2H6C4.89543 2 4 2.89543 4 4V20C4 21.1046 4.89543 22 6 22H18C19.1046 22 20 21.1046 20 20V8L14 2Z" fill="#A7F3D0"/><path d="M14 2V8H20L14 2Z" fill="#6EE7B7"/></svg>
                </div>
                <div class="flex flex-col min-w-0 flex-1 overflow-hidden">
                    <span class="text-[13px] font-medium text-gray-900 truncate">${this.escHtml(name)}</span>
                    <span class="text-[11px] text-emerald-600">📤 ${ext} 文件已发送</span>
                </div>
            </div>`;
        }
        if (toolcall.status === 'error') {
            return `
            <div class="flex items-center w-fit min-w-[280px] max-w-sm
                bg-rose-50/80 backdrop-blur-xl rounded-xl px-3.5 py-2.5 mt-2 mb-2
                border border-rose-200/60 shadow-sm select-none">
                <span class="text-[13px] text-rose-600">❌ 文件发送失败: ${this.escHtml(toolcall.result || '')}</span>
            </div>`;
        }
        return undefined;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof SendFileSchema> | undefined;
        if (!args?.filePath) return undefined;
        const name = args.fileName || pathLib.basename(args.filePath);
        const ext = name.includes('.') ? name.split('.').pop()!.toUpperCase() : 'FILE';

        if (toolcall.status === 'running') {
            return [`  ${chalk.blueBright('●')} ${chalk.dim('📤')} ${chalk.bold(name)} ${chalk.dim('·')} ${chalk.dim('发送中...')}`];
        }
        if (toolcall.status === 'success') {
            return [`  ${chalk.greenBright('✔')} ${chalk.greenBright('📤')} ${chalk.bold(name)} ${chalk.dim('·')} ${chalk.dim(ext + ' 文件已发送')}`];
        }
        if (toolcall.status === 'error') {
            return [`  ${chalk.redBright('✘')} ${chalk.red('📤')} ${chalk.bold(name)} ${chalk.dim('·')} ${chalk.red('发送失败')}`];
        }
        return [`  ${chalk.dim('○')} ${chalk.dim('📤')} ${chalk.bold(name)}`];
    }

    private async run(args: z.output<typeof SendFileSchema>): Promise<string> {
        const filePath = args.filePath;
        if (!fs.existsSync(filePath)) {
            throw new Error(`文件不存在: ${filePath}`);
        }

        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
            throw new Error(`路径不是文件: ${filePath}`);
        }

        const fileName = args.fileName || pathLib.basename(filePath);
        return `文件已准备好发送: ${fileName} (${(stats.size / 1024).toFixed(1)} KB)`;
    }

    private escHtml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}
