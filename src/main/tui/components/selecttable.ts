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
    visibleWidth,
    truncateToWidth,
    type SelectItem,
    SelectListTheme
} from '@mariozechner/pi-tui';

/**
 * 清理文本，移除特殊字符和ANSI转义序列
 */
function sanitizeText(text: string): string {
    let clean = text;

    // 移除 <think> 等特殊标签
    clean = clean.replace(/<think>[\s\S]*?<\/think>/gi, '');
    clean = clean.replace(/<[^>]+>/g, '');

    // 移除ANSI转义序列（颜色代码等）
    clean = clean.replace(/\x1b\[[0-9;]*m/g, '');

    // 移除换行符、回车符等会导致文本换行的字符
    clean = clean.replace(/[\n\r\t]/g, ' ');

    // 移除多余的空格
    clean = clean.replace(/\s+/g, ' ');

    return clean.trim();
}

export interface SelectRow {
    /** 每列的显示标签 */
    labels: string[];
    /** 用于标识行的唯一键（如 task_id） */
    value: string;
    /** 可选的描述 */
    description?: string;
}

interface InnerSelectRow extends SelectRow, SelectItem {}

type Alignment = 'left' | 'right' | 'center';

export class SelectTable implements Component {
    /**
     * 一列的stretchFactor如果为0，则说明这一列不能被拉伸，其内容应当始终保持显示。
     * 如果有多列的stretchFactor不为0，则说明如果还有剩余排版空间的话，应该按照stretchFactor
     * 的比例来安排空间。
     */
    stretchFactors: number[] = [];
    alignments: Alignment[] = [];
    innerRows: InnerSelectRow[] = [];
    innerList: SelectList;

    private lastWidth = 0;

    /** 选中项回调 */
    onSelect?: (value: string) => void;
    /** 取消回调 */
    onCancel?: () => void;

    constructor(rows: SelectRow[], maxVisible: number, theme: SelectListTheme) {
        // 初始化 innerRows，label 先设为空字符串，render 时会更新
        this.innerRows = rows.map((row) => ({ ...row, label: '' }));
        this.innerList = new SelectList(this.innerRows, maxVisible, theme);
        this.stretchFactors = Array(rows[0].labels.length).fill(1);
        this.alignments = Array(rows[0].labels.length).fill('left');

        // 代理 innerList 的事件
        this.innerList.onSelect = (item: SelectItem) => {
            this.onSelect?.(item.value);
        };
        this.innerList.onCancel = () => {
            this.onCancel?.();
        };
    }

    setColumnStrechFactors(factors: number[]) {
        this.stretchFactors = factors;
    }

    setAlignments(alignments: Alignment[]) {
        this.alignments = alignments;
    }

    invalidate(): void {
        this.innerList.invalidate();
    }

    reloadInnerList(width: number) {
        const numCols = this.stretchFactors.length;
        // 1. 计算每列的最大宽度
        const colMaxWidths: number[] = [];
        for (let col = 0; col < numCols; col++) {
            let maxWidth = 0;
            for (const row of this.innerRows) {
                if (row.labels[col] !== undefined) {
                    const cleanValue = sanitizeText(row.labels[col]);
                    maxWidth = Math.max(maxWidth, visibleWidth(cleanValue));
                }
            }
            colMaxWidths.push(maxWidth);
        }

        // 2. 计算固定列（stretchFactor为0）的总宽度
        let fixedWidth = 0;
        let totalStretchFactor = 0;
        for (let col = 0; col < numCols; col++) {
            if (this.stretchFactors[col] === 0) {
                fixedWidth += colMaxWidths[col];
            } else {
                totalStretchFactor += this.stretchFactors[col];
            }
        }

        // 列之间的分隔符空间（每列之间一个空格）
        const separatorWidth = Math.max(0, numCols - 1);
        // 除了分隔符之外还要预留前面的箭头位置
        const totalAvailable = width - separatorWidth - 5;

        // 如果固定列宽度超过可用宽度，需要按比例缩减固定列
        if (fixedWidth > totalAvailable) {
            return ['...'];
        }

        const availableForStretch = totalAvailable - fixedWidth;

        // 3. 计算每列的最终宽度
        const colWidths: number[] = [];
        for (let col = 0; col < numCols; col++) {
            if (this.stretchFactors[col] === 0) {
                // 固定列：使用（可能已缩减的）最大宽度
                colWidths.push(colMaxWidths[col]);
            } else {
                // 可拉伸列：按比例分配
                if (totalStretchFactor > 0 && availableForStretch > 0) {
                    const stretchWidth = Math.floor(
                        (availableForStretch * this.stretchFactors[col]) / totalStretchFactor
                    );
                    colWidths.push(Math.max(1, stretchWidth));
                } else {
                    colWidths.push(1);
                }
            }
        }

        // 4. 格式化每行数据并更新innerRows
        for (const row of this.innerRows) {
            const formattedValues: string[] = [];
            for (let col = 0; col < numCols; col++) {
                const value = sanitizeText(row.labels[col] ?? '');
                const colWidth = colWidths[col];
                const valueWidth = visibleWidth(value);
                const alignment = this.alignments[col] ?? 'left';

                let formatted: string;
                if (valueWidth > colWidth) {
                    formatted = truncateToWidth(value, colWidth, '…', true);
                    // truncateToWidth 会插入 \x1b[0m 重置码，这会破坏外层 Box 的背景色
                    formatted = formatted.replace(/\x1b\[0m/g, '');
                } else {
                    // 需要填充
                    const padding = colWidth - valueWidth;
                    switch (alignment) {
                        case 'right':
                            formatted = ' '.repeat(padding) + value;
                            break;
                        case 'center':
                            const leftPad = Math.floor(padding / 2);
                            const rightPad = padding - leftPad;
                            formatted = ' '.repeat(leftPad) + value + ' '.repeat(rightPad);
                            break;
                        case 'left':
                        default:
                            formatted = value + ' '.repeat(padding);
                            break;
                    }
                }
                formattedValues.push(formatted);
            }
            row.label = formattedValues.join(' ');
        }
    }

    render(width: number): string[] {
        if (this.innerRows.length === 0) {
            return this.innerList.render(width);
        }

        if (width != this.lastWidth) {
            this.reloadInnerList(width);
        }

        this.lastWidth = width;
        return this.innerList.render(width);
    }

    /**
     * 处理键盘输入
     */
    handleInput(keyData: string): void {
        this.innerList.handleInput(keyData);
    }
}
