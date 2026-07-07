import { type Component, SelectList, Box, Text, Loader } from '../pi-tui.js';
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
    private list: SelectList;
    private header: Text;
    private messageText: Text;
    private box: Box;
    private onConfirm?: () => void;
    private onCancel?: () => void;
    private allowDuringConfig: boolean;

    constructor(openDeskTUI: OpenDeskTUI, options: ConfirmOptions) {
        this.openDeskTUI = openDeskTUI;
        this.allowDuringConfig = options.allowDuringConfig === true;

        const confirmLabel = options.confirmLabel || '确认';
        const cancelLabel = options.cancelLabel || '取消';

        const items = [
            { value: 'confirm', label: chalk.green(confirmLabel) },
            { value: 'cancel', label: chalk.red(cancelLabel) }
        ];

        this.header = new Text(chalk.bold(`⚠️ ${options.title}`));
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
