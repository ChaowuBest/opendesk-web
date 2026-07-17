import type { Component } from '@earendil-works/pi-tui';
import { visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';

export interface VerticalLayoutPadding {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
}

/** 水平对齐：行内内容在可用宽度内的对齐方式 */
export type HorizontalAlign = 'left' | 'center' | 'right';

/** 垂直对齐：当总行数小于 minLines 时，多余空行的分布 */
export type VerticalAlign = 'top' | 'center' | 'bottom';

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

function normalizePadding(padding: number | VerticalLayoutPadding | undefined): {
    top: number;
    right: number;
    bottom: number;
    left: number;
} {
    if (padding === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
    if (typeof padding === 'number') {
        const n = Math.max(0, padding);
        return { top: n, right: n, bottom: n, left: n };
    }
    return {
        top: Math.max(0, padding.top ?? 0),
        right: Math.max(0, padding.right ?? 0),
        bottom: Math.max(0, padding.bottom ?? 0),
        left: Math.max(0, padding.left ?? 0)
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

    /**
     * 渲染缓存：存储每个子组件的原始输出和对应的已处理行。
     * 当子组件输出未变化时直接复用已处理行，跳过 visibleWidth 调用。
     */
    private cache?: {
        childOutputs: string[][];
        processedLines: string[][];
        width: number;
        minLines: number;
    };

    constructor(options: VerticalLayoutOptions = {}) {
        this.minLines = options.minLines ?? 0;
        this.padding = normalizePadding(options.padding);
        this.spacing = Math.max(0, options.spacing ?? 0);
        this.alignHorizontal = options.alignHorizontal ?? 'left';
        this.alignVertical = options.alignVertical ?? 'top';
    }

    addChild(component: Component): void {
        this.children.push(component);
        this.cache = undefined;
    }

    removeChild(component: Component): void {
        const index = this.children.indexOf(component);
        if (index !== -1) {
            this.children.splice(index, 1);
            this.cache = undefined;
        }
    }

    clear(): void {
        this.children.length = 0;
        this.cache = undefined;
    }

    setMinLines(lines: number): void {
        this.minLines = Math.max(0, lines);
        this.cache = undefined;
    }

    setPadding(padding: number | VerticalLayoutPadding): void {
        this.padding = normalizePadding(padding);
        this.cache = undefined;
    }

    setSpacing(lines: number): void {
        this.spacing = Math.max(0, lines ?? 0);
        this.cache = undefined;
    }

    setHorizontalAlign(align: HorizontalAlign): void {
        this.alignHorizontal = align;
        this.cache = undefined;
    }

    setVerticalAlign(align: VerticalAlign): void {
        this.alignVertical = align;
        this.cache = undefined;
    }

    invalidate(): void {
        this.cache = undefined;
        for (const child of this.children) {
            child.invalidate?.();
        }
    }

    render(width: number): string[] {
        const { top: padT, right: padR, bottom: padB, left: padL } = this.padding;
        const contentWidth = Math.max(1, width - padL - padR);
        const emptyLine = ' '.repeat(width);

        // 渲染所有子组件，收集原始输出
        const childOutputs: string[][] = [];
        for (let c = 0; c < this.children.length; c++) {
            childOutputs.push(this.children[c].render(contentWidth));
        }

        const cache = this.cache;
        const configMatch =
            cache?.width === width &&
            cache?.minLines === this.minLines &&
            cache.childOutputs.length === this.children.length;

        // 逐子组件检测输出是否变化，未变化则复用缓存的已处理行
        const processedLines: string[][] = [];
        for (let c = 0; c < childOutputs.length; c++) {
            const cur = childOutputs[c];
            const old = configMatch && cache && c < cache.childOutputs.length ? cache.childOutputs[c] : undefined;
            if (old && cur.length === old.length && cur.every((line, i) => line === old[i])) {
                processedLines.push(cache.processedLines[c]);
            } else {
                processedLines.push(this.processChildLines(cur, width, padL, padR, contentWidth));
            }
        }

        const result = this.assembleFinalLines(processedLines, emptyLine, padT, padB);
        this.cache = { childOutputs, processedLines, width, minLines: this.minLines };
        return result;
    }

    /** 处理单个子组件的输出行：应用前缀、对齐、安全截断。 */
    private processChildLines(
        childLines: string[],
        width: number,
        padL: number,
        padR: number,
        contentWidth: number
    ): string[] {
        const isLeftAligned = this.alignHorizontal === 'left';
        const leftPrefix = padL > 0 ? ' '.repeat(padL) : '';
        const result: string[] = [];

        if (isLeftAligned) {
            for (const line of childLines) {
                const combined = leftPrefix + line;
                // 安全截断：防止子组件输出超过总宽度
                if (visibleWidth(combined) > width) {
                    result.push(truncateToWidth(combined, width));
                } else {
                    result.push(combined);
                }
            }
        } else {
            for (const line of childLines) {
                const vis = visibleWidth(line);
                let leftPad: number;
                if (this.alignHorizontal === 'center') {
                    leftPad = padL + Math.max(0, Math.floor((contentWidth - vis) / 2));
                } else {
                    leftPad = width - padR - vis;
                }
                const rightPad = Math.max(0, width - leftPad - vis);
                const assembled = ' '.repeat(leftPad) + line + ' '.repeat(rightPad);
                if (visibleWidth(assembled) > width) {
                    result.push(truncateToWidth(assembled, width));
                } else {
                    result.push(assembled);
                }
            }
        }
        return result;
    }

    /** 将各子组件的已处理行拼接为最终输出，加上 padding、spacing 和 minLines 补齐。 */
    private assembleFinalLines(processedLines: string[][], emptyLine: string, padT: number, padB: number): string[] {
        const contentLines: string[] = [];
        for (let i = 0; i < padT; i++) contentLines.push(emptyLine);

        for (let c = 0; c < processedLines.length; c++) {
            if (c > 0 && this.spacing > 0) {
                for (let i = 0; i < this.spacing; i++) contentLines.push(emptyLine);
            }
            for (const line of processedLines[c]) {
                contentLines.push(line);
            }
        }

        for (let i = 0; i < padB; i++) contentLines.push(emptyLine);

        const minPad = Math.max(0, this.minLines - contentLines.length);
        if (minPad <= 0) return contentLines;

        if (this.alignVertical === 'top') {
            return [...contentLines, ...Array(minPad).fill(emptyLine)];
        }
        if (this.alignVertical === 'bottom') {
            return [...Array(minPad).fill(emptyLine), ...contentLines];
        }
        // center
        const topExtra = Math.floor(minPad / 2);
        const bottomExtra = minPad - topExtra;
        return [...Array(topExtra).fill(emptyLine), ...contentLines, ...Array(bottomExtra).fill(emptyLine)];
    }
}

export interface HorizontalLayoutOptions {
    /** 最小行数，不足时在底部补空行 */
    minLines?: number;
    /** 四边内边距 */
    padding?: number | VerticalLayoutPadding;
    /** 子组件之间的水平间距（列数） */
    spacing?: number;
    /** 垂直对齐：不同高度的子组件在行内的对齐方式 */
    alignVertical?: VerticalAlign;
}

/**
 * 水平布局容器：子组件按顺序从左到右排列，支持权重分配宽度、四边 padding、子组件间距与垂直对齐。
 */
export class HorizontalLayout implements Component {
    readonly children: { component: Component; weight: number }[] = [];
    private minLines: number;
    private padding: { top: number; right: number; bottom: number; left: number };
    private spacing: number;
    private alignVertical: VerticalAlign;

    constructor(options: HorizontalLayoutOptions = {}) {
        this.minLines = options.minLines ?? 0;
        this.padding = normalizePadding(options.padding);
        this.spacing = Math.max(0, options.spacing ?? 0);
        this.alignVertical = options.alignVertical ?? 'top';
    }

    /** 添加子组件，weight 决定该组件分配到的宽度比例（默认 1） */
    addChild(component: Component, weight: number = 1): void {
        this.children.push({ component, weight: Math.max(0, weight) });
    }

    removeChild(component: Component): void {
        const index = this.children.findIndex((c) => c.component === component);
        if (index !== -1) {
            this.children.splice(index, 1);
        }
    }

    clear(): void {
        this.children.length = 0;
    }

    setMinLines(lines: number): void {
        this.minLines = Math.max(0, lines);
        this.invalidate();
    }

    setPadding(padding: number | VerticalLayoutPadding): void {
        this.padding = normalizePadding(padding);
    }

    setSpacing(columns: number): void {
        this.spacing = Math.max(0, columns);
    }

    setVerticalAlign(align: VerticalAlign): void {
        this.alignVertical = align;
    }

    invalidate(): void {
        for (const { component } of this.children) {
            component.invalidate?.();
        }
    }

    render(width: number): string[] {
        const { top: padT, right: padR, bottom: padB, left: padL } = this.padding;
        const contentWidth = Math.max(1, width - padL - padR);
        const emptyLine = ' '.repeat(width);

        if (this.children.length === 0) {
            const lines: string[] = [];
            for (let i = 0; i < padT + padB; i++) lines.push(emptyLine);
            while (lines.length < this.minLines) lines.push(emptyLine);
            return lines;
        }

        // 计算子组件可用总宽度（减去间距）
        const totalSpacing = this.spacing * (this.children.length - 1);
        const availableWidth = Math.max(this.children.length, contentWidth - totalSpacing);

        // 按权重分配宽度
        const totalWeight = this.children.reduce((sum, c) => sum + c.weight, 0);
        const childWidths: number[] = [];
        let usedWidth = 0;
        for (let i = 0; i < this.children.length; i++) {
            if (i === this.children.length - 1) {
                childWidths.push(Math.max(1, availableWidth - usedWidth));
            } else {
                const w = Math.max(1, Math.floor((availableWidth * this.children[i].weight) / totalWeight));
                childWidths.push(w);
                usedWidth += w;
            }
        }

        // 渲染每个子组件并记录最大高度
        const childOutputs: string[][] = [];
        let maxHeight = 0;
        for (let i = 0; i < this.children.length; i++) {
            const lines = this.children[i].component.render(childWidths[i]);
            childOutputs.push(lines);
            maxHeight = Math.max(maxHeight, lines.length);
        }

        // 水平拼接
        const contentLines: string[] = [];
        for (let i = 0; i < padT; i++) contentLines.push(emptyLine);

        const spacer = ' '.repeat(this.spacing);
        for (let row = 0; row < maxHeight; row++) {
            let line = ' '.repeat(padL);
            for (let c = 0; c < this.children.length; c++) {
                if (c > 0) line += spacer;

                const output = childOutputs[c];
                const childWidth = childWidths[c];
                const childHeight = output.length;

                // 根据垂直对齐计算偏移
                let offset: number;
                if (this.alignVertical === 'top') {
                    offset = 0;
                } else if (this.alignVertical === 'bottom') {
                    offset = maxHeight - childHeight;
                } else {
                    offset = Math.floor((maxHeight - childHeight) / 2);
                }

                const childRow = row - offset;
                if (childRow >= 0 && childRow < childHeight) {
                    const cellContent = output[childRow];
                    const vis = visibleWidth(cellContent);
                    line += cellContent + ' '.repeat(Math.max(0, childWidth - vis));
                } else {
                    line += ' '.repeat(childWidth);
                }
            }

            // 补齐右侧到总宽度，并安全截断
            const vis = visibleWidth(line);
            if (vis > width) {
                contentLines.push(truncateToWidth(line, width));
            } else {
                line += ' '.repeat(Math.max(0, width - vis));
                contentLines.push(line);
            }
        }

        for (let i = 0; i < padB; i++) contentLines.push(emptyLine);

        // 处理最小行数
        while (contentLines.length < this.minLines) contentLines.push(emptyLine);
        return contentLines;
    }
}
