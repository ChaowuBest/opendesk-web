
import { type Component, SelectList, Box, Text } from "@mariozechner/pi-tui";
import { defaultSelectListTheme } from "../theme";
import { OpenDeskTUI } from "../entry";
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


export interface ConfirmOptions {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
}

export interface InfoOptions {
    title: string;
    message: string;
    closeLabel?: string;
}

export class ConfirmOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private list: SelectList;
    private header: Text;
    private messageText: Text;
    private box: Box;
    private onConfirm?: () => void;
    private onCancel?: () => void;

    constructor(openDeskTUI: OpenDeskTUI, options: ConfirmOptions) {
        this.openDeskTUI = openDeskTUI;

        const confirmLabel = options.confirmLabel || "确认";
        const cancelLabel = options.cancelLabel || "取消";

        const items = [
            { value: "confirm", label: chalk.green(confirmLabel) },
            { value: "cancel", label: chalk.red(cancelLabel) }
        ];

        this.header = new Text(chalk.bold(`⚠️ ${options.title}`));
        this.messageText = new Text(options.message);
        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        this.box.addChild(this.header);
        this.box.addChild(new Splitter());
        this.box.addChild(new Text("")); // Empty line for spacing
        this.box.addChild(this.messageText);
        this.box.addChild(new Text("")); // Empty line for spacing
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

        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const terminalHeight = this.openDeskTUI.tui.terminal.rows;
        const overlayWidth = Math.min(60, terminalWidth - 4);
        const overlayMaxHeight = Math.max(8, terminalHeight - 4);

        const handle = this.openDeskTUI.tui.showOverlay(this, {
            width: overlayWidth,
            maxHeight: overlayMaxHeight,
            anchor: "center",
        });

        // 标记有 overlay 打开
        this.openDeskTUI.hasOpenOverlay = true;

        this.openDeskTUI.tui.setFocus(this.list);

        this.list.onSelect = (item) => {
            handle.hide();
            // 标记 overlay 关闭
            this.openDeskTUI.hasOpenOverlay = false;
            this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
            if (item.value === "confirm") {
                this.onConfirm?.();
            } else {
                this.onCancel?.();
            }
        };

        this.list.onCancel = () => {
            handle.hide();
            // 标记 overlay 关闭
            this.openDeskTUI.hasOpenOverlay = false;
            this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
            this.onCancel?.();
        };
    }
}

export class InfoOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private list: SelectList;
    private header: Text;
    private messageText: Text;
    private box: Box;
    private onClose?: () => void;

    constructor(openDeskTUI: OpenDeskTUI, options: InfoOptions) {
        this.openDeskTUI = openDeskTUI;

        const closeLabel = options.closeLabel || "确定";

        const items = [
            { value: "close", label: chalk.cyan(closeLabel) }
        ];

        this.header = new Text(chalk.bold(`ℹ️ ${options.title}`));
        this.messageText = new Text(options.message);
        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        this.box.addChild(this.header);
        this.box.addChild(new Splitter());
        this.box.addChild(new Text("")); // Empty line for spacing
        this.box.addChild(this.messageText);
        this.box.addChild(new Text("")); // Empty line for spacing
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

        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const terminalHeight = this.openDeskTUI.tui.terminal.rows;
        const overlayWidth = Math.min(60, terminalWidth - 4);
        const overlayMaxHeight = Math.max(8, terminalHeight - 4);

        const handle = this.openDeskTUI.tui.showOverlay(this, {
            width: overlayWidth,
            maxHeight: overlayMaxHeight,
            anchor: "center",
        });

        // 标记有 overlay 打开
        this.openDeskTUI.hasOpenOverlay = true;

        this.openDeskTUI.tui.setFocus(this.list);

        this.list.onSelect = () => {
            handle.hide();
            // 标记 overlay 关闭
            this.openDeskTUI.hasOpenOverlay = false;
            this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
            this.onClose?.();
        };

        this.list.onCancel = () => {
            handle.hide();
            // 标记 overlay 关闭
            this.openDeskTUI.hasOpenOverlay = false;
            this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
            this.onClose?.();
        };
    }
}
