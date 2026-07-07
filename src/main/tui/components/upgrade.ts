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

import { type Component, SelectList, Box, Text } from '@earendil-works/pi-tui';
import { defaultSelectListTheme, getOverlayColors } from '../theme';
import { OpenDeskTUI } from '../entry';
import { performUpgrade, getVersionInfo, getCurrentVersion } from '../../utils/upgrade.js';
import { t } from '../../../locale/index.js';
import chalk from 'chalk';

class Splitter implements Component {
    invalidate(): void {
        // 不需要实现
    }

    render(width: number): string[] {
        const { border } = getOverlayColors();
        const separator = '━'.repeat(width);
        return [chalk.hex(border)(separator)];
    }
}

type UpgradeState = 'init' | 'select' | 'checking' | 'confirm' | 'upgrading' | 'success' | 'error' | 'uptodate';
type UpgradeAction = 'stable' | 'nightly' | 'cancel' | 'upgrade' | 'close';
type UpgradeItem = { value: UpgradeAction; label: string };

export class UpgradeOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private tag: 'latest' | 'nightly' | null = null;
    private box: Box;
    private list?: SelectList;

    private state: UpgradeState = 'select';
    private currentVersion: string = 'unknown';
    private latestVersion: string = 'unknown';
    private errorMessage: string = '';
    private closed = false;
    private token = 0;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;

        this.box = new Box(1, 1);
        this.updateUI();
    }

    private updateUI(): void {
        this.box = new Box(1, 1);
        this.list = undefined;

        const oc = getOverlayColors();
        this.box.setBgFn((text: string) => chalk.bgHex(oc.bg).hex(oc.fg)(text));

        let icon = '📦';
        let title = '';
        switch (this.state) {
            case 'init':
                title = t('upgrade.title');
                break;
            case 'select':
                title = t('upgrade.title');
                break;
            case 'checking':
                icon = '🔍';
                title = t('upgrade.title.checking');
                break;
            case 'confirm':
                title = t('upgrade.title.confirm');
                break;
            case 'upgrading':
                icon = '⏳';
                title = t('upgrade.title.upgrading');
                break;
            case 'success':
                icon = '☑';
                title = t('upgrade.title.success');
                break;
            case 'error':
                icon = '❌';
                title = t('upgrade.title.error');
                break;
            case 'uptodate':
                icon = '✓';
                title = t('upgrade.title.uptodate');
                break;
        }

        this.box.addChild(new Text(chalk.bold(`${icon} ${title}`)));
        this.box.addChild(new Splitter());
        this.box.addChild(new Text(''));

        switch (this.state) {
            case 'init':
                this.box.addChild(new Text(chalk.cyan(t('upgrade.loading.current'))));
                this.box.addChild(new Text(''));
                this.addList([{ value: 'cancel', label: chalk.red(t('common.cancel')) }]);
                break;

            case 'select':
                this.box.addChild(
                    new Text(
                        t('upgrade.current.version', {
                            version:
                                this.currentVersion === 'unknown' ? t('upgrade.current.not_npm') : this.currentVersion
                        })
                    )
                );
                this.box.addChild(new Text(''));
                this.box.addChild(new Text(t('upgrade.select.prompt')));
                this.box.addChild(new Text(''));

                this.addList([
                    { value: 'stable', label: chalk.green('Stable') + chalk.gray(` - ${t('upgrade.option.stable')}`) },
                    {
                        value: 'nightly',
                        label: chalk.cyan('Nightly') + chalk.gray(` - ${t('upgrade.option.nightly')}`)
                    },
                    { value: 'cancel', label: chalk.red(t('common.cancel')) }
                ]);
                break;

            case 'checking':
                this.box.addChild(
                    new Text(
                        chalk.cyan(t('upgrade.checking.tag', { tag: this.tag === 'nightly' ? 'Nightly' : 'Stable' }))
                    )
                );
                this.box.addChild(new Text(''));
                this.addList([{ value: 'cancel', label: chalk.red(t('common.cancel')) }]);
                break;

            case 'confirm':
                this.box.addChild(
                    new Text(
                        `${t('upgrade.version.current', { version: chalk.yellow(this.currentVersion) })}\n` +
                            t('upgrade.version.latest', { version: chalk.green(this.latestVersion) })
                    )
                );
                this.box.addChild(new Text(''));
                this.box.addChild(
                    new Text(t('upgrade.confirm.prompt', { tag: this.tag === 'nightly' ? 'Nightly' : 'Stable' }))
                );
                this.box.addChild(new Text(''));

                this.addList([
                    { value: 'upgrade', label: chalk.green(t('upgrade.confirm.action')) },
                    { value: 'cancel', label: chalk.red(t('common.cancel')) }
                ]);
                break;

            case 'upgrading':
                this.box.addChild(
                    new Text(
                        chalk.cyan(
                            t('upgrade.upgrading.message', { tag: this.tag === 'nightly' ? 'Nightly' : 'Stable' })
                        )
                    )
                );
                this.box.addChild(new Text(''));
                this.box.addChild(new Text(chalk.gray(t('upgrade.upgrading.detail'))));
                break;

            case 'success':
                this.box.addChild(
                    new Text(`${chalk.yellow(this.currentVersion)} → ${chalk.green(this.latestVersion)}`)
                );
                this.box.addChild(new Text(''));
                this.box.addChild(new Text(chalk.green(t('upgrade.success.restart'))));
                this.box.addChild(new Text(''));

                this.addList([{ value: 'close', label: chalk.cyan(t('common.close')) }]);
                break;

            case 'error':
                this.box.addChild(new Text(chalk.red(this.errorMessage)));
                this.box.addChild(new Text(''));

                this.addList([{ value: 'close', label: chalk.cyan(t('common.close')) }]);
                break;

            case 'uptodate':
                this.box.addChild(
                    new Text(
                        `${t('upgrade.version.current', { version: chalk.green(this.currentVersion) })}\n` +
                            t('upgrade.uptodate.message', { tag: this.tag === 'nightly' ? 'Nightly' : 'Stable' })
                    )
                );
                this.box.addChild(new Text(''));

                this.addList([{ value: 'close', label: chalk.cyan(t('common.confirm')) }]);
                break;
        }

        this.box.invalidate();
    }

    private addList(items: UpgradeItem[]): void {
        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.list.onSelect = (item) => this.handleSelection(item.value as UpgradeAction);
        this.list.onCancel = () => {
            this.close();
        };
        this.box.addChild(this.list);
    }

    private setState(state: UpgradeState): void {
        this.state = state;
        this.updateUI();
        this.openDeskTUI.tui.requestRender();
        if (this.list) {
            this.openDeskTUI.tui.setFocus(this.list);
        }
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }

    async show(): Promise<void> {
        if (this.openDeskTUI.deferInputPromptIfBlockedByMode(() => void this.show())) {
            return;
        }

        this.closed = false;
        const token = ++this.token;
        this.openDeskTUI.inputArea.showPromptWidget(this);
        this.openDeskTUI.hasOpenOverlay = true;

        this.setState('init');

        const version = await getCurrentVersion();
        if (this.closed || token !== this.token) {
            return;
        }
        this.currentVersion = version || 'unknown';

        this.setState('select');
    }

    private handleSelection(action: UpgradeAction): void {
        if (action === 'stable') {
            this.tag = 'latest';
            void this.checkVersion();
        } else if (action === 'nightly') {
            this.tag = 'nightly';
            void this.checkVersion();
        } else if (action === 'cancel' || action === 'close') {
            this.close();
        } else if (action === 'upgrade') {
            void this.doUpgrade();
        }
    }

    private async checkVersion(): Promise<void> {
        if (!this.tag) return;

        const token = this.token;
        this.setState('checking');

        try {
            const versionInfo = await getVersionInfo(this.tag);
            if (this.closed || token !== this.token) {
                return;
            }

            this.currentVersion = versionInfo.current || 'unknown';
            this.latestVersion = versionInfo.latest || 'unknown';

            if (!versionInfo.isNpmInstalled) {
                this.errorMessage = t('upgrade.error.not_npm');
                this.setState('error');
                return;
            }

            if (!versionInfo.needsUpdate) {
                this.setState('uptodate');
            } else {
                this.setState('confirm');
            }
        } catch (err) {
            if (this.closed || token !== this.token) {
                return;
            }
            const errorMessage = err instanceof Error ? err.message : String(err);
            this.errorMessage = t('upgrade.error.check_failed', { message: errorMessage });
            this.setState('error');
        }
    }

    private async doUpgrade(): Promise<void> {
        if (!this.tag) return;

        const token = this.token;
        this.setState('upgrading');

        try {
            const result = await performUpgrade(this.tag);
            if (this.closed || token !== this.token) {
                return;
            }

            if (result.success) {
                this.currentVersion = result.currentVersion || this.currentVersion;
                this.latestVersion = result.latestVersion || this.latestVersion;
                this.setState('success');
            } else {
                this.errorMessage = result.message;
                this.setState('error');
            }
        } catch (err) {
            if (this.closed || token !== this.token) {
                return;
            }
            const errorMessage = err instanceof Error ? err.message : String(err);
            this.errorMessage = t('upgrade.error.upgrade_failed', { message: errorMessage });
            this.setState('error');
        }
    }

    private close(): void {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.token++;
        const restored = this.openDeskTUI.closeInputPrompt(this);
        this.openDeskTUI.focusAfterInputPromptClose(restored);
    }
}
