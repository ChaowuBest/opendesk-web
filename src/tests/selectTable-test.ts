/**
 * 测试 SelectTable 组件的 render 逻辑
 * 独立脚本，不依赖模块导入
 */

// 模拟 pi-tui 的 visibleWidth 函数
function visibleWidth(str: string): number {
    // 移除 ANSI 转义序列后计算宽度
    // 中文字符宽度为 2，其他字符宽度为 1
    const noAnsi = str.replace(/\x1b\[[0-9;]*m/g, '');
    let width = 0;
    for (const char of noAnsi) {
        // 判断是否为中文字符
        if (/[\u4e00-\u9fff]/.test(char)) {
            width += 2;
        } else if (char === '\t') {
            width += 3;
        } else if (char === '\r') {
            // 不计入宽度
        } else {
            width += 1;
        }
    }
    return width;
}

// 模拟 pi-tui 的 truncateToWidth 函数
function truncateToWidth(str: string, maxWidth: number, ellipsis: string = '…'): string {
    const noAnsi = str.replace(/\x1b\[[0-9;]*m/g, '');
    let result = '';
    let width = 0;
    for (const char of noAnsi) {
        let charWidth: number;
        if (/[\u4e00-\u9fff]/.test(char)) {
            charWidth = 2;
        } else if (char === '\t') {
            charWidth = 3;
        } else if (char === '\r') {
            charWidth = 0;
        } else {
            charWidth = 1;
        }

        if (width + charWidth > maxWidth) {
            return result + ellipsis;
        }
        result += char;
        width += charWidth;
    }
    return result;
}

// SelectTable 的 render 逻辑测试
function testRender() {
    console.log('=== 测试 SelectTable render 逻辑 ===\n');

    // 测试数据
    const rows = [
        { labels: ['任务A', '执行中', '2026-01-01'], key: 'task-a' },
        { labels: ['任务B（长名称测试）', '空闲', '2026-01-02'], key: 'task-b' },
        { labels: ['任务C', '已完成', '2026-01-03'], key: 'task-c' },
    ];

    // 测试参数
    const stretchFactors = [1, 0, 0]; // 第一列可拉伸，后两列固定
    const alignments: ('left' | 'right' | 'center')[] = ['left', 'right', 'right'];
    const width = 50;

    console.log('测试数据:');
    console.log('  行数:', rows.length);
    console.log('  列数:', rows[0].labels.length);
    console.log('  stretchFactors:', stretchFactors);
    console.log('  alignments:', alignments);
    console.log('  总宽度:', width);
    console.log();

    const numCols = stretchFactors.length;

    // 1. 计算每列的最大宽度
    const colMaxWidths: number[] = [];
    for (let col = 0; col < numCols; col++) {
        let maxWidth = 0;
        for (const row of rows) {
            if (row.labels[col] !== undefined) {
                maxWidth = Math.max(maxWidth, visibleWidth(row.labels[col]));
            }
        }
        colMaxWidths.push(maxWidth);
    }
    console.log('每列最大宽度:', colMaxWidths);

    // 2. 计算固定列的总宽度
    let fixedWidth = 0;
    let totalStretchFactor = 0;
    for (let col = 0; col < numCols; col++) {
        if (stretchFactors[col] === 0) {
            fixedWidth += colMaxWidths[col];
        } else {
            totalStretchFactor += stretchFactors[col];
        }
    }
    console.log('固定列总宽度:', fixedWidth);
    console.log('总拉伸因子:', totalStretchFactor);

    // 列之间的分隔符空间
    const separatorWidth = Math.max(0, numCols - 1);
    const availableForStretch = width - fixedWidth - separatorWidth;
    console.log('分隔符宽度:', separatorWidth);
    console.log('可拉伸空间:', availableForStretch);

    // 3. 计算每列的最终宽度
    const colWidths: number[] = [];
    for (let col = 0; col < numCols; col++) {
        if (stretchFactors[col] === 0) {
            colWidths.push(colMaxWidths[col]);
        } else {
            if (totalStretchFactor > 0) {
                const stretchWidth = Math.floor(availableForStretch * stretchFactors[col] / totalStretchFactor);
                colWidths.push(Math.max(1, stretchWidth));
            } else {
                colWidths.push(1);
            }
        }
    }
    console.log('每列最终宽度:', colWidths);
    console.log('总计算宽度:', colWidths.reduce((a, b) => a + b, 0) + separatorWidth);
    console.log();

    // 4. 格式化每行数据
    console.log('格式化后的行:');
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const formattedValues: string[] = [];
        for (let col = 0; col < numCols; col++) {
            const value = row.labels[col] ?? '';
            const colWidth = colWidths[col];
            const valueWidth = visibleWidth(value);
            const alignment = alignments[col] ?? 'left';

            let formatted: string;
            if (valueWidth > colWidth) {
                formatted = truncateToWidth(value, colWidth, '…');
            } else {
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
        const line = formattedValues.join(' ');
        console.log(`  行${i + 1}: "${line}" (可见宽度: ${visibleWidth(line)})`);
    }

    console.log('\n=== 测试 2: 多列拉伸 ===');
    testMultiColumnStretch();

    console.log('\n=== 测试 3: 截断测试 ===');
    testTruncation();

    console.log('\n=== 测试 4: 居中对齐测试 ===');
    testCenterAlignment();
}

function testMultiColumnStretch() {
    const rows = [
        { labels: ['短', '中等长度', '很长很长很长的内容'], key: 'a' },
        { labels: ['非常长的内容在这里', '短', '中'], key: 'b' },
    ];

    const stretchFactors = [1, 2, 1]; // 三列都可拉伸，比例为 1:2:1
    const alignments: ('left' | 'right' | 'center')[] = ['left', 'center', 'right'];
    const width = 40;

    console.log('测试数据:');
    console.log('  stretchFactors:', stretchFactors);
    console.log('  总宽度:', width);

    const numCols = stretchFactors.length;

    // 计算每列最大宽度
    const colMaxWidths: number[] = [];
    for (let col = 0; col < numCols; col++) {
        let maxWidth = 0;
        for (const row of rows) {
            maxWidth = Math.max(maxWidth, visibleWidth(row.labels[col] ?? ''));
        }
        colMaxWidths.push(maxWidth);
    }
    console.log('每列最大宽度:', colMaxWidths);

    // 计算拉伸
    let totalStretchFactor = stretchFactors.reduce((a, b) => a + b, 0);
    const separatorWidth = numCols - 1;
    const availableForStretch = width - separatorWidth;

    const colWidths: number[] = [];
    for (let col = 0; col < numCols; col++) {
        const stretchWidth = Math.floor(availableForStretch * stretchFactors[col] / totalStretchFactor);
        colWidths.push(Math.max(1, stretchWidth));
    }
    console.log('每列最终宽度:', colWidths);
    console.log('总计算宽度:', colWidths.reduce((a, b) => a + b, 0) + separatorWidth);

    // 格式化
    console.log('格式化后的行:');
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const formattedValues: string[] = [];
        for (let col = 0; col < numCols; col++) {
            const value = row.labels[col] ?? '';
            const colWidth = colWidths[col];
            const valueWidth = visibleWidth(value);
            const alignment = alignments[col] ?? 'left';

            let formatted: string;
            if (valueWidth > colWidth) {
                formatted = truncateToWidth(value, colWidth, '…');
            } else {
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
                    default:
                        formatted = value + ' '.repeat(padding);
                }
            }
            formattedValues.push(formatted);
        }
        const line = formattedValues.join(' ');
        console.log(`  行${i + 1}: "${line}" (可见宽度: ${visibleWidth(line)})`);
    }
}

function testTruncation() {
    const rows = [
        { labels: ['这是一个非常非常长的内容需要被截断', '短'], key: 'a' },
    ];

    const stretchFactors = [0, 1]; // 第一列固定，第二列拉伸
    const alignments: ('left' | 'right' | 'center')[] = ['left', 'left'];
    const width = 20;

    console.log('测试数据:');
    console.log('  stretchFactors:', stretchFactors);
    console.log('  总宽度:', width);

    const numCols = stretchFactors.length;

    // 计算每列最大宽度
    const colMaxWidths: number[] = [];
    for (let col = 0; col < numCols; col++) {
        let maxWidth = 0;
        for (const row of rows) {
            maxWidth = Math.max(maxWidth, visibleWidth(row.labels[col] ?? ''));
        }
        colMaxWidths.push(maxWidth);
    }
    console.log('每列最大宽度:', colMaxWidths);

    // 第一列固定，使用最大宽度
    const fixedWidth = colMaxWidths[0];
    const separatorWidth = numCols - 1;
    const availableForStretch = width - fixedWidth - separatorWidth;

    const colWidths = [colMaxWidths[0], Math.max(1, availableForStretch)];
    console.log('每列最终宽度:', colWidths);
    console.log('总计算宽度:', colWidths.reduce((a, b) => a + b, 0) + separatorWidth);

    // 格式化
    const row = rows[0];
    const formattedValues: string[] = [];
    for (let col = 0; col < numCols; col++) {
        const value = row.labels[col] ?? '';
        const colWidth = colWidths[col];
        const valueWidth = visibleWidth(value);

        let formatted: string;
        if (valueWidth > colWidth) {
            formatted = truncateToWidth(value, colWidth, '…');
        } else {
            formatted = value + ' '.repeat(colWidth - valueWidth);
        }
        formattedValues.push(formatted);
    }
    const line = formattedValues.join(' ');
    console.log(`格式化后: "${line}" (可见宽度: ${visibleWidth(line)})`);
}

function testCenterAlignment() {
    const rows = [
        { labels: ['左', '中', '右'], key: 'a' },
    ];

    const stretchFactors = [1, 1, 1];
    const alignments: ('left' | 'right' | 'center')[] = ['left', 'center', 'right'];
    const width = 30;

    console.log('测试数据:');
    console.log('  alignments:', alignments);
    console.log('  总宽度:', width);

    const numCols = 3;
    const separatorWidth = numCols - 1;
    const colWidth = Math.floor((width - separatorWidth) / numCols);
    const colWidths = [colWidth, colWidth, colWidth];

    console.log('每列宽度:', colWidths);

    const row = rows[0];
    const formattedValues: string[] = [];
    for (let col = 0; col < numCols; col++) {
        const value = row.labels[col] ?? '';
        const cw = colWidths[col];
        const valueWidth = visibleWidth(value);
        const alignment = alignments[col];

        let formatted: string;
        const padding = cw - valueWidth;
        switch (alignment) {
            case 'right':
                formatted = ' '.repeat(padding) + value;
                break;
            case 'center':
                const leftPad = Math.floor(padding / 2);
                const rightPad = padding - leftPad;
                formatted = ' '.repeat(leftPad) + value + ' '.repeat(rightPad);
                break;
            default:
                formatted = value + ' '.repeat(padding);
        }
        formattedValues.push(formatted);
        console.log(`  列${col + 1} (${alignment}): "${formatted}"`);
    }
    const line = formattedValues.join(' ');
    console.log(`结果: "${line}" (可见宽度: ${visibleWidth(line)})`);
}

function testFixedColumnOverflow() {
    console.log('\n=== 测试 5: 固定列溢出测试 ===');
    console.log('测试数据:');
    console.log('  stretchFactors: [0, 0] (两列都是固定列)');
    console.log('  总宽度: 20 (不足以容纳固定列)');

    const rows = [
        { labels: ['这是一个非常非常长的内容', '短'], key: 'a' },
    ];

    const stretchFactors = [0, 0]; // 两列都是固定列
    const alignments: ('left' | 'right' | 'center')[] = ['left', 'left'];
    const width = 20;

    const numCols = stretchFactors.length;

    // 计算每列最大宽度
    const colMaxWidths: number[] = [];
    for (let col = 0; col < numCols; col++) {
        let maxWidth = 0;
        for (const row of rows) {
            maxWidth = Math.max(maxWidth, visibleWidth(row.labels[col] ?? ''));
        }
        colMaxWidths.push(maxWidth);
    }
    console.log('原始每列最大宽度:', colMaxWidths);

    const separatorWidth = numCols - 1;
    const totalAvailable = width - separatorWidth;
    const fixedWidth = colMaxWidths.reduce((a, b) => a + b, 0);

    console.log('固定列总宽度:', fixedWidth);
    console.log('可用宽度:', totalAvailable);

    // 如果固定列宽度超过可用宽度，按比例缩减
    if (fixedWidth > totalAvailable) {
        const scale = totalAvailable / fixedWidth;
        console.log('缩减比例:', scale.toFixed(3));
        for (let col = 0; col < numCols; col++) {
            colMaxWidths[col] = Math.max(1, Math.floor(colMaxWidths[col] * scale));
        }
        console.log('缩减后每列宽度:', colMaxWidths);
    }

    const colWidths = colMaxWidths;
    console.log('每列最终宽度:', colWidths);
    console.log('总计算宽度:', colWidths.reduce((a, b) => a + b, 0) + separatorWidth);

    // 格式化
    const row = rows[0];
    const formattedValues: string[] = [];
    for (let col = 0; col < numCols; col++) {
        const value = row.labels[col] ?? '';
        const colWidth = colWidths[col];
        const valueWidth = visibleWidth(value);

        let formatted: string;
        if (valueWidth > colWidth) {
            formatted = truncateToWidth(value, colWidth, '…');
        } else {
            formatted = value + ' '.repeat(colWidth - valueWidth);
        }
        formattedValues.push(formatted);
    }
    const line = formattedValues.join(' ');
    console.log(`格式化后: "${line}" (可见宽度: ${visibleWidth(line)})`);
}

// 运行测试
testRender();
testFixedColumnOverflow();