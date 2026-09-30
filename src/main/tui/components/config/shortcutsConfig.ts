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

import {
    type Component,
    type TUI,
    Key,
    matchesKey,
    isKeyRelease,
    parseKey,
    visibleWidth,
    type KeyId
} from '@earendil-works/pi-tui';
import { Setting, DEFAULT_SHORTCUTS, type ShortcutsConfig } from '../../../utils/setting.js';
import { SlashCommandRegistry } from '../../commands/base.js';
import { InfoOverlay } from '../notice.js';
import { OpenDeskTUI } from '../../entry.js';
import chalk from 'chalk';
import { t } from '../../../../locale/index.js';

interface ShortcutItem {
    key: keyof ShortcutsConfig;
    descriptionKey: string;
    defaultValue: string;
    currentValue: string;
}

type PageState = 'list' | 'capturing' | 'confirming';

/**
 * 快捷键设置二级页面。
 * 列出所有可配置的快捷键，支持按键捕获、恢复默认。
 */
export class ShortcutsConfigPage implements Component {
    private openDeskTUI: OpenDeskTUI;
    private tui: TUI;
    private onBack: () => void;
    private removeInputListener?: () => void;

    private items: ShortcutItem[];
    private activeIndex = 0;
    private state: PageState = 'list';
    private capturedKey: string = '';

    constructor(openDeskTUI: OpenDeskTUI, onBack: () => void) {
        this.openDeskTUI = openDeskTUI;
        this.tui = openDeskTUI.tui;
        this.onBack = onBack;

        const shortcuts = this.loadShortcuts();
        this.items = [
            {
                key: 'switch_mode',
                descriptionKey: 'shortcut.switch_mode',
                defaultValue: DEFAULT_SHORTCUTS.switch_mode,
                currentValue: shortcuts.switch_mode
            },
            {
                key: 'output_display',
                descriptionKey: 'shortcut.output_display',
                defaultValue: DEFAULT_SHORTCUTS.output_display,
                currentValue: shortcuts.output_display
            },
            {
                key: 'switch_model',
                descriptionKey: 'shortcut.switch_model',
                defaultValue: DEFAULT_SHORTCUTS.switch_model,
                currentValue: shortcuts.switch_model
            },
            {
                key: 'endline',
                descriptionKey: 'shortcut.endline',
                defaultValue: DEFAULT_SHORTCUTS.endline,
                currentValue: shortcuts.endline
            },
            {
                key: 'show_help',
                descriptionKey: 'shortcut.show_help',
                defaultValue: DEFAULT_SHORTCUTS.show_help,
                currentValue: shortcuts.show_help
            },
            {
                key: 'clear_input',
                descriptionKey: 'shortcut.clear_input',
                defaultValue: DEFAULT_SHORTCUTS.clear_input,
                currentValue: shortcuts.clear_input
            },
            {
                key: 'list_tasks',
                descriptionKey: 'shortcut.list_tasks',
                defaultValue: DEFAULT_SHORTCUTS.list_tasks,
                currentValue: shortcuts.list_tasks
            }
        ];

        this.activate();
    }

    private loadShortcuts(): ShortcutsConfig {
        const data = Setting.getInstance().getData() as any;
        return {
            switch_mode: data.cli_config?.shortcuts?.switch_mode ?? DEFAULT_SHORTCUTS.switch_mode,
            output_display: data.cli_config?.shortcuts?.output_display ?? DEFAULT_SHORTCUTS.output_display,
            switch_model: data.cli_config?.shortcuts?.switch_model ?? DEFAULT_SHORTCUTS.switch_model,
            endline: data.cli_config?.shortcuts?.endline ?? DEFAULT_SHORTCUTS.endline,
            show_help: data.cli_config?.shortcuts?.show_help ?? DEFAULT_SHORTCUTS.show_help,
            clear_input: data.cli_config?.shortcuts?.clear_input ?? DEFAULT_SHORTCUTS.clear_input,
            list_tasks: data.cli_config?.shortcuts?.list_tasks ?? DEFAULT_SHORTCUTS.list_tasks
        };
    }

    private activate() {
        this.tui.setFocus(null);
        this.removeInputListener = this.tui.addInputListener((data: string) => {
            return this.handleInput(data);
        });
        this.tui.requestRender();
    }

    private deactivate() {
        this.removeInputListener?.();
        this.removeInputListener = undefined;
    }

    handleInput(data: string): { consume?: boolean; data?: string } | undefined {
        if (isKeyRelease(data)) {
            if (this.state === 'capturing') {
                // 按键松开，完成捕获（仅在已有捕获内容时）
                if (this.capturedKey) {
                    this.state = 'confirming';
                    this.tui.requestRender();
                }
            }
            return { consume: true };
        }

        if (this.state === 'capturing') {
            return this.handleCapturing(data);
        }
        if (this.state === 'confirming') {
            return this.handleConfirming(data);
        }
        return this.handleList(data);
    }

    private handleList(data: string): { consume?: boolean } | undefined {
        if (matchesKey(data, Key.up)) {
            if (this.activeIndex > 0) {
                this.activeIndex--;
                this.tui.requestRender();
            }
            return { consume: true };
        }
        if (matchesKey(data, Key.down)) {
            if (this.activeIndex < this.items.length - 1) {
                this.activeIndex++;
                this.tui.requestRender();
            }
            return { consume: true };
        }
        if (matchesKey(data, Key.enter)) {
            this.state = 'capturing';
            this.capturedKey = '';
            this.tui.requestRender();
            return { consume: true };
        }
        if (matchesKey(data, 'd' as KeyId) || matchesKey(data, 'D' as KeyId)) {
            const item = this.items[this.activeIndex];
            item.currentValue = item.defaultValue;
            this.saveAndClose();
            return { consume: true };
        }
        if (matchesKey(data, Key.escape)) {
            this.deactivate();
            this.onBack();
            return { consume: true };
        }
        return { consume: true };
    }

    private handleCapturing(data: string): { consume?: boolean } | undefined {
        // 将捕获到的按键数据解析为 KeyId 并显示
        const keyId = this.parseKeyId(data);
        if (keyId) {
            this.capturedKey = keyId;
            // 对于非 Kitty 终端，没有 key release 事件，直接进入确认
            this.state = 'confirming';
            this.tui.requestRender();
        }
        return { consume: true };
    }

    private handleConfirming(data: string): { consume?: boolean } | undefined {
        if (matchesKey(data, Key.enter)) {
            // 验证：不允许单个按键
            if (this.isSingleKey(this.capturedKey)) {
                // 先移除输入监听器，让 InfoOverlay 能接收按键
                this.deactivate();
                const info = new InfoOverlay(this.openDeskTUI, {
                    title: t('config.shortcuts.error.single_key.title'),
                    message: t('config.shortcuts.error.single_key.message'),
                    type: 'error',
                    allowDuringConfig: true
                });
                info.show(() => {
                    // InfoOverlay 关闭后，重新激活输入监听器
                    this.activate();
                    // 回到列表状态
                    this.state = 'list';
                    this.capturedKey = '';
                    this.tui.requestRender();
                });
                return { consume: true };
            }
            // 确认保存
            this.items[this.activeIndex].currentValue = this.capturedKey;
            this.saveAndClose();
            return { consume: true };
        }
        if (matchesKey(data, Key.escape)) {
            // 取消，回到列表
            this.state = 'list';
            this.capturedKey = '';
            this.tui.requestRender();
            return { consume: true };
        }
        if (matchesKey(data, 'd' as KeyId) || matchesKey(data, 'D' as KeyId)) {
            // 恢复默认
            const item = this.items[this.activeIndex];
            this.capturedKey = item.defaultValue;
            this.tui.requestRender();
            return { consume: true };
        }
        return { consume: true };
    }

    /**
     * 判断是否是单个按键（没有修饰键）。
     * 单个按键格式：a, b, enter, escape, tab 等
     * 组合键格式：ctrl+a, alt+b, shift+tab 等
     */
    private isSingleKey(keyId: string): boolean {
        // 组合键都包含 '+' 符号
        return !keyId.includes('+');
    }

    /**
     * 尝试从原始按键数据中解析出 KeyId（pi-tui 兼容格式）。
     * 使用 pi-tui 原生的 parseKey 来确保与 matchesKey 一致的识别逻辑。
     */
    private parseKeyId(data: string): string | null {
        const parsed = parseKey(data);
        if (!parsed) return null;
        // parseKey 返回的 key id 全小写，直接可用于 matchesKey
        return parsed;
    }

    private saveAndClose() {
        const setting = Setting.getInstance();
        const data = { ...setting.getData() } as any;

        if (!data.cli_config) data.cli_config = {};
        if (!data.cli_config.shortcuts) data.cli_config.shortcuts = {};

        for (const item of this.items) {
            data.cli_config.shortcuts[item.key] = item.currentValue;
        }

        setting.setData(data);
        this.state = 'list';
        this.capturedKey = '';
        this.tui.requestRender();
    }

    invalidate() {}

    render(width: number): string[] {
        const lines: string[] = [];
        const dividerWidth = Math.min(width - 2, 50);

        lines.push(chalk.bold('🚲️  ' + t('config.shortcuts.title')));
        lines.push(chalk.dim('─'.repeat(dividerWidth)));
        lines.push('');

        // 计算标签列的最大可见宽度，用于两栏对齐
        const labels = this.items.map((item) => t(item.descriptionKey));
        const maxLabelWidth = Math.max(...labels.map((l) => visibleWidth(l)));

        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];
            const isActive = i === this.activeIndex;
            const indicator = isActive ? chalk.cyan('❯ ') : '  ';
            const rawLabel = labels[i];
            const labelPad = ' '.repeat(maxLabelWidth - visibleWidth(rawLabel));
            const label = isActive ? chalk.cyan(rawLabel) : chalk.dim(rawLabel);

            let valueDisplay: string;
            if (isActive && this.state === 'capturing') {
                valueDisplay = chalk.yellow.bold(
                    this.capturedKey
                        ? SlashCommandRegistry.formatKeyLabel(this.capturedKey)
                        : t('config.shortcuts.waiting')
                );
            } else if (isActive && this.state === 'confirming') {
                valueDisplay = chalk.green.bold(SlashCommandRegistry.formatKeyLabel(this.capturedKey));
            } else {
                const formatted = SlashCommandRegistry.formatKeyLabel(item.currentValue);
                const isDefault = item.currentValue === item.defaultValue;
                valueDisplay = isActive ? chalk.cyan.bold(formatted) : chalk.white(formatted);
                if (!isDefault) {
                    valueDisplay += chalk.dim(` (${SlashCommandRegistry.formatKeyLabel(item.defaultValue)})`);
                }
            }

            lines.push(`${indicator}${label}${labelPad}    ${valueDisplay}`);
        }

        lines.push('');

        if (this.state === 'capturing') {
            lines.push(chalk.yellow('  ' + t('config.shortcuts.waiting')));
        } else if (this.state === 'confirming') {
            lines.push(chalk.dim('  ' + t('config.shortcuts.confirm')));
        } else {
            lines.push(chalk.dim('  ' + t('config.shortcuts.hint')));
        }

        return lines;
    }
}
