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
    name: z.string().optional().describe('账号显示名称（可选）。某些邮箱服务商收信时可能需要用户名，如不确定可不填，默认使用邮箱地址'),
});

export class AddMailAccountTool extends BaseTool<typeof AddMailAccountArgsSchema> {
    private mailApp: MailboxApplication;

    constructor(mailApp: MailboxApplication) {
        super(
            'addMailAccount',
            '添加邮箱账号。内置常见邮箱服务商（QQ、163、126、Outlook、Gmail等）的服务器预设，只需提供邮箱地址、密码/授权码和收信协议（imap或pop3）即可完成配置。',
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
            }
        }
        if (protocol) {
            body.push(chalk.dim('收信协议: ') + chalk.blue(String(protocol).toUpperCase()));
        }
        if (args?.['name']) {
            body.push(chalk.dim('显示名称: ') + chalk.white(String(args['name'])));
        }
        if (args?.['password']) {
            body.push(chalk.dim('密码: ') + chalk.yellow('******'));
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
        if (!preset) {
            const domain = email.split('@')[1];
            throw new Error(
                `无法识别邮箱服务商 "${domain}"。当前支持的邮箱服务商: ` +
                MAIL_PROVIDER_PRESETS.map(p => p.domains.join('/')).join(', ') +
                '。如果你使用的是企业邮箱或其他服务商，暂时无法通过此工具自动配置。'
            );
        }

        // 【关键】深拷贝配置，避免直接修改 Setting 内存中的引用对象
        const rawConfig = this.mailApp.getConfig();
        const config = rawConfig ? JSON.parse(JSON.stringify(rawConfig)) : { profiles: [] };
        const profiles: any[] = Array.isArray(config.profiles) ? config.profiles : [];
        const existing = profiles.find((p: any) => p.username === email);
        if (existing) {
            return JSON.stringify({
                success: true,
                message: `邮箱账号 "${email}" 已存在，无需重复添加`,
                email,
                provider: preset.name,
                alreadyExists: true,
            });
        }

        // 同时配置 IMAP 和 POP3 服务器信息，通过 protocol 字段标记用户选择的协议
        const newProfile = {
            name: displayName,
            username: email,
            password: password,
            inbox: {
                protocol,
                imap: {
                    host: preset.imap.host,
                    tls: preset.imap.tls,
                    port: preset.imap.port,
                },
                pop3: {
                    host: preset.pop3.host,
                    tls: preset.pop3.tls,
                    port: preset.pop3.port,
                },
            },
            outbox: {
                smtp: {
                    account: email,
                    host: preset.smtp.host,
                    tls: preset.smtp.tls,
                    port: preset.smtp.port,
                },
            },
        };

        // 保存配置
        profiles.push(newProfile);
        config.profiles = profiles;
        if (!config.currentProfileId) {
            config.currentProfileId = email;
        }
        this.mailApp.setConfig(config);

        // 通知 Worker 重新加载配置并自动触发邮件同步
        this.notifyWorkerConfigChanged();

        return JSON.stringify({
            success: true,
            message: `邮箱账号 "${email}" (${preset.name}, ${protocol.toUpperCase()}) 配置成功，正在后台同步邮件…`,
            email,
            provider: preset.name,
            protocol,
            displayName,
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
            const preset = matchPreset(p.username);
            return {
                email: p.username,
                name: p.name || p.username,
                provider: preset?.name ?? '未知',
                protocol: p.inbox?.protocol ?? '未配置',
                isCurrent: p.username === currentProfileId,
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

        const index = profiles.findIndex((p: any) => p.username === email);
        if (index === -1) {
            throw new Error(`未找到邮箱账号 "${email}"`);
        }

        const removed = profiles.splice(index, 1)[0] as any;
        config.profiles = profiles;

        // 如果删除的是当前选中的账号，切换到第一个
        if (config.currentProfileId === email) {
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

        // 查找目标账号
        const target = profiles.find((p: any) => p.username === email);
        if (!target) {
            const available = profiles.map((p: any) => p.username).join(', ');
            throw new Error(
                `未找到邮箱账号 "${email}"。` +
                (available ? `当前已配置的账号: ${available}` : '当前没有已配置的邮箱账号，请先添加账号。')
            );
        }

        // 检查是否已经是当前账号
        if (config.currentProfileId === email) {
            return JSON.stringify({
                success: true,
                message: `"${email}" 已经是当前使用的邮箱账号，无需切换`,
                email,
                alreadyCurrent: true,
            });
        }

        // 执行切换
        const previousEmail = config.currentProfileId;
        config.currentProfileId = email;
        this.mailApp.setConfig(config);

        // 通知 Worker 重新加载配置（切换当前账号）
        this.notifyWorkerConfigChanged();

        const preset = matchPreset(email);
        return JSON.stringify({
            success: true,
            message: `已切换到邮箱账号 "${email}"` + (preset ? ` (${preset.name})` : ''),
            email,
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
