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
    SelectList,
    Box,
    Text,
    Loader,
    Input,
    matchesKey,
    Key,
    isKeyRelease,
    visibleWidth
} from '@earendil-works/pi-tui';
import { defaultSelectListTheme, getOverlayColors } from '../theme';
import { OpenDeskTUI } from '../entry';
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

function closeInputPrompt(openDeskTUI: OpenDeskTUI, widget: Component): Component | null {
    return openDeskTUI.closeInputPrompt(widget);
}

function focusAfterInputPromptClose(openDeskTUI: OpenDeskTUI, restored: Component | null): void {
    openDeskTUI.focusAfterInputPromptClose(restored);
}

export interface ConfirmOptions {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    allowDuringConfig?: boolean;
    /** 如果设置，则要求用户输入该验证码才能确认 */
    challenge?: string;
    /** challenge 模式下的提示文本，${code} 会被替换为验证码 */
    challengeHint?: string;
}

export type InfoType = 'info' | 'warning' | 'error';

export interface InfoOptions {
    title: string;
    message: string;
    closeLabel?: string;
    /** 兼容旧调用；输入区 prompt 默认全宽。 */
    fullWidth?: boolean;
    /** info 类型：info/warning/error */
    type?: InfoType;
    allowDuringConfig?: boolean;
}

export class ConfirmOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private list: SelectList | null = null;
    private header: Text;
    private messageText: Text;
    private challengeHintText: Text | null = null;
    private box: Box;
    private onConfirm?: () => void;
    private onCancel?: () => void;
    private allowDuringConfig: boolean;

    // challenge 模式专用
    private challengeCode: string | null = null;
    private challengeInput: Input | null = null;
    private challengeMatched = false;
    private removeInputListener?: () => void;
    /** challenge 模式下当前焦点项索引：0=input, 1=confirm(匹配后), 2=cancel */
    private actionIndex = 0;
    /** 存储传入的按钮文案，供 renderChallenge 使用 */
    private confirmLabel: string;
    private cancelLabel: string;

    constructor(openDeskTUI: OpenDeskTUI, options: ConfirmOptions) {
        this.openDeskTUI = openDeskTUI;
        this.allowDuringConfig = options.allowDuringConfig === true;
        this.challengeCode = options.challenge ?? null;
        this.confirmLabel = options.confirmLabel || '确认';
        this.cancelLabel = options.cancelLabel || '取消';

        this.header = new Text(chalk.bold(`⚠️ ${options.title}`));
        this.messageText = new Text(options.message);

        const oc = getOverlayColors();
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex(oc.bg).hex(oc.fg)(text));
        this.box.addChild(this.header);
        this.box.addChild(new Splitter());
        this.box.addChild(new Text('')); // Empty line for spacing
        this.box.addChild(this.messageText);

        if (this.challengeCode) {
            // challenge 模式：用 Input 替代 SelectList
            const hintText = options.challengeHint ?? `请输入 ${this.challengeCode} 以确认操作`;
            this.challengeHintText = new Text(hintText);
            this.box.addChild(this.challengeHintText);
            this.challengeInput = new Input();
            this.challengeInput.onSubmit = () => {
                if (this.challengeInput?.getValue() === this.challengeCode) {
                    this.doConfirm();
                }
            };
            this.challengeMatched = false;
        } else {
            // 普通模式：使用 SelectList
            const items = [
                { value: 'confirm', label: chalk.green(this.confirmLabel) },
                { value: 'cancel', label: chalk.red(this.cancelLabel) }
            ];
            this.list = new SelectList(items, items.length, defaultSelectListTheme);
            this.box.addChild(new Text('')); // Empty line for spacing
            this.box.addChild(this.list);
        }
    }

    invalidate(): void {
        this.box.invalidate();
    }

    dispose(): void {
        this.removeInputListener?.();
        this.removeInputListener = undefined;
    }

    render(width: number): string[] {
        if (this.challengeCode && this.challengeInput) {
            // challenge 模式自定义渲染
            return this.renderChallenge(width);
        }
        return this.box.render(width);
    }

    private renderChallenge(width: number): string[] {
        const oc = getOverlayColors();
        const bgFn = (text: string) => chalk.bgHex(oc.bg).hex(oc.fg)(text);
        const lines: string[] = [];

        // Header
        const headerLines = this.header.render(width - 2);
        for (const line of headerLines) {
            lines.push(bgFn(' ' + line + ' '.repeat(Math.max(0, width - 1 - visibleWidth(line)))));
        }

        // Splitter
        const separator = '━'.repeat(width - 2);
        lines.push(bgFn(' ' + chalk.hex(oc.border)(separator) + ' '));
        lines.push(bgFn(' '.repeat(width)));

        // Message
        const msgLines = this.messageText.render(width - 4);
        for (const line of msgLines) {
            lines.push(bgFn('  ' + line + ' '.repeat(Math.max(0, width - 2 - visibleWidth(line)))));
        }

        // Challenge hint
        if (this.challengeHintText) {
            const hintLines = this.challengeHintText.render(width - 4);
            for (const line of hintLines) {
                lines.push(bgFn('  ' + line + ' '.repeat(Math.max(0, width - 2 - visibleWidth(line)))));
            }
        }

        lines.push(bgFn(' '.repeat(width)));

        // Input field
        const inputLines = this.challengeInput!.render(width - 4);
        for (const line of inputLines) {
            lines.push(bgFn('  ' + line + ' '.repeat(Math.max(0, width - 2 - visibleWidth(line)))));
        }

        lines.push(bgFn(' '.repeat(width)));

        // Actions row: confirm (only when matched) and cancel
        if (this.challengeMatched) {
            const confirmDisplay =
                this.actionIndex === 1
                    ? chalk.green.bold(`❯ ${this.confirmLabel}`)
                    : '  ' + chalk.green(this.confirmLabel);
            const cancelDisplay =
                this.actionIndex === 2 ? chalk.red.bold(`❯ ${this.cancelLabel}`) : '  ' + chalk.red(this.cancelLabel);
            const rowContent = '  ' + confirmDisplay + '    ' + cancelDisplay;
            lines.push(bgFn(rowContent + ' '.repeat(Math.max(0, width - visibleWidth(rowContent)))));
        } else {
            const cancelDisplay =
                this.actionIndex === 1 ? chalk.red.bold(`❯ ${this.cancelLabel}`) : '  ' + chalk.red(this.cancelLabel);
            const rowContent = '  ' + cancelDisplay;
            lines.push(bgFn(rowContent + ' '.repeat(Math.max(0, width - visibleWidth(rowContent)))));
        }

        lines.push(bgFn(' '.repeat(width)));
        return lines;
    }

    show(onConfirm?: () => void, onCancel?: () => void) {
        this.onConfirm = onConfirm;
        this.onCancel = onCancel;
        if (
            this.openDeskTUI.deferInputPromptIfBlockedByMode(() => this.show(onConfirm, onCancel), {
                allowDuringConfig: this.allowDuringConfig
            })
        ) {
            return;
        }

        this.openDeskTUI.inputArea.showPromptWidget(this);
        this.openDeskTUI.hasOpenOverlay = true;

        if (this.challengeCode && this.challengeInput) {
            this.actionIndex = 0;
            this.openDeskTUI.tui.setFocus(this.challengeInput);
            this.removeInputListener = this.openDeskTUI.tui.addInputListener((data: string) => {
                return this.handleChallengeInput(data);
            });
        } else if (this.list) {
            this.openDeskTUI.tui.setFocus(this.list);
            this.list.onSelect = (item) => {
                const restored = closeInputPrompt(this.openDeskTUI, this);
                focusAfterInputPromptClose(this.openDeskTUI, restored);
                if (item.value === 'confirm') {
                    this.onConfirm?.();
                } else {
                    this.onCancel?.();
                }
            };
            this.list.onCancel = () => {
                const restored = closeInputPrompt(this.openDeskTUI, this);
                focusAfterInputPromptClose(this.openDeskTUI, restored);
                this.onCancel?.();
            };
        }
    }

    private handleChallengeInput(data: string): { consume?: boolean; data?: string } | undefined {
        if (isKeyRelease(data)) {
            return { consume: true };
        }

        // Esc: cancel
        if (matchesKey(data, Key.escape)) {
            this.doCancel();
            return { consume: true };
        }

        // Tab / Down: navigate to next action
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
            const maxIndex = this.challengeMatched ? 2 : 1;
            this.actionIndex = this.actionIndex >= maxIndex ? 0 : this.actionIndex + 1;
            if (this.actionIndex === 0) {
                this.openDeskTUI.tui.setFocus(this.challengeInput);
            } else {
                this.openDeskTUI.tui.setFocus(null);
            }
            this.box.invalidate();
            this.openDeskTUI.tui.requestRender();
            return { consume: true };
        }

        // Up / Shift+Tab: navigate to previous action
        if (matchesKey(data, Key.up) || matchesKey(data, Key.shift('tab'))) {
            const maxIndex = this.challengeMatched ? 2 : 1;
            this.actionIndex = this.actionIndex <= 0 ? maxIndex : this.actionIndex - 1;
            if (this.actionIndex === 0) {
                this.openDeskTUI.tui.setFocus(this.challengeInput);
            } else {
                this.openDeskTUI.tui.setFocus(null);
            }
            this.box.invalidate();
            this.openDeskTUI.tui.requestRender();
            return { consume: true };
        }

        // Enter on cancel action
        if (matchesKey(data, Key.enter) && this.actionIndex > 0) {
            if (this.actionIndex === 1 && this.challengeMatched) {
                this.doConfirm();
            } else {
                this.doCancel();
            }
            return { consume: true };
        }

        // Pass through to Input for text editing (actionIndex === 0)
        if (this.actionIndex === 0) {
            setTimeout(() => {
                this.checkChallengeMatch();
            }, 0);
            return undefined;
        }

        return { consume: true };
    }

    private checkChallengeMatch(): void {
        if (!this.challengeInput || !this.challengeCode) return;
        const value = this.challengeInput.getValue();
        const matched = value === this.challengeCode;
        if (matched !== this.challengeMatched) {
            this.challengeMatched = matched;
            // Reset action index if we just matched (keep on input)
            if (matched) {
                this.actionIndex = 0;
            }
            this.box.invalidate();
            this.openDeskTUI.tui.requestRender();
        }
    }

    private doConfirm(): void {
        this.removeInputListener?.();
        this.removeInputListener = undefined;
        const restored = closeInputPrompt(this.openDeskTUI, this);
        focusAfterInputPromptClose(this.openDeskTUI, restored);
        this.onConfirm?.();
    }

    private doCancel(): void {
        this.removeInputListener?.();
        this.removeInputListener = undefined;
        const restored = closeInputPrompt(this.openDeskTUI, this);
        focusAfterInputPromptClose(this.openDeskTUI, restored);
        this.onCancel?.();
    }
}

export interface ProgressOptions {
    title: string;
    message: string;
}

export class ProgressOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private header: Text;
    private loader: Loader;
    private box: Box;
    private shown = false;
    private cancelled = false;
    private deferredToken = 0;

    constructor(openDeskTUI: OpenDeskTUI, options: ProgressOptions) {
        this.openDeskTUI = openDeskTUI;

        const oc = getOverlayColors();
        this.header = new Text(chalk.bold(`ℹ️ ${options.title}`));
        this.loader = new Loader(
            openDeskTUI.tui,
            (s: string) => chalk.cyan(s),
            (s: string) => chalk.hex(oc.fg)(s),
            options.message
        );
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex(oc.bg).hex(oc.fg)(text));
        this.box.addChild(this.header);
        this.box.addChild(new Splitter());
        this.box.addChild(this.loader);
        this.box.addChild(new Text(''));
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }

    show() {
        this.cancelled = false;
        const token = ++this.deferredToken;
        if (
            this.openDeskTUI.deferInputPromptIfBlockedByMode(() => {
                if (!this.cancelled && token === this.deferredToken) {
                    this.showNow();
                }
            })
        ) {
            return;
        }
        this.showNow();
    }

    private showNow() {
        this.shown = true;
        this.openDeskTUI.inputArea.showPromptWidget(this);
        this.openDeskTUI.hasOpenOverlay = true;
    }

    hide() {
        this.cancelled = true;
        this.deferredToken++;
        if (!this.shown) return;
        this.shown = false;
        this.loader.stop();
        const restored = closeInputPrompt(this.openDeskTUI, this);
        focusAfterInputPromptClose(this.openDeskTUI, restored);
    }
}

export class InfoOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private list: SelectList;
    private header: Text;
    private messageText: Text;
    private box: Box;
    private onClose?: () => void;
    private type: InfoType;
    private allowDuringConfig: boolean;

    constructor(openDeskTUI: OpenDeskTUI, options: InfoOptions) {
        this.openDeskTUI = openDeskTUI;
        this.type = options.type ?? 'info';
        this.allowDuringConfig = options.allowDuringConfig === true;

        const closeLabel = options.closeLabel || '确定';
        const icon = this.type === 'error' ? '❌' : this.type === 'warning' ? '⚠️' : 'ℹ️';

        const items = [{ value: 'close', label: chalk.cyan(closeLabel) }];

        this.header = new Text(chalk.bold(`${icon} ${options.title}`));
        this.messageText = new Text(options.message);
        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.box = new Box(1, 1);
        const oc = getOverlayColors();
        this.box.setBgFn((text: string) => chalk.bgHex(oc.bg).hex(oc.fg)(text));
        this.box.addChild(this.header);
        this.box.addChild(new Splitter());
        this.box.addChild(new Text('')); // Empty line for spacing
        this.box.addChild(this.messageText);
        this.box.addChild(new Text('')); // Empty line for spacing
        this.box.addChild(this.list);
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }

    show(onClose?: () => void) {
        this.onClose = onClose;
        if (
            this.openDeskTUI.deferInputPromptIfBlockedByMode(() => this.show(onClose), {
                allowDuringConfig: this.allowDuringConfig
            })
        ) {
            return;
        }

        this.openDeskTUI.inputArea.showPromptWidget(this);
        this.openDeskTUI.hasOpenOverlay = true;

        this.openDeskTUI.tui.setFocus(this.list);

        this.list.onSelect = () => {
            const restored = closeInputPrompt(this.openDeskTUI, this);
            focusAfterInputPromptClose(this.openDeskTUI, restored);
            this.onClose?.();
        };

        this.list.onCancel = () => {
            const restored = closeInputPrompt(this.openDeskTUI, this);
            focusAfterInputPromptClose(this.openDeskTUI, restored);
            this.onClose?.();
        };
    }
}

/**
 * 内联信息页面（非浮层），类似 /config 风格：替换主容器内容展示，按 Enter/Esc 退出。
 */
export class InfoPage implements Component {
    private openDeskTUI: OpenDeskTUI;
    private list: SelectList;
    private box: Box;

    constructor(openDeskTUI: OpenDeskTUI, title: string, message: string, onClose: () => void) {
        this.openDeskTUI = openDeskTUI;

        const items = [{ value: 'close', label: chalk.cyan('确定') }];
        this.list = new SelectList(items, items.length, defaultSelectListTheme);

        this.box = new Box(1, 1);
        this.box.addChild(new Text(chalk.bold(title)));
        this.box.addChild(new Splitter());
        this.box.addChild(new Text(''));
        this.box.addChild(new Text(message));
        this.box.addChild(new Text(''));
        this.box.addChild(this.list);

        this.list.onSelect = () => onClose();
        this.list.onCancel = () => onClose();

        setTimeout(() => {
            this.openDeskTUI.tui.setFocus(this.list);
            this.openDeskTUI.tui.requestRender();
        }, 10);
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }
}
