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

import { getKeybindings, type Component } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import type { PluginAccountLoginMethod, PluginDisplayName } from '../../../../packages/plugin-sdk/src/index.js';
import { resolvePluginDisplayName } from '../../../../packages/plugin-sdk/src/index.js';
import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay, ProgressOverlay } from '../components/notice.js';
import { t, getLocale } from '../../../locale/index.js';
import { getAccountRuntime } from '../../applications/account/factory.js';
import { describeLoginError, runLoginFlow, type LoginFlowIo } from '../../applications/account/login-flow.js';
import type { AccountKind } from '../../applications/account/types.js';
import { refreshBuiltinModels } from '../../applications/account/model-provider.js';

// ─── 登录 widget 配色 ────────────────────────────────────────────────────────

const loginColors = {
    bg: (s: string) => chalk.bgHex('#1e2a3a')(s),
    title: (s: string) => chalk.bgHex('#1a6b9a').hex('#ffffff').bold(s),
    label: (s: string) => chalk.hex('#e0e8f0').bold(s),
    value: (s: string) => chalk.hex('#7ec8e3')(s),
    hint: (s: string) => chalk.hex('#556677')(s),
    separator: (s: string) => chalk.hex('#334455')(s)
};

function padBgLine(line: string, width: number, bgFn: (s: string) => string): string {
    const w = line.length;
    const pad = Math.max(0, width - w);
    return bgFn(line + ' '.repeat(pad));
}

/** 单字段文本输入 widget（支持密码隐藏）。 */
class TextFieldWidget implements Component {
    private value = '';
    private renderCallback: (() => void) | null = null;
    onDone?: (value: string) => void;
    onCancel?: () => void;

    constructor(
        private readonly tui: OpenDeskTUI,
        private readonly label: string,
        private readonly secret = false
    ) {}

    setRenderCallback(cb: () => void): void {
        this.renderCallback = cb;
    }

    handleInput(keyData: unknown): { consume: boolean } | undefined {
        const kb = getKeybindings();
        if (kb.matches(keyData, 'tui.select.confirm')) {
            this.onDone?.(this.value);
            return { consume: true };
        }
        if (kb.matches(keyData, 'tui.select.cancel')) {
            this.onCancel?.();
            return { consume: true };
        }
        if (kb.matches(keyData, 'tui.editor.deleteCharBackward')) {
            this.value = this.value.slice(0, -1);
            this.invalidate();
            return { consume: true };
        }
        if (typeof keyData === 'string' && keyData.length === 1) {
            this.value += keyData;
            this.invalidate();
            return { consume: true };
        }
        return undefined;
    }

    invalidate(): void {
        this.renderCallback?.();
    }

    render(width: number): string[] {
        const c = loginColors;
        const shown = this.secret ? '*'.repeat(this.value.length) : this.value;
        return [
            c.separator('─'.repeat(width)),
            padBgLine(c.title('  ' + t('cli.account.tui.login_title') + ' '), width, c.bg),
            c.bg(' '.repeat(width)),
            padBgLine(c.label('  ' + this.label), width, c.bg),
            c.bg(' '.repeat(width)),
            padBgLine(c.value('  > ') + c.value(shown || ' ') + c.hint('_'), width, c.bg),
            c.bg(' '.repeat(width)),
            padBgLine(c.hint('  ' + t('cli.account.tui.enter_confirm')), width, c.bg),
            c.bg(' '.repeat(width))
        ];
    }
}

/** 关闭一个输入区 prompt 并恢复焦点（遵循 prompt 队列规范）。 */
function closeWidget(tui: OpenDeskTUI, widget: Component): void {
    const restored = tui.closeInputPrompt(widget);
    tui.focusAfterInputPromptClose(restored);
}

function showWidget(tui: OpenDeskTUI, widget: Component): boolean {
    if (tui.deferInputPromptIfBlockedByMode(() => showWidget(tui, widget))) {
        return true;
    }
    tui.inputArea.showPromptWidget(widget);
    tui.hasOpenOverlay = true;
    tui.tui.setFocus(widget);
    tui.tui.requestRender();
    return false;
}

function askField(tui: OpenDeskTUI, label: string, secret: boolean, next: (value: string) => void): void {
    const widget = new TextFieldWidget(tui, label, secret);
    widget.setRenderCallback(() => tui.tui.requestRender());
    widget.onDone = (value) => {
        closeWidget(tui, widget);
        next(value);
    };
    widget.onCancel = () => closeWidget(tui, widget);
    showWidget(tui, widget);
}

/** 登录流字段输入：Esc 取消时以空值结束，由驱动器按 required 规则报错。 */
function askFlowField(tui: OpenDeskTUI, label: string, secret: boolean): Promise<string> {
    return new Promise((resolve) => {
        const widget = new TextFieldWidget(tui, label, secret);
        widget.setRenderCallback(() => tui.tui.requestRender());
        widget.onDone = (value) => {
            closeWidget(tui, widget);
            resolve(value);
        };
        widget.onCancel = () => {
            closeWidget(tui, widget);
            resolve('');
        };
        showWidget(tui, widget);
    });
}

/** 交互式 TUI 侧登录流 IO：字段输入走输入区 prompt，等待态用 ProgressOverlay 呈现。 */
function createTuiLoginIo(tui: OpenDeskTUI): LoginFlowIo {
    let progress: ProgressOverlay | null = null;
    let lastStatus: string | null = null;
    return {
        resolveText: (displayName: PluginDisplayName | undefined) =>
            resolvePluginDisplayName(displayName, getLocale()) ?? '',
        promptText: (label) => askFlowField(tui, label, false),
        promptSecret: (label) => askFlowField(tui, label, true),
        showStatus: (message) => {
            if (message === lastStatus) return;
            lastStatus = message;
            progress?.hide();
            progress = new ProgressOverlay(tui, { title: t('cli.account.tui.login_title'), message });
            progress.show();
        },
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now()
    };
}

/** 询问账号类型（个人/企业），再按插件声明的登录方式驱动登录流。 */
function runTuiLogin(tui: OpenDeskTUI): void {
    const startFlow = async (kind: AccountKind): Promise<void> => {
        try {
            const service = getAccountRuntime().getService();
            const io = createTuiLoginIo(tui);
            const methods = await service.getLoginMethods(kind);
            if (methods.length === 0) {
                finish(tui, t('cli.account.no_login_methods'), 'error');
                return;
            }
            const method: PluginAccountLoginMethod =
                methods.length === 1 ? methods[0] : await chooseLoginMethod(methods, io);
            const session = await runLoginFlow(service, kind, method, io);
            await refreshBuiltinModels();
            finish(tui, t('cli.account.login.success', { username: session.user.username }), 'info');
        } catch (err) {
            finish(tui, t('cli.account.login.failed', { detail: describeLoginError(err) }), 'error');
        }
    };

    const askKind = (): void => {
        askField(
            tui,
            `${t('cli.account.select_kind')} (${t('cli.account.personal')}/${t('cli.account.enterprise')}, ${t('cli.account.tui.kind_default')} ${t('cli.account.personal')})`,
            false,
            (raw) => {
                const kind: AccountKind = /enterprise|企业/i.test(raw) ? 'enterprise' : 'personal';
                if (kind === 'enterprise') {
                    askEnterpriseBaseUrl();
                } else {
                    void startFlow('personal');
                }
            }
        );
    };

    const askEnterpriseBaseUrl = (): void => {
        const cfg = getAccountRuntime().config.get();
        const current = cfg.enterprise_base_url || cfg.default_base_url;
        askField(tui, `${t('cli.account.enterprise_url')} [${current}]`, false, (value) => {
            const baseUrl = (value || current).trim();
            getAccountRuntime().config.configure({ enterprise_base_url: baseUrl });
            void startFlow('enterprise');
        });
    };

    askKind();
}

async function chooseLoginMethod(
    methods: readonly PluginAccountLoginMethod[],
    io: LoginFlowIo
): Promise<PluginAccountLoginMethod> {
    const options = methods
        .map((method, index) => `${index + 1}. ${io.resolveText(method.displayName) || method.id}`)
        .join(' / ');
    const answer = await io.promptText(`${t('cli.account.select_method')} (${options}) [1]`);
    const index = Number.parseInt(answer, 10);
    return Number.isInteger(index) && index >= 1 && index <= methods.length ? methods[index - 1] : methods[0];
}

function finish(tui: OpenDeskTUI, message: string, type: 'info' | 'error'): void {
    const title = type === 'error' ? t('cli.account.tui.failed_title') : t('cli.account.tui.success_title');
    const info = new InfoOverlay(tui, {
        title,
        message,
        type,
        closeLabel: t('quickpass.close')
    });
    info.show();
}

export function registerAccountCommands(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'account',
        description: t('cli.account.tui.status_title'),
        execute: () => {
            const service = getAccountRuntime().getService();
            const session = service.getSession();
            if (!session) {
                finish(tui, t('cli.account.status.not_logged_in'), 'info');
                return;
            }
            const user = session.user;
            const displayName = user.display_name || user.username;
            const emailLine = user.email ? `\n  ${t('cli.account.status.email')}: ${user.email}` : '';
            finish(
                tui,
                t('cli.account.status.logged_in', {
                    kind: session.kind === 'enterprise' ? t('cli.account.enterprise') : t('cli.account.personal'),
                    username: user.username,
                    displayName,
                    baseUrl: session.baseUrl
                }) + emailLine,
                'info'
            );
        }
    });
}

export function registerLoginCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'login',
        description: t('cli.account.login.description'),
        execute: () => {
            const session = getAccountRuntime().getService();
            if (session.getSession()) {
                finish(tui, t('cli.account.tui.already_logged_in'), 'info');
                return;
            }
            runTuiLogin(tui);
        }
    });
}

export function registerLogoutCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'logout',
        description: t('cli.account.logout.description'),
        execute: async () => {
            const service = getAccountRuntime().getService();
            if (!service.getSession()) {
                finish(tui, t('cli.account.status.not_logged_in'), 'info');
                return;
            }
            try {
                await service.logout();
                await refreshBuiltinModels();
                finish(tui, t('cli.account.logout.success'), 'info');
            } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                finish(tui, t('cli.account.logout.failed', { detail }), 'error');
            }
        }
    });
}
