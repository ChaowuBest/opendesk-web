import { visibleWidth, type Component } from "@mariozechner/pi-tui";

/** 将多行文本在给定宽度内居中显示的组件 */
export class CenteredText implements Component {
    constructor(private text: string) {}
    invalidate() {}
    render(width: number): string[] {
        const lines = this.text.trim().split("\n");
        return lines.map((line) => {
            const lineWidth = visibleWidth(line);
            const leftPad = Math.max(0, Math.floor((width - lineWidth) / 2));
            const padded = " ".repeat(leftPad) + line;
            const rightPad = Math.max(0, width - visibleWidth(padded));
            return padded + " ".repeat(rightPad);
        });
    }
}