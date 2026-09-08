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

import type { Command } from 'commander';
import readline from 'readline';
import process from 'process';
import type { PluginAccountLoginMethod, PluginDisplayName } from '../../../../packages/plugin-sdk/src/index.js';
import { resolvePluginDisplayName } from '../../../../packages/plugin-sdk/src/index.js';
import { t, getLocale } from '../../../locale/index.js';
import { getAccountRuntime } from '../../applications/account/factory.js';
import { describeLoginError, runLoginFlow, type LoginFlowIo } from '../../applications/account/login-flow.js';
import type { AccountKind } from '../../applications/account/types.js';
import { initializePluginHost } from '../../applications/pluginmgr/index.js';
import { refreshBuiltinModels } from '../../applications/account/model-provider.js';

/** CLI 侧登录流 IO：文本/密码输入走 readline，状态直接打印。 */
const cliIo: LoginFlowIo = {
    resolveText: (displayName: PluginDisplayName | undefined) =>
        resolvePluginDisplayName(displayName, getLocale()) ?? '',
    promptText: (label) => promptLine(`${label}: `),
    promptSecret: (label) => promptSecret(`${label}: `),
    showStatus: (message) => console.log(`\n${message}`),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
};

/** 交互式普通文本输入（回车确认）。 */
function promptLine(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`\n${question}`, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

/** 交互式密码输入（不回显，以 * 占位）。 */
function promptSecret(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        readline.emitKeypressEvents(stdin);
        const wasRaw = Boolean((stdin as unknown as { isRaw?: boolean }).isRaw);
        stdin.setRawMode(true);
        stdout.write(`\n${question}`);

        let value = '';
        const cleanup = () => {
            stdin.off('keypress', onKey);
            if (stdin.isTTY) {
                stdin.setRawMode(wasRaw);
            }
        };
        const onKey = (str: string | null, key: { name?: string; ctrl?: boolean }): void => {
            if (key && key.ctrl === true && key.name === 'c') {
                cleanup();
                stdout.write('\n');
                process.exit(130);
            }
            if (key && key.name === 'return') {
                cleanup();
                stdout.write('\n');
                resolve(value);
                return;
            }
            if (key && key.name === 'backspace') {
                value = value.slice(0, -1);
                stdout.write(`\r\x1b[2K${question}${'*'.repeat(value.length)}`);
                return;
            }
            if (str) {
                value += str;
                stdout.write('*');
            }
        };
        stdin.on('keypress', onKey);
    });
}

/** 交互式选择账号类型（个人/企业）。 */
async function promptKind(): Promise<AccountKind> {
    const answer = await promptLine(
        `${t('cli.account.select_kind')} (${t('cli.account.personal')}/${t('cli.account.enterprise')}) [${t('cli.account.personal')}]: `
    );
    return /enterprise|企业/i.test(answer) ? 'enterprise' : 'personal';
}

/** 交互式询问企业 base_url 并持久化到 account_config（不改 mode）。 */
async function promptEnterpriseBaseUrl(): Promise<string> {
    const cfg = getAccountRuntime().config.get();
    const current = cfg.enterprise_base_url || cfg.default_base_url;
    const answer = await promptLine(`${t('cli.account.enterprise_url')} [${current}]: `);
    const baseUrl = (answer || current).trim();
    getAccountRuntime().config.configure({ enterprise_base_url: baseUrl });
    return baseUrl;
}

/** 多个登录方式时让用户按序号选择，单个方式时直接采用。 */
async function promptLoginMethod(methods: readonly PluginAccountLoginMethod[]): Promise<PluginAccountLoginMethod> {
    if (methods.length === 1) return methods[0];
    const options = methods
        .map((method, index) => `${index + 1}. ${cliIo.resolveText(method.displayName) || method.id}`)
        .join('\n');
    const answer = await promptLine(`${t('cli.account.select_method')}:\n${options}\n[1]: `);
    const index = Number.parseInt(answer, 10);
    return Number.isInteger(index) && index >= 1 && index <= methods.length ? methods[index - 1] : methods[0];
}

async function runCliLogin(): Promise<void> {
    await initializePluginHost();
    const kind = await promptKind();

    if (kind === 'enterprise') {
        await promptEnterpriseBaseUrl();
    }

    const service = getAccountRuntime().getService();
    const methods = await service.getLoginMethods(kind);
    if (methods.length === 0) {
        throw new Error(t('cli.account.no_login_methods'));
    }
    const method = await promptLoginMethod(methods);
    const session = await runLoginFlow(service, kind, method, cliIo);
    console.log(`\n✓ ${t('cli.account.login.success', { username: session.user.username })}`);
    await refreshBuiltinModels();
}

export function registerAccountCommand(prog: Command): void {
    const acctCmd = prog.command('account').description(t('cli.account.description'));

    acctCmd
        .command('login')
        .description(t('cli.account.login.description'))
        .action(async () => {
            try {
                await runCliLogin();
            } catch (err) {
                console.error(`✗ ${t('cli.account.login.failed', { detail: describeLoginError(err) })}`);
                process.exit(1);
            }
            process.exit(0);
        });

    acctCmd
        .command('logout')
        .description(t('cli.account.logout.description'))
        .action(async () => {
            try {
                await initializePluginHost();
                const service = getAccountRuntime().getService();
                await service.logout();
                await refreshBuiltinModels();
                console.log(`\n✓ ${t('cli.account.logout.success')}`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`✗ ${t('cli.account.logout.failed', { detail: message })}`);
                process.exit(1);
            }
            process.exit(0);
        });

    acctCmd
        .command('status')
        .description(t('cli.account.status.description'))
        .action(async () => {
            await initializePluginHost();
            const service = getAccountRuntime().getService();
            const session = service.getSession();
            if (!session) {
                console.log(t('cli.account.status.not_logged_in'));
                process.exit(0);
                return;
            }
            const user = session.user;
            const displayName = user.display_name || user.username;
            const emailLine = user.email ? `\n  ${t('cli.account.status.email')}: ${user.email}` : '';
            console.log(
                t('cli.account.status.logged_in', {
                    kind: session.kind === 'enterprise' ? t('cli.account.enterprise') : t('cli.account.personal'),
                    username: user.username,
                    displayName,
                    baseUrl: session.baseUrl
                }) + emailLine
            );
            process.exit(0);
        });
}
