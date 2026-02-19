import chalk from 'chalk';
import { type Component, visibleWidth, truncateToWidth } from '@mariozechner/pi-tui';

/**
 * Strip control characters that break terminal card rendering.
 * \r  → remove (carriage return repositions cursor)
 * \t  → 3 spaces (match pi-tui visibleWidth behaviour)
 * other C0 controls (except \x1b for ANSI) → remove
 */
function sanitizeLine(line: string): string {
    // eslint-disable-next-line no-control-regex
    return line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\r]/g, '').replace(/\t/g, '   ');
}


export interface CardStatus {
    icon: string;
    text: string;
}

/**
 * 行裁剪策略：
 *  - 'head'      保留前部，尾部折叠
 *  - 'tail'      保留尾部，头部折叠
 *  - 'head-tail' 头尾各保留一部分，中间折叠
 */
export type TruncateStrategy = 'head' | 'tail' | 'head-tail';

export interface CardOptions {
    /** 图标，显示在标题左侧 */
    icon?: string;
    /** 标题文字 */
    title: string;
    /** 右上角状态指示器 */
    status?: CardStatus;
    /** 初始内容行 */
    body?: string[];
    /** 折叠模式：隐藏所有内容行 */
    collapsed?: boolean;
    /** 最大显示行数（含省略提示行），undefined 则不限制 */
    maxLines?: number;
    /** 超出 maxLines 时的裁剪策略，默认 'tail' */
    truncateStrategy?: TruncateStrategy;
}

/**
 * 通用圆角卡片组件，可在终端中渲染为带边框的信息面板。
 *
 * ```
 * ╭─ icon title ───────── status ─╮
 * │ body line 1                   │
 * │ body line 2                   │
 * ╰───────────────────────────────╯
 * ```
 */
export class Card implements Component {

    private _icon: string;
    private _title: string;
    private _status?: CardStatus;
    private _body: string[];
    private _collapsed: boolean;
    private _maxLines?: number;
    private _truncateStrategy: TruncateStrategy;

    constructor(options: CardOptions) {
        this._icon = options.icon ?? '';
        this._title = options.title;
        this._status = options.status;
        this._body = options.body ?? [];
        this._collapsed = options.collapsed ?? false;
        this._maxLines = options.maxLines;
        this._truncateStrategy = options.truncateStrategy ?? 'tail';
    }

    setIcon(icon: string) { this._icon = icon; }
    setTitle(title: string) { this._title = title; }
    setStatus(status?: CardStatus) { this._status = status; }
    setBody(lines: string[]) { this._body = lines; }
    setCollapsed(collapsed: boolean) { this._collapsed = collapsed; }
    setMaxLines(maxLines?: number) { this._maxLines = maxLines; }
    setTruncateStrategy(strategy: TruncateStrategy) { this._truncateStrategy = strategy; }

    invalidate() {}

    render(width: number): string[] {
        const dim = (s: string) => chalk.dim(s);
        const contentWidth = Math.max(1, width - 4);
        const result: string[] = [];

        result.push(this.renderHeader(width));

        if (!this._collapsed) {
            const flatBody = this._body.flatMap(l => l.split('\n'));
            const displayLines = this.applyTruncation(flatBody);
            for (const raw of displayLines) {
                const line = sanitizeLine(raw);
                const padded = truncateToWidth(line, contentWidth, '…', true);
                result.push(dim('│') + ' ' + padded + ' ' + dim('│'));
            }
        }

        result.push(dim('╰' + '─'.repeat(Math.max(0, width - 2)) + '╯'));

        return result.map(l => truncateToWidth(l, width, '…', true));
    }

    // ───────────────────── Header ─────────────────────

    private renderHeader(width: number): string {
        const dim = (s: string) => chalk.dim(s);
        const titleContent = this._icon
            ? `${this._icon} ${chalk.bold(this._title)}`
            : chalk.bold(this._title);

        const prefix = dim('╭─ ');
        const suffix = dim(' ─╮');
        const prefixVis = visibleWidth(prefix);
        const suffixVis = visibleWidth(suffix);
        const titleVis = visibleWidth(titleContent);

        if (this._status) {
            const statusContent = `${this._status.icon} ${this._status.text}`;
            const statusVis = visibleWidth(statusContent);
            const fixedParts = prefixVis + titleVis + 1 + statusVis + suffixVis;

            if (fixedParts >= width) {
                const maxTitleVis = Math.max(1, width - prefixVis - suffixVis);
                return prefix + truncateToWidth(titleContent, maxTitleVis, '…') + suffix;
            }

            const fillLen = width - fixedParts;
            return (
                prefix + titleContent + ' ' +
                dim('─'.repeat(fillLen)) +
                statusContent + suffix
            );
        }

        // 无状态指示器
        const fixedParts = prefixVis + titleVis + 1 + suffixVis;
        if (fixedParts >= width) {
            const maxTitleVis = Math.max(1, width - prefixVis - suffixVis);
            return prefix + truncateToWidth(titleContent, maxTitleVis, '…') + suffix;
        }

        const fillLen = width - fixedParts;
        return prefix + titleContent + ' ' + dim('─'.repeat(fillLen)) + suffix;
    }

    // ───────────────────── 行裁剪 ─────────────────────

    private applyTruncation(lines: string[]): string[] {
        if (this._maxLines === undefined || lines.length <= this._maxLines) return lines;
        if (this._maxLines <= 0) return [];

        const omitted = lines.length - this._maxLines + 1;
        const omitLabel = chalk.dim.italic(`  … 省略 ${omitted} 行 …`);

        switch (this._truncateStrategy) {
            case 'head': {
                const keepCount = Math.max(0, this._maxLines - 1);
                return [...lines.slice(0, keepCount), omitLabel];
            }
            case 'tail': {
                const keepCount = Math.max(0, this._maxLines - 1);
                if (keepCount === 0) return [omitLabel];
                return [omitLabel, ...lines.slice(-keepCount)];
            }
            case 'head-tail': {
                const available = Math.max(0, this._maxLines - 1);
                const headCount = Math.ceil(available / 2);
                const tailCount = available - headCount;
                const result: string[] = [];
                if (headCount > 0) result.push(...lines.slice(0, headCount));
                result.push(omitLabel);
                if (tailCount > 0) result.push(...lines.slice(-tailCount));
                return result;
            }
        }
    }
}
