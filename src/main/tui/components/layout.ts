import type { Component } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";

export interface VerticalLayoutPadding {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
}

/** 水平对齐：行内内容在可用宽度内的对齐方式 */
export type HorizontalAlign = "left" | "center" | "right";

/** 垂直对齐：当总行数小于 minLines 时，多余空行的分布 */
export type VerticalAlign = "top" | "center" | "bottom";

export interface VerticalLayoutOptions {
    /** 最小行数，不足时按 verticalAlign 补空行 */
    minLines?: number;
    /** 四边内边距，可传数字（四边相同）或分别指定 top/right/bottom/left */
    padding?: number | VerticalLayoutPadding;
    /** 子组件之间的空行数 */
    spacing?: number;
    /** 水平对齐（行内内容） */
    alignHorizontal?: HorizontalAlign;
    /** 垂直对齐（minLines 产生的空行分布） */
    alignVertical?: VerticalAlign;
}

function normalizePadding(padding: number | VerticalLayoutPadding | undefined): { top: number; right: number; bottom: number; left: number } {
    if (padding === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
    if (typeof padding === "number") {
        const n = Math.max(0, padding);
        return { top: n, right: n, bottom: n, left: n };
    }
    return {
        top: Math.max(0, padding.top ?? 0),
        right: Math.max(0, padding.right ?? 0),
        bottom: Math.max(0, padding.bottom ?? 0),
        left: Math.max(0, padding.left ?? 0),
    };
}

/**
 * 垂直布局容器：子组件按顺序从上到下排列，支持四边 padding、子组件间距、最小高度与水平/垂直对齐。
 */
export class VerticalLayout implements Component {
    readonly children: Component[] = [];
    private minLines: number;
    private padding: { top: number; right: number; bottom: number; left: number };
    private spacing: number;
    private alignHorizontal: HorizontalAlign;
    private alignVertical: VerticalAlign;

    constructor(options: VerticalLayoutOptions = {}) {
        this.minLines = options.minLines ?? 0;
        this.padding = normalizePadding(options.padding);
        this.spacing = Math.max(0, options.spacing ?? 0);
        this.alignHorizontal = options.alignHorizontal ?? "left";
        this.alignVertical = options.alignVertical ?? "top";
    }

    addChild(component: Component): void {
        this.children.push(component);
    }

    removeChild(component: Component): void {
        const index = this.children.indexOf(component);
        if (index !== -1) {
            this.children.splice(index, 1);
        }
    }

    clear(): void {
        this.children.length = 0;
    }

    setMinLines(lines: number): void {
        this.minLines = Math.max(0, lines);
    }

    setPadding(padding: number | VerticalLayoutPadding): void {
        this.padding = normalizePadding(padding);
    }

    setSpacing(lines: number): void {
        this.spacing = Math.max(0, lines);
    }

    setHorizontalAlign(align: HorizontalAlign): void {
        this.alignHorizontal = align;
    }

    setVerticalAlign(align: VerticalAlign): void {
        this.alignVertical = align;
    }

    invalidate(): void {
        for (const child of this.children) {
            child.invalidate?.();
        }
    }

    render(width: number): string[] {
        const { top: padT, right: padR, bottom: padB, left: padL } = this.padding;
        const contentWidth = Math.max(1, width - padL - padR);
        const emptyLine = " ".repeat(width);

        const contentLines: string[] = [];

        // 上 padding
        for (let i = 0; i < padT; i++) contentLines.push(emptyLine);

        for (let c = 0; c < this.children.length; c++) {
            if (c > 0 && this.spacing > 0) {
                for (let i = 0; i < this.spacing; i++) contentLines.push(emptyLine);
            }
            const childLines = this.children[c].render(contentWidth);
            for (const line of childLines) {
                const vis = visibleWidth(line);
                let leftPad: number;
                if (this.alignHorizontal === "left") {
                    leftPad = padL;
                } else if (this.alignHorizontal === "center") {
                    leftPad = padL + Math.max(0, Math.floor((contentWidth - vis) / 2));
                } else {
                    leftPad = width - padR - vis;
                }
                const rightPad = Math.max(0, width - leftPad - vis);
                contentLines.push(" ".repeat(leftPad) + line + " ".repeat(rightPad));
            }
        }

        // 下 padding
        for (let i = 0; i < padB; i++) contentLines.push(emptyLine);

        const minPad = Math.max(0, this.minLines - contentLines.length);
        if (minPad <= 0) return contentLines;

        if (this.alignVertical === "top") {
            return [...contentLines, ...Array(minPad).fill(emptyLine)];
        }
        if (this.alignVertical === "bottom") {
            return [...Array(minPad).fill(emptyLine), ...contentLines];
        }
        // center
        const topExtra = Math.floor(minPad / 2);
        const bottomExtra = minPad - topExtra;
        return [
            ...Array(topExtra).fill(emptyLine),
            ...contentLines,
            ...Array(bottomExtra).fill(emptyLine),
        ];
    }
}
