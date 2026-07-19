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

import { visibleWidth, truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';

/** 将多行文本在给定宽度内居中显示的组件 */
export class CenteredText implements Component {
    constructor(private text: string) {}
    invalidate() {}
    render(width: number): string[] {
        const lines = this.text.trim().split('\n');
        return lines.map((line) => {
            const lineWidth = visibleWidth(line);
            // 当行宽超过可用宽度时，截断后再居中
            const clipped = lineWidth > width ? truncateToWidth(line, width, '…', true) : line;
            const clippedWidth = lineWidth > width ? visibleWidth(clipped) : lineWidth;
            const leftPad = Math.max(0, Math.floor((width - clippedWidth) / 2));
            const padded = ' '.repeat(leftPad) + clipped;
            const rightPad = Math.max(0, width - visibleWidth(padded));
            return padded + ' '.repeat(rightPad);
        });
    }
}

/** 居中显示文本，宽度不足时自动换行（而非截断） */
export class WrappingCenteredText implements Component {
    constructor(private text: string) {}
    invalidate() {}
    render(width: number): string[] {
        const wrapped = wrapTextWithAnsi(this.text, width);
        return wrapped.map((line) => {
            const lineW = visibleWidth(line);
            const leftPad = Math.max(0, Math.floor((width - lineW) / 2));
            const padded = ' '.repeat(leftPad) + line;
            const rightPad = Math.max(0, width - visibleWidth(padded));
            return padded + ' '.repeat(rightPad);
        });
    }
}
