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

import { type Component, SelectList, Box, Text, Loader } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { defaultSelectListTheme } from '../../tui/theme';
import { OpenDeskTUI } from '../../tui/entry';
import { InfoOverlay } from '../../tui/components/notice';
import { listVisiblePlugins, setPluginEnabled } from '../pluginmgr/index.js';
import type { PluginRegistryRecord, PluginSourceKind } from '../pluginmgr/index.js';
import { t } from '../../../locale/index.js';

type ViewState = 'list' | 'confirm-toggle' | 'confirm-uninstall' | 'uninstalling';

function pluginSourceLabel(source: PluginSourceKind): string {
    // 'managed' 仅存在于旧版注册表数据中，对外统一视为本地插件。
    switch (source) {
        case 'builtin':
            return t('plugin.list.source.builtin');
        case 'external':
            return t('plugin.list.source.external');
        default:
            return t('plugin.list.source.managed');
    }
}

/**
 * 消息插件列表（TUI）。
 *
 * 启停与卸载都交给调用方提供的回调：这两类操作必须先动插件宿主里的运行实例，再落盘，
 * 并由宿主广播 pluginsChanged。组件不直接碰 management 层的 install/uninstall，
 * 否则会退化成"带着运行实例删目录"（Windows 下 rename 失败）且不通知其他订阅方。
 */
export class PluginsListOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;
    private header: Text;
    private list?: SelectList;
    private loader?: Loader;
    private state: ViewState = 'list';
    private plugins: PluginRegistryRecord[] = [];
    private onToggle: (id: string, enabled: boolean) => Promise<void>;
    private onUninstall: (id: string, removeData: boolean) => Promise<void>;

    constructor(
        openDeskTUI: OpenDeskTUI,
        onToggle: (id: string, enabled: boolean) => Promise<void>,
        onUninstall: (id: string, removeData: boolean) => Promise<void>
    ) {
        this.openDeskTUI = openDeskTUI;
        this.onToggle = onToggle;
        this.onUninstall = onUninstall;
        this.header = new Text(chalk.bold(t('plugin.tui.title')));
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
    }

    private refreshPlugins() {
        // 与 GUI 插件管理页同口径：registry 记录 + discovery 候选（含内置插件）
        this.plugins = listVisiblePlugins();
    }

    private cleanup() {
        if (this.loader) {
            this.loader.stop();
            this.loader = undefined;
        }
    }

    private showList() {
        this.cleanup();
        this.state = 'list';
        this.list = undefined;
        this.refreshPlugins();
        this.header = new Text(chalk.bold(t('plugin.tui.title')));

        if (this.plugins.length === 0) {
            const items = [{ value: '__empty__', label: chalk.gray(t('plugin.tui.empty')) }];
            this.list = new SelectList(items, 1, defaultSelectListTheme);
        } else {
            const items = this.plugins.map((r) => {
                const status = r.enabled
                    ? chalk.green(`✓ ${t('plugin.list.status.enabled')}`)
                    : chalk.red(`✗ ${t('plugin.list.status.disabled')}`);
                const spec = r.spec ?? r.path;
                return {
                    value: r.id,
                    label: `${chalk.bold(r.id)} ${chalk.dim(`[${pluginSourceLabel(r.source)}]`)} ${chalk.dim(`(${spec})`)} [${status}]`
                };
            });
            this.list = new SelectList(items, Math.min(items.length, 10), defaultSelectListTheme);
        }

        this.list.onSelect = () => {
            /* Enter on list item does nothing in this view */
        };
        this.list.onCancel = () => {
            this.close();
        };

        this.renderBox();
        this.openDeskTUI.tui.setFocus(this);
    }

    private getSelectedPlugin(): PluginRegistryRecord | undefined {
        if (!this.list || this.plugins.length === 0) return undefined;
        const item = this.list.getSelectedItem();
        if (!item || item.value === '__empty__') return undefined;
        return this.plugins.find((p) => p.id === item.value);
    }

    // ── Toggle enable/disable ────────────────────────────────────────────────

    private onToggleKey() {
        const plugin = this.getSelectedPlugin();
        if (!plugin) return;
        this.showConfirmToggle(plugin);
    }

    private showConfirmToggle(plugin: PluginRegistryRecord) {
        this.cleanup();
        this.state = 'confirm-toggle';
        const action = plugin.enabled ? t('plugin.tui.action.disable') : t('plugin.tui.action.enable');
        this.header = new Text(chalk.bold.yellow(t('plugin.tui.confirmToggle', { action, id: plugin.id })));

        const items = [
            { value: 'confirm', label: chalk.green(t('plugin.tui.confirm', { action })) },
            { value: 'cancel', label: chalk.red(t('plugin.tui.cancel')) }
        ];

        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.list.onSelect = (item) => {
            if (item.value === 'confirm') {
                this.performToggle(plugin);
            } else {
                this.showList();
            }
        };
        this.list.onCancel = () => {
            this.showList();
        };

        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private async performToggle(plugin: PluginRegistryRecord) {
        const enabled = !plugin.enabled;
        const action = plugin.enabled ? t('plugin.tui.action.disable') : t('plugin.tui.action.enable');
        if (!setPluginEnabled(plugin.id, enabled)) {
            this.showList();
            this.showResultMessage(t('plugin.tui.notFound', { id: plugin.id }));
            return;
        }
        try {
            // 差量启停：只动目标插件，其他插件与渠道不受影响
            await this.onToggle(plugin.id, enabled);
        } catch (err: any) {
            // 启用失败（完整性校验、入口缺失等）：回滚注册表并提示原因，不谎报完成
            setPluginEnabled(plugin.id, plugin.enabled);
            this.showList();
            this.showResultMessage(
                t('plugin.tui.toggleFail', { action, id: plugin.id, error: err?.message ?? String(err) })
            );
            return;
        }
        this.showList();
        this.showResultMessage(t('plugin.tui.toggleDone', { action, id: plugin.id }));
    }

    // ── Uninstall ────────────────────────────────────────────────────────────

    private onUninstallKey() {
        const plugin = this.getSelectedPlugin();
        if (!plugin) return;
        // 与 GUI 的 removable 口径一致：内置与外部路径插件不可卸载
        if (plugin.source === 'builtin' || plugin.source === 'external') {
            const key =
                plugin.source === 'builtin'
                    ? 'plugin.tui.uninstallBlocked.builtin'
                    : 'plugin.tui.uninstallBlocked.external';
            this.showResultMessage(t(key, { id: plugin.id }));
            return;
        }
        this.showConfirmUninstall(plugin);
    }

    private showConfirmUninstall(plugin: PluginRegistryRecord) {
        this.cleanup();
        this.state = 'confirm-uninstall';
        this.header = new Text(chalk.bold.red(t('plugin.tui.confirmUninstall', { id: plugin.id })));

        // 顺序不能变：既有用户的肌肉记忆是「下一项 + 回车 = 取消」，破坏它会让
        // 一次误操作直接变成「卸载并删除数据目录」。危险选项排在最后，必须刻意选择。
        const items = [
            { value: 'confirm', label: chalk.red(t('plugin.tui.uninstallConfirm')) },
            { value: 'cancel', label: chalk.green(t('plugin.tui.cancel')) },
            { value: 'confirm-remove-data', label: chalk.red(t('plugin.tui.uninstallRemoveData')) }
        ];

        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.list.onSelect = (item) => {
            if (item.value === 'confirm') {
                this.performUninstall(plugin, false);
            } else if (item.value === 'confirm-remove-data') {
                this.performUninstall(plugin, true);
            } else {
                this.showList();
            }
        };
        this.list.onCancel = () => {
            this.showList();
        };

        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private async performUninstall(plugin: PluginRegistryRecord, removeData: boolean) {
        this.cleanup();
        this.state = 'uninstalling';
        this.list = undefined;
        this.header = new Text(chalk.bold(t('plugin.tui.uninstalling')));
        this.loader = new Loader(
            this.openDeskTUI.tui,
            (s: string) => chalk.cyan(s),
            (s: string) => chalk.hex('#e0e0e0')(s),
            t('plugin.tui.uninstallingDetail', { id: plugin.id })
        );
        this.renderBox();

        try {
            // 差量卸载：先释放插件实例再删盘，其他插件与渠道不受影响
            await this.onUninstall(plugin.id, removeData);
            this.cleanup();
            this.showList();
            const dataMessage = removeData
                ? t('plugin.uninstall.dataRemoved', { id: plugin.id })
                : t('plugin.uninstall.dataKept', { id: plugin.id });
            this.showResultMessage(`${t('plugin.tui.uninstallDone', { id: plugin.id })}\n\n${dataMessage}`);
        } catch (err: any) {
            this.cleanup();
            this.showList();
            this.showResultMessage(t('plugin.tui.uninstallError', { error: err?.message ?? String(err) }));
        }
    }

    // ── Result notification (brief overlay after action) ─────────────────────

    private showResultMessage(message: string) {
        this.close();
        new InfoOverlay(this.openDeskTUI, {
            title: t('plugin.tui.title'),
            message
        }).show();
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    private renderBox() {
        this.box.clear();
        this.box.addChild(this.header);

        if (this.state === 'uninstalling' && this.loader) {
            this.box.addChild(new Text(''));
            this.box.addChild(this.loader);
            this.box.addChild(new Text(''));
        } else {
            if (this.list) {
                this.box.addChild(this.list);
            }
            if (this.state === 'confirm-uninstall') {
                // 与设置页的插件中心保持同一口径：默认保留数据目录，删除则不可恢复
                this.box.addChild(new Text(''));
                this.box.addChild(new Text(chalk.dim(t('plugin.tui.uninstallDataHint'))));
            }
        }

        if (this.state === 'list') {
            this.box.addChild(new Text(''));
            this.box.addChild(new Text(chalk.dim(t('plugin.tui.help.list'))));
        } else if (this.state === 'confirm-toggle' || this.state === 'confirm-uninstall') {
            this.box.addChild(new Text(''));
            this.box.addChild(new Text(chalk.dim(t('plugin.tui.help.confirm'))));
        }

        this.openDeskTUI.tui.requestRender();
    }

    // ── Panel lifecycle ──────────────────────────────────────────────────────

    private close() {
        const restored = this.openDeskTUI.closeInputPrompt(this);
        this.cleanup();
        this.openDeskTUI.focusAfterInputPromptClose(restored);
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }

    handleInput(keyData: string): void {
        if (this.state === 'list') {
            if (keyData === 'd' || keyData === 'D') {
                this.onToggleKey();
                return;
            }
            if (keyData === 'u' || keyData === 'U') {
                this.onUninstallKey();
                return;
            }
        }

        this.list?.handleInput(keyData);
        this.openDeskTUI.tui.requestRender();
    }

    show() {
        if (this.openDeskTUI.deferInputPromptIfBlockedByMode(() => this.show())) {
            return;
        }

        this.openDeskTUI.inputArea.showPromptWidget(this);
        this.openDeskTUI.hasOpenOverlay = true;
        this.showList();
    }
}
