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

import { type Component, SelectList } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { t } from '../../../../locale/index.js';
import { ApplicationRegistry } from '../../../applications/registry.js';
import type { PluginMgrApplication } from '../../../applications/pluginmgr/app.js';
import type { OpenDeskTUI } from '../../entry.js';
import { defaultSelectListTheme } from '../../theme.js';

interface PluginListEntry {
    id: string;
    source: 'managed' | 'local' | 'external';
    managed: boolean;
    enabled: boolean;
    runtime?: {
        status: 'active' | 'error' | 'disabled';
        apiVersion: number;
        capabilities: string[];
    };
}

export class PluginConfigPage implements Component {
    private readonly openDeskTUI: OpenDeskTUI;
    private readonly onBack: () => void;
    private list?: SelectList;
    private entries: PluginListEntry[] = [];
    private state: 'main' | 'actions' | 'confirm' = 'main';
    private selectedId?: string;
    private loading = true;
    private error?: string;

    constructor(openDeskTUI: OpenDeskTUI, onBack: () => void) {
        this.openDeskTUI = openDeskTUI;
        this.onBack = onBack;
        this.showLoading();
        void this.loadEntries();
    }

    private getApplication(): PluginMgrApplication {
        const application = ApplicationRegistry.getApplication('pluginmgr');
        if (!application) throw new Error('pluginmgr application is not registered');
        return application as PluginMgrApplication;
    }

    private showLoading(): void {
        this.list = new SelectList(
            [{ value: '_loading', label: chalk.dim(t('plugin.center.loading')) }],
            1,
            defaultSelectListTheme
        );
        this.list.onSelect = () => undefined;
        this.list.onCancel = this.onBack;
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private async loadEntries(reload = false): Promise<void> {
        this.loading = true;
        this.error = undefined;
        this.openDeskTUI.tui.requestRender();
        try {
            const application = this.getApplication();
            this.entries = (await (reload ? application.reload() : application.list())) as PluginListEntry[];
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.loading = false;
            this.showMain();
        }
    }

    private showMain(): void {
        this.state = 'main';
        this.selectedId = undefined;
        const items = [
            { value: '_reload', label: chalk.cyan(`↻ ${t('plugin.settings.reload')}`) },
            ...(this.entries.length
                ? this.entries.map((entry) => {
                      const status = entry.enabled ? (entry.runtime?.status ?? 'disabled') : 'disabled';
                      const marker =
                          status === 'active'
                              ? chalk.green('●')
                              : status === 'error'
                                ? chalk.red('●')
                                : chalk.gray('●');
                      const source = t(`plugin.center.source.${entry.source}`);
                      const capabilityCount = entry.runtime?.capabilities.length ?? 0;
                      return {
                          value: entry.id,
                          label: `${marker} ${chalk.bold(entry.id)}  ${chalk.dim(`${t(`plugin.runtime.status.${status}`)} · ${source} · ${capabilityCount}`)}`
                      };
                  })
                : [{ value: '_empty', label: chalk.dim(t('plugin.center.empty')) }])
        ];
        this.list = new SelectList(items, Math.min(items.length, 15), defaultSelectListTheme);
        this.list.onSelect = (item) => {
            if (item.value === '_reload') {
                void this.loadEntries(true);
            } else if (item.value !== '_empty') {
                this.showActions(item.value);
            }
        };
        this.list.onCancel = this.onBack;
        this.openDeskTUI.tui.setFocus(this.list);
        this.openDeskTUI.tui.requestRender();
    }

    private showActions(id: string): void {
        const entry = this.entries.find((candidate) => candidate.id === id);
        if (!entry) return;
        this.state = 'actions';
        this.selectedId = id;
        const items = [
            {
                value: 'toggle',
                label: entry.enabled ? t('plugin.center.disable') : t('plugin.center.enable')
            },
            ...(entry.managed ? [{ value: 'uninstall', label: chalk.red(t('plugin.center.uninstall')) }] : []),
            { value: 'back', label: t('plugin.tui.back') }
        ];
        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.list.onSelect = (item) => {
            if (item.value === 'toggle') void this.toggleSelected();
            else if (item.value === 'uninstall') this.showUninstallConfirmation();
            else this.showMain();
        };
        this.list.onCancel = () => this.showMain();
        this.openDeskTUI.tui.setFocus(this.list);
        this.openDeskTUI.tui.requestRender();
    }

    private async toggleSelected(): Promise<void> {
        const entry = this.entries.find((candidate) => candidate.id === this.selectedId);
        if (!entry) return;
        try {
            await this.getApplication().setEnabled(entry.id, !entry.enabled);
            await this.loadEntries();
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
            this.showMain();
        }
    }

    private showUninstallConfirmation(): void {
        this.state = 'confirm';
        this.list = new SelectList(
            [
                { value: 'cancel', label: t('plugin.tui.back') },
                { value: 'confirm', label: chalk.red(t('plugin.center.uninstall')) }
            ],
            2,
            defaultSelectListTheme
        );
        this.list.onSelect = (item) => {
            if (item.value === 'confirm') void this.uninstallSelected();
            else if (this.selectedId) this.showActions(this.selectedId);
        };
        this.list.onCancel = () => {
            if (this.selectedId) this.showActions(this.selectedId);
        };
        this.openDeskTUI.tui.setFocus(this.list);
        this.openDeskTUI.tui.requestRender();
    }

    private async uninstallSelected(): Promise<void> {
        if (!this.selectedId) return;
        try {
            await this.getApplication().uninstall(this.selectedId);
            await this.loadEntries();
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
            this.showMain();
        }
    }

    invalidate() {}

    render(width: number): string[] {
        const lines = [chalk.bold('🔌  ' + t('config.plugin.title')), chalk.dim(t('config.plugin.title.hint')), ''];
        if (this.state === 'confirm' && this.selectedId) {
            lines.push(chalk.yellow(t('plugin.center.uninstallConfirm', { id: this.selectedId })), '');
        } else if (this.state === 'actions' && this.selectedId) {
            lines.push(chalk.bold(this.selectedId), '');
        }
        if (this.error) lines.push(chalk.red(this.error), '');
        if (this.loading) lines.push(chalk.dim(t('plugin.center.loading')));
        else if (this.list) lines.push(...this.list.render(width));
        lines.push('', chalk.dim(t('config.common.cancel')));
        return lines;
    }
}
