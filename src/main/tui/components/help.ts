import { type Component, SelectList, Box, Text } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { SlashCommandRegistry } from "../commands";
import { defaultSelectListTheme } from "../theme";
import { OpenDeskTUI } from "../entry";


export class HelpOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private list: SelectList;
    private header: Text;
    private box: Box;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
        const commands = this.openDeskTUI.commandRegistry.getAll();

        const items = commands.map(cmd => {
            const cmdName = ('/' + cmd.name).padEnd(10);
            const shortcut = cmd.shortcut
                ? chalk.cyan(SlashCommandRegistry.formatKeyLabel(cmd.shortcut).padEnd(10))
                : ' '.repeat(10);
            return {
                value: cmd.name,
                label: `${chalk.bold(cmdName)}${shortcut}${cmd.description}`,
            };
        });

        this.header = new Text(chalk.bold(' 指令列表'));
        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        this.box.addChild(this.header);
        this.box.addChild(this.list);
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
        const overlayMaxHeight = Math.max(5, terminalHeight - 4);

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
        };

        this.list.onCancel = () => {
            handle.hide();
            // 标记 overlay 关闭
            this.openDeskTUI.hasOpenOverlay = false;
            this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
        };
    }
}
