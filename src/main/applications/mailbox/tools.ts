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
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';
import { z } from 'zod';
import type { MailboxApplication } from './app';


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
        smtp: { host: 'smtp.qq.com', port: 465, tls: true },
    },
    {
        name: '163邮箱',
        domains: ['163.com'],
        imap: { host: 'imap.163.com', port: 993, tls: true },
        pop3: { host: 'pop.163.com', port: 995, tls: true },
        smtp: { host: 'smtp.163.com', port: 465, tls: true },
    },
    {
        name: '126邮箱',
        domains: ['126.com'],
        imap: { host: 'imap.126.com', port: 993, tls: true },
        pop3: { host: 'pop.126.com', port: 995, tls: true },
        smtp: { host: 'smtp.126.com', port: 465, tls: true },
    },
    {
        name: 'yeah.net邮箱',
        domains: ['yeah.net'],
        imap: { host: 'imap.yeah.net', port: 993, tls: true },
        pop3: { host: 'pop.yeah.net', port: 995, tls: true },
        smtp: { host: 'smtp.yeah.net', port: 465, tls: true },
    },
    {
        name: 'Outlook',
        domains: ['outlook.com', 'hotmail.com', 'live.com', 'live.cn'],
        imap: { host: 'outlook.office365.com', port: 993, tls: true },
        pop3: { host: 'outlook.office365.com', port: 995, tls: true },
        smtp: { host: 'smtp.office365.com', port: 587, tls: true },
    },
    {
        name: 'Gmail',
        domains: ['gmail.com', 'googlemail.com'],
        imap: { host: 'imap.gmail.com', port: 993, tls: true },
        pop3: { host: 'pop.gmail.com', port: 995, tls: true },
        smtp: { host: 'smtp.gmail.com', port: 465, tls: true },
    },
    {
        name: '139邮箱',
        domains: ['139.com'],
        imap: { host: 'imap.139.com', port: 993, tls: true },
        pop3: { host: 'pop.139.com', port: 995, tls: true },
        smtp: { host: 'smtp.139.com', port: 465, tls: true },
    },
    {
        name: '新浪邮箱',
        domains: ['sina.com', 'sina.cn'],
        imap: { host: 'imap.sina.com', port: 993, tls: true },
        pop3: { host: 'pop.sina.com', port: 995, tls: true },
        smtp: { host: 'smtp.sina.com', port: 465, tls: true },
    },
    {
        name: '搜狐邮箱',
        domains: ['sohu.com'],
        imap: { host: 'imap.sohu.com', port: 993, tls: true },
        pop3: { host: 'pop3.sohu.com', port: 995, tls: true },
        smtp: { host: 'smtp.sohu.com', port: 465, tls: true },
    },
    {
        name: '阿里邮箱',
        domains: ['aliyun.com'],
        imap: { host: 'imap.aliyun.com', port: 993, tls: true },
        pop3: { host: 'pop3.aliyun.com', port: 995, tls: true },
        smtp: { host: 'smtp.aliyun.com', port: 465, tls: true },
    },
    {
        name: '华为邮箱',
        domains: ['huawei.com'],
        imap: { host: 'imap.huawei.com', port: 993, tls: true },
        pop3: { host: 'popscn.huawei.com', port: 110, tls: false },
        smtp: { host: 'smtpscn.huawei.com', port: 25, tls: false },
        requireAuthUsername: true,
        authUsernameHint: '华为邮箱收信需要使用单独的用户名（格式：姓名首字母 + 8位工号，例如 z00123456），请向用户询问',
    },
];

/**
 * 根据邮箱地址的域名匹配预设服务商
 */
function matchPreset(email: string): MailProviderPreset | undefined {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return undefined;
    return MAIL_PROVIDER_PRESETS.find(p => p.domains.includes(domain));
}


// ============================================================
// AddMailAccount Tool
// ============================================================

const AddMailAccountArgsSchema = z.object({
    email: z.string().describe('邮箱地址，例如 "user@qq.com"'),
    password: z.string().min(1, '密码/授权码不能为空，必须向用户询问后才能调用此工具').describe('邮箱密码或授权码（必填，不能为空）'),
    protocol: z.enum(['imap', 'pop3']).describe('收信协议，imap 或 pop3，需要询问用户选择'),
    name: z.string().optional().describe('账号显示名称（可选）。如不确定可不填，默认使用邮箱地址'),
    authUsername: z.string().optional().describe('收信认证用户名（可选）。某些邮箱服务商（如华为邮箱）要求使用与邮箱地址不同的用户名进行 IMAP/POP3 认证。华为邮箱格式为：姓名首字母+8位工号（如 zhangsan00123456）。如果服务商不要求则不需要填写。'),
    // ── 自定义服务器配置（仅当邮箱不在预设服务商列表中时需要提供） ──
    imapHost: z.string().optional().describe('IMAP 服务器地址（当邮箱不在预设服务商列表中且收信协议选择 imap 时必填）'),
    imapPort: z.number().optional().describe('IMAP 服务器端口（可选，默认: TLS开启时993，关闭时143）'),
    imapTls: z.boolean().optional().describe('IMAP 是否启用 TLS（可选，默认 true）'),
    pop3Host: z.string().optional().describe('POP3 服务器地址（当邮箱不在预设服务商列表中且收信协议选择 pop3 时必填）'),
    pop3Port: z.number().optional().describe('POP3 服务器端口（可选，默认: TLS开启时995，关闭时110）'),
    pop3Tls: z.boolean().optional().describe('POP3 是否启用 TLS（可选，默认 true）'),
    smtpHost: z.string().optional().describe('SMTP 发信服务器地址（当邮箱不在预设服务商列表中时必填）'),
    smtpPort: z.number().optional().describe('SMTP 发信服务器端口（可选，默认: TLS开启时465，关闭时25）'),
    smtpTls: z.boolean().optional().describe('SMTP 是否启用 TLS（可选，默认 true）'),
});

export class AddMailAccountTool extends BaseTool<typeof AddMailAccountArgsSchema> {
    private mailApp: MailboxApplication;

    constructor(mailApp: MailboxApplication) {
        super(
            'addMailAccount',
            '添加邮箱账号。内置常见邮箱服务商（QQ、163、126、Outlook、Gmail等）的服务器预设，只需提供邮箱地址、密码/授权码和收信协议（imap或pop3）即可完成配置。对于不在预设列表中的邮箱（如企业邮箱、自建邮箱），需要额外提供收信服务器地址（imapHost/pop3Host）和SMTP发信服务器地址（smtpHost），端口和TLS可选（有合理默认值）。',
            AddMailAccountArgsSchema,
        );
        this.mailApp = mailApp;
        this.executor = this.addAccount.bind(this);
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
                body.push(chalk.dim('IMAP: ') + chalk.white(`${args['imapHost']}:${args['imapPort'] ?? (args['imapTls'] !== false ? 993 : 143)}`) + chalk.dim(args['imapTls'] !== false ? ' (TLS)' : ''));
            }
            if (protocol === 'pop3' && args?.['pop3Host']) {
                body.push(chalk.dim('POP3: ') + chalk.white(`${args['pop3Host']}:${args['pop3Port'] ?? (args['pop3Tls'] !== false ? 995 : 110)}`) + chalk.dim(args['pop3Tls'] !== false ? ' (TLS)' : ''));
            }
            if (args?.['smtpHost']) {
                body.push(chalk.dim('SMTP: ') + chalk.white(`${args['smtpHost']}:${args['smtpPort'] ?? (args['smtpTls'] !== false ? 465 : 25)}`) + chalk.dim(args['smtpTls'] !== false ? ' (TLS)' : ''));
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

        return new Card({ icon: '📧', title: '添加邮箱账号', status: statusDisplay(toolcall.status), body }).render(width);
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
                tls: imapTls,
            };
            pop3Config = {
                host: args.pop3Host ?? '',
                port: args.pop3Port ?? (pop3Tls ? 995 : 110),
                tls: pop3Tls,
            };
            smtpConfig = {
                host: args.smtpHost,
                port: args.smtpPort ?? (smtpTls ? 465 : 25),
                tls: smtpTls,
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
                alreadyExists: true,
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
                    port: imapConfig.port,
                },
                pop3: {
                    host: pop3Config.host,
                    tls: pop3Config.tls,
                    port: pop3Config.port,
                },
            },
            outbox: {
                smtp: {
                    account: email,
                    host: smtpConfig.host,
                    tls: smtpConfig.tls,
                    port: smtpConfig.port,
                },
            },
        };

        // 保存配置
        profiles.push(newProfile);
        config.profiles = profiles;
        if (!config.currentProfileId) {
            config.currentProfileId = username;
        }
        this.mailApp.setConfig(config);

        // 通知 Worker 重新加载配置并自动触发邮件同步
        this.notifyWorkerConfigChanged();

        // 构建结果描述
        const serverInfo = preset
            ? ''
            : ` [${protocol === 'imap' ? imapConfig.host : pop3Config.host}:${protocol === 'imap' ? imapConfig.port : pop3Config.port}, SMTP: ${smtpConfig.host}:${smtpConfig.port}]`;
        const authInfo = authUsername ? `, 认证用户名: ${authUsername}` : '';

        return JSON.stringify({
            success: true,
            message: `邮箱账号 "${email}" (${providerName}, ${protocol.toUpperCase()}${authInfo})${serverInfo} 配置成功，正在后台同步邮件…`,
            email,
            provider: providerName,
            protocol,
            displayName,
            authUsername: authUsername || undefined,
            isCustom: !preset,
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
        super(
            'listMailAccounts',
            '列出当前已配置的所有邮箱账号',
            ListMailAccountsArgsSchema,
        );
        this.mailApp = mailApp;
        this.executor = this.listAccounts.bind(this);
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
                        const protocol = account.protocol ? chalk.blue(` [${String(account.protocol).toUpperCase()}]`) : '';
                        body.push(`    📧 ${chalk.cyan(String(account.email))}${provider}${protocol}${isCurrent}`);
                    }
                }
            } catch {
                body.push(chalk.dim('  ✓ 已获取邮箱账号列表'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({ icon: '📋', title: '邮箱账号列表', status: statusDisplay(toolcall.status), body }).render(width);
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
                hasAuthUsername: p.username !== emailAddr ? p.username : undefined,
            };
        });

        return JSON.stringify({
            accounts,
            total: accounts.length,
        });
    }
}


// ============================================================
// RemoveMailAccount Tool
// ============================================================

const RemoveMailAccountArgsSchema = z.object({
    email: z.string().describe('要删除的邮箱地址'),
});

export class RemoveMailAccountTool extends BaseTool<typeof RemoveMailAccountArgsSchema> {
    private mailApp: MailboxApplication;

    constructor(mailApp: MailboxApplication) {
        super(
            'removeMailAccount',
            '删除已配置的邮箱账号',
            RemoveMailAccountArgsSchema,
        );
        this.mailApp = mailApp;
        this.executor = this.removeAccount.bind(this);
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

        return new Card({ icon: '🗑️', title: '删除邮箱账号', status: statusDisplay(toolcall.status), body }).render(width);
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
            name: removed.name,
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
    email: z.string().describe('要切换到的邮箱地址'),
});

export class SwitchMailAccountTool extends BaseTool<typeof SwitchMailAccountArgsSchema> {
    private mailApp: MailboxApplication;

    constructor(mailApp: MailboxApplication) {
        super(
            'switchMailAccount',
            '切换当前使用的邮箱账号。切换后，后续的邮件收发操作将使用该账号。',
            SwitchMailAccountArgsSchema,
        );
        this.mailApp = mailApp;
        this.executor = this.switchAccount.bind(this);
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

        return new Card({ icon: '🔄', title: '切换邮箱账号', status: statusDisplay(toolcall.status), body }).render(width);
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
                alreadyCurrent: true,
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
            previousEmail,
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
