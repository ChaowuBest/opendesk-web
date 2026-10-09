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

import { BaseTool } from '../../aikernel/tool';
import { ToolCall } from '../../aikernel/messages';
import { Card } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import { escapeHtml } from '../../../common/utils/escape.js';
import { ApplicationRegistry } from '../registry';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';
import { z } from 'zod';
import fs from 'fs';
import nodePath from 'path';
import type { MailboxApplication } from './app';

// ============================================================
// 工具调用渲染辅助函数
// ============================================================

/**
 * 单行内联工具渲染：图标 + 标题 + 状态点 + 关键信息
 */
function renderMailboxInlineTool(opts: { icon: string; title: string; status: string; detail?: string }): string {
    const statusIcon =
        opts.status === 'running'
            ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
            : opts.status === 'error'
              ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
              : '';

    const detailHtml = opts.detail
        ? `<span class="truncate text-xs text-slate-600">${escapeHtml(opts.detail)}</span>`
        : '';

    return `<div class="od-inline-toolcall-container">
        <div class="flex items-center gap-1.5 min-w-0">
            <i class="${opts.icon} shrink-0 text-slate-400 text-xs"></i>
            <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(opts.title)}</span>
            ${statusIcon}
            ${detailHtml}
        </div>
    </div>`;
}

/** 解析工具结果中的 success / 数量等通用字段 */
function parseMailboxResult(result: string | undefined): { success?: boolean; total?: number; message?: string } {
    if (!result) return {};
    try {
        return JSON.parse(result);
    } catch {
        return {};
    }
}

// ============================================================
// 常见邮箱服务商预设配置
// ============================================================

interface MailProviderPreset {
    name: string;
    domains: string[];
    imap: { host: string; port: number; tls: boolean };
    pop3: { host: string; port: number; tls: boolean };
    smtp: { host: string; port: number; tls: boolean };
    /** 是否要求单独的认证用户名（与邮箱地址不同） */
    requireAuthUsername?: boolean;
    /** 认证用户名的提示说明，用于引导 AI 向用户询问 */
    authUsernameHint?: string;
}

const MAIL_PROVIDER_PRESETS: MailProviderPreset[] = [
    {
        name: 'QQ邮箱',
        domains: ['qq.com', 'foxmail.com'],
        imap: { host: 'imap.qq.com', port: 993, tls: true },
        pop3: { host: 'pop.qq.com', port: 995, tls: true },
        smtp: { host: 'smtp.qq.com', port: 465, tls: true }
    },
    {
        name: '163邮箱',
        domains: ['163.com'],
        imap: { host: 'imap.163.com', port: 993, tls: true },
        pop3: { host: 'pop.163.com', port: 995, tls: true },
        smtp: { host: 'smtp.163.com', port: 465, tls: true }
    },
    {
        name: '126邮箱',
        domains: ['126.com'],
        imap: { host: 'imap.126.com', port: 993, tls: true },
        pop3: { host: 'pop.126.com', port: 995, tls: true },
        smtp: { host: 'smtp.126.com', port: 465, tls: true }
    },
    {
        name: 'yeah.net邮箱',
        domains: ['yeah.net'],
        imap: { host: 'imap.yeah.net', port: 993, tls: true },
        pop3: { host: 'pop.yeah.net', port: 995, tls: true },
        smtp: { host: 'smtp.yeah.net', port: 465, tls: true }
    },
    {
        name: 'Outlook',
        domains: ['outlook.com', 'hotmail.com', 'live.com', 'live.cn'],
        imap: { host: 'outlook.office365.com', port: 993, tls: true },
        pop3: { host: 'outlook.office365.com', port: 995, tls: true },
        smtp: { host: 'smtp.office365.com', port: 587, tls: true }
    },
    {
        name: 'Gmail',
        domains: ['gmail.com', 'googlemail.com'],
        imap: { host: 'imap.gmail.com', port: 993, tls: true },
        pop3: { host: 'pop.gmail.com', port: 995, tls: true },
        smtp: { host: 'smtp.gmail.com', port: 465, tls: true }
    },
    {
        name: '139邮箱',
        domains: ['139.com'],
        imap: { host: 'imap.139.com', port: 993, tls: true },
        pop3: { host: 'pop.139.com', port: 995, tls: true },
        smtp: { host: 'smtp.139.com', port: 465, tls: true }
    },
    {
        name: '新浪邮箱',
        domains: ['sina.com', 'sina.cn'],
        imap: { host: 'imap.sina.com', port: 993, tls: true },
        pop3: { host: 'pop.sina.com', port: 995, tls: true },
        smtp: { host: 'smtp.sina.com', port: 465, tls: true }
    },
    {
        name: '搜狐邮箱',
        domains: ['sohu.com'],
        imap: { host: 'imap.sohu.com', port: 993, tls: true },
        pop3: { host: 'pop3.sohu.com', port: 995, tls: true },
        smtp: { host: 'smtp.sohu.com', port: 465, tls: true }
    },
    {
        name: '阿里邮箱',
        domains: ['aliyun.com'],
        imap: { host: 'imap.aliyun.com', port: 993, tls: true },
        pop3: { host: 'pop3.aliyun.com', port: 995, tls: true },
        smtp: { host: 'smtp.aliyun.com', port: 465, tls: true }
    },
    {
        name: '华为邮箱',
        domains: ['huawei.com'],
        imap: { host: 'imail.huawei.com', port: 143, tls: false },
        pop3: { host: 'popscn.huawei.com', port: 110, tls: false },
        smtp: { host: 'smtpscn.huawei.com', port: 25, tls: false },
        requireAuthUsername: true,
        authUsernameHint: '华为邮箱收信需要使用单独的用户名（格式：姓名首字母 + 8位工号，例如 z00123456），请向用户询问'
    }
];

/**
 * 根据邮箱地址的域名匹配预设服务商
 */
function matchPreset(email: string): MailProviderPreset | undefined {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return undefined;
    return MAIL_PROVIDER_PRESETS.find((p) => p.domains.includes(domain));
}

// ============================================================
// AddMailAccount Tool
// ============================================================

const AddMailAccountArgsSchema = z.object({
    email: z.string().describe('邮箱地址，例如 "user@qq.com"'),
    password: z
        .string()
        .min(1, '密码/授权码不能为空，必须向用户询问后才能调用此工具')
        .describe('邮箱密码或授权码（必填，不能为空）'),
    protocol: z.enum(['imap', 'pop3']).describe('收信协议，imap 或 pop3，需要询问用户选择'),
    name: z.string().optional().describe('账号显示名称（可选）。如不确定可不填，默认使用邮箱地址'),
    authUsername: z
        .string()
        .optional()
        .describe(
            '收信认证用户名（可选）。某些邮箱服务商（如华为邮箱）要求使用与邮箱地址不同的用户名进行 IMAP/POP3 认证。华为邮箱格式为：姓名首字母+8位工号（如 zhangsan00123456）。如果服务商不要求则不需要填写。'
        ),
    // ── 自定义服务器配置（仅当邮箱不在预设服务商列表中时需要提供） ──
    imapHost: z.string().optional().describe('IMAP 服务器地址（当邮箱不在预设服务商列表中且收信协议选择 imap 时必填）'),
    imapPort: z.number().optional().describe('IMAP 服务器端口（可选，默认: TLS开启时993，关闭时143）'),
    imapTls: z.boolean().optional().describe('IMAP 是否启用 TLS（可选，默认 true）'),
    pop3Host: z.string().optional().describe('POP3 服务器地址（当邮箱不在预设服务商列表中且收信协议选择 pop3 时必填）'),
    pop3Port: z.number().optional().describe('POP3 服务器端口（可选，默认: TLS开启时995，关闭时110）'),
    pop3Tls: z.boolean().optional().describe('POP3 是否启用 TLS（可选，默认 true）'),
    smtpHost: z.string().optional().describe('SMTP 发信服务器地址（当邮箱不在预设服务商列表中时必填）'),
    smtpPort: z.number().optional().describe('SMTP 发信服务器端口（可选，默认: TLS开启时465，关闭时25）'),
    smtpTls: z.boolean().optional().describe('SMTP 是否启用 TLS（可选，默认 true）')
});

export class AddMailAccountTool extends BaseTool<typeof AddMailAccountArgsSchema> {
    private mailApp: MailboxApplication;

    constructor(mailApp: MailboxApplication) {
        super(
            'addMailAccount',
            '添加邮箱账号。内置常见邮箱服务商（QQ、163、126、Outlook、Gmail等）的服务器预设，只需提供邮箱地址、密码/授权码和收信协议（imap或pop3）即可完成配置。对于不在预设列表中的邮箱（如企业邮箱、自建邮箱），需要额外提供收信服务器地址（imapHost/pop3Host）和SMTP发信服务器地址（smtpHost），端口和TLS可选（有合理默认值）。',
            AddMailAccountArgsSchema,
            undefined,
            { 'zh-CN': '添加邮箱账号', 'en-US': 'Add Mail Account' }
        );
        this.mailApp = mailApp;
        this.executor = this.addAccount.bind(this);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        const email = args?.email || '';
        const protocol = args?.protocol || '';
        const detailParts: string[] = [];
        if (email) detailParts.push(email);
        if (protocol) detailParts.push(protocol.toUpperCase());
        if (toolcall.status === 'success') {
            const r = parseMailboxResult(toolcall.result);
            detailParts.push(r.success ? '配置成功' : r.message || '');
        }
        return renderMailboxInlineTool({
            icon: 'fas fa-plus-circle',
            title: '添加邮箱账号',
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const email = args?.['email'];
        const protocol = args?.['protocol'];
        const body: string[] = [];

        if (email) {
            body.push(chalk.dim('邮箱: ') + chalk.cyan(String(email)));
            const preset = matchPreset(String(email));
            if (preset) {
                body.push(chalk.dim('服务商: ') + chalk.green(preset.name));
            } else {
                body.push(chalk.dim('服务商: ') + chalk.yellow('自定义'));
            }
        }
        if (protocol) {
            body.push(chalk.dim('收信协议: ') + chalk.blue(String(protocol).toUpperCase()));
        }
        if (args?.['authUsername']) {
            body.push(chalk.dim('认证用户名: ') + chalk.yellow(String(args['authUsername'])));
        }
        if (args?.['name']) {
            body.push(chalk.dim('显示名称: ') + chalk.white(String(args['name'])));
        }
        if (args?.['password']) {
            body.push(chalk.dim('密码: ') + chalk.yellow('******'));
        }
        // 展示自定义服务器信息
        if (email && !matchPreset(String(email))) {
            if (protocol === 'imap' && args?.['imapHost']) {
                body.push(
                    chalk.dim('IMAP: ') +
                        chalk.white(
                            `${args['imapHost']}:${args['imapPort'] ?? (args['imapTls'] !== false ? 993 : 143)}`
                        ) +
                        chalk.dim(args['imapTls'] !== false ? ' (TLS)' : '')
                );
            }
            if (protocol === 'pop3' && args?.['pop3Host']) {
                body.push(
                    chalk.dim('POP3: ') +
                        chalk.white(
                            `${args['pop3Host']}:${args['pop3Port'] ?? (args['pop3Tls'] !== false ? 995 : 110)}`
                        ) +
                        chalk.dim(args['pop3Tls'] !== false ? ' (TLS)' : '')
                );
            }
            if (args?.['smtpHost']) {
                body.push(
                    chalk.dim('SMTP: ') +
                        chalk.white(
                            `${args['smtpHost']}:${args['smtpPort'] ?? (args['smtpTls'] !== false ? 465 : 25)}`
                        ) +
                        chalk.dim(args['smtpTls'] !== false ? ' (TLS)' : '')
                );
            }
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 配置中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ✓ ') + chalk.green(result.message));
            } catch {
                body.push(chalk.dim('  ✓ 配置成功!'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '📧',
            title: '添加邮箱账号',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async addAccount(args: z.output<typeof AddMailAccountArgsSchema>): Promise<string> {
        const email = args.email.trim();
        const password = args.password?.trim();
        const protocol = args.protocol;
        const displayName = args.name?.trim() || email;
        const authUsername = args.authUsername?.trim();

        // 验证邮箱格式
        if (!email.includes('@')) {
            throw new Error(`"${email}" 不是有效的邮箱地址`);
        }

        // 验证密码/授权码不能为空
        if (!password) {
            throw new Error('密码或授权码不能为空，请先向用户询问密码/授权码后再调用此工具');
        }

        // 验证协议参数
        if (protocol !== 'imap' && protocol !== 'pop3') {
            throw new Error(`无效的收信协议 "${protocol}"，仅支持 "imap" 或 "pop3"`);
        }

        // 匹配预设
        const preset = matchPreset(email);

        // 如果预设要求单独的认证用户名，但用户未提供，则报错引导
        if (preset?.requireAuthUsername && !authUsername) {
            throw new Error(
                `${preset.authUsernameHint || `${preset.name}需要提供单独的认证用户名（authUsername 参数）`}。` +
                    `\n该用户名用于 IMAP/POP3 收信认证，与邮箱地址不同，请务必向用户询问后再调用此工具。`
            );
        }

        // ── 构建服务器配置 ──
        let imapConfig: { host: string; port: number; tls: boolean };
        let pop3Config: { host: string; port: number; tls: boolean };
        let smtpConfig: { host: string; port: number; tls: boolean };
        let providerName: string;

        if (preset) {
            // 使用预设配置
            imapConfig = { ...preset.imap };
            pop3Config = { ...preset.pop3 };
            smtpConfig = { ...preset.smtp };
            providerName = preset.name;
        } else {
            // 自定义服务器配置 —— 根据用户选择的协议验证必填字段
            providerName = '自定义';

            if (protocol === 'imap') {
                if (!args.imapHost) {
                    throw new Error(
                        `邮箱 "${email}" 不在预设服务商列表中，选择了 IMAP 协议，需要提供 IMAP 服务器地址（imapHost 参数）。` +
                            `\n请向用户询问 IMAP 服务器地址、端口、是否启用 TLS，以及 SMTP 发信服务器地址。`
                    );
                }
            } else {
                if (!args.pop3Host) {
                    throw new Error(
                        `邮箱 "${email}" 不在预设服务商列表中，选择了 POP3 协议，需要提供 POP3 服务器地址（pop3Host 参数）。` +
                            `\n请向用户询问 POP3 服务器地址、端口、是否启用 TLS，以及 SMTP 发信服务器地址。`
                    );
                }
            }

            if (!args.smtpHost) {
                throw new Error(
                    `邮箱 "${email}" 不在预设服务商列表中，需要提供 SMTP 发信服务器地址（smtpHost 参数）。` +
                        `\n请向用户询问 SMTP 服务器地址、端口和是否启用 TLS。`
                );
            }

            const imapTls = args.imapTls ?? true;
            const pop3Tls = args.pop3Tls ?? true;
            const smtpTls = args.smtpTls ?? true;

            imapConfig = {
                host: args.imapHost ?? '',
                port: args.imapPort ?? (imapTls ? 993 : 143),
                tls: imapTls
            };
            pop3Config = {
                host: args.pop3Host ?? '',
                port: args.pop3Port ?? (pop3Tls ? 995 : 110),
                tls: pop3Tls
            };
            smtpConfig = {
                host: args.smtpHost,
                port: args.smtpPort ?? (smtpTls ? 465 : 25),
                tls: smtpTls
            };
        }

        // 【关键】深拷贝配置，避免直接修改 Setting 内存中的引用对象
        const rawConfig = this.mailApp.getConfig();
        const config = rawConfig ? JSON.parse(JSON.stringify(rawConfig)) : { profiles: [] };
        const profiles: any[] = Array.isArray(config.profiles) ? config.profiles : [];
        const username = authUsername || email;
        const existing = profiles.find((p: any) => p.username === username || p.email === email);
        if (existing) {
            return JSON.stringify({
                success: true,
                message: `邮箱账号 "${email}" 已存在，无需重复添加`,
                email,
                provider: providerName,
                alreadyExists: true
            });
        }

        // 同时配置 IMAP 和 POP3 服务器信息，通过 protocol 字段标记用户选择的协议
        // username: 用于 IMAP/POP3 认证的用户名（某些服务商如华为邮箱需要与邮箱地址不同的用户名）
        // name: 显示名称
        // email: 原始邮箱地址（用于 SMTP 发信和唯一标识）
        const newProfile = {
            name: displayName,
            username: authUsername || email,
            email: email,
            password: password,
            inbox: {
                protocol,
                imap: {
                    host: imapConfig.host,
                    tls: imapConfig.tls,
                    port: imapConfig.port
                },
                pop3: {
                    host: pop3Config.host,
                    tls: pop3Config.tls,
                    port: pop3Config.port
                }
            },
            outbox: {
                smtp: {
                    account: email,
                    host: smtpConfig.host,
                    tls: smtpConfig.tls,
                    port: smtpConfig.port
                }
            }
        };

        // 先验证账号连接，验证通过后再保存配置
        let verifyResult: any = null;
        try {
            verifyResult = await this.mailApp.callWorker('verifyAccount', {
                email,
                protocol,
                imap: protocol === 'imap' ? imapConfig : undefined,
                pop3: protocol === 'pop3' ? pop3Config : undefined,
                smtp: smtpConfig,
                password,
                authUsername
            });
            verifyResult = verifyResult?.data;
        } catch (err: any) {
            logger.warn(`failed to verify account ${email}: ${err?.message ?? err}`);
        }

        const inboxOk = verifyResult?.inbox?.status === 'success';
        const smtpOk = verifyResult?.smtp?.status === 'success';
        const inboxError = verifyResult?.inbox?.error;
        const smtpError = verifyResult?.smtp?.error;

        const serverInfo = preset
            ? ''
            : ` [${protocol === 'imap' ? imapConfig.host : pop3Config.host}:${protocol === 'imap' ? imapConfig.port : pop3Config.port}, SMTP: ${smtpConfig.host}:${smtpConfig.port}]`;
        const authInfo = authUsername ? `, 认证用户名: ${authUsername}` : '';

        if (!inboxOk) {
            return JSON.stringify({
                success: false,
                verified: true,
                inboxVerified: false,
                smtpVerified: smtpOk,
                inboxError: inboxError || '连接失败',
                smtpError: smtpError || undefined,
                message: `邮箱账号 "${email}" (${providerName}, ${protocol.toUpperCase()}${authInfo})${serverInfo} 收信验证失败: ${inboxError || '未知错误'}。账号未添加，请检查邮箱地址、授权码或服务器配置是否正确后重试。`,
                email,
                provider: providerName,
                protocol
            });
        }

        if (!smtpOk) {
            return JSON.stringify({
                success: false,
                verified: true,
                inboxVerified: inboxOk,
                smtpVerified: false,
                inboxError: undefined,
                smtpError: smtpError || '连接失败',
                message: `邮箱账号 "${email}" (${providerName}, ${protocol.toUpperCase()}${authInfo})${serverInfo} 发信(SMTP)验证失败: ${smtpError || '未知错误'}。账号未添加，请检查SMTP配置或授权码是否正确后重试。`,
                email,
                provider: providerName,
                protocol
            });
        }

        // 验证通过，保存配置
        profiles.push(newProfile);
        config.profiles = profiles;
        if (!config.currentProfileId) {
            config.currentProfileId = username;
        }
        this.mailApp.setConfig(config);

        // 通知 Worker 重新加载配置并自动触发邮件同步
        this.notifyWorkerConfigChanged();

        return JSON.stringify({
            success: true,
            verified: true,
            inboxVerified: true,
            smtpVerified: true,
            message: `邮箱账号 "${email}" (${providerName}, ${protocol.toUpperCase()}${authInfo})${serverInfo} 配置成功，收信和发信验证通过，正在后台同步邮件…`,
            email,
            provider: providerName,
            protocol,
            displayName,
            authUsername: authUsername || undefined,
            isCustom: !preset
        });
    }

    /**
     * 通知 Worker 线程配置已变更，触发 reloadProfilesFromConfig + trySync
     */
    private notifyWorkerConfigChanged() {
        const config = this.mailApp.getConfig();
        this.mailApp.callWorker('applicationConfigChanged', config).catch((err: any) => {
            logger.warn(`failed to notify mailbox worker of config change: ${err?.message ?? err}`);
        });
    }
}

// ============================================================
// ListMailAccounts Tool
// ============================================================

const ListMailAccountsArgsSchema = z.object({});

export class ListMailAccountsTool extends BaseTool<typeof ListMailAccountsArgsSchema> {
    private mailApp: MailboxApplication;

    constructor(mailApp: MailboxApplication) {
        super('listMailAccounts', '列出当前已配置的所有邮箱账号', ListMailAccountsArgsSchema, undefined, {
            'zh-CN': '邮箱账号列表',
            'en-US': 'List Mail Accounts'
        });
        this.mailApp = mailApp;
        this.executor = this.listAccounts.bind(this);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const detailParts: string[] = [];
        if (toolcall.status === 'success' && toolcall.result) {
            const r = parseMailboxResult(toolcall.result);
            if (r.total !== undefined) detailParts.push(`${r.total} 个账号`);
        }
        return renderMailboxInlineTool({
            icon: 'fas fa-list',
            title: '邮箱账号列表',
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 加载中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                const accounts = Array.isArray(result.accounts) ? result.accounts : [];
                if (accounts.length === 0) {
                    body.push(chalk.dim('  暂无已配置的邮箱账号'));
                } else {
                    body.push(chalk.dim(`  找到 ${chalk.white(String(accounts.length))} 个邮箱账号:`));
                    for (const account of accounts) {
                        const isCurrent = account.isCurrent ? chalk.yellow(' [当前]') : '';
                        const provider = account.provider ? chalk.dim(` (${account.provider})`) : '';
                        const protocol = account.protocol
                            ? chalk.blue(` [${String(account.protocol).toUpperCase()}]`)
                            : '';
                        body.push(`    📧 ${chalk.cyan(String(account.email))}${provider}${protocol}${isCurrent}`);
                    }
                }
            } catch {
                body.push(chalk.dim('  ✓ 已获取邮箱账号列表'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '📋',
            title: '邮箱账号列表',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async listAccounts(): Promise<string> {
        const config = this.mailApp.getConfig() ?? { profiles: [] };
        const profiles = Array.isArray(config.profiles) ? config.profiles : [];
        const currentProfileId = config.currentProfileId;

        const accounts = profiles.map((p: any) => {
            const emailAddr = p.email || p.username;
            const preset = matchPreset(emailAddr);
            return {
                email: emailAddr,
                username: p.username,
                name: p.name || emailAddr,
                provider: preset?.name ?? '未知',
                protocol: p.inbox?.protocol ?? '未配置',
                isCurrent: p.username === currentProfileId,
                hasAuthUsername: p.username !== emailAddr ? p.username : undefined
            };
        });

        return JSON.stringify({
            accounts,
            total: accounts.length
        });
    }
}

// ============================================================
// RemoveMailAccount Tool
// ============================================================

const RemoveMailAccountArgsSchema = z.object({
    email: z.string().describe('要删除的邮箱地址')
});

export class RemoveMailAccountTool extends BaseTool<typeof RemoveMailAccountArgsSchema> {
    private mailApp: MailboxApplication;

    constructor(mailApp: MailboxApplication) {
        super('removeMailAccount', '删除已配置的邮箱账号', RemoveMailAccountArgsSchema, undefined, {
            'zh-CN': '删除邮箱账号',
            'en-US': 'Remove Mail Account'
        });
        this.mailApp = mailApp;
        this.executor = this.removeAccount.bind(this);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        return renderMailboxInlineTool({
            icon: 'fas fa-user-minus',
            title: '删除邮箱账号',
            status: toolcall.status,
            detail: args?.email ? args.email : undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const email = args?.['email'];
        const body: string[] = [];

        if (email) {
            body.push(chalk.dim('邮箱: ') + chalk.magenta(String(email)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 删除中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ✓ ') + chalk.green(result.message));
            } catch {
                body.push(chalk.dim('  ✓ 删除成功!'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '🗑️',
            title: '删除邮箱账号',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async removeAccount(args: z.output<typeof RemoveMailAccountArgsSchema>): Promise<string> {
        const email = args.email.trim();
        // 【关键】深拷贝配置，避免直接修改 Setting 内存中的引用对象
        const rawConfig = this.mailApp.getConfig();
        const config = rawConfig ? JSON.parse(JSON.stringify(rawConfig)) : { profiles: [] };
        const profiles: any[] = Array.isArray(config.profiles) ? config.profiles : [];

        const index = profiles.findIndex((p: any) => p.username === email || p.email === email);
        if (index === -1) {
            throw new Error(`未找到邮箱账号 "${email}"`);
        }

        const removed = profiles.splice(index, 1)[0] as any;
        config.profiles = profiles;

        // 如果删除的是当前选中的账号，切换到第一个
        // currentProfileId 存储的是 username（可能是 authUsername）
        if (config.currentProfileId === removed.username) {
            config.currentProfileId = profiles.length > 0 ? (profiles[0] as any).username : undefined;
        }

        this.mailApp.setConfig(config);

        // 通知 Worker 重新加载配置（移除已删除的账号）
        this.notifyWorkerConfigChanged();

        return JSON.stringify({
            success: true,
            message: `邮箱账号 "${email}" 已删除`,
            email: removed.username,
            name: removed.name
        });
    }

    /**
     * 通知 Worker 线程配置已变更
     */
    private notifyWorkerConfigChanged() {
        const config = this.mailApp.getConfig();
        this.mailApp.callWorker('applicationConfigChanged', config).catch((err: any) => {
            logger.warn(`failed to notify mailbox worker of config change: ${err?.message ?? err}`);
        });
    }
}

// ============================================================
// SwitchMailAccount Tool
// ============================================================

const SwitchMailAccountArgsSchema = z.object({
    email: z.string().describe('要切换到的邮箱地址')
});

export class SwitchMailAccountTool extends BaseTool<typeof SwitchMailAccountArgsSchema> {
    private mailApp: MailboxApplication;

    constructor(mailApp: MailboxApplication) {
        super(
            'switchMailAccount',
            '切换当前使用的邮箱账号。切换后，后续的邮件收发操作将使用该账号。',
            SwitchMailAccountArgsSchema,
            undefined,
            { 'zh-CN': '切换邮箱账号', 'en-US': 'Switch Mail Account' }
        );
        this.mailApp = mailApp;
        this.executor = this.switchAccount.bind(this);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        return renderMailboxInlineTool({
            icon: 'fas fa-exchange-alt',
            title: '切换邮箱账号',
            status: toolcall.status,
            detail: args?.email ? args.email : undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const email = args?.['email'];
        const body: string[] = [];

        if (email) {
            body.push(chalk.dim('切换到: ') + chalk.cyan(String(email)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 切换中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ✓ ') + chalk.green(result.message));
            } catch {
                body.push(chalk.dim('  ✓ 切换成功!'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '🔄',
            title: '切换邮箱账号',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async switchAccount(args: z.output<typeof SwitchMailAccountArgsSchema>): Promise<string> {
        const email = args.email.trim();
        // 【关键】深拷贝配置，避免直接修改 Setting 内存中的引用对象
        const rawConfig = this.mailApp.getConfig();
        const config = rawConfig ? JSON.parse(JSON.stringify(rawConfig)) : { profiles: [] };
        const profiles: any[] = Array.isArray(config.profiles) ? config.profiles : [];

        // 查找目标账号（支持通过 email 或 username 查找）
        const target = profiles.find((p: any) => p.username === email || p.email === email);
        if (!target) {
            const available = profiles.map((p: any) => p.email || p.username).join(', ');
            throw new Error(
                `未找到邮箱账号 "${email}"。` +
                    (available ? `当前已配置的账号: ${available}` : '当前没有已配置的邮箱账号，请先添加账号。')
            );
        }

        // currentProfileId 存储的是 username（可能是 authUsername）
        const targetUsername = target.username;

        // 检查是否已经是当前账号
        if (config.currentProfileId === targetUsername) {
            return JSON.stringify({
                success: true,
                message: `"${email}" 已经是当前使用的邮箱账号，无需切换`,
                email,
                alreadyCurrent: true
            });
        }

        // 执行切换
        const previousEmail = config.currentProfileId;
        config.currentProfileId = targetUsername;
        this.mailApp.setConfig(config);

        // 通知 Worker 重新加载配置（切换当前账号）
        this.notifyWorkerConfigChanged();

        const targetEmail = target.email || targetUsername;
        const preset = matchPreset(targetEmail);
        return JSON.stringify({
            success: true,
            message: `已切换到邮箱账号 "${targetEmail}"` + (preset ? ` (${preset.name})` : ''),
            email: targetEmail,
            provider: preset?.name,
            previousEmail
        });
    }

    /**
     * 通知 Worker 线程配置已变更
     */
    private notifyWorkerConfigChanged() {
        const config = this.mailApp.getConfig();
        this.mailApp.callWorker('applicationConfigChanged', config).catch((err: any) => {
            logger.warn(`failed to notify mailbox worker of config change: ${err?.message ?? err}`);
        });
    }
}

// ============================================================
// 邮件操作：辅助函数 + Schema + Executor + 工具类
// 供 operate-mailbox Skill 对外暴露，也供 tui.ts 直接实例化
// ============================================================

export async function callMailWorker(method: string, ...args: any[]): Promise<any> {
    const result = await ApplicationRegistry.callWorker('mailbox', method, ...args);
    if (result?.status === 'error') throw new Error(result.message || `mailbox.${method} failed`);
    return result?.data;
}

export function formatSender(from: Array<{ name: string; address: string }> | undefined): string {
    if (!from || from.length === 0) return '未知';
    return from[0].name || from[0].address || '未知';
}

export function formatAddresses(addrs: Array<{ name: string; address: string }> | undefined): string {
    if (!addrs || addrs.length === 0) return '未知';
    return addrs.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
}

export function stripHtml(html: string): string {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<\/tr>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeRecipients(raw: any): string[] {
    if (!raw) return [];
    if (typeof raw === 'string') return [raw];
    if (Array.isArray(raw)) {
        return raw.map((item: any) => (typeof item === 'string' ? item : item.address)).filter(Boolean);
    }
    return [];
}

function mapEmailHeaders(emails: any[]) {
    return emails.map((e) => ({
        uid: e.uid,
        subject: e.subject || '(无主题)',
        from: formatSender(e.from),
        date: new Date(e.date).toISOString(),
        unread: e.unread,
        starred: e.starred,
        type: e.type
    }));
}

// ── Schema ──

const GetEmailListSchema = z.object({
    offset: z.number().optional().describe('从第几条开始，默认 0'),
    limit: z.number().optional().describe('最多返回条数，默认 20')
});

const GetEmailContentSchema = z.object({
    uid: z.string().describe('邮件唯一标识 uid，从 getEmailList 或 searchEmails 结果中获取')
});

const SearchEmailsSchema = z.object({
    subject: z.string().optional().describe('按主题关键词搜索（模糊匹配）'),
    from: z.string().optional().describe('按发件人搜索（支持姓名或邮箱地址，模糊匹配）'),
    to: z.string().optional().describe('按收件人搜索（支持姓名或邮箱地址，模糊匹配）'),
    body: z.string().optional().describe('按正文内容搜索（模糊匹配）'),
    general: z
        .string()
        .optional()
        .describe('在主题、发件人、正文中同时搜索的通用关键词（与 subject/from/body 互斥，用于简单搜索场景）'),
    dateFrom: z.string().optional().describe('搜索起始日期（含），格式 YYYY-MM-DD'),
    dateTo: z.string().optional().describe('搜索结束日期（含），格式 YYYY-MM-DD'),
    unread: z.boolean().optional().describe('筛选已读/未读状态：true=仅未读，false=仅已读，不传=不限'),
    starred: z.boolean().optional().describe('筛选收藏状态：true=仅收藏，false=仅非收藏，不传=不限'),
    attachmentName: z.string().optional().describe('按附件文件名搜索（模糊匹配）'),
    limit: z.number().optional().describe('最多返回条数，默认 50'),
    offset: z.number().optional().describe('跳过前 N 条')
});

const SendEmailSchema = z.object({
    to: z
        .union([
            z.string().describe('收件人邮箱地址'),
            z.array(z.string()).describe('多个收件人邮箱地址数组'),
            z
                .array(
                    z.object({
                        name: z.string().optional().describe('收件人姓名'),
                        address: z.string().describe('收件人邮箱地址')
                    })
                )
                .describe('收件人对象列表')
        ])
        .describe('收件人'),
    cc: z
        .union([
            z.string().describe('抄送邮箱地址'),
            z.array(z.string()).describe('多个抄送邮箱地址数组'),
            z
                .array(
                    z.object({
                        name: z.string().optional().describe('抄送收件人姓名'),
                        address: z.string().describe('抄送收件人邮箱地址')
                    })
                )
                .describe('抄送对象列表')
        ])
        .optional()
        .describe('抄送'),
    bcc: z
        .union([
            z.string().describe('密送邮箱地址'),
            z.array(z.string()).describe('多个密送邮箱地址数组'),
            z
                .array(
                    z.object({
                        name: z.string().optional().describe('密送收件人姓名'),
                        address: z.string().describe('密送收件人邮箱地址')
                    })
                )
                .describe('密送对象列表')
        ])
        .optional()
        .describe('密送'),
    subject: z.string().describe('邮件主题'),
    content: z.string().describe('邮件内容'),
    attachments: z.array(z.string()).optional().describe('附件文件路径列表，每个元素是本地文件的绝对路径')
});

const ReplyEmailSchema = z.object({
    uid: z.string().describe('要回复的邮件唯一标识 uid'),
    content: z.string().describe('回复内容'),
    replyAll: z.boolean().optional().describe('是否回复所有人，默认 false')
});

const MarkEmailReadSchema = z.object({
    uid: z.string().describe('邮件唯一标识 uid'),
    read: z.boolean().describe('是否标记为已读：true=标记为已读，false=标记为未读')
});

const StarEmailSchema = z.object({
    uid: z.string().describe('邮件 uid'),
    starred: z.boolean().describe('是否收藏：true=收藏，false=取消收藏')
});

const DeleteEmailSchema = z.object({
    uid: z.string().describe('邮件唯一标识 uid')
});

// ── 回复邮件引用格式（与 Electron 前端一致） ──

export function buildQuotedText(
    email: { from?: any; to?: any; cc?: any; date?: any; subject?: string },
    content: { textContent?: string; htmlContent?: string }
): string {
    const sender = formatAddresses(email.from);
    const sendTime = new Date(email.date).toLocaleString();
    const receivers = formatAddresses(email.to);
    const ccText = email.cc?.length > 0 ? formatAddresses(email.cc) : '';
    const subject = email.subject || '(无主题)';

    let originalBody = '';
    if (content.textContent?.trim()) originalBody = content.textContent.trim();
    else if (content.htmlContent) originalBody = stripHtml(content.htmlContent);

    const quotedBody = originalBody
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');

    const lines = [
        '---------- 原始邮件 ----------',
        `发件人: ${sender}`,
        `发送时间: ${sendTime}`,
        `收件人: ${receivers}`
    ];
    if (ccText) lines.push(`抄送: ${ccText}`);
    lines.push(`主题: ${subject}`);
    lines.push('');
    lines.push(quotedBody);
    return lines.join('\n');
}

export function buildReplyHtml(
    replyBody: string,
    email: { from?: any; to?: any; cc?: any; date?: any; subject?: string },
    content: { textContent?: string; htmlContent?: string }
): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const userHtml = esc(replyBody).replace(/\n/g, '<br>');

    const sender = formatAddresses(email.from);
    const sendTime = new Date(email.date).toLocaleString();
    const receivers = formatAddresses(email.to);
    const ccText = email.cc?.length > 0 ? formatAddresses(email.cc) : '';
    const subject = email.subject || '(无主题)';

    const originContent = content.htmlContent
        ? content.htmlContent
        : esc(content.textContent || '').replace(/\n/g, '<br>');

    return `<div>${userHtml}</div>
<br><br>
<hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 20px 0;">
<div style="background-color: #f3f4f6; padding: 16px; border-radius: 8px; font-size: 13px; color: #374151; margin-bottom: 20px;">
  <div style="font-weight: bold; font-size: 14px; margin-bottom: 12px; color: #111827; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;">
    ----- 原始邮件 -----
  </div>
  <div style="margin-bottom: 6px;"><span style="color: #6b7280; font-weight: bold;">发件人:</span> ${esc(sender)}</div>
  <div style="margin-bottom: 6px;"><span style="color: #6b7280; font-weight: bold;">发送时间:</span> ${esc(sendTime)}</div>
  <div style="margin-bottom: 6px;"><span style="color: #6b7280; font-weight: bold;">收件人:</span> ${esc(receivers)}</div>
  ${ccText ? `<div style="margin-bottom: 6px;"><span style="color: #6b7280; font-weight: bold;">抄送:</span> ${esc(ccText)}</div>` : ''}
  <div><span style="color: #6b7280; font-weight: bold;">主题:</span> ${esc(subject)}</div>
</div>
<div style="font-size: 14px; line-height: 1.6;">${originContent}</div>`;
}

// ── 工具类 ──

export class GetEmailListTool extends BaseTool<typeof GetEmailListSchema> {
    constructor() {
        super(
            'getEmailList',
            '获取当前邮箱的邮件列表，返回 uid、主题、发件人、日期、已读状态等。',
            GetEmailListSchema,
            undefined,
            { 'zh-CN': '邮件列表', 'en-US': 'Email List' }
        );
        this.setExecutor(async (args) => {
            const data = await callMailWorker('getEmailHeaderList', args.offset ?? 0, args.limit ?? 20);
            const emails: any[] = Array.isArray(data) ? data : [];
            if (emails.length === 0) return JSON.stringify({ total: 0, emails: [], message: '暂无邮件' });
            return JSON.stringify({ total: emails.length, emails: mapEmailHeaders(emails) });
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        const detailParts: string[] = [];
        if (args?.limit) detailParts.push(`最多 ${args.limit} 封`);
        if (toolcall.status === 'success' && toolcall.result) {
            const r = parseMailboxResult(toolcall.result);
            detailParts.push(`${r.total ?? 0} 封邮件`);
        }
        return renderMailboxInlineTool({
            icon: 'fas fa-inbox',
            title: '获取邮件列表',
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, _width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const lines: string[] = [];
        if (args?.limit) lines.push(chalk.dim('数量: ') + chalk.cyan(String(args.limit)));
        if (toolcall.status === 'running') lines.push(chalk.dim('  ⏳ 正在获取邮件列表…'));
        else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const r = JSON.parse(toolcall.result);
                lines.push(chalk.dim(`  ✓ 共 ${r.total ?? 0} 封邮件`));
            } catch {
                lines.push(chalk.dim('  ✓ 已获取邮件列表'));
            }
        } else if (toolcall.status === 'error') lines.push(chalk.red(String(toolcall.result || '获取失败')));
        return lines.length > 0 ? lines : undefined;
    }
}

export class GetEmailContentTool extends BaseTool<typeof GetEmailContentSchema> {
    constructor() {
        super(
            'getEmailContent',
            '获取指定 uid 邮件的完整正文（纯文本），用于查看详情或摘要。',
            GetEmailContentSchema,
            undefined,
            { 'zh-CN': '邮件内容', 'en-US': 'Email Content' }
        );
        this.setExecutor(async (args) => {
            const content = await callMailWorker('getEmailContent', args.uid);
            if (!content) return JSON.stringify({ error: '未找到该邮件' });
            const text = content.textContent?.trim() || stripHtml(content.htmlContent || '');
            return JSON.stringify({
                uid: args.uid,
                textContent: text.slice(0, 5000),
                fullLength: text.length
            });
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        const uid = args?.uid || '';
        return renderMailboxInlineTool({
            icon: 'fas fa-envelope-open-text',
            title: '获取邮件内容',
            status: toolcall.status,
            detail: uid ? `邮件 ID: ${uid}` : undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, _width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const lines: string[] = [];
        if (args?.uid) lines.push(chalk.dim('邮件 ID: ') + chalk.cyan(String(args.uid)));
        if (toolcall.status === 'running') lines.push(chalk.dim('  ⏳ 正在获取邮件内容…'));
        else if (toolcall.status === 'success') lines.push(chalk.dim('  ✓ 已获取邮件内容'));
        else if (toolcall.status === 'error') lines.push(chalk.red(String(toolcall.result || '获取失败')));
        return lines.length > 0 ? lines : undefined;
    }
}

export class SearchEmailsTool extends BaseTool<typeof SearchEmailsSchema> {
    constructor() {
        super(
            'searchEmails',
            '按条件搜索邮件，支持主题/发件人/收件人/正文/日期/已读/收藏/附件名等组合搜索。',
            SearchEmailsSchema,
            undefined,
            { 'zh-CN': '搜索邮件', 'en-US': 'Search Emails' }
        );

        this.setExecutor(async (args) => {
            const q: any = { limit: args.limit ?? 50, offset: args.offset ?? 0 };
            if (args.subject) q.subject = args.subject;
            if (args.from) q.from = args.from;
            if (args.to) q.to = args.to;
            if (args.body) q.body = args.body;
            if (args.general) q.general = args.general;
            if (args.dateFrom) q.startDate = args.dateFrom;
            if (args.dateTo) q.endDate = args.dateTo;
            if (args.unread !== undefined) q.unread = args.unread;
            if (args.starred !== undefined) q.starred = args.starred;
            if (args.attachmentName) q.attachmentName = args.attachmentName;
            const data = await callMailWorker('searchEmails', q);
            const emails: any[] = Array.isArray(data) ? data : [];
            return JSON.stringify({ total: emails.length, emails: mapEmailHeaders(emails) });
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        const query = args?.subject || args?.general || args?.from || '';
        const detailParts: string[] = [];
        if (query) detailParts.push(`"${String(query)}"`);
        if (toolcall.status === 'success' && toolcall.result) {
            const r = parseMailboxResult(toolcall.result);
            if (r.total !== undefined) detailParts.push(`${r.total} 条结果`);
        }
        return renderMailboxInlineTool({
            icon: 'fas fa-search',
            title: '搜索邮件',
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, _width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const query = args?.subject || args?.general || args?.from || '';
        const lines: string[] = [];
        if (query) lines.push(chalk.dim('搜索: ') + chalk.cyan(String(query)));
        if (toolcall.status === 'running') lines.push(chalk.dim('  ⏳ 正在搜索邮件…'));
        else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const r = JSON.parse(toolcall.result);
                lines.push(chalk.dim(`  ✓ 共 ${r.total ?? 0} 条结果`));
            } catch {
                lines.push(chalk.dim('  ✓ 搜索完成'));
            }
        } else if (toolcall.status === 'error') lines.push(chalk.red(String(toolcall.result || '搜索失败')));
        return lines.length > 0 ? lines : undefined;
    }
}

export class SendEmailTool extends BaseTool<typeof SendEmailSchema> {
    constructor() {
        super('sendEmail', '发送邮件，需提供收件人、主题和内容，可选抄送、密送和附件。', SendEmailSchema, undefined, {
            'zh-CN': '发送邮件',
            'en-US': 'Send Email'
        });
        this.setExecutor(async (args) => {
            try {
                const to = normalizeRecipients(args.to);
                const cc = normalizeRecipients(args.cc);
                const bcc = normalizeRecipients(args.bcc);
                const attachments: Array<{ filename: string; path: string }> = [];
                if (args.attachments?.length) {
                    for (const fp of args.attachments) {
                        const resolved = nodePath.resolve(fp);
                        if (!fs.existsSync(resolved))
                            return JSON.stringify({
                                success: false,
                                error: `附件文件不存在: ${fp}`
                            });
                        attachments.push({ filename: nodePath.basename(resolved), path: resolved });
                    }
                }
                const result = await callMailWorker('sendEmail', {
                    to,
                    cc: cc.length > 0 ? cc : undefined,
                    bcc: bcc.length > 0 ? bcc : undefined,
                    subject: args.subject,
                    text: args.content,
                    html: args.content.replace(/\n/g, '<br>'),
                    attachments
                });
                return JSON.stringify({ success: true, message: '邮件发送成功', data: result });
            } catch (error: any) {
                return JSON.stringify({ success: false, error: error.message || '邮件发送失败' });
            }
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        const detailParts: string[] = [];
        const recipients = [args?.to, args?.cc].filter(Boolean).join(', ');
        if (recipients) detailParts.push(`收件人: ${recipients}`);
        if (args?.subject) detailParts.push(`主题: ${args.subject}`);
        if (toolcall.status === 'success') {
            const r = parseMailboxResult(toolcall.result);
            detailParts.push(r.success ? '发送成功' : '发送失败');
        }
        return renderMailboxInlineTool({
            icon: 'fas fa-paper-plane',
            title: '发送邮件',
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, _width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const lines: string[] = [];
        const recipients = [args?.to, args?.cc].filter(Boolean).join(', ');
        if (recipients) lines.push(chalk.dim('收件人: ') + chalk.cyan(recipients));
        if (args?.subject) lines.push(chalk.dim('主题: ') + chalk.cyan(args.subject));
        if (toolcall.status === 'running') lines.push(chalk.dim('  ⏳ 正在发送邮件…'));
        else if (toolcall.status === 'success') lines.push(chalk.green('  ✓ 邮件已发送'));
        else if (toolcall.status === 'error') lines.push(chalk.red(String(toolcall.result || '发送失败')));
        return lines.length > 0 ? lines : undefined;
    }
}

export class ReplyEmailTool extends BaseTool<typeof ReplyEmailSchema> {
    constructor() {
        super('replyEmail', '回复邮件，需提供原邮件 uid 和回复内容。', ReplyEmailSchema, undefined, {
            'zh-CN': '回复邮件',
            'en-US': 'Reply Email'
        });
        this.setExecutor(async (args) => {
            try {
                const emailMeta = await callMailWorker('getEmailMeta', args.uid);
                if (!emailMeta) return JSON.stringify({ success: false, error: '未找到该邮件' });
                const emailContent = await callMailWorker('getEmailContent', args.uid);

                const to = [...normalizeRecipients(emailMeta.from)];
                const cc: string[] = [];
                if (args.replyAll) {
                    const seen = new Set(to);
                    for (const addr of normalizeRecipients(emailMeta.to)) {
                        if (!seen.has(addr)) {
                            to.push(addr);
                            seen.add(addr);
                        }
                    }
                    for (const addr of normalizeRecipients(emailMeta.cc)) {
                        if (!seen.has(addr)) {
                            cc.push(addr);
                            seen.add(addr);
                        }
                    }
                }

                const originalSubject = emailMeta.subject || '';
                const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;
                const quotedText = buildQuotedText(emailMeta, emailContent || {});
                const fullText = args.content + '\n\n' + quotedText;
                const html = buildReplyHtml(args.content, emailMeta, emailContent || {});

                const result = await callMailWorker('sendEmail', {
                    to,
                    cc: cc.length > 0 ? cc : undefined,
                    subject,
                    text: fullText,
                    html,
                    attachments: []
                });
                return JSON.stringify({ success: true, message: '邮件回复成功', data: result });
            } catch (error: any) {
                return JSON.stringify({ success: false, error: error.message || '邮件回复失败' });
            }
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        const detailParts: string[] = [];
        if (args?.uid) detailParts.push(`原邮件 ID: ${args.uid}`);
        if (args?.replyAll) detailParts.push('回复所有人');
        if (toolcall.status === 'success') {
            const r = parseMailboxResult(toolcall.result);
            detailParts.push(r.success ? '回复成功' : '回复失败');
        }
        return renderMailboxInlineTool({
            icon: 'fas fa-reply',
            title: '回复邮件',
            status: toolcall.status,
            detail: detailParts.join(' · ') || undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, _width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const lines: string[] = [];
        if (args?.uid) lines.push(chalk.dim('原邮件 ID: ') + chalk.cyan(String(args.uid)));
        if (args?.replyAll) lines.push(chalk.dim('  回复所有人'));
        if (toolcall.status === 'running') lines.push(chalk.dim('  ⏳ 正在回复邮件…'));
        else if (toolcall.status === 'success') lines.push(chalk.green('  ✓ 邮件已回复'));
        else if (toolcall.status === 'error') lines.push(chalk.red(String(toolcall.result || '回复失败')));
        return lines.length > 0 ? lines : undefined;
    }
}

export class MarkEmailReadTool extends BaseTool<typeof MarkEmailReadSchema> {
    constructor() {
        super('markEmailReadStatus', '标记邮件已读/未读。', MarkEmailReadSchema, undefined, {
            'zh-CN': '标记已读',
            'en-US': 'Mark Read'
        });
        this.setExecutor(async (args) => {
            try {
                if (args.read) await callMailWorker('markEmailAsRead', args.uid);
                else await callMailWorker('markEmailAsUnread', args.uid);
                return JSON.stringify({
                    success: true,
                    message: `邮件已${args.read ? '标记为已读' : '标记为未读'}`
                });
            } catch (error: any) {
                return JSON.stringify({
                    success: false,
                    error: error.message || '标记邮件状态失败'
                });
            }
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        const status = args?.read === false ? '标记为未读' : '标记为已读';
        return renderMailboxInlineTool({
            icon: 'fas fa-envelope-open',
            title: '标记邮件状态',
            status: toolcall.status,
            detail: args?.uid ? `邮件 ID: ${args.uid} · ${status}` : undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, _width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const status = args?.read === false ? '标记为未读' : '标记为已读';
        const lines: string[] = [];
        if (args?.uid) lines.push(chalk.dim('邮件 ID: ') + chalk.cyan(String(args.uid)));
        if (toolcall.status === 'running') lines.push(chalk.dim(`  ⏳ 正在${status}…`));
        else if (toolcall.status === 'success') lines.push(chalk.green(`  ✓ 已${status}`));
        else if (toolcall.status === 'error') lines.push(chalk.red(String(toolcall.result || '操作失败')));
        return lines.length > 0 ? lines : undefined;
    }
}

export class StarEmailTool extends BaseTool<typeof StarEmailSchema> {
    constructor() {
        super('starEmail', '收藏或取消收藏邮件。', StarEmailSchema, undefined, {
            'zh-CN': '收藏邮件',
            'en-US': 'Star Email'
        });
        this.setExecutor(async (args) => {
            try {
                await callMailWorker('starEmail', { uid: args.uid, starred: args.starred });
                return JSON.stringify({
                    success: true,
                    message: `邮件已${args.starred ? '收藏' : '取消收藏'}`
                });
            } catch (error: any) {
                return JSON.stringify({
                    success: false,
                    error: error.message || '操作邮件收藏状态失败'
                });
            }
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        const action = args?.starred === false ? '取消收藏' : '收藏';
        return renderMailboxInlineTool({
            icon: 'fas fa-star',
            title: '收藏邮件',
            status: toolcall.status,
            detail: args?.uid ? `邮件 ID: ${args.uid} · ${action}` : undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, _width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const action = args?.starred === false ? '取消收藏' : '收藏';
        const lines: string[] = [];
        if (args?.uid) lines.push(chalk.dim('邮件 ID: ') + chalk.cyan(String(args.uid)));
        if (toolcall.status === 'running') lines.push(chalk.dim(`  ⏳ 正在${action}…`));
        else if (toolcall.status === 'success') lines.push(chalk.green(`  ✓ 已${action}`));
        else if (toolcall.status === 'error') lines.push(chalk.red(String(toolcall.result || '操作失败')));
        return lines.length > 0 ? lines : undefined;
    }
}

export class DeleteEmailTool extends BaseTool<typeof DeleteEmailSchema> {
    constructor() {
        super('deleteEmail', '删除指定邮件。', DeleteEmailSchema, undefined, {
            'zh-CN': '删除邮件',
            'en-US': 'Delete Email'
        });
        this.setExecutor(async (args) => {
            try {
                await callMailWorker('deleteEmail', args.uid);
                return JSON.stringify({ success: true, message: '邮件删除成功' });
            } catch (error: any) {
                return JSON.stringify({ success: false, error: error.message || '删除邮件失败' });
            }
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        return renderMailboxInlineTool({
            icon: 'fas fa-trash',
            title: '删除邮件',
            status: toolcall.status,
            detail: args?.uid ? `邮件 ID: ${args.uid}` : undefined
        });
    }

    renderToolCallCli(toolcall: ToolCall, _width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const lines: string[] = [];
        if (args?.uid) lines.push(chalk.dim('邮件 ID: ') + chalk.cyan(String(args.uid)));
        if (toolcall.status === 'running') lines.push(chalk.dim('  ⏳ 正在删除邮件…'));
        else if (toolcall.status === 'success') lines.push(chalk.green('  ✓ 邮件已删除'));
        else if (toolcall.status === 'error') lines.push(chalk.red(String(toolcall.result || '删除失败')));
        return lines.length > 0 ? lines : undefined;
    }
}

// ============================================================
// 邮件同步状态查询
// ============================================================

const GetMailSyncStatusSchema = z.object({});

export class GetMailSyncStatusTool extends BaseTool<typeof GetMailSyncStatusSchema> {
    constructor() {
        super(
            'getMailSyncStatus',
            '查询邮件同步状态。在配置邮箱账号后，用于检查同步是否完成、当前正在同步哪个账号、上次同步时间及结果。',
            GetMailSyncStatusSchema,
            undefined,
            { 'zh-CN': '同步状态', 'en-US': 'Sync Status' }
        );
        this.setExecutor(async () => {
            const status = await callMailWorker('getSyncStatus');
            if (!status) return JSON.stringify({ error: '无法获取同步状态' });

            const accountSummaries = (status.accounts || []).map((acc: any) => {
                const result = acc.lastSyncResult;
                if (!result) return `${acc.email} (${acc.protocol || 'unknown'}): 未同步`;
                if (result.status === 'success')
                    return `${acc.email} (${acc.protocol}): 同步成功，新增 ${result.newEmailCount} 封`;
                return `${acc.email} (${acc.protocol}): 同步失败 - ${result.error}`;
            });

            return JSON.stringify({
                isSyncing: status.isSyncing,
                currentSyncingAccount: status.currentSyncingAccount || null,
                syncStartTime: status.syncStartTime || null,
                lastSyncTime: status.lastSyncTime || null,
                accounts: status.accounts || [],
                summary: status.isSyncing
                    ? `正在同步中（当前: ${status.currentSyncingAccount || '未知'}）`
                    : status.lastSyncTime
                      ? `同步已完成，上次同步时间: ${new Date(status.lastSyncTime).toLocaleString()}`
                      : '尚未进行同步',
                accountSummaries
            });
        });
    }
}

// ============================================================
// 跨应用联动工具：日历 & 时间
// ============================================================

const GetCalendarItemsSchema = z.object({
    dateString: z.string().describe('日期字符串，格式为 YYYY-MM-DD。例如 "2026-03-05"')
});
export class GetCalendarItemsTool extends BaseTool<typeof GetCalendarItemsSchema> {
    constructor() {
        super(
            'getCalendarItems',
            '获取指定日期的日程/会议列表。当用户想查看某天的安排、检查时间冲突，或需要将邮件中的会议信息与日历比对时使用。',
            GetCalendarItemsSchema,
            undefined,
            { 'zh-CN': '日程列表', 'en-US': 'Calendar Items' }
        );
        this.setExecutor(async (args) => {
            const result = await ApplicationRegistry.callWorker('calendar', 'getCalendarItems', args.dateString);
            if (result?.status !== 'ok')
                return JSON.stringify({ error: `无法获取日程: ${result?.message || '未知错误'}` });
            const items = result.data || [];
            if (items.length === 0)
                return JSON.stringify({
                    total: 0,
                    items: [],
                    message: `${args.dateString} 暂无日程安排`
                });
            const mapped = items.map((item: any) => ({
                uid: item.uid,
                subject: item.subject,
                startTime: new Date(item.startTime).toLocaleString(),
                endTime: new Date(item.endTime).toLocaleString(),
                location: item.location || ''
            }));
            return JSON.stringify({ total: mapped.length, items: mapped });
        });
    }
}

const AddCalendarItemSchema = z.object({
    subject: z.string().describe('日程标题'),
    dateString: z.string().describe('日期，格式为 YYYY-MM-DD'),
    startTime: z.string().describe('开始时间，格式为 HH:MM（24小时制）'),
    endTime: z.string().describe('结束时间，格式为 HH:MM（24小时制）'),
    location: z.string().optional().describe('地点（可选）'),
    isAllDay: z.boolean().optional().default(false).describe('是否为全天事件')
});
export class AddCalendarItemTool extends BaseTool<typeof AddCalendarItemSchema> {
    constructor() {
        super(
            'addCalendarItem',
            '添加新日程/会议。当用户要求根据邮件内容创建日程、安排会议、或设置提醒时使用。',
            AddCalendarItemSchema,
            undefined,
            { 'zh-CN': '添加日程', 'en-US': 'Add Calendar Item' }
        );
        this.setExecutor(async (args) => {
            const { subject, dateString, startTime, endTime, location, isAllDay } = args;
            const dateParts = dateString.replace(/-/g, '/');
            let startTs: number, endTs: number;
            if (isAllDay) {
                startTs = new Date(dateParts).getTime();
                endTs = startTs + 86400000;
            } else {
                startTs = new Date(`${dateParts} ${startTime}`).getTime();
                endTs = new Date(`${dateParts} ${endTime}`).getTime();
            }
            if (isNaN(startTs) || isNaN(endTs))
                return JSON.stringify({ error: '日期或时间格式无效，请使用 YYYY-MM-DD 和 HH:MM' });
            if (endTs <= startTs) return JSON.stringify({ error: '结束时间必须晚于开始时间' });

            try {
                const existing = await ApplicationRegistry.callWorker('calendar', 'getCalendarItems', dateString);
                if (existing?.status === 'ok' && Array.isArray(existing.data)) {
                    const subjectLower = subject.trim().toLowerCase();
                    const dup = existing.data.find((item: any) => {
                        const iSubj = (item.subject || '').trim().toLowerCase();
                        const iStart = new Date(item.startTime).getTime();
                        if (iSubj === subjectLower && iStart === startTs) return true;
                        const iEnd = new Date(item.endTime).getTime();
                        return (
                            (iSubj.includes(subjectLower) || subjectLower.includes(iSubj)) &&
                            startTs < iEnd &&
                            endTs > iStart
                        );
                    });
                    if (dup)
                        return JSON.stringify({
                            skipped: true,
                            reason: '已存在相同或相似的日程，无需重复添加',
                            existing: {
                                uid: dup.uid,
                                subject: dup.subject,
                                startTime: new Date(dup.startTime).toLocaleString(),
                                endTime: new Date(dup.endTime).toLocaleString()
                            }
                        });
                }
            } catch {
                /* 去重检查失败不阻塞 */
            }

            const result = await ApplicationRegistry.callWorker('calendar', 'addCalendarItem', {
                subject,
                startTime: startTs,
                endTime: endTs,
                location: location || '',
                isAllDay
            });
            if (result?.status !== 'ok')
                return JSON.stringify({ error: `添加日程失败: ${result?.message || '未知错误'}` });
            const item = result.data ?? result;
            return JSON.stringify({
                success: true,
                uid: item.uid,
                subject,
                dateString,
                startTime,
                endTime
            });
        });
    }
}

const DeleteCalendarItemSchema = z.object({
    uid: z.string().describe('要删除的日程项的唯一标识符（uid），可通过 getCalendarItems 获取')
});
export class DeleteCalendarItemTool extends BaseTool<typeof DeleteCalendarItemSchema> {
    constructor() {
        super(
            'deleteCalendarItem',
            '删除指定的日程项。当用户要求取消某个日程、会议时使用。',
            DeleteCalendarItemSchema,
            undefined,
            { 'zh-CN': '删除日程', 'en-US': 'Delete Calendar Item' }
        );
        this.setExecutor(async (args) => {
            const result = await ApplicationRegistry.callWorker('calendar', 'deleteCalendarItem', args.uid);
            if (result?.status !== 'ok')
                return JSON.stringify({ error: `删除日程失败: ${result?.message || '未知错误'}` });
            const data = result.data ?? result;
            return JSON.stringify({ success: true, uid: args.uid, ...data });
        });
    }
}

const GetCurrentTimeSchema = z.object({});
export class GetCurrentTimeTool extends BaseTool<typeof GetCurrentTimeSchema> {
    constructor() {
        super(
            'getCurrentTime',
            '获取当前精确的日期和时间。在需要知道"今天"、"明天"等相对日期时使用。',
            GetCurrentTimeSchema,
            undefined,
            { 'zh-CN': '当前时间', 'en-US': 'Current Time' }
        );
        this.setExecutor(async () => {
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            return JSON.stringify({
                date: dateStr,
                time: timeStr,
                datetime: now.toLocaleString(),
                dayOfWeek: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]
            });
        });
    }
}
