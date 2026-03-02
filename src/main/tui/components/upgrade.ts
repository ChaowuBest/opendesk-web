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

import { type Component, SelectList, Box, Text } from "@mariozechner/pi-tui";
import { defaultSelectListTheme } from "../theme";
import { OpenDeskTUI } from "../entry";
import { checkForUpdate, performUpgrade, getVersionInfo, getCurrentVersion } from "../../utils/upgrade.js";
import chalk from "chalk";


class Splitter implements Component {
    invalidate(): void {
        // 不需要实现
    }

    render(width: number): string[] {
        const separator = "━".repeat(width);
        return [chalk.hex('#b6b6b6')(separator)];
    }
}

type UpgradeState = 'select' | 'checking' | 'confirm' | 'upgrading' | 'success' | 'error' | 'uptodate';

export class UpgradeOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private tag: 'latest' | 'nightly' | null = null;
    private box: Box;
    private header: Text;
    private statusText: Text;
    private detailText: Text;
    private list: SelectList;

    private state: UpgradeState = 'select';
    private currentVersion: string = 'unknown';
    private latestVersion: string = 'unknown';
    private errorMessage: string = '';
    private overlayHandle: any = null;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;

        this.header = new Text('');
        this.statusText = new Text('');
        this.detailText = new Text('');
        this.list = new SelectList([], 1, defaultSelectListTheme);

        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));

        this.updateUI();
    }

    private updateUI(): void {
        // 清空 box
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));

        // 设置标题
        let title = '';
        switch (this.state) {
            case 'select':
                title = `📦 OpenDesk CLI 升级`;
                break;
            case 'checking':
                title = `🔄 检查版本更新...`;
                break;
            case 'confirm':
                title = `📦 发现新版本`;
                break;
            case 'upgrading':
                title = `⬇️ 正在升级...`;
                break;
            case 'success':
                title = `✅ 升级成功`;
                break;
            case 'error':
                title = `❌ 升级失败`;
                break;
            case 'uptodate':
                title = `✓ 已是最新版本`;
                break;
        }

        this.header = new Text(chalk.bold(title));
        this.box.addChild(this.header);
        this.box.addChild(new Splitter());
        this.box.addChild(new Text("")); // 空行

        // 状态内容
        switch (this.state) {
            case 'select':
                this.statusText = new Text(`当前版本: ${this.currentVersion === 'unknown' ? '未通过 npm 安装' : this.currentVersion}`);
                this.box.addChild(this.statusText);
                this.box.addChild(new Text("")); // 空行
                this.box.addChild(new Text("请选择要升级的版本:"));
                this.box.addChild(new Text("")); // 空行

                const selectItems = [
                    { value: "stable", label: chalk.green("Stable") + chalk.gray(" - 稳定版本") },
                    { value: "nightly", label: chalk.cyan("Nightly") + chalk.gray(" - 每日构建版本") },
                    { value: "cancel", label: chalk.red("取消") }
                ];
                this.list = new SelectList(selectItems, selectItems.length, defaultSelectListTheme);
                this.box.addChild(this.list);
                break;

            case 'checking':
                const tagLabel = this.tag === 'nightly' ? 'Nightly' : 'Stable';
                this.statusText = new Text(chalk.cyan(`正在检查 ${tagLabel} 版本...`));
                this.box.addChild(this.statusText);
                break;

            case 'confirm':
                const confirmTagLabel = this.tag === 'nightly' ? 'Nightly' : 'Stable';
                this.statusText = new Text(
                    `当前版本: ${chalk.yellow(this.currentVersion)}\n` +
                    `最新版本: ${chalk.green(this.latestVersion)}`
                );
                this.box.addChild(this.statusText);
                this.box.addChild(new Text("")); // 空行
                this.box.addChild(new Text(`是否升级到最新 ${confirmTagLabel} 版本？`));
                this.box.addChild(new Text("")); // 空行

                // 确认/取消按钮
                const confirmItems = [
                    { value: "upgrade", label: chalk.green("确认升级") },
                    { value: "cancel", label: chalk.red("取消") }
                ];
                this.list = new SelectList(confirmItems, confirmItems.length, defaultSelectListTheme);
                this.box.addChild(this.list);
                break;

            case 'upgrading':
                const upgradingTagLabel = this.tag === 'nightly' ? 'Nightly' : 'Stable';
                this.statusText = new Text(chalk.cyan(`正在下载并安装 ${upgradingTagLabel} 版本...`));
                this.box.addChild(this.statusText);
                this.box.addChild(new Text("")); // 空行
                this.detailText = new Text(chalk.gray('请稍候，这可能需要几分钟时间'));
                this.box.addChild(this.detailText);
                break;

            case 'success':
                this.statusText = new Text(
                    `${chalk.yellow(this.currentVersion)} → ${chalk.green(this.latestVersion)}`
                );
                this.box.addChild(this.statusText);
                this.box.addChild(new Text("")); // 空行
                this.box.addChild(new Text(chalk.green('请重启 OpenDesk 以使用新版本')));
                this.box.addChild(new Text("")); // 空行

                const closeItems = [
                    { value: "close", label: chalk.cyan("关闭") }
                ];
                this.list = new SelectList(closeItems, closeItems.length, defaultSelectListTheme);
                this.box.addChild(this.list);
                break;

            case 'error':
                this.statusText = new Text(chalk.red(this.errorMessage));
                this.box.addChild(this.statusText);
                this.box.addChild(new Text("")); // 空行

                const errorItems = [
                    { value: "close", label: chalk.cyan("关闭") }
                ];
                this.list = new SelectList(errorItems, errorItems.length, defaultSelectListTheme);
                this.box.addChild(this.list);
                break;

            case 'uptodate':
                const uptodateTagLabel = this.tag === 'nightly' ? 'Nightly' : 'Stable';
                this.statusText = new Text(
                    `当前版本: ${chalk.green(this.currentVersion)}\n` +
                    `已是最新 ${uptodateTagLabel} 版本`
                );
                this.box.addChild(this.statusText);
                this.box.addChild(new Text("")); // 空行

                const okItems = [
                    { value: "close", label: chalk.cyan("确定") }
                ];
                this.list = new SelectList(okItems, okItems.length, defaultSelectListTheme);
                this.box.addChild(this.list);
                break;
        }

        this.box.invalidate();
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }

    async show(): Promise<void> {
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const terminalHeight = this.openDeskTUI.tui.terminal.rows;
        const overlayWidth = Math.min(60, terminalWidth - 4);
        const overlayMaxHeight = Math.max(12, terminalHeight - 4);

        this.overlayHandle = this.openDeskTUI.tui.showOverlay(this, {
            width: overlayWidth,
            maxHeight: overlayMaxHeight,
            anchor: "center",
        });

        // 标记有 overlay 打开
        this.openDeskTUI.hasOpenOverlay = true;

        // 获取当前版本
        const version = await getCurrentVersion();
        this.currentVersion = version || 'unknown';

        // 显示选择界面
        this.state = 'select';
        this.updateUI();
        this.openDeskTUI.tui.setFocus(this.list);
        this.setupSelectHandlers();
    }

    private setupSelectHandlers(): void {
        this.list.onSelect = (item) => {
            if (item.value === 'stable') {
                this.tag = 'latest';
                this.checkVersion();
            } else if (item.value === 'nightly') {
                this.tag = 'nightly';
                this.checkVersion();
            } else if (item.value === 'cancel' || item.value === 'close') {
                this.close();
            } else if (item.value === 'upgrade') {
                this.doUpgrade();
            }
        };

        this.list.onCancel = () => {
            this.close();
        };
    }

    private async checkVersion(): Promise<void> {
        if (!this.tag) return;

        this.state = 'checking';
        this.updateUI();
        this.openDeskTUI.tui.requestRender();

        try {
            // 获取版本信息
            const versionInfo = await getVersionInfo(this.tag);
            this.currentVersion = versionInfo.current || 'unknown';
            this.latestVersion = versionInfo.latest || 'unknown';

            // 检查是否通过 npm 安装
            if (!versionInfo.isNpmInstalled) {
                this.state = 'error';
                this.errorMessage = '当前 OpenDesk 未通过 npm 全局安装\n无法使用自动升级功能\n\n请使用以下命令安装:\nnpm install -g @bitclub.ai/opendesk-cli';
                this.updateUI();
                this.openDeskTUI.tui.setFocus(this.list);
                this.setupSelectHandlers();
                return;
            }

            if (!versionInfo.needsUpdate) {
                // 已是最新版本
                this.state = 'uptodate';
                this.updateUI();
                this.openDeskTUI.tui.setFocus(this.list);
                this.setupSelectHandlers();
            } else {
                // 发现新版本，显示确认界面
                this.state = 'confirm';
                this.updateUI();
                this.openDeskTUI.tui.setFocus(this.list);
                this.setupSelectHandlers();
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            this.state = 'error';
            this.errorMessage = `检查版本失败: ${errorMessage}`;
            this.updateUI();
            this.openDeskTUI.tui.setFocus(this.list);
            this.setupSelectHandlers();
        }
    }

    private async doUpgrade(): Promise<void> {
        if (!this.tag) return;

        this.state = 'upgrading';
        this.updateUI();
        this.openDeskTUI.tui.requestRender();

        try {
            const result = await performUpgrade(this.tag);

            if (result.success) {
                this.state = 'success';
                this.currentVersion = result.currentVersion || this.currentVersion;
                this.latestVersion = result.latestVersion || this.latestVersion;
            } else {
                this.state = 'error';
                this.errorMessage = result.message;
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            this.state = 'error';
            this.errorMessage = `升级失败: ${errorMessage}`;
        }

        this.updateUI();
        this.openDeskTUI.tui.setFocus(this.list);

        // 重新设置按钮处理器
        this.list.onSelect = () => {
            this.close();
        };
        this.list.onCancel = () => {
            this.close();
        };
    }

    private close(): void {
        if (this.overlayHandle) {
            this.overlayHandle.hide();
        }
        // 标记 overlay 关闭
        this.openDeskTUI.hasOpenOverlay = false;
        this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
    }
}