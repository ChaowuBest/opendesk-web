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

import { type Component, SelectList, Box, Text, Loader } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { defaultSelectListTheme } from '../../tui/theme';
import { OpenDeskTUI } from '../../tui/entry';
import { InfoOverlay } from '../../tui/components/notice';
import { uninstallPlugin, listInstalledPlugins, setPluginEnabled } from '../../plugins/index.js';
import type { PluginInstallRecord } from '../../plugins/types.js';

type ViewState = 'list' | 'confirm-toggle' | 'confirm-uninstall' | 'uninstalling';

export class PluginsListOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;
    private header: Text;
    private list?: SelectList;
    private loader?: Loader;
    private state: ViewState = 'list';
    private plugins: PluginInstallRecord[] = [];
    private pendingPlugin?: PluginInstallRecord;
    private removeInputListener?: () => void;
    private overlayHandle?: any;
    private onReload?: () => Promise<void>;

    constructor(openDeskTUI: OpenDeskTUI, onReload?: () => Promise<void>) {
        this.openDeskTUI = openDeskTUI;
        this.onReload = onReload;
        this.header = new Text(chalk.bold(' 插件管理'));
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
    }

    private refreshPlugins() {
        this.plugins = listInstalledPlugins();
    }

    private cleanup() {
        if (this.removeInputListener) {
            this.removeInputListener();
            this.removeInputListener = undefined;
        }
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
        this.header = new Text(chalk.bold(' 插件管理'));

        if (this.plugins.length === 0) {
            const items = [{ value: '__empty__', label: chalk.gray('暂无已安装的插件') }];
            this.list = new SelectList(items, 1, defaultSelectListTheme);
        } else {
            const items = this.plugins.map((r) => {
                const status = r.enabled ? chalk.green('✓ 已启用') : chalk.red('✗ 已禁用');
                return {
                    value: r.id,
                    label: `${chalk.bold(r.id)} ${chalk.dim(`(${r.npmSpec})`)} [${status}]`
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

        this.removeInputListener = this.openDeskTUI.tui.addInputListener((data: string) => {
            if (this.state !== 'list') return undefined;

            if (data === 'd' || data === 'D') {
                this.onToggleKey();
                return { consume: true };
            }
            if (data === 'u' || data === 'U') {
                this.onUninstallKey();
                return { consume: true };
            }
            return undefined;
        });

        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private getSelectedPlugin(): PluginInstallRecord | undefined {
        if (!this.list || this.plugins.length === 0) return undefined;
        const item = this.list.getSelectedItem();
        if (!item || item.value === '__empty__') return undefined;
        return this.plugins.find((p) => p.id === item.value);
    }

    // ── Toggle enable/disable ────────────────────────────────────────────────

    private onToggleKey() {
        const plugin = this.getSelectedPlugin();
        if (!plugin) return;
        this.pendingPlugin = plugin;
        this.showConfirmToggle(plugin);
    }

    private showConfirmToggle(plugin: PluginInstallRecord) {
        this.cleanup();
        this.state = 'confirm-toggle';
        const action = plugin.enabled ? '禁用' : '启用';
        this.header = new Text(chalk.bold.yellow(` 确认${action}: ${plugin.id}`));

        const items = [
            { value: 'confirm', label: chalk.green(`确认${action}`) },
            { value: 'cancel', label: chalk.red('取消') }
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

    private async performToggle(plugin: PluginInstallRecord) {
        const action = plugin.enabled ? '禁用' : '启用';
        const ok = setPluginEnabled(plugin.id, !plugin.enabled);
        if (ok) {
            if (this.onReload) {
                try {
                    await this.onReload();
                } catch {
                    /* best effort */
                }
            }
            this.showList();
            this.showResultMessage(`插件已${action}: ${plugin.id}\n\n消息渠道已自动重新加载。`);
        } else {
            this.showList();
            this.showResultMessage(`未找到插件: ${plugin.id}`);
        }
    }

    // ── Uninstall ────────────────────────────────────────────────────────────

    private onUninstallKey() {
        const plugin = this.getSelectedPlugin();
        if (!plugin) return;
        this.pendingPlugin = plugin;
        this.showConfirmUninstall(plugin);
    }

    private showConfirmUninstall(plugin: PluginInstallRecord) {
        this.cleanup();
        this.state = 'confirm-uninstall';
        this.header = new Text(chalk.bold.red(` 确认卸载: ${plugin.id}`));

        const items = [
            { value: 'confirm', label: chalk.red('确认卸载') },
            { value: 'cancel', label: chalk.green('取消') }
        ];

        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.list.onSelect = (item) => {
            if (item.value === 'confirm') {
                this.performUninstall(plugin);
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

    private async performUninstall(plugin: PluginInstallRecord) {
        this.cleanup();
        this.state = 'uninstalling';
        this.list = undefined;
        this.header = new Text(chalk.bold(' 卸载中'));
        this.loader = new Loader(
            this.openDeskTUI.tui,
            (s: string) => chalk.cyan(s),
            (s: string) => chalk.hex('#e0e0e0')(s),
            `正在卸载插件: ${plugin.id} ...`
        );
        this.renderBox();

        try {
            const result = await uninstallPlugin(plugin.id);
            if (result.success && this.onReload) {
                try {
                    await this.onReload();
                } catch {
                    /* best effort */
                }
            }
            this.cleanup();
            this.showList();
            if (result.success) {
                this.showResultMessage(`插件已卸载: ${plugin.id}\n\n消息渠道已自动重新加载。`);
            } else {
                this.showResultMessage(`插件卸载失败: ${result.error}`);
            }
        } catch (err: any) {
            this.cleanup();
            this.showList();
            this.showResultMessage(`插件卸载出错: ${err?.message ?? err}`);
        }
    }

    // ── Result notification (brief overlay after action) ─────────────────────

    private showResultMessage(message: string) {
        this.close();
        new InfoOverlay(this.openDeskTUI, {
            title: '插件管理',
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
        }

        if (this.state === 'list') {
            this.box.addChild(new Text(''));
            this.box.addChild(new Text(chalk.dim('  D 启用/禁用  U 卸载  Esc 关闭')));
        } else if (this.state === 'confirm-toggle' || this.state === 'confirm-uninstall') {
            this.box.addChild(new Text(''));
            this.box.addChild(new Text(chalk.dim('  ↑↓ 选择  Enter 确认  Esc 取消')));
        }

        this.openDeskTUI.tui.requestRender();
    }

    // ── Overlay lifecycle ────────────────────────────────────────────────────

    private close() {
        if (!this.overlayHandle) return;

        const handle = this.overlayHandle;
        this.overlayHandle = undefined;

        this.openDeskTUI.hasOpenOverlay = false;
        handle.hide();

        this.cleanup();
        this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }

    show() {
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const terminalHeight = this.openDeskTUI.tui.terminal.rows;
        const overlayWidth = Math.min(70, terminalWidth - 4);
        const overlayMaxHeight = Math.max(10, terminalHeight - 4);

        this.overlayHandle = this.openDeskTUI.tui.showOverlay(this, {
            width: overlayWidth,
            maxHeight: overlayMaxHeight,
            anchor: 'center'
        });

        this.openDeskTUI.hasOpenOverlay = true;
        this.showList();

        this.overlayHandle.onHide = () => {
            if (this.overlayHandle) {
                this.cleanup();
                this.openDeskTUI.hasOpenOverlay = false;
                this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
            }
        };
    }
}
