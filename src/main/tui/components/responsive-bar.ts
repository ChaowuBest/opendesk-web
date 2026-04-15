/**
 * ResponsiveBar —— 响应式横向状态栏组件
 *
 * 将一组 cell（带可见宽度的字符串片段）以分隔符连接并居中显示。
 * 当总宽度超过可用空间时，按照从右到左的顺序逐个隐藏 cell，
 * 直到剩余内容能够放下为止。
 */

import { visibleWidth } from '@mariozechner/pi-tui';

export interface ResponsiveCell {
    /** 已经包含 ANSI 着色的完整显示字符串 */
    text: string;
    /** 预计算的可见宽度（如果没提供会自动计算） */
    width?: number;
}

export interface ResponsiveBarOptions {
    /** 分隔符（含 ANSI 颜色），默认 " │ " */
    separator?: string;
    /** 分隔符可见宽度（如果没提供会自动计算） */
    separatorWidth?: number;
    /** 左右 padding 字符数，默认 1 */
    horizontalPadding?: number;
}

export function renderResponsiveCells(
    cells: ResponsiveCell[],
    availableWidth: number,
    options: ResponsiveBarOptions = {}
): string {
    if (cells.length === 0) return '';

    const sep = options.separator ?? ' │ ';
    const sepW = options.separatorWidth ?? visibleWidth(sep);
    const pad = options.horizontalPadding ?? 1;
    const innerWidth = availableWidth - pad * 2;

    const widths = cells.map((c) => c.width ?? visibleWidth(c.text));

    let shown = cells.length;
    while (shown > 0) {
        let total = 0;
        for (let i = 0; i < shown; i++) {
            total += widths[i];
            if (i > 0) total += sepW;
        }
        if (total <= innerWidth) break;
        shown--;
    }

    if (shown === 0) return '';

    const parts: string[] = [];
    for (let i = 0; i < shown; i++) {
        parts.push(cells[i].text);
    }
    const joined = parts.join(sep);
    const joinedVis = visibleWidth(joined);
    const leftPad = Math.max(0, Math.floor((innerWidth - joinedVis) / 2));

    return ' '.repeat(leftPad + pad) + joined;
}
