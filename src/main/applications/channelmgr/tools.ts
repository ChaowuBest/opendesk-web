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
import type { ChannelMgrApplication } from './app.js';
import { resolveChannelDisplayName } from './app.js';
import {
    installPlugin,
    uninstallPlugin,
    isPluginEnabledFixed,
    listVisiblePlugins,
    setPluginEnabled,
    reloadPluginHost,
    applyPluginEnabledChange
} from '../pluginmgr/index.js';
import { feishuAuthInit, feishuAuthBegin, feishuAuthPoll } from './feishu-auth.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';
import qrcodeTerminal from 'qrcode-terminal';
import { escapeHtml } from '../../../common/utils/escape.js';

// ── List Channel Status ─────────────────────────────────────────────────────

const ListChannelStatusSchema = z.object({});

export class ListChannelStatusTool extends BaseTool<typeof ListChannelStatusSchema> {
    private app: ChannelMgrApplication;

    constructor(app: ChannelMgrApplication) {
        super(
            'listChannelStatus',
            'List all channel plugins and their current connection status.',
            ListChannelStatusSchema,
            undefined,
            { 'zh-CN': '渠道状态', 'en-US': 'Channel Status' }
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
    spec: z.string().describe('要安装的 OpenDesk 插件：本地目录、.tgz 文件、URL 或 npm 包名')
});

export class InstallChannelPluginTool extends BaseTool<typeof InstallChannelPluginSchema> {
    private app: ChannelMgrApplication;

    constructor(app: ChannelMgrApplication) {
        super(
            'installChannelPlugin',
            'Install an OpenDesk channel plugin by local directory, .tgz file, URL or npm package name.',
            InstallChannelPluginSchema,
            undefined,
            { 'zh-CN': '安装渠道插件', 'en-US': 'Install Plugin' }
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof InstallChannelPluginSchema>): Promise<string> {
        const result = await installPlugin(args.spec);
        if (result.success) {
            // 先让插件宿主重新加载（新插件通过 ctx.channels.register 注册 channel），
            // 再收集渠道并启动，否则 GUI 系统设置页 / reloadChannels 看不到新渠道。
            await reloadPluginHost();
            await this.app.reloadChannels();
            return `插件安装成功: ${result.id}\n\n消息渠道已自动重新加载。`;
        }
        return `插件安装失败: ${result.error}`;
    }
}

const UninstallChannelPluginSchema = z.object({
    id: z.string().describe('要卸载的插件 ID（可通过 listChannelPlugins 工具获取）')
});

export class UninstallChannelPluginTool extends BaseTool<typeof UninstallChannelPluginSchema> {
    private app: ChannelMgrApplication;

    constructor(app: ChannelMgrApplication) {
        super(
            'uninstallChannelPlugin',
            'Uninstall a previously installed channel plugin by its ID.',
            UninstallChannelPluginSchema,
            undefined,
            { 'zh-CN': '卸载渠道插件', 'en-US': 'Uninstall Plugin' }
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof UninstallChannelPluginSchema>): Promise<string> {
        const result = await uninstallPlugin(args.id);
        if (result.success) {
            // 宿主重载使被卸载插件的 channel 从运行时注销，随后收集渠道
            await reloadPluginHost();
            await this.app.reloadChannels();
            return `插件已卸载: ${args.id}\n\n消息渠道已自动重新加载。`;
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
            undefined,
            { 'zh-CN': '渠道插件列表', 'en-US': 'List Plugins' }
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(): Promise<string> {
        // 与 GUI 插件管理页同口径：包含内置插件（不经 installPlugin 写入 registry）
        const records = listVisiblePlugins();
        if (records.length === 0) {
            return '当前没有已安装的插件。';
        }
        const lines = records.map((r, i) => {
            const status = r.enabled ? '✓ 已启用' : '✗ 已禁用';
            // 由清单固定启停的插件提前标明，避免 agent 再尝试切换后被拒
            const fixed = r.system ? ' [由清单固定启停]' : '';
            return `${i + 1}. ${r.id} (${r.spec ?? r.path}) [${status}]${fixed}\n   安装时间: ${r.installedAt ?? '-'}`;
        });
        return `共 ${records.length} 个已安装的插件：\n\n${lines.join('\n\n')}`;
    }
}

const ToggleChannelPluginSchema = z.object({
    id: z.string().describe('插件 ID'),
    enabled: z.boolean().describe('true 为启用，false 为禁用')
});

export class ToggleChannelPluginTool extends BaseTool<typeof ToggleChannelPluginSchema> {
    private app: ChannelMgrApplication;

    constructor(app: ChannelMgrApplication) {
        super(
            'toggleChannelPlugin',
            'Enable or disable a channel plugin. Takes effect immediately.',
            ToggleChannelPluginSchema,
            undefined,
            { 'zh-CN': '启用/停用插件', 'en-US': 'Toggle Plugin' }
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof ToggleChannelPluginSchema>): Promise<string> {
        const action = args.enabled ? '启用' : '禁用';
        if (isPluginEnabledFixed(args.id)) {
            return `插件 ${args.id} 的启停状态由 OpenDesk 固定，无法修改`;
        }
        if (!setPluginEnabled(args.id, args.enabled)) {
            return `未找到插件: ${args.id}`;
        }
        try {
            // 差量应用启停状态（其他插件与渠道连接不受影响），随后同步该渠道
            await applyPluginEnabledChange(args.id, args.enabled);
        } catch (err: any) {
            // 启用失败（完整性校验、入口缺失等）：回滚注册表，避免留下未生效的启用状态
            setPluginEnabled(args.id, !args.enabled);
            return `插件${action}失败: ${err?.message ?? err}`;
        }
        await this.app.syncChannelsWithPluginHost(args.id, args.enabled ? 'enable' : 'disable');
        return `插件已${action}: ${args.id}`;
    }
}

const SetChannelConfigSchema = z.object({
    channelId: z.string().describe('消息渠道的 ID，例如 "feishu"'),
    config: z
        .any()
        .describe('要设置的渠道配置 JSON 对象，将写入 settings.json 的 applications.channelmgr.<channelId> 中')
});

export class SetChannelConfigTool extends BaseTool<typeof SetChannelConfigSchema> {
    private app: ChannelMgrApplication;

    constructor(app: ChannelMgrApplication) {
        super(
            'setChannelConfig',
            'Set the configuration for a channel plugin. The config will be saved to settings.json under applications.channelmgr.<channelId>.',
            SetChannelConfigSchema,
            undefined,
            { 'zh-CN': '设置渠道配置', 'en-US': 'Set Config' }
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof SetChannelConfigSchema>): Promise<string> {
        try {
            const currentConfig = (this.app.getConfig() || {}) as Record<string, any>;
            const currentChannelConfig = (currentConfig[args.channelId] || {}) as Record<string, unknown>;
            const nextChannelConfig = { ...(args.config as Record<string, unknown>) };
            // activeTasks 是 channelmgr 的运行态（已迁移到应用私有目录），不属于渠道配置，
            // 顺手剔除，避免旧知识/旧日志把它写回配置树
            delete nextChannelConfig.activeTasks;
            // accountRuntime（workspace/agentId/model/分发策略）是用户在账号设置里维护的，
            // 不属于渠道连接参数：整体替换渠道配置时保留，否则一次「设置渠道配置」就把用户设置清空
            if (nextChannelConfig.accountRuntime === undefined && currentChannelConfig.accountRuntime !== undefined) {
                nextChannelConfig.accountRuntime = currentChannelConfig.accountRuntime;
            }
            const updatedConfig = { ...currentConfig, [args.channelId]: nextChannelConfig };
            this.app.setConfig(updatedConfig);
            await this.app.reloadChannels();
            return `渠道 ${args.channelId} 的配置已保存并自动重新加载。\n\n已保存的配置:\n${JSON.stringify(nextChannelConfig, null, 2)}`;
        } catch (err: any) {
            return `保存配置失败: ${err?.message || err}`;
        }
    }
}

const GetChannelConfigSchema = z.object({
    channelId: z.string().describe('消息渠道的 ID，例如 "feishu"')
});

export class GetChannelConfigTool extends BaseTool<typeof GetChannelConfigSchema> {
    private app: ChannelMgrApplication;

    constructor(app: ChannelMgrApplication) {
        super(
            'getChannelConfig',
            'Get the configuration JSON for a specific channel plugin. Useful for debugging.',
            GetChannelConfigSchema,
            undefined,
            { 'zh-CN': '获取渠道配置', 'en-US': 'Get Config' }
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
    channelId: z
        .string()
        .describe(
            '消息渠道的 ID。有效值：\n  - "weixin"（微信）\n  - "feishu"（飞书）\n  - "whatsapp"（WhatsApp）\n  - "zalouser"（Zalo）'
        ),
    accountId: z.string().default('default').describe('账户 ID，默认为 "default"')
});

export class LoginChannelTool extends BaseTool<typeof LoginChannelSchema> {
    private app: ChannelMgrApplication;

    constructor(app: ChannelMgrApplication) {
        super(
            'loginChannel',
            '触发消息渠道的登录流程。支持的 channelId：\n  - "weixin"：微信登录（扫码）\n  - "feishu"：飞书登录（扫码创建机器人）\n  - "whatsapp"：WhatsApp 登录（扫码）\n  - "zalouser"：Zalo 登录（扫码）\n登录成功后会返回结果。',
            LoginChannelSchema,
            undefined,
            { 'zh-CN': '渠道登录', 'en-US': 'Channel Login' }
        );
        this.app = app;
        this.setUniversalExecutor(this.run.bind(this));
    }

    requiresUserAttention(toolcall: ToolCall): boolean {
        const phase = (toolcall.result_object as LoginChannelState | undefined)?.phase;
        return phase === 'generating_qr' || phase === 'polling';
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const state = toolcall.result_object as LoginChannelState | undefined;
        if (!state) return undefined;

        if (state.phase === 'generating_qr' || state.phase === 'polling') {
            const channelLabel = resolveChannelDisplayName(state.channelId || '');
            const escUrl = escapeHtml(state.verification_url || '');
            const qrImageUrl = state.verification_url
                ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(state.verification_url)}`
                : '';

            return `
            <div class="mt-3 mb-3 p-5 bg-white/90 backdrop-blur-md border border-slate-200 rounded-2xl shadow-sm" style="max-width: 320px;">
                <div class="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                    <div class="h-2 w-2 rounded-full bg-blue-500 animate-pulse ring-4 ring-blue-100/50"></div>
                    ${channelLabel} 扫码登录
                </div>
                ${
                    qrImageUrl
                        ? `<div class="flex justify-center p-3 bg-white rounded-xl border border-slate-100">
                    <img src="${qrImageUrl}" alt="${channelLabel} 二维码" width="200" height="200" style="display: block;" />
                </div>`
                        : ''
                }
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
            lines.push(`渠道 ${resolveChannelDisplayName(state.channelId || '')} 登录成功！`);
            if (state.message) lines.push(state.message);
            if (state.appId) lines.push(`App ID: ${state.appId}`);
            if (state.appSecret) lines.push(`App Secret: ${state.appSecret.slice(0, 6)}****`);
            return `
            <div class="mt-3 mb-3 p-5 bg-white/90 backdrop-blur-md border border-emerald-200 rounded-2xl shadow-sm" style="max-width: 320px;">
                <div class="text-sm font-semibold text-emerald-700 mb-3 flex items-center gap-2">
                    <div class="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"></div>
                    登录成功
                </div>
                <div class="text-xs text-slate-600 space-y-1">${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}</div>
            </div>`;
        }

        if (state.phase === 'error') {
            return `
            <div class="mt-3 mb-3 p-4 bg-white/90 backdrop-blur-md border border-rose-200 rounded-2xl shadow-sm" style="max-width: 320px;">
                <div class="text-sm font-semibold text-rose-600 flex items-center gap-2">
                    <div class="h-2.5 w-2.5 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]"></div>
                    登录失败
                </div>
                <p class="text-xs text-rose-500 mt-2">${escapeHtml(state.error || '未知错误')}</p>
            </div>`;
        }

        return undefined;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const state = toolcall.result_object as LoginChannelState | undefined;
        if (!state) return undefined;

        const displayName = resolveChannelDisplayName(state.channelId || '');

        if (state.phase === 'init' || state.phase === 'generating_qr') {
            return [`  ⏳ 正在启动 ${displayName} 登录流程...`];
        }

        if (state.phase === 'polling') {
            const lines: string[] = [];
            lines.push(`  📱 请使用 ${displayName} App 扫描下方二维码登录:`);
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
            const lines: string[] = [`  ✅ ${displayName} 登录成功！`];
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

        result.updateResultObject({
            phase: 'init',
            channelId,
            accountId
        } satisfies LoginChannelState);

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
                    appSecret: loginResult.appSecret
                } satisfies LoginChannelState);
                result.updateResult(loginResult.message || `${channelId} 登录成功`);
            } else if (loginResult.phase === 'error') {
                result.updateResultObject({
                    phase: 'error',
                    channelId,
                    accountId,
                    error: loginResult.error
                } satisfies LoginChannelState);
                throw new Error(loginResult.error);
            }
        } catch (err: any) {
            result.updateResultObject({
                phase: 'error',
                channelId,
                accountId,
                error: err?.message || String(err)
            } satisfies LoginChannelState);
            throw err;
        }
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
            undefined,
            { 'zh-CN': '创建飞书机器人', 'en-US': 'Create Feishu Bot' }
        );
        this.setUniversalExecutor(this.run.bind(this));
    }

    requiresUserAttention(toolcall: ToolCall): boolean {
        const phase = (toolcall.result_object as FeishuBotToolState | undefined)?.phase;
        return phase === 'qr_code' || phase === 'polling';
    }

    // ── Electron 渲染 ─────────────────────────────────────────────────────

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const state = toolcall.result_object as FeishuBotToolState | undefined;
        if (!state) return undefined;

        if (state.phase === 'qr_code' || state.phase === 'polling') {
            const escUrl = escapeHtml(state.verification_url || '');
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
            const masked = state.appSecret ? state.appSecret.slice(0, 6) + '****' + state.appSecret.slice(-4) : '';
            return `
            <div class="mt-3 mb-3 p-5 bg-white/90 backdrop-blur-md border border-emerald-200 rounded-2xl shadow-sm" style="max-width: 320px;">
                <div class="text-sm font-semibold text-emerald-700 mb-3 flex items-center gap-2">
                    <div class="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"></div>
                    飞书机器人创建成功
                </div>
                <div class="text-xs text-slate-600 space-y-1.5 bg-slate-50 p-3 rounded-lg font-mono">
                    <p><span class="text-slate-400">App ID:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>${escapeHtml(state.appId || '')}</p>
                    <p><span class="text-slate-400">App Secret:&nbsp;</span>${escapeHtml(masked)}</p>
                    <p><span class="text-slate-400">Open ID:&nbsp;&nbsp;&nbsp;&nbsp;</span>${escapeHtml(state.openId || 'N/A')}</p>
                </div>
            </div>`;
        }

        if (state.phase === 'error') {
            return `
            <div class="mt-3 mb-3 p-4 bg-white/90 backdrop-blur-md border border-rose-200 rounded-2xl shadow-sm" style="max-width: 320px;">
                <div class="text-sm font-semibold text-rose-600 flex items-center gap-2">
                    <div class="h-2.5 w-2.5 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]"></div>
                    ${escapeHtml(state.error || '创建失败')}
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
                `     Open ID:    ${state.openId || 'N/A'}`
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
            const errState: FeishuBotToolState = {
                phase: 'error',
                error: '当前飞书环境不支持扫码创建机器人 (client_secret 方式不可用)'
            };
            result.updateResultObject(errState);
            throw new Error(errState.error);
        }

        // Step 2: Begin — get device_code and QR code URL
        logger.info('[createFeishuBot] Step 2: begin');
        const beginRes = await feishuAuthBegin();
        logger.info(
            `[createFeishuBot] begin response: device_code=${beginRes.device_code}, interval=${beginRes.interval}, expire_in=${beginRes.expire_in ?? beginRes.expires_in}`
        );

        const deviceCode = beginRes.device_code;
        const verificationUrl = beginRes.verification_uri_complete;
        if (!deviceCode || !verificationUrl) {
            const errState: FeishuBotToolState = {
                phase: 'error',
                error: `飞书 begin 返回异常: device_code=${deviceCode}, uri=${verificationUrl}`
            };
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
            verification_url: verificationUrl
        };
        result.updateResultObject(qrState);

        // Step 4: Poll until user scans or timeout
        const startTime = Date.now();
        let currentInterval = pollIntervalSec;
        const deadlineMs = Math.min(expireInSec, FEISHU_BOT_POLL_TIMEOUT_SEC) * 1000;
        logger.info(`[createFeishuBot] Step 4: polling, interval=${currentInterval}s, deadline=${deadlineMs}ms`);

        while (Date.now() - startTime < deadlineMs) {
            await new Promise((resolve) => setTimeout(resolve, currentInterval * 1000));

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
                    openId: pollRes.user_info?.open_id || ''
                };
                result.updateResultObject(successState);
                result.updateResult(
                    JSON.stringify({
                        appId: successState.appId,
                        appSecret: successState.appSecret,
                        openId: successState.openId
                    })
                );
                logger.info(`[createFeishuBot] 机器人创建成功: ${successState.appId}`);
                return;
            }

            if (pollRes.error) {
                if (pollRes.error === 'authorization_pending') {
                    result.updateResultObject({ ...qrState, phase: 'polling' });
                } else if (pollRes.error === 'slow_down') {
                    currentInterval += 5;
                } else if (pollRes.error === 'access_denied') {
                    const errState: FeishuBotToolState = {
                        phase: 'error',
                        error: '用户拒绝了授权，机器人未创建。'
                    };
                    result.updateResultObject(errState);
                    throw new Error(errState.error);
                } else if (pollRes.error === 'expired_token') {
                    const errState: FeishuBotToolState = {
                        phase: 'error',
                        error: '二维码已过期，请重新调用此工具重试。'
                    };
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
        const errState: FeishuBotToolState = {
            phase: 'error',
            error: '等待超时，二维码已过期。请重新调用此工具重试。'
        };
        result.updateResultObject(errState);
        throw new Error(errState.error);
    }
}

// ── Send File Tool ──────────────────────────────────────────────────────────

export const SEND_FILE_TOOL_NAME = 'channel-outbound-SendFile';

const SendFileSchema = z.object({
    filePath: z.string().describe('要发送的文件的绝对路径'),
    fileName: z.string().optional().describe('可选的文件显示名称，默认使用文件本身的名字')
});

export class SendFileTool extends BaseTool<typeof SendFileSchema> {
    constructor() {
        super(
            'SendFile',
            '发送文件给用户。在消息渠道中该文件会作为附件发送，而非以文本形式发送文件内容。',
            SendFileSchema,
            undefined,
            { 'zh-CN': '发送文件', 'en-US': 'Send File' }
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
            <div class="file-tool-card flex items-center group w-fit min-w-[280px] max-w-sm
                bg-emerald-50 backdrop-blur-xl rounded-xl px-3.5 py-2.5 mt-2 mb-2
                border border-emerald-200 shadow-sm select-none">
                <div class="relative w-10 h-10 flex items-center justify-center
                            bg-white rounded-lg shadow-[0_2px_5px_rgba(0,0,0,0.08)] mr-3 shrink-0">
                    <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none"><path d="M14 2H6C4.89543 2 4 2.89543 4 4V20C4 21.1046 4.89543 22 6 22H18C19.1046 22 20 21.1046 20 20V8L14 2Z" fill="#A7F3D0"/><path d="M14 2V8H20L14 2Z" fill="#6EE7B7"/></svg>
                </div>
                <div class="flex flex-col min-w-0 flex-1 overflow-hidden">
                    <span class="text-[13px] font-medium text-gray-900 truncate">${escapeHtml(name)}</span>
                    <span class="text-[11px] text-emerald-600">📤 ${ext} 文件已发送</span>
                </div>
            </div>`;
        }
        if (toolcall.status === 'error') {
            return `
            <div class="file-tool-card flex items-center w-fit min-w-[280px] max-w-sm
                bg-rose-50 backdrop-blur-xl rounded-xl px-3.5 py-2.5 mt-2 mb-2
                border border-rose-200 shadow-sm select-none">
                <span class="text-[13px] text-rose-600">❌ 文件发送失败: ${escapeHtml(toolcall.result || '')}</span>
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
            return [
                `  ${chalk.blueBright('●')} ${chalk.dim('📤')} ${chalk.bold(name)} ${chalk.dim('·')} ${chalk.dim('发送中...')}`
            ];
        }
        if (toolcall.status === 'success') {
            return [
                `  ${chalk.greenBright('✔')} ${chalk.greenBright('📤')} ${chalk.bold(name)} ${chalk.dim('·')} ${chalk.dim(ext + ' 文件已发送')}`
            ];
        }
        if (toolcall.status === 'error') {
            return [
                `  ${chalk.redBright('✘')} ${chalk.red('📤')} ${chalk.bold(name)} ${chalk.dim('·')} ${chalk.red('发送失败')}`
            ];
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
}
