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
} from '@earendil-works/pi-tui';

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

/**
 * 按 stretchFactor 把可用宽度分配给可截断的列，每列上限为自身自然内容宽度。
 * 命中自然宽度的列会被固化，释放出来的预算继续在其余列之间按比例分配，
 * 保证最终分配的总宽度不会超过 budget。
 */
function distributeColumnWidths(
    budget: number,
    cols: number[],
    stretchFactors: number[],
    naturalWidths: number[]
): Map<number, number> {
    const result = new Map<number, number>();
    let active = [...cols];
    let pool = budget;

    while (active.length > 0) {
        const totalFactor = active.reduce((sum, col) => sum + stretchFactors[col], 0);
        if (totalFactor <= 0) {
            for (const col of active) result.set(col, 1);
            break;
        }

        const perFactor = pool / totalFactor;
        const saturated = active.filter((col) => perFactor * stretchFactors[col] >= naturalWidths[col]);

        if (saturated.length === 0) {
            // 没有列达到自然宽度：按比例分配，余数补给最后一列
            let left = pool;
            active.forEach((col, index) => {
                const width =
                    index === active.length - 1 ? left : Math.max(1, Math.floor(perFactor * stretchFactors[col]));
                result.set(col, Math.max(1, width));
                left -= width;
            });
            break;
        }

        for (const col of saturated) {
            result.set(col, naturalWidths[col]);
            pool -= naturalWidths[col];
        }
        active = active.filter((col) => !saturated.includes(col));

        if (active.length === 0) break;
        if (pool <= 0) {
            // 预算已被饱和列吃光，剩下的列只保留 1 列宽兜底
            for (const col of active) result.set(col, 1);
            break;
        }
    }

    return result;
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

/** 可截断列在"是否需要隐藏该列"判断中的最小可读宽度 */
const MIN_STRETCH_COLUMN_WIDTH = 3;

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
    /** 列间分隔符，默认为单个空格 */
    columnSeparator: string = ' ';

    constructor(rows: SelectRow[], maxVisible: number, theme: SelectListTheme) {
        // 初始化 innerRows，label 先设为空字符串，render 时会更新。
        // 注意：不要透传 description。SelectList 会把 description 当作附加信息渲染，
        // 会导致表格视图出现“意外多出一段文本”的显示异常。
        this.innerRows = rows.map((row) => ({
            labels: row.labels,
            value: row.value,
            label: ''
        }));
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

    /**
     * 重新计算列宽并格式化每行数据。
     *
     * 关键点：内容列超宽时必须"截断"，而不是让整列消失。原实现用每列内容的
     * 最大宽度参与"是否放得下"的判断，只要一条内容特别长（例如 /undo 里某条
     * 用户消息是一整段没有换行的长文本，或 /goal 投影出来的长目标），按内容
     * 宽度铺开的布局就会把右侧整列挤掉，选择器最后只剩序号列 —— 用户看到的
     * 就是"所有消息全是空的"。
     */
    reloadInnerList(width: number) {
        const numCols = this.stretchFactors.length;

        // 1. 按内容测量每列的自然宽度
        const naturalColWidths: number[] = [];
        for (let col = 0; col < numCols; col++) {
            let maxWidth = 0;
            for (const row of this.innerRows) {
                if (row.labels[col] !== undefined) {
                    const cleanValue = sanitizeText(row.labels[col]);
                    maxWidth = Math.max(maxWidth, visibleWidth(cleanValue));
                }
            }
            naturalColWidths.push(maxWidth);
        }

        const totalAvailable = width - 5; // 预留箭头位置

        // 2. 决定可见列：可拉伸列允许被截断，计算占位时只按最小可读宽度计；
        //    只有连"固定列 + 每个可拉伸列的最小宽度"都放不下时才从右向左隐藏列，
        //    避免出现每列只剩一个省略号、全是噪声的排版。
        const visibleCols: number[] = Array.from({ length: numCols }, (_, i) => i);
        const measureMinimumWidth = () => {
            let total = this.columnSeparator.length * Math.max(0, visibleCols.length - 1);
            for (const col of visibleCols) {
                total +=
                    this.stretchFactors[col] === 0
                        ? naturalColWidths[col]
                        : Math.min(naturalColWidths[col], MIN_STRETCH_COLUMN_WIDTH);
            }
            return total;
        };
        while (visibleCols.length > 1 && measureMinimumWidth() > totalAvailable) {
            // 放不下，移除最右边的可见列
            visibleCols.pop();
        }

        const sepForVisible = this.columnSeparator.length * Math.max(0, visibleCols.length - 1);
        const availableForCols = Math.max(1, totalAvailable - sepForVisible);

        // 3. 分配宽度：固定列优先取自然宽度，剩余空间按 stretchFactor 分给可截断列
        const colWidths: number[] = Array(numCols).fill(0);
        const fixedCols = visibleCols.filter((col) => this.stretchFactors[col] === 0);
        const stretchCols = visibleCols.filter((col) => this.stretchFactors[col] !== 0);
        const fixedWidth = fixedCols.reduce((sum, col) => sum + naturalColWidths[col], 0);
        const stretchBudget = Math.max(0, availableForCols - fixedWidth);

        if (fixedWidth > availableForCols) {
            // 连固定列都放不下：按比例压缩固定列，可截断列只保留最小宽度兜底
            const ratio = availableForCols / Math.max(1, fixedWidth);
            for (const col of fixedCols) {
                colWidths[col] = Math.max(1, Math.floor(naturalColWidths[col] * ratio));
            }
            for (const col of stretchCols) {
                colWidths[col] = Math.min(naturalColWidths[col], MIN_STRETCH_COLUMN_WIDTH);
            }
        } else {
            for (const col of fixedCols) {
                colWidths[col] = naturalColWidths[col];
            }
            const distributed = distributeColumnWidths(
                stretchBudget,
                stretchCols,
                this.stretchFactors,
                naturalColWidths
            );
            for (const col of stretchCols) {
                colWidths[col] = distributed.get(col) ?? 1;
            }
        }

        // 4. 格式化每行数据并更新innerRows
        for (const row of this.innerRows) {
            const formattedValues: string[] = [];
            for (const col of visibleCols) {
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
            row.label = formattedValues.join(this.columnSeparator);
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
